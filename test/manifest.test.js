import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const ext = (p) => new URL(`../extension/${p}`, import.meta.url);
const manifest = JSON.parse(readFileSync(ext('manifest.json'), 'utf8'));

test('manifest is MV3 and every file it references exists', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const files = [
    manifest.action.default_popup,
    manifest.options_page,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  for (const f of files) assert.ok(existsSync(ext(f)), f);
});

test('only the permissions STORE.md justifies', () => {
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'clipboardWrite', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  const store = readFileSync(ext('STORE.md'), 'utf8');
  for (const p of [...manifest.permissions, '<all_urls>']) assert.ok(store.includes(`\`${p}\``), p);
});
