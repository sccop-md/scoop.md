# Chrome Web Store listing: scoop.md

Everything the Web Store dashboard asks for, matching what the code in this folder does (version 0.6.2). Build the upload with `npm run pack:extension` → `dist/scoop.md-extension-<version>.zip`. This file and the artwork in `store-assets/` aren't included in the zip.

## Store listing

**Name:** scoop.md

**Summary (≤ 132 chars):**
Scoop any doc. One click copies the site's llms.txt and its instructions for agents for your coding agent.

**Category:** Developer Tools

**Language:** English

**Description:**

> Scoop any doc.
>
> scoop.md gives your coding agent the docs of the site you're on, the way agents read them best: the site's llms.txt. Click it on any documentation site and a short prompt with the llms.txt link is on your clipboard, ready to paste into Claude Code, Codex, Cursor or any other coding agent. Your agent reads the index and fetches only the pages it needs.
>
> • The site's llms.txt and its instructions for agents (how to install, set up and use it), with one button to copy both. The site's own llms.txt when it has one; when it doesn't, scoop.md prepares one, getting-started first, and hosts it at scoop.md/<site>/llms.txt.
> • Works from anywhere on the site: on stripe.com it finds the docs at docs.stripe.com.
> • A site scoop.md can't help with (a shop, a search engine)? It says so, and copies nothing.
> • The toolbar icon shows "1" on sites with an llms.txt and "2" when they also have instructions for agents, looked up in a list kept on your device.
>
> scoop.md never reads the page you're on: it asks for the site's llms.txt by the site's address.
>
> Usage statistics: scoop.md sends anonymous usage events (which sites you open it on, whether their llms.txt was copied, version, browser and OS, errors) so we can see what to fix. Never page content. The first time you open scoop.md it tells you, with a button to turn it off; you can also turn it off in Settings ("Send usage statistics").
>
> Keyboard shortcut: Alt+Shift+C.

**Homepage:** https://scoop.md
**Support:** https://scoop.md (contact link on the site)
**Privacy policy URL:** https://scoop.md/privacy (it must say what the "Data usage" section below says)

## Single purpose

Copy the llms.txt of the documentation site the user is on (and its instructions for agents) to the clipboard as a short prompt for a coding agent.

## Permission justifications

