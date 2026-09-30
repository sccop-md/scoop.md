# scoop.md website

The site at https://scoop.md: landing page, the shared library browser, privacy policy and terms. Astro 7 with the Cloudflare adapter, deployed as a Worker (`scoop-md-site`) with static assets.

| Route | Rendering | Data |
|---|---|---|
| `/` | prerendered | none |
| `/privacy`, `/terms` | prerendered | none |
| `/library` | on demand | `GET {API}/v1/sites?limit=100` |
| `/<site>` e.g. `/docs.stripe.com` | on demand | `GET {API}/v1/sites/<site>` |

Static routes and files win over `/<site>`. Anything that isn't a hostname gets the 404 page without calling the API; `Docs.Stripe.com` and `www.` hosts 301 to the normalised site. When the API says 404 the page answers 404 ("No scoops for … yet"); when it's unreachable, library pages answer 503 with a "library unavailable" notice instead of failing.

Library pages send `Cache-Control: public, max-age=60, s-maxage=60`, and API subrequests are cached at the edge for 60 s (`cf.cacheTtl`). Errors are cached for 10 s at most.

## Commands

```sh
npm install
npm run dev       # http://localhost:4321 (runs in workerd, like production)
npm run build     # dist/client (assets) + dist/server (Worker)
npm run preview   # serve the production build locally in workerd
npm run deploy    # astro build && wrangler deploy
```

`wrangler deploy` needs `wrangler login` (or `CLOUDFLARE_API_TOKEN`) with access to the account that owns the `scoop.md` zone.

### Against a local library

```sh
# repo root: the reference API on :8787
PORT=8787 ALLOW_LOCALHOST=1 node server/server.js

# site/
PUBLIC_API_URL=http://localhost:8787 npm run dev
```

`npm run dev` sets `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` so shell variables reach the Worker's `env`. For `npm run preview`, prefix it the same way, or put `PUBLIC_API_URL=http://localhost:8787` in `site/.dev.vars` (gitignored).

## Environment

| Variable | When it's read | Default | Purpose |
|---|---|---|---|
| `PUBLIC_API_URL` | Runtime (Worker var) | `https://api.scoop.md` | Library API base URL. Set in `wrangler.jsonc` `vars`; override locally as above. |
| `PUBLIC_CHROME_STORE_URL` | Build time | unset | Chrome Web Store listing. When unset, the hero button reads "Coming soon to the Chrome Web Store" and links to GitHub. Set it in the build environment, e.g. `PUBLIC_CHROME_STORE_URL=https://chromewebstore.google.com/detail/… npm run deploy`, or in Workers Builds settings. |

## Domain

`wrangler.jsonc` attaches the Worker to `scoop.md` as a [custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/); Cloudflare creates the DNS record and certificate on first deploy. The zone must be on the same Cloudflare account.

### Redirect www.scoop.md and anydoc.md

Use [Single Redirects](https://developers.cloudflare.com/rules/url-forwarding/single-redirects/) (Rules → Redirect Rules). The hostname needs a proxied DNS record for the rule to run: add `AAAA @ 100::` (and `AAAA www 100::`) with the orange cloud on, if the host has no other record.

In the **anydoc.md** zone, create a rule:

- When incoming requests match: *Custom filter expression*
  `(http.host in {"anydoc.md" "www.anydoc.md"})`
- Then: *Dynamic* redirect, status **301**, preserve query string
  - Expression: `concat("https://scoop.md", http.request.uri.path)`

In the **scoop.md** zone, the same for www:

- `(http.host eq "www.scoop.md")` → Dynamic, 301, `concat("https://scoop.md", http.request.uri.path)`, preserve query string

Check with `curl -sI https://anydoc.md/library` → `301` and `location: https://scoop.md/library`.

## Placeholders for the owner

- `privacy@scoop.md` (contact and takedown address) and `[LEGAL ENTITY]` are defined in `src/lib/links.ts` and shown on `/privacy`, `/terms` and in the footer. The entity renders highlighted until replaced.
- `GITHUB_URL` in `src/lib/links.ts` is `https://github.com/sccop-md/scoop.md`.

## Layout

```
src/lib/api.ts           read-only API client, result types, hostname checks
src/lib/example.ts       the landing page's example package (same format as extension/lib/package.js)
src/lib/links.ts         GitHub, Chrome Web Store, contact placeholders
src/components/          Logo, ScoopFlow (the three-step demo), Unavailable, NotFound
src/pages/               index, library, [site], privacy, terms, 404
src/styles/global.css    colour tokens (light + dark), type, shared patterns
```

Fonts (Bricolage Grotesque, IBM Plex Sans, IBM Plex Mono) are self-hosted via Fontsource, so the site makes no third-party requests. The only client script is the example's Copy button.
