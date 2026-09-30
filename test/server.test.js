import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, best } from '../server/store.js';
import { createApp } from '../server/server.js';

const skill = (o) => ({ site: 'ex.com', worked: 0, failed: 0, lastWorkedAt: null, ...o });

test('best returns the most recently confirmed skill, ignoring unconfirmed and net-failing ones', () => {
  const skills = [
    skill({ id: 'old', worked: 5, lastWorkedAt: '2026-01-01T00:00:00Z' }),
    skill({ id: 'recent', worked: 1, lastWorkedAt: '2026-09-01T00:00:00Z' }),
    skill({ id: 'unconfirmed' }),
    skill({ id: 'failing', worked: 1, failed: 3, lastWorkedAt: '2026-09-29T00:00:00Z' }),
    skill({ id: 'other-site', site: 'other.com', worked: 9, lastWorkedAt: '2026-09-30T00:00:00Z' }),
  ];
  assert.equal(best(skills, 'ex.com').id, 'recent');
  assert.equal(best(skills, 'nothing.com'), null);
});

test('HTTP flow: save, not served until it worked, then served', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'scoop-'));
  const store = await new Store(join(dir, 'skills.json')).load();
  const server = createApp(store).listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const post = (path, body) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const created = await post('/api/skills', { site: 'ex.com', sources: [], content: '# ex docs' });
  assert.equal(created.status, 201);
  const { id } = await created.json();

  let res = await (await fetch(`${base}/api/skills/best?site=ex.com`)).json();
  assert.equal(res.skill, null);

  assert.equal((await post(`/api/skills/${id}/feedback`, { worked: true })).status, 200);
  res = await (await fetch(`${base}/api/skills/best?site=ex.com`)).json();
  assert.equal(res.skill.id, id);
  assert.equal(res.skill.content, '# ex docs');

  const reloaded = await new Store(join(dir, 'skills.json')).load();
  assert.equal(reloaded.best('ex.com').id, id, 'persisted to disk');

  assert.equal((await post('/api/skills', { site: 'ex.com' })).status, 400);
  assert.equal((await post('/api/skills/nope/feedback', { worked: true })).status, 404);
});
