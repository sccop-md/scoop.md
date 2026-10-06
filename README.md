# scoop.md

**Scoop any doc.**

A "Scoop to agent" button that works on any documentation site. Click it on a docs page and you get one Markdown document on your clipboard, ready to paste into Claude Code, Codex, Cursor or any other coding agent.

Behind it is a shared library: once a package for a site has helped someone's agent implement their task, the next person on that site gets the same package.

## How a click works

1. **Shared library.** If the library has a skill for this site that people confirmed worked, copy it (plus the current page if the skill doesn't already cover it).
2. **What the site already publishes.** Look for the page's Markdown twin (`<page>.md`), `llms.txt` and `llms-full.txt`, at the site root and under the docs prefix. Files over 2 MB are not downloaded; the agent gets the link instead.
3. **Extraction.** Otherwise convert the page's main content to Markdown, and list related pages from the site's navigation so the agent can fetch more.
4. **Copy.** The package opens with its sources and a note telling the agent to treat the material as reference, not instructions.
5. **Feedback.** "It worked" / "It didn't" decides what the library serves next time.

Only material fetched without your cookies is shared with the library. If a page only renders when you're signed in, you still get it on your clipboard, but it's never uploaded.

## Run it

```sh
npm test                 # unit, HTTP and popup tests
npm run server           # shared library on http://localhost:8787/v1
npm run probe -- https://docs.stripe.com/webhooks   # see what a site publishes
npm run check:live       # scoop real sites and verify every section like the library would (network)
npm run pack:extension   # dist/scoop.md-extension-<version>.zip for the Chrome Web Store
npm run icons            # redraw extension/icons (needs python3 + Pillow)
```

Load the extension in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → pick the `extension/` folder. Click the toolbar icon on any docs page, or press Alt+Shift+C.

Settings (library URL, sharing on or off) are on the extension's options page. The library defaults to `https://api.scoop.md/v1`; use `http://localhost:8787/v1` with `npm run server`. Leave it empty to work without a library.

## Layout

```
extension/            Chrome MV3 extension
  lib/discover.js     finds .md twins and llms.txt files (no credentials)
  lib/extract.js      HTML → Markdown fallback, related links
  lib/scoop.js        builds a page's sections (shared by the popup and check-live)
  lib/library.js      api.scoop.md/v1 client; never throws, short timeouts
  lib/package.js      assembles the clipboard document within a size budget
  popup.js            the click flow
  STORE.md            Chrome Web Store listing, permissions, data disclosures
server/               shared library (Node, no dependencies, JSON file store)
scripts/probe.js      runs discovery against real sites
scripts/check-live.js scoops real sites and verifies each section with server/verify.js
test/                 node:test suites
```

## Library API

The extension talks to the v1 API specified in [docs/BACKEND.md](docs/BACKEND.md): `GET /v1/skills/best?site=`, `POST /v1/skills` (sections are verified against their live sources), `POST /v1/skills/:id/feedback` and `POST /v1/reports`. POSTs carry an anonymous install ID (`X-Scoop-Install`).

## Known limits (prototype)

- A site is identified by hostname. Different products on one host share a skill.
- "Worked" is a single button press, one vote per install.
- Extraction is heuristic: it takes the smallest element around the page's `<h1>` that holds most of the prose.

## License

MIT. See [LICENSE](LICENSE). Agent logos in `extension/agents/` and `site/public/agents/` come from [Simple Icons](https://simpleicons.org) (CC0); the brands belong to their owners.
