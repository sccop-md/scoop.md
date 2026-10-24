# Product Hunt launch: scoop.md

Everything the "Launch a product" form asks for. Character limits are Product Hunt's.

## Listing

**Name (≤ 40):** scoop.md

**Tagline (≤ 60):** Scoop any doc's llms.txt for your coding agent

Alternatives:
- One click to give your coding agent any docs site
- A "Scoop to agent" button for every documentation site

**Description (≤ 260):**
A Chrome extension. Open any docs site, click scoop.md, and the site's llms.txt plus its instructions for agents are on your clipboard as a short prompt. Paste it into Claude Code, Codex or Cursor. No llms.txt? scoop.md builds one. Free and open source.

**Topics:** Developer Tools, Artificial Intelligence, Chrome Extensions, Open Source

**Links**
- Website: https://scoop.md
- Chrome Web Store: the live listing (the hero button on scoop.md links to it)
- Source: the GitHub repository (MIT)

**Pricing:** Free. **Open source:** yes.

## Gallery (in order)

Product Hunt wants 1270×760 images; the 1280×800 store images are close, so crop to 1270×760 or export fresh.

| # | File | Caption |
|---|---|---|
| 1 | `extension/store-assets/promo-marquee-1400x560.png` (or a 1270×760 recut) | Scoop any doc's llms.txt |
| 2 | `extension/store-assets/1-stripe.png` | On docs.stripe.com: the llms.txt and Stripe's own instructions for agents, copied |
| 3 | `extension/store-assets/3-python.png` | No llms.txt? scoop.md prepares one and hosts it |
| 4 | `extension/store-assets/6-badge.png` | The toolbar badge: 1 = llms.txt, 2 = llms.txt + instructions |
| 5 | `extension/store-assets/5-not-developer.png` | Not a developer site? It says so and copies nothing |

**Thumbnail:** `site/public/icon-512.png`.
**Video (optional but lifts engagement):** 20 to 30 seconds. Open a docs page, click the icon, paste into Claude Code, and the agent fetches just the page it needs.

## Maker's first comment

> Hey Product Hunt, I'm Dominic, the maker of scoop.md 👋
>
> Coding agents are only as good as the docs you hand them. Pasting a whole docs site burns context; pointing an agent at a homepage makes it guess. More and more sites publish an `llms.txt`: an index written for agents, often with instructions on how to install and use the product. Almost nobody knows where to find it.
>
> scoop.md is the button that finds it. Open any documentation site, click the icon (or Alt+Shift+C), and you get a short prompt on your clipboard:
>
> `Stripe docs for agents: https://docs.stripe.com/llms.txt — read it first, then fetch only the pages you need.`
>
> Paste it into Claude Code, Codex, Cursor, or whatever you use. The agent reads the index and fetches only what the task needs.
>
> What it does:
> - Copies the site's llms.txt together with the site's own instructions for agents
> - Works from anywhere on a site: on stripe.com it finds docs.stripe.com
> - If a site has no llms.txt, scoop.md builds one (getting-started first) and hosts it at scoop.md/<site>/llms.txt
> - A toolbar badge shows "1" when a site has an llms.txt and "2" when it also has agent instructions
> - Never reads the page you're on. It asks for the llms.txt by the site's address
>
> It's free and open source (MIT). I'd love to know: which docs sites do you wish had an llms.txt? I'll make sure scoop.md covers them.

## Replies to likely questions

- **How is this different from pasting the docs?** It sends a link, not the content. The agent fetches only the pages the task needs, so your context stays small.
- **What data does it collect?** It never reads the page. Opening the popup sends the site's origin and first path segment to look up the llms.txt. Anonymous usage statistics can be turned off in Settings. Details at scoop.md/privacy.
- **Does it work with my agent?** Any agent that can read a URL: Claude Code, Codex, Cursor and others.
- **Is it free?** Yes, and open source under MIT.
- **Firefox / Safari?** Chrome first; tell us what you need.

## Launch checklist

- [ ] Schedule for 12:01 AM Pacific on a Tuesday to Thursday
- [ ] Gallery images uploaded at 1270×760, thumbnail set
- [ ] First comment posted the minute the page goes live
- [ ] Tell people who know the product to leave real comments, not just upvotes (no vote-asking links; Product Hunt penalises them)
- [ ] Reply to every comment within the hour for the first 12 hours
- [ ] Check api.scoop.md capacity and the usage dashboard before launch (see the admin dashboard)
