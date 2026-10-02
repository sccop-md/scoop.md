// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

// Landing, privacy and terms are prerendered; /library and /[site] render on
// demand in a Vercel Function (they opt out with `export const prerender = false`).
export default defineConfig({
  site: 'https://scoop.md',
  // privacy.html rather than privacy/index.html, so /privacy is served as-is
  // instead of redirecting to /privacy/.
  build: { format: 'file' },
  adapter: vercel(),
});
