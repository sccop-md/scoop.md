// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// Landing, privacy and terms are prerendered; /library and /[site] render on
// demand (they opt out with `export const prerender = false`).
export default defineConfig({
  site: 'https://scoop.md',
  // privacy.html rather than privacy/index.html, so /privacy is served as-is
  // instead of redirecting to /privacy/.
  build: { format: 'file' },
  adapter: cloudflare({ imageService: 'passthrough' }),
  // No sessions, so the adapter doesn't ask for a KV binding.
  session: false,
});