| Permission | Justification |
|---|---|
| `clipboardWrite` | Put the llms.txt prompt on the clipboard. That's the extension's only output. |
| `storage` | Remember settings (usage statistics on/off, theme), an anonymous random install ID, whether the first-run note and the pin hint were dismissed, the list behind the toolbar badge and what the popup learned for sites it was opened on (7 days), and the queue of usage events not yet sent (at most 500). |
| `alarms` | Wake the extension's service worker once an hour to send the once-a-day "active" usage event and any queued usage events, and to retry sending with backoff when the network was down; and every 6 hours to download the list of sites with an llms.txt (`GET /v1/sites/index`, with If-None-Match) that the toolbar badge is looked up in. No usage events are sent when usage statistics are off. |
| Host permission `<all_urls>` | Documentation lives on any domain. The service worker reads the address of the active tab when it is activated or finishes loading, to show on the toolbar icon whether that site has an llms.txt ("1", or "2" with instructions for agents): the site is looked up in a list downloaded to the device (and in the library's answers for sites the user opened the popup on, kept on the device for 7 days), so no request is made per page, and private-network hosts are never looked up (no "tabs" permission is used). When the library at `https://api.scoop.md` doesn't answer, the popup looks for the site's own `llms.txt` itself, **without cookies**: a cross-origin request to the site the user is on, which isn't known in advance. No content scripts; the page itself is never read. |

**Remote code:** No. All JavaScript ships in the package. The extension downloads only text (llms.txt files and JSON from the library), which is never executed.

## Data usage (privacy practices tab)

Data the extension **collects** (sends off the device). The llms.txt lookup happens only when the user opens the popup. Usage statistics (`POST https://api.scoop.md/v1/events`, on by default, off with "Send usage statistics" in Settings) are sent in batches when the popup closes and hourly from the service worker; the full event list is in docs/TELEMETRY.md and on scoop.md/privacy. **Prominent disclosure:** the first popup shows "scoop.md sends anonymous usage statistics, including the hostname of the sites you open it on." with [Turn off] and [OK]; until it has been shown, events carry no hostname.

| Category | Collected? | What exactly |
|---|---|---|
| Web history | Yes | When the popup opens, the page's **origin and the first segment of its path** (e.g. `https://app.example.com/docs`; never the rest of the path, the query or the fragment) are sent to `api.scoop.md` (`GET /v1/llms?url=`) to get the site's llms.txt. Nothing is sent, not even the hostname, for pages on the user's computer or a private network (localhost, private and link-local IP addresses, single-label hosts, `.local`, `.internal`, `.lan`, `.home.arpa`). Usage statistics record the **hostname** of the site the popup was opened on, never a path; for private hosts (also `.corp`, `.home`, `.intranet`, `.onion`, `.test` and similar), nothing. To set the toolbar icon, the service worker reads the address of the tab you switch to or that finishes loading and compares its hostname with a list downloaded to the device; this stays on the device and is never sent. Browsing history beyond the site the popup was opened on is never sent. |
| Website content | No | The extension never reads or sends the content of the pages you visit. |
| User activity | Yes | App usage events: install, update, browser update, a once-a-day "active" ping, popup opened/closed (with how long it was open), each copy of a site's llms.txt (`llms_copy`: the hostname, whether the llms.txt was the site's own or prepared by scoop.md, on opening or with the button), the "copied" animation being shown (and whether reduced motion is on), an hourly count of toolbar badges shown ("1" and "2", no sites), settings changes (theme, usage statistics), the settings page being opened, and error codes with a short message stripped of URLs. Each event has a timestamp, a per-popup session ID and the install ID, plus the extension version, browser name and version, OS, CPU architecture, UI language and time zone. |
| Location | Yes | **Coarse location** (country, region, continent) and the network's ISP or organisation name, derived on the server from the request's IP address by Cloudflare. The IP address itself is never stored. For abuse analysis a hash of it is kept, made with a random key created each day and deleted after 48 hours (so a hash can't be traced back or linked across days once its key is gone); the hash itself is deleted after 30 days and never archived. Library requests from an extension with usage statistics off are not recorded. |
| Personally identifiable information | No | The extension sends a random install ID (UUID created on install, stored locally) with usage events, plus its version (`X-Scoop-Client: extension/0.6.0`). The ID isn't linked to any account, name or email. No names, emails, Google account, cookies or IP addresses are stored. |
| Authentication, financial, health, personal communications | No | |

Requests to the documentation site itself (`llms.txt`, only when the library doesn't answer) go to the site the user is on, without cookies or credentials.

Stored on the device only: the usage-statistics setting (`chrome.storage.sync`), theme, install ID, first-run flag, the badge list and learned answers, and the unsent usage-event queue (`chrome.storage.local`).

Uninstall: the extension sets its uninstall page to `https://scoop.md/bye#i=<install ID>&v=<version>` (just `https://scoop.md/bye` when usage statistics are off). The ID is in the fragment, which browsers never send to a server; the page sends no Referer. That page records the uninstall, and an optional reason the user picks, against the install ID.

Retention: raw usage events are kept 180 days in the database, then deleted; daily counts (no install IDs) are kept. Every raw event (without the IP hash) is also archived (compressed) for 13 months. Deletion requests by install ID (team@ddamoah.com) remove the install's events from the database and exclude them from every export of the archive until those archive objects expire.

Certifications to tick:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Store artwork

In `store-assets/` (copies in `dist/store/`), taken in Chrome with the released 0.6.0 zip against production (api.scoop.md) and composed with the popup at the top right (1280×800, light theme). Sources: scratchpad/ux-evidence/060-prod/store/.

| File | Size | Shows |
|---|---|---|
| `1-stripe.png` | 1280×800 | docs.stripe.com/webhooks: the llms.txt field (docs.stripe.com/llms.txt, "513 pages · checked today · found in 0.3s"), Instructions for agents (Stripe's, collapsed with "Show all ⌄") and "Copied ✓" |
| `2-twilio.png` | 1280×800 | twilio.com: www.twilio.com/docs/llms.txt with Twilio's instructions for agents, copied |
| `3-python.png` | 1280×800 | docs.python.org: scoop.md/docs.python.org/llms.txt, prepared by scoop.md ("by scoop.md" badge, 322 pages) with install instructions, copied |
| `4-hono.png` | 1280×800 | hono.dev: an llms.txt only (no instructions): "Copy llms.txt", copied; the toolbar shows "1" |
| `5-not-developer.png` | 1280×800 | a site on the denylist (amazon.com): "scoop.md has nothing to copy for this site." and nothing else |
| `6-badge.png` | 1280×800 | The toolbar badge close-ups: "2" on docs.stripe.com, "1" on hono.dev, nothing on example.com |
| `promo-small-440x280.png` | 440×280 | Small promo tile: the icon with the "2" badge, "scoop.md", "Scoop any doc's llms.txt" and the "Copy llms.txt + instructions" button on #ffeee0 |
| `promo-marquee-1400x560.png` | 1400×560 | Marquee: "Scoop any doc's llms.txt" with the docs.stripe.com popup (llms.txt field, instructions for agents, "Copied ✓") and the toolbar icon showing "2" |
