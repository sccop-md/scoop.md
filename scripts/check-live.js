// Scoops real docs pages with the extension's own code (lib/scoop.js) and checks
// every section the way the library would before accepting a share
// (server/verify.js). Needs the network; not part of npm test.
// Usage: node scripts/check-live.js [<url>...]

import { DOMParser } from 'linkedom';
import { scoopPage } from '../extension/lib/scoop.js';
import { verifySection, fetchSource, containment, HTML_THRESHOLD } from '../server/verify.js';

const URLS = [
  'https://api.jquery.com/jQuery.ajax/',
  'https://tailwindcss.com/docs/installation/using-vite',
  'https://react.dev/reference/react/useState',
  'https://docs.stripe.com/webhooks',
];

const parseHtml = (html) => new DOMParser().parseFromString(html, 'text/html');
const size = (s) => (s.content == null ? `link only, over ${Math.round(s.bytes / 1_048_576)} MB` : `${Math.round(s.content.length / 1024)} KB`);

let failed = 0;
for (const url of process.argv.slice(2).length ? process.argv.slice(2) : URLS) {
  console.log(`\n${url}`);
  const scoop = await scoopPage(url, { parseHtml });
  if (!scoop.sections.length) {
    console.log('  FAIL no sections');
    failed++;
    continue;
  }
  for (const [i, s] of scoop.sections.entries()) {
    let detail = '';
    if (s.kind === 'page-html') {
      const { text } = await fetchSource(s.url, scoop.site);
      const { ratio, count } = containment(s.content, text);
      detail = `, containment ${(ratio * 100).toFixed(1)}% of ${count} shingles (needs ${count < 20 ? 100 : HTML_THRESHOLD * 100}%)`;
    }
    try {
      await verifySection(s, scoop.site, i);
      console.log(`  ok   ${s.kind.padEnd(9)} ${s.url} (${size(s)}${detail})`);
    } catch (e) {
      console.log(`  FAIL ${s.kind.padEnd(9)} ${s.url} (${size(s)}${detail}): ${e.code} ${e.message}`);
      failed++;
    }
  }
  console.log(`  ${scoop.relatedLinks.length} related links, shareable: ${scoop.isPublic}`);
}

console.log(failed ? `\n${failed} section(s) failed` : '\nAll sections verified.');
process.exit(failed ? 1 : 0);
