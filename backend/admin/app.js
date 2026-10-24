// scoop.md admin console. One module, no build step, no dependencies.
// Everything crawled or shared is rendered as text (textContent, never
// innerHTML), and links to crawled URLs only ever carry http(s) hrefs.
// The JSON API is same-origin (/api/*); the browser's Basic auth covers it.

const $view = document.getElementById('view');
const REFRESH_MS = 5000;
let timer = null;
let generation = 0;

// ---- DOM helpers -------------------------------------------------------------

// h('a', { class: 'x', href: '#/', onclick }, 'text', child, [more]) — strings become text nodes.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'href') el.setAttribute('href', safeHref(v));
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Internal hash routes, or http(s) URLs. Anything else (javascript:, data:) becomes inert.
function safeHref(v) {
  const s = String(v);
  if (s.startsWith('#/')) return s;
  try {
    const u = new URL(s);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
  } catch {}
  return '#';
}

const ext = (url, label = url) => h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'mono' }, label);
const enc = encodeURIComponent;
const fmtInt = (n) => (n ?? 0).toLocaleString('en-US');
const fmtUsd = (n, d = 4) => `$${Number(n ?? 0).toFixed(d)}`;
const fmtBytes = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(2)} MB`);

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 0) return d.toISOString().slice(0, 16).replace('T', ' ');
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
const time = (iso) => (iso ? h('time', { datetime: iso, title: iso }, fmtTime(iso)) : '');

function duration(a, b) {
  if (!a) return '';
  const s = Math.max(0, ((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000);
  return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

const ACTIVE = new Set(['queued', 'running', 'starting', 'crawling', 'waiting', 'busy', 'indexing']);
const PILL = {
  queued: 'running', running: 'running', starting: 'running', crawling: 'running', waiting: '', busy: 'running', indexing: 'running',
  complete: 'complete', ready: 'complete',
  rejected: 'rejected', not_devtool: 'rejected', cancelled: 'rejected', empty: 'rejected',
  failed: 'failed', error: 'failed', blocked: 'failed',
};
const LABEL = { not_devtool: 'rejected (not devtool)' };
const pill = (status) => h('span', { class: `pill ${PILL[status] ?? ''}` }, LABEL[status] ?? status ?? '—');

function table(cols, rows, empty = 'Nothing here yet.') {
  if (!rows.length) return h('p', { class: 'empty' }, empty);
  return h('div', { class: 'table' },
    h('table', {},
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.cls }, c.label)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, cols.map((c) => h('td', { class: c.cls }, c.get(r))))))));
}

const card = (title, ...body) => h('section', { class: 'card' }, title ? h('h2', {}, title) : null, ...body);
const stat = (value, label, extra) => h('div', { class: 'stat' }, h('b', {}, value), h('span', {}, label), extra ?? null);

function meter(used, cap) {
  const m = h('div', { class: `meter${used >= cap ? ' over' : ''}` }, h('i'));
  m.firstChild.style.width = `${Math.min(100, cap > 0 ? (used / cap) * 100 : 0)}%`;
  return m;
}

function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast${bad ? ' bad' : ''}`;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 3500);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { class: 'offscreen' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`Copied ${fmtBytes(new Blob([text]).size)}`);
}

function markdownBlock(text, { short = false, label = 'Copy' } = {}) {
  const pre = h('pre', { class: `md${short ? ' short' : ''}` });
  pre.textContent = text;
  return h('div', { class: 'grid' },
    h('div', { class: 'row' },
      h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(text) }, label),
      h('span', { class: 'meta small' }, `${fmtInt(text.length)} characters · ${fmtBytes(new Blob([text]).size)}`)),
    pre);
}

// ---- API ---------------------------------------------------------------------

class ApiFailure extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiFailure(res.status, data?.error?.message ?? `HTTP ${res.status}`);
  return data;
}

async function act(button, fn, done) {
  button.disabled = true;
  try {
    const r = await fn();
    if (done) toast(typeof done === 'function' ? done(r) : done);
    render();
    return r;
  } catch (e) {
    toast(e.message, true);
  } finally {
    button.disabled = false;
  }
}

// ---- Router ------------------------------------------------------------------

function route() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  return { parts, params: new URLSearchParams(query) };
}

const VIEWS = {
  '': overview, crawls, runs: runDetail, batches: batchDetail, seeds, sites: (r) => (r.parts[1] ? siteDetail(r) : sites(r)),
  page: pageDetail, agent, library: (r) => (r.parts[1] ? librarySite(r) : library(r)), skills: skillDetail, costs, telemetry,
  requests: crawlRequests,
};
const NAV = { '': 'overview', runs: 'crawls', batches: 'crawls', page: 'sites', skills: 'library' };

async function render() {
  const r = route();
  const key = r.parts[0] ?? '';
  const view = VIEWS[key];
  const mine = ++generation;
  clearTimeout(timer);
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('on', a.dataset.nav === (NAV[key] ?? key));
  if (!view) return show(mine, [card('Not found', h('p', {}, 'No such page. '), h('a', { href: '#/' }, 'Back to the overview'))]);
  let out;
  $view.setAttribute('aria-busy', 'true');
  try {
    out = await view(r);
  } catch (e) {
    out = { nodes: [card('Something went wrong', h('p', { class: 'err' }, e.message))] };
  }
  show(mine, out.nodes ?? out, out.live);
}

// Swaps the view in (unless the user navigated meanwhile) and, while anything
// is running, re-renders every REFRESH_MS. Inputs keep focus and values.
function show(mine, nodes, live = false) {
  if (mine !== generation) return;
  $view.removeAttribute('aria-busy');
  const focused = document.activeElement?.id;
  const values = Object.fromEntries([...$view.querySelectorAll('input[id], select[id]')].map((i) => [i.id, i.type === 'checkbox' ? i.checked : i.value]));
  const keep = $view.dataset.hash === location.hash;
  $view.replaceChildren(...nodes);
  $view.dataset.hash = location.hash;
  if (keep) {
    for (const [id, v] of Object.entries(values)) {
      const el = document.getElementById(id);
      if (el) el.type === 'checkbox' ? (el.checked = v) : (el.value = v);
    }
    if (focused) document.getElementById(focused)?.focus();
  }
  if (live) timer = setTimeout(() => !document.hidden && mine === generation && render(), REFRESH_MS);
}

window.addEventListener('hashchange', () => {
  delete $view.dataset.hash;
  render();
  window.scrollTo(0, 0);
});
document.addEventListener('visibilitychange', () => !document.hidden && render());

// Theme: follows the system unless switched; remembered per browser.
const themeKey = 'scoop-admin-theme';
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
try { applyTheme(localStorage.getItem(themeKey)); } catch {}
document.getElementById('theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(themeKey, next); } catch {}
});

// ---- Shared pieces -----------------------------------------------------------

const siteLink = (site) => h('a', { href: `#/sites/${enc(site)}`, class: 'mono' }, site);
// IDs end in their random part: phones show only the last 8 characters.
const shortId = (id) => [h('span', { class: 'hide-sm' }, id.slice(0, -8)), id.slice(-8)];
const runLink = (id) => h('a', { href: `#/runs/${id}`, class: 'mono', title: id }, shortId(id));
const pageLink = (url, label = url) => h('a', { href: `#/page?url=${enc(url)}`, class: label === url ? 'mono' : undefined }, label);

function gateText(g) {
  if (!g) return '';
  return [g.decision, g.category, g.method && `(${g.method})`].filter(Boolean).join(' ');
}

// A run's total: final once its pages are indexed, else marked as still growing.
function costCell(c) {
  const title = `browser ${fmtUsd(c.browserUsd)} · gate ${fmtUsd(c.gateUsd)} · classify ${fmtUsd(c.classifyUsd)} · embed ${fmtUsd(c.embedUsd, 6)}`;
  const note = !c.tracked ? ' (no indexing costs)' : c.indexingDone ? null : ' +indexing';
  return h('span', { title }, fmtUsd(c.totalUsd, 5), note ? h('span', { class: 'meta small' }, note) : null);
}

const pagesCell = (r) => `${fmtInt(r.pagesNew)} new · ${fmtInt(r.pagesChanged)} chg · ${fmtInt(r.pagesUnchanged)} same${r.pagesFailed ? ` · ${r.pagesFailed} failed` : ''}`;

function runsTable(runs, { site = true } = {}) {
  return table([
    { label: 'Run', get: (r) => runLink(r.id) },
    site && { label: 'Site', get: (r) => siteLink(r.site) },
    { label: 'Status', get: (r) => pill(r.status) },
    { label: 'Gate', get: (r) => (r.forced ? 'forced' : gateText(r.gate)), cls: 'hide-sm' },
    { label: 'Path', get: (r) => r.path ?? '' },
    { label: 'Pages', get: pagesCell, cls: 'nowrap' },
    { label: 'Total cost', get: (r) => costCell(r.costs), cls: 'num' },
    { label: 'Started', get: (r) => time(r.startedAt), cls: 'nowrap' },
    { label: 'Took', get: (r) => duration(r.startedAt, r.finishedAt), cls: 'num' },
    { label: 'Error', get: (r) => (r.error ? h('span', { class: r.status === 'rejected' ? 'warn small' : 'err small' }, r.error) : ''), cls: 'hide-sm' },
  ].filter(Boolean), runs, 'No crawl runs yet.');
}

function pager(next, params, base) {
  const cursor = Number(params.get('cursor') ?? 0);
  const link = (c) => {
    const p = new URLSearchParams(params);
    if (c) p.set('cursor', String(c)); else p.delete('cursor');
    const qs = p.toString();
    return `${base}${qs ? `?${qs}` : ''}`;
  };
  if (!next && !cursor) return null;
  return h('div', { class: 'pager' },
    cursor ? h('a', { class: 'btn ghost sm', href: link(Math.max(0, cursor - 50)) }, '← Newer') : null,
    next ? h('a', { class: 'btn ghost sm', href: link(next) }, 'Older →') : null);
}

function crawlForm(defaults = {}) {
  const url = h('input', { id: 'crawl-url', type: 'url', class: 'wide', placeholder: 'https://docs.example.com/', required: true, value: defaults.url ?? '' });
  const max = h('input', { id: 'crawl-max', type: 'number', class: 'num', min: 1, max: 1000, value: defaults.maxPages ?? 200 });
  const force = h('input', { id: 'crawl-force', type: 'checkbox' });
  const go = h('button', { class: 'btn', type: 'submit' }, defaults.label ?? 'Start crawl');
  return h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      act(go, () => api('crawl', { method: 'POST', body: { url: url.value.trim(), maxPages: Number(max.value), force: force.checked } }),
        (r) => `Started ${r.runId} for ${r.site}`);
    },
  },
  h('label', { class: 'field' }, 'Start URL', url),
  h('label', { class: 'field' }, 'Max pages', max),
  h('label', { class: 'check' }, force, 'Skip the devtool gate'),
  go);
}

// ---- Overview ----------------------------------------------------------------

