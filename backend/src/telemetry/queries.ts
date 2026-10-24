// D1 reads behind the admin console's Telemetry section (src/admin/telemetry.ts),
// plus the export and the per-install deletion. Every list is bounded by a
// LIMIT; time windows are UTC days.

import { TOMBSTONE_PREFIX, writeTombstone } from './archive.ts';

const DAY_MS = 86_400_000;
export const dayOf = (now: Date, back = 0) => new Date(now.getTime() - back * DAY_MS).toISOString().slice(0, 10);
const num = (v: unknown) => Number(v ?? 0);

// Raw events are pruned after 180 days: figures read from `events` cover at
// most that, whatever the window (the UI says so). Rollups cover the window.
export const RAW_DAYS = 180;
const rawFrom = (now: Date, since: string) => (since > dayOf(now, RAW_DAYS - 1) ? since : dayOf(now, RAW_DAYS - 1));

type Row = Record<string, unknown>;

async function all<T = Row>(db: D1Database, sql: string, ...params: (string | number | null)[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...params).all<T>()).results;
}

async function first<T = Row>(db: D1Database, sql: string, ...params: (string | number | null)[]): Promise<T> {
  return ((await db.prepare(sql).bind(...params).first<T>()) ?? {}) as T;
}

const SCOOP_OK = `name = 'scoop_result' AND outcome = 'copied_ready'`;

export async function overview(db: D1Database, days: number, now = new Date(Date.now())) {
  const since = dayOf(now, days - 1);
  const today = dayOf(now);
  const [installs, uninstalls, dau, totals, active, funnel, funnelInstalls, library, shares, sizes] = await Promise.all([
    // New installs by their install event (not first contact: existing users updating to 0.3.0 aren't new).
    all(db, `SELECT substr(installed_at, 1, 10) AS day, COUNT(*) AS n FROM installs WHERE installed_at >= ? GROUP BY day ORDER BY day`, since),
    all(db, `SELECT substr(uninstalled_at, 1, 10) AS day, SUM(known) AS n, SUM(known = 0) AS unknown FROM uninstalls WHERE uninstalled_at >= ? GROUP BY day ORDER BY day`, since),
    all(db, `SELECT day, COUNT(*) AS n FROM install_days WHERE day >= ? GROUP BY day ORDER BY day`, since),
    first(db, `SELECT COUNT(*) AS installs, COUNT(installed_at) AS installed, COUNT(uninstalled_at) AS uninstalled, SUM(opted_out) AS opted_out,
      (SELECT COUNT(*) FROM uninstalls WHERE known = 0) AS unknown_uninstalls FROM installs`),
    first(db, `SELECT
        (SELECT COUNT(*) FROM install_days WHERE day = ?1) AS dau,
        (SELECT COUNT(DISTINCT install_id) FROM install_days WHERE day >= ?2) AS wau,
        (SELECT COUNT(DISTINCT install_id) FROM install_days WHERE day >= ?3) AS mau`, today, dayOf(now, 6), dayOf(now, 29)),
    all(db, `SELECT name, outcome, SUM(count) AS n FROM events_daily
             WHERE day >= ? AND source = 'extension' AND name IN ('popup_open', 'scoop_result', 'copy', 'vote')
             GROUP BY name, outcome`, since),
    // Each step counted once per popup session, and once per install.
    first(db, `SELECT
        COUNT(DISTINCT CASE WHEN name = 'popup_open' THEN install_id || ':' || session_id END) AS s_popup_open,
        COUNT(DISTINCT CASE WHEN ${SCOOP_OK} THEN install_id || ':' || session_id END) AS s_scooped,
        COUNT(DISTINCT CASE WHEN name = 'copy' THEN install_id || ':' || session_id END) AS s_copied,
        COUNT(DISTINCT CASE WHEN name = 'vote' THEN install_id || ':' || session_id END) AS s_voted,
        COUNT(DISTINCT CASE WHEN name = 'popup_open' THEN install_id END) AS popup_open,
        COUNT(DISTINCT CASE WHEN ${SCOOP_OK} THEN install_id END) AS scooped,
        COUNT(DISTINCT CASE WHEN name = 'copy' THEN install_id END) AS copied,
        COUNT(DISTINCT CASE WHEN name = 'vote' THEN install_id END) AS voted
      FROM events WHERE day >= ? AND source = 'extension'`, since),
    first(db, `SELECT COUNT(*) AS scoops, SUM(json_extract(props, '$.libraryHit') = 1) AS hits
      FROM events WHERE day >= ? AND ${SCOOP_OK}`, since),
    all(db, `SELECT outcome, SUM(count) AS n FROM events_daily WHERE day >= ? AND name = 'share_result' GROUP BY outcome ORDER BY n DESC`, since),
    first(db, `SELECT AVG(json_extract(props, '$.sizeBytes')) AS size, AVG(json_extract(props, '$.durationMs')) AS duration
      FROM events WHERE day >= ? AND ${SCOOP_OK}`, since),
  ]);
  const count = (name: string, outcome?: string) =>
    funnel.filter((r) => r.name === name && (outcome === undefined || r.outcome === outcome)).reduce((n, r) => n + num(r.n), 0);
  const t = totals as Row;
  return {
    days,
    since,
    rawFrom: rawFrom(now, since),
    perDay: { installs, uninstalls, active: dau },
    installs: {
      total: num(t.installs),
      installed: num(t.installed),
      uninstalled: num(t.uninstalled),
      net: num(t.installs) - num(t.uninstalled),
      optedOut: num(t.opted_out),
      unknownUninstalls: num(t.unknown_uninstalls),
    },
    active: { dau: num(active.dau), wau: num(active.wau), mau: num(active.mau) },
    funnel: {
      events: { popupOpen: count('popup_open'), scooped: count('scoop_result', 'copied_ready'), copied: count('copy'), voted: count('vote') },
      sessions: { popupOpen: num(funnelInstalls.s_popup_open), scooped: num(funnelInstalls.s_scooped), copied: num(funnelInstalls.s_copied), voted: num(funnelInstalls.s_voted) },
      installs: { popupOpen: num(funnelInstalls.popup_open), scooped: num(funnelInstalls.scooped), copied: num(funnelInstalls.copied), voted: num(funnelInstalls.voted) },
      votes: { worked: count('vote', 'worked'), failed: count('vote', 'failed') },
    },
    library: { scoops: num(library.scoops), hits: num(library.hits), hitRate: num(library.scoops) ? num(library.hits) / num(library.scoops) : null },
    shares,
    averages: { sizeBytes: sizes.size == null ? null : Math.round(num(sizes.size)), durationMs: sizes.duration == null ? null : Math.round(num(sizes.duration)) },
  };
}

