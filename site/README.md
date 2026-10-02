# scoop.md website

The site at https://scoop.md: landing page, the shared library browser, privacy policy and terms. Astro 7 with the Vercel adapter, deployed to the Vercel project `scoop-md-site`. Static pages are served from Vercel's CDN; library pages render in a Vercel Function.

| Route | Rendering | Data |
|---|---|---|
| `/` | prerendered | none |
| `/privacy`, `/terms` | prerendered | none |
| `/library` | on demand | `GET {API}/v1/sites?limit=100` |
| `/<site>` e.g. `/docs.stripe.com` | on demand | `GET {API}/v1/sites/<site>` |

Static routes and files win over `/<site>`. Anything that isn't a hostname gets the 404 page without calling the API; `Docs.Stripe.com` and `www.` hosts 301 to the normalised site. When the API says 404 the page answers 404 ("No scoops for … yet"); when it's unreachable, library pages answer 503 with a "library unavailable" notice instead of failing.

Library pages send `Cache-Control: public, max-age=60, s-maxage=60`, which Vercel's CDN honours. Errors are cached for 10 s at most.

## Commands

```sh
npm install
npm run dev       # http://localhost:4321
npm run build     # .vercel/output (Build Output API)
npm run deploy    # vercel deploy --prod
```

Deploys need `vercel login` with access to the project. Pushes to `main` also deploy once the project is connected to the GitHub repo (root directory `site`).

### Against a local library

```sh
# repo root: the reference API on :8787
PORT=8787 ALLOW_LOCALHOST=1 node server/server.js

# site/
PUBLIC_API_URL=http://localhost:8787 npm run dev
```

Shell variables reach the dev server directly; `site/.env` (gitignored) works too.

## Environment

| Variable | When it's read | Default | Purpose |
|---|---|---|---|
| `PUBLIC_API_URL` | Runtime, else build time | `https://api.scoop.md` | Library API base URL. Set it in the Vercel project's environment variables to point at staging. |
| `PUBLIC_CHROME_STORE_URL` | Build time | unset | Chrome Web Store listing. When unset, the hero button reads "Coming soon to the Chrome Web Store" and links to GitHub. Set it in the Vercel project's environment variables and redeploy. |

## Domain

DNS for scoop.md stays on Cloudflare; the site is served by Vercel.

1. In Vercel: project `scoop-md-site` → Settings → Domains → add `scoop.md` and `www.scoop.md` (redirect www to the apex).
2. In Cloudflare DNS for scoop.md, create the records Vercel shows. Typically `A @ 76.76.21.21` and `CNAME www cname.vercel-dns.com`, both **DNS only** (grey cloud) so Vercel can issue the certificate.
3. `api.scoop.md` is separate: it points at the Cloudflare Worker (docs/BACKEND.md), so leave it as Cloudflare configures it.

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
