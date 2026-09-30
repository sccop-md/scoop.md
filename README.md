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
npm test          # unit and HTTP tests
npm run server    # shared library on http://localhost:8787
npm run probe -- https://docs.stripe.com/webhooks   # see what a site publishes
```

Load the extension in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → pick the `extension/` folder. Click the toolbar icon on any docs page, or press Alt+Shift+C.

Settings (library URL, sharing on or off) are on the extension's options page. Leave the library URL empty to work without a library.

## Layout

```
extension/            Chrome MV3 extension
  lib/discover.js     finds .md twins and llms.txt files (no credentials)
  lib/extract.js      HTML → Markdown fallback, related links
  lib/package.js      assembles the clipboard document within a size budget
  popup.js            the click flow
server/               shared library (Node, no dependencies, JSON file store)
scripts/probe.js      runs discovery against real sites
test/                 node:test suites
```

## Library API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/skills/best?site=<host>` | Most recent skill confirmed to work, or `null` |
| POST | `/api/skills` | Save `{ site, sources, content }` |
| POST | `/api/skills/:id/feedback` | Record `{ worked: true \| false }` |

A skill is served only once it has at least one "worked" and more "worked" than "didn't". Among those, the most recently confirmed one wins.

## Known limits (prototype)

- A site is identified by hostname. Different products on one host share a skill.
- The server trusts clients to send only public material; it doesn't re-fetch sources to check.
- "Worked" is a single button press. There's no versioning and no protection against spam votes yet.
- Extraction is heuristic. Sites without a `<main>` or `<article>` element can leak header links into the output.
