import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';
import { pickMain, htmlToMarkdown, relatedLinks } from '../extension/lib/extract.js';
import { containment } from '../server/verify.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const parse = (html) => new DOMParser().parseFromString(html, 'text/html');

function extract(name, url = 'https://ex.com/docs/page') {
  const html = fixture(name);
  const doc = parse(html);
  return { html, doc, md: htmlToMarkdown(pickMain(doc), url) };
}

test('pages without <main>/<article> do not leak the top bar, sidebar or footer', () => {
  const { md } = extract('nav-leak.html');
  assert.match(md, /^Installation\n\n# Get started with Widgets\n/);
  for (const leak of ['Showcase', 'Editor setup', 'Core concepts', 'Trademark Policy', 'Copyright', 'Copy\n']) {
    assert.ok(!md.includes(leak), `leaked ${JSON.stringify(leak)}`);
  }
  assert.match(md, /## Install the plugin/);
  assert.match(md, /Install `widgets` and its build plugin with \*\*npm\*\*, then add the plugin to your \*build configuration\*\./);
  assert.match(md, /```bash\nnpm install widgets @widgets\/vite\nnpm run dev\n```/);
  assert.match(md, /## Configure it/);
});

test('heading permalink markers are dropped', () => {
  const { md } = extract('nav-leak.html');
  assert.match(md, /^# Get started with Widgets$/m);
});

test('per-line highlighters keep one line per line and lose their gutters', () => {
  const { md } = extract('highlighters.html');
  assert.match(md, /```\nconst a = 1;\nconst b = 2;\n```/, 'Shiki');
  assert.match(md, /```\n\$\.ajax\(\{\n\}\);\n```/, 'SyntaxHighlighter table with gutter');
  assert.match(md, /```js\nlet x = 1;\nx\+\+;\n```/, 'Prism lines ending in <br>');
  assert.match(md, /```py\nprint\("hi"\)\nprint\("bye"\)\n```/, 'line numbers inside lines');
  assert.ok(!/^\s*[12]\s*$/m.test(md), 'no bare line numbers');
});

test('tables become Markdown tables with a header separator', () => {
  const { md } = extract('table.html');
  assert.match(md, /\| Name \| Type \| Description \|\n\| --- \| --- \| --- \|\n\| `timeout` \| number \| Milliseconds/);
  assert.match(md, /retry a failed request \\\| at most five\. \|/);
});

test('an article header holding the title is kept; lists nest; quotes stay quotes', () => {
  const { md } = extract('table.html');
  assert.match(md, /^# Options\n\nEvery option the client accepts\./);
  assert.match(md, /- First item\n  - Nested item\n- Second item/);
  assert.match(md, /^> Deprecated since version two\.$/m);
  assert.ok(!md.includes('Edit this page'));
});

test('relatedLinks lists same-site navigation under the docs prefix only', () => {
  const { doc } = extract('table.html');
  assert.deepEqual(relatedLinks(doc, 'https://ex.com/docs/page'), [
    { url: 'https://ex.com/docs/a', text: 'A' },
    { url: 'https://ex.com/docs/b', text: 'B' },
    { url: 'https://ex.com/docs/d', text: 'D' },
  ]);
});

// highlighters.html is left out: it is almost all gutters and line numbers,
// and each one removed breaks the shingles around it. scripts/check-live.js
// covers real pages with code.
test('prose fixtures pass the library\'s containment check against their own HTML', () => {
  for (const name of ['nav-leak.html', 'table.html']) {
    const { html, md } = extract(name);
    const { ratio, count } = containment(md, html);
    assert.ok(ratio >= (count < 20 ? 1 : 0.85), `${name}: ${ratio} of ${count} shingles`);
  }
});