export async function topSites(db: D1Database, days: number, now = new Date(Date.now())) {
  return all(db, `SELECT site,
      SUM(name = 'scoop_result') AS scoops,
      SUM(${SCOOP_OK}) AS copied_ready,
      SUM(name = 'copy') AS copies,
      COUNT(DISTINCT install_id) AS installs,
      SUM(name = 'scoop_result' AND json_extract(props, '$.libraryHit') = 1) AS library_hits,
      SUM(name = 'scoop_result' AND outcome IN ('error', 'empty')) AS failures,
      SUM(name = 'vote' AND outcome = 'worked') AS worked,
      SUM(name = 'vote' AND outcome = 'failed') AS failed,
      MAX(ts) AS last_at
    FROM events WHERE day >= ? AND source = 'extension' AND site IS NOT NULL
    GROUP BY site ORDER BY scoops DESC, installs DESC LIMIT 200`, dayOf(now, days - 1));
}

export async function siteDetail(db: D1Database, site: string, days: number, now = new Date(Date.now())) {
  const since = dayOf(now, days - 1);
  const [summary, perDay, paths, outcomes, shares, sources, queries, best, recent] = await Promise.all([
    first(db, `SELECT SUM(name = 'scoop_result') AS scoops, SUM(name = 'copy') AS copies, COUNT(DISTINCT install_id) AS installs,
        SUM(name = 'scoop_result' AND json_extract(props, '$.libraryHit') = 1) AS library_hits,
        SUM(name = 'vote' AND outcome = 'worked') AS worked, SUM(name = 'vote' AND outcome = 'failed') AS failed,
        SUM(name = 'report') AS reports, SUM(name = 'rebuild') AS rebuilds,
        AVG(CASE WHEN ${SCOOP_OK} THEN json_extract(props, '$.sizeBytes') END) AS avg_size,
        AVG(CASE WHEN ${SCOOP_OK} THEN json_extract(props, '$.durationMs') END) AS avg_duration
      FROM events WHERE site = ? AND day >= ? AND source = 'extension'`, site, since),
    all(db, `SELECT day, SUM(name = 'scoop_result') AS scoops, SUM(name = 'copy') AS copies, COUNT(DISTINCT install_id) AS installs
      FROM events WHERE site = ? AND day >= ? AND source = 'extension' GROUP BY day ORDER BY day`, site, since),
    all(db, `SELECT path, SUM(name = 'scoop_result') AS scoops, SUM(name = 'copy') AS copies, COUNT(DISTINCT install_id) AS installs,
        SUM(name = 'scoop_result' AND outcome IN ('error', 'empty')) AS failures
      FROM events WHERE site = ? AND day >= ? AND path IS NOT NULL GROUP BY path ORDER BY scoops DESC LIMIT 100`, site, since),
    all(db, `SELECT outcome, json_extract(props, '$.libraryHit') = 1 AS library_hit, COUNT(*) AS n FROM events
      WHERE site = ? AND day >= ? AND name = 'scoop_result' GROUP BY 1, 2 ORDER BY n DESC`, site, since),
    all(db, `SELECT outcome, COUNT(*) AS n FROM events WHERE site = ? AND day >= ? AND name = 'share_result' GROUP BY outcome ORDER BY n DESC`, site, since),
    all(db, `SELECT s.value AS kind, COUNT(*) AS n FROM events e, json_each(e.props, '$.sourceKinds') s
      WHERE e.site = ? AND e.day >= ? AND e.name = 'scoop_result' GROUP BY kind ORDER BY n DESC`, site, since),
    all(db, `SELECT json_extract(props, '$.q') AS q, name, COUNT(*) AS n, AVG(json_extract(props, '$.results')) AS avg_results,
        SUM(outcome = 'miss') AS misses
      FROM events WHERE site = ? AND day >= ? AND name IN ('api_search', 'api_packages') AND json_extract(props, '$.q') IS NOT NULL
      GROUP BY 1, 2 ORDER BY n DESC LIMIT 100`, site, since),
    all(db, `SELECT outcome, SUM(count) AS n FROM events_daily WHERE site = ? AND day >= ? AND name = 'api_best' GROUP BY outcome`, site, since),
    all(db, `SELECT ts, name, path, outcome, install_id, props FROM events WHERE site = ? AND day >= ? AND source = 'extension'
      AND (name IN ('error', 'report') OR outcome IN ('error', 'empty', 'not_shared'))
      ORDER BY ts DESC LIMIT 50`, site, since),
  ]);
  return { site, days, since, rawFrom: rawFrom(now, since), summary, perDay, paths, outcomes, shares, sources, queries, best, problems: recent };
}

