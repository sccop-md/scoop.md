// Finds agent-ready documentation a site already publishes, without the site
// having to add anything for us. Every fetch omits credentials so whatever we
// find is public by construction and safe to share in the library.

export function siteKey(pageUrl) {
  return new URL(pageUrl).hostname.replace(/^www\./, '');
}

export function candidateUrls(pageUrl) {
  const u = new URL(pageUrl);
  const segs = u.pathname.split('/').filter(Boolean);
  const out = [];

  // Many docs platforms (Mintlify, Fern, GitBook, Docusaurus plugins) serve a
  // Markdown twin of each page at <path>.md.
  const hasExtension = /\.[a-z0-9]{1,5}$/i.test(u.pathname);
  if (segs.length && !hasExtension) {
    out.push({ kind: 'page-md', url: `${u.origin}/${segs.join('/')}.md` });
  }

  // llms.txt convention: at the origin root, or under a docs prefix like /docs.
  const bases = [u.origin];
  if (segs.length > 1) bases.push(`${u.origin}/${segs[0]}`);
  for (const base of bases) {
    out.push({ kind: 'llms-full', url: `${base}/llms-full.txt` });
    out.push({ kind: 'llms', url: `${base}/llms.txt` });
  }
  return out;
}

// SPA hosts often answer any path with 200 + their HTML shell, so status alone
// is not evidence the file exists.
export function looksLikeText(contentType, body) {
  if (/text\/html/i.test(contentType || '')) return false;
  if (/^\s*<(!doctype|html|head|body)/i.test(body)) return false;
  return body.trim().length > 50;
}

// Files beyond this are not downloaded; the agent gets the link instead.
export const MAX_FETCH_BYTES = 2_000_000;

// Returns { content } for usable text, { content: null, bytes } when the file
// exists but is too large to download (bytes is a lower bound when the server
// doesn't say), or null when there's nothing usable.
export async function fetchPublicText(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, { credentials: 'omit', redirect: 'follow' });
    if (!res.ok) return null;
    const type = res.headers.get('content-type');
    if (/text\/html/i.test(type || '')) return null;
    const declared = Number(res.headers.get('content-length')) || 0;
    if (declared > MAX_FETCH_BYTES) {
      await res.body?.cancel();
      return { content: null, bytes: declared };
    }
    const body = await readCapped(res);
    if (body === null) return { content: null, bytes: MAX_FETCH_BYTES };
    return looksLikeText(type, body) ? { content: body } : null;
  } catch {
    return null;
  }
}

// Many servers stream compressed responses without Content-Length, so stop
// reading once we pass the cap rather than trusting headers.
async function readCapped(res) {
  if (!res.body?.getReader) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > MAX_FETCH_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

// Returns the first hit for each kind: { 'page-md'?, 'llms-full'?, 'llms'? },
// each as { url, content, bytes? } (content is null when too large to fetch).
export async function discover(pageUrl, fetchImpl = fetch) {
  const candidates = candidateUrls(pageUrl);
  const bodies = await Promise.all(candidates.map((c) => fetchPublicText(c.url, fetchImpl)));
  const found = {};
  candidates.forEach((c, i) => {
    if (bodies[i] && !found[c.kind]) found[c.kind] = { url: c.url, ...bodies[i] };
  });
  return found;
}
