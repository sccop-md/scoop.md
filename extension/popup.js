import { siteKey } from './lib/discover.js';
import { buildPackage, withCurrentPage } from './lib/package.js';
import { scoopPage, currentPageSection } from './lib/scoop.js';
import { DEFAULT_LIBRARY, createLibrary, shareBody, notSharedReason } from './lib/library.js';

const DEFAULTS = { libraryUrl: DEFAULT_LIBRARY, share: true };
const KIND = {
  'page-md': ['MD', 'Page Markdown'],
  'page-html': ['</>', 'Page, converted from HTML'],
  llms: ['TXT', 'llms.txt index'],
  'llms-full': ['ALL', 'llms-full.txt'],
};
const $ = (id) => document.getElementById(id);

let settings;
let library;
let tab;
let clipboardText = '';
let skillId = null;

function status(text, cls = 'ok') {
  $('status').textContent = text;
  $('status').className = cls;
}

function note(id, text, cls = '') {
  $(id).textContent = text;
  $(id).className = cls;
  $(id).hidden = !text;
}

function showSources(sections) {
  $('sources').replaceChildren(...sections.map((s) => {
    const [glyph, name] = KIND[s.kind] ?? ['DOC', s.kind];
    const li = document.createElement('li');
    const avatar = Object.assign(document.createElement('span'), { className: 'avatar', textContent: glyph });
    avatar.setAttribute('aria-hidden', 'true');
    const text = Object.assign(document.createElement('div'), { className: 'info' });
    const link = Object.assign(document.createElement('a'), {
      href: s.url, target: '_blank', rel: 'noreferrer',
      textContent: s.label.replace(/^This page: /, ''), title: s.url,
    });
    const size = s.content == null ? 'link only, too large to copy' : kb(s.content);
    text.append(link, Object.assign(document.createElement('span'), { className: 'meta', textContent: `${name} · ${size}` }));
    li.append(avatar, text);
    return li;
  }));
  $('sources').hidden = !sections.length;
  $('sources-title').hidden = !sections.length;
}

function showLibrary(site, shared, reachable) {
  $('lib-site').textContent = site;
  $('lib-link').href = `https://scoop.md/${encodeURIComponent(site)}`;
  if (!settings.libraryUrl) {
    $('lib-status').textContent = 'Library is off';
    $('lib-meta').textContent = 'Set a library URL in Settings to use shared scoops.';
  } else if (!reachable) {
    $('lib-status').textContent = 'Library unavailable';
    $('lib-meta').textContent = 'Your copy was built from this page instead.';
  } else if (shared) {
    $('lib-status').textContent = `Shared scoop worked for ${plural(shared.worked, 'person', 'people')}`;
    $('lib-meta').textContent = `${plural(shared.sections.length, 'source')}${shared.lastWorkedAt ? ` · last confirmed ${new Date(shared.lastWorkedAt).toLocaleDateString()}` : ''}`;
  } else {
    $('lib-status').textContent = 'No shared scoop yet';
    $('lib-meta').textContent = 'Yours becomes the first once your agent confirms it worked.';
  }
}

function selectTab(name) {
  for (const t of ['scoop', 'library']) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`panel-${t}`).hidden = t !== name;
  }
}

async function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function showFeedback(id) {
  skillId = id;
  $('feedback').hidden = !id;
  $('voted').hidden = true;
  $('report').hidden = true;
}

// The async clipboard API refuses unfocused documents (e.g. the user clicked
// away while we were scooping). execCommand works there because the extension
// has clipboardWrite. Returns whether the text reached the clipboard.
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = Object.assign(document.createElement('textarea'), { value: text });
    area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    area.remove();
    getSelection()?.removeAllRanges();
    return ok;
  }
}

async function copy(text) {
  clipboardText = text;
  $('actions').hidden = false;
  return writeClipboard(text);
}

function copied(ok) {
  if (ok) status('Copied. Paste it into your agent.');
  else status('Ready. Click Copy to put it on your clipboard.', 'err');
}

const kb = (text) => `${Math.max(1, Math.round(text.length / 1024))} KB`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function tabHtml() {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.documentElement.outerHTML,
    });
    return result;
  } catch {
    return null; // Pages like the Chrome Web Store can't be scripted.
  }
}

function scoopCurrentTab() {
  return scoopPage(tab.url, {
    title: tab.title,
    parseHtml: (html) => new DOMParser().parseFromString(html, 'text/html'),
    tabHtml,
  });
}

