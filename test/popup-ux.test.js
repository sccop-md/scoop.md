// The popup (0.5.0): loader → copied → content with the best package right
// away (index, shared skill, or the instant build: the page plus /quick
// sources), indexing in the background with "Copy all <site> docs", the
// Overview and Search tabs, and the service worker: crawl follow-up and the
// per-tab docs-count badge. The real popup.js and background.js run against a
// mock of the library's contract (helpers/mock-library.js), chrome.* stubbed.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { parseHTML, DOMParser } from 'linkedom';
import { startMockLibrary } from './helpers/mock-library.js';
import { sleep, stageLog, timing } from '../extension/lib/ux.js';
import { SITES_KEY, SITES_ALARM, LEARNED_TTL_MS, badgeFor, llmsLevelFor, refreshSites, rememberLlms, setTabBadge } from '../extension/lib/badge.js';
import { createLibrary } from '../extension/lib/library.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const MANIFEST = JSON.parse(read('../extension/manifest.json'));
const GUIDE = read('./fixtures/nav-leak.html');
const SITE = 'docs.example.com';
const PAGE = `https://${SITE}/docs/guide`;
// A docs subdomain the server's /quick finds for SITE (served by the docs server under /sub).
const SUB = 'docs.example.org';

let docs; let docsUrl; let mock;
let failPackages = false;
let packageAttempts = 0;
const headRequests = [];
const realFetch = globalThis.fetch;

before(async () => {
  docs = createServer((req, res) => {
    if (req.url === '/docs/guide' || req.url === '/docs/other') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(GUIDE);
    }
    if (req.url === '/docs/links') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<html><body><nav><a href="/docs/other">Other</a><a href="/docs/gone">Gone</a><a href="/docs/migration-guide">Migration</a></nav>
        <main><h1>Links</h1><p>Read the <a href="/docs/other">other page</a>, the <a href="/docs/gone">gone page</a> and the
        <a href="/docs/migration-guide">migration guide</a> before you start building anything with this library today.</p>
        <p>${'More words about the library so the page has enough text to be worth scooping. '.repeat(6)}</p></main></body></html>`);
    }
    if (req.url === '/sub/guide.md') {
      res.writeHead(200, { 'content-type': 'text/markdown' });
      return res.end('# Guide (Markdown twin)\n\nThe Markdown version of the guide, from the docs subdomain.\n');
    }
    if (req.url === '/shop/' || req.url === '/shop/pricing') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<html><head><title>Pricing | Shop</title></head><body><main><h1>Pricing</h1><p>${'Plans for every team, billed monthly or yearly. '.repeat(10)}</p></main></body></html>`);
    }
    if (req.url === '/shop/llms.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('# Shop\n\n- [Pricing](https://shop.example.net/pricing)\n');
    }
    if (req.url === '/sub/llms-rel.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('# Example docs\n\n> The example docs, with site-relative links.\n\n- [Guide](/guide.md): getting started\n');
    }
    if (req.url === '/sub/home.md') {
      res.writeHead(200, { 'content-type': 'text/markdown' });
      return res.end('---\n"@context": https://schema.org\nheadline: "Home"\n---\n\n# Example home\n\nWelcome to the example docs. Start with the guide.\n');
    }
    if (req.url === '/sub/llms-big.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(`# Big docs\n\n${'- [A page](https://docs.example.org/guide.md): what it covers, in a few words\n'.repeat(800)}`);
    }
    if (req.url === '/sub/llms-full.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('# Example docs, in full\n\nEverything.\n');
    }
    if (req.url === '/sub/llms.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('# Example docs\n\n> The llms.txt index of the example docs.\n\n- [Guide](https://docs.example.org/guide.md)\n');
    }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((r) => docs.listen(0, '127.0.0.1', r));
  docsUrl = `http://127.0.0.1:${docs.address().port}`;
  // docs.example.com is served by the local docs server; api.scoop.md by the mock.
  globalThis.fetch = (url, init) => {
    const s = String(url);
    if (s.startsWith(`https://${SITE}`)) return realFetch(s.replace(`https://${SITE}`, docsUrl), init);
    if (s.startsWith(`https://${SUB}`)) return realFetch(s.replace(`https://${SUB}`, `${docsUrl}/sub`), init);
    if (s.startsWith('https://shop.example.net')) return realFetch(s.replace('https://shop.example.net', `${docsUrl}/shop`), init);
    if (s.startsWith('https://api.scoop.md/v1')) return realFetch(s.replace('https://api.scoop.md/v1', mock.url), init);
    if (s.includes('/v1/packages')) packageAttempts++;
    if (init?.method === 'HEAD') headRequests.push(s);
    if (failPackages && s.includes('/v1/packages')) return Promise.reject(new TypeError('Failed to fetch'));
    return realFetch(url, init);
  };
});

