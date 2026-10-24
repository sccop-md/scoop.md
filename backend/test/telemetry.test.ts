// Usage telemetry (src/telemetry/, docs/TELEMETRY.md): the POST /v1/events
// schema and caps, private hosts, rate limiting, enrichment, the queue
// consumer (D1 rows, rollups, installs, the R2 archive), API usage logging,
// the admin Telemetry endpoints, export and the deletion flow. D1 is
// node:sqlite with the real migrations; the queue, R2 and limiter are stand-ins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { Env } from '../src/env.ts';
import { handleAdmin } from '../src/admin/app.ts';
import { gunzip, readArchive, RAW_PREFIX } from '../src/telemetry/archive.ts';
import { handleTelemetryBatch, pruneTelemetry } from '../src/telemetry/consumer.ts';
import { ingestEvents, parseUa, recordApiUsage } from '../src/telemetry/ingest.ts';
import type { TelemetryMessage } from '../src/telemetry/ingest.ts';
import { cleanPath, MAX_EVENTS, validateEvents } from '../src/telemetry/schema.ts';
import { csvCell } from '../src/telemetry/queries.ts';
import { hmacHex } from '../src/db/ratelimit.ts';
import { fakeD1, fakeR2 } from './helpers.ts';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: 'data:text/javascript,export class WorkflowEntrypoint {}', shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { default: worker } = await import('../src/index.ts');

const ID = '3b241101-e2bb-4255-8caf-4136c566a962';
const ID2 = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const NOW = new Date('2026-10-12T10:30:00Z');
const T = NOW.getTime();
const IP = '203.0.113.77';
const ADMIN_PASS = 'a test passcode that is at least 32 characters long';
const CF = { country: 'GH', region: 'Greater Accra', continent: 'AF', asOrganization: 'Example Telecom' };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const CLIENT = { extVersion: '0.3.0', browser: 'Google Chrome', browserVersion: '130', os: 'mac', platformArch: 'arm', locale: 'en-GB', timezone: 'Africa/Accra' };

// raw is TELEMETRY_DB (migrations-telemetry/); the library's DB is a separate database.
function setup(over: Partial<Env> = {}) {
  const { d1, raw } = fakeD1('migrations-telemetry');
  const telemetry = fakeR2();
  const sent: TelemetryMessage[] = [];
  const batches: number[] = [];
  const keys: string[] = [];
  let allowed = Infinity;
  const limiter = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: keys.filter((k) => k === key).length <= allowed }; } };
  const env = {
    DB: fakeD1().d1,
    TELEMETRY_DB: d1,
    SKILLS: fakeR2().r2,
    TELEMETRY: telemetry.r2,
    TELEMETRY_QUEUE: {
      send: async (m: TelemetryMessage) => { sent.push(structuredClone(m)); },
      sendBatch: async (ms: { body: TelemetryMessage }[]) => { batches.push(ms.length); for (const m of ms) sent.push(structuredClone(m.body)); },
    },
    EVENTS_LIMITER: limiter,
    EVENTS_INSTALL_LIMITER: limiter,
    READ_LIMITER: { limit: async () => ({ success: true }) },
    ADMIN_AUTH_LIMITER: { limit: async () => ({ success: true }) },
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
    RATE_KEY: 'rk',
    ADMIN_UI_USER: 'admin',
    ADMIN_UI_PASSCODE: ADMIN_PASS,
    ENVIRONMENT: 'production',
    ...over,
  } as unknown as Env;
  return { env, raw, sent, batches, keys, telemetry, limitTo: (n: number) => { allowed = n; } };
}

function eventsReq(body: unknown, headers: Record<string, string> = {}) {
  const r = new Request('https://api.scoop.md/v1/events', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'text/plain;charset=UTF-8', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'user-agent': UA, ...headers },
  });
  Object.defineProperty(r, 'cf', { value: CF });
  return r;
}

const ev = (name: string, props: Record<string, unknown> = {}, seq = 1, ts = T - 60_000) => ({ name, ts, seq, props });
const envelope = (events: unknown[], over: Record<string, unknown> = {}) => ({ installId: ID, sessionId: 'sess-1', client: CLIENT, events, ...over });

async function post(env: Env, body: unknown, headers?: Record<string, string>) {
  const res = await ingestEvents(eventsReq(body, headers), env, IP, NOW).catch((e) => e);
  if (res instanceof Response) return { status: res.status, body: (await res.json()) as any };
  return { status: res.status as number, body: { error: { code: res.code, message: res.message } } as any };
}

// Runs the consumer on everything sent so far, as one queue batch.
async function consume(s: ReturnType<typeof setup>, messages = s.sent.splice(0)) {
  const acked: number[] = [];
  const retried: number[] = [];
  await handleTelemetryBatch({
    queue: 'telemetry-events-production',
    messages: messages.map((body, i) => ({ id: String(i), body, attempts: 1, timestamp: NOW, ack: () => acked.push(i), retry: () => retried.push(i) })),
  } as unknown as MessageBatch<unknown>, s.env);
  return { acked, retried };
}

// ---- Schema ------------------------------------------------------------------

test('schema: unknown events and props are dropped, strings capped, private hosts dropped whole, paths cleaned', () => {
  const b = validateEvents(envelope([
    ev('scoop_result', { site: 'Docs.Stripe.com', path: '/webhooks?utm_source=x&q=secret#frag', outcome: 'copied_ready', sizeBytes: 1234.7, sneaky: 'x', sourceKinds: ['page-md', 'evil'], isPublic: true }, 1),
    ev('made_up_event', {}, 2),
    ev('rebuild', { site: 'localhost' }, 3),
    ev('rebuild', { site: '192.168.0.4' }, 4),
    ev('rebuild', { site: 'wiki.corp.internal' }, 5),
    ev('rebuild', {}, 6),
    ev('error', { where: 'scoop', code: 'TypeError', message: `Failed https://docs.x.io/a?b and docs.secret.dev/path ${'y'.repeat(400)}` }, 7),
    ev('page_view', { path: '/' }, 8), // a website event from the extension
    ev('settings_change', { key: 'share', value: 'false' }, 9),
  ]), T);
  assert.equal(b.source, 'extension');
  assert.equal(b.installId, ID);
  assert.deepEqual(b.events.map((e) => e.name), ['scoop_result', 'error', 'settings_change']);
  assert.equal(b.dropped, 6);
  const [r, err] = b.events;
  assert.equal(r.site, 'docs.stripe.com');
  assert.equal(r.path, '/webhooks');
  assert.deepEqual(r.props, { outcome: 'copied_ready', sourceKinds: ['page-md'], sizeBytes: 1234, isPublic: true });
  assert.ok(!JSON.stringify(err.props).includes('docs.'), 'no URLs or hosts in error text');
  assert.ok((err.props.message as string).length <= 200);
  assert.equal(cleanPath('/#/guide/intro?x=1'), '/#/guide/intro');
  assert.equal(cleanPath('relative'), null);
});