const STATUS: Record<string, string> = {
  active: 'uninstalled_at IS NULL AND opted_out = 0',
  uninstalled: 'uninstalled_at IS NOT NULL',
  opted_out: 'opted_out = 1',
};

export async function listInstalls(db: D1Database, f: { status?: string; q?: string; limit: number; offset: number }) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.status && STATUS[f.status]) where.push(STATUS[f.status]);
  if (f.q) {
    where.push('install_id LIKE ?');
    params.push(`${f.q.replace(/[%_]/g, '')}%`);
  }
  const rows = await all(db, `SELECT * FROM installs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY last_seen DESC LIMIT ? OFFSET ?`, ...params, f.limit + 1, f.offset);
  return { rows: rows.slice(0, f.limit), more: rows.length > f.limit };
}

export async function installDetail(db: D1Database, installId: string) {
  const [install, days, timeline, sites] = await Promise.all([
    db.prepare('SELECT * FROM installs WHERE install_id = ?').bind(installId).first<Row>(),
    first(db, 'SELECT COUNT(*) AS n, MIN(day) AS first_day, MAX(day) AS last_day FROM install_days WHERE install_id = ?', installId),
    all(db, `SELECT id, source, name, ts, received_at, session_id, seq, site, path, outcome, props, ext_version, country, ua_browser, ua_os
      FROM events WHERE install_id = ? ORDER BY ts DESC, seq DESC LIMIT 500`, installId),
    all(db, `SELECT site, SUM(name = 'scoop_result') AS scoops, SUM(name = 'copy') AS copies, MAX(ts) AS last_at
      FROM events WHERE install_id = ? AND site IS NOT NULL GROUP BY site ORDER BY scoops DESC LIMIT 100`, installId),
  ]);
  return { install, activeDays: num(days.n), firstDay: days.first_day ?? null, lastDay: days.last_day ?? null, timeline, sites };
}