async function overview() {
  const o = await api('overview');
  const env = document.getElementById('env');
  env.textContent = o.environment;
  env.className = `env ${o.environment}`;
  env.hidden = false;
  const active = (o.runs.queued ?? 0) + (o.runs.running ?? 0);
  const s = o.sites.byStatus;
  return {
    live: active > 0 || o.batchesRunning > 0,
    nodes: [
      h('div', { class: 'head' }, h('h1', {}, 'Overview'), active ? h('span', { class: 'live' }, 'live') : null, h('span', { class: 'meta' }, `UTC day ${o.day}`)),
      card('Sites', h('div', { class: 'stats' },
        stat(fmtInt(o.sites.total), 'sites'),
        stat(fmtInt(s.ready), 'ready'),
        stat(fmtInt(o.sites.crawling), 'crawling now'),
        stat(fmtInt(s.not_devtool), 'rejected (not devtool)'),
        stat(fmtInt(s.failed), 'failed'),
        stat(fmtInt((s.empty ?? 0) + (s.blocked ?? 0) + (s.new ?? 0)), 'empty, blocked or new')),
      h('div', { class: 'row small' }, Object.entries(s).map(([k, v]) => h('a', { href: `#/sites?status=${enc(k)}` }, pill(k), ` ${v}`)))),
      card('Content', h('div', { class: 'stats' },
        stat(fmtInt(o.pages), 'pages stored'),
        stat(fmtInt(o.indexed), 'pages indexed'),
        stat(fmtInt(o.chunks), 'chunks'),
        stat(fmtInt(o.skills), 'shared skills'),
        stat(fmtInt(o.openReports), 'open reports'))),
      card('Index backlog', h('div', { class: 'stats' },
        stat(fmtInt(o.backlog.indexPending), 'waiting to be queued'),
        stat(fmtInt(o.backlog.awaitingIndex), 'not indexed at current content'),
        stat(fmtInt(o.backlog.unclassified), 'indexed unclassified'),
        stat(fmtInt(o.backlog.classifyFailed), 'classification failed')),
      h('p', { class: 'meta small' }, 'Unclassified and failed pages are picked up by the daily reclassify job (04:17 UTC).')),
      card(h('span', {}, 'Crawl requests ', h('a', { href: '#/requests', class: 'small' }, 'open')), h('div', { class: 'stats' },
        stat(fmtInt(o.crawlRequests.started), `crawls started today of ${fmtInt(o.crawlRequests.capPerDay)} cap`, meter(o.crawlRequests.started, o.crawlRequests.capPerDay)),
        stat(fmtInt(o.crawlRequests.total), 'requests today'),
        stat(fmtInt(o.crawlRequests.byOutcome.joined), 'joined a running crawl'),
        stat(fmtInt(o.crawlRequests.byOutcome.recent), 'answered from a recent crawl'),
        stat(fmtInt(o.crawlRequests.byOutcome.rejected), 'not a devtool site'),
        stat(h('a', { href: '#/sites?status=pending' }, fmtInt(o.pendingApproval)), 'sites pending approval'))),
      card(h('span', {}, 'Crawls ', h('a', { href: '#/crawls', class: 'small' }, 'open')), h('div', { class: 'stats' },
        stat(fmtInt(o.runs.queued), 'queued'),
        stat(fmtInt(o.runs.running), 'running'),
        stat(fmtInt(o.runs.complete), 'complete today'),
        stat(fmtInt(o.runs.rejected), 'rejected today'),
        stat(fmtInt(o.runs.failed), 'failed today'),
        stat(fmtInt(o.batchesRunning), 'batches running'))),
      card('Spend today', h('div', { class: 'stats' },
        stat(fmtUsd(o.aiSpend.totalUsd), `AI of ${fmtUsd(o.aiSpend.totalCapUsd, 2)} daily cap`, meter(o.aiSpend.totalUsd, o.aiSpend.totalCapUsd)),
        stat(fmtUsd(o.gateCostUsd), 'of which devtool gate'),
        stat(`${fmtInt(Math.round(o.e2b.seconds))} s`, 'E2B sandbox time'),
        stat(fmtUsd(o.e2b.costUsd), `E2B of ${fmtUsd(o.e2bCapUsd, 2)} daily cap`, meter(o.e2b.costUsd, o.e2bCapUsd))),
      o.secrets.openrouter ? null : h('p', { class: 'warn small' }, 'OPENROUTER_API_KEY is not set: pages are indexed unclassified and the gate cannot ask the AI.'),
      table([
        { label: 'Site', get: (r) => siteLink(r.site) },
        { label: 'AI spend', get: (r) => fmtUsd(r.costUsd), cls: 'num' },
        { label: `of ${fmtUsd(o.aiSpend.siteCapUsd, 2)} per site`, get: (r) => meter(r.costUsd, o.aiSpend.siteCapUsd) },
      ], o.aiSpend.bySite, 'No AI spend today.')),
    ],
  };
}

// ---- Crawl requests (from the extension) --------------------------------------

// Approve / Reject for a site first crawled on a user's request: approve adds
// it to cross-site search; reject marks it not_devtool and purges its index.
function approvalButtons(site) {
  const approve = h('button', { class: 'btn sm', type: 'button' }, 'Approve');
  const reject = h('button', { class: 'btn ghost sm danger', type: 'button' }, 'Reject');
  approve.onclick = () => act(approve, () => api(`sites/${enc(site)}/approve`, { method: 'POST' }), `${site} approved for search`);
  reject.onclick = () => {
    if (!confirm(`Reject ${site}? It is marked not a devtool site and its index is deleted.`)) return;
    act(reject, () => api(`sites/${enc(site)}/reject`, { method: 'POST' }), (r) => `${site} rejected; ${r.purged.pages} pages removed`);
  };
  return h('span', { class: 'row' }, approve, reject);
}

async function crawlRequests(r) {
  const site = r.params.get('site') ?? '';
  const qs = new URLSearchParams();
  if (site) qs.set('site', site);
  if (r.params.get('cursor')) qs.set('cursor', r.params.get('cursor'));
  const d = await api(`crawl-requests?${qs}`);
  const active = d.requests.some((x) => ACTIVE.has(x.state));
  const siteIn = h('input', { id: 'requests-site', type: 'search', placeholder: 'site', value: site });
  const filter = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      location.hash = `#/requests${siteIn.value.trim() ? `?site=${enc(siteIn.value.trim())}` : ''}`;
    },
  }, h('label', { class: 'field' }, 'Site', siteIn), h('button', { class: 'btn ghost', type: 'submit' }, 'Filter'));
  return {
    live: active,
    nodes: [
      h('div', { class: 'head' }, h('h1', {}, 'Crawl requests'), active ? h('span', { class: 'live' }, `refreshing every ${REFRESH_MS / 1000}s`) : null),
      h('p', { class: 'meta small' },
        `Asked for by the extension on sites the library hadn't crawled. At most ${d.capPerDay} may start a crawl per UTC day (CRAWL_REQUESTS_DAILY_MAX); 5 per install and 15 per IP.`),
      card('Requests', filter, table([
        { label: 'Request', get: (x) => h('span', { class: 'mono', title: x.id }, shortId(x.id)) },
        { label: 'Site', get: (x) => siteLink(x.site) },
        { label: 'Page', get: (x) => h('span', { class: 'mono small', title: x.url }, x.url.length > 60 ? `${x.url.slice(0, 59)}…` : x.url), cls: 'hide-sm' },
        { label: 'Outcome', get: (x) => x.outcome },
        { label: 'State', get: (x) => [pill(x.state), x.state === 'running' || x.state === 'indexing' ? h('span', { class: 'meta small' }, ` ${x.phase}`) : null] },
        { label: 'Pages', get: (x) => `${fmtInt(x.pagesIndexed)}/${fmtInt(x.pagesFound)} indexed`, cls: 'nowrap' },
        { label: 'Install', get: (x) => h('span', { class: 'mono', title: 'first 8 hex characters of the install ID HMAC' }, x.install) },
        { label: 'Run', get: (x) => (x.runId ? runLink(x.runId) : '') },
        { label: 'Cost', get: (x) => (x.costs ? costCell(x.costs) : ''), cls: 'num' },
        { label: 'Asked', get: (x) => time(x.createdAt), cls: 'nowrap' },
        { label: 'Reason', get: (x) => (x.error || x.reason ? h('span', { class: x.state === 'rejected' ? 'warn small' : 'err small', title: x.error ?? '' }, x.error ?? x.reason) : ''), cls: 'hide-sm' },
        { label: 'Search', get: (x) => (x.siteApproved === false && x.state !== 'rejected' ? approvalButtons(x.site) : x.siteApproved ? 'approved' : ''), cls: 'nowrap' },
      ], d.requests, 'No crawl requests yet.'), pager(d.next, r.params, '#/requests')),
    ],
  };
}

// ---- Crawls ------------------------------------------------------------------

async function crawls(r) {
  const status = r.params.get('status') ?? '';
  const site = r.params.get('site') ?? '';
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (site) qs.set('site', site);
  if (r.params.get('cursor')) qs.set('cursor', r.params.get('cursor'));
  const [runs, batches] = await Promise.all([api(`runs?${qs}`), api('batches')]);
  const active = runs.runs.some((x) => ACTIVE.has(x.status)) || batches.batches.some((b) => b.status === 'running');

  const statusSel = h('select', { id: 'runs-status' }, ['', 'active', 'queued', 'running', 'complete', 'rejected', 'failed'].map((s) => h('option', { value: s, selected: s === status }, s || 'any status')));
  const siteIn = h('input', { id: 'runs-site', type: 'search', placeholder: 'site', value: site });
  const filter = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      const p = new URLSearchParams();
      if (statusSel.value) p.set('status', statusSel.value);
      if (siteIn.value.trim()) p.set('site', siteIn.value.trim());
      location.hash = `#/crawls${p.toString() ? `?${p}` : ''}`;
    },
  }, h('label', { class: 'field' }, 'Status', statusSel), h('label', { class: 'field' }, 'Site', siteIn), h('button', { class: 'btn ghost', type: 'submit' }, 'Filter'));

  return {
    live: active,
    nodes: [
      h('div', { class: 'head' }, h('h1', {}, 'Crawls'), active ? h('span', { class: 'live' }, `refreshing every ${REFRESH_MS / 1000}s`) : null),
      card('Start a crawl', crawlForm(), h('p', { class: 'meta small' }, 'One crawl per site at a time; the devtool gate runs first unless skipped.')),
      card(h('span', {}, 'Batches ', h('a', { href: '#/seeds', class: 'small' }, 'start one from Seeds')), table([
        { label: 'Batch', get: (b) => h('a', { href: `#/batches/${b.id}`, class: 'mono', title: b.id }, shortId(b.id)) },
        { label: 'Status', get: (b) => pill(b.status) },
        { label: 'Progress', get: (b) => `${b.done}/${b.jobs} done · ${b.active} running`, cls: 'nowrap' },
        { label: 'Concurrency', get: (b) => b.concurrency, cls: 'num' },
        { label: 'Max pages', get: (b) => b.max_pages ?? 'per seed', cls: 'num' },
        { label: 'Started', get: (b) => time(b.created_at), cls: 'nowrap' },
      ], batches.batches, 'No batches yet.')),
      card('Runs', filter, runsTable(runs.runs), pager(runs.next, r.params, '#/crawls')),
    ],
  };
}

async function runDetail(r) {
  const id = r.parts[1];
  const d = await api(`runs/${id}`);
  const run = d.run;
  const active = ACTIVE.has(run.status);
  const cancel = h('button', {
    class: 'btn danger', type: 'button',
    onclick: (e) => confirm(`Cancel ${run.id}? Its Workflow is terminated and its sandboxes killed.`) &&
      act(e.currentTarget, () => api(`runs/${run.id}/cancel`, { method: 'POST' }), (x) => `Cancelled (${x.terminated ? 'workflow terminated' : 'no live workflow'}, ${x.sandboxes} sandboxes killed)`),
  }, 'Cancel run');
  return {
    live: active,
    nodes: [
      h('p', { class: 'crumbs' }, h('a', { href: '#/crawls' }, 'Crawls'), ' / run'),
      h('div', { class: 'head' }, h('h1', { class: 'mono' }, run.id), pill(run.status), active ? h('span', { class: 'live' }, 'live') : null, h('span', { class: 'grow' }), active ? cancel : null),
      card(null, h('dl', { class: 'kv' },
        h('dt', {}, 'Site'), h('dd', {}, siteLink(run.site)),
        h('dt', {}, 'Start URL'), h('dd', {}, ext(run.startUrl)),
        h('dt', {}, 'Path'), h('dd', {}, run.path ?? '—'),
        h('dt', {}, 'Gate'), h('dd', {}, run.forced ? 'skipped (forced by an admin)' : run.gate ? `${gateText(run.gate)} — ${run.gate.reason ?? ''}` : '—'),
        h('dt', {}, 'Pages'), h('dd', {}, `${pagesCell(run)} · ${fmtInt(run.pagesSkipped)} skipped`),
        h('dt', {}, 'Browser'), h('dd', {}, `${fmtInt(Math.round(run.browserSeconds))} s`),
        h('dt', {}, 'Started'), h('dd', {}, run.startedAt ?? ''),
        h('dt', {}, 'Finished'), h('dd', {}, run.finishedAt ?? (active ? `running for ${duration(run.startedAt)}` : '—')),
        h('dt', {}, 'Workflow'), h('dd', {}, d.workflow ? `${d.workflow.status}${d.workflow.error ? ` — ${d.workflow.error}` : ''}` : 'expired or unknown'),
        run.error ? [h('dt', {}, 'Error'), h('dd', { class: run.status === 'rejected' ? 'warn' : 'err' }, run.error)] : null)),
      card('Cost', costBreakdown(run.costs)),
      card(`Pages fetched by this run (first ${d.pages.length})`, table([
        { label: 'URL', get: (p) => pageLink(p.url), cls: 'url' },
        { label: 'Kind', get: (p) => p.kind },
        { label: 'Size', get: (p) => fmtBytes(p.bytes), cls: 'num' },
        { label: 'Changed', get: (p) => time(p.changedAt), cls: 'nowrap' },
      ], d.pages, 'No pages recorded by this run.')),
    ],
  };
}