after(() => { globalThis.fetch = realFetch; docs.close(); mock?.close(); });

beforeEach(() => {
  failPackages = false;
  packageAttempts = 0;
  Object.assign(timing, { loaderMs: 60, celebrateMs: 120, reducedMs: 20, packageRetryMs: [10, 20, 40], followMs: 15, searchDebounceMs: 10 });
  stageLog.length = 0;
});

const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out waiting');
};

// Opens the popup on `url`; returns at once (ready resolves when the scoop is done).
async function openPopup(url, { local = {}, share = true, installType = 'development', reduced = false, sync = {}, clipboardFails = false, pinned, liveHtml = '<html><body><main><h1>Private</h1><p>Only for you.</p></main></body></html>' } = {}) {
  const { document } = parseHTML(read('../extension/popup.html'));
  const clipboard = { text: null, writes: [], writeText: async (t) => {
    if (clipboardFails) throw new Error('Document is not focused.');
    clipboard.text = t; clipboard.writes.push({ at: Date.now(), stage: document.body.dataset.stage });
  } };
  // The execCommand fallback in a browser that refuses it too (linkedom has neither select nor execCommand).
  Object.getPrototypeOf(document.createElement('textarea')).select ??= () => {};
  document.execCommand ??= () => false;
  globalThis.getSelection ??= () => null;
  // Every text written to the live regions, in order.
  const writes = { announce: [] };
  for (const id of Object.keys(writes)) {
    const el = document.getElementById(id);
    let proto = el;
    let found;
    while ((proto = Object.getPrototypeOf(proto)) && !(found = Object.getOwnPropertyDescriptor(proto, 'textContent')));
    Object.defineProperty(el, 'textContent', { get() { return found.get.call(el); }, set(v) { writes[id].push(v); found.set.call(el, v); }, configurable: true });
  }
  // linkedom has no activeElement: record focus calls instead.
  const focused = [];
  for (const id of ['copy-llms']) document.getElementById(id).focus = () => focused.push(id);
  const badge = { text: null, history: [], titles: [] };
  const alarms = {};
  globalThis.document = document;
  globalThis.DOMParser = DOMParser;
  globalThis.matchMedia = (q) => ({ matches: q.includes('reduced-motion') ? reduced : false });
  const beacons = [];
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard, sendBeacon: (url, blob) => { beacons.push(blob); return true; } }, configurable: true });
  // Node has no window events: collect the popup's (pagehide) to fire them by hand.
  const windowListeners = {};
  globalThis.addEventListener = (type, fn) => { windowListeners[type] = fn; };
  local.devLibraryUrl ??= mock.url;
  local.telemetryNoticeShown ??= true;
  globalThis.chrome = {
    storage: {
      sync: {
        get: async (defaults) => ({ ...(typeof defaults === 'object' ? defaults : {}), share, ...sync }),
        remove: async () => {},
        set: async (o) => Object.assign(sync, o),
      },
      local: {
        get: async (key) => (typeof key === 'string' ? (key in local ? { [key]: local[key] } : {}) : { ...local }),
        set: async (o) => { Object.assign(local, structuredClone(o)); },
        remove: async (keys) => { for (const k of [keys].flat()) delete local[k]; },
      },
    },
    tabs: { query: async () => [{ id: 1, url, title: 'Guide' }], get: async () => ({ id: 1, url }) },
    scripting: { executeScript: async () => [{ result: liveHtml }] },
    runtime: { getManifest: () => MANIFEST, openOptionsPage() {}, setUninstallURL: async () => {} },
    management: { getSelf: async () => ({ installType }) },
    alarms: { create: (name, info) => { alarms[name] = info; }, clear: async (name) => { delete alarms[name]; return true; }, get: async (name) => alarms[name] },
    action: {
      setBadgeText: async ({ text }) => { badge.text = text; badge.history.push(text); },
      setBadgeBackgroundColor: async () => {},
      setTitle: async ({ title }) => { badge.titles.push(title); },
      ...(pinned === undefined ? {} : { getUserSettings: async () => ({ isOnToolbar: pinned }) }),
    },
  };
  const popup = await import(`../extension/popup.js?${Math.random()}`);
  const $ = (id) => document.getElementById(id);
  return { $, clipboard, badge, alarms, local, document, focused, writes, beacons, windowListeners, ready: popup.ready };
}

const posts = (path) => mock.log.filter((e) => e.method === 'POST' && e.path === path);
const gets = (prefix) => mock.log.filter((e) => e.method === 'GET' && e.path.startsWith(prefix));
const stages = () => stageLog.map((s) => s.name);
const queued = (local, name) => (local.telemetryQueue ?? []).filter((e) => e.name === name).map((e) => e.props);