// Weekly cohorts by install week (Monday; the install event, so installs from
// before telemetry are left out) × weeks since, counted from install_days.
export async function retention(db: D1Database, weeks: number, now = new Date(Date.now())) {
  const since = dayOf(now, weeks * 7);
  const cohort = `date(installed_at, '-6 days', 'weekday 1')`;
  const [sizes, cells] = await Promise.all([
    all<{ cohort: string; n: number }>(db, `SELECT ${cohort} AS cohort, COUNT(*) AS n FROM installs WHERE installed_at >= ? GROUP BY cohort ORDER BY cohort`, since),
    all<{ cohort: string; week: number; n: number }>(db, `WITH c AS (SELECT install_id, ${cohort} AS cohort FROM installs WHERE installed_at >= ?)
      SELECT c.cohort, CAST((julianday(d.day) - julianday(c.cohort)) / 7 AS INTEGER) AS week, COUNT(DISTINCT d.install_id) AS n
      FROM c JOIN install_days d ON d.install_id = c.install_id GROUP BY 1, 2 ORDER BY 1, 2`, since),
  ]);
  return {
    weeks,
    cohorts: sizes.map((s) => ({
      cohort: s.cohort,
      size: s.n,
      // Weeks that have started since the cohort's Monday; later columns are the future.
      elapsed: Math.floor((Date.parse(dayOf(now)) - Date.parse(s.cohort)) / (7 * DAY_MS)),
      active: Array.from({ length: weeks + 1 }, (_, w) => cells.find((c) => c.cohort === s.cohort && c.week === w)?.n ?? 0),
    })),
  };
}

export async function platforms(db: D1Database, days: number, now = new Date(Date.now())) {
  const since = dayOf(now, days - 1);
  const by = (col: string) =>
    all(db, `SELECT COALESCE(${col}, '') AS value, COUNT(*) AS installs FROM installs WHERE last_seen >= ? AND uninstalled_at IS NULL
      GROUP BY 1 ORDER BY installs DESC LIMIT 50`, since);
  const [versions, browsers, browserVersions, oses, arches, locales, timezones, adoption, uaBrowsers] = await Promise.all([
    by('ext_version'), by('browser'), by(`browser || ' ' || browser_version`), by('os'), by('arch'), by('locale'), by('timezone'),
    // Daily active installs by version: update adoption.
    all(db, `SELECT day, version, SUM(count) AS n FROM events_daily WHERE day >= ? AND name = 'active_daily' GROUP BY day, version ORDER BY day, version`, since),
    all(db, `SELECT COALESCE(ua_browser, '') AS value, COALESCE(ua_os, '') AS os, COUNT(*) AS n FROM events WHERE day >= ? AND source = 'site' AND name = 'page_view'
      GROUP BY 1, 2 ORDER BY n DESC LIMIT 30`, since),
  ]);
  return { days, since, rawFrom: rawFrom(now, since), versions, browsers, browserVersions, oses, arches, locales, timezones, adoption, websiteBrowsers: uaBrowsers };
}

export async function geography(db: D1Database, days: number, now = new Date(Date.now())) {
  const since = dayOf(now, days - 1);
  const [installs, events, website, networks] = await Promise.all([
    all(db, `SELECT COALESCE(country, '') AS country, COUNT(*) AS installs, SUM(uninstalled_at IS NOT NULL) AS uninstalled
      FROM installs WHERE last_seen >= ? GROUP BY 1 ORDER BY installs DESC LIMIT 250`, since),
    all(db, `SELECT country, SUM(CASE WHEN name = 'scoop_result' THEN count END) AS scoops, SUM(count) AS events
      FROM events_daily WHERE day >= ? AND source = 'extension' GROUP BY country ORDER BY scoops DESC LIMIT 250`, since),
    all(db, `SELECT country, SUM(count) AS views FROM events_daily WHERE day >= ? AND name = 'page_view' GROUP BY country ORDER BY views DESC LIMIT 250`, since),
    all(db, `SELECT COALESCE(continent, '') AS continent, COALESCE(as_org, '') AS network, COUNT(DISTINCT install_id) AS installs
      FROM events WHERE day >= ? AND source = 'extension' GROUP BY 1, 2 ORDER BY installs DESC LIMIT 50`, since),
  ]);
  return { days, since, rawFrom: rawFrom(now, since), installs, events, website, networks };
}

