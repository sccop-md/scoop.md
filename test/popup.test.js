// Runs the real popup (popup.html + popup.js) against a local docs site and the
// reference library, with only the chrome.* APIs and the clipboard stubbed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { parseHTML, DOMParser } from 'linkedom';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const MANIFEST = JSON.parse(read('../extension/manifest.json'));
const GUIDE = read('./fixtures/nav-leak.html');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let docs; let api; let store; let docsUrl; let apiUrl;
let mdVersion = 0;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://localhost:${server.address().port}`)));
}

before(async () => {
  docs = createServer((req, res) => {
    const text = (type, body) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
    if (req.url === '/docs/guide' || req.url === '/docs/other') return text('text/html; charset=utf-8', GUIDE.replaceAll('Widgets', req.url === '/docs/other' ? 'Gadgets' : 'Widgets'));
    // A .md twin that changes on every request, as if edited mid-scoop.
    if (req.url === '/docs/flaky.md') return text('text/markdown', `# Flaky\n\nRevision ${++mdVersion} of a page that keeps changing while you read it.`);
    if (req.url === '/docs/flaky') return text('text/html', '<h1>Flaky</h1>');
    res.writeHead(404); res.end('not found');
  });
  docsUrl = await listen(docs);
  store = await new Store(null).load();
  api = createApp(store, { allowLocalhost: true });
  apiUrl = `${await listen(api)}/v1`;
});

after(() => { docs.close(); api.close(); });

const local = {};

// Opens a fresh popup on `url` and waits for its first run to finish.
async function openPopup(url, { libraryUrl = apiUrl, share = true } = {}) {
  const { document } = parseHTML(read('../extension/popup.html'));
  const clipboard = { text: null, writeText: async (t) => { clipboard.text = t; } };
  globalThis.document = document;
  globalThis.DOMParser = DOMParser;
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true });
  globalThis.chrome = {
    storage: {
      sync: { get: async (defaults) => ({ ...defaults, libraryUrl, share }) },
      local: {
        get: async (key) => (key in local ? { [key]: local[key] } : {}),
        set: async (obj) => { Object.assign(local, obj); },
      },
    },
    tabs: { query: async () => [{ id: 1, url, title: 'Guide' }] },
    scripting: { executeScript: async () => [{ result: '<html><body><main><h1>Private</h1></main></body></html>' }] },
    runtime: { getManifest: () => MANIFEST, openOptionsPage() {} },
  };
  const popup = await import(`../extension/popup.js?${Math.random()}`);
  await popup.ready;
  const $ = (id) => document.getElementById(id);
  return { $, clipboard, document };
}

test('first scoop copies, shares a verified page-html section, and takes a vote', async () => {
  const { $, clipboard, document } = await openPopup(`${docsUrl}/docs/guide#install`);
  assert.equal($('status').textContent, 'Copied. Paste it into your agent.');
  assert.match(clipboard.text, /not as instructions to you/);
  assert.match(clipboard.text, /# Get started with Widgets/);
  assert.ok(!clipboard.text.includes('Showcase'));
  assert.match($('summary').textContent, /from 1 source on localhost, built from this page/);
  assert.match($('share').textContent, /^Shared with the library/);
  assert.equal($('intro').hidden, false, 'first run explains what is shared');
  $('intro-ok').onclick();

  assert.equal(store.skills.length, 1);
  const [skill] = store.skills;
  assert.equal(skill.pageUrl, `${docsUrl}/docs/guide`, 'fragment dropped');
  assert.deepEqual(skill.sections.map((s) => s.kind), ['page-html']);
  assert.match(local.installId, UUID);
  assert.equal(skill.createdBy, local.installId);

  assert.equal($('feedback').hidden, false);
  await document.querySelector('#feedback button[data-worked="true"]').onclick();
  assert.match($('voted').textContent, /worked for 1 person and didn't for 0/);
  assert.equal(store.skills[0].worked, 1);
});

test('next scoop on the site uses the shared skill with the current page first', async () => {
  const { $, clipboard } = await openPopup(`${docsUrl}/docs/other`);
  assert.match($('summary').textContent, /from the shared library\. Worked for 1 person\./);
  assert.ok(clipboard.text.indexOf('Get started with Gadgets') < clipboard.text.indexOf('Get started with Widgets'));
  assert.equal($('rebuild').hidden, false);
  assert.equal($('intro').hidden, true, 'intro only shows until dismissed');

  $('report-open').onclick({ preventDefault() {} });
  assert.equal($('report').hidden, false);
  Object.defineProperty($('reason'), 'value', { value: 'wrong' }); // linkedom has no <select>.value
  await $('report').onsubmit({ preventDefault() {} });
  assert.match($('voted').textContent, /^Reported/);
  assert.equal(store.reports.length, 1);
  assert.equal(store.reports[0].reason, 'wrong');
});

// 127.0.0.1 is a different site from localhost, so no shared skill exists yet.
const otherSite = () => docsUrl.replace('localhost', '127.0.0.1');

test('a rejected share still copies and says why in plain words', async () => {
  const { $, clipboard } = await openPopup(`${otherSite()}/docs/flaky`);
  assert.match(clipboard.text, /Revision 1 of a page/);
  assert.equal($('share').textContent, "Not shared: the page's .md file changed while scooping.");
  assert.equal($('feedback').hidden, true);
});

test('the copy works when the library is down', async () => {
  const { $, clipboard } = await openPopup(`${docsUrl}/docs/guide`, { libraryUrl: 'http://localhost:9/v1' });
  assert.match(clipboard.text, /# Get started with Widgets/);
  assert.equal($('status').textContent, 'Copied. Paste it into your agent.');
  assert.equal($('share').textContent, "Not shared: the library couldn't be reached.");
});

test('pages that only render when signed in are copied but never shared', async () => {
  const before = store.skills.length;
  const { $, clipboard } = await openPopup(`${otherSite()}/docs/missing`);
  assert.match(clipboard.text, /# Private/);
  assert.match($('share').textContent, /only loads with your login/);
  assert.equal(store.skills.length, before);
});