async function run({ skipLibrary = false } = {}) {
  status('Finding docs for this page…', 'busy');
  note('share', '');
  showFeedback(null);
  $('rebuild').hidden = true;
  const site = siteKey(tab.url);

  // Build locally while asking the library; the copy never waits on the
  // library for more than its short timeout.
  const local = scoopCurrentTab();
  local.catch(() => {});
  const best = skipLibrary ? null : await library.best(site);
  const shared = best?.ok ? best.data?.skill : null;
  if (!skipLibrary) showLibrary(site, shared, !!best?.ok);

  if (shared?.sections?.length) {
    const current = currentPageSection(await local.catch(() => null));
    const sections = withCurrentPage(shared.sections, current);
    const text = buildPackage({ site, pageUrl: tab.url, sections, relatedLinks: shared.relatedLinks ?? [] });
    const ok = await copy(text);
    showSources(sections);
    copied(ok);
    note('summary', `${kb(text)} from the shared library. Worked for ${plural(shared.worked, 'person', 'people')}` +
      `${shared.failed ? `, didn't for ${shared.failed}` : ''}.`);
    $('rebuild').hidden = false;
    showFeedback(shared.id);
    return;
  }

  const scoop = await local;
  if (!scoop.sections.length) throw new Error('Could not find any documentation text on this page.');
  const text = buildPackage({ site, pageUrl: scoop.pageUrl, sections: scoop.sections, relatedLinks: scoop.relatedLinks });
  const ok = await copy(text);
  showSources(scoop.sections);
  copied(ok);
  note('summary', `${kb(text)} from ${plural(scoop.sections.length, 'source')} on ${site}, built from this page.`);
  await share(scoop);
}

async function share(scoop) {
  if (!settings.libraryUrl) return;
  if (!settings.share) return note('share', 'Not shared: sharing is off in Settings.');
  if (!scoop.isPublic) return note('share', 'Not shared: this page only loads with your login, so it stays on your machine.');

  note('share', 'Sharing with the library…');
  const res = await library.share(shareBody(scoop));
  if (!res.ok) return note('share', `Not shared: ${notSharedReason(res.error, scoop.sections)}`, 'warn');
  note('share', res.data.duplicate ? 'Already in the library. Vote below once your agent is done.' : 'Shared with the library. Vote below once your agent is done.');
  showFeedback(res.data.id);
}

async function vote(worked) {
  const res = await library.feedback(skillId, worked);
  note('voted', res.ok
    ? `Thanks. So far it worked for ${plural(res.data.worked, 'person', 'people')} and didn't for ${res.data.failed}.`
    : "Couldn't record your vote. Try again in a moment.");
}

async function report(reason) {
  const res = await library.report(skillId, reason);
  $('report').hidden = true;
  note('voted', res.ok ? 'Reported. Thanks, we will review it.' : "Couldn't send the report. Try again in a moment.");
}

async function installId() {
  let { installId: id } = await chrome.storage.local.get('installId');
  if (!id) {
    id = crypto.randomUUID();
    await chrome.storage.local.set({ installId: id });
  }
  return id;
}

async function intro() {
  const { introSeen } = await chrome.storage.local.get('introSeen');
  if (introSeen || !settings.share || !settings.libraryUrl) return;
  $('intro').hidden = false;
  $('intro-ok').onclick = () => {
    $('intro').hidden = true;
    chrome.storage.local.set({ introSeen: true });
  };
}

const fail = (e) => status(e?.message || String(e), 'err');

$('tab-scoop').onclick = () => selectTab('scoop');
$('tab-library').onclick = () => selectTab('library');
$('theme').onclick = async () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = dark ? 'light' : 'dark';
  applyTheme(theme);
  try { await chrome.storage.local.set({ theme }); } catch {}
};
$('share-toggle').onchange = async (e) => {
  settings.share = e.target.checked;
  try { await chrome.storage.sync.set({ share: settings.share }); } catch {}
};
$('copy').onclick = async () => {
  if (!(await writeClipboard(clipboardText))) return status("Couldn't copy. Try again.", 'err');
  status('Copied again.');
};
$('rebuild').onclick = () => run({ skipLibrary: true }).catch(fail);
$('settings').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
for (const btn of document.querySelectorAll('#feedback button[data-worked]')) {
  btn.onclick = () => vote(btn.dataset.worked === 'true');
}
$('report-open').onclick = (e) => { e.preventDefault(); $('report').hidden = !$('report').hidden; };
$('report').onsubmit = (e) => { e.preventDefault(); return report($('reason').value); };

async function main() {
  settings = await chrome.storage.sync.get(DEFAULTS);
  try { applyTheme((await chrome.storage.local.get('theme')).theme); } catch {}
  $('share-toggle').checked = !!settings.share;
  // The prototype's default had no API version in the path.
  if (settings.libraryUrl === 'http://localhost:8787') settings.libraryUrl += '/v1';
  library = createLibrary({
    baseUrl: settings.libraryUrl,
    installId: await installId(),
    client: `extension/${chrome.runtime.getManifest().version}`,
  });
  await intro();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!/^https?:/.test(tab?.url || '')) return status('Open a documentation page first.', 'err');
  await run();
}

// Exported so tests can wait for the first run.
export const ready = main().catch(fail);