test('schema: envelope checks, the 100-event cap and the ±7 day timestamp window', () => {
  assert.throws(() => validateEvents(envelope([ev('popup_open')], { installId: 'nope' }), T), /installId/);
  assert.throws(() => validateEvents(envelope([ev('popup_open')], { sessionId: 'has spaces' }), T), /sessionId/);
  assert.throws(() => validateEvents(envelope([]), T), /non-empty/);
  assert.throws(() => validateEvents(envelope(Array.from({ length: MAX_EVENTS + 1 }, (_, i) => ev('popup_open', {}, i))), T), /over 100/);
  assert.throws(() => validateEvents([], T), /JSON object/);
  const b = validateEvents(envelope([
    ev('popup_open', {}, 1, T - 8 * 86_400_000),
    ev('popup_open', {}, 2, T + 8 * 86_400_000),
    ev('popup_open', {}, 3, T - 6 * 86_400_000),
    { name: 'popup_open', ts: new Date(T).toISOString(), seq: 4 },
  ]), T);
  assert.deepEqual(b.events.map((e) => e.seq), [3, 4]);
  const site = validateEvents({ source: 'site', sessionId: 'p1', events: [ev('page_view', { path: '/privacy?x=1', referrerHost: 'news.ycombinator.com', utmSource: 'hn' }), ev('uninstall', { installId: ID.toUpperCase(), version: '0.3.0' }, 2)] }, T);
  assert.equal(site.installId, null);
  assert.equal(site.events[0].path, '/privacy');
  assert.equal(site.events[1].props.installId, ID);
});

// ---- Ingest ------------------------------------------------------------------

test('POST /v1/events: 202, enqueued with geo, UA family and a daily IP hash; the IP is never in the message', async () => {
  const s = setup();
  const r = await post(s.env, envelope([ev('popup_open'), ev('rebuild', { site: 'react.dev' }, 2), ev('rebuild', { site: 'localhost' }, 3)]));
  assert.equal(r.status, 202);
  assert.deepEqual(r.body, { accepted: 2, dropped: 1 });
  assert.equal(s.sent.length, 1);
  const [a, b] = s.sent[0].rows;
  assert.equal(a.name, 'popup_open');
  assert.equal(b.site, 'react.dev');
  assert.equal(a.install_id, ID);
  assert.equal(a.country, 'GH');
  assert.equal(a.region, 'Greater Accra');
  assert.equal(a.continent, 'AF');
  assert.equal(a.as_org, 'Example Telecom');
  assert.equal(a.ua_browser, 'Chrome 130');
  assert.equal(a.ua_os, 'macOS');
  assert.equal(a.ext_version, '0.3.0');
  assert.equal(a.timezone, 'Africa/Accra');
  assert.match(a.ip_hash!, /^[0-9a-f]{32}$/);
  assert.equal(a.received_at, NOW.toISOString());
  assert.ok(!JSON.stringify(s.sent).includes(IP), 'no raw IP');
  // The hash is HMAC(that day's random key, IP subject); the key lives in TELEMETRY_DB.
  const key = (s.raw.prepare('SELECT key FROM day_keys WHERE day = ?').get('2026-10-12') as { key: string }).key;
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal((await hmacHex(key, `ip:${IP}`)).slice(0, 32), a.ip_hash);
  // Same IP, next day: a new key, a different hash.
  await ingestEvents(eventsReq(envelope([ev('popup_open', {}, 9, T + 86_400_000 - 60_000)])), s.env, IP, new Date(T + 86_400_000));
  assert.notEqual(s.sent[1].rows[0].ip_hash, a.ip_hash);
  assert.equal((s.raw.prepare('SELECT COUNT(*) AS n FROM day_keys').get() as { n: number }).n, 2);
  // Two days on, the first day's key is gone: its hashes can't be linked to an IP any more.
  await pruneTelemetry(s.env.TELEMETRY_DB, new Date(T + 2 * 86_400_000));
  assert.deepEqual(s.raw.prepare('SELECT day FROM day_keys').all().map((r) => (r as { day: string }).day), ['2026-10-13']);
});