async function withMock(opts, fn) {
  mock = await startMockLibrary(opts);
  try { return await fn(); } finally { mock.close(); }
}

test('llmsLevelFor: "1" llms.txt, "2" with instructions, from the list or what the popup learned (newer, 7 days); private hosts never; an old list shows nothing', () => {
  const llms = { 'docs.stripe.com': 2, 'stripe.com': 2, 'hono.dev': 1 };
  const now = Date.now();
  assert.equal(llmsLevelFor('https://docs.stripe.com/webhooks', { llms }), 2);
  assert.equal(llmsLevelFor('https://stripe.com/', { llms }), 2, 'aliases are listed too');
  assert.equal(llmsLevelFor('https://www.hono.dev/docs/', { llms }), 1, 'www. is the same site');
  assert.equal(llmsLevelFor('https://example.com/', { llms }), 0, 'unknown: nothing');
  assert.equal(llmsLevelFor('https://hono.dev/', { llms, learned: { 'hono.dev': { level: 2, at: now } } }), 2, 'the popup knows better');
  assert.equal(llmsLevelFor('https://hono.dev/', { llms, learned: { 'hono.dev': { level: 0, at: now } } }), 0, 'still preparing or not docs: nothing');
  assert.equal(llmsLevelFor('https://example.com/', { learned: { 'example.com': { level: 1, at: now - LEARNED_TTL_MS - 1 } } }), 0, 'kept 7 days');
  assert.equal(llmsLevelFor('http://localhost:3000/', { llms: { localhost: 1 } }), 0, 'private hosts are never looked up');
  assert.equal(llmsLevelFor('https://docs.stripe.com/', {}), 0, 'an old list without llms: nothing');
  assert.deepEqual(badgeFor('https://hono.dev/', { llms }), { level: 1, text: '1', title: 'scoop.md: llms.txt available' });
  assert.deepEqual(badgeFor('https://stripe.com/', { llms }), { level: 2, text: '2', title: 'scoop.md: llms.txt + instructions for agents' });
  assert.ok(!read('../extension/lib/badge.js').includes('OffscreenCanvas'), 'no icon overlays');
});

