// Fallback for sites that publish nothing agent-ready: turn the page's HTML
// into Markdown. Browser-only (needs DOMParser / DOM nodes).

const DROP = 'script,style,noscript,svg,nav,header,footer,aside,form,iframe,button,[role=navigation],[aria-hidden=true],' +
  '.gutter,.line-numbers-rows,.linenos,.lineno'; // line-number gutters of code highlighters

export function pickMain(doc) {
  return (
    doc.querySelector('main article') ||
    doc.querySelector('article') ||
    doc.querySelector('main') ||
    doc.querySelector('[role=main]') ||
    doc.querySelector('.markdown, .theme-doc-markdown, .content, #content') ||
    doc.body
  );
}

export function htmlToMarkdown(root, baseUrl) {
  const clone = root.cloneNode(true);
  clone.querySelectorAll(DROP).forEach((n) => n.remove());
  const out = walk(clone, baseUrl);
  return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

function walk(node, baseUrl) {
  if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  const inner = () => Array.from(node.childNodes).map((c) => walk(c, baseUrl)).join('');

  if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(+tag[1])} ${inner().trim()}\n\n`;
  if (tag === 'pre') {
    const code = node.querySelector('code');
    const lang = (code?.className.match(/language-(\S+)/) || [])[1] || '';
    return `\n\n\`\`\`${lang}\n${codeText(node).replace(/\n$/, '')}\n\`\`\`\n\n`;
  }
  // Highlighters that lay code out as a table (code beside line numbers).
  if ((tag === 'table' || tag === 'tr') && node.querySelector('pre')) return inner();
  if (tag === 'code') return `\`${node.textContent}\``;
  if (tag === 'p' || tag === 'div' || tag === 'section') return `\n\n${inner().trim()}\n\n`;
  if (tag === 'br') return '\n';
  if (tag === 'li') return `\n- ${inner().trim()}`;
  if (tag === 'ul' || tag === 'ol') return `\n${inner()}\n`;
  if (tag === 'strong' || tag === 'b') return `**${inner()}**`;
  if (tag === 'em' || tag === 'i') return `*${inner()}*`;
  if (tag === 'a') {
    const href = node.getAttribute('href');
    const text = inner().trim();
    if (!href || href.startsWith('#') || !text) return text;
    try { return `[${text}](${new URL(href, baseUrl).href})`; } catch { return text; }
  }
  if (tag === 'tr') return `\n| ${Array.from(node.children).map((c) => walk(c, baseUrl).trim()).join(' | ')} |`;
  if (tag === 'table') return `\n\n${inner()}\n\n`;
  return inner();
}

// Some highlighters put each line in its own element with no newline between.
function codeText(pre) {
  const lines = pre.querySelectorAll('.line');
  return lines.length ? Array.from(lines, (l) => l.textContent).join('\n') : pre.textContent;
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
