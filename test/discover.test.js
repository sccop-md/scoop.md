import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteKey, candidateUrls, looksLikeText, discover, fetchPublicText } from '../extension/lib/discover.js';

test('siteKey strips www', () => {
  assert.equal(siteKey('https://www.example.com/docs/a'), 'example.com');
  assert.equal(siteKey('https://api.jquery.com/ajax/'), 'api.jquery.com');
});

test('candidateUrls covers page .md and llms files at root and docs prefix', () => {
  const urls = candidateUrls('https://ex.com/docs/guides/webhooks/').map((c) => c.url);
  assert.deepEqual(urls, [
    'https://ex.com/docs/guides/webhooks.md',
    'https://ex.com/llms-full.txt',
    'https://ex.com/llms.txt',
    'https://ex.com/docs/llms-full.txt',
    'https://ex.com/docs/llms.txt',
  ]);
});

test('candidateUrls skips .md twin for root and files with extensions', () => {
  assert.ok(!candidateUrls('https://ex.com/').some((c) => c.kind === 'page-md'));
  assert.ok(!candidateUrls('https://ex.com/a/page.html').some((c) => c.kind === 'page-md'));
});

test('looksLikeText rejects HTML shells served for any path', () => {
  const md = '# Title\n\nSome real documentation content that is long enough.';
  assert.equal(looksLikeText('text/markdown', md), true);
  assert.equal(looksLikeText('text/html; charset=utf-8', md), false);
  assert.equal(looksLikeText('text/plain', '<!DOCTYPE html><html>…'), false);
  assert.equal(looksLikeText('text/plain', 'short'), false);
});

test('discover returns first hit per kind and never sends credentials', async () => {
  const body = '# Docs\n\n' + 'x'.repeat(100);
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push(init);
    const hit = url.endsWith('/docs/llms.txt') || url.endsWith('/webhooks.md');
    return {
      ok: hit,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => body,
    };
  };
  const found = await discover('https://ex.com/docs/webhooks', fakeFetch);
  assert.equal(found['page-md'].url, 'https://ex.com/docs/webhooks.md');
  assert.equal(found['llms'].url, 'https://ex.com/docs/llms.txt');
  assert.equal(found['llms-full'], undefined);
  assert.ok(calls.every((c) => c.credentials === 'omit'));
});

test('oversized files are not downloaded; only their size and URL are kept', async () => {
  let read = false;
  const fakeFetch = async (url) => ({
    ok: url.endsWith('/llms-full.txt'),
    headers: new Headers({ 'content-type': 'text/plain', 'content-length': '40000000' }),
    body: { cancel() {} },
    text: async () => { read = true; return ''; },
  });
  const found = await discover('https://ex.com/', fakeFetch);
  assert.deepEqual(found['llms-full'], { url: 'https://ex.com/llms-full.txt', content: null, bytes: 40_000_000 });
  assert.equal(read, false);
});

test('streams without Content-Length stop at the cap instead of downloading everything', async () => {
  let pulled = 0;
  const chunk = new Uint8Array(500_000).fill(97);
  const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(chunk); } }); // endless
  const res = { ok: true, headers: new Headers({ 'content-type': 'text/plain' }), body };
  const out = await fetchPublicText('https://ex.com/llms-full.txt', async () => res);
  assert.deepEqual(out, { content: null, bytes: 2_000_000 });
  assert.ok(pulled <= 6, `pulled ${pulled} chunks`);
});