function costBreakdown(c) {
  return [
    h('div', { class: 'stats' },
      stat(fmtUsd(c.totalUsd, 5), c.indexingDone ? 'total' : 'total so far'),
      stat(c.perPageUsd == null ? '—' : fmtUsd(c.perPageUsd, 6), `per page (${fmtInt(c.pagesStored)} stored)`),
      stat(fmtUsd(c.browserUsd), 'browser sandbox (E2B)'),
      stat(fmtUsd(c.gateUsd), 'devtool gate (AI)'),
      stat(fmtUsd(c.classifyUsd), 'page classification (AI)'),
      stat(fmtUsd(c.embedUsd, 6), 'embeddings (Workers AI, est.)')),
    h('p', { class: c.indexingDone ? 'meta small' : 'warn small' },
      !c.tracked
        ? 'This run is from before cost tracking: its classification and embedding costs were not recorded.'
        : c.indexingDone
        ? `Final: all ${fmtInt(c.pagesStored)} stored pages are indexed.`
        : `Indexing pending: ${fmtInt(c.pagesIndexed)} of ${fmtInt(c.pagesStored)} pages indexed; classification and embedding costs are still coming in.`),
  ];
}

async function batchDetail(r) {
  const id = r.parts[1];
  const { batch, jobs } = await api(`batches/${id}`);
  const running = batch.status === 'running';
  const live = running || jobs.some((j) => ACTIVE.has(j.run_status));
  const stop = (stopRuns) => h('button', {
    class: stopRuns ? 'btn danger' : 'btn ghost', type: 'button',
    onclick: (e) => confirm(stopRuns ? 'Cancel the batch and stop its running crawls?' : 'Stop starting new crawls? Running crawls finish.') &&
      act(e.currentTarget, () => api(`batches/${id}/cancel`, { method: 'POST', body: { stopRuns } }), (x) => `Batch cancelled; ${x.stopped} crawls stopped`),
  }, stopRuns ? 'Cancel and stop crawls' : 'Stop queuing');
  const count = (s) => jobs.filter((j) => j.status === s).length;
  return {
    live,
    nodes: [
      h('p', { class: 'crumbs' }, h('a', { href: '#/crawls' }, 'Crawls'), ' / batch'),
      h('div', { class: 'head' }, h('h1', { class: 'mono' }, batch.id), pill(batch.status), live ? h('span', { class: 'live' }, 'live') : null,
        h('span', { class: 'grow' }), running ? stop(false) : null, running ? stop(true) : null),
      card(null, h('div', { class: 'stats' },
        stat(`${jobs.length}`, 'jobs'),
        stat(`${count('waiting')}`, 'waiting'),
        stat(`${count('starting') + count('running')}`, `running (max ${batch.concurrency})`),
        stat(`${count('complete')}`, 'complete'),
        stat(`${count('rejected')}`, 'rejected'),
        stat(`${count('failed') + count('error')}`, 'failed or error'),
        stat(`${count('cancelled')}`, 'cancelled')),
      h('p', { class: 'meta small' }, `Max pages: ${batch.max_pages ?? 'per seed'} · gate ${batch.force ? 'skipped' : 'on'} · started ${batch.created_at}${batch.finished_at ? ` · ended ${batch.finished_at}` : ''}`)),
      card('Jobs', table([
        { label: '#', get: (j) => j.ord + 1, cls: 'num' },
        { label: 'Seed', get: (j) => j.name },
        { label: 'Site', get: (j) => siteLink(j.site) },
        { label: 'Job', get: (j) => pill(j.status) },
        { label: 'Run', get: (j) => (j.run_id ? h('span', { class: 'row' }, runLink(j.run_id), j.run_status ? pill(j.run_status) : null) : '') },
        { label: 'Path', get: (j) => j.run_path ?? '' },
        { label: 'Pages', get: (j) => (j.run_pages == null ? '' : fmtInt(j.run_pages)), cls: 'num' },
        { label: 'Tries', get: (j) => j.attempts, cls: 'num' },
        { label: 'Note', get: (j) => (j.error || j.run_error ? h('span', { class: 'small muted' }, j.error ?? j.run_error) : ''), cls: 'hide-sm' },
      ], jobs)),
    ],
  };
}

// ---- Seeds -------------------------------------------------------------------

async function seeds() {
  const { seeds: list } = await api('seeds');
  const boxes = list.map((s, i) => h('input', { type: 'checkbox', id: `seed-${i}`, 'data-url': s.startUrl, 'aria-label': `Select ${s.name}` }));
  const all = h('input', { type: 'checkbox', id: 'seed-all', 'aria-label': 'Select all', onchange: (e) => boxes.forEach((b) => (b.checked = e.target.checked)) });
  const conc = h('input', { id: 'batch-conc', type: 'number', class: 'num', min: 1, max: 8, value: 4 });
  const max = h('input', { id: 'batch-max', type: 'number', class: 'num', min: 1, max: 1000, placeholder: 'per seed' });
  const force = h('input', { id: 'batch-force', type: 'checkbox' });
  const start = (everything) => async (e) => {
    const picked = boxes.filter((b) => b.checked).map((b) => b.dataset.url);
    if (!everything && !picked.length) return toast('Select some seeds first', true);
    const n = everything ? list.length : picked.length;
    if (!confirm(`Start a batch of ${n} crawls, ${conc.value} at a time?`)) return;
    const body = { concurrency: Number(conc.value), force: force.checked, ...(max.value ? { maxPages: Number(max.value) } : {}), ...(everything ? {} : { startUrls: picked }) };
    const res = await act(e.currentTarget, () => api('batches', { method: 'POST', body }), (x) => `Batch ${x.batchId}: ${x.jobs} jobs`);
    if (res) location.hash = `#/batches/${res.batchId}`;
  };
  return [
    h('div', { class: 'head' }, h('h1', {}, 'Seeds'), h('span', { class: 'meta' }, `${list.length} sites from seeds/devtools.json`)),
    card('Start a batch',
      h('div', { class: 'form' },
        h('label', { class: 'field' }, 'Concurrency (1–8)', conc),
        h('label', { class: 'field' }, 'Max pages', max),
        h('label', { class: 'check' }, force, 'Skip the devtool gate'),
        h('button', { class: 'btn', type: 'button', onclick: start(false) }, 'Crawl selected'),
        h('button', { class: 'btn ghost', type: 'button', onclick: start(true) }, 'Crawl all')),
      h('p', { class: 'meta small' }, 'The batch runs on the server (CrawlBatch Workflow): you can close this page. A busy site (409) is retried a minute later.')),
    card(null, table([
      { label: h('label', { class: 'check' }, all, 'All'), get: (s) => boxes[list.indexOf(s)] },
      { label: 'Seed', get: (s) => s.name },
      { label: 'Site', get: (s) => siteLink(s.site) },
      { label: 'Start URL', get: (s) => ext(s.startUrl), cls: 'url hide-sm' },
      { label: 'Max', get: (s) => s.maxPages, cls: 'num' },
      { label: 'Status', get: (s) => h('span', { class: 'row' }, s.status ? pill(s.status) : h('span', { class: 'meta' }, 'never crawled'), s.crawling ? pill('crawling') : null) },
      { label: 'Pages', get: (s) => fmtInt(s.pagesFetched), cls: 'num' },
      { label: 'Last crawl', get: (s) => time(s.lastCrawledAt), cls: 'nowrap' },
    ], list)),
  ];
}

// ---- Sites -------------------------------------------------------------------

async function sites(r) {
  const status = r.params.get('status') ?? '';
  const q = r.params.get('q') ?? '';
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (q) qs.set('q', q);
  if (r.params.get('cursor')) qs.set('cursor', r.params.get('cursor'));
  const d = await api(`sites?${qs}`);
  const statusSel = h('select', { id: 'sites-status' }, ['', 'ready', 'crawling', 'pending', 'not_devtool', 'failed', 'empty', 'blocked', 'new'].map((s) => h('option', { value: s, selected: s === status }, s || 'any status')));
  const qIn = h('input', { id: 'sites-q', type: 'search', placeholder: 'filter by name', value: q });
  return {
    live: d.sites.some((s) => s.crawling),
    nodes: [
      h('div', { class: 'head' }, h('h1', {}, 'Sites')),
      card(null,
        h('form', {
          onsubmit: (e) => {
            e.preventDefault();
            const p = new URLSearchParams();
            if (statusSel.value) p.set('status', statusSel.value);
            if (qIn.value.trim()) p.set('q', qIn.value.trim());
            location.hash = `#/sites${p.toString() ? `?${p}` : ''}`;
          },
        }, h('label', { class: 'field' }, 'Status', statusSel), h('label', { class: 'field' }, 'Site', qIn), h('button', { class: 'btn ghost', type: 'submit' }, 'Filter')),
        table([
          { label: 'Site', get: (s) => siteLink(s.site) },
          { label: 'Status', get: (s) => h('span', { class: 'row' }, pill(s.status), s.crawling ? pill('crawling') : null) },
          { label: 'Gate', get: (s) => (s.gate ? `${s.gate.category ?? ''} (${s.gate.method})` : ''), cls: 'hide-sm' },
          { label: 'Pages', get: (s) => fmtInt(s.pages), cls: 'num' },
          { label: 'Indexed', get: (s) => fmtInt(s.indexed), cls: 'num' },
          { label: 'llms.txt', get: (s) => (s.hasLlms ? 'yes' : ''), cls: 'hide-sm' },
          { label: 'Broken links', get: (s) => (s.brokenLinks ? h('a', { href: `#/sites/${enc(s.site)}`, class: 'warn' }, fmtInt(s.brokenLinks)) : ''), cls: 'num' },
          { label: 'Last crawl', get: (s) => (s.lastRun ? h('span', { class: 'row' }, time(s.lastRun.startedAt), pill(s.lastRun.status)) : ''), cls: 'nowrap' },
          { label: 'Search', get: (s) => (!s.approved && s.status !== 'not_devtool' ? approvalButtons(s.site) : ''), cls: 'nowrap' },
        ], d.sites, 'No sites match.'),
        pager(d.next, r.params, '#/sites')),
    ],
  };
}

function topicTreeView(nodes, site) {
  if (!nodes.length) return h('p', { class: 'empty' }, 'No topics yet (pages are unclassified or not indexed).');
  const list = (ns) => h('ul', {}, ns.map((n) => h('li', {},
    h('a', { href: `#/sites/${enc(site)}?topic=${enc(n.path)}` }, n.name), h('span', { class: 'count' }, String(n.count)),
    n.children.length ? list(n.children) : null)));
  return h('div', { class: 'tree' }, list(nodes));
}

