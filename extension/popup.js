import { siteKey, discover } from './lib/discover.js';
import { buildPackage, withCurrentPage } from './lib/package.js';
import { pickMain, htmlToMarkdown, relatedLinks } from './lib/extract.js';

const DEFAULTS = { libraryUrl: 'http://localhost:8787', share: true };
const $ = (id) => document.getElementById(id);

let settings;
let tab;
let clipboardText = '';
let skillId = null;

function status(text, cls = '') {
  $('status').textContent = text;
  $('status').className = cls;
}

function showSources(sources) {
  $('sources').replaceChildren(...sources.map((s) => {
    const li = document.createElement('li');
    li.textContent = `${s.label}: ${s.url}`;
    return li;
  }));
  $('sources').hidden = !sources.length;
}

async function copy(text) {
  clipboardText = text;
  await navigator.clipboard.writeText(text);
  $('actions').hidden = false;
}

async function library(path, init) {
  if (!settings.libraryUrl) return null;
  try {
    const res = await fetch(settings.libraryUrl.replace(/\/$/, '') + path, {
      ...init,
      headers: { 'content-type': 'application/json' },
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null; // Library unreachable: the button still works locally.
  }
}

// The page itself as Markdown. Prefer a credential-less fetch so the result is
// shareable; fall back to the live tab (may include signed-in content, so it
// is never shared).
async function currentPage() {
  const html = await fetchPublicHtml(tab.url);
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const md = htmlToMarkdown(pickMain(doc), tab.url);
    if (md.length > 200) return { doc, md, isPublic: true };
  }
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => document.documentElement.outerHTML,
  });
  const doc = new DOMParser().parseFromString(result, 'text/html');
  return { doc, md: htmlToMarkdown(pickMain(doc), tab.url), isPublic: false };
}

async function fetchPublicHtml(url) {
  try {
    const res = await fetch(url, { credentials: 'omit' });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

async function build() {
  const site = siteKey(tab.url);
  const found = await discover(tab.url);
  const sections = [];
  let isPublic = true;
  let links = [];

  if (found['page-md']?.content) {
    sections.push({ label: `This page: ${tab.title}`, ...found['page-md'] });
  } else {
    const page = await currentPage();
    isPublic = page.isPublic;
    links = relatedLinks(page.doc, tab.url);
    if (page.md) sections.push({ label: `This page: ${tab.title}`, url: tab.url, content: page.md });
  }
  if (found['llms']?.content) sections.push({ label: 'Site documentation index (llms.txt)', ...found['llms'] });
  const full = found['llms-full'];
  if (full) {
    sections.push({
      label: 'Full documentation (llms-full.txt)',
      url: full.url,
      content: full.content ??
        `The complete documentation is available as one large file (over ${Math.round(full.bytes / 1_048_576)} MB), ` +
        `too large to include here. Fetch ${full.url} and search it when the sections above are not enough.`,
    });
  }

  if (!sections.length) throw new Error('Could not find any documentation text on this page.');

  const content = buildPackage({ site, pageUrl: tab.url, sections, relatedLinks: links });
  return { site, sections, content, isPublic };
}

async function run({ skipLibrary = false } = {}) {
  status('Finding docs for this page…');
  skillId = null;
  const site = siteKey(tab.url);

  if (!skipLibrary) {
    const shared = await library(`/api/skills/best?site=${encodeURIComponent(site)}`);
    if (shared?.skill) {
      const pageMd = (await discover(tab.url))['page-md'];
      const extra = pageMd?.content && { label: `This page: ${tab.title}`, ...pageMd };
      await copy(withCurrentPage(shared.skill.content, extra));
      skillId = shared.skill.id;
      showSources(shared.skill.sources);
      status(`Copied the shared ${site} skill (worked ${shared.skill.worked}×). Paste it into your agent.`, 'ok');
      $('rebuild').hidden = false;
      $('feedback').hidden = false;
      return;
    }
  }

  const pkg = await build();
  await copy(pkg.content);
  showSources(pkg.sections);
  const kb = Math.round(pkg.content.length / 1024);
  status(`Copied ${kb} KB of ${site} docs. Paste it into your agent.`, 'ok');

  if (pkg.isPublic && settings.share) {
    const saved = await library('/api/skills', {
      method: 'POST',
      body: JSON.stringify({
        site,
        sources: pkg.sections.map(({ label, url }) => ({ label, url })),
        content: pkg.content,
      }),
    });
    skillId = saved?.id ?? null;
  }
  $('feedback').hidden = !skillId;
}

$('copy').onclick = async () => {
  await navigator.clipboard.writeText(clipboardText);
  status('Copied again.', 'ok');
};
$('rebuild').onclick = () => run({ skipLibrary: true }).catch((e) => status(e.message, 'err'));
$('settings').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
for (const btn of document.querySelectorAll('#feedback button')) {
  btn.onclick = async () => {
    await library(`/api/skills/${skillId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ worked: btn.dataset.worked === 'true' }),
    });
    $('feedback').replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Thanks, noted.' }));
  };
}

(async () => {
  settings = await chrome.storage.sync.get(DEFAULTS);
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!/^https?:/.test(tab?.url || '')) return status('Open a documentation page first.', 'err');
  await run();
})().catch((e) => status(e.message, 'err'));
