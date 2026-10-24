# Telemetry

Usage statistics for scoop.md: who installs and keeps the extension, which documentation sites it is used on, what works and what breaks, how the library API is used, and how the website is found. Everything here is disclosed on [scoop.md/privacy](../site/src/pages/privacy.astro) and in the Web Store data-usage answers ([extension/STORE.md](../extension/STORE.md)); a test (`test/manifest.test.js`) fails if an event the backend accepts is missing from the privacy page.

## Rules

- **No identity.** No names, emails, Google account, cookies. The extension's random install ID is the only identifier.
- **No IP addresses stored.** The IP is used at ingest for rate limiting (the IP subject: IPv4, or the IPv6 /64), for Cloudflare's country/region/continent/network lookup (`request.cf`), and for `ip_hash = HMAC(dayKey, "ip:" + subject)`, kept for abuse analysis. `dayKey` is a random 256-bit key per UTC day in `TELEMETRY_DB.day_keys`, deleted after 48 hours; after that nobody (admins included) can link a hash to an IP or to another day. `ip_hash` is never written to the R2 archive and is cleared in D1 after 30 days. The website's visitor ID is `HMAC(dayKey, "visitor:" + subject + user agent)`. The raw IP never reaches the queue, D1 or R2.
- **A notice first.** The first popup shows "scoop.md sends anonymous usage statistics, including the hostname of the sites you open it on." (before 0.6.0: "…including the hostname and path of public docs pages you scoop.") with [Turn off] and [OK], whatever the sharing setting. Until it has been shown (`telemetryNoticeShown`), events carry no `site` or `path`; lifecycle events still go.
- **Only the clicked tab.** Events describe the page the user clicked scoop.md on, nothing else.
- **No private hosts.** Nothing about a page on a private host (`isPrivateHost` in `extension/lib/hosts.js`: localhost, private, link-local, benchmarking (198.18/15) and multicast/reserved (224+) IPs, single-label names, `.local`, `.internal`, `.lan`, `.home.arpa`, `.home`, `.corp`, `.intranet`, `.private`, `.test`, `.example`, `.invalid`, `.onion`, `.i2p`). The extension sends no events for the scoop; the server drops any event naming one.
- **Sites and paths.** `scoop_start` names no site. On `scoop_result` and the events after it (copy, share, vote, report, rebuild): the hostname when the page was public or the library has the site, else only its registrable domain (`extension/lib/hosts.js` `registrableDomain`: `acme.atlassian.net` → `atlassian.net`). A path only when the scoop found a docs source (`page-md`, `llms`, `llms-full`) or the page is public HTML that looks like docs (`docsLike`: a `docs.`/`developer.`/… host or a `/docs`/`/guide`/`/reference`/… path). Paths have no query string or fragment (a `#/` route stays, cut at `?`, `&` or a second `#`), tracking parameters are stripped, and secret-looking segments (`extension/lib/privacy.js` `SECRETISH`: long letters-and-digits, 12+ hex, UUIDs; readable slugs, where every part looks like a word or number and one is a real word, excepted) become `:id`, in the extension and again on the server.
- **Error text** loses emails, URLs, IPv4 and IPv6 literals, hostnames and 24+ character tokens (`scrubText`), in the extension and again on the server.
- **Opt-out.** Settings → "Send usage statistics", on by default (or [Turn off] on the notice). Switching it off drops the unsent queue, sends exactly one `telemetry_opt_out`, and from then on nothing is sent (no daily ping either); library requests carry `X-Scoop-Telemetry: off` so the API doesn't record them; the uninstall page no longer gets the install ID. Switching it on sends `telemetry_opt_in` and `settings_change`. A synced opt-out arriving on a new device: the service worker doesn't send at install, flushes 30 s later after rechecking, and drops the queue when the setting turns off.
- **Website.** No cookies, no storage, no third-party scripts. Page views and CTA clicks are skipped when the browser sends Global Privacy Control or Do Not Track. `/bye` takes the install ID from the fragment (`#i=…&v=…`, never sent to Vercel) and sets `<meta name="referrer" content="no-referrer">`.
- **API callers are not tracked.** Server-side API usage records the request with the country only and the time rounded to the hour: never an IP hash, install ID, region, network or user agent.

## Events