export async function errors(db: D1Database, days: number, now = new Date(Date.now())) {
  const since = dayOf(now, days - 1);
  const [byCode, perDay, failures, recent] = await Promise.all([
    all(db, `SELECT json_extract(props, '$.where') AS where_, outcome AS code, COALESCE(ext_version, '') AS version, COUNT(*) AS n,
        COUNT(DISTINCT install_id) AS installs, MAX(ts) AS last_at
      FROM events WHERE day >= ? AND name = 'error' GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 100`, since),
    all(db, `SELECT day, version, SUM(count) AS n FROM events_daily WHERE day >= ? AND name = 'error' GROUP BY day, version ORDER BY day`, since),
    all(db, `SELECT day, outcome, SUM(count) AS n FROM events_daily WHERE day >= ? AND name = 'scoop_result' AND outcome IN ('error', 'empty', 'unsupported_page')
      GROUP BY day, outcome ORDER BY day`, since),
    all(db, `SELECT ts, install_id, ext_version, json_extract(props, '$.where') AS where_, outcome AS code, json_extract(props, '$.message') AS message
      FROM events WHERE day >= ? AND name = 'error' ORDER BY ts DESC LIMIT 50`, since),
  ]);
  return { days, since, rawFrom: rawFrom(now, since), byCode, perDay, scoopFailures: failures, recent };
}

export async function apiUsage(db: D1Database, days: number, now = new Date(Date.now())) {
  const since = dayOf(now, days - 1);
  const q = `json_extract(props, '$.q')`;
  const [routes, queries, zero, packages, best, clients] = await Promise.all([
    all(db, `SELECT name, outcome, SUM(count) AS n FROM events_daily WHERE day >= ? AND source = 'api' GROUP BY name, outcome ORDER BY name`, since),
    all(db, `SELECT ${q} AS q, COALESCE(site, '') AS site, COUNT(*) AS n, AVG(json_extract(props, '$.results')) AS avg_results,
        AVG(json_extract(props, '$.latencyMs')) AS avg_ms
      FROM events WHERE day >= ? AND name = 'api_search' GROUP BY 1, 2 ORDER BY n DESC LIMIT 100`, since),
    all(db, `SELECT ${q} AS q, COALESCE(site, '') AS site, name, COUNT(*) AS n, MAX(ts) AS last_at
      FROM events WHERE day >= ? AND name IN ('api_search', 'api_packages') AND outcome = 'miss' AND ${q} IS NOT NULL
      GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 100`, since),
    all(db, `SELECT COALESCE(site, '') AS site, COUNT(*) AS n, SUM(outcome = 'hit') AS hits,
        SUM(json_extract(props, '$.topic') IS NOT NULL) AS by_topic, AVG(json_extract(props, '$.latencyMs')) AS avg_ms
      FROM events WHERE day >= ? AND name = 'api_packages' GROUP BY 1 ORDER BY n DESC LIMIT 100`, since),
    all(db, `SELECT site, SUM(CASE WHEN outcome = 'hit' THEN count ELSE 0 END) AS hits, SUM(CASE WHEN outcome = 'miss' THEN count ELSE 0 END) AS misses
      FROM events_daily WHERE day >= ? AND name = 'api_best' GROUP BY site ORDER BY hits + misses DESC LIMIT 200`, since),
    all(db, `SELECT COALESCE(json_extract(props, '$.client'), '') AS client, COUNT(*) AS n FROM events WHERE day >= ? AND source = 'api'
      GROUP BY 1 ORDER BY n DESC LIMIT 30`, since),
  ]);
  return { days, since, rawFrom: rawFrom(now, since), routes, queries, zeroResults: zero, packages, best, clients };
}

