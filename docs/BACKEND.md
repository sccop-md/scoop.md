# scoop.md backend: build spec for api.scoop.md

You are building the shared library behind scoop.md. This document is self-contained: it tells you what the product is, the exact API the Chrome extension and website call, the rules the server must enforce, and how "done" is measured. Where this spec and your own preferences differ, follow the spec. Where it is silent, choose the simplest thing that keeps the contract tests passing, and write your choice down in `docs/BACKEND-DECISIONS.md`.

## 1. Product in one paragraph

scoop.md is a browser extension with one button, "Scoop to agent". On any documentation page it copies a Markdown package the user pastes into their coding agent (Claude Code, Codex, Cursor…). The package is built from what the site already publishes (`<page>.md`, `llms.txt`, `llms-full.txt`) or, failing that, from the page's HTML converted to Markdown. The backend stores packages that people share, and when a later user scoops the same site, the extension gets **the most recent package that people confirmed worked** instead of rebuilding from scratch. Success for the product is "my agent implemented what I asked using this context", so the vote from users ("It worked" / "It didn't") is the core signal.

## 2. Fixed decisions

| Decision | Value |
|---|---|
| Runtime | Cloudflare Workers (TypeScript) |
| Metadata store | Cloudflare D1 |
| Package content store | Cloudflare R2 (one JSON object per skill) |
| Production URL | `https://api.scoop.md` (Workers custom domain) |
| Staging URL | `https://api-staging.scoop.md` |
| API prefix | `/v1` |
| What is stored | Full copies of **public** documentation, with source URLs for attribution |
| Accounts | None in v1. Clients identify with an anonymous install ID. |
| Repo location | `backend/` in this repository |

Check Cloudflare's current documentation for exact `wrangler` config syntax (D1, R2, rate limiting bindings, custom domains). Don't rely on remembered syntax.

## 3. Vocabulary

- **Site**: the documentation host a package belongs to. It is the URL's hostname, lowercased, with a leading `www.` removed. `https://www.Example.com/docs` → `example.com`. `docs.stripe.com` and `stripe.com` are different sites.
- **Section**: one piece of source material with the URL it came from.
- **Skill**: a set of sections for one site, plus related links. This is what the library stores and serves. (The user-facing name is "a scoop"; the API says "skill".)
- **Install ID**: a random UUID v4 the extension creates on first run and sends with every request. It identifies an installation, not a person. Never log it next to IP addresses for longer than rate limiting needs.

## 4. Data shapes

### Section

```json
{
  "kind": "page-md",
  "label": "This page: Webhooks",
  "url": "https://docs.stripe.com/webhooks.md",
  "content": "# Receive Stripe events in your webhook endpoint\n...",
  "bytes": null
}
```

| Field | Type | Rules |
|---|---|---|
| `kind` | enum | `page-md` (the page's Markdown twin), `llms` (llms.txt), `llms-full` (llms-full.txt), `page-html` (extracted from the page's HTML by the extension) |
| `label` | string | 1–200 chars. Shown to the agent as the section heading. |
| `url` | string | Absolute `https://` URL (or `http://` only when `ALLOW_LOCALHOST=1`). Hostname must equal the skill's `site` after the same normalisation. |
| `content` | string or null | The text. `null` only for `llms-full` sections too large to download (> 2,000,000 bytes); then `bytes` says how large (a lower bound is fine). |
| `bytes` | integer or null | Required when `content` is null, otherwise null. |

### Related link

```json
{ "url": "https://tailwindcss.com/docs/editor-setup", "text": "Editor setup" }
```

Same host as the skill's site, `http(s)` only, `text` ≤ 120 chars, at most 100 per skill.

### Skill (as returned by the API)

```json
{
  "id": "sk_01J9Z3Q4W8B7X2N5K6M1P0R3T4",
  "site": "docs.stripe.com",
  "pageUrl": "https://docs.stripe.com/webhooks",
  "title": "Receive Stripe events in your webhook endpoint",
  "sections": [ /* Section[] in priority order */ ],
  "relatedLinks": [ /* RelatedLink[] */ ],
  "worked": 3,
  "failed": 0,
  "createdAt": "2026-09-30T08:06:43.550Z",
  "lastWorkedAt": "2026-10-02T11:20:00.000Z",
  "status": "verified"
}
```

A **skill summary** is the same object without `sections` and `relatedLinks`, plus `sources: [{ kind, label, url }]` and `sizeBytes` (sum of section content lengths).

IDs are opaque strings with the prefix `sk_`. Use a sortable random ID (ULID or similar).

## 5. API

All responses are JSON (`content-type: application/json; charset=utf-8`) unless stated.