test('POST /v1/events: rate limited per install and per IP subject; body and origin caps', async () => {
  const s = setup();
  s.limitTo(2);
  assert.equal((await post(s.env, envelope([ev('popup_open')]))).status, 202);
  assert.equal((await post(s.env, envelope([ev('popup_open')]))).status, 202);
  const third = await post(s.env, envelope([ev('popup_open')]));
  assert.equal(third.status, 429);
  assert.equal(third.body.error.code, 'rate_limited');
  assert.ok(s.keys.includes(`install:${ID}`) && s.keys.includes(`ip:${IP}`));

  const t = setup();
  const big = envelope([ev('error', { message: 'x'.repeat(70_000) })]);
  assert.equal((await post(t.env, big)).status, 413);
  assert.equal((await post(t.env, '{not json')).status, 400);
  assert.equal((await post(t.env, envelope([ev('popup_open')]), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(t.env, { source: 'site', sessionId: 'p', events: [ev('page_view', { path: '/' })] }, { origin: 'https://scoop.md' })).status, 202);
  assert.equal((await post(t.env, envelope([ev('popup_open')]), { origin: '' })).status, 202, 'no Origin (server-side) is fine');
});

test('POST /v1/events through the Worker: CORS for the extension and scoop.md, 404 on GET', async () => {
  const s = setup({ EXTENSION_IDS: 'abcdefghijklmnopabcdefghijklmnop' });
  const res = await worker.fetch(eventsReq(envelope([ev('popup_open')])), s.env);
  assert.equal(res.status, 202);
  assert.equal(res.headers.get('access-control-allow-origin'), 'chrome-extension://abcdefghijklmnopabcdefghijklmnop');
  const pre = await worker.fetch(new Request('https://api.scoop.md/v1/events', { method: 'OPTIONS', headers: { origin: 'https://scoop.md', 'access-control-request-method': 'POST' } }), s.env);
  assert.equal(pre.status, 204);
  assert.equal((await worker.fetch(new Request('https://api.scoop.md/v1/events'), s.env)).status, 404);
});

test('parseUa: browser family with major version and OS', () => {
  assert.deepEqual(parseUa(UA), { browser: 'Chrome 130', os: 'macOS' });
  assert.deepEqual(parseUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0'), { browser: 'Edge 129', os: 'Windows' });
  assert.deepEqual(parseUa('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'), { browser: 'Firefox 131', os: 'Linux' });
  assert.deepEqual(parseUa('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), { browser: 'Safari 18', os: 'iOS' });
  assert.deepEqual(parseUa('Googlebot/2.1 (+http://www.google.com/bot.html)'), { browser: 'Bot', os: 'Other' });
  assert.deepEqual(parseUa(null), { browser: null, os: null });
});

// ---- Consumer ----------------------------------------------------------------

test('consumer: raw events, rollups, installs and install days in D1; a gzipped NDJSON archive in R2; redelivery counts once', async () => {
  const s = setup();
  await post(s.env, envelope([
    ev('install', { reason: 'install' }, 1, T - 3_600_000),
    ev('popup_open', {}, 2),
    ev('scoop_start', { site: 'docs.stripe.com' }, 3),
    ev('scoop_result', { site: 'docs.stripe.com', path: '/webhooks', outcome: 'copied_ready', sizeBytes: 2048, durationMs: 900, libraryHit: true, isPublic: true, sourceKinds: ['page-md', 'llms'] }, 4),
    ev('copy', { site: 'docs.stripe.com', sizeBytes: 2048, trigger: 'auto' }, 5),
    ev('vote', { site: 'docs.stripe.com', skillId: 'sk_01ABC', worked: true, ok: true }, 6),
  ]));
  const messages = structuredClone(s.sent);
  const { acked } = await consume(s);
  assert.deepEqual(acked, [0]);

  const events = s.raw.prepare('SELECT name, site, path, outcome, install_id, country, rolled FROM events ORDER BY seq').all() as Record<string, unknown>[];
  assert.deepEqual(events.map((e) => e.name), ['install', 'popup_open', 'scoop_start', 'scoop_result', 'copy', 'vote']);
  assert.ok(events.every((e) => e.rolled === 1 && e.install_id === ID && e.country === 'GH'));
  assert.equal(events[3].path, '/webhooks');
  assert.equal(events[3].outcome, 'copied_ready');
  assert.equal(events[5].outcome, 'worked');

  const install = s.raw.prepare('SELECT * FROM installs').get() as Record<string, unknown>;
  assert.equal(install.install_id, ID);
  assert.equal(install.scoops, 1);
  assert.equal(install.copies, 1);
  assert.equal(install.events, 6);
  assert.equal(install.installed_at, new Date(T - 3_600_000).toISOString());
  assert.equal(install.ext_version, '0.3.0');
  assert.equal(install.browser, 'Google Chrome');
  assert.equal(install.os, 'mac');
  assert.equal(install.country, 'GH');
  assert.deepEqual(s.raw.prepare('SELECT install_id, day FROM install_days').all().map((r) => ({ ...r })), [{ install_id: ID, day: '2026-10-12' }]);

  const rollup = s.raw.prepare(`SELECT * FROM events_daily WHERE name = 'scoop_result'`).get() as Record<string, unknown>;
  assert.deepEqual({ ...rollup }, { day: '2026-10-12', source: 'extension', name: 'scoop_result', site: 'docs.stripe.com', country: 'GH', version: '0.3.0', outcome: 'copied_ready', count: 1 });

  const keys = [...s.telemetry.objects.keys()];
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^telemetry\/raw\/dt=2026-10-12\/hour=10\/[0-9a-f-]{36}\.ndjson\.gz$/);
  const lines = (await gunzip(s.telemetry.objects.get(keys[0]) as Uint8Array)).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 6);
  assert.equal(lines[3].site, 'docs.stripe.com');
  assert.deepEqual(s.telemetry.meta.get(keys[0]), { httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' }, customMetadata: { events: '6' } });

  // The same message again (a queue redelivery): no double counting.
  await consume(s, messages);
  assert.equal((s.raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 6);
  assert.equal((s.raw.prepare(`SELECT count FROM events_daily WHERE name = 'scoop_result'`).get() as { count: number }).count, 1);
  assert.equal((s.raw.prepare('SELECT scoops FROM installs').get() as { scoops: number }).scoops, 1);
});

test('consumer: opt-out state follows the last toggle; the website uninstall marks the install', async () => {
  const s = setup();
  await post(s.env, envelope([ev('popup_open', {}, 1, T - 120_000)]));
  await post(s.env, envelope([ev('telemetry_opt_out', {}, 1, T - 60_000)], { sessionId: 'sess-2' }));
  await consume(s);
  let row = s.raw.prepare('SELECT opted_out, opted_out_at FROM installs').get() as Record<string, unknown>;
  assert.equal(row.opted_out, 1);
  assert.equal(row.opted_out_at, new Date(T - 60_000).toISOString());
  await post(s.env, envelope([ev('telemetry_opt_in', {}, 1, T - 30_000), ev('settings_change', { key: 'telemetry', value: 'true' }, 2, T - 30_000)], { sessionId: 'sess-3' }));
  await consume(s);
  row = s.raw.prepare('SELECT opted_out, opted_out_at FROM installs').get() as Record<string, unknown>;
  assert.deepEqual({ ...row }, { opted_out: 0, opted_out_at: null });

  await post(s.env, { source: 'site', sessionId: 'bye-1', events: [ev('uninstall', { installId: ID, version: '0.3.0' }), ev('uninstall_reason', { installId: ID, reason: 'too_noisy' }, 2)] }, { origin: 'https://scoop.md' });
  await consume(s);
  row = s.raw.prepare('SELECT uninstalled_at, uninstall_reason, events FROM installs').get() as Record<string, unknown>;
  assert.equal(row.uninstalled_at, new Date(T - 60_000).toISOString());
  assert.equal(row.uninstall_reason, 'too_noisy');
  assert.equal(row.events, 4, 'website events are not counted as extension activity');
});

test('consumer: a message that is not a telemetry message is dropped; an R2 failure retries the batch with nothing in D1', async () => {
  const s = setup();
  await post(s.env, envelope([ev('popup_open')]));
  const failing = { ...s.env, TELEMETRY: { put: async () => { throw new Error('r2 down'); } } } as unknown as Env;
  const retried: number[] = [];
  await handleTelemetryBatch({
    queue: 'telemetry-events-production',
    messages: [{ id: '0', body: s.sent[0], attempts: 1, ack: () => {}, retry: () => retried.push(0) }, { id: '1', body: { v: 9 }, attempts: 1, ack: () => {}, retry: () => retried.push(1) }],
  } as unknown as MessageBatch<unknown>, failing);
  assert.deepEqual(retried, [0]);
  assert.equal((s.raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 0);
});

test('pruning: raw events past 180 days leave D1, ip_hash goes after 30; rollups and install days stay', async () => {
  const s = setup();
  await post(s.env, envelope([ev('popup_open')]));
  await consume(s);
  s.raw.exec(`UPDATE events SET received_at = '2026-01-01T00:00:00.000Z'`);
  await post(s.env, envelope([ev('popup_open', {}, 2)]));
  await consume(s);
  await post(s.env, envelope([ev('popup_open', {}, 3)]));
  await consume(s);
  s.raw.exec(`UPDATE events SET received_at = '2026-09-01T00:00:00.000Z' WHERE seq = 3`);
  assert.deepEqual(await pruneTelemetry(s.env.TELEMETRY_DB, NOW), { events: 1, ipHashes: 1 });
  assert.deepEqual(s.raw.prepare('SELECT seq, ip_hash IS NOT NULL AS hashed FROM events ORDER BY seq').all().map((r) => ({ ...r })), [{ seq: 2, hashed: 1 }, { seq: 3, hashed: 0 }]);
  s.raw.exec(`DELETE FROM events WHERE seq = 3`);
  assert.equal((s.raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 1);
  assert.equal((s.raw.prepare(`SELECT SUM(count) AS n FROM events_daily`).get() as { n: number }).n, 3);
  assert.equal((s.raw.prepare('SELECT COUNT(*) AS n FROM install_days').get() as { n: number }).n, 1);
});

// ---- API usage -----------------------------------------------------------------

test('API usage: /v1/skills/best hit and miss per site, no IP or install ID; private hosts and sample 0 record nothing', async () => {
  const s = setup();
  const get = (path: string, headers: Record<string, string> = {}) => {
    const r = new Request(`https://api.scoop.md${path}`, { headers: { 'x-scoop-client': 'extension/0.3.0', 'x-scoop-install': ID, 'cf-connecting-ip': IP, ...headers } });
    Object.defineProperty(r, 'cf', { value: CF });
    return worker.fetch(r, s.env);
  };
  assert.equal((await get('/v1/skills/best?site=docs.stripe.com')).status, 200);
  assert.equal((await get('/v1/sites/nowhere.dev')).status, 404);
  assert.equal((await get('/v1/skills/best?site=localhost')).status, 200);
  assert.equal((await get('/v1/health')).status, 200);
  assert.equal(s.sent.length, 2, 'best + site; nothing for localhost or health');
  const [best, site] = s.sent.map((m) => m.rows[0]);
  assert.equal(best.source, 'api');
  assert.equal(best.name, 'api_best');
  assert.equal(best.site, 'docs.stripe.com');
  assert.equal(best.outcome, 'miss');
  assert.equal(best.ext_version, '0.3.0');
  assert.equal(best.country, 'GH');
  assert.equal(best.install_id, null);
  assert.equal(best.ip_hash, null);
  assert.equal(best.session_id, null);
  assert.deepEqual(Object.keys(JSON.parse(best.props)).sort(), ['client', 'hit', 'latencyMs', 'route', 'status']);
  assert.ok(!JSON.stringify(s.sent).includes(IP) && !JSON.stringify(s.sent).includes(ID));
  assert.equal(site.name, 'api_site');
  assert.equal(site.outcome, 'miss');

  // Search: the query text (capped) and the result count.
  const req = new Request('https://api.scoop.md/v1/search?q=x');
  await recordApiUsage(s.env, req, '/v1/search', { status: 200, latencyMs: 12.6, usage: { q: 'verify webhook '.repeat(30), site: 'docs.stripe.com', results: 0, hit: false } }, NOW);
  const search = JSON.parse(s.sent.at(-1)!.rows[0].props);
  assert.equal(search.q.length, 200);
  assert.equal(search.results, 0);
  assert.equal(search.latencyMs, 13);

  const off = setup({ TELEMETRY_API_SAMPLE: '0' });
  await recordApiUsage(off.env, req, '/v1/search', { status: 200, latencyMs: 1, usage: { q: 'x' } }, NOW);
  assert.equal(off.sent.length, 0);
  const half = setup({ TELEMETRY_API_SAMPLE: '0.5' });
  await recordApiUsage(half.env, req, '/v1/search', { status: 200, latencyMs: 1, usage: {} }, NOW, () => 0.7);
  await recordApiUsage(half.env, req, '/v1/search', { status: 200, latencyMs: 1, usage: {} }, NOW, () => 0.2);
  assert.equal(half.sent.length, 1);
});

// ---- Admin -------------------------------------------------------------------

const ADMIN = `Basic ${Buffer.from(`admin:${ADMIN_PASS}`).toString('base64')}`;
async function admin(env: Env, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('authorization', ADMIN);
  if (init.method && init.method !== 'GET') headers.set('sec-fetch-site', 'same-origin');
  const r = new Request(`https://admin.scoop.md${path}`, { ...init, headers });
  const res = await handleAdmin(r, env, new URL(r.url), '198.51.100.1');
  const type = res.headers.get('content-type') ?? '';
  const body: any = type.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, headers: res.headers, body };
}

async function seedTelemetry(s: ReturnType<typeof setup>) {
  await post(s.env, envelope([
    ev('install', { reason: 'install' }, 1, T - 2 * 86_400_000),
    ev('active_daily', {}, 2, T - 2 * 86_400_000),
    ev('popup_open', {}, 3),
    ev('scoop_result', { site: 'docs.stripe.com', path: '/webhooks', outcome: 'copied_ready', sizeBytes: 3000, durationMs: 1000, libraryHit: true, isPublic: true, sourceKinds: ['page-md'] }, 4),
    ev('copy', { site: 'docs.stripe.com', sizeBytes: 3000, trigger: 'auto' }, 5),
    ev('vote', { site: 'docs.stripe.com', skillId: 'sk_1', worked: false, ok: true }, 6),
    ev('share_result', { site: 'docs.stripe.com', outcome: 'duplicate' }, 7),
    ev('error', { where: 'scoop', code: 'TypeError', message: 'boom' }, 8),
  ]));
  await post(s.env, envelope([
    ev('install', { reason: 'install' }, 1),
    ev('active_daily', {}, 2),
    ev('popup_open', {}, 3),
    ev('scoop_result', { site: 'react.dev', path: '/learn', outcome: 'copied_ready', sizeBytes: 1000, durationMs: 3000, libraryHit: false, isPublic: true, sourceKinds: ['page-html'] }, 4),
    ev('scoop_result', { site: 'react.dev', outcome: 'empty', durationMs: 50 }, 5),
  ], { installId: ID2, client: { ...CLIENT, extVersion: '0.2.9', browser: 'Brave', os: 'win' } }));
  await post(s.env, { source: 'site', sessionId: 'v1', events: [ev('page_view', { path: '/', referrerHost: 'news.ycombinator.com', utmSource: 'hn', utmMedium: 'social' }), ev('page_view', { path: '/bye' }, 2), ev('cta_click', { target: 'chrome_store', path: '/' }, 3)] }, { origin: 'https://scoop.md' });
  const search = new Request('https://api.scoop.md/v1/search');
  await recordApiUsage(s.env, search, '/v1/search', { status: 200, latencyMs: 30, usage: { q: 'webhook signature', site: 'docs.stripe.com', results: 0, hit: false } }, NOW);
  await recordApiUsage(s.env, search, '/v1/packages', { status: 200, latencyMs: 30, usage: { topic: 'webhooks', site: 'docs.stripe.com', results: 4, hit: true } }, NOW);
  await recordApiUsage(s.env, search, '/v1/skills/best', { status: 200, latencyMs: 3, usage: { site: 'docs.stripe.com', hit: true } }, NOW);
  await consume(s);
}

test('admin telemetry: overview, sites, installs, retention, platforms, geography, errors, API usage, website', async () => {
  const s = setup();
  await seedTelemetry(s);
  const realNow = Date.now;
  Date.now = () => T;
  try {
    const o = await admin(s.env, '/api/telemetry/overview?days=30');
    assert.equal(o.status, 200);
    assert.deepEqual(o.body.installs, { total: 2, installed: 2, uninstalled: 0, net: 2, optedOut: 0, unknownUninstalls: 0 });
    assert.equal(o.body.rawFrom, '2026-09-13');
    assert.equal(o.body.funnel.events.popupOpen, 2);
    assert.equal(o.body.funnel.events.scooped, 2);
    assert.equal(o.body.funnel.events.copied, 1);
    assert.equal(o.body.funnel.events.voted, 1);
    assert.deepEqual(o.body.funnel.installs, { popupOpen: 2, scooped: 2, copied: 1, voted: 1 });
    assert.deepEqual(o.body.funnel.sessions, { popupOpen: 2, scooped: 2, copied: 1, voted: 1 });
    assert.equal(o.body.library.hitRate, 0.5);
    assert.deepEqual(o.body.shares, [{ outcome: 'duplicate', n: 1 }]);
    assert.deepEqual(o.body.averages, { sizeBytes: 2000, durationMs: 2000 });

    const sites = await admin(s.env, '/api/telemetry/sites');
    assert.deepEqual(sites.body.sites.map((x: { site: string }) => x.site), ['react.dev', 'docs.stripe.com']);
    const d = await admin(s.env, '/api/telemetry/sites/docs.stripe.com');
    assert.equal(d.body.summary.scoops, 1);
    assert.deepEqual(d.body.paths.map((p: { path: string }) => p.path), ['/webhooks']);
    assert.deepEqual(d.body.queries, [{ q: 'webhook signature', name: 'api_search', n: 1, avg_results: 0, misses: 1 }]);
    assert.deepEqual(d.body.best, [{ outcome: 'hit', n: 1 }]);

    const list = await admin(s.env, '/api/telemetry/installs');
    assert.equal(list.body.installs.length, 2);
    const one = await admin(s.env, `/api/telemetry/installs/${ID2}`);
    assert.equal(one.body.install.ext_version, '0.2.9');
    assert.deepEqual(one.body.timeline.map((e: { name: string }) => e.name).sort(), ['active_daily', 'install', 'popup_open', 'scoop_result', 'scoop_result']);
    assert.equal((await admin(s.env, '/api/telemetry/installs/not-a-uuid')).status, 400);

    const ret = await admin(s.env, '/api/telemetry/retention?weeks=4');
    // 2026-10-10 is a Saturday (week of Monday 10-05), 10-12 a Monday: two cohorts.
    assert.deepEqual(ret.body.cohorts.map((c: { cohort: string; size: number }) => [c.cohort, c.size]), [['2026-10-05', 1], ['2026-10-12', 1]]);
    // Active days are by received day: everything arrived on 10-12, the second week of the first cohort.
    assert.deepEqual(ret.body.cohorts[0].active.slice(0, 3), [0, 1, 0]);
    assert.deepEqual(ret.body.cohorts[1].active.slice(0, 2), [1, 0]);
    assert.deepEqual(ret.body.cohorts.map((c: { elapsed: number }) => c.elapsed), [1, 0]);

    const p = await admin(s.env, '/api/telemetry/platforms');
    assert.deepEqual(p.body.versions.map((v: { value: string }) => v.value).sort(), ['0.2.9', '0.3.0']);
    assert.ok(p.body.adoption.length >= 2);
    const g = await admin(s.env, '/api/telemetry/geo');
    assert.equal(g.body.installs[0].country, 'GH');
    const e = await admin(s.env, '/api/telemetry/errors');
    assert.equal(e.body.byCode[0].code, 'TypeError');
    assert.equal(e.body.recent[0].message, 'boom');
    const a = await admin(s.env, '/api/telemetry/api');
    assert.deepEqual(a.body.zeroResults.map((z: { q: string }) => z.q), ['webhook signature']);
    assert.deepEqual(a.body.best, [{ site: 'docs.stripe.com', hits: 1, misses: 0 }]);
    const w = await admin(s.env, '/api/telemetry/website');
    assert.equal(w.body.bye.views, 1);
    assert.deepEqual(w.body.referrers, [{ host: 'news.ycombinator.com', views: 1 }]);
    assert.equal(w.body.utm[0].source, 'hn');
    assert.equal(w.body.ctas[0].target, 'chrome_store');
  } finally {
    Date.now = realNow;
  }
});

test('admin telemetry live: the last 24 hours of copies, installs, website and errors', async () => {
  const s = setup();
  await seedTelemetry(s);
  const realNow = Date.now;
  Date.now = () => T;
  try {
    const l = await admin(s.env, '/api/telemetry/live');
    assert.equal(l.status, 200);
    assert.equal(l.body.now.installs, 2);
    assert.equal(l.body.now.popups, 2);
    assert.equal(l.body.now.views, 2);
    assert.equal(l.body.now.ctas, 1);
    assert.equal(l.body.now.errors, 1);
    assert.equal(l.body.now.active, 2);
    assert.equal(l.body.before.popups, 0);
    assert.deepEqual(l.body.ctas, [{ target: 'chrome_store', n: 1 }]);
    assert.ok(l.body.hourly.length >= 1);
    assert.ok(l.body.lastEventAt);
  } finally {
    Date.now = realNow;
  }
});

test('admin telemetry export: CSV and NDJSON downloads with Content-Disposition, under the console CSP; the archive too', async () => {
  const s = setup();
  await seedTelemetry(s);
  const csv = await admin(s.env, '/api/telemetry/export?table=events&from=2026-10-01&to=2026-10-12');
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="scoop-telemetry-events-2026-10-01-to-2026-10-12.csv"');
  assert.match(csv.headers.get('content-security-policy')!, /default-src 'self'/);
  assert.equal(csv.headers.get('cache-control'), 'no-store');
  const lines = (csv.body as string).trim().split('\n');
  assert.match(lines[0], /^id,source,name,ts,day,/);
  assert.equal(lines.length, 1 + 13 + 3 + 3);

  const nd = await admin(s.env, '/api/telemetry/export?table=installs&from=2026-10-01&to=2026-10-12&format=ndjson');
  assert.equal((nd.body as string).trim().split('\n').map((l) => JSON.parse(l).install_id).length, 2);
  const archive = await admin(s.env, '/api/telemetry/export?table=archive&from=2026-10-12&to=2026-10-12');
  assert.equal(archive.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  assert.equal((archive.body as string).trim().split('\n').length, 19);

  assert.equal((await admin(s.env, '/api/telemetry/export?table=skills')).status, 400);
  assert.equal((await admin(s.env, '/api/telemetry/export?table=archive&from=2026-01-01&to=2026-10-12')).status, 400);
  assert.equal((await admin(s.env, '/api/telemetry/export?table=events&from=2026-10-12&to=2026-10-01')).status, 400);
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('a,b'), '"a,b"');
});

test('deletion: an install ID leaves D1, is refused from then on, and is skipped by archive exports', async () => {
  const s = setup();
  await seedTelemetry(s);
  // Needs the same-origin header like every other state change.
  const csrf = await handleAdmin(new Request(`https://admin.scoop.md/api/telemetry/installs/${ID}`, { method: 'DELETE', headers: { authorization: ADMIN } }), s.env, new URL(`https://admin.scoop.md/api/telemetry/installs/${ID}`), '198.51.100.1');
  assert.equal(csrf.status, 403);

  const del = await admin(s.env, `/api/telemetry/installs/${ID}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(del.body.eventsDeleted, 8);
  assert.equal(del.body.tombstone, `telemetry/tombstones/${ID}.json`);
  const count = (sql: string) => (s.raw.prepare(sql).get(ID) as { n: number }).n;
  assert.equal(count('SELECT COUNT(*) AS n FROM events WHERE install_id = ?'), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM installs WHERE install_id = ?'), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM install_days WHERE install_id = ?'), 0);
  assert.ok(s.telemetry.objects.has(`telemetry/tombstones/${ID}.json`));
  assert.equal((await admin(s.env, `/api/telemetry/installs/${ID}`)).status, 404);
  assert.equal((await admin(s.env, '/api/telemetry/deletions')).body.deletions[0].install_id, ID);

  // New events from that install are neither stored nor archived.
  const before = [...s.telemetry.objects.keys()].filter((k) => k.startsWith(RAW_PREFIX)).length;
  await post(s.env, envelope([ev('popup_open', {}, 99)], { sessionId: 'after' }));
  await consume(s);
  assert.equal(count('SELECT COUNT(*) AS n FROM events WHERE install_id = ?'), 0);
  assert.equal([...s.telemetry.objects.keys()].filter((k) => k.startsWith(RAW_PREFIX)).length, before);

  // The archive written before the deletion still holds them; exports skip them.
  let text = '';
  const reader = readArchive(s.env.TELEMETRY, '2026-10-12', '2026-10-12').getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  const rows = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.install_id !== ID));
});

// ---- Flood limits, switches and privacy fixes ------------------------------------

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: crypto.randomUUID(), source: 'extension', name: 'popup_open', ts: NOW.toISOString(), day: '2026-10-12', received_at: NOW.toISOString(),
  install_id: ID, session_id: 's', visitor_id: null, seq: 1, site: null, path: null, outcome: null, props: '{}', ext_version: '0.3.0',
  browser: null, browser_version: null, os: null, arch: null, locale: null, timezone: null, ua_browser: null, ua_os: null,
  country: 'GH', region: null, continent: null, as_org: null, ip_hash: 'iphash', ...over,
}) as unknown as import('../src/telemetry/ingest.ts').TelemetryRow;

test('quotas: 20 new installs per IP hash, 2,000 events per install, 20,000 per IP hash, the global ceiling keeps lifecycle only, API rows capped', async () => {
  const { quota, QUOTAS } = await import('../src/telemetry/consumer.ts');
  const fresh = () => ({ counts: new Map<string, number>(), ipInstalls: new Map<string, Set<string>>() });
  const limits = { dailyMax: 1_000_000, apiDailyMax: 3 };

  const installs = Array.from({ length: 25 }, () => row({ install_id: crypto.randomUUID() }));
  let kept = quota(installs, fresh(), limits);
  assert.equal(kept.rows.length, QUOTAS.newInstallsPerIp);
  assert.equal(kept.dropped, 5);

  const one = Array.from({ length: QUOTAS.eventsPerInstall + 10 }, () => row());
  kept = quota(one, fresh(), limits);
  assert.equal(kept.rows.length, QUOTAS.eventsPerInstall);

  const state = fresh();
  state.counts.set('2026-10-12|ip_events|iphash', QUOTAS.eventsPerIp - 1);
  kept = quota([row(), row()], state, limits);
  assert.equal(kept.rows.length, 1);
  assert.equal(kept.deltas.get('2026-10-12|ip_events|iphash'), 1);

  const ceiling = fresh();
  ceiling.counts.set('2026-10-12|all_events|', 5);
  kept = quota([row({ name: 'scoop_result' }), row({ name: 'install' }), row({ name: 'active_daily' })], ceiling, { dailyMax: 5, apiDailyMax: 3 });
  assert.deepEqual(kept.rows.map((r) => r.name), ['install', 'active_daily']);

  kept = quota(Array.from({ length: 5 }, () => row({ source: 'api', name: 'api_best', install_id: null, ip_hash: null })), fresh(), limits);
  assert.equal(kept.rows.length, 3);
});

test('quotas through the consumer: counters persist in TELEMETRY_DB across batches', async () => {
  const s = setup({ TELEMETRY_DAILY_MAX: '3' } as Partial<Env>);
  await post(s.env, envelope([ev('popup_open', {}, 1), ev('popup_open', {}, 2)]));
  await consume(s);
  await post(s.env, envelope([ev('popup_open', {}, 3), ev('popup_open', {}, 4), ev('active_daily', {}, 5)]));
  await consume(s);
  assert.deepEqual(s.raw.prepare('SELECT seq FROM events ORDER BY seq').all().map((r) => (r as { seq: number }).seq), [1, 2, 3, 5]);
  assert.equal((s.raw.prepare(`SELECT count FROM quota_counters WHERE kind = 'all_events'`).get() as { count: number }).count, 4);
  assert.equal((s.raw.prepare(`SELECT COUNT(*) AS n FROM ip_installs`).get() as { n: number }).n, 1);
});

test('TELEMETRY_INGEST: off accepts nothing, lifecycle keeps lifecycle events only; API usage only when on', async () => {
  const off = setup({ TELEMETRY_INGEST: 'off' } as Partial<Env>);
  assert.deepEqual((await post(off.env, envelope([ev('install', { reason: 'install' }), ev('popup_open', {}, 2)]))).body, { accepted: 0, dropped: 2 });
  assert.equal(off.sent.length, 0);
  const life = setup({ TELEMETRY_INGEST: 'lifecycle' } as Partial<Env>);
  const r = await post(life.env, envelope([ev('install', { reason: 'install' }), ev('scoop_start', {}, 2), ev('telemetry_opt_out', {}, 3)]));
  assert.deepEqual(r.body, { accepted: 2, dropped: 1 });
  assert.deepEqual(life.sent[0].rows.map((x) => x.name), ['install', 'telemetry_opt_out']);
  await recordApiUsage(life.env, new Request('https://api.scoop.md/v1/search'), '/v1/search', { status: 200, latencyMs: 1, usage: {} }, NOW);
  assert.equal(life.sent.length, 1, 'no API rows unless on');
});

test('the install limiter is its own binding; requests are split into queue messages under 90 KB', async () => {
  const s = setup();
  const installKeys: string[] = [];
  (s.env as unknown as Record<string, unknown>).EVENTS_INSTALL_LIMITER = { limit: async ({ key }: { key: string }) => { installKeys.push(key); return { success: installKeys.length <= 1 }; } };
  assert.equal((await post(s.env, envelope([ev('popup_open')]))).status, 202);
  assert.equal((await post(s.env, envelope([ev('popup_open', {}, 2)]))).status, 429);
  assert.deepEqual(installKeys, [`install:${ID}`, `install:${ID}`]);

  const t = setup();
  const long = '/docs/' + 'segment/'.repeat(36);
  const events = Array.from({ length: 100 }, (_, i) => ev('error', { where: 'x'.repeat(40), code: 'c'.repeat(60), message: 'word '.repeat(40) }, i));
  const big = Array.from({ length: 100 }, (_, i) => ev('scoop_result', { site: 'docs.stripe.com', path: long, outcome: 'copied_ready', sourceKinds: ['page-md', 'llms', 'llms-full', 'page-html'] }, i));
  for (const body of [envelope(events), envelope(big, { sessionId: 'sess-2' })]) assert.equal((await post(t.env, body)).status, 202);
  assert.ok(t.batches.every((n) => n >= 1));
  for (const m of t.sent) assert.ok(JSON.stringify(m).length < 128_000, `message is ${JSON.stringify(m).length} bytes`);
  assert.equal(t.sent.reduce((n, m) => n + m.rows.length, 0), 200);
});

test('the R2 archive has no ip_hash; D1 keeps it (until 30 days)', async () => {
  const s = setup();
  await post(s.env, envelope([ev('popup_open')]));
  await consume(s);
  const [key] = [...s.telemetry.objects.keys()].filter((k) => k.startsWith(RAW_PREFIX));
  const line = JSON.parse((await gunzip(s.telemetry.objects.get(key) as Uint8Array)).trim());
  assert.ok(!('ip_hash' in line));
  assert.ok((s.raw.prepare('SELECT ip_hash FROM events').get() as { ip_hash: string }).ip_hash);
});

test('opt-out state: an older opt-in arriving later does not undo a newer opt-out', async () => {
  const s = setup();
  await post(s.env, envelope([ev('telemetry_opt_out', {}, 1, T - 60_000)], { sessionId: 'b' }));
  await consume(s);
  await post(s.env, envelope([ev('telemetry_opt_in', {}, 1, T - 120_000)], { sessionId: 'a' }));
  await consume(s);
  const row = s.raw.prepare('SELECT opted_out, opted_changed_at FROM installs').get() as Record<string, unknown>;
  assert.deepEqual({ ...row }, { opted_out: 1, opted_changed_at: new Date(T - 60_000).toISOString() });
});

test('an uninstall for an unknown install ID creates no installs row; it is counted apart', async () => {
  const s = setup();
  await post(s.env, { source: 'site', sessionId: 'bye', events: [ev('uninstall', { installId: ID2, version: '0.3.0' })] }, { origin: 'https://scoop.md' });
  await consume(s);
  assert.equal((s.raw.prepare('SELECT COUNT(*) AS n FROM installs').get() as { n: number }).n, 0);
  assert.deepEqual({ ...(s.raw.prepare('SELECT install_id, known FROM uninstalls').get() as object) }, { install_id: ID2, known: 0 });
});

test('install days use the day the server received the event, not the client clock', async () => {
  const s = setup();
  await post(s.env, envelope([ev('popup_open', {}, 1, T + 5 * 86_400_000)]));
  await consume(s);
  assert.deepEqual(s.raw.prepare('SELECT day FROM install_days').all().map((r) => (r as { day: string }).day), ['2026-10-12']);
});

test('API usage: X-Scoop-Telemetry: off records nothing; rows keep the country only, timed to the hour', async () => {
  const s = setup();
  const req = (h: Record<string, string> = {}) => {
    const r = new Request('https://api.scoop.md/v1/skills/best?site=react.dev', { headers: { 'user-agent': UA, ...h } });
    Object.defineProperty(r, 'cf', { value: CF });
    return r;
  };
  await recordApiUsage(s.env, req({ 'x-scoop-telemetry': 'off' }), '/v1/skills/best', { status: 200, latencyMs: 3, usage: { site: 'react.dev', hit: true } }, NOW);
  assert.equal(s.sent.length, 0);
  await recordApiUsage(s.env, req(), '/v1/skills/best', { status: 200, latencyMs: 3, usage: { site: 'react.dev', hit: true } }, NOW);
  const r = s.sent[0].rows[0];
  assert.equal(r.country, 'GH');
  assert.deepEqual([r.region, r.continent, r.as_org, r.ua_browser, r.ua_os], [null, null, null, null, null]);
  assert.equal(r.ts, '2026-10-12T10:00:00.000Z');
  assert.equal(r.received_at, '2026-10-12T10:00:00.000Z');
});

test('paths: secret-looking segments are redacted and hash routes cut on the server too; error text loses emails and tokens', () => {
  assert.equal(cleanPath('/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit'), '/document/d/:id/edit');
  assert.equal(cleanPath('/docs/getting-started-with-v2-api'), '/docs/getting-started-with-v2-api');
  assert.equal(cleanPath('/#/guide&x=1'), '/#/guide');
  assert.equal(cleanPath('/#/guide#section'), '/#/guide');
  const b = validateEvents(envelope([ev('error', { where: 'scoop', code: 'E', message: 'mail jane@acme.com token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234' })]), T);
  assert.equal(b.events[0].props.message, 'mail <email> token <token>');
});

test('deletion: the tombstone is written first, and archive reads also skip IDs deleted in D1 only', async () => {
  const s = setup();
  await post(s.env, envelope([ev('popup_open')]));
  await consume(s);
  const order: string[] = [];
  const db = s.env.TELEMETRY_DB;
  const failing = {
    prepare: (sql: string) => db.prepare(sql),
    batch: async () => { order.push('d1'); throw new Error('d1 down'); },
  } as unknown as D1Database;
  const r2 = { put: async (key: string, value: string) => { order.push('r2'); await s.env.TELEMETRY.put(key, value); } } as unknown as R2Bucket;
  const { deleteInstall } = await import('../src/telemetry/queries.ts');
  await assert.rejects(deleteInstall(failing, r2, ID, NOW), /d1 down/);
  assert.deepEqual(order, ['r2', 'd1']);

  const t = setup();
  await post(t.env, envelope([ev('popup_open')]));
  await consume(t);
  t.raw.prepare('INSERT INTO telemetry_deletions (install_id, deleted_at) VALUES (?, ?)').run(ID, NOW.toISOString());
  let text = '';
  const reader = readArchive(t.env.TELEMETRY, '2026-10-12', '2026-10-12', t.env.TELEMETRY_DB).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  assert.equal(text, '');
});

test('scoop_start is accepted with no properties (the extension names no site on it)', () => {
  const b = validateEvents(envelope([ev('scoop_start'), ev('scoop_start', { site: 'react.dev', path: '/learn' }, 2)]), T);
  assert.deepEqual(b.events.map((e) => [e.name, e.site, e.path]), [['scoop_start', null, null], ['scoop_start', null, null]]);
});

test('lifecycle events stop too at 3× the daily ceiling; each cap logs telemetry_cap_hit once per day', async () => {
  const { quota, logCapHits } = await import('../src/telemetry/consumer.ts');
  const state = { counts: new Map<string, number>([['2026-10-12|all_events|', 15]]), ipInstalls: new Map<string, Set<string>>() };
  const kept = quota([row({ name: 'install' }), row({ name: 'popup_open' })], state, { dailyMax: 5, apiDailyMax: 3 });
  assert.equal(kept.rows.length, 0);
  assert.deepEqual([...kept.caps].sort(), ['2026-10-12|lifecycle_max']);

  const s = setup({ TELEMETRY_DAILY_MAX: '1' } as Partial<Env>);
  const lines: string[] = [];
  const log = console.log;
  console.log = (l: string) => { lines.push(String(l)); };
  try {
    await post(s.env, envelope([ev('popup_open', {}, 1), ev('popup_open', {}, 2)]));
    await consume(s);
    await post(s.env, envelope([ev('popup_open', {}, 3)]));
    await consume(s);
    assert.equal(await logCapHits(s.env.TELEMETRY_DB, new Set(['2026-10-12|daily_max']), { dailyMax: 1, apiDailyMax: 1 }), 0, 'already logged today');
  } finally {
    console.log = log;
  }
  const hits = lines.filter((l) => l.includes('telemetry_cap_hit')).map((l) => JSON.parse(l));
  assert.equal(hits.length, 1);
  assert.deepEqual([hits[0].event, hits[0].day, hits[0].cap], ['telemetry_cap_hit', '2026-10-12', 'daily_max']);
});

test('API row IDs carry the hour, not the exact request time', async () => {
  const s = setup();
  await recordApiUsage(s.env, new Request('https://api.scoop.md/v1/sites'), '/v1/sites', { status: 200, latencyMs: 1, usage: {} }, NOW);
  const id = s.sent[0].rows[0].id;
  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const ms = [...id.slice(4, 14)].reduce((n, c) => n * 32 + CROCKFORD.indexOf(c), 0);
  assert.equal(new Date(ms).toISOString(), '2026-10-12T10:00:00.000Z');
});

test('error text loses IPv4 and IPv6 literals on the server', () => {
  const b = validateEvents(envelope([ev('error', { where: 'x', code: 'E', message: 'from 203.0.113.7 via 2001:db8::1 at 10:30:00' })]), T);
  assert.equal(b.events[0].props.message, 'from <ip> via <ip> at 10:30:00');
});
