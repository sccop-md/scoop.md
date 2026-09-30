// Source verification (docs/BACKEND.md §6): every section must be what its URL
// serves to an anonymous visitor. This is what keeps injected instructions and
// private material out of the shared library.

export const FETCH_CAP = 2_000_000;
export const HTML_THRESHOLD = 0.85;
const SHINGLE = 5;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 10_000;

export class VerifyError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function normalizeSite(host) {
  return String(host || '').trim().toLowerCase().replace(/^www\./, '');
}

export function siteOf(url) {
  return normalizeSite(new URL(url).hostname);
}

// SSRF guard. Returns the parsed URL or throws 400 invalid_request.
export function assertFetchable(raw, { allowLocalhost = false } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw new VerifyError('invalid_request', `Not a URL: ${raw}`, 400); }
  const host = u.hostname.toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  if (allowLocalhost && isLocal) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new VerifyError('invalid_request', `Unsupported scheme: ${raw}`, 400);
    return u;
  }
  if (u.protocol !== 'https:') throw new VerifyError('invalid_request', `Only https URLs are accepted: ${raw}`, 400);
  if (u.port && u.port !== '443') throw new VerifyError('invalid_request', `Non-standard port: ${raw}`, 400);
  const ipLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':');
  if (ipLiteral || host === 'localhost' || /\.(local|internal|localhost|test)$/.test(host)) {
    throw new VerifyError('invalid_request', `Host not allowed: ${host}`, 400);
  }
  return u;
}

async function readCapped(res, cap) {
  if (!res.body?.getReader) {
    const text = await res.text();
    return { text: text.slice(0, cap), over: text.length > cap };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), over: false };
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return { text, over: true };
    }
    text += decoder.decode(value, { stream: true });
  }
}

// Anonymous fetch: no cookies, no auth, manual redirects so each hop is
// checked against the SSRF rules and the site.
export async function fetchSource(url, site, { fetchImpl = fetch, allowLocalhost = false } = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = assertFetchable(current, { allowLocalhost });
    if (siteOf(u.href) !== site) throw new VerifyError('site_mismatch', `${url} redirects off ${site} (to ${u.href})`);
    let res;
    try {
      res = await fetchImpl(u.href, {
        redirect: 'manual',
        credentials: 'omit',
        headers: { 'user-agent': 'scoop.md-verifier/1 (+https://scoop.md)' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new VerifyError('source_unreachable', `Could not fetch ${url}: ${e.message}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      current = new URL(res.headers.get('location'), u).href;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new VerifyError('source_unreachable', `${url} answered ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length')) || 0;
    const contentType = res.headers.get('content-type') || '';
    if (declared > FETCH_CAP) {
      await res.body?.cancel();
      return { contentType, text: '', over: true };
    }
    return { contentType, ...(await readCapped(res, FETCH_CAP)) };
  }
  throw new VerifyError('source_unreachable', `${url} redirects too many times`);
}

export function normalizeText(s) {
  return s.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

function isHtml(contentType, text) {
  return /text\/html/i.test(contentType) || /^\s*<(!doctype|html|head|body)/i.test(text);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

export function markdownToPlain(md) {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ');
}

export function words(text) {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function shingles(ws) {
  const out = [];
  for (let i = 0; i + SHINGLE <= ws.length; i++) out.push(ws.slice(i, i + SHINGLE).join(' '));
  return out;
}

// Share of the section's 5-word shingles that also occur in the page.
export function containment(sectionMarkdown, pageHtml) {
  const mine = shingles(words(markdownToPlain(sectionMarkdown)));
  if (!mine.length) return { ratio: 0, count: 0 };
  const theirs = new Set(shingles(words(htmlToText(pageHtml))));
  const hits = mine.filter((s) => theirs.has(s)).length;
  return { ratio: hits / mine.length, count: mine.length };
}

export async function verifySection(section, site, index, opts = {}) {
  const where = `Section ${index + 1} (${section.url})`;
  if (siteOf(section.url) !== site) throw new VerifyError('site_mismatch', `${where} is not on ${site}`);
  const src = await fetchSource(section.url, site, opts);

  if (section.kind === 'page-html') {
    if (src.over) throw new VerifyError('source_unreachable', `${where} is larger than ${FETCH_CAP} bytes`);
    if (!isHtml(src.contentType, src.text)) throw new VerifyError('source_mismatch', `${where} is not an HTML page`);
    const { ratio, count } = containment(section.content, src.text);
    const needed = count < 20 ? 1 : HTML_THRESHOLD;
    if (ratio < needed) {
      throw new VerifyError('source_mismatch', `${where} matches ${Math.round(ratio * 100)}% of the live page; ${Math.round(needed * 100)}% required`);
    }
    return;
  }

  if (isHtml(src.contentType, src.text)) throw new VerifyError('source_unreachable', `${where} serves HTML, not a text file`);

  if (section.content === null) {
    if (section.kind !== 'llms-full') throw new VerifyError('invalid_request', `${where}: only llms-full sections may omit content`, 400);
    if (!src.over) throw new VerifyError('source_mismatch', `${where} is small enough to include; send its content`);
    return;
  }
  if (src.over || normalizeText(src.text) !== normalizeText(section.content)) {
    throw new VerifyError('source_mismatch', `${where} does not match the live file`);
  }
}