test('service worker: clears 0.5.x state, downloads the sites index with llms levels (then 304), sets "1" / "2" / nothing per tab in the brand colour with white text, no request per visit, counts once per tab per site', () => withMock({ sites: { 'hono.dev': { indexed: true, pages: 230, llmsLevel: 1 }, [SITE]: { indexed: true, pages: 14, llmsLevel: 2 }, 'amazon.com': { notDocs: true } } }, async () => {
  const local = { devLibraryUrl: mock.url, crawlPending: { x: {} }, popupView: 'advanced', introSeen: true, docsVerdicts: { 'a.dev': { v: 'docs', at: 1 } }, badgeVerdictsShown: { docs: 1 } };
  const syncStore = { share: false, telemetry: false };
  const badges = {};
  const colors = {};
  const textColors = {};
  const titles = {};
  const alarms = {};
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const tabs = { 7: { id: 7, url: 'https://hono.dev/docs/' }, 8: { id: 8, url: 'http://localhost:5173/' }, 9: { id: 9, url: 'https://www.amazon.com/' }, 10: { id: 10, url: PAGE } };
  globalThis.chrome = {
    storage: {
      local: { get: async (k) => (typeof k === 'string' ? (k in local ? { [k]: structuredClone(local[k]) } : {}) : { ...local }), set: async (o) => { Object.assign(local, structuredClone(o)); }, remove: async (ks) => { for (const k of [ks].flat()) delete local[k]; } },
      sync: { get: async (d) => ({ ...d, ...syncStore }), remove: async (k) => { for (const key of [k].flat()) delete syncStore[key]; } },
      onChanged: on('storage'),
    },
    runtime: { getManifest: () => MANIFEST, onInstalled: on('installed'), onStartup: on('startup'), setUninstallURL: async () => {}, getPlatformInfo: async () => ({}) },
    management: { getSelf: async () => ({ installType: 'development' }) },
    alarms: { create: (n, i) => { alarms[n] = i; }, clear: async (n) => { delete alarms[n]; return true; }, get: async (n) => alarms[n], onAlarm: on('alarm') },
    tabs: { onActivated: on('activated'), onUpdated: on('updated'), get: async (id) => tabs[id], query: async () => Object.values(tabs) },
    action: {
      setBadgeText: async ({ tabId, text }) => { badges[tabId] = text; },
      setBadgeBackgroundColor: async ({ tabId, color }) => { colors[tabId] = color; },
      setBadgeTextColor: async ({ tabId, color }) => { textColors[tabId] = color; },
      setTitle: async ({ tabId, title }) => { titles[tabId] = title; },
    },
  };
  await import(`../extension/background.js?${Math.random()}`);
  listeners.installed({ reason: 'install' });
  await waitFor(() => local[SITES_KEY]?.etag);
  await waitFor(() => local.docsVerdicts === undefined);
  for (const key of ['crawlPending', 'popupView', 'introSeen', 'docsVerdicts', 'badgeVerdictsShown']) assert.equal(local[key], undefined, `0.5.x ${key} removed`);
  assert.equal(syncStore.share, undefined, 'the sharing setting removed');
  assert.deepEqual(local[SITES_KEY].llms, { 'hono.dev': 1, [SITE]: 2 });
  assert.equal(alarms[SITES_ALARM].periodInMinutes, 360, 'every 6 hours');
  const before = mock.log.length;
  listeners.activated({ tabId: 7 });
  for (const id of [8, 9, 10]) listeners.updated(id, { status: 'complete' }, tabs[id]);
  await waitFor(() => [7, 8, 9, 10].every((id) => badges[id] !== undefined));
  assert.equal(badges[7], '1');
  assert.equal(titles[7], 'scoop.md: llms.txt available');
  assert.equal(colors[7], '#c2410c', 'the scoop orange, not green');
  assert.equal(textColors[7], '#ffffff');
  assert.equal(badges[10], '2');
  assert.equal(titles[10], 'scoop.md: llms.txt + instructions for agents');
  assert.equal(badges[9], '', 'not a developer site: nothing (no "!")');
  assert.equal(badges[8], '', 'localhost: nothing');
  assert.equal(titles[9], 'Scoop to agent');
  assert.equal(mock.log.length, before, 'no network request per visit');
  listeners.alarm({ name: SITES_ALARM });
  await waitFor(() => mock.log.filter((e) => e.path === '/v1/sites/index').length === 2);
  await sleep(20);
  assert.deepEqual(local[SITES_KEY].llms, { 'hono.dev': 1, [SITE]: 2 }, '304 keeps the copy');
  await waitFor(() => local.badgeLlmsShown?.[1] === 1 && local.badgeLlmsShown?.[2] === 1);
  listeners.updated(7, { status: 'complete' }, tabs[7]);
  listeners.activated({ tabId: 10 });
  await sleep(30);
  assert.deepEqual(local.badgeLlmsShown, { 1: 1, 2: 1 }, 'same tab, same site: not counted again');
  tabs[7] = { id: 7, url: PAGE };
  listeners.updated(7, { status: 'complete' }, tabs[7]);
  await waitFor(() => local.badgeLlmsShown?.[2] === 2);
}));

