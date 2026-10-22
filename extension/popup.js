// The popup (0.6.0): the site's llms.txt and its instructions for agents,
// copied for the agent in one click. Nothing else: no page scoop, no sharing.
import { discover, siteKey } from './lib/discover.js';
import { verifyLlms } from './lib/llms.js';
import { DEFAULT_LIBRARY, libraryUrl, createLibrary } from './lib/library.js';
import { createTelemetry, getInstallId, NOTICE_KEY, errorText, setTelemetry, telemetryEnabled } from './lib/telemetry.js';
import { isPrivateHost } from './lib/hosts.js';
import { rememberLlms, setTabBadge } from './lib/badge.js';
import { logStage, reducedMotion, sleep, timing } from './lib/ux.js';

const $ = (id) => document.getElementById(id);

let library;
let libraryOptions;
let devLibrary = false;
let tab;
// Usage statistics (lib/telemetry.js).
const telemetry = createTelemetry();
const openedAt = Date.now();
const track = (name, props) => telemetry.track(name, props);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

// The async clipboard API refuses unfocused documents (e.g. the user clicked
// away while the popup was loading). execCommand works there because the
// extension has clipboardWrite. Returns whether the text reached the clipboard.
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = Object.assign(document.createElement('textarea'), { value: text, className: 'offscreen' });
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    area.remove();
    getSelection()?.removeAllRanges();
    return ok;
  }
}

// Stages (body[data-stage]): loading → copied → content, or loading → content.
function setStage(name) {
  document.body.dataset.stage = name;
  logStage(name);
  $('loader').hidden = name !== 'loading';
  $('copied-stage').hidden = name !== 'copied';
  $('main').hidden = name !== 'content';
}

// The loader stays at least timing.loaderMs, so a fast answer doesn't flicker.
let loaderShownAt = 0;
function showLoader() {
  loaderShownAt = Date.now();
  setStage('loading');
}
const loaderDone = () => sleep(Math.max(0, loaderShownAt + timing.loaderMs - Date.now()));

// After the copy: the "copied" moment, then the content. Never before the copy.
async function revealAfterCopy(ok) {
  await loaderDone();
  if (ok) {
    const reduced = reducedMotion();
    document.body.dataset.motion = reduced ? 'reduced' : 'full';
    setStage('copied');
    track('copied_animation_shown', { reducedMotion: reduced });
    await sleep(reduced ? timing.reducedMs : timing.celebrateMs);
  }
  reveal();
  if (ok) flashLlmsCopied();
}

// Clears the live region first, so the same message twice is announced twice.
let announcing = null;
function announce(text) {
  $('announce').textContent = '';
  clearTimeout(announcing);
  announcing = setTimeout(() => { $('announce').textContent = text; }, ANNOUNCE_DELAY_MS);
}
const ANNOUNCE_DELAY_MS = 50;

// The content, announced, and focus on the Copy button.
function reveal() {
  setStage('content');
  announce(`${$('main').getAttribute('aria-label')}. ${llmsCopiedNow ? 'Copied to your clipboard.' : $('not-dev').hidden ? $('llms-status').textContent : $('not-dev').textContent}`.trim());
  llmsCopiedNow = false;
  if (!$('copy-llms').hidden) $('copy-llms').focus();
}

// The main view (0.6.0): the site's llms.txt. GET /v1/llms answers with the
// exact prompt to copy (its URL and how to use it); a docs site without an
// llms.txt gets one prepared by scoop.md, already at a valid URL while it is
// built ("preparing", polled until ready). Not docs: nothing to copy. The
// library unreachable or slow (5 s): the site's own llms.txt, if verified
// here, gives the same prompt; otherwise "Couldn't reach scoop.md" and Retry.
let llmsPrompt = '';
let llmsData = null;
let llmsCopiedNow = false;
let llmsSource = null;
let llmsPoll = null;
const PREPARING_POLLS = 40;

