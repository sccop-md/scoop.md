// Runs the discovery step against real docs sites to see what each one
// publishes. Usage: npm run probe -- <url> [<url>...]

import { discover } from '../extension/lib/discover.js';

const urls = process.argv.slice(2);
if (!urls.length) {
  console.error('Usage: npm run probe -- <url> [<url>...]');
  process.exit(1);
}

for (const url of urls) {
  const found = await discover(url);
  const kinds = Object.entries(found).map(([k, v]) => v.content ? `${k} (${Math.round(v.content.length / 1024)} KB) ${v.url}` : `${k} (over ${Math.round(v.bytes / 1_048_576)} MB, link only) ${v.url}`);
  console.log(`\n${url}\n  ${kinds.length ? kinds.join('\n  ') : 'nothing agent-ready; will fall back to page extraction'}`);
}
