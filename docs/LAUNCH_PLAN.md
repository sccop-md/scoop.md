# Launch plan: where to post, what to say, and the video

Nothing here has been posted. Every item needs a person to press the button. Platform rules change: read each community's current self-promotion rules before posting, and don't post the same text in several places on the same day.

## Status

- **Chrome Web Store:** 0.6.3 submitted, pending review (it publishes automatically once approved). Listing images, promo tiles, privacy answers and distribution (free, public, all regions) are in.
- **Product Hunt:** scheduled Tue Oct 27, 12:01 AM PT. Copy in [PRODUCT_HUNT.md](PRODUCT_HUNT.md). The video slot is empty.
- **Site, GitHub (public, MIT):** live.

## Platforms, in order

| When | Where | Why | Notes |
|---|---|---|---|
| Launch day | Product Hunt | already scheduled | Reply to every comment in the first 12 hours. No vote requests. |
| Launch day, mid-morning US Pacific | Show HN | the audience that reads llms.txt, agents and dev docs | Link the site or the GitHub repo, not the store. Be around to answer for a few hours. Read the Show HN guidelines first. |
| Same week, one per day | Reddit: communities for the agents you support (Claude Code, Codex, Cursor) and r/chrome_extensions | people already pasting docs into agents | Tailor each post. Duplicates get suppressed. Check each subreddit's self-promotion rules. |
| Launch day | X and LinkedIn | the video, the Stripe example | Video natively uploaded, link in a reply. |
| Launch week | DEV (dev.to) or Hashnode post: "Stop pasting docs into your agent" | long-lived search traffic | Link the repo. |
| After the store approves | The llms.txt community lists: the `llmstxt-site` repo (open a pull request adding scoop.md's sites file), llmstxthub, and the Tally curated directory | the audience that cares about llms.txt | Verify each is still active first. Skip paid listings. |
| After approval | Developer-tool directories (daily.dev's roundup lists DevHunt and AlternativeTo) | slow, steady discovery | Submit once each. |

Sources for the platform list: [daily.dev developer tool directories](https://daily.dev/blog/best-developer-tool-directories/), [SaaSCity extension directories](https://saascity.io/blog/best-directories-chrome-extensions-2026), [llmstxt-site](https://github.com/generaltranslation/llmstxt-site). These are third-party guides, not official rules.

## Copy

**Show HN**

> Show HN: scoop.md – one click to give your coding agent a docs site's llms.txt
>
> I got tired of pasting docs into Claude Code. More developer sites now publish an llms.txt (an index for agents, often with install and usage instructions), but nobody knows where to find it. scoop.md is a Chrome extension: open a developer docs site, press the button, and a short prompt with the llms.txt link is on your clipboard. The agent reads the index and fetches only the pages it needs. If a site has no llms.txt, scoop.md builds one. It never reads the page you're on. Free, MIT. Feedback and pull requests very welcome: https://github.com/sccop-md/scoop.md

**X**

> Your coding agent is only as good as the docs you give it.
> scoop.md: open any developer docs site, press one button, paste into Claude Code, Codex or Cursor. It gets the site's llms.txt and instructions for agents, and fetches only the pages it needs.
> Free, open source. ⭐ the repo if it's useful: https://github.com/sccop-md/scoop.md
> [video]

**LinkedIn**

> I built scoop.md for a problem I kept hitting: getting a coding agent the right documentation without pasting a whole docs site into it. It's a free, open-source Chrome extension. Open a developer docs site, click the button, and a short prompt with the site's llms.txt is on your clipboard. Your favorite developer docs are already covered; if a site has no llms.txt, scoop.md builds one. I'm looking for feedback and for pull requests from anyone who likes the idea. [video] [link]

**Reddit** (adapt per community; lead with the problem, not the product)

> Title: I made a one-click way to hand any developer docs site to your coding agent (free, open source)
> Body: the problem in two lines, a 20-second clip, the repo link, and a direct ask: "What docs do you wish had an llms.txt?" Do not ask for upvotes.

## The video (45 seconds, screen capture, no talking head)

Developers respond to the real workflow on screen. Keep it to one flow.

| Time | On screen | Caption / voiceover |
|---|---|---|
| 0:00–0:04 | Claude Code with a task: "add Stripe webhooks". | "Your agent needs the docs." |
| 0:04–0:12 | Open docs.stripe.com/webhooks, click the scoop.md icon. Popup shows "Copied". | "One click." |
| 0:12–0:20 | Paste into Claude Code. The prompt shows the llms.txt link. | "Paste it." |
| 0:20–0:34 | The agent reads the index and fetches only the pages it needs, then writes the handler. | "It reads the index and fetches only what it needs." |
| 0:34–0:41 | Cut to docs.python.org: popup says "Made by scoop.md". | "No llms.txt? scoop.md builds one." |
| 0:41–0:45 | End card: scoop.md, "Free and open source", GitHub star prompt. | "Star it, and tell me what to improve." |

Cuts: 30 to 45 seconds for X, 45 to 90 for LinkedIn, the same cut for Product Hunt. Lengths come from third-party guides ([FlowJam](https://www.flowjam.com/blog/devtools-launch-video), [Advids](https://advids.co/blog/developer-tool-demo-videos-code-on-screen)), so treat them as rules of thumb. Add burned-in captions: most feeds autoplay muted.

## Asks to put in every post

1. A GitHub star.
2. Feedback: which developer docs should it cover next?
3. Pull requests: say what kind (new sites, popup polish, other browsers).