// The elapsed time: under the loader while /v1/llms answers, then in the meta
// line while a scoop.md llms.txt is prepared ("Preparing… 3.4s"), and the final
// time stays in the meta ("found in 1.2s", "prepared in 4.6s"). Every 100 ms,
// or once a second with reduced motion.
let timerStart = 0;
let timerTick = null;
let foundMs = null;
let preparedMs = null;
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
// The loader's timer, one span per character, so each digit that changes rolls in (popup.css)
function setDigits(el, text) {
  const old = [...el.children];
  if (old.length !== text.length) {
    el.textContent = '';
    old.length = 0;
  }
  [...text].forEach((ch, i) => {
    if (old[i]?.textContent === ch) return;
    const d = document.createElement('span');
    d.className = 'digit';
    d.textContent = ch;
    if (old[i]) old[i].replaceWith(d);
    else el.append(d);
  });
}
function startTimer() {
  stopTimer();
  timerStart = Date.now();
  foundMs = null;
  preparedMs = null;
  const tick = () => {
    const text = seconds(Date.now() - timerStart);
    setDigits($('elapsed'), text);
    if (llmsData?.llms?.status === 'preparing' && !$('llms-block').hidden) $('llms-meta').textContent = `Preparing… ${text}`;
  };
  tick();
  timerTick = setInterval(tick, reducedMotion() ? 1_000 : 100);
}
function stopTimer() {
  clearInterval(timerTick);
  timerTick = null;
  return Date.now() - timerStart;
}

async function runMain() {
  clearTimeout(llmsPoll);
  llmsData = null;
  setLlms({ state: 'checking' });
  showLoader();
  startTimer();
  const host = new URL(tab.url).hostname;
  const privateHost = isPrivateHost(host);
  let res = null;
  if (devLibrary || !privateHost) res = await library.llms(llmsQueryUrl(tab.url));
  if (res?.ok && res.data && typeof res.data === 'object') return showLlms(res.data, { fallback: false, privateHost });
  const local = await localLlms(tab.url);
  if (local) return showLlms(local, { fallback: true, privateHost });
  stopTimer();
  setLlms({ state: 'unreachable' });
  await loaderDone();
  reveal();
}