async function siteDetail(r) {
  const site = r.parts[1];
  const topic = r.params.get('topic') ?? '';
  const qs = new URLSearchParams();
  if (topic) qs.set('topic', topic);
  if (r.params.get('cursor')) qs.set('cursor', r.params.get('cursor'));
  const [d, pages, broken] = await Promise.all([api(`sites/${enc(site)}`), api(`sites/${enc(site)}/pages?${qs}`), api(`sites/${enc(site)}/broken-links`)]);
  const p = d.profile;
  const active = p?.crawling || d.runs.some((x) => ACTIVE.has(x.status));
  const startUrl = d.runs[0]?.startUrl ?? `https://${site}/`;
  return {
    live: active,
    nodes: [
      h('p', { class: 'crumbs' }, h('a', { href: '#/sites' }, 'Sites'), ' / site'),
      h('div', { class: 'head' }, h('h1', { class: 'mono' }, site), p ? pill(p.status) : null, p?.crawling ? pill('crawling') : null,
        p && !p.approved && p.status !== 'not_devtool' ? h('span', { class: 'row' }, h('span', { class: 'pill' }, 'pending approval'), approvalButtons(site)) : null,
        h('span', { class: 'grow' }),
        h('a', { class: 'btn ghost sm', href: `#/agent?site=${enc(site)}` }, 'Agent view'),
        h('a', { class: 'btn ghost sm', href: `#/library/${enc(site)}` }, 'Shared skills')),
      card('Re-crawl', crawlForm({ url: startUrl, maxPages: p?.pagesFetched ? Math.min(1000, Math.max(50, p.pagesFetched)) : 200, label: 'Re-crawl' })),
      h('div', { class: 'cols' },
        card('Profile', p ? h('dl', { class: 'kv' },
          h('dt', {}, 'Docs root'), h('dd', { class: 'mono' }, p.docsRoot ?? '—'),
          h('dt', {}, 'llms.txt'), h('dd', {}, p.llmsUrl ? ext(p.llmsUrl) : 'no'),
          h('dt', {}, 'llms-full.txt'), h('dd', {}, p.llmsFullUrl ? ext(p.llmsFullUrl) : 'no'),
          h('dt', {}, '.md twins'), h('dd', {}, p.mdTwinsRatio == null ? '—' : `${Math.round(p.mdTwinsRatio * 100)}% (${p.twinPattern ?? ''})`),
          h('dt', {}, 'Sitemap URLs'), h('dd', {}, fmtInt(p.sitemapUrlsCount)),
          h('dt', {}, 'Needs browser'), h('dd', {}, p.needsBrowser ? 'yes' : 'no'),
          h('dt', {}, 'Crawl delay'), h('dd', {}, p.crawlDelay == null ? '—' : `${p.crawlDelay}s`),
          h('dt', {}, 'OpenAPI'), h('dd', {}, p.openapi?.length ? p.openapi.map((u) => h('div', {}, ext(u))) : '—'),
          h('dt', {}, 'Gate'), h('dd', {}, p.gate ? `${p.gate.category ?? ''} (${p.gate.method}${p.gate.confidence != null ? `, ${p.gate.confidence}` : ''}) — ${p.gate.reason ?? ''}` : '—'),
          h('dt', {}, 'Last crawled'), h('dd', {}, p.lastCrawledAt ?? '—'),
        ) : h('p', { class: 'empty' }, 'No profile (indexed by hand only).')),
        card('Counts', h('div', { class: 'stats' },
          stat(fmtInt(d.counts.pages), 'pages'),
          stat(fmtInt(d.counts.indexed), 'indexed'),
          stat(fmtInt(d.counts.indexPending), 'waiting to queue'),
          stat(fmtInt(d.counts.chunks), 'chunks'),
          stat(fmtInt(d.counts.skills), 'shared skills'),
          stat(fmtInt(d.counts.brokenLinks), 'broken links'),
          stat(fmtUsd(d.counts.classifyUsd), 'classification spend'))),
        card('Topics', topicTreeView(d.topics, site))),
      card(h('span', {}, topic ? ['Pages under ', h('code', {}, topic), ' ', h('a', { href: `#/sites/${enc(site)}`, class: 'small' }, 'all pages')] : 'Pages'),
        table([
          { label: 'Page', get: (x) => h('div', {}, pageLink(x.url, x.title || x.url), x.title ? h('div', { class: 'meta small mono' }, x.url) : null), cls: 'url' },
          { label: 'Slot', get: (x) => x.slot ?? '' },
          { label: 'Topic', get: (x) => (x.topic ? h('code', {}, x.topic) : ''), cls: 'hide-sm' },
          { label: 'Summary', get: (x) => h('span', { class: 'small' }, x.summary ?? ''), cls: 'hide-sm' },
          { label: 'Model', get: (x) => (x.indexed ? h('span', { class: x.current ? '' : 'warn' }, `${x.model}${x.current ? '' : ' (stale)'}`) : h('span', { class: 'meta' }, x.indexPending ? 'queued' : 'not indexed')) },
          { label: 'Cost', get: (x) => (x.costUsd ? fmtUsd(x.costUsd, 5) : ''), cls: 'num' },
          { label: 'Size', get: (x) => fmtBytes(x.bytes), cls: 'num' },
        ], pages.pages, 'No pages.'),
        pager(pages.next, r.params, `#/sites/${enc(site)}`)),
      card('Crawl history', runsTable(d.runs, { site: false })),
      h('div', { id: 'broken' }, card(`Broken links (${fmtInt(broken.links.length)})`, table([
        { label: 'Link', get: (x) => h('span', { class: 'mono small' }, x.url), cls: 'url' },
        { label: 'Status', get: (x) => (x.status == null ? 'no answer' : String(x.status)), cls: 'num' },
        { label: 'Found on', get: (x) => pageLink(x.pageUrl, x.pageUrl), cls: 'url hide-sm' },
        { label: 'Checked', get: (x) => h('span', { class: 'row' }, time(x.checkedAt), x.badChecks > 1 ? pill('permanent') : pill('recheck')), cls: 'nowrap' },
      ], broken.links, 'No broken links.'))),
    ],
  };
}

// ---- Page --------------------------------------------------------------------

async function pageDetail(r) {
  const url = r.params.get('url') ?? '';
  const d = await api(`page?url=${enc(url)}`);
  const l = d.labels;
  const site = d.page?.site;
  return [
    h('p', { class: 'crumbs' }, h('a', { href: '#/sites' }, 'Sites'), site ? [' / ', h('a', { href: `#/sites/${enc(site)}` }, site)] : null, ' / page'),
    h('div', { class: 'head' }, h('h1', {}, l?.title || d.page?.title || 'Page')),
    h('p', {}, ext(d.url)),
    h('div', { class: 'cols' },
      card('Stored', d.page ? h('dl', { class: 'kv' },
        h('dt', {}, 'Source'), h('dd', {}, ext(d.page.source_url)),
        h('dt', {}, 'Kind'), h('dd', {}, d.page.source_kind),
        h('dt', {}, 'Hash'), h('dd', { class: 'mono' }, d.page.content_hash),
        h('dt', {}, 'Size'), h('dd', {}, fmtBytes(d.page.bytes)),
        h('dt', {}, 'Fetched'), h('dd', {}, d.page.fetched_at),
        h('dt', {}, 'Changed'), h('dd', {}, d.page.changed_at),
        h('dt', {}, 'Run'), h('dd', {}, runLink(d.page.run_id)),
        h('dt', {}, 'Index queue'), h('dd', {}, d.page.index_pending ? 'waiting to be sent' : 'sent'),
      ) : h('p', { class: 'empty' }, 'Indexed by hand (no crawl record).')),
      card('AI labels', l ? h('dl', { class: 'kv' },
        h('dt', {}, 'Slot'), h('dd', {}, l.slot),
        h('dt', {}, 'Topic'), h('dd', {}, h('code', {}, l.topicPath.join(' / ') || '—')),
        h('dt', {}, 'Summary'), h('dd', {}, l.summary || '—'),
        h('dt', {}, 'Tasks'), h('dd', {}, l.tasks.length ? h('ul', { class: 'plain' }, l.tasks.map((t) => h('li', {}, t))) : '—'),
        h('dt', {}, 'Entities'), h('dd', {}, l.entities.length ? l.entities.map((e) => h('div', {}, h('span', { class: 'meta' }, `${e.kind} `), h('code', {}, e.name))) : '—'),
        h('dt', {}, 'Model'), h('dd', {}, `${l.model}${l.attempts ? ` (${l.attempts} failed attempts)` : ''}`),
        h('dt', {}, 'Cost'), h('dd', {}, fmtUsd(l.costUsd, 5)),
        h('dt', {}, 'Indexed'), h('dd', {}, `${l.indexedAt}${l.current ? '' : ' — older content than stored'}`),
      ) : h('p', { class: 'empty' }, 'Not indexed yet.'))),
    card(h('span', {}, 'Stored Markdown ', h('code', { class: 'small meta' }, d.markdownKey)),
      d.markdown === null ? h('p', { class: 'err' }, 'The R2 object is missing.') : markdownBlock(d.markdown),
      d.truncated ? h('p', { class: 'warn small' }, 'Shown truncated.') : null),
    card(`Chunks (${d.chunks.length})`, d.chunks.length
      ? d.chunks.map((c) => h('div', { class: 'chunk' }, h('div', { class: 'meta small' }, `#${c.ord} · ${c.heading_path} · `, h('code', {}, c.id)), (() => { const p = h('pre', { class: 'md short' }); p.textContent = c.text; return p; })()))
      : h('p', { class: 'empty' }, 'No chunks.')),
  ];
}

// ---- Agent view --------------------------------------------------------------

async function agent(r) {
  const site = r.params.get('site') ?? '';
  const q = r.params.get('q') ?? '';
  const topic = r.params.get('topic') ?? '';
  const budget = r.params.get('budget') ?? '';
  const siteIn = h('input', { id: 'ag-site', type: 'text', placeholder: 'docs.example.com', value: site, required: true });
  const qIn = h('input', { id: 'ag-q', type: 'search', class: 'wide', placeholder: 'verify webhook signature', value: q });
  const topicIn = h('input', { id: 'ag-topic', type: 'text', placeholder: 'or a topic, e.g. webhooks/signatures', value: topic });
  const budgetIn = h('input', { id: 'ag-budget', type: 'number', class: 'num', min: 2000, max: 400000, step: 1000, placeholder: '60000', value: budget });
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      const p = new URLSearchParams({ site: siteIn.value.trim() });
      if (qIn.value.trim()) p.set('q', qIn.value.trim());
      if (topicIn.value.trim()) p.set('topic', topicIn.value.trim());
      if (budgetIn.value) p.set('budget', budgetIn.value);
      location.hash = `#/agent?${p}`;
    },
  },
  h('label', { class: 'field' }, 'Site', siteIn),
  h('label', { class: 'field' }, 'Search query', qIn),
  h('label', { class: 'field' }, 'Topic', topicIn),
  h('label', { class: 'field' }, 'Budget (chars)', budgetIn),
  h('button', { class: 'btn', type: 'submit' }, 'Preview'));

  const out = [
    h('div', { class: 'head' }, h('h1', {}, 'What the agent gets')),
    card(null, form, h('p', { class: 'meta small' }, 'Search is GET /v1/search; the package is GET /v1/packages (by query, or by topic when one is given). The shared skill the extension copies is in the Shared library.')),
  ];
  if (!site || (!q && !topic)) return out;

  const pq = new URLSearchParams({ site });
  if (topic) pq.set('topic', topic); else pq.set('q', q);
  if (budget) pq.set('budget', budget);
  const [hits, pkg] = await Promise.allSettled([
    q ? api(`search?${new URLSearchParams({ site, q, limit: '10' })}`) : Promise.resolve(null),
    api(`package?${pq}`),
  ]);
  if (hits.status === 'fulfilled' && hits.value) {
    out.push(card(`Search hits (${hits.value.hits.length})`, hits.value.hits.length
      ? hits.value.hits.map((x, i) => h('div', { class: 'chunk' },
        h('div', { class: 'row' }, h('b', {}, `${i + 1}.`), pageLink(x.url, x.title || x.url), h('span', { class: 'pill' }, x.slot), h('span', { class: 'meta small' }, `score ${x.score.toFixed(4)}`)),
        h('div', { class: 'meta small' }, x.heading_path, x.topic_path?.length ? [' · ', h('code', {}, x.topic_path.join('/'))] : null),
        h('p', { class: 'small' }, x.snippet)))
      : h('p', { class: 'empty' }, 'No hits.')));
  } else if (hits.status === 'rejected') {
    out.push(card('Search hits', h('p', { class: 'err' }, hits.reason.message)));
  }
  out.push(pkg.status === 'fulfilled'
    ? card(h('span', {}, 'Package ', h('span', { class: 'meta small' }, `${pkg.value.chunks} chunks considered · budget ${fmtInt(pkg.value.budget)}`)), markdownBlock(pkg.value.markdown, { label: 'Copy package' }))
    : card('Package', h('p', { class: pkg.reason.status === 404 ? 'meta' : 'err' }, pkg.reason.message)));
  return out;
}

// ---- Shared library ----------------------------------------------------------

const votes = (s) => h('span', { class: 'nowrap' }, h('span', { class: 'ok' }, `▲ ${s.worked}`), ' ', h('span', { class: 'err' }, `▼ ${s.failed}`));

