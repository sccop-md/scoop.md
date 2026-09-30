import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store, MAX_CONTENT } from './store.js';

const PORT = Number(process.env.PORT) || 8787;
const DATA = process.env.SCOOP_DATA || fileURLToPath(new URL('./data/skills.json', import.meta.url));

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_CONTENT * 2) throw new Error('body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function createApp(store) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'OPTIONS') return send(res, 204);

      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true });

      if (req.method === 'GET' && url.pathname === '/api/skills/best') {
        return send(res, 200, { skill: store.best(url.searchParams.get('site') || '') });
      }

      if (req.method === 'POST' && url.pathname === '/api/skills') {
        const skill = await store.add(await readJson(req));
        return send(res, 201, { id: skill.id });
      }

      const fb = url.pathname.match(/^\/api\/skills\/([\w-]+)\/feedback$/);
      if (req.method === 'POST' && fb) {
        const { worked } = await readJson(req);
        const skill = await store.feedback(fb[1], worked === true);
        return skill ? send(res, 200, { worked: skill.worked, failed: skill.failed }) : send(res, 404, { error: 'not found' });
      }

      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = await new Store(DATA).load();
  createApp(store).listen(PORT, () => console.log(`scoop.md library on http://localhost:${PORT}`));
}
