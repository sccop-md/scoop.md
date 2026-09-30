import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT) || 8787;
const DATA = process.env.SCOOP_DATA || fileURLToPath(new URL('./data/skills.json', import.meta.url));

const store = await new Store(DATA).load();
createApp(store, {
  allowLocalhost: process.env.ALLOW_LOCALHOST === '1',
  adminToken: process.env.ADMIN_TOKEN || '',
}).listen(PORT, () => console.log(`scoop.md reference library on http://localhost:${PORT}/v1`));