async function library(r) {
  const d = await api(`library${r.params.get('cursor') ? `?cursor=${enc(r.params.get('cursor'))}` : ''}`);
  return [
    h('div', { class: 'head' }, h('h1', {}, 'Shared library')),
    card(`Open reports (${d.reports.length})`, table([
      { label: 'Reported', get: (x) => time(x.createdAt), cls: 'nowrap' },
      { label: 'Skill', get: (x) => h('a', { href: `#/skills/${enc(x.skillId)}`, class: 'mono' }, x.skillId) },
      { label: 'Site', get: (x) => (x.site ? siteLink(x.site) : '') },
      { label: 'Reason', get: (x) => h('span', { class: 'pill' }, x.reason) },
      { label: 'Details', get: (x) => h('span', { class: 'small' }, x.details ?? '') },
      { label: 'Skill state', get: (x) => (x.skillRemoved ? pill('removed') : 'live') },
    ], d.reports, 'No open reports.')),
    card('Sites with shared skills', table([
      { label: 'Site', get: (x) => h('a', { href: `#/library/${enc(x.site)}`, class: 'mono' }, x.site) },
      { label: 'Live / total', get: (x) => `${x.live} / ${x.total}`, cls: 'num' },
      { label: 'Votes', get: votes },
      { label: 'Best', get: (x) => (x.best ? h('a', { href: `#/skills/${enc(x.best.id)}` }, x.best.title || x.best.id) : h('span', { class: 'meta' }, 'none qualifies')) },
      { label: 'Last shared', get: (x) => time(x.lastSharedAt), cls: 'nowrap' },
    ], d.sites, 'No skills shared yet.'), pager(d.next, r.params, '#/library')),
  ];
}

function skillRows(list) {
  return table([
    { label: 'Skill', get: (s) => h('a', { href: `#/skills/${enc(s.id)}` }, s.title || s.id) },
    { label: 'Page', get: (s) => ext(s.pageUrl), cls: 'url hide-sm' },
    { label: 'Votes', get: votes },
    { label: 'Sources', get: (s) => s.sources.map((x) => h('div', { class: 'small' }, h('span', { class: 'meta' }, `${x.kind} `), ext(x.url, x.label))), cls: 'hide-sm' },
    { label: 'Size', get: (s) => fmtBytes(s.sizeBytes), cls: 'num' },
    { label: 'Shared', get: (s) => time(s.createdAt), cls: 'nowrap' },
  ], list);
}

async function librarySite(r) {
  const site = r.parts[1];
  const d = await api(`library/${enc(site)}`);
  return [
    h('p', { class: 'crumbs' }, h('a', { href: '#/library' }, 'Shared library'), ' / site'),
    h('div', { class: 'head' }, h('h1', { class: 'mono' }, site), h('span', { class: 'grow' }), h('a', { class: 'btn ghost sm', href: `#/sites/${enc(site)}` }, 'Crawl data')),
    card('Best skill (what the extension gets first)', d.best ? skillRows([d.best]) : h('p', { class: 'empty' }, 'No skill qualifies yet.')),
    card(`Recent skills (${d.recent.length})`, skillRows(d.recent)),
    d.removed.length ? card(`Taken down (${d.removed.length})`, table([
      { label: 'Skill', get: (s) => h('a', { href: `#/skills/${enc(s.id)}`, class: 'mono' }, s.id) },
      { label: 'Title', get: (s) => s.title },
      { label: 'Removed', get: (s) => time(s.removed_at), cls: 'nowrap' },
    ], d.removed)) : null,
  ];
}

async function skillDetail(r) {
  const id = r.parts[1];
  const d = await api(`skills/${enc(id)}`);
  const s = d.skill;
  const takedown = h('button', {
    class: 'btn danger', type: 'button',
    onclick: (e) => confirm(`Take down ${s.id}? Its content is deleted; the record stays for audit.`) &&
      act(e.currentTarget, () => api(`skills/${enc(s.id)}`, { method: 'DELETE' }), 'Skill taken down'),
  }, 'Take down');
  return [
    h('p', { class: 'crumbs' }, h('a', { href: '#/library' }, 'Shared library'), ' / ', h('a', { href: `#/library/${enc(s.site)}` }, s.site), ' / skill'),
    h('div', { class: 'head' }, h('h1', {}, s.title || s.id), s.removedAt ? pill('removed') : null, h('span', { class: 'grow' }), s.removedAt ? null : takedown),
    card(null, h('dl', { class: 'kv' },
      h('dt', {}, 'ID'), h('dd', { class: 'mono' }, s.id),
      h('dt', {}, 'Page'), h('dd', {}, ext(s.pageUrl)),
      h('dt', {}, 'Votes'), h('dd', {}, votes(s), s.lastWorkedAt ? h('span', { class: 'meta' }, ` · last worked ${fmtTime(s.lastWorkedAt)}`) : null),
      h('dt', {}, 'Shared'), h('dd', {}, s.createdAt),
      s.removedAt ? [h('dt', {}, 'Removed'), h('dd', { class: 'err' }, s.removedAt)] : null,
      h('dt', {}, 'Sources'), h('dd', {}, s.sources.map((x) => h('div', {}, h('span', { class: 'meta' }, `${x.kind} · ${x.label} `), ext(x.url)))))),
    card(h('span', {}, 'Package the extension copies ', h('span', { class: 'meta small' }, '(on the skill\'s own page; built by shared/package.js)')),
      d.package === null ? h('p', { class: 'empty' }, 'Content removed.') : markdownBlock(d.package, { label: 'Copy package' })),
    s.relatedLinks?.length ? card(`Related links (${s.relatedLinks.length})`, h('ul', { class: 'plain' }, s.relatedLinks.map((l) => h('li', {}, ext(l.url, l.text || l.url))))) : null,
    card(`Reports (${d.reports.length})`, table([
      { label: 'Reported', get: (x) => time(x.createdAt), cls: 'nowrap' },
      { label: 'Reason', get: (x) => h('span', { class: 'pill' }, x.reason) },
      { label: 'Details', get: (x) => x.details ?? '' },
      { label: 'Resolved', get: (x) => x.resolvedAt ?? '' },
    ], d.reports, 'No reports.')),
  ].filter(Boolean);
}

// ---- Costs -------------------------------------------------------------------

async function costs() {
  const d = await api('costs?days=14');
  const total = (k) => d.days.reduce((n, x) => n + x[k], 0);
  return [
    h('div', { class: 'head' }, h('h1', {}, 'Costs'), h('span', { class: 'meta' }, 'last 14 UTC days')),
    card(null, h('div', { class: 'stats' },
      stat(fmtUsd(total('aiUsd'), 2), 'AI (classifier + gate)'),
      stat(fmtUsd(total('gateUsd'), 2), 'of which gate'),
      stat(fmtUsd(total('e2bUsd'), 2), 'E2B sandboxes'),
      stat(fmtInt(total('runs')), 'crawl runs')),
    h('p', { class: 'meta small' }, `Caps per UTC day: ${fmtUsd(d.siteCapUsd, 2)} per site, ${fmtUsd(d.totalCapUsd, 2)} in total (AI only).`)),
    card('By day', table([
      { label: 'Day', get: (x) => x.day, cls: 'nowrap mono' },
      { label: 'AI', get: (x) => fmtUsd(x.aiUsd), cls: 'num' },
      { label: 'Cap', get: (x) => meter(x.aiUsd, d.totalCapUsd) },
      { label: 'Gate', get: (x) => fmtUsd(x.gateUsd), cls: 'num' },
      { label: 'E2B', get: (x) => `${fmtUsd(x.e2bUsd)} · ${fmtInt(Math.round(x.browserSeconds))}s`, cls: 'num' },
      { label: 'Runs', get: (x) => x.runs, cls: 'num' },
      { label: 'Top sites (AI)', get: (x) => x.sites.slice(0, 4).map((s) => h('div', { class: 'small' }, siteLink(s.site), ` ${fmtUsd(s.costUsd)}`)), cls: 'hide-sm' },
    ], d.days)),
    ...crawlCostCards(d.crawls),
  ];
}

// Cost per crawl: averages (over runs whose indexing has caught up), each
// finished run with its total and per-page cost as bars, and the daily
// reclassify job's spend, which belongs to no run.
function crawlCostCards(c) {
  const usd = (n, d = 6) => (n == null ? '—' : fmtUsd(n, d));
  const o = c.averages.overall;
  const maxPage = Math.max(0, ...c.runs.filter((r) => r.costs_tracked).map((r) => r.cost_per_page ?? 0));
  const maxTotal = Math.max(0, ...c.runs.map((r) => r.total_cost_usd));
  const bar = (v, max) => {
    const m = h('div', { class: 'meter' }, h('i'));
    m.firstChild.style.width = `${max > 0 ? Math.min(100, (v / max) * 100) : 0}%`;
    return m;
  };
  return [
    card('Cost per crawl', h('div', { class: 'stats' },
      stat(usd(o.perCrawlUsd, 5), 'average per crawl'),
      stat(usd(o.perPageUsd), 'average per page'),
      stat(fmtInt(o.finalRuns), 'finished runs counted'),
      stat(fmtInt(o.pendingRuns), 'runs still indexing (left out)')),
    table([
      { label: 'Path', get: (g) => g.path },
      { label: 'Runs', get: (g) => `${g.finalRuns}${g.pendingRuns ? ` (+${g.pendingRuns} indexing)` : ''}`, cls: 'num' },
      { label: 'Per crawl', get: (g) => usd(g.perCrawlUsd, 5), cls: 'num' },
      { label: 'Per page', get: (g) => usd(g.perPageUsd), cls: 'num' },
      { label: 'Pages', get: (g) => fmtInt(g.pages), cls: 'num' },
      { label: 'Spend', get: (g) => fmtUsd(g.totalUsd), cls: 'num' },
    ], c.averages.byPath, 'No finished crawls in this window.'),
    h('p', { class: 'meta small' }, 'Per crawl: browser sandbox + devtool gate + classification + embeddings (Workers AI, estimated). Per page is total spend over pages stored (new + changed). A rejected run only pays for its gate check.')),
    card('Crawls over time', table([
      { label: 'Started', get: (r) => h('span', { title: r.started_at }, r.started_at.slice(0, 16).replace('T', ' ')), cls: 'nowrap mono' },
      { label: 'Run', get: (r) => runLink(r.id) },
      { label: 'Site', get: (r) => siteLink(r.site) },
      { label: 'Path', get: (r) => (r.path ? r.path : pill(r.status)) },
      { label: 'Pages', get: (r) => `${fmtInt(r.pages_indexed)}/${fmtInt(r.pages_stored)}`, cls: 'num' },
      { label: 'Total', get: (r) => h('span', { title: `browser ${fmtUsd(r.browser_cost_usd)} · gate ${fmtUsd(r.gate_cost_usd)} · classify ${fmtUsd(r.classify_cost_usd)} · embed ${fmtUsd(r.embed_cost_usd, 6)}` }, fmtUsd(r.total_cost_usd, 5), r.indexing_done ? null : h('span', { class: 'meta small' }, r.costs_tracked ? ' +indexing' : ' (untracked)')), cls: 'num' },
      { label: '', get: (r) => bar(r.total_cost_usd, maxTotal), cls: 'hide-sm' },
      { label: 'Per page', get: (r) => (r.costs_tracked ? usd(r.cost_per_page) : '—'), cls: 'num' },
      { label: '', get: (r) => (r.cost_per_page == null || !r.costs_tracked ? '' : bar(r.cost_per_page, maxPage)), cls: 'hide-sm' },
    ], c.runs, 'No finished crawls in this window.')),
    card('Daily reclassify job', table([
      { label: 'Day', get: (x) => x.day, cls: 'nowrap mono' },
      { label: 'Pages', get: (x) => fmtInt(x.pages), cls: 'num' },
      { label: 'Classification', get: (x) => fmtUsd(x.classifyUsd), cls: 'num' },
      { label: 'Embeddings', get: (x) => fmtUsd(x.embedUsd, 6), cls: 'num' },
    ], c.reclassify, 'No reclassify spend in this window.'),
    h('p', { class: 'meta small' }, 'Pages first indexed unclassified (cap reached, classifier down) are classified later by the cron; that spend is kept apart from the run that crawled them.')),
  ];
}

// ---- Telemetry ---------------------------------------------------------------
// Usage statistics (docs/TELEMETRY.md): #/telemetry/<tab>, with ?days= for the window.

const TELEMETRY_TABS = [
  ['live', 'Live'], ['', 'Overview'], ['sites', 'Sites'], ['users', 'Users'], ['retention', 'Retention'], ['platforms', 'Versions & platforms'],
  ['geo', 'Geography'], ['errors', 'Errors'], ['api', 'API usage'], ['website', 'Website'], ['export', 'Export'],
];
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');
const fmtMs = (n) => (n == null ? '—' : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);
const installLink = (id) => h('a', { href: `#/telemetry/users/${enc(id)}`, class: 'mono', title: id }, shortId(id));
const tSiteLink = (site) => (site ? h('a', { href: `#/telemetry/sites/${enc(site)}`, class: 'mono' }, site) : '');

