// Reference implementation of the api.scoop.md v1 contract (docs/BACKEND.md).
// Dependency-free Node; rate limiting is left to the production Worker.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { VerifyError, normalizeSite, siteOf, assertFetchable, verifySection } from './verify.js';
import { summary, publicSkill } from './store.js';

const MAX_BODY = 6_000_000;
const MAX_SECTION = 2_000_000;
const KINDS = new Set(['page-md', 'llms', 'llms-full', 'page-html']);
const REASONS = new Set(['malicious', 'wrong', 'copyright', 'other']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const fail = (code, message, status) => new VerifyError(code, message, status);
const bad = (message) => fail('invalid_request', message, 400);

function cors(req) {
  return {
    'access-control-allow-origin': req.headers.origin || '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, x-scoop-install, x-scoop-client, authorization',
    vary: 'origin',
  };
}

function send(req, res, status, body, cache) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...cors(req),
    ...(cache ? { 'cache-control': 'public, max-age=30, s-maxage=60' } : {}),
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw fail('too_large', 'Request body is over 6 MB', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw bad('Body is not valid JSON');
  }
}

function installId(req) {
  const id = req.headers['x-scoop-install'];
  if (!id || !UUID.test(id)) throw bad('X-Scoop-Install must be a UUID v4');
  return id;
}

function str(v, name, max, { optional = false } = {}) {
  if (optional && (v === undefined || v === null)) return undefined;
  if (typeof v !== 'string' || !v.length || v.length > max) throw bad(`${name} must be a string of 1–${max} characters`);
  return v;
}

function validateSkill(body, allowLocalhost) {
  const site = normalizeSite(str(body.site, 'site', 253));
  const pageUrl = str(body.pageUrl, 'pageUrl', 2048);
  assertFetchable(pageUrl, { allowLocalhost });
  if (siteOf(pageUrl) !== site) throw fail('site_mismatch', `pageUrl is not on ${site}`);
  const title = body.title === undefined ? '' : String(body.title).slice(0, 300);

  if (!Array.isArray(body.sections) || body.sections.length < 1 || body.sections.length > 6) throw bad('sections must have 1–6 items');
  const sections = body.sections.map((s, i) => {
    if (!s || !KINDS.has(s.kind)) throw bad(`sections[${i}].kind is invalid`);
    const url = str(s.url, `sections[${i}].url`, 2048);
    assertFetchable(url, { allowLocalhost });
    const content = s.content ?? null;
    if (content !== null && typeof content !== 'string') throw bad(`sections[${i}].content must be a string or null`);
    if (content !== null && content.length > MAX_SECTION) throw fail('too_large', `sections[${i}].content is over ${MAX_SECTION} characters`, 413);
    if (content === null && !(Number.isInteger(s.bytes) && s.bytes > 0)) throw bad(`sections[${i}].bytes is required when content is null`);
    return { kind: s.kind, label: str(s.label, `sections[${i}].label`, 200), url, content, bytes: content === null ? s.bytes : null };
  });

  const links = body.relatedLinks ?? [];
  if (!Array.isArray(links) || links.length > 100) throw bad('relatedLinks must have at most 100 items');
  const relatedLinks = links.map((l, i) => {
    const url = str(l?.url, `relatedLinks[${i}].url`, 2048);
    let u;
    try { u = new URL(url); } catch { throw bad(`relatedLinks[${i}].url is not a URL`); }
    if (!/^https?:$/.test(u.protocol)) throw bad(`relatedLinks[${i}].url must be http(s)`);
    if (siteOf(url) !== site) throw fail('site_mismatch', `relatedLinks[${i}] is not on ${site}`);
    return { url, text: String(l.text ?? '').slice(0, 120) };
  });

  return { site, pageUrl, title, sections, relatedLinks };
}

