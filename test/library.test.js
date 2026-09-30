import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { createLibrary, shareBody, notSharedReason } from '../extension/lib/library.js';
import { scoopPage } from '../extension/lib/scoop.js';

const ID = '3b1f2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

test('POSTs carry the install ID and client; GETs only the client', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: 'sk_1', status: 'verified', duplicate: false }), { status: 201 });
  };
  const lib = createLibrary({ baseUrl: 'https://api.scoop.md/v1/', installId: ID, client: 'extension/0.2.0', fetchImpl });
  await lib.best('docs.stripe.com');
  const res = await lib.share({ site: 'x' });
  assert.equal(calls[0].url, 'https://api.scoop.md/v1/skills/best?site=docs.stripe.com');
  assert.equal(calls[0].init.headers['x-scoop-install'], undefined);
  assert.equal(calls[1].init.headers['x-scoop-install'], ID);
  assert.equal(calls[1].init.headers['x-scoop-client'], 'extension/0.2.0');
  assert.equal(calls[1].init.credentials, 'omit');
  assert.deepEqual(res, { ok: true, status: 201, data: { id: 'sk_1', status: 'verified', duplicate: false } });
});

test('library errors, timeouts and outages resolve instead of throwing', async () => {
  const refuse = async () => new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }), { status: 429 });
  const down = async () => { throw new TypeError('Failed to fetch'); };
  const slow = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const lib = (fetchImpl) => createLibrary({ baseUrl: 'https://api.scoop.md/v1', installId: ID, client: 't', fetchImpl });
  assert.equal((await lib(refuse).share({})).error.code, 'rate_limited');
  assert.equal((await lib(down).best('x')).error.code, 'offline');
  const started = Date.now();
  const keepAlive = setTimeout(() => {}, 10_000); // AbortSignal.timeout's timer doesn't hold Node open
  assert.equal((await lib(slow).best('x')).error.code, 'timeout');
  clearTimeout(keepAlive);
  assert.ok(Date.now() - started < 4000);
  assert.equal((await createLibrary({ baseUrl: '' }).best('x')).ok, false);
});

test('shareBody sends null content with bytes only for oversized files', () => {
  const body = shareBody({
    site: 'ex.com', pageUrl: 'https://ex.com/', title: 'T',
    sections: [
      { kind: 'llms', label: 'L', url: 'https://ex.com/llms.txt', content: 'x', bytes: null },
      { kind: 'llms-full', label: 'F', url: 'https://ex.com/llms-full.txt', content: null, bytes: 3_000_000 },
    ],
    relatedLinks: [{ url: 'https://ex.com/a', text: 'a'.repeat(200) }],
  });
  assert.deepEqual(body.sections.map((s) => [s.content, s.bytes]), [['x', null], [null, 3_000_000]]);
  assert.equal(body.relatedLinks[0].text.length, 120);
});

test('notSharedReason names the failing source in plain words', () => {
  const sections = [{ kind: 'page-md' }, { kind: 'llms' }];
  assert.equal(notSharedReason({ code: 'source_mismatch', message: 'Section 1 (https://ex.com/a.md) does not match' }, sections), "the page's .md file changed while scooping.");
  assert.equal(notSharedReason({ code: 'source_unreachable', message: 'Section 2 (https://ex.com/llms.txt) answered 404' }, sections), "the library couldn't fetch llms.txt.");
  assert.equal(notSharedReason({ code: 'offline' }), "the library couldn't be reached.");
});

test('scoopPage prefers the .md twin and keeps oversized llms-full as a link', async () => {
  const files = {
    'https://ex.com/docs/a.md': '# A\n\nThe page as Markdown, long enough to count as text.',
    'https://ex.com/llms.txt': '# Ex\n\n- [A](https://ex.com/docs/a.md): the A page of the docs',
  };
  const fetchImpl = async (url) => {
    if (url === 'https://ex.com/llms-full.txt') return new Response('', { headers: { 'content-type': 'text/plain', 'content-length': '9000000' } });
    return files[url] ? new Response(files[url], { headers: { 'content-type': 'text/markdown' } }) : new Response('nope', { status: 404 });
  };
  const scoop = await scoopPage('https://ex.com/docs/a#x', { fetchImpl, parseHtml: (h) => new DOMParser().parseFromString(h, 'text/html'), title: 'A' });
  assert.equal(scoop.pageUrl, 'https://ex.com/docs/a');
  assert.equal(scoop.isPublic, true);
  assert.deepEqual(scoop.sections.map((s) => [s.kind, s.url, s.content === null ? s.bytes : 'text']), [
    ['page-md', 'https://ex.com/docs/a.md', 'text'],
    ['llms', 'https://ex.com/llms.txt', 'text'],
    ['llms-full', 'https://ex.com/llms-full.txt', 9_000_000],
  ]);
  assert.equal(scoop.sections[0].label, 'This page: A');
});