export async function website(db: D1Database, days: number, now = new Date(Date.now())) {
  const since = dayOf(now, days - 1);
  const pv = `day >= ? AND source = 'site' AND name = 'page_view'`;
  const [perDay, paths, referrers, utm, uninstalls, reasons, ctas] = await Promise.all([
    all(db, `SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors FROM events WHERE ${pv} GROUP BY day ORDER BY day`, since),
    all(db, `SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors FROM events WHERE ${pv} GROUP BY path ORDER BY views DESC LIMIT 100`, since),
    all(db, `SELECT json_extract(props, '$.referrerHost') AS host, COUNT(*) AS views FROM events WHERE ${pv} AND json_extract(props, '$.referrerHost') IS NOT NULL
      GROUP BY host ORDER BY views DESC LIMIT 100`, since),
    all(db, `SELECT json_extract(props, '$.utmSource') AS source, json_extract(props, '$.utmMedium') AS medium, json_extract(props, '$.utmCampaign') AS campaign,
        COUNT(*) AS views FROM events WHERE ${pv} AND json_extract(props, '$.utmSource') IS NOT NULL GROUP BY 1, 2, 3 ORDER BY views DESC LIMIT 100`, since),
    first(db, `SELECT SUM(name = 'page_view' AND path LIKE '/bye%') AS bye_views, SUM(name = 'uninstall') AS uninstalls
      FROM events WHERE day >= ? AND source = 'site'`, since),
    all(db, `SELECT outcome AS reason, COUNT(*) AS n FROM events WHERE day >= ? AND name = 'uninstall_reason' GROUP BY 1 ORDER BY n DESC`, since),
    all(db, `SELECT json_extract(props, '$.target') AS target, COALESCE(path, '') AS path, COUNT(*) AS n FROM events WHERE day >= ? AND name = 'cta_click'
      GROUP BY 1, 2 ORDER BY n DESC LIMIT 50`, since),
  ]);
  return { days, since, rawFrom: rawFrom(now, since), perDay, paths, referrers, utm, bye: { views: num(uninstalls.bye_views), uninstalls: num(uninstalls.uninstalls), reasons }, ctas };
}

// ---- Export ------------------------------------------------------------------

// Each exportable table and the column its date range applies to.
export const EXPORT_TABLES: Record<string, { sql: string; order: string }> = {
  events: { sql: 'SELECT * FROM events WHERE day BETWEEN ?1 AND ?2', order: 'ts, id' },
  installs: { sql: 'SELECT * FROM installs WHERE last_seen >= ?1 AND first_seen < date(?2, \'+1 day\')', order: 'first_seen, install_id' },
  install_days: { sql: 'SELECT * FROM install_days WHERE day BETWEEN ?1 AND ?2', order: 'day, install_id' },
  events_daily: { sql: 'SELECT * FROM events_daily WHERE day BETWEEN ?1 AND ?2', order: 'day, source, name, site, country, version, outcome' },
};
export const EXPORT_PAGE = 2000;
export const EXPORT_MAX_ROWS = 1_000_000;

// A CSV cell: quoted when needed, and a leading = + - @ defused so a
// spreadsheet never runs it as a formula.
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// The rows of one table in [from, to] as CSV or NDJSON, a page at a time.
export function exportTable(db: D1Database, table: string, from: string, to: string, format: 'csv' | 'ndjson'): ReadableStream<Uint8Array> {
  const t = EXPORT_TABLES[table];
  const enc = new TextEncoder();
  let offset = 0;
  let header = format === 'csv';
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const rows = offset >= EXPORT_MAX_ROWS ? [] : await all(db, `${t.sql} ORDER BY ${t.order} LIMIT ?3 OFFSET ?4`, from, to, EXPORT_PAGE, offset);
      offset += rows.length;
      let out = '';
      if (header && rows.length) {
        out += Object.keys(rows[0]).map(csvCell).join(',') + '\n';
        header = false;
      }
      for (const r of rows) out += format === 'csv' ? Object.values(r).map(csvCell).join(',') + '\n' : JSON.stringify(r) + '\n';
      if (out) controller.enqueue(enc.encode(out));
      if (rows.length < EXPORT_PAGE) controller.close();
    },
  });
}

// ---- Deletion ----------------------------------------------------------------