### Request headers the extension sends

| Header | Example | Required on |
|---|---|---|
| `X-Scoop-Install` | `3b1f…` (UUID v4) | All `POST` requests. Reject with 400 `invalid_request` if missing or not a UUID. |
| `X-Scoop-Client` | `extension/0.2.0` | Optional. Log it for version stats. |

### Error format

```json
{ "error": { "code": "source_mismatch", "message": "Section 2 (https://ex.com/llms.txt) does not match the live file." } }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid_request` | Malformed JSON, missing or invalid fields, bad install ID |
| 404 | `not_found` | Unknown skill or site |
| 410 | `removed` | Skill removed by takedown |
| 413 | `too_large` | Body over 6 MB, or any section over its limit |
| 422 | `source_unreachable` | A source URL can't be fetched publicly (non-2xx, timeout, HTML shell where text was expected) |
| 422 | `source_mismatch` | A section's content doesn't match its source (see §6) |
| 422 | `site_mismatch` | A URL's host isn't the skill's site |
| 429 | `rate_limited` | Over a rate limit. Include `Retry-After` (seconds). |
| 500 | `internal` | Anything else. Never leak stack traces. |

### Endpoints

#### `GET /v1/health`
`200 { "ok": true, "version": "<git sha or semver>" }`

#### `GET /v1/skills/best?site=<site>`
The skill the extension should use for this site, per the ranking rule (§7).
- `200 { "skill": Skill }` or `200 { "skill": null }` when nothing qualifies.
- `site` is normalised server-side (lowercase, strip `www.`).
- Cacheable: `cache-control: public, max-age=30, s-maxage=60`.

#### `GET /v1/skills/:id`
`200 { "skill": Skill }`, `404`, or `410` if removed.

#### `POST /v1/skills`
Share a newly built skill.

Request:
```json
{
  "site": "docs.stripe.com",
  "pageUrl": "https://docs.stripe.com/webhooks",
  "title": "Receive Stripe events in your webhook endpoint",
  "sections": [ /* 1–6 Section objects */ ],
  "relatedLinks": [ /* 0–100 RelatedLink objects */ ]
}
```

Behaviour:
1. Validate shape and limits (§8). `pageUrl` host must equal `site`.
2. **Verify every section against its live source** (§6). All sections must pass, or reject the whole skill.
3. **Deduplicate**: compute a fingerprint = SHA-256 of the canonical JSON of `[{kind, url, sha256(content)}]` in order. If a non-removed skill with the same site and fingerprint exists, return it with `200 { "id": "...", "status": "verified", "duplicate": true }` instead of creating another.
4. Store metadata in D1 and `{ sections, relatedLinks }` in R2 at `skills/<id>.json`.
5. Respond `201 { "id": "...", "status": "verified", "duplicate": false }`.

A new skill starts with `worked = 0` and is **not served by `/best` until someone confirms it worked**. That's intended: the sharer's own vote is usually the first one.

#### `POST /v1/skills/:id/feedback`
Request: `{ "worked": true }` (boolean, required).
- One vote per (skill, install ID). A second vote from the same install **replaces** the first.
- Update `worked`, `failed` and `lastWorkedAt` (the time of the most recent `worked: true` vote still standing) atomically with the vote.
- `200 { "worked": 3, "failed": 0 }`. `404` for an unknown skill, `410` for a removed one.

#### `GET /v1/sites?limit=50&cursor=<opaque>`
For the website's library index. Sites that have a best skill, most recently confirmed first.

`200 { "sites": [{ "site": "docs.stripe.com", "best": SkillSummary }], "next": "<cursor or null>" }`. `limit` 1–100, default 50. Cacheable for 60 s.

#### `GET /v1/sites/:site`
For the website's per-site page.

`200 { "site": "docs.stripe.com", "best": SkillSummary | null, "recent": SkillSummary[] }`. `recent` is up to 20 non-removed skills for the site, newest first, including unconfirmed ones. `404` if the site has no skills at all. Cacheable for 60 s.

#### `POST /v1/reports`
Anyone can flag a skill (wrong content, malicious instructions, copyright).

Request: `{ "skillId": "sk_…", "reason": "malicious" | "wrong" | "copyright" | "other", "details": "optional, ≤ 2000 chars" }`. Requires `X-Scoop-Install`. `202 { "ok": true }`. Store it; don't act automatically.