async function showLlms(data, { fallback, privateHost }) {
  const llms = data.llms;
  const docs = Boolean(data.docs?.found && llms?.url && data.prompt && /^https?:\/\//i.test(llms.url));
  if (!fallback && !privateHost) learnBadge(data, docs);
  // Still preparing: the clock keeps running, in the meta line.
  if (!(docs && llms.status === 'preparing' && !fallback)) foundMs = stopTimer();
  if (!docs) {
    setLlms({ state: 'no' });
    await loaderDone();
    return reveal();
  }
  llmsData = data;
  llmsPrompt = data.prompt;
  llmsSource = fallback ? 'fallback' : llms.source === 'scoop' ? 'scoop' : 'site';
  setLlms({ state: 'yes', data });
  const ok = await writeClipboard(llmsPrompt);
  if (ok && !privateHost) track('llms_copy', { site: siteKey(tab.url), source: llmsSource, trigger: 'auto' });
  // Success shows on the button ("Copied", with a drawn check) and is announced; the line is for problems.
  $('llms-status').textContent = ok ? '' : 'Press Copy to put it on your clipboard.';
  llmsCopiedNow = ok;
  await revealAfterCopy(ok);
  if (llms.status === 'preparing' && !fallback) pollPreparing(data.retryAfterMs, 0);
}

// The instructions for agents, as /v1/llms reports them (verbatim from the
// llms.txt; the server's prompt already carries them for the big button).
function agentInstructions(data) {
  return String(data?.agentInstructions?.text ?? '').trim();
}

// The toolbar badge for this site, from this answer at once (kept 7 days):
// "1" an llms.txt, "2" with instructions for agents, nothing while it is being
// prepared or when the site is one scoop.md has nothing for.
function learnBadge(data, docs) {
  const level = !docs || data.llms.status !== 'ready' ? 0 : agentInstructions(data) ? 2 : 1;
  rememberLlms(chrome, siteKey(tab.url), level).then(() => setTabBadge(chrome, tab)).catch(() => {});
}

// A scoop.md-built llms.txt still being built: its URL already works; asked
// again every retryAfterMs until it is ready.
function pollPreparing(retryAfterMs, n) {
  if (n >= PREPARING_POLLS) {
    stopTimer();
    return;
  }
  llmsPoll = setTimeout(async () => {
    const res = await library.llms(llmsQueryUrl(tab.url));
    if (!res.ok || !res.data?.llms) return pollPreparing(retryAfterMs, n + 1);
    if (res.data.prompt) {
      llmsData = res.data;
      llmsPrompt = res.data.prompt;
    }
    if (res.data.llms.status === 'ready') preparedMs = stopTimer();
    setLlms({ state: 'yes', data: res.data });
    if (res.data.llms.status === 'ready') learnBadge(res.data, true);
    if (res.data.llms.status === 'preparing') pollPreparing(res.data.retryAfterMs ?? retryAfterMs, n + 1);
  }, Math.max(500, Number(retryAfterMs) || 3_000));
}

// What GET /v1/llms is told: the page's origin and the first segment of its
// path (https://app.example.com/docs), enough to find the docs root and no more.
function llmsQueryUrl(url) {
  const u = new URL(url);
  const first = u.pathname.split('/').filter(Boolean)[0];
  return `${u.origin}/${first ?? ''}`;
}

const docsName = (title, host) => (String(title || '').replace(/\s*[-–|:]\s*$/, '').replace(/\s+(developer\s+)?(documentation|docs)$/i, '').trim() || host);

// The site's own llms.txt found here (the library unreachable): the same prompt.
async function localLlms(url) {
  const page = new URL(url);
  const found = await discover(`${page.origin}${page.pathname}`).catch(() => ({}));
  const file = found.llms;
  if (!file?.content || !verifyLlms(file.content)) return null;
  const title = file.content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';
  const pages = (file.content.match(/\[[^\]]+\]\((?:https?:\/\/|\/)[^)\s]+\)/g) ?? []).length;
  const root = new URL(file.url).origin;
  return {
    site: siteKey(url),
    docs: { found: true, root, verdict: 'unknown' },
    llms: { url: file.url, source: 'site', status: 'ready', title, pages, checkedAt: new Date().toISOString(), fullUrl: null },
    prompt: `${docsName(title, siteKey(file.url))} docs for agents: ${file.url} — read it first, then fetch only the pages you need.`,
    retryAfterMs: null,
  };
}

function checkedText(iso) {
  const t = Date.parse(iso ?? '');
  if (!t) return '';
  const days = Math.floor((Date.now() - t) / 86_400_000);
  return days <= 0 ? 'checked today' : days === 1 ? 'checked yesterday' : `checked ${days} days ago`;
}

