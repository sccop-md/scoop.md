// Zips extension/ for the Chrome Web Store: dist/scoop.md-extension-<version>.zip.
// Leaves out tests, docs (STORE.md) and OS litter.

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(`${root}extension/manifest.json`, 'utf8'));
const out = `${root}dist/scoop.md-extension-${version}.zip`;

mkdirSync(`${root}dist`, { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', out, '.', '-x', '*.test.js', '*.md', '.DS_Store', '*/.DS_Store'], { cwd: `${root}extension`, stdio: ['ignore', 'ignore', 'inherit'] });
console.log(execFileSync('unzip', ['-l', out], { encoding: 'utf8' }));
console.log(`Wrote ${out}`);