// Everything for one install ID leaves D1; its ID is recorded so the consumer
// refuses its events from now on, and an R2 tombstone makes every archive
// export skip it. Rollups hold no install IDs and stay.
export async function deleteInstall(db: D1Database, bucket: R2Bucket, installId: string, now = new Date(Date.now())) {
  const at = now.toISOString();
  // The tombstone first: if anything after it fails, archive exports already skip the ID.
  await writeTombstone(bucket, installId, at);
  const eventsDeleted = num((await first(db, 'SELECT COUNT(*) AS n FROM events WHERE install_id = ?', installId)).n);
  await db.batch([
    db.prepare('DELETE FROM events WHERE install_id = ?').bind(installId),
    db.prepare('DELETE FROM installs WHERE install_id = ?').bind(installId),
    db.prepare('DELETE FROM install_days WHERE install_id = ?').bind(installId),
    db.prepare('DELETE FROM uninstalls WHERE install_id = ?').bind(installId),
    db.prepare('DELETE FROM ip_installs WHERE install_id = ?').bind(installId),
    db
      .prepare('INSERT INTO telemetry_deletions (install_id, deleted_at, events_deleted) VALUES (?1, ?2, ?3) ON CONFLICT (install_id) DO UPDATE SET deleted_at = ?2, events_deleted = events_deleted + ?3')
      .bind(installId, at, eventsDeleted),
  ]);
  return { installId, deletedAt: at, eventsDeleted, tombstone: `${TOMBSTONE_PREFIX}${installId}.json` };
}

export async function deletions(db: D1Database, limit = 100) {
  return all(db, 'SELECT * FROM telemetry_deletions ORDER BY deleted_at DESC LIMIT ?', limit);
}

// The Live tab: the last 24 hours against the 24 before, by received time.
// Counts of 0.6 events (llms_copy, popup_open, badge_llms_shown), installs, the website and errors.
export async function live(db: D1Database, now = new Date(Date.now())) {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const before = new Date(now.getTime() - 2 * DAY_MS).toISOString();
  const [hourly, totals, copies, sites, ctas, last] = await Promise.all([
    all(db, `SELECT substr(received_at, 1, 13) AS hour,
        SUM(name = 'popup_open') AS popups, SUM(name = 'llms_copy') AS copies,
        SUM(name = 'install') AS installs, SUM(name = 'page_view') AS views, SUM(name = 'error') AS errors
      FROM events WHERE received_at >= ? AND source IN ('extension', 'site') GROUP BY hour ORDER BY hour`, since),
    all(db, `SELECT CASE WHEN received_at >= ?1 THEN 'now' ELSE 'before' END AS span,
        SUM(name = 'popup_open') AS popups, SUM(name = 'llms_copy') AS copies, SUM(name = 'install') AS installs,
        SUM(name = 'telemetry_opt_out') AS opt_outs, SUM(name = 'page_view') AS views, SUM(name = 'cta_click') AS ctas,
        SUM(name = 'error') AS errors, SUM(name = 'uninstall') AS uninstalls,
        COUNT(DISTINCT CASE WHEN source = 'extension' THEN install_id END) AS active,
        COUNT(DISTINCT CASE WHEN name = 'page_view' THEN visitor_id END) AS visitors
      FROM events WHERE received_at >= ?2 GROUP BY span`, since, before),
    all(db, `SELECT json_extract(props, '$.source') AS source, json_extract(props, '$.trigger') AS trigger, COUNT(*) AS n
      FROM events WHERE received_at >= ? AND name = 'llms_copy' GROUP BY 1, 2 ORDER BY n DESC`, since),
    all(db, `SELECT site, COUNT(*) AS copies, COUNT(DISTINCT install_id) AS installs, SUM(json_extract(props, '$.source') = 'scoop') AS by_scoop,
        MAX(received_at) AS last_at
      FROM events WHERE received_at >= ? AND name = 'llms_copy' AND site IS NOT NULL GROUP BY site ORDER BY copies DESC, last_at DESC LIMIT 15`, since),
    all(db, `SELECT json_extract(props, '$.target') AS target, COUNT(*) AS n FROM events WHERE received_at >= ? AND name = 'cta_click' GROUP BY 1 ORDER BY n DESC LIMIT 10`, since),
    first(db, `SELECT MAX(received_at) AS at FROM events`),
  ]);
  const span = (s: string) => totals.find((r) => r.span === s) ?? {};
  const pick = (r: Row) => ({
    popups: num(r.popups), copies: num(r.copies), installs: num(r.installs), uninstalls: num(r.uninstalls), optOuts: num(r.opt_outs),
    views: num(r.views), visitors: num(r.visitors), ctas: num(r.ctas), errors: num(r.errors), active: num(r.active),
  });
  return { generatedAt: now.toISOString(), since, lastEventAt: (last as Row).at ?? null, now: pick(span('now')), before: pick(span('before')), hourly, copies, sites, ctas };
}
