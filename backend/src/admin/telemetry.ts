// The admin console's Telemetry endpoints (admin.scoop.md/api/telemetry/*),
// behind the same Basic auth and same-origin check as the rest (app.ts).
// Reads are in src/telemetry/queries.ts; the export streams a file
// (Content-Disposition: attachment) from a same-origin GET.

import { json } from '../api/http.ts';
import { bad, notFound } from '../lib/errors.ts';
import { normalizeSite } from '../lib/ssrf.ts';
import type { Env } from '../env.ts';
import { MAX_ARCHIVE_DAYS, readArchive } from '../telemetry/archive.ts';
import * as t from '../telemetry/queries.ts';

interface Ctx {
  req: Request;
  env: Env;
  url: URL;
  params: string[];
}

const PAGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const days = (url: URL, fallback = 30, max = 365) => Math.min(max, Math.max(1, Math.trunc(Number(url.searchParams.get('days'))) || fallback));

function installArg(raw: string): string {
  const id = raw.toLowerCase();
  if (!UUID.test(id)) throw bad('Invalid install ID');
  return id;
}

function siteArg(raw: string): string {
  let site: string;
  try { site = normalizeSite(decodeURIComponent(raw)); } catch { throw bad('Invalid site'); }
  if (!/^[a-z0-9.-]{1,253}$/.test(site)) throw bad('Invalid site');
  return site;
}

function range(url: URL, maxDays: number): { from: string; to: string } {
  const now = new Date();
  const from = url.searchParams.get('from') || t.dayOf(now, 29);
  const to = url.searchParams.get('to') || t.dayOf(now);
  if (!DAY.test(from) || !DAY.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw bad('from and to must be YYYY-MM-DD');
  if (from > to) throw bad('from is after to');
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 >= maxDays) throw bad(`At most ${maxDays} days at a time`);
  return { from, to };
}

export const telemetryRoutes: { method: string; pattern: RegExp; handler: (c: Ctx) => Promise<Response> }[] = [
  { method: 'GET', pattern: /^\/api\/telemetry\/overview$/, handler: async ({ env, url }) => json(200, await t.overview(env.TELEMETRY_DB, days(url))) },
  { method: 'GET', pattern: /^\/api\/telemetry\/live$/, handler: async ({ env }) => json(200, await t.live(env.TELEMETRY_DB)) },
  { method: 'GET', pattern: /^\/api\/telemetry\/sites$/, handler: async ({ env, url }) => json(200, { days: days(url), rawFrom: t.dayOf(new Date(), Math.min(days(url), t.RAW_DAYS) - 1), sites: await t.topSites(env.TELEMETRY_DB, days(url)) }) },
  {
    method: 'GET',
    pattern: /^\/api\/telemetry\/sites\/([^/]+)$/,
    handler: async ({ env, url, params }) => json(200, await t.siteDetail(env.TELEMETRY_DB, siteArg(params[0]), days(url))),
  },
  {
    method: 'GET',
    pattern: /^\/api\/telemetry\/installs$/,
    handler: async ({ env, url }) => {
      const offset = Math.max(0, Math.trunc(Number(url.searchParams.get('cursor'))) || 0);
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      if (q && !/^[0-9a-f-]{1,36}$/.test(q)) throw bad('q is the start of an install ID');
      const { rows, more } = await t.listInstalls(env.TELEMETRY_DB, { status: url.searchParams.get('status') ?? undefined, q: q || undefined, limit: PAGE, offset });
      return json(200, { installs: rows, next: more ? String(offset + PAGE) : null });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/telemetry\/installs\/([^/]+)$/,
    handler: async ({ env, params }) => {
      const d = await t.installDetail(env.TELEMETRY_DB, installArg(params[0]));
      if (!d.install && !d.timeline.length) throw notFound('No telemetry for this install ID');
      return json(200, d);
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/telemetry\/installs\/([^/]+)$/,
    // A deletion request (privacy policy): D1 rows go, the consumer refuses the ID from now on, R2 gets a tombstone.
    handler: async ({ env, params }) => json(200, await t.deleteInstall(env.TELEMETRY_DB, env.TELEMETRY, installArg(params[0]))),
  },
  { method: 'GET', pattern: /^\/api\/telemetry\/deletions$/, handler: async ({ env }) => json(200, { deletions: await t.deletions(env.TELEMETRY_DB) }) },
  {
    method: 'GET',
    pattern: /^\/api\/telemetry\/retention$/,
    handler: async ({ env, url }) => json(200, await t.retention(env.TELEMETRY_DB, Math.min(26, Math.max(1, Math.trunc(Number(url.searchParams.get('weeks'))) || 12)))),
  },
  { method: 'GET', pattern: /^\/api\/telemetry\/platforms$/, handler: async ({ env, url }) => json(200, await t.platforms(env.TELEMETRY_DB, days(url))) },
  { method: 'GET', pattern: /^\/api\/telemetry\/geo$/, handler: async ({ env, url }) => json(200, await t.geography(env.TELEMETRY_DB, days(url))) },
  { method: 'GET', pattern: /^\/api\/telemetry\/errors$/, handler: async ({ env, url }) => json(200, await t.errors(env.TELEMETRY_DB, days(url))) },
  { method: 'GET', pattern: /^\/api\/telemetry\/api$/, handler: async ({ env, url }) => json(200, await t.apiUsage(env.TELEMETRY_DB, days(url))) },
  { method: 'GET', pattern: /^\/api\/telemetry\/website$/, handler: async ({ env, url }) => json(200, await t.website(env.TELEMETRY_DB, days(url))) },
  {
    method: 'GET',
    pattern: /^\/api\/telemetry\/export$/,
    // ?table=events|installs|install_days|events_daily|archive&from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv|ndjson
    handler: async ({ env, url }) => {
      const table = url.searchParams.get('table') ?? '';
      const format = url.searchParams.get('format') === 'ndjson' || table === 'archive' ? 'ndjson' : 'csv';
      if (table !== 'archive' && !t.EXPORT_TABLES[table]) throw bad(`table must be one of ${[...Object.keys(t.EXPORT_TABLES), 'archive'].join(', ')}`);
      const { from, to } = range(url, table === 'archive' ? MAX_ARCHIVE_DAYS : 366);
      const body = table === 'archive' ? readArchive(env.TELEMETRY, from, to, env.TELEMETRY_DB) : t.exportTable(env.TELEMETRY_DB, table, from, to, format);
      return new Response(body, {
        headers: {
          'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
          'content-disposition': `attachment; filename="scoop-telemetry-${table}-${from}-to-${to}.${format}"`,
        },
      });
    },
  },
];