// The main view for a state: checking; yes (the /v1/llms answer: the llms.txt
// field and the instructions for agents); no (one line); unreachable.
function setLlms({ state, data = null }) {
  const site = siteKey(tab.url);
  $('llms-checking').hidden = state !== 'checking';
  $('llms-block').hidden = state !== 'yes';
  $('copy-llms').hidden = state !== 'yes';
  $('peek').hidden = true;
  $('llms-found').hidden = state !== 'yes';
  $('not-dev').hidden = state !== 'no';
  $('agent-block').hidden = true;
  $('llms-retry').hidden = state !== 'unreachable';
  $('llms-status').textContent = state === 'unreachable' ? "Couldn't reach scoop.md" : '';
  $('main').setAttribute('aria-label', {
    checking: "Checking this site's llms.txt",
    no: `scoop.md has nothing to copy for ${site}`,
    unreachable: "Couldn't reach scoop.md",
    yes: `${site}: llms.txt`,
  }[state]);
  if (state !== 'yes') return;
  const llms = data.llms;
  $('llms-badge').hidden = llms.source !== 'scoop';
  // The site, with a tag for what was found: its own llms.txt, one scoop.md made, or one still being made
  const found = llms.status === 'preparing' ? 'preparing' : llms.source;
  $('llms-found').dataset.state = found;
  $('llms-found').setAttribute('aria-label', {
    preparing: `Preparing an llms.txt for ${site}`,
    scoop: `llms.txt prepared by scoop.md for ${site}`,
    site: `llms.txt detected on ${site}`,
  }[found]);
  if (tab.favIconUrl?.startsWith('http')) $('site-icon').src = tab.favIconUrl;
  $('llms-found-text').textContent = site;
  $('llms-found-tag').textContent = { preparing: 'Preparing', scoop: 'Made by scoop.md', site: 'llms.txt detected' }[found];
  const took = preparedMs != null ? `prepared in ${seconds(preparedMs)}` : foundMs != null ? `found in ${seconds(foundMs)}` : '';
  $('llms-meta').textContent = llms.status === 'preparing'
    ? `Preparing… ${seconds(Date.now() - timerStart)}`
    : [llms.pages > 0 ? plural(llms.pages, 'page') : '', checkedText(llms.checkedAt), took].filter(Boolean).join(' · ');
  $('llms-field-text').textContent = middle(llms.url.replace(/^https?:\/\//, ''), 36);
  $('llms-field-text').title = llms.url;
  $('llms-field-text').setAttribute('aria-label', `llms.txt: ${llms.url}`);
  $('llms-field').href = llms.url;
  $('llms-field').setAttribute('aria-label', `Open ${llms.url}${llms.source === 'scoop' ? ', prepared by scoop.md' : ''}`);
  // The start of the prompt the big button copies, so it's clear what goes to the agent
  const prompt = data.prompt || llmsPrompt || '';
  $('peek').textContent = prompt;
  $('peek').hidden = !prompt;
  const text = agentInstructions(data);
  $('agent-block').hidden = !text;
  $('agent-text').textContent = text;
  const long = text.split('\n').length > 4 || text.length > 240;
  $('agent-text').dataset.collapsed = String(long);
  $('agent-more').hidden = !long;
  $('agent-more').onclick = () => {
    $('agent-text').dataset.collapsed = 'false';
    $('agent-more').hidden = true;
  };
  $('main').setAttribute('aria-label', `${site}: llms.txt${text ? ' and instructions for agents' : ''}`);
  llmsLabel = text ? 'Copy llms.txt + instructions' : 'Copy llms.txt';
  if ($('copy-llms-label').textContent !== 'Copied') $('copy-llms-label').textContent = llmsLabel;
}
let llmsLabel = 'Copy llms.txt';

// A long URL cut in the middle, so its host and its end (…/llms.txt) both show.
function middle(text, max) {
  if (text.length <= max) return text;
  const tail = Math.min(text.length - 1, Math.max(12, Math.floor(max / 2)));
  return `${text.slice(0, max - tail - 1)}…${text.slice(-tail)}`;
}


let llmsCopiedTimer = null;
function flashLlmsCopied() {
  $('copy-llms-label').textContent = 'Copied';
  // data-copied drives the button's copied animation (popup.css); off and on again restarts it
  delete $('copy-llms').dataset.copied;
  void $('copy-llms').offsetWidth;
  $('copy-llms').dataset.copied = 'true';
  clearTimeout(llmsCopiedTimer);
  llmsCopiedTimer = setTimeout(() => {
    $('copy-llms-label').textContent = llmsLabel;
    delete $('copy-llms').dataset.copied;
  }, timing.copiedLabelMs);
}
$('copy-llms').onclick = async () => {
  if (!llmsPrompt) return;
  const ok = await writeClipboard(llmsPrompt);
  $('llms-status').textContent = ok ? '' : "Couldn't copy. Try again.";
  if (!ok) return;
  announce('Copied to your clipboard.');
  flashLlmsCopied();
  if (!isPrivateHost(new URL(tab.url).hostname)) track('llms_copy', { site: siteKey(tab.url), source: llmsSource, trigger: 'button' });
};
$('llms-retry').onclick = () => runMain().catch(fail);
// The two small Copy buttons: the llms.txt link alone, the instructions alone.
async function copySmall(button, text, label) {
  if (!text || !(await writeClipboard(text))) return;
  button.dataset.done = 'true';
  button.title = 'Copied';
  announce(`${label} copied to your clipboard.`);
  setTimeout(() => { button.dataset.done = 'false'; button.title = 'Copy'; }, timing.copiedLabelMs);
}
$('copy-llms-url').onclick = () => copySmall($('copy-llms-url'), llmsData?.llms?.url, 'The llms.txt link');
$('copy-agent').onclick = () => copySmall($('copy-agent'), agentInstructions(llmsData), 'The instructions for agents');

// One-time notice about usage statistics.
// Until it has been shown, events carry no site (lib/telemetry.js).
async function usageNotice() {
  if (!(await telemetryEnabled(chrome))) return;
  if ((await chrome.storage.local.get(NOTICE_KEY))[NOTICE_KEY]) return;
  $('usage-notice').hidden = false;
  telemetry.markNoticeShown();
  $('usage-ok').onclick = () => { $('usage-notice').hidden = true; };
  $('usage-off').onclick = async () => {
    telemetry.disable();
    library = createLibrary({ ...libraryOptions, telemetry: false });
    $('usage-notice-text').textContent = 'Usage statistics are off. You can turn them back on in Settings.';
    $('usage-off').hidden = true;
    $('usage-ok').onclick = () => { $('usage-notice').hidden = true; };
    await setTelemetry(chrome, false);
  };
}

// One line, once: pinning shows on the icon which sites have an llms.txt.
const PIN_KEY = 'pinHintSeen';
async function pinHint() {
  try {
    const { [PIN_KEY]: seen } = await chrome.storage.local.get(PIN_KEY);
    if (seen || (await chrome.action.getUserSettings?.())?.isOnToolbar !== false) return;
  } catch {
    return;
  }
  $('pin-hint').hidden = false;
  $('pin-ok').onclick = () => {
    $('pin-hint').hidden = true;
    chrome.storage.local.set({ [PIN_KEY]: true });
  };
}

function fail(e) {
  stopTimer();
  setLlms({ state: 'unreachable' });
  $('llms-status').textContent = e?.message || String(e);
  reveal();
  track('error', { where: 'popup', code: e?.name || 'Error', message: errorText(e) });
}

$('theme').onclick = async () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = dark ? 'light' : 'dark';
  applyTheme(theme);
  track('settings_change', { key: 'theme', value: theme });
  try { await chrome.storage.local.set({ theme }); } catch {}
};
$('settings').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

async function main() {
  try { applyTheme((await chrome.storage.local.get('theme')).theme); } catch {}
  const baseUrl = await libraryUrl(chrome);
  devLibrary = baseUrl !== DEFAULT_LIBRARY;
  libraryOptions = {
    baseUrl,
    installId: await getInstallId(chrome),
    client: `extension/${chrome.runtime.getManifest().version}`,
    telemetry: await telemetryEnabled(chrome),
  };
  library = createLibrary(libraryOptions);
  await usageNotice();
  await pinHint();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!/^https?:/.test(tab?.url || '')) {
    setLlms({ state: 'unreachable' });
    $('llms-status').textContent = 'Open a documentation site first.';
    $('llms-retry').hidden = true;
    return reveal();
  }
  await runMain();
}

// The popup can't tell a toolbar click from the keyboard shortcut (MV3 has no
// signal for either), so popup_open carries no trigger.
track('popup_open');
let closed = false;
function onClose() {
  if (closed) return;
  closed = true;
  track('popup_close', { durationMs: Date.now() - openedAt });
  telemetry.flushOnClose();
}
globalThis.addEventListener?.('pagehide', () => {
  // Hidden may already have run onClose: send anything queued since.
  telemetry.flushOnClose();
  onClose();
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') onClose(); });

// Exported so tests can wait for the first run.
export const ready = main().catch(fail);