#### `DELETE /v1/admin/skills/:id`
Takedown. Requires `Authorization: Bearer <ADMIN_TOKEN>` (Workers secret; compare in constant time). Marks the skill removed (keep the row for audit, delete the R2 object). `200 { "ok": true }`. Wrong or missing token → `404` (don't reveal the endpoint).

#### `GET /v1/admin/reports`
Same auth. Lists open reports, newest first.

### CORS

- `GET` endpoints: `Access-Control-Allow-Origin: *`.
- `POST` / `DELETE`: allow origins `chrome-extension://<id>` for IDs listed in the `EXTENSION_IDS` env var (comma-separated), plus `https://scoop.md`. When `ALLOW_ANY_EXTENSION=1` (dev/staging only), allow any `chrome-extension://` origin. Requests without an `Origin` header (curl, tests) are allowed; CORS protects browsers, not the API.
- Allowed headers: `content-type, x-scoop-install, x-scoop-client, authorization`. Answer `OPTIONS` preflights with 204.

## 6. Source verification (required)

This is the most important rule in the spec. Users paste this content into agents that can run commands. A skill containing text that didn't come from the cited page is an attack vector (prompt injection). The server must confirm every section came from its URL, fetched **without credentials**. That also enforces "public docs only": anything the server can't fetch anonymously is, by definition, not public.

For each section, fetch `url` with no cookies or auth headers, following at most 5 redirects, with a 10 s timeout and a 2,000,000-byte read cap (stop reading once exceeded). Follow redirects manually, applying the SSRF rules below to every hop; if any hop leaves the skill's site, reject with `422 site_mismatch`. Then check by kind:

| kind | Check |
|---|---|
| `page-md`, `llms` | Response is 2xx and not an HTML document (reject `content-type: text/html`, or a body starting with `<!doctype`/`<html`). After normalising both sides (CRLF → LF, trim trailing whitespace on each line, trim the whole text), `content` must **equal** the fetched body. |
| `llms-full` with content | As above. |
| `llms-full` with `content: null` | Response is 2xx, not HTML, and the body is larger than 2,000,000 bytes (the cap was hit or `content-length` says so). |
| `page-html` | Response is 2xx HTML. Convert the HTML to plain text: drop `script`, `style`, `noscript` and `template` elements, replace every tag with a space (so adjacent block and line elements don't glue words together), decode **all** HTML5 named and numeric entities (use a library, e.g. `entities`), and collapse whitespace. Then compute **shingle containment**: take the section content, remove Markdown syntax (`#`, `*`, backticks, `[text](url)` → `text`, list and table markers), lowercase, split into words, and form 5-word shingles. At least **85%** of the section's shingles must appear in the page text's shingle set. Sections with fewer than 20 shingles must match 100%. |

Anything else → `422 source_mismatch` naming the failing section. Unreachable, non-2xx or timeout → `422 source_unreachable`.

The 85% threshold allows for the extension's HTML-to-Markdown conversion differing slightly from yours. Fixtures in the contract tests pin this down.

### Fetch safety (SSRF)

Reject with `400 invalid_request` before fetching (this applies to `pageUrl` and every section URL):
- Non-`https` URLs (allow `http` only when `ALLOW_LOCALHOST=1`).
- Hostnames that are IP literals (v4 or v6), `localhost`, or end in `.local`, `.internal`, `.localhost` or `.test`. When `ALLOW_LOCALHOST=1`, allow `localhost` and `127.0.0.1` only.
- Ports other than 443 (or any port on localhost when `ALLOW_LOCALHOST=1`).

Verify at most 6 sections per request. Fetch them concurrently.

## 7. Ranking: "the most recent skill that worked"

`/v1/skills/best?site=S` returns the skill with the **latest `lastWorkedAt`** among skills where all of these hold:
- `site = S`
- not removed
- `worked ≥ 1`
- `worked > failed`

Ties break by `createdAt` descending. If none qualify, return `null`; the extension then builds fresh from the live site. This definition matches the reference implementation in `server/store.js` and the contract tests. Don't add popularity weighting in v1.

## 8. Limits

| Limit | Value | Response |
|---|---|---|
| Request body | 6 MB | 413 `too_large` |
| Sections per skill | 1–6 | 400 |
| Section `content` | ≤ 2,000,000 chars | 413 |
| Related links | ≤ 100 | 400 |
| Report `details` | ≤ 2,000 chars | 400 |
| `POST /v1/skills` | 20 per hour per install ID, and 60 per hour per IP | 429 |
| Feedback and reports | 120 per hour per install ID | 429 |
| Reads | 600 per minute per IP | 429 |

Use Cloudflare's rate limiting binding or a D1/Durable Object counter. Rate limit by install ID **and** IP, so rotating install IDs doesn't bypass the limit.

## 9. Storage

D1 schema (adapt names if you like, but keep the semantics):

```sql
CREATE TABLE skills (
  id            TEXT PRIMARY KEY,
  site          TEXT NOT NULL,
  page_url      TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  fingerprint   TEXT NOT NULL,
  sources_json  TEXT NOT NULL,          -- [{kind,label,url}] for summaries without hitting R2
  size_bytes    INTEGER NOT NULL,
  worked        INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  last_worked_at TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,          -- install ID
  removed_at    TEXT
);
CREATE INDEX skills_site_best ON skills (site, removed_at, last_worked_at DESC);
CREATE UNIQUE INDEX skills_site_fp ON skills (site, fingerprint) WHERE removed_at IS NULL;

CREATE TABLE votes (
  skill_id   TEXT NOT NULL REFERENCES skills(id),
  install_id TEXT NOT NULL,
  worked     INTEGER NOT NULL,          -- 1 or 0
  voted_at   TEXT NOT NULL,
  PRIMARY KEY (skill_id, install_id)
);

CREATE TABLE reports (
  id         TEXT PRIMARY KEY,
  skill_id   TEXT NOT NULL,
  install_id TEXT NOT NULL,
  reason     TEXT NOT NULL,
  details    TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
```

Keep `worked`, `failed` and `last_worked_at` consistent with `votes` in the same D1 batch. `last_worked_at` = max `voted_at` over the skill's current `worked = 1` votes (null if none).

R2 object `skills/<id>.json` = `{ "sections": [...], "relatedLinks": [...] }`.

Migrations live in `backend/migrations/` and run with `wrangler d1 migrations apply`.

## 10. Security and privacy checklist

- [ ] Every section verified against its live source (§6). No code path stores unverified content.
- [ ] SSRF rules (§6) enforced before any outbound fetch.
- [ ] Outbound fetches never send cookies, `Authorization` or the client's headers.
- [ ] Install IDs are stored only on skills, votes and reports. IP addresses are used only for rate limiting and not persisted.
- [ ] Admin token is a Workers secret, compared in constant time; admin routes return 404 on bad auth.
- [ ] No stack traces or internal errors in responses.
- [ ] Takedown removes the R2 content immediately and stops the skill appearing anywhere.
- [ ] Logs don't contain section content.

## 11. Operations

- `wrangler.toml` (or `wrangler.jsonc`) with `production` and `staging` environments, each with its own D1 database and R2 bucket.
- Custom domains: `api.scoop.md` → production, `api-staging.scoop.md` → staging. DNS for scoop.md is on Cloudflare.
- Secrets: `ADMIN_TOKEN`. Vars: `EXTENSION_IDS`, `ALLOW_ANY_EXTENSION` (staging only), `ALLOW_LOCALHOST` (local dev only; never set in staging or production).
- Enable Workers Logs. Log one line per request: method, route, status, duration, `X-Scoop-Client`. Nothing else.
- Back up D1 with Time Travel (on by default); document how to restore in `backend/README.md`.
- CI (GitHub Actions): typecheck, unit tests, then contract tests against `wrangler dev`. Deploy to staging on push to `main`, to production on a tag `backend-v*`.

## 12. Definition of done

1. `backend/` contains the Worker, migrations, config and a README with setup, deploy and restore steps.
2. **The contract tests pass**: `SCOOP_API=http://localhost:8787 npm run test:contract` from the repo root, against `wrangler dev` with `ALLOW_LOCALHOST=1`. They start their own fixture docs server on localhost, so the Worker must be able to fetch `http://localhost:<port>` in local dev. The same suite passes against the reference server (`npm run server`), so treat any disagreement between this spec and those tests as a bug to report, not something to code around.
3. Your own unit tests cover verification (all four kinds, including near-miss HTML), SSRF rejection, ranking, dedupe and vote replacement.
4. Deployed to staging, and `curl https://api-staging.scoop.md/v1/health` returns `ok: true`.
5. `docs/BACKEND-DECISIONS.md` lists every choice you made that this spec didn't.

Don't deploy to production. The owner does that after reviewing staging.

## 13. Out of scope for v1 (don't build yet)

- **Direct reader links** (`scoop.md/<url>` → Markdown for agents that can't use the extension). Planned for v2. Design so it can reuse the verification and ranking code.
- **Scheduled re-verification** of stored skills when the docs change. Planned for v2.
- Accounts, teams, private libraries, billing.

## 14. Reference implementation

`server/` in this repo is a dependency-free Node implementation of this exact API, used for local development and as the source of truth for behaviour. Read `server/app.js` and `server/verify.js` before starting. When the reference and this spec disagree, tell the owner; don't silently pick one.