function adminOk(req, token) {
  if (!token) return false;
  const given = Buffer.from(String(req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${token}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function createApp(store, { allowLocalhost = false, adminToken = '', fetchImpl = fetch, version = '0.2.0' } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const m = (re) => path.match(re);
    try {
      if (req.method === 'OPTIONS') return send(req, res, 204);

      if (req.method === 'GET' && path === '/v1/health') return send(req, res, 200, { ok: true, version });

      if (req.method === 'GET' && path === '/v1/skills/best') {
        const skill = store.best(normalizeSite(url.searchParams.get('site')));
        return send(req, res, 200, { skill: skill && publicSkill(skill) }, true);
      }

      let hit;
      if (req.method === 'GET' && (hit = m(/^\/v1\/skills\/([\w-]+)$/))) {
        const skill = store.get(hit[1]);
        if (!skill) throw fail('not_found', 'No such skill', 404);
        if (skill.removedAt) throw fail('removed', 'This skill was removed', 410);
        return send(req, res, 200, { skill: publicSkill(skill) });
      }

      if (req.method === 'POST' && path === '/v1/skills') {
        const install = installId(req);
        const skill = validateSkill(await readJson(req), allowLocalhost);
        await Promise.all(skill.sections.map((s, i) => verifySection(s, skill.site, i, { fetchImpl, allowLocalhost })));
        const { skill: saved, duplicate } = await store.add({ ...skill, installId: install });
        return send(req, res, duplicate ? 200 : 201, { id: saved.id, status: 'verified', duplicate });
      }

      if (req.method === 'POST' && (hit = m(/^\/v1\/skills\/([\w-]+)\/feedback$/))) {
        const install = installId(req);
        const { worked } = await readJson(req);
        if (typeof worked !== 'boolean') throw bad('worked must be true or false');
        const skill = store.get(hit[1]);
        if (!skill) throw fail('not_found', 'No such skill', 404);
        if (skill.removedAt) throw fail('removed', 'This skill was removed', 410);
        await store.vote(skill, install, worked);
        return send(req, res, 200, { worked: skill.worked, failed: skill.failed });
      }

      if (req.method === 'GET' && path === '/v1/sites') {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        const offset = Number(url.searchParams.get('cursor')) || 0;
        const all = store.sites();
        const page = all.slice(offset, offset + limit).map(({ site, best }) => ({ site, best: summary(best) }));
        const next = offset + limit < all.length ? String(offset + limit) : null;
        return send(req, res, 200, { sites: page, next }, true);
      }

      if (req.method === 'GET' && (hit = m(/^\/v1\/sites\/([^/]+)$/))) {
        const site = normalizeSite(decodeURIComponent(hit[1]));
        if (!store.hasSite(site)) throw fail('not_found', 'No skills for this site', 404);
        const b = store.best(site);
        return send(req, res, 200, { site, best: b && summary(b), recent: store.recent(site).map(summary) }, true);
      }

      if (req.method === 'POST' && path === '/v1/reports') {
        const install = installId(req);
        const body = await readJson(req);
        if (!REASONS.has(body.reason)) throw bad('reason must be malicious, wrong, copyright or other');
        if (body.details !== undefined && (typeof body.details !== 'string' || body.details.length > 2000)) throw bad('details must be at most 2000 characters');
        if (!store.get(body.skillId)) throw fail('not_found', 'No such skill', 404);
        await store.report({ skillId: body.skillId, installId: install, reason: body.reason, details: body.details });
        return send(req, res, 202, { ok: true });
      }

      if (path.startsWith('/v1/admin/')) {
        if (!adminOk(req, adminToken)) throw fail('not_found', 'Not found', 404);
        if (req.method === 'DELETE' && (hit = m(/^\/v1\/admin\/skills\/([\w-]+)$/))) {
          const skill = store.get(hit[1]);
          if (!skill) throw fail('not_found', 'No such skill', 404);
          await store.remove(skill);
          return send(req, res, 200, { ok: true });
        }
        if (req.method === 'GET' && path === '/v1/admin/reports') {
          return send(req, res, 200, { reports: store.reports.filter((r) => !r.resolvedAt).reverse() });
        }
      }

      throw fail('not_found', 'Not found', 404);
    } catch (e) {
      if (e instanceof VerifyError) return send(req, res, e.status, { error: { code: e.code, message: e.message } });
      console.error(e);
      return send(req, res, 500, { error: { code: 'internal', message: 'Internal error' } });
    }
  });
}