function bar(v, max) {
  const m = h('div', { class: 'meter' }, h('i'));
  m.firstChild.style.width = `${max > 0 ? Math.min(100, (v / max) * 100) : 0}%`;
  return m;
}

// A count with a bar scaled to the column's largest value.
function barCol(label, key, rows, fmt = fmtInt) {
  const max = Math.max(0, ...rows.map((r) => Number(r[key] ?? 0)));
  return { label, get: (r) => h('div', { class: 'barcell' }, h('span', {}, fmt(r[key] ?? 0)), bar(Number(r[key] ?? 0), max)), cls: 'num' };
}

function tabs(active, days) {
  const q = days ? `?days=${days}` : '';
  return h('nav', { class: 'tabs', 'aria-label': 'Telemetry' },
    TELEMETRY_TABS.map(([key, label]) => h('a', { href: `#/telemetry${key ? `/${key}` : ''}${key === 'export' || key === 'users' ? '' : q}`, class: key === active ? 'on' : undefined }, label)));
}

function windowPicker(base, days) {
  return h('span', { class: 'row small' }, 'Window:', [7, 30, 90, 365].map((d) => (d === days ? h('b', {}, `${d}d`) : h('a', { href: `${base}?days=${d}` }, `${d}d`))));
}

// rawFrom: the first day raw events cover (they are pruned after 180 days).
function telemetryHead(title, tab, days, base, rawFrom) {
  return [
    h('div', { class: 'head' }, h('h1', {}, title), days ? windowPicker(base, days) : null),
    tabs(tab, days),
    days > 180 && rawFrom ? h('p', { class: 'meta small warn' }, `Raw events are kept 180 days: figures read from them start ${rawFrom}. Daily counts, installs and active days cover the whole window.`) : null,
  ].filter(Boolean);
}

// Versions in semver order (0.10.0 after 0.9.0); anything unparsable last.
function semverCmp(a, b) {
  const p = (v) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v ?? '') ?? []).slice(1).map(Number);
  const [x, y] = [p(a), p(b)];
  if (!x.length || !y.length) return x.length ? -1 : y.length ? 1 : String(a).localeCompare(String(b));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

const daysOf = (r) => Math.min(365, Math.max(1, Number(r.params.get('days')) || 30));

