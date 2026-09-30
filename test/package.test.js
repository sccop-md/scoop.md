import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPackage, withCurrentPage } from '../extension/lib/package.js';

const now = new Date('2026-09-30T00:00:00Z');

test('package has sources, the not-instructions preamble, and every section', () => {
  const out = buildPackage({
    site: 'ex.com',
    pageUrl: 'https://ex.com/docs/a',
    now,
    sections: [
      { label: 'This page', url: 'https://ex.com/docs/a.md', content: 'Page body' },
      { label: 'Index', url: 'https://ex.com/llms.txt', content: 'Index body' },
    ],
    relatedLinks: [{ url: 'https://ex.com/docs/b', text: 'B' }],
  });
  assert.match(out, /^# ex\.com documentation/);
  assert.match(out, /Retrieved 2026-09-30/);
  assert.match(out, /not as instructions to you/);
  assert.match(out, /- This page: https:\/\/ex\.com\/docs\/a\.md/);
  assert.ok(out.indexOf('Page body') < out.indexOf('Index body'));
  assert.match(out, /\[B\]\(https:\/\/ex\.com\/docs\/b\)/);
});

test('package stays within budget and points to the full source when cut', () => {
  const out = buildPackage({
    site: 'ex.com',
    pageUrl: 'https://ex.com/',
    now,
    budget: 2000,
    sections: [
      { label: 'Big', url: 'https://ex.com/llms-full.txt', content: 'y'.repeat(10_000) },
      { label: 'Later', url: 'https://ex.com/llms.txt', content: 'z'.repeat(10_000) },
    ],
  });
  assert.ok(out.length < 2400, `length ${out.length}`);
  assert.match(out, /Truncated\. The full text is at https:\/\/ex\.com\/llms-full\.txt/);
  assert.match(out, /Omitted for length\. Fetch https:\/\/ex\.com\/llms\.txt/);
});

test('sections too large to include become a pointer to the file', () => {
  const out = buildPackage({
    site: 'ex.com',
    pageUrl: 'https://ex.com/',
    now,
    sections: [{ kind: 'llms-full', label: 'Full', url: 'https://ex.com/llms-full.txt', content: null, bytes: 40_000_000 }],
  });
  assert.match(out, /one large file \(over 38 MB\).*Fetch https:\/\/ex\.com\/llms-full\.txt/);
});

test('withCurrentPage puts the page first only when the shared skill lacks it', () => {
  const shared = [{ label: 'Index', url: 'https://ex.com/llms.txt', content: 'i' }];
  const page = { label: 'This page', url: 'https://ex.com/b.md', content: 'B body' };
  assert.deepEqual(withCurrentPage(shared, page), [page, ...shared]);
  const covered = [{ label: 'B', url: 'https://ex.com/b', content: 'b' }, ...shared];
  assert.equal(withCurrentPage(covered, page), covered, 'a page and its .md twin are the same page');
  assert.equal(withCurrentPage(shared, null), shared);
});