test('setTabBadge reads what is stored now: what the popup just learned shows at once', async () => {
  const local = {};
  const badges = {};
  const chromeApi = {
    storage: { local: { get: async (k) => (k in local ? { [k]: structuredClone(local[k]) } : {}), set: async (o) => Object.assign(local, structuredClone(o)) } },
    action: { setBadgeText: async ({ tabId, text }) => { badges[tabId] = text; }, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  };
  assert.equal(await setTabBadge(chromeApi, { id: 3, url: PAGE }), 0);
  assert.equal(badges[3], '', 'unknown: nothing');
  await rememberLlms(chromeApi, SITE, 2);
  assert.equal(await setTabBadge(chromeApi, { id: 3, url: PAGE }), 2);
  assert.equal(badges[3], '2');
  await rememberLlms(chromeApi, 'example.com', 0);
  assert.equal(await setTabBadge(chromeApi, { id: 4, url: 'https://example.com/' }), 0);
  assert.equal(badges[4], '');
});

test('refreshSites: an unchanged list (304) keeps the copy; a new one replaces it', () => withMock({ sites: { 'hono.dev': { indexed: true, pages: 4 } } }, async () => {
  const local = {};
  const chromeApi = { storage: { local: { get: async (k) => (k in local ? { [k]: structuredClone(local[k]) } : {}), set: async (o) => Object.assign(local, structuredClone(o)) } } };
  const lib = createLibrary({ baseUrl: mock.url, installId: 'x', client: 't' });
  assert.equal(await refreshSites(chromeApi, lib), true);
  assert.equal(await refreshSites(chromeApi, lib), false, '304');
  mock.sites['hono.dev'].pages = 9;
  assert.equal(await refreshSites(chromeApi, lib), true);
  assert.deepEqual(local[SITES_KEY].sites, { 'hono.dev': 9 });
}));

test('pin hint: one line until dismissed, only while scoop.md is not pinned', () => withMock({ sites: { [SITE]: { status: 'not_devtool' } } }, async () => {
  const p = await openPopup(PAGE, { pinned: false });
  await p.ready;
  assert.equal(p.$('pin-hint').hidden, false);
  assert.match(p.$('pin-hint').textContent, /Pin scoop\.md to see which sites have an llms\.txt/);
  p.$('pin-ok').onclick();
  assert.equal(p.$('pin-hint').hidden, true);
  assert.equal(p.local.pinHintSeen, true);
  const again = await openPopup(PAGE, { pinned: false, local: { pinHintSeen: true } });
  await again.ready;
  assert.equal(again.$('pin-hint').hidden, true, 'once');
  const pinned = await openPopup(PAGE, { pinned: true });
  await pinned.ready;
  assert.equal(pinned.$('pin-hint').hidden, true, 'not when pinned');
}));

test('no paywall words in the popup or settings: this is an open source project', () => {
  for (const f of ['../extension/popup.html', '../extension/popup.js', '../extension/options.html', '../extension/options.js']) {
    const src = read(f);
    for (const word of [/upgrad/i, /premium/i, /unlock/i, /\bpro\b/i, /full version/i]) assert.ok(!word.test(src), `${f}: ${word}`);
  }
});

test('service worker: badge_llms_shown per level, hourly, no sites', async () => {
  const local = { badgeLlmsShown: { 1: 3, 2: 1 }, telemetryNoticeShown: true };
  const chromeApi = { storage: { local: { get: async (k) => (k in local ? { [k]: structuredClone(local[k]) } : {}), set: async (o) => Object.assign(local, o), remove: async (k) => { delete local[k]; } } } };
  const { takeShownCounts } = await import('../extension/lib/badge.js');
  assert.deepEqual(await takeShownCounts(chromeApi), { 1: 3, 2: 1 });
  assert.equal(local.badgeLlmsShown, undefined);
  assert.match(read('../extension/background.js'), /t\.track\('badge_llms_shown', \{ level: Number\(level\), count \}\)/);
});

// The main view (0.6.0): the site's llms.txt as a prompt

const NOW = new Date().toISOString();
const PROMPT = 'Example docs for agents: https://docs.example.com/llms.txt — read it first, then fetch only the pages you need.';
const llmsAnswer = (over = {}, llms = {}) => ({
  site: SITE,
  docs: { found: true, root: `https://${SITE}`, verdict: 'yes' },
  llms: { url: `https://${SITE}/llms.txt`, source: 'site', status: 'ready', title: 'Example docs', pages: 412, tokens: 23000, checkedAt: NOW, fullUrl: null, ...llms },
  prompt: PROMPT,
  retryAfterMs: null,
  ...over,
});
const main = (p) => ({
  field: p.$('llms-block').hidden ? null : p.$('llms-field-text').textContent,
  meta: p.$('llms-block').hidden ? null : p.$('llms-meta').textContent,
  badge: !p.$('llms-badge').hidden,
  agent: p.$('agent-block').hidden ? null : p.$('agent-text').textContent,
  button: p.$('copy-llms').hidden ? null : p.$('copy-llms-label').textContent,
  notDev: p.$('not-dev').hidden ? null : p.$('not-dev').textContent,
});

test('main view, the site’s own llms.txt: the llms.txt field (opens the file), the prompt copied at once (exact text), and nothing else runs', () => withMock({ sites: { [SITE]: { llmsApi: llmsAnswer() } } }, async () => {
  const p = await openPopup(PAGE, {});
  await p.ready;
  assert.equal(p.clipboard.text, PROMPT, 'the exact prompt');
  const { meta, ...rest } = main(p);
  assert.deepEqual(rest, { field: `${SITE}/llms.txt`, badge: false, agent: null, button: 'Copied', notDev: null });
  assert.match(meta, /^412 pages · checked today · found in \d+\.\ds$/, 'the final time stays in the meta');
  const stopped = p.$('elapsed').textContent;
  assert.match(stopped, /^\d+\.\ds$/);
  await sleep(250);
  assert.equal(p.$('elapsed').textContent, stopped, 'the timer stopped on success');
  assert.equal(p.$('llms-field').getAttribute('href'), `https://${SITE}/llms.txt`, 'the field opens the file');
  assert.equal(p.$('llms-field').getAttribute('target'), '_blank');
  assert.equal(p.$('llms-status').textContent, '', 'the button says it');
  await sleep(80);
  assert.equal(p.$('announce').textContent, `${SITE}: llms.txt. Copied to your clipboard.`);
  assert.deepEqual(stages(), ['loading', 'copied', 'content']);
  assert.equal(p.$('main').hidden, false);
  assert.deepEqual(gets('/v1/llms')[0].query, { url: `https://${SITE}/docs` }, 'only the origin and the first path segment');
  assert.equal(gets('/v1/packages').length + gets('/v1/quick').length + posts('/v1/skills').length + posts('/v1/crawl-requests').length, 0, 'no page scoop, no share, no crawl');
  assert.deepEqual(queued(p.local, 'llms_copy'), [{ site: SITE, source: 'site', trigger: 'auto' }]);
  await waitFor(() => p.local.llmsLevels?.[SITE]?.level === 1);
  await waitFor(() => p.badge.text === '1');
  await p.$('copy-llms').onclick();
  await waitFor(() => queued(p.local, 'llms_copy').length === 2);
  assert.deepEqual(queued(p.local, 'llms_copy').at(-1), { site: SITE, source: 'site', trigger: 'button' });
  await p.$('copy-llms-url').onclick();
  assert.equal(p.clipboard.text, `https://${SITE}/llms.txt`, 'the small copy icon: the link alone');
  assert.equal(p.$('copy-llms-url').dataset.done, 'true');
  assert.equal(p.$('copy-llms-url').getAttribute('aria-label'), 'Copy the llms.txt link');
  assert.equal(p.$('llms-field').getAttribute('aria-label'), `Open https://${SITE}/llms.txt`);
}));

const INSTRUCTIONS_TEXT = 'Install the CLI with `npm i -g example`.\nSet EXAMPLE_KEY before you start.\nUse the MCP server at https://mcp.example.com.\nLine 4.\nLine 5.';
const PROMPT_WITH = `${PROMPT}\n\nFrom the Example docs, for agents (https://docs.example.com/llms.txt#instructions-for-agents):\n${INSTRUCTIONS_TEXT}`;

test('main view with instructions for agents: shown verbatim, collapsed after ~4 lines with "Show all ⌄", their own copy icon; the big button copies the prompt as given (it carries them); the badge says "2"', () => withMock({ sites: { [SITE]: { llmsApi: llmsAnswer({ prompt: PROMPT_WITH, agentInstructions: { text: INSTRUCTIONS_TEXT, source: `https://${SITE}/llms.txt#instructions-for-agents`, method: 'section' } }) } } }, async () => {
  const p = await openPopup(PAGE, {});
  await p.ready;
  assert.equal(p.clipboard.text, PROMPT_WITH, 'the prompt, unchanged');
  assert.equal(main(p).agent, INSTRUCTIONS_TEXT, 'verbatim');
  assert.equal(p.$('agent-text').dataset.collapsed, 'true');
  assert.equal(p.$('agent-more').textContent, 'Show all ⌄');
  assert.equal(p.$('agent-more').className, 'more', 'a quiet text button, not an underlined link');
  assert.equal(p.$('agent-more').hidden, false);
  p.$('agent-more').onclick();
  assert.equal(p.$('agent-text').dataset.collapsed, 'false');
  assert.equal(p.$('agent-more').hidden, true);
  await sleep(timing.copiedLabelMs + 20);
  assert.equal(p.$('copy-llms-label').textContent, 'Copy llms.txt + instructions');
  await p.$('copy-agent').onclick();
  assert.equal(p.clipboard.text, INSTRUCTIONS_TEXT, 'the small copy icon: the instructions alone');
  await waitFor(() => p.local.llmsLevels?.[SITE]?.level === 2);
  await waitFor(() => p.badge.text === '2');
}));

test('main view without instructions for agents: no block, "Copy llms.txt", the badge says "1"', () => withMock({ sites: { [SITE]: { llmsApi: llmsAnswer({ agentInstructions: null }) } } }, async () => {
  const p = await openPopup(PAGE, {});
  await p.ready;
  assert.equal(main(p).agent, null);
  await sleep(timing.copiedLabelMs + 20);
  assert.equal(p.$('copy-llms-label').textContent, 'Copy llms.txt');
  await waitFor(() => p.badge.text === '1');
}));

test('main view: only the page’s origin and first path segment go to /v1/llms; docs on another host show their llms.txt there', () => withMock({ sites: { [SITE]: { llmsApi: llmsAnswer({ docs: { found: true, root: `https://${SUB}`, verdict: 'yes' } }, { url: `https://${SUB}/llms.txt` }) } } }, async () => {
  const p = await openPopup(`https://${SITE}/docs/guide/deep/page?tab=js&utm_source=x#install`, {});
  await p.ready;
  assert.deepEqual(gets('/v1/llms')[0].query, { url: `https://${SITE}/docs` }, 'origin and first path segment only');
  assert.equal(main(p).field, `${SUB}/llms.txt`);
}));

test('main view, an llms.txt prepared by scoop.md: the "by scoop.md" badge', () => withMock({ sites: { [SITE]: { llmsApi: llmsAnswer({ prompt: 'Example docs for agents (llms.txt prepared by scoop.md): https://scoop.md/docs.example.com/llms.txt — read it first, then fetch only the pages you need.' }, { source: 'scoop', url: 'https://scoop.md/docs.example.com/llms.txt' }) } } }, async () => {
  const p = await openPopup(PAGE, {});
  await p.ready;
  assert.equal(p.clipboard.text, 'Example docs for agents (llms.txt prepared by scoop.md): https://scoop.md/docs.example.com/llms.txt — read it first, then fetch only the pages you need.');
  assert.equal(main(p).badge, true);
  assert.equal(main(p).field, 'scoop.md/docs.example.com/llms.txt');
  assert.deepEqual(queued(p.local, 'llms_copy').map((e) => e.source), ['scoop']);
}));

test('main view, preparing: copied at once, "Preparing…", then asked again until ready', () => withMock({ sites: { [SITE]: { llmsApi: [
  llmsAnswer({ retryAfterMs: 20, prompt: 'P1' }, { source: 'scoop', status: 'preparing', url: 'https://scoop.md/docs.example.com/llms.txt' }),
  llmsAnswer({ retryAfterMs: 20, prompt: 'P1' }, { source: 'scoop', status: 'preparing', url: 'https://scoop.md/docs.example.com/llms.txt' }),
  llmsAnswer({ prompt: 'P2' }, { source: 'scoop', status: 'ready', url: 'https://scoop.md/docs.example.com/llms.txt', pages: 230 }),
] } } }, async () => {
  const p = await openPopup(PAGE, {});
  await p.ready;
  assert.equal(p.clipboard.text, 'P1', 'the URL already works: copied at once');
  assert.match(main(p).meta, /^Preparing… \d+\.\ds$/, 'the clock keeps running while it is prepared');
  const first = main(p).meta;
  await sleep(250);
  assert.notEqual(main(p).meta, first, 'it ticks');
  await waitFor(() => /^230 pages · checked today · prepared in \d+\.\ds$/.test(main(p).meta), 4000);
  assert.equal(gets('/v1/llms').length, 3);
  await p.$('copy-llms').onclick();
  assert.equal(p.clipboard.text, 'P2', 'the latest prompt');
}));

test('main view, not a developer site: one line, nothing else, nothing copied; the toolbar learns it', () => withMock({ sites: { [SITE]: {} } }, async () => {
  const p = await openPopup(PAGE, {});
  await p.ready;
  assert.deepEqual(main(p), { field: null, meta: null, badge: false, agent: null, button: null, notDev: "scoop.md has nothing to copy for this site." });
  assert.equal(p.clipboard.text, null);
  assert.deepEqual(stages(), ['loading', 'content'], 'no copied moment');
  assert.deepEqual(queued(p.local, 'llms_copy'), []);
  await waitFor(() => p.local.llmsLevels?.[SITE]?.level === 0);
  assert.equal(p.badge.text, '', 'no "!": nothing');
}));

test('main view, the library unreachable: the site’s own verified llms.txt gives the same prompt here', () => withMock({ sites: {} }, async () => {
  const p = await openPopup(`https://${SUB}/guide`, { local: { devLibraryUrl: 'http://localhost:9/v1' } });
  await p.ready;
  assert.equal(p.clipboard.text, 'Example docs for agents: https://docs.example.org/llms.txt — read it first, then fetch only the pages you need.');
  assert.equal(main(p).field, `${SUB}/llms.txt`);
  assert.match(main(p).meta, /^1 page · checked today · found in \d+\.\ds$/, 'the fallback stops the clock too');
  assert.deepEqual(queued(p.local, 'llms_copy').map((e) => e.source), ['fallback']);
  assert.equal(p.local.llmsLevels, undefined, 'a local find is not learned');
}));

test('main view, the library unreachable and no llms.txt here: "Couldn’t reach scoop.md" and Retry', () => withMock({ sites: { [SITE]: { llmsApi: llmsAnswer() } } }, async () => {
  const p = await openPopup(PAGE, { local: { devLibraryUrl: 'http://localhost:9/v1' } });
  await p.ready;
  assert.equal(p.$('llms-status').textContent, "Couldn't reach scoop.md");
  assert.equal(p.$('llms-retry').hidden, false);
  assert.equal(p.$('copy-llms').hidden, true);
  assert.equal(p.$('llms-block').hidden, true);
  assert.equal(p.clipboard.text, null);
}));

test('0.6.0: the version (0.6.1), the button wording, one view only, and only the permissions it needs', () => {
  assert.equal(MANIFEST.version, '0.6.1');
  const html = read('../extension/popup.html');
  assert.match(html, /<span id="copy-llms-label">Copy llms\.txt<\/span>/);
  assert.match(html, /scoop.md has nothing to copy for this site./);
  assert.ok(!/Advanced|Overview|Search|tab-page|This page/.test(html), 'no Advanced, no tabs');
  assert.deepEqual(MANIFEST.permissions, ['clipboardWrite', 'storage', 'alarms'], 'no scripting or activeTab: the page itself is never read');
});



test('main view: a long llms.txt URL is cut in the middle, so its host and its end show', () => withMock({ sites: { [SITE]: { llmsApi: llmsAnswer({}, { url: 'https://api-staging.scoop.md/v1/llms/docs.python.org/llms.txt', source: 'scoop' }) } } }, async () => {
  const p = await openPopup(PAGE, {});
  await p.ready;
  assert.equal(main(p).field, 'api-staging.scoop…ython.org/llms.txt');
  assert.equal(p.$('llms-field-text').title, 'https://api-staging.scoop.md/v1/llms/docs.python.org/llms.txt');
  assert.equal(main(p).badge, true);
}));

test('the loader stays at least loaderMs, the copy lands before the copied moment; reduced motion gets a short still moment', async () => {
  await withMock({ sites: { [SITE]: { llmsApi: llmsAnswer() } } }, async () => {
    timing.loaderMs = 300;
    const p = await openPopup(PAGE);
    await p.ready;
    const [loading, copiedStage] = stageLog;
    assert.ok(copiedStage.at - loading.at >= 280, `loader shown for ${copiedStage.at - loading.at} ms`);
    assert.equal(p.clipboard.writes[0].stage, 'loading', 'copied while the loader was still up');
    assert.deepEqual(queued(p.local, 'copied_animation_shown'), [{ reducedMotion: false }]);
  });
  stageLog.length = 0;
  await withMock({ sites: { [SITE]: { llmsApi: llmsAnswer() } } }, async () => {
    Object.assign(timing, { loaderMs: 0, celebrateMs: 400, reducedMs: 20 });
    const p = await openPopup(PAGE, { reduced: true });
    await p.ready;
    assert.equal(p.document.body.dataset.motion, 'reduced');
    const copiedAt = stageLog.find((x) => x.name === 'copied').at;
    const contentAt = stageLog.find((x) => x.name === 'content').at;
    assert.ok(contentAt - copiedAt < 200, `held ${contentAt - copiedAt} ms`);
  });
});

test('nothing at all reaches the library for pages on private hosts (store install); the popup looks for an llms.txt there itself', () => withMock({ sites: {} }, async () => {
  const p = await openPopup('http://localhost:5173/docs', { installType: 'normal' });
  await p.ready;
  assert.equal(mock.log.length, 0);
  assert.equal(p.$('llms-status').textContent, "Couldn't reach scoop.md");
}));

test('usage statistics notice: shown once; Turn off sends nothing more', () => withMock({ sites: { [SITE]: { llmsApi: llmsAnswer() } } }, async () => {
  const p = await openPopup(PAGE, { local: { telemetryNoticeShown: false } });
  await p.ready;
  assert.equal(p.$('usage-notice').hidden, false);
  assert.match(p.$('usage-notice-text').textContent, /hostname of the sites you open it on/);
  await p.$('usage-off').onclick();
  assert.equal(p.$('usage-notice-text').textContent, 'Usage statistics are off. You can turn them back on in Settings.');
  const again = await openPopup(PAGE, { local: { telemetryNoticeShown: true } });
  await again.ready;
  assert.equal(again.$('usage-notice').hidden, true);
}));

test('the elapsed timer: under the loader, every 100 ms (once a second with reduced motion); it stops on an error too', async () => {
  await withMock({ sites: { [SITE]: { llmsApi: llmsAnswer(), llmsDelayMs: 450 } } }, async () => {
    timing.loaderMs = 0;
    const p = await openPopup(PAGE);
    await sleep(320);
    assert.equal(p.document.body.dataset.stage, 'loading');
    assert.match(p.$('elapsed').textContent, /^0\.[2-4]s$/, `ticks every 100 ms: ${p.$('elapsed').textContent}`);
    await p.ready;
  });
  await withMock({ sites: { [SITE]: { llmsApi: llmsAnswer(), llmsDelayMs: 450 } } }, async () => {
    const p = await openPopup(PAGE, { reduced: true });
    await sleep(320);
    assert.equal(p.$('elapsed').textContent, '0.0s', 'reduced motion: once a second');
    await p.ready;
  });
  await withMock({ sites: {} }, async () => {
    const p = await openPopup(PAGE, { local: { devLibraryUrl: 'http://localhost:9/v1' } });
    await p.ready;
    const stopped = p.$('elapsed').textContent;
    await sleep(250);
    assert.equal(p.$('elapsed').textContent, stopped, 'stopped on "Couldn\'t reach scoop.md"');
  });
});