// Merges per-day series into one row per day, oldest first.
function byDay(series) {
  const days = new Map();
  for (const [key, rows] of Object.entries(series)) {
    for (const x of rows) days.set(x.day, { day: x.day, ...days.get(x.day), [key]: Number(x.n ?? x.views ?? 0) });
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

async function telemetry(r) {
  const tab = r.parts[1] ?? '';
  if (tab === 'sites' && r.parts[2]) return telemetrySite(r);
  if (tab === 'users' && r.parts[2]) return telemetryInstall(r);
  const view = { live: telemetryLive, '': telemetryOverview, sites: telemetrySites, users: telemetryUsers, retention: telemetryRetention, platforms: telemetryPlatforms, geo: telemetryGeo, errors: telemetryErrors, api: telemetryApi, website: telemetryWebsite, export: telemetryExport }[tab];
  if (!view) return [card('Not found', h('p', {}, 'No such telemetry page. '), h('a', { href: '#/telemetry' }, 'Back to telemetry'))];
  return view(r);
}

// The launch-day monitor: the last 24 hours against the 24 before, refreshed every 30 seconds while the tab is open.
let liveTimer;
async function telemetryLive() {
  clearInterval(liveTimer);
  const d = await api('telemetry/live');
  liveTimer = setInterval(() => {
    if (!location.hash.startsWith('#/telemetry/live')) return clearInterval(liveTimer);
    if (!document.hidden) location.hash = '#/telemetry/live?t=' + Date.now();
  }, 30000);
  const delta = (k) => {
    const a = d.now[k], b = d.before[k];
    return h('span', { class: 'small' }, b ? `${a >= b ? '▲' : '▼'} ${Math.abs(Math.round(((a - b) / b) * 100))}% vs previous 24h` : `${fmtInt(b)} in previous 24h`);
  };
  const tile = (k, label) => h('div', { class: 'stat' }, h('b', {}, fmtInt(d.now[k])), h('span', {}, label), delta(k));
  const fresh = d.lastEventAt ? Math.round((Date.parse(d.generatedAt) - Date.parse(d.lastEventAt)) / 60000) : null;
  const hours = d.hourly.map((x) => ({ ...x, hour: x.hour.slice(5).replace('T', ' ') + ':00' }));
  return [
    ...telemetryHead('Live', 'live'),
    h('p', { class: 'meta small' }, `Last 24 hours, by when the server received events. Refreshes every 30 s. Newest event: ${fresh == null ? 'none yet' : fresh < 1 ? 'under a minute ago' : `${fresh} min ago`}. Opted-out installs aren't counted.`),
    card('Right now', h('div', { class: 'stats' },
      tile('active', 'active installs'), tile('copies', 'llms.txt copies'), tile('popups', 'popups opened'), tile('installs', 'new installs'),
      tile('uninstalls', 'uninstalls'), tile('optOuts', 'opt-outs'), tile('errors', 'errors'))),
    card('Website', h('div', { class: 'stats' }, tile('views', 'page views'), tile('visitors', 'visitors'), tile('ctas', 'button clicks')),
      table([{ label: 'Button', get: (x) => x.target || '—', cls: 'mono' }, barCol('Clicks', 'n', d.ctas)], d.ctas, 'No clicks yet.')),
    card('By hour', table([
      { label: 'Hour (UTC)', get: (x) => x.hour, cls: 'nowrap mono' },
      barCol('Copies', 'copies', hours), barCol('Popups', 'popups', hours),
      { label: 'Installs', get: (x) => fmtInt(x.installs), cls: 'num' },
      { label: 'Views', get: (x) => fmtInt(x.views), cls: 'num hide-sm' },
      { label: 'Errors', get: (x) => (x.errors ? h('span', { class: 'err' }, fmtInt(x.errors)) : '0'), cls: 'num' },
    ], hours, 'No events in the last 24 hours.')),
    h('div', { class: 'cols' },
      card('Top sites (copies)', table([
        { label: 'Site', get: (x) => tSiteLink(x.site) },
        barCol('Copies', 'copies', d.sites),
        { label: 'Installs', get: (x) => fmtInt(x.installs), cls: 'num' },
        { label: 'Built by scoop.md', get: (x) => fmtInt(x.by_scoop), cls: 'num hide-sm' },
        { label: 'Last', get: (x) => time(x.last_at), cls: 'nowrap' },
      ], d.sites, 'No copies yet.')),
      card('Where the llms.txt came from', table([
        { label: 'Source', get: (x) => ({ site: "the site's own", scoop: 'prepared by scoop.md', fallback: 'found by the extension' }[x.source] ?? x.source ?? '—') },
        { label: 'Trigger', get: (x) => x.trigger || '—' },
        barCol('Copies', 'n', d.copies),
      ], d.copies, 'No copies yet.'))),
  ];
}

async function telemetryOverview(r) {
  const days = daysOf(r);
  const o = await api(`telemetry/overview?days=${days}`);
  const f = o.funnel;
  const steps = [['Popup opened', 'popupOpen'], ['Scooped (copied or ready)', 'scooped'], ['Copied', 'copied'], ['Voted', 'voted']];
  const perDay = byDay({ installs: o.perDay.installs, uninstalls: o.perDay.uninstalls, unknown: o.perDay.uninstalls.map((x) => ({ day: x.day, n: x.unknown })), active: o.perDay.active });
  return [
    ...telemetryHead('Telemetry', '', days, '#/telemetry', o.rawFrom),
    card('Installs', h('div', { class: 'stats' },
      stat(fmtInt(o.installs.total), 'installs seen'),
      stat(fmtInt(o.installs.installed), 'installed since telemetry (install event)'),
      stat(fmtInt(o.installs.uninstalled), 'uninstalled'),
      stat(fmtInt(o.installs.net), 'net installs'),
      stat(fmtInt(o.installs.optedOut), 'opted out of statistics'),
      stat(fmtInt(o.active.dau), 'DAU (today)'),
      stat(fmtInt(o.active.wau), 'WAU (7 days)'),
      stat(fmtInt(o.active.mau), 'MAU (30 days)'),
      stat(fmtInt(o.installs.unknownUninstalls), 'uninstalls of unknown install IDs (not counted above)'))),
    card(`Per day (since ${o.since})`, table([
      { label: 'Day', get: (x) => x.day, cls: 'nowrap mono' },
      barCol('Installs', 'installs', perDay),
      barCol('Uninstalls', 'uninstalls', perDay),
      { label: 'Unknown IDs', get: (x) => fmtInt(x.unknown), cls: 'num hide-sm' },
      barCol('Active installs', 'active', perDay),
    ], perDay, 'No installs or activity in this window.')),
    card('Funnel', table([
      { label: 'Step', get: (x) => x[0] },
      { label: 'Popup sessions', get: (x) => fmtInt(f.sessions[x[1]]), cls: 'num' },
      { label: '', get: (x) => bar(f.sessions[x[1]], f.sessions.popupOpen), cls: 'hide-sm' },
      { label: 'of sessions', get: (x) => pct(f.sessions[x[1]], f.sessions.popupOpen), cls: 'num' },
      { label: 'Events', get: (x) => fmtInt(f.events[x[1]]), cls: 'num hide-sm' },
      { label: 'Installs', get: (x) => fmtInt(f.installs[x[1]]), cls: 'num' },
      { label: '', get: (x) => bar(f.installs[x[1]], f.installs.popupOpen), cls: 'hide-sm' },
      { label: 'of installs', get: (x) => pct(f.installs[x[1]], f.installs.popupOpen), cls: 'num' },
    ], steps),
    h('p', { class: 'meta small' }, `Each step counts a popup session (or an install) once; a copy is the package reaching the clipboard, automatically or with the button. Votes: ${fmtInt(f.votes.worked)} worked, ${fmtInt(f.votes.failed)} didn't.`)),
    card('Library and packages', h('div', { class: 'stats' },
      stat(o.library.hitRate == null ? '—' : pct(o.library.hits, o.library.scoops), `library hit rate (${fmtInt(o.library.hits)} of ${fmtInt(o.library.scoops)} scoops)`),
      stat(fmtBytes(o.averages.sizeBytes) || '—', 'average package size'),
      stat(fmtMs(o.averages.durationMs), 'average scoop duration')),
    table([
      { label: 'Share outcome', get: (x) => pill(x.outcome || '—') },
      barCol('Count', 'n', o.shares),
    ], o.shares, 'No shares in this window.')),
  ];
}

async function telemetrySites(r) {
  const days = daysOf(r);
  const d = await api(`telemetry/sites?days=${days}`);
  return [
    ...telemetryHead('Sites', 'sites', days, '#/telemetry/sites', d.rawFrom),
    card(`Top sites (${d.sites.length})`, table([
      { label: 'Site', get: (s) => tSiteLink(s.site) },
      barCol('Scoops', 'scoops', d.sites),
      { label: 'Copied', get: (s) => fmtInt(s.copies), cls: 'num' },
      { label: 'Installs', get: (s) => fmtInt(s.installs), cls: 'num' },
      { label: 'Library hits', get: (s) => `${fmtInt(s.library_hits)} (${pct(s.library_hits, s.scoops)})`, cls: 'num' },
      { label: 'Failed', get: (s) => (s.failures ? h('span', { class: 'err' }, fmtInt(s.failures)) : '0'), cls: 'num' },
      { label: 'Votes', get: (s) => votes({ worked: s.worked, failed: s.failed }), cls: 'hide-sm' },
      { label: 'Last', get: (s) => time(s.last_at), cls: 'nowrap' },
    ], d.sites, 'No scoops in this window.')),
  ];
}

async function telemetrySite(r) {
  const site = r.parts[2];
  const days = daysOf(r);
  const d = await api(`telemetry/sites/${enc(site)}?days=${days}`);
  const s = d.summary;
  const best = Object.fromEntries(d.best.map((b) => [b.outcome, b.n]));
  return [
    h('p', { class: 'crumbs' }, h('a', { href: `#/telemetry/sites?days=${days}` }, 'Telemetry sites'), ' / '),
    h('div', { class: 'head' }, h('h1', { class: 'mono' }, site), windowPicker(`#/telemetry/sites/${enc(site)}`, days), h('a', { href: `#/sites/${enc(site)}`, class: 'small' }, 'crawl profile')),
    card(null, h('div', { class: 'stats' },
      stat(fmtInt(s.scoops), 'scoops'),
      stat(fmtInt(s.copies), 'copies'),
      stat(fmtInt(s.installs), 'installs'),
      stat(pct(s.library_hits ?? 0, s.scoops ?? 0), 'library hit rate'),
      stat(`${fmtInt(s.worked)} / ${fmtInt(s.failed)}`, 'worked / didn\'t'),
      stat(fmtInt(s.reports), 'reports'),
      stat(fmtBytes(s.avg_size && Math.round(s.avg_size)) || '—', 'average size'),
      stat(fmtMs(s.avg_duration), 'average duration'),
      stat(`${fmtInt(best.hit)} / ${fmtInt(best.miss)}`, 'API best: hit / miss'))),
    card('Per day', table([
      { label: 'Day', get: (x) => x.day, cls: 'nowrap mono' },
      barCol('Scoops', 'scoops', d.perDay),
      { label: 'Copies', get: (x) => fmtInt(x.copies), cls: 'num' },
      { label: 'Installs', get: (x) => fmtInt(x.installs), cls: 'num' },
    ], d.perDay)),
    card('Paths (public pages only)', table([
      { label: 'Path', get: (x) => h('span', { class: 'mono' }, x.path), cls: 'url' },
      barCol('Scoops', 'scoops', d.paths),
      { label: 'Copies', get: (x) => fmtInt(x.copies), cls: 'num' },
      { label: 'Installs', get: (x) => fmtInt(x.installs), cls: 'num' },
      { label: 'Failed', get: (x) => fmtInt(x.failures), cls: 'num' },
    ], d.paths, 'No public paths recorded.')),
    h('div', { class: 'cols' },
      card('Outcomes', table([
        { label: 'Outcome', get: (x) => pill(x.outcome) },
        { label: 'Library', get: (x) => (x.library_hit ? 'hit' : 'miss') },
        { label: 'Count', get: (x) => fmtInt(x.n), cls: 'num' },
      ], d.outcomes)),
      card('Sources', table([
        { label: 'Kind', get: (x) => x.kind },
        { label: 'Scoops', get: (x) => fmtInt(x.n), cls: 'num' },
      ], d.sources)),
      card('Shares', table([
        { label: 'Outcome', get: (x) => pill(x.outcome) },
        { label: 'Count', get: (x) => fmtInt(x.n), cls: 'num' },
      ], d.shares))),
    card('Search and package queries for this site', table([
      { label: 'Query', get: (x) => x.q },
      { label: 'Route', get: (x) => x.name.replace('api_', ''), cls: 'hide-sm' },
      { label: 'Count', get: (x) => fmtInt(x.n), cls: 'num' },
      { label: 'Avg results', get: (x) => (x.avg_results == null ? '' : x.avg_results.toFixed(1)), cls: 'num' },
      { label: 'Zero results', get: (x) => fmtInt(x.misses), cls: 'num' },
    ], d.queries, 'No queries for this site.')),
    card('Errors and refusals', table([
      { label: 'When', get: (x) => time(x.ts), cls: 'nowrap' },
      { label: 'Event', get: (x) => x.name },
      { label: 'Outcome', get: (x) => (x.outcome ? pill(x.outcome) : '') },
      { label: 'Install', get: (x) => (x.install_id ? installLink(x.install_id) : '') },
      { label: 'Details', get: (x) => h('span', { class: 'mono small' }, x.props), cls: 'hide-sm' },
    ], d.problems, 'None.')),
  ];
}

const INSTALL_STATUS = (i) => (i.uninstalled_at ? 'uninstalled' : i.opted_out ? 'opted out' : 'active');
const STATUS_PILL = { active: 'complete', uninstalled: 'failed', 'opted out': 'rejected' };
const statusPill = (i) => h('span', { class: `pill ${STATUS_PILL[INSTALL_STATUS(i)]}` }, INSTALL_STATUS(i));

async function telemetryUsers(r) {
  const status = r.params.get('status') ?? '';
  const q = r.params.get('q') ?? '';
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (q) qs.set('q', q);
  if (r.params.get('cursor')) qs.set('cursor', r.params.get('cursor'));
  const d = await api(`telemetry/installs?${qs}`);
  const statusSel = h('select', { id: 'installs-status' }, ['', 'active', 'uninstalled', 'opted_out'].map((x) => h('option', { value: x, selected: x === status }, x || 'any status')));
  const qIn = h('input', { id: 'installs-q', type: 'search', placeholder: 'install ID starts with', value: q });
  return [
    ...telemetryHead('Users', 'users'),
    card(null,
      h('form', {
        onsubmit: (e) => {
          e.preventDefault();
          const p = new URLSearchParams();
          if (statusSel.value) p.set('status', statusSel.value);
          if (qIn.value.trim()) p.set('q', qIn.value.trim().toLowerCase());
          location.hash = `#/telemetry/users${p.toString() ? `?${p}` : ''}`;
        },
      }, h('label', { class: 'field' }, 'Status', statusSel), h('label', { class: 'field' }, 'Install ID', qIn), h('button', { class: 'btn ghost', type: 'submit' }, 'Filter')),
      table([
        { label: 'Install', get: (i) => installLink(i.install_id) },
        { label: 'First seen', get: (i) => time(i.first_seen), cls: 'nowrap' },
        { label: 'Last seen', get: (i) => time(i.last_seen), cls: 'nowrap' },
        { label: 'Version', get: (i) => i.ext_version ?? '', cls: 'mono' },
        { label: 'Browser / OS', get: (i) => [i.browser, i.browser_version, i.os && `· ${i.os}`, i.arch].filter(Boolean).join(' '), cls: 'hide-sm' },
        { label: 'Country', get: (i) => i.country ?? '' },
        { label: 'Scoops', get: (i) => fmtInt(i.scoops), cls: 'num' },
        { label: 'Copies', get: (i) => fmtInt(i.copies), cls: 'num' },
        { label: 'Status', get: statusPill },
      ], d.installs, 'No installs match.'),
      pager(d.next, r.params, '#/telemetry/users')),
  ];
}

async function telemetryInstall(r) {
  const id = r.parts[2];
  const d = await api(`telemetry/installs/${enc(id)}`);
  const i = d.install;
  const del = h('button', { class: 'btn danger sm', type: 'button' }, 'Delete all data for this install');
  del.addEventListener('click', () => {
    if (!confirm(`Delete every event, the install row and its active days for ${id}? Its archived events are excluded from exports from now on, and new events from it are refused. This can't be undone.`)) return;
    act(del, () => api(`telemetry/installs/${enc(id)}`, { method: 'DELETE' }), (x) => {
      location.hash = '#/telemetry/users';
      return `Deleted ${fmtInt(x.eventsDeleted)} events for ${id}`;
    });
  });
  return [
    h('p', { class: 'crumbs' }, h('a', { href: '#/telemetry/users' }, 'Users'), ' / '),
    h('div', { class: 'head' }, h('h1', { class: 'mono' }, id), i ? statusPill(i) : null),
    i ? card(null, h('dl', { class: 'kv' }, [
      ['First seen', time(i.first_seen)], ['Last seen', time(i.last_seen)], ['Installed', time(i.installed_at)],
      ['Days active', `${fmtInt(d.activeDays)}${d.firstDay ? ` (${d.firstDay} – ${d.lastDay})` : ''}`],
      ['Version', i.ext_version ?? ''], ['Browser', [i.browser, i.browser_version].filter(Boolean).join(' ')], ['OS', [i.os, i.arch].filter(Boolean).join(' ')],
      ['Locale / time zone', [i.locale, i.timezone].filter(Boolean).join(' · ')], ['Country', i.country ?? ''],
      ['Events / scoops / copies', `${fmtInt(i.events)} / ${fmtInt(i.scoops)} / ${fmtInt(i.copies)}`],
      ['Statistics', i.opted_out ? `opted out ${i.opted_out_at ?? ''}` : 'on'],
      ['Uninstalled', i.uninstalled_at ? `${i.uninstalled_at}${i.uninstall_reason ? ` (${i.uninstall_reason})` : ''}` : ''],
    ].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))) : card(null, h('p', { class: 'meta' }, 'Only website events for this ID (no extension activity recorded).')),
    card(`Sites (${d.sites.length})`, table([
      { label: 'Site', get: (x) => tSiteLink(x.site) },
      { label: 'Scoops', get: (x) => fmtInt(x.scoops), cls: 'num' },
      { label: 'Copies', get: (x) => fmtInt(x.copies), cls: 'num' },
      { label: 'Last', get: (x) => time(x.last_at), cls: 'nowrap' },
    ], d.sites, 'No sites.')),
    card(`Timeline (latest ${d.timeline.length})`, table([
      { label: 'When', get: (x) => h('span', { title: x.ts, class: 'mono small' }, x.ts.replace('T', ' ').slice(0, 19)), cls: 'nowrap' },
      { label: 'Event', get: (x) => x.name },
      { label: 'Site', get: (x) => tSiteLink(x.site) },
      { label: 'Path', get: (x) => (x.path ? h('span', { class: 'mono' }, x.path) : ''), cls: 'url' },
      { label: 'Outcome', get: (x) => (x.outcome ? pill(x.outcome) : '') },
      { label: 'Properties', get: (x) => (x.props === '{}' ? '' : h('span', { class: 'mono small' }, x.props)), cls: 'hide-sm' },
      { label: 'Session', get: (x) => h('span', { class: 'mono small', title: x.session_id ?? '' }, (x.session_id ?? '').slice(-6)), cls: 'hide-sm' },
    ], d.timeline, 'No events.')),
    card('Deletion request', h('p', { class: 'meta small' }, 'For a request to team@ddamoah.com with this install ID. Daily counts (no install IDs) are kept.'), h('div', {}, del)),
  ];
}

async function telemetryRetention(r) {
  const weeks = Math.min(26, Math.max(1, Number(r.params.get('weeks')) || 12));
  const d = await api(`telemetry/retention?weeks=${weeks}`);
  const cols = Array.from({ length: weeks + 1 }, (_, w) => w);
  const heat = (n, size) => {
    const p = size ? n / size : 0;
    return `heat heat-${p === 0 ? 0 : Math.min(5, 1 + Math.floor(p * 5))}`;
  };
  return [
    h('div', { class: 'head' }, h('h1', {}, 'Retention'),
      h('span', { class: 'row small' }, 'Weeks:', [4, 8, 12, 26].map((w) => (w === weeks ? h('b', {}, String(w)) : h('a', { href: `#/telemetry/retention?weeks=${w}` }, String(w)))))),
    tabs('retention'),
    card('Weekly install cohorts × weeks active', table([
      { label: 'Cohort (week of)', get: (c) => c.cohort, cls: 'nowrap mono' },
      { label: 'Installs', get: (c) => fmtInt(c.size), cls: 'num' },
      ...cols.map((w) => ({
        label: `W${w}`,
        get: (c) => (w <= c.elapsed ? h('span', { class: heat(c.active[w], c.size), title: `${c.active[w]} of ${c.size}` }, pct(c.active[w], c.size)) : ''),
        cls: 'num',
      })),
    ], d.cohorts, 'No installs in this window.'),
    h('p', { class: 'meta small' }, 'A cohort is the installs whose install event falls in a week (Monday to Sunday, UTC); installs from before usage statistics have none and are left out. Wn is the share that sent anything n weeks later (by the day the server received it).')),
  ];
}

async function telemetryPlatforms(r) {
  const days = daysOf(r);
  const d = await api(`telemetry/platforms?days=${days}`);
  const breakdown = (title, rows) => card(title, table([
    { label: 'Value', get: (x) => x.value || '—', cls: 'mono' },
    barCol('Installs', 'installs', rows),
  ], rows));
  const versions = [...new Set(d.adoption.map((x) => x.version))].sort(semverCmp);
  const adoption = [...d.adoption.reduce((m, x) => m.set(x.day, { day: x.day, ...m.get(x.day), [x.version]: x.n }), new Map()).values()];
  return [
    ...telemetryHead('Versions & platforms', 'platforms', days, '#/telemetry/platforms', d.rawFrom),
    h('p', { class: 'meta small' }, 'Installs seen in the window and not uninstalled.'),
    h('div', { class: 'cols' },
      breakdown('Extension version', d.versions),
      breakdown('Browser', d.browsers),
      breakdown('Browser version', d.browserVersions),
      breakdown('OS', d.oses),
      breakdown('CPU architecture', d.arches),
      breakdown('UI language', d.locales),
      breakdown('Time zone', d.timezones)),
    card('Update adoption (daily active installs by version)', table([
      { label: 'Day', get: (x) => x.day, cls: 'nowrap mono' },
      ...versions.map((v) => ({ label: v || '—', get: (x) => (x[v] ? `${fmtInt(x[v])} (${pct(x[v], versions.reduce((n, k) => n + (x[k] ?? 0), 0))})` : ''), cls: 'num' })),
    ], adoption, 'No daily pings in this window.')),
    card('Website visitors by browser (parsed user agent)', table([
      { label: 'Browser', get: (x) => x.value || '—' },
      { label: 'OS', get: (x) => x.os || '—' },
      { label: 'Page views', get: (x) => fmtInt(x.n), cls: 'num' },
    ], d.websiteBrowsers)),
  ];
}

async function telemetryGeo(r) {
  const days = daysOf(r);
  const d = await api(`telemetry/geo?days=${days}`);
  return [
    ...telemetryHead('Geography', 'geo', days, '#/telemetry/geo', d.rawFrom),
    h('p', { class: 'meta small' }, 'Country from the request IP (Cloudflare), at ingest. IPs are never stored.'),
    h('div', { class: 'cols' },
      card('Installs by country', table([
        { label: 'Country', get: (x) => x.country || '—', cls: 'mono' },
        barCol('Installs', 'installs', d.installs),
        { label: 'Uninstalled', get: (x) => fmtInt(x.uninstalled), cls: 'num' },
      ], d.installs)),
      card('Scoops by country', table([
        { label: 'Country', get: (x) => x.country || '—', cls: 'mono' },
        barCol('Scoops', 'scoops', d.events),
        { label: 'Events', get: (x) => fmtInt(x.events), cls: 'num' },
      ], d.events)),
      card('Website views by country', table([
        { label: 'Country', get: (x) => x.country || '—', cls: 'mono' },
        barCol('Views', 'views', d.website),
      ], d.website))),
    card('Networks (ISP or organisation)', table([
      { label: 'Continent', get: (x) => x.continent || '—', cls: 'mono' },
      { label: 'Network', get: (x) => x.network || '—' },
      barCol('Installs', 'installs', d.networks),
    ], d.networks)),
  ];
}

async function telemetryErrors(r) {
  const days = daysOf(r);
  const d = await api(`telemetry/errors?days=${days}`);
  const perDay = byDay(Object.fromEntries([...new Set(d.scoopFailures.map((x) => x.outcome))].map((o) => [o, d.scoopFailures.filter((x) => x.outcome === o)])));
  const errDay = d.perDay.reduce((m, x) => m.set(x.day, (m.get(x.day) ?? 0) + x.n), new Map());
  for (const row of perDay) row.errors = errDay.get(row.day) ?? 0;
  for (const [day, n] of errDay) if (!perDay.some((x) => x.day === day)) perDay.push({ day, errors: n });
  perDay.sort((a, b) => (a.day < b.day ? -1 : 1));
  return [
    ...telemetryHead('Errors', 'errors', days, '#/telemetry/errors', d.rawFrom),
    card('By code, where and version', table([
      { label: 'Where', get: (x) => x.where_ ?? '' },
      { label: 'Code', get: (x) => h('span', { class: 'mono' }, x.code ?? '') },
      { label: 'Version', get: (x) => x.version || '—', cls: 'mono' },
      barCol('Count', 'n', d.byCode),
      { label: 'Installs', get: (x) => fmtInt(x.installs), cls: 'num' },
      { label: 'Last', get: (x) => time(x.last_at), cls: 'nowrap' },
    ], d.byCode, 'No errors in this window.')),
    card('Over time', table([
      { label: 'Day', get: (x) => x.day, cls: 'nowrap mono' },
      barCol('Error events', 'errors', perDay),
      { label: 'Scoops failed', get: (x) => fmtInt(x.error), cls: 'num' },
      { label: 'Empty pages', get: (x) => fmtInt(x.empty), cls: 'num' },
      { label: 'Unsupported pages', get: (x) => fmtInt(x.unsupported_page), cls: 'num' },
    ], perDay, 'Nothing in this window.')),
    card('Recent', table([
      { label: 'When', get: (x) => time(x.ts), cls: 'nowrap' },
      { label: 'Install', get: (x) => (x.install_id ? installLink(x.install_id) : '') },
      { label: 'Version', get: (x) => x.ext_version ?? '', cls: 'mono' },
      { label: 'Where', get: (x) => x.where_ ?? '' },
      { label: 'Code', get: (x) => x.code ?? '', cls: 'mono' },
      { label: 'Message', get: (x) => x.message ?? '' },
    ], d.recent, 'No errors.')),
  ];
}

async function telemetryApi(r) {
  const days = daysOf(r);
  const d = await api(`telemetry/api?days=${days}`);
  const routes = [...d.routes.reduce((m, x) => m.set(x.name, { name: x.name, ...m.get(x.name), [x.outcome || 'other']: x.n, total: (m.get(x.name)?.total ?? 0) + x.n }), new Map()).values()];
  return [
    ...telemetryHead('API usage', 'api', days, '#/telemetry/api', d.rawFrom),
    h('p', { class: 'meta small' }, 'Server-side, per request: route, site, query text, hit or miss, results, latency, client and country. No IPs or install IDs.'),
    card('Routes', table([
      { label: 'Route', get: (x) => h('span', { class: 'mono' }, x.name.replace('api_', '')) },
      barCol('Requests', 'total', routes),
      { label: 'Hit', get: (x) => fmtInt(x.hit), cls: 'num' },
      { label: 'Miss', get: (x) => fmtInt(x.miss), cls: 'num' },
    ], routes, 'No API requests recorded.')),
    card('Top search queries', table([
      { label: 'Query', get: (x) => x.q ?? '' },
      { label: 'Site', get: (x) => tSiteLink(x.site) },
      barCol('Count', 'n', d.queries),
      { label: 'Avg results', get: (x) => (x.avg_results == null ? '' : x.avg_results.toFixed(1)), cls: 'num' },
      { label: 'Avg latency', get: (x) => fmtMs(x.avg_ms), cls: 'num' },
    ], d.queries, 'No searches.')),
    card('Zero-result queries', table([
      { label: 'Query', get: (x) => x.q ?? '' },
      { label: 'Site', get: (x) => tSiteLink(x.site) },
      { label: 'Route', get: (x) => x.name.replace('api_', '') },
      { label: 'Count', get: (x) => fmtInt(x.n), cls: 'num' },
      { label: 'Last', get: (x) => time(x.last_at), cls: 'nowrap' },
    ], d.zeroResults, 'None.')),
    h('div', { class: 'cols' },
      card('Package requests by site', table([
        { label: 'Site', get: (x) => tSiteLink(x.site) },
        barCol('Requests', 'n', d.packages),
        { label: 'Hit', get: (x) => pct(x.hits, x.n), cls: 'num' },
        { label: 'By topic', get: (x) => fmtInt(x.by_topic), cls: 'num' },
      ], d.packages, 'None.')),
      card('Best skill: hit / miss by site', table([
        { label: 'Site', get: (x) => tSiteLink(x.site) },
        { label: 'Hit', get: (x) => fmtInt(x.hits), cls: 'num' },
        { label: 'Miss', get: (x) => fmtInt(x.misses), cls: 'num' },
        { label: 'Hit rate', get: (x) => pct(x.hits, x.hits + x.misses), cls: 'num' },
      ], d.best, 'None.')),
      card('Clients (X-Scoop-Client)', table([
        { label: 'Client', get: (x) => x.client || '—', cls: 'mono' },
        barCol('Requests', 'n', d.clients),
      ], d.clients, 'None.'))),
  ];
}

async function telemetryWebsite(r) {
  const days = daysOf(r);
  const d = await api(`telemetry/website?days=${days}`);
  return [
    ...telemetryHead('Website', 'website', days, '#/telemetry/website', d.rawFrom),
    h('p', { class: 'meta small' }, 'scoop.md page views: no cookies; a visitor is a daily-rotating hash, so visitors are unique per day.'),
    card('Per day', table([
      { label: 'Day', get: (x) => x.day, cls: 'nowrap mono' },
      barCol('Views', 'views', d.perDay),
      { label: 'Visitors', get: (x) => fmtInt(x.visitors), cls: 'num' },
    ], d.perDay, 'No page views.')),
    h('div', { class: 'cols' },
      card('Pages', table([
        { label: 'Path', get: (x) => h('span', { class: 'mono' }, x.path ?? ''), cls: 'url' },
        barCol('Views', 'views', d.paths),
        { label: 'Visitors', get: (x) => fmtInt(x.visitors), cls: 'num' },
      ], d.paths)),
      card('Referrers', table([
        { label: 'Host', get: (x) => h('span', { class: 'mono' }, x.host) },
        barCol('Views', 'views', d.referrers),
      ], d.referrers, 'None.')),
      card('Campaigns (UTM)', table([
        { label: 'Source', get: (x) => x.source ?? '' },
        { label: 'Medium', get: (x) => x.medium ?? '' },
        { label: 'Campaign', get: (x) => x.campaign ?? '' },
        { label: 'Views', get: (x) => fmtInt(x.views), cls: 'num' },
      ], d.utm, 'None.')),
      card('Calls to action', table([
        { label: 'Target', get: (x) => x.target ?? '' },
        { label: 'Page', get: (x) => h('span', { class: 'mono' }, x.path) },
        { label: 'Clicks', get: (x) => fmtInt(x.n), cls: 'num' },
      ], d.ctas, 'None.'))),
    card('Uninstall page (/bye)', h('div', { class: 'stats' },
      stat(fmtInt(d.bye.views), 'page views'),
      stat(fmtInt(d.bye.uninstalls), 'uninstalls recorded')),
    table([
      { label: 'Reason', get: (x) => x.reason ?? '' },
      barCol('Count', 'n', d.bye.reasons),
    ], d.bye.reasons, 'No reasons given.')),
  ];
}

const EXPORTS = [
  ['events', 'Raw events (D1, last 180 days)'],
  ['installs', 'Installs'],
  ['install_days', 'Install active days'],
  ['events_daily', 'Daily rollups'],
  ['archive', 'R2 archive (raw, NDJSON, ≤31 days)'],
];

async function telemetryExport() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const tableSel = h('select', { id: 'export-table' }, EXPORTS.map(([v, label]) => h('option', { value: v }, label)));
  const from = h('input', { id: 'export-from', type: 'date', value: monthAgo });
  const to = h('input', { id: 'export-to', type: 'date', value: today });
  const format = h('select', { id: 'export-format' }, ['csv', 'ndjson'].map((v) => h('option', { value: v }, v.toUpperCase())));
  const link = h('a', { class: 'btn', download: '' }, 'Download');
  // A same-origin GET: the browser's Basic auth covers it and the response is an attachment.
  const update = () => {
    const p = new URLSearchParams({ table: tableSel.value, from: from.value, to: to.value, format: tableSel.value === 'archive' ? 'ndjson' : format.value });
    link.setAttribute('href', safeHref(new URL(`/api/telemetry/export?${p}`, location.origin).href));
    format.disabled = tableSel.value === 'archive';
  };
  for (const el of [tableSel, from, to, format]) el.addEventListener('change', update);
  update();
  const { deletions } = await api('telemetry/deletions');
  return [
    ...telemetryHead('Export', 'export'),
    card('Download a table', h('div', { class: 'form' },
      h('label', { class: 'field' }, 'Table', tableSel),
      h('label', { class: 'field' }, 'From', from),
      h('label', { class: 'field' }, 'To (inclusive)', to),
      h('label', { class: 'field' }, 'Format', format),
      link),
    h('p', { class: 'meta small' }, 'Days are UTC. The archive skips every install ID with a deletion tombstone. CSV cells that start with = + - @ are prefixed with \' so spreadsheets don\'t run them.')),
    card(`Deletion requests (${deletions.length})`, table([
      { label: 'Install', get: (x) => h('span', { class: 'mono' }, x.install_id) },
      { label: 'Deleted', get: (x) => time(x.deleted_at), cls: 'nowrap' },
      { label: 'Events deleted', get: (x) => fmtInt(x.events_deleted), cls: 'num' },
    ], deletions, 'None.')),
  ];
}

render();
