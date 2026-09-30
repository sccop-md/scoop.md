// Fallback for sites that publish nothing agent-ready: turn the page's HTML
// into Markdown. Needs a DOM (the browser's DOMParser, or linkedom in tests).
//
// The output is checked by the library against the live page (server/verify.js
// `containment`), so everything emitted here must be text the page contains:
// no invented labels, and nothing from attributes except link targets.

const DROP = 'script,style,noscript,template,svg,nav,header,footer,aside,form,iframe,button,dialog,select,' +
  '[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true],' +
  // line-number gutters of code highlighters
  '.gutter,.linenos,.lineno,.line-numbers-rows,.line-number,.hljs-ln-numbers,.react-syntax-highlighter-line-number';

// Per-line code highlighters (Shiki, SyntaxHighlighter, Prism/Docusaurus, CodeMirror).
const LINE = '.line,.token-line,.cm-line,[data-line]';

const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'figure', 'figcaption', 'details', 'summary', 'dl', 'dt', 'dd', 'center']);

// A <header> that holds the page title is content, not site chrome.
function dropped(el) {
  if (!el.matches(DROP)) return false;
  return !(el.tagName.toLowerCase() === 'header' && el.querySelector('h1'));
}

// Text an element contributes, ignoring dropped chrome and link text (nav
// menus are mostly links; prose is mostly not).
function weight(el) {
  let n = 0;
  for (const c of el.childNodes) {
    if (c.nodeType === 3) n += c.textContent.replace(/\s+/g, ' ').trim().length;
    else if (c.nodeType === 1 && !dropped(c) && c.tagName.toLowerCase() !== 'a') n += weight(c);
  }
  return n;
}

function titleHeading(root) {
  for (const h of root.querySelectorAll('h1')) {
    if (!h.closest('nav,aside,footer,[role=navigation]') && h.textContent.trim()) return h;
  }
  return null;
}

// The main content: a semantic container when the page has one, then narrowed
// (or found, when there is none) by walking up from the page title to the
// smallest element holding most of the prose. That leaves out top bars and
// sidebars even on sites built from anonymous <div>s.
export function pickMain(doc) {
  const root =
    doc.querySelector('main article') ||
    doc.querySelector('article') ||
    doc.querySelector('main') ||
    doc.querySelector('[role=main]') ||
    doc.querySelector('.markdown, .theme-doc-markdown, #content') ||
    doc.body;
  const h1 = titleHeading(root);
  if (!h1) return root;
  const total = weight(root);
  for (let el = h1.parentElement; el && el !== root; el = el.parentElement) {
    if (weight(el) >= total * 0.6) return el;
  }
  return root;
}

export function htmlToMarkdown(root, baseUrl) {
  const clone = root.cloneNode(true);
  for (const n of Array.from(clone.querySelectorAll(DROP))) if (dropped(n)) n.remove();
  const out = walk(clone, baseUrl);
  return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

function walk(node, baseUrl) {
  if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  const inner = () => Array.from(node.childNodes).map((c) => walk(c, baseUrl)).join('');

  if (/^h[1-6]$/.test(tag)) {
    // Drop permalink markers ("#", "¶") that many doc generators append.
    const text = inner().replace(/\s+/g, ' ').trim().replace(/\s*[#¶§]$/u, '');
    return text ? `\n\n${'#'.repeat(+tag[1])} ${text}\n\n` : '';
  }
  if (tag === 'pre') {
    const code = node.querySelector('code');
    const lang = ((code?.className || node.className || '').match(/(?:language|lang)-([\w+#-]+)/) || [])[1] || '';
    return `\n\n\`\`\`${lang}\n${codeText(node).replace(/\n+$/, '')}\n\`\`\`\n\n`;
  }
  // Highlighters that lay code out as a table (code beside line numbers).
  if ((tag === 'table' || tag === 'tbody' || tag === 'tr' || tag === 'td') && node.querySelector('pre')) return inner();
  if (tag === 'table') return `\n\n${table(node, baseUrl)}\n\n`;
  if (tag === 'code') return `\`${node.textContent}\``;
  if (tag === 'br') return '\n';
  if (tag === 'hr') return '\n\n---\n\n';
  if (tag === 'li') return `\n- ${inner().trim().replace(/\n{2,}(?=- )/g, '\n').replace(/\n/g, '\n  ')}`;
  if (tag === 'ul' || tag === 'ol') return `\n${inner()}\n`;
  if (tag === 'blockquote') return `\n\n${inner().trim().replace(/^/gm, '> ')}\n\n`;
  if (BLOCK.has(tag)) return `\n\n${inner().trim()}\n\n`;
  if (tag === 'strong' || tag === 'b') return wrap('**', inner());
  if (tag === 'em' || tag === 'i') return wrap('*', inner());
  if (tag === 'a') {
    const href = node.getAttribute('href');
    const text = inner().trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || !text || /\n/.test(text)) return inner();
    try { return `[${text}](${new URL(href, baseUrl).href})`; } catch { return text; }
  }
  return inner();
}

// Keeps the spaces outside the markers: "**Note: **x" is not bold in Markdown.
function wrap(mark, s) {
  const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : s;
}

function table(node, baseUrl) {
  const rows = Array.from(node.querySelectorAll('tr')).filter((tr) => tr.closest('table') === node);
  if (!rows.length) return '';
  const cell = (c) => walk(c, baseUrl).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
  const lines = rows.map((tr) => `| ${Array.from(tr.children, cell).join(' | ')} |`);
  const cols = rows[0].children.length;
  lines.splice(1, 0, `|${' --- |'.repeat(cols)}`);
  return lines.join('\n');
}

// Some highlighters put each line in its own element with no newline between,
// or end lines with <br>.
function codeText(pre) {
  const lines = Array.from(pre.querySelectorAll(LINE)).filter((l) => !l.parentElement.closest(LINE));
  if (lines.length) return lines.map((l) => plain(l).replace(/\n$/, '')).join('\n');
  return plain(pre);
}

function plain(el) {
  let s = '';
  for (const c of el.childNodes) {
    if (c.nodeType === 3) s += c.textContent;
    else if (c.nodeType === 1 && c.tagName.toLowerCase() === 'br') s += '\n';
    else if (c.nodeType === 1) s += plain(c);
  }
  return s;
}

// Links in the site's navigation that stay within the same docs section, so the
// agent knows what else exists without us crawling it all up front.
export function relatedLinks(doc, pageUrl, limit = 60) {
  const page = new URL(pageUrl);
  const prefix = '/' + (page.pathname.split('/').filter(Boolean)[0] || '');
  const seen = new Set([page.origin + page.pathname]);
  const links = [];
  for (const a of doc.querySelectorAll('nav a[href], aside a[href], [role=navigation] a[href]')) {
    let u;
    try { u = new URL(a.getAttribute('href'), pageUrl); } catch { continue; }
    const key = u.origin + u.pathname;
    if (u.origin !== page.origin || !u.pathname.startsWith(prefix) || seen.has(key)) continue;
    seen.add(key);
    links.push({ url: key, text: a.textContent.trim().replace(/\s+/g, ' ').slice(0, 80) });
    if (links.length >= limit) break;
  }
  return links;
}