Envelope (`POST /v1/events`, JSON, sent as `text/plain` by beacons so there is no preflight):

```json
{ "installId": "<uuid v4>", "sessionId": "<uuid>", "client": { "extVersion": "0.3.0", "browser": "Google Chrome", "browserVersion": "130", "os": "mac", "platformArch": "arm64", "locale": "en-GB", "timezone": "Europe/London" },
  "events": [{ "name": "scoop_result", "ts": 1791780858485, "seq": 3, "props": { "site": "docs.stripe.com", "path": "/webhooks", "outcome": "copied_ready" } }] }
```

The website sends `{ "source": "site", "sessionId": "<random per page load>", "events": [...] }` without `installId` or `client`.

| Event | Source | Props |
|---|---|---|
| `install` | extension (service worker) | `reason` |
| `update` | extension (service worker) | `from`, `to` |
| `browser_update` | extension (service worker) | `from`, `to` (browser major version) |
| `active_daily` | extension (service worker, hourly alarm, once per UTC day) | |
| `telemetry_opt_out` / `telemetry_opt_in` | extension (options) | |
| `popup_open` | popup | `trigger` (accepted, not sent: MV3 can't tell toolbar from shortcut) |
| `popup_close` | popup | `durationMs` |
| `scoop_start` | popup (before 0.6.0) | (none: the site is named on `scoop_result`) |
| `scoop_result` | popup (before 0.6.0) | `site`, `path`, `outcome` (`copied_ready` / `empty` / `error` / `unsupported_page`), `sourceKinds[]`, `sources`, `sizeBytes`, `truncated`, `durationMs`, `libraryHit`, `libraryWorked`, `indexHit`, `isPublic`, `relatedLinks`, `clipboard` (`sourceKinds` is `["index"]` for a package from the docs index) |
| `copy` | popup (before 0.6.0) | `site`, `path`, `sizeBytes`, `trigger` (`auto` / `button`) |
| `rebuild` | popup (before 0.6.0) | `site`, `path` |
| `copied_animation_shown` | popup | `reducedMotion` (the "copied to your clipboard" moment played; never for private hosts) |
| `tab_switch` | popup (before 0.6.0) | `tab` (`page` (the Quick Copy tab) / `overview` / `search`) |
| `search` | popup (before 0.6.0) | `site`, `qLen` (length of the query, never its text), `results` |
| `llms_copy` | popup | `site` (hostname), `source` (`site`: the site's own llms.txt / `scoop`: prepared by scoop.md / `fallback`: found by the extension when the library didn't answer), `trigger` (`auto` on opening / `button`) |
| `copy_overview` | popup (before 0.6.0) | `site` |
| `copy_search` | popup (before 0.6.0) | `site`, `count` (results copied) |
| `badge_verdict_shown` | extension (service worker, hourly; before 0.6.0) | `verdict` (`docs` / `not_docs`), `count` |
| `badge_llms_shown` | extension (service worker, hourly) | `level` (`1`: the site has an llms.txt / `2`: llms.txt and instructions for agents), `count`: how many times the toolbar badge showed it in the hour (once per tab per site); no sites |
| `crawl_request` | popup (before 0.6.0) | `site`, `state` (`queued` / `running` / `indexing` / `complete` / `rejected` / `failed`, or `rate_limited` / `error` when the request itself failed) |
| `crawl_wait` | popup (before 0.6.0) | `durationMs`, `outcome` (`complete` / `rejected` / `failed` / `copied_page` ("Copy this page now") / `closed` (popup closed; the service worker keeps following it) / `timeout` (gave up after 10 minutes and copied the page; the service worker keeps following it) / `stalled_index` (indexing stopped making progress, so the pages already indexed were delivered)) |
| `share_result` | popup (before 0.6.0) | `site`, `path`, `outcome` (`shared` / `duplicate` / `not_shared`), `reason` (`sharing_off`, `not_devdocs`, `private_host`, `signed_in`, or the library's error code) |
| `vote` | popup (before 0.6.0) | `site`, `path`, `skillId`, `worked`, `ok` |
| `report` | popup (before 0.6.0) | `site`, `path`, `skillId`, `reason`, `ok` |
| `settings_change` | popup, options | `key` (`share` (before 0.6.0) / `theme` / `telemetry`), `value` |
| `options_open` | options | |
| `error` | popup | `where`, `code`, `message` (≤200 chars; emails, URLs, hostnames and tokens removed on both sides) |
| `page_view` | website | `path`, `referrerHost`, `utmSource`, `utmMedium`, `utmCampaign` |
| `cta_click` | website | `target`, `path` |
| `uninstall` | website (`/bye#i=<installId>&v=<version>`) | `installId`, `version` |
| `uninstall_reason` | website (`/bye`) | `installId`, `reason` (`too_noisy` / `didnt_work` / `privacy` / `other`) |
| `api_search`, `api_packages`, `api_best`, `api_sites`, `api_site`, `api_profile`, `api_topics` | server | `route`, `status`, `latencyMs`, `q` (≤200), `topic`, `results`, `hit`, `client` (`X-Scoop-Client`) |
| `api_crawl_request` | server (`POST /v1/crawl-requests`) | `route`, `status`, `latencyMs`, `state` (`queued` / `running` / `indexing` / `complete` / `rejected` / `failed`, or `rate_limited` for any 429 including "busy"; also the row's `outcome`), `client`; `site` on the row. Not recorded with `X-Scoop-Telemetry: off`. |
| `api_quick` | server (`GET /v1/quick`) | `route`, `status`, `latencyMs`, `results` (sources found), `hit` (an overview was found), `client`; `site` on the row. |

The catalog lives in `backend/src/telemetry/schema.ts`; the reference server (`server/app.js`) keeps the same names, checked by a test.

Server-added fields on extension and website events: `received_at`, `country`, `region`, `continent`, `as_org` (from `request.cf`), `ua_browser` / `ua_os` (parsed family and major version, the raw user agent is not kept), `ip_hash`, `visitor_id` (website only), and `outcome` (the event's result, for rollups). API rows get `country` only, with `ts` and `received_at` rounded down to the hour.

Lifecycle events (accepted under `TELEMETRY_INGEST=lifecycle` and above the daily ceiling): `install`, `update`, `browser_update`, `active_daily`, `telemetry_opt_out`, `telemetry_opt_in`, `uninstall`, `uninstall_reason`.

## Pipeline

1. **Extension** (`extension/lib/telemetry.js`): `track()` appends to `chrome.storage.local.telemetryQueue` (≤500, oldest dropped). The popup sends its session's events with `navigator.sendBeacon` on `pagehide` (fetch `keepalive` if the beacon is refused) and drops them from the queue. The service worker (`extension/background.js`) schedules a flush 30 s after install/update (not at once, so a synced opt-out can land), flushes on startup, and runs an hourly alarm that flushes and sends `active_daily` once per UTC day. Requests carry ≤100 events and ≤60 KB. A network error, 429 or 5xx keeps the queue and schedules a retry (1, 2, 4 … minutes, capped at 6 hours); a 4xx drops the refused batch. The endpoint is the library's base URL + `/events`, so `devLibraryUrl` works on unpacked installs.
2. **Ingest** (`POST /v1/events`, `backend/src/telemetry/ingest.ts`): Origin must be the extension, `https://scoop.md`, absent, or localhost in dev. Rate limits: `EVENTS_LIMITER` 30 requests/min per IP subject, `EVENTS_INSTALL_LIMITER` 10/min per install ID (a full 500-event queue needs 5). Body ≤64 KB, ≤100 events, strict schema, timestamps within ±7 days. `TELEMETRY_INGEST`: `on` (default), `lifecycle` (lifecycle events only) or `off` (nothing is queued; still `202`). Rows are split into queue messages of ≤90 KB (`sendBatch`; the queue's limit is 128 KB). Answers `202 {accepted, dropped}`.
3. **API usage**: after each response of the routes above, `ctx.waitUntil(recordApiUsage(...))` queues one row, unless the request carries `X-Scoop-Telemetry: off` or `TELEMETRY_INGEST` isn't `on`. `TELEMETRY_API_SAMPLE` (0–1, default 1) is the sampled share.
4. **Consumer** (`telemetry-events-<env>`, `max_concurrency` 1, `backend/src/telemetry/consumer.ts`), writing to `TELEMETRY_DB` only:
   - drops events of deleted installs;
   - applies the daily quotas (by received UTC day, counters in `quota_counters` and `ip_installs`): at most 20 new install IDs per `ip_hash`, 2,000 events per install, 20,000 events per `ip_hash`; above `TELEMETRY_DAILY_MAX` (default 2,000,000) events in a day, lifecycle events only, and none at all above 3× that; at most `TELEMETRY_API_DAILY_MAX` (default 200,000) API rows a day. A redelivered message counts toward the quotas twice (conservative). The first time each cap drops an event on a UTC day, the consumer logs one structured `{"event":"telemetry_cap_hit","day","cap",…}` line (caps: `new_installs_per_ip`, `events_per_install`, `events_per_ip`, `daily_max`, `lifecycle_max`, `api_daily_max`);
   - writes the kept rows to R2 (one gzipped NDJSON object per receive hour, without `ip_hash`);
   - then per message, in one D1 transaction: `INSERT OR IGNORE` into `events` (the ID is a hash of install or visitor, session, seq and name, so resends and redeliveries are stored once), the quota counters, `events_daily` counts, `install_days` (by received day), the `installs` upsert (client fields from the latest event by time), opt-out state (only a toggle newer than `opted_changed_at` changes it) and `uninstalls` (an uninstall never creates an `installs` row; unknown IDs are counted apart).
   Failures retry with backoff; 10 retries, then the dead-letter queue.
5. **Retention** (hourly cron `23 * * * *`, `pruneTelemetry`): deletes `events` rows received more than 180 days ago and clears `ip_hash` after 30 days, in chunks of 5,000 until a chunk comes back short; deletes day keys older than 48 hours and quota rows older than 2 days. `events_daily`, `install_days`, `installs`, `uninstalls` stay; the R2 archive is deleted by a bucket lifecycle rule after 13 months.

## Storage

Its own D1 database, binding `TELEMETRY_DB` (`backend/migrations-telemetry/0001_telemetry.sql`), so a flood of events can never fill the library's database:

| Table | Holds | Kept |
|---|---|---|
| `events` | every event, enriched (indexes: name+ts, install_id+ts, site+ts, received_at, day) | 180 days (`ip_hash` 30 days) |
| `installs` | per install with extension events: first/last seen, install time, version, browser, OS, arch, locale, time zone, country, events/scoops/copies, opted out (and when it last changed), uninstalled at and why | until deleted |
| `uninstalls` | every uninstall from `/bye`: time, reason, version, `known` (an installs row existed) | until deleted |
| `install_days` | (install_id, received day) pairs: DAU/WAU/MAU and retention past 180 days | until deleted |
| `events_daily` | count per (day, source, name, site, country, version, outcome); no install IDs | forever |
| `telemetry_deletions` | install IDs whose data was deleted on request | forever |
| `day_keys` | the random key per UTC day for `ip_hash` and `visitor_id` | 48 hours |
| `quota_counters`, `ip_installs` | daily quota state | 2 days |

The admin's figures read from `events` cover at most the last 180 days; pages say so when the window is longer. New installs and retention cohorts use `installed_at` (the `install` event), so existing users updating to 0.3.0 aren't counted as new; installs without one are left out of retention.

R2 bucket `scoop-telemetry-<env>` (binding `TELEMETRY`; its own bucket so the archive's access, lifecycle and cost stay apart from the skills bucket):

- `telemetry/raw/dt=YYYY-MM-DD/hour=HH/<uuid>.ndjson.gz`: one JSON row per line, the D1 columns except `ip_hash`. A redelivered message can archive an event twice: dedupe on `id`. **Lifecycle rule (create it): delete objects under `telemetry/raw/` 13 months (395 days) after creation.**
- `telemetry/tombstones/<install_id>.json`: deletion tombstones. Objects are never rewritten; every read of the archive (`readArchive`, the admin export) skips install IDs with a tombstone or a `telemetry_deletions` row.

## AI spend (costs, not usage telemetry)

What crawling and indexing cost is kept in the library database (`DB`), not here: `index_costs` (per site and UTC day, what the daily caps count), `index_run_costs` (per page and run) and `crawl_runs` (per run, shown in the admin console's Costs view and in each run's `costs`). Jev, TypeSafe's model for the devtool gate, page classification and `/v1/quick`'s overview pick, is billed in tokens at a price not yet published: its tokens are recorded in `jev_tokens` columns on all three tables (`gate_jev_tokens` on `crawl_runs` for the gate; migration 0011) and priced at `JEV_USD_PER_MTOK` (a provisional 0.5 until TypeSafe publishes a price) into the existing USD columns; `JEV_DAILY_TOKEN_CAP` (5M a day) stops Jev calls past it. A run's `costs.jevTokens` adds the gate's and the classification's. `/v1/quick` and the crawl's `agent-instructions` step (instructions for agents) charge their Jev tokens to the site in `index_costs`. OpenRouter spend (the gate's fallback; classification with `CLASSIFIER=openrouter`) stays in USD as before.

## Deletion requests

Users email team@ddamoah.com with the install ID shown on the extension's settings page. Admin console → Telemetry → Users → the install → "Delete all data for this install" (or `DELETE /api/telemetry/installs/<id>`): writes the R2 tombstone first, then deletes its `events`, `installs`, `install_days`, `uninstalls` and `ip_installs` rows and records it in `telemetry_deletions` (the consumer then refuses its events). Its archived rows are skipped by every export and go when the lifecycle rule deletes their objects. `events_daily` holds no install IDs and stays.

## Admin console

`admin.scoop.md` → Telemetry: Live (the last 24 hours against the 24 before, refreshed every 30 s: active installs, `llms_copy` copies by source and trigger, popups, new installs, uninstalls, opt-outs, errors, website views and button clicks, an hourly table and the top sites; for launch days), Overview (installs and uninstalls per day, net installs, DAU/WAU/MAU, the popup → scoop → copy → vote funnel per session and per install, library hit rate, share outcomes, average size and duration), Sites (with a drilldown: paths, outcomes, sources, shares, search queries, best hit/miss, problems), Users (installs table and per-install timeline), Retention (weekly cohorts × weeks active), Versions & platforms (with update adoption), Geography, Errors, API usage (top and zero-result queries, packages, best hit/miss by site, clients), Website (page views, visitors, referrers, UTM, CTAs, the uninstall page) and Export (CSV or NDJSON of `events`, `installs`, `install_days`, `events_daily` for a date range, or the R2 archive as NDJSON for up to 31 days; a same-origin GET with `Content-Disposition: attachment`, CSV cells starting with `= + - @` are prefixed with `'`).

JSON endpoints (`/api/telemetry/…`): `live`, `overview?days=`, `sites?days=`, `sites/:site?days=`, `installs?status=&q=&cursor=`, `installs/:id`, DELETE `installs/:id`, `deletions`, `retention?weeks=`, `platforms?days=`, `geo?days=`, `errors?days=`, `api?days=`, `website?days=`, `export?table=&from=&to=&format=`.

## Remote resources (per environment)

| Resource | Dev | Staging | Production |
|---|---|---|---|
| D1 database (`TELEMETRY_DB`) | local placeholder `00000000-0000-0000-0000-000000000001` | `scoop-telemetry-staging` (`d059ae06-4a40-40ac-b096-5d511b2b0b89`) | `scoop-telemetry-production` (`1ea9ed26-92e3-4d1e-a031-bba44dbd11e0`) |
| Migrations | `migrations-telemetry/0001_telemetry.sql` | same | same |
| Queue | `telemetry-events-dev` | `telemetry-events-staging` | `telemetry-events-production` |
| Dead-letter queue | `telemetry-events-dlq-dev` | `telemetry-events-dlq-staging` | `telemetry-events-dlq-production` |
| R2 bucket (+ 13-month lifecycle rule on `telemetry/raw/`) | `scoop-telemetry-dev` | `scoop-telemetry-staging` | `scoop-telemetry-production` |
| `EVENTS_LIMITER` (30/min per IP subject) | 4130 | 4131 | 4132 |
| `EVENTS_INSTALL_LIMITER` (10/min per install) | 4133 | 4134 | 4135 |
| Vars | `TELEMETRY_INGEST`, `TELEMETRY_API_SAMPLE`, `TELEMETRY_DAILY_MAX`, `TELEMETRY_API_DAILY_MAX` | same | same |
| Crons | `17 4 * * *`, `23 * * * *` | same | same |

No secret is needed: the day keys live in `TELEMETRY_DB`. See backend/README.md, "Before the first deploy", step 11.
