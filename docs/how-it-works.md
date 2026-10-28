# How Lede works

## Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:8787. `npm run dev` serves sample data, so no Cloudflare account is needed. `npm test` runs the tests.

## Deploy from the command line

Turn on Analytics Engine once for your account: in the Cloudflare dashboard, Storage & databases, Analytics Engine, Enable. Then:

```bash
npx wrangler deploy
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put ANALYTICS_TOKEN
```

For the token, [create one with this link](https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22account_analytics%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&accountId=%2A&zoneId=all&name=Lede). It comes with the two permissions Lede needs already chosen: Account Analytics Read, to read the stats, and Account Settings Read, to find which account they're in.

The first deploy creates the `STORE` KV namespace. The Analytics Engine dataset is created when the first event arrives. Open the Worker's address, type your site's address, and add the line it shows to every page:

```html
<script defer src="https://lede.<your-subdomain>.workers.dev/t.js"></script>
```

Lede reads your account ID from the token. If the token works for more than one account, run `npx wrangler secret put ACCOUNT_ID` and paste the ID of the account Lede runs on.

## The dashboard

Home tells the period's story: the visitor total, a sentence saying what changed and why, a small crowd of who is here now, then four tiles that each answer one question: when (daily visitors against the previous period), from where to where (a Sankey from source to landing page), did they stay (bounce as rows of ten squares) and what they read (a page treemap). Click any tile, block, flow or underlined name to zoom in; Esc zooms out. Colour says what kind of thing a mark is: visitors over time are blue, sources amber, pages violet, bounce red, people here now green.

Every view has its own address, so refresh and the back button work and a link opens the same view: `/overview`, `/bounce`, `/online`, `/events`, `/sources`, `/pages`, `/sources/google.com` (`/sources/direct` for no referrer), `/channels/ai`, `/page/docs/install` (`/page/` is the home page). `?days=7` and, with more than one site, `?site=` ride along. See `public/routes.js`. A source's address with a channel on it (`/sources/google.com?channel=search`) opens the source's own view; the channel is dropped.

Who is here now refreshes every minute, and when you come back to the tab: on home, and on the Online view while it's showing.

A page's view shows how long the page is read on average and how far down people scroll. It and the overview end with the links people clicked: links to other sites, and files they downloaded. Neither shows until the tracker has sent some.

A goal is a page that means a visitor did something, such as `/signup`. Flag it from the Pages list or a page's view, or answer the question on home when a page looks like one. Click the flag again to stop tracking it.

## Pieces

| Piece | Where |
|---|---|
| Tracker (`/t.js`) | `public/t.js`, served as a plain static file, so loading it is free and needs no password. Sends `{page URL, referrer, landing query}` with `fetch` and `keepalive` (not `sendBeacon`, whose pings tracker blockers drop while it still reports success), including on single-page-app navigation and back/forward restores. Replacing the address (`replaceState`) counts as a view only when the path changes, as on an endless page scrolling into the next, and only once it has stayed on the new path for 5 seconds, so scrolling back and forth across the border between two pages isn't a view each time; a changed query or hash alone is the site tidying its address. Anchor jumps on the same page aren't views, and a prerendered page counts only once it's opened. Also sends one engagement event as each page view ends, clicks on links to other sites and on files, and a ping every 3 minutes while the tab shows (see below). |
| Collect (`POST /lede`) | `src/collect.js`. Drops bots, data-centre traffic, referrer spam, unknown sites and beacons sent from another site's page (see [What isn't counted](#what-isnt-counted)), works out the channel, hashes the visitor, writes one data point per event. Not `/api/event`: blocklists such as EasyPrivacy block that path on `workers.dev`, because self-hosted Plausible uses it (the old path still works for cached trackers). |
| Stats API (`GET /api/*`) | `src/api.js` and `src/queries.js`. Runs SQL against Analytics Engine through the SQL API and keeps answers for 60 s (15 s for live). Changes (`POST`/`PUT`) are only accepted from the dashboard's own origin. |
| Dashboard (`/`) | `public/index.html`, with the story logic (what the sentences say, the bounce split, the waterfall, the crowd) in `public/story.js`, which `test/story.test.js` covers. The crowd's figures are [Wee People](https://github.com/propublica/weepeople) by ProPublica (CC BY-NC-ND 3.0), in `public/weepeople.woff2`. |
| Password (`POST /api/signin`) | `src/index.js`. When `DASHBOARD_PASSWORD` is set, the stats answer only with a cookie that holds a hash of it; the dashboard page shows its own password card until then. Changing the password signs everyone out. |
| Settings | `src/settings.js`. Sites, each month's visitor salt, the account ID and goals, kept in the `STORE` KV namespace. |
| Sample data | `src/demo.js`, used when `DEMO="true"` (`npm run dev` sets it). |

Each event is one data point, indexed by site. The blob order is defined once in `src/schema.js`:
site, path, url, referrer, channel, visitor, visit, type, country, utm_source, utm_medium, utm_campaign, target.
New fields only go at the end, so rows already stored keep their meaning. `type` is `pageview`, `engagement`, `outbound` or `download`; rows from before there were other types are all page views, and every page-view stat filters on it. Engagement figures are doubles: `double1` is engaged milliseconds, `double2` scroll depth in percent. `target` is the clicked link's host and path, without its query.

### Metric definitions

- **Visitor:** a hash of a monthly salt + site + IP + user agent. IPs are never stored. Each month's salt is random and deletes itself from KV the day after the month ends, so IDs can't be linked across months, even by you.
- **Visit:** a visitor's page views from the clock hour the visit started. The tracker remembers that hour per tab, so a visit that runs past the hour stays one visit until half an hour passes without a page. A new tab starts from the current hour.
- **Your own visits:** run `localStorage.lede_ignore = 1` in the browser console on your site, and that browser is left out.
- **Bounce rate:** share of visits with a single page view.
- **Visit duration:** time between the first and last view of multi-page visits, divided by all visits.
- **Entry / exit page:** first / last page of a visit.
- **Source:** the referrer of the page the visit started on. The tracker keeps it in `sessionStorage`, so later pages of the visit still credit it. Redirectors, mobile hosts and Android apps go by the site's own name (`l.facebook.com` → `facebook.com`, `t.co` → `x.com`, `android-app://com.google.android.gm` → `mail.google.com`); see `src/channels.js`.
- **Channels:** paid (ad click IDs or a paid `utm_medium`), email, AI assistants, search, video, social, referral, direct. See `src/channels.js`.
- **Time on page:** how long a page view was in front of someone, averaged over the views that sent an engagement event. It only runs while the tab is visible and its window has focus, stops counting at 30 minutes, and a view under a second sends nothing (so it isn't averaged in). The event goes once per page view, when it ends: the tab is hidden or closed, or a single-page app moves to the next page. Add `data-engagement="false"` to the script tag to turn it off.
- **Scrolled:** how far down the page the bottom of the window got, as a share of the page's height, averaged the same way. A page that fits on the screen is read to the end. It's taken on scroll, a second after the view starts, and when the tab is hidden or closed, but not when a single-page app moves on: by then the next page is usually drawn, and its height would be taken for the page being left.
- **Here now:** anyone whose last page view or ping was in the last 5 minutes. A tab that shows pings every 3 minutes, counted from its last page view or ping, so someone reading one page for a long while stays here; a window in the background counts while its tab shows, a hidden tab doesn't, and coming back to a tab after 3 minutes or more pings at once. Pings count nowhere else: not as views, visits or bounces.
- **Outbound links and downloads:** clicks (and middle clicks) on a link to another host, and on a link to a file such as a PDF, ZIP, DMG, EXE, CSV, Office document or audio and video file, on any host. Counted by visitors, credited to the page and the visit's source like a page view. The link's query is never sent, since links often carry a token or an email address.
- **Why bounce changed:** the change splits into who visited (last period's bounce per source, weighted by this period's mix, minus last period's rate) and how each source behaved (its visits × its own change in bounce, over all visits). Whatever is left (other sources, sources new this period) is "everyone else", so the parts add up to the total.

### What isn't counted

Each filter is in `src/bots.js`. A dropped beacon gets the same empty answer as a counted one, so a script can't tell which rule caught it.

- **Bots by name:** user agents that say they're a crawler, a monitor, a headless browser or an HTTP library (`bot`, `spider`, `HeadlessChrome`, `curl`, `python`…), and requests Cloudflare marks as a verified bot.
- **User agents no browser sends** (after [Pirsch](https://github.com/pirsch-analytics/pirsch)): 16 characters or fewer, more than 500, anything outside plain ASCII, one that is only an IP address, a UUID or a hash, a Firefox whose `rv:` doesn't match its version (except the `rv:109.0` Firefox 110–119 sent), and browsers older than any device that still updates: Chrome before 90, Firefox before 78, Safari before 12 and Internet Explorer before 11. The versions aren't checked for browsers that ship an old engine on purpose or run where it never updates: Android webviews (`; wv)`, whose engine belongs to the app, or to a system webview that phones without Google Play never update), the Chinese browsers and apps that bundle their own frozen Chromium (WeChat's TBS and XWEB, QQ Browser, the Baidu app, Quark, Sogou, and the MIUI, Huawei, OPPO and vivo browsers), UC Browser, Samsung Internet, smart TVs, Tesla, KaiOS, Pale Moon, SeaMonkey and Waterfox. Safari is judged by its `Version/`, so iOS in-app browsers (Instagram, Facebook, LinkedIn), which send none, and Android webviews, which send a fake `Version/4.0`, are left alone. The cost: Android 4.4 or older, iPhone 5 or older and OS X 10.10 or older aren't counted.
- **Data centres:** beacons from the networks of AWS, Google Cloud, Azure, Oracle Cloud, Alibaba Cloud, Tencent Cloud, DigitalOcean, Hetzner, OVHcloud, Linode, Vultr, Contabo and Scaleway (by `request.cf.asn`). People don't browse from servers, but scrapers do. Google's main network (AS15169) is left in, because Pixel's VPN and Google Fi use it, and so are Cloudflare, Fastly and Akamai's CDN, which iCloud Private Relay and similar privacy proxies exit through. Visitors on a cloud desktop (Windows 365, Amazon WorkSpaces) or a VPN hosted at one of those providers aren't counted. To count them, add `"KEEP_DATACENTER": "true"` to `vars` in `wrangler.jsonc`.
- **Referrer spam:** visits whose source is on [Matomo's referrer spam list](https://github.com/matomo-org/referrer-spam-list) (public domain), or a subdomain of one. The list is copied into `src/spam.js`, with the command to refresh it at the top. Its hosts are matched exactly, so a real site that only looks like spam stays.
- **Global Privacy Control:** off by default, since Lede stores nothing that identifies a person. Add `"RESPECT_GPC": "true"` to `vars` and beacons from browsers that send `Sec-GPC: 1` aren't counted (Brave and DuckDuckGo send it by default; Firefox and privacy extensions such as Privacy Badger when it's turned on).

### API

All stats routes take `site`, `days` (1–45), `tzName` (the viewer's time zone, such as `America/New_York`), `tz` (`Date#getTimezoneOffset()`, used when `tzName` is missing or unknown), and optional filters `path`, `referrer` (`""` = direct) and `channel`.

Days run from local midnight to local midnight in `tzName`, so the day the clocks change is 23 or 25 hours long (23.5 or 24.5 on Lord Howe Island), as it really was. With only `tz`, one offset is used for the whole period. Today is only partly over, so the previous period stops at the same time of day.

- `GET /api/sites`
- `GET /api/summary` → visitors, visits, views, bounce, duration for the period and the one before, and `sampled: true` when Analytics Engine kept only a sample of some of this period's views
- `GET /api/series` → the same metrics per day, plus each day's top source and how many visitors it sent
- `GET /api/breakdown?dim=path|entry|exit|referrer|channel|country` (referrer rows also carry the channel the host falls in)
- `GET /api/flows` → visitors by the source a visit came from and the page it landed on
- `GET /api/firsts` → the day each page and source was first seen in the period
- `GET /api/hourly` → visitors per hour of the period, counted in whole days back from today's local midnight, so today's hours match the clock even after a daylight-saving change earlier in the period
- `GET /api/live` → visitors in the last 30 minutes, with who is active in the last 5
- `GET /api/conversions?goal=/signup&goal=/thanks` → visits per source, and how many of them viewed a goal page
- `GET /api/engagement` → per page: page views that sent an engagement event, average seconds on the page and share scrolled, with last period's
- `GET /api/links` → `outbound` links and `downloads`, each with visitors, clicks and last period's visitors
- `GET /api/sites` → the sites Lede counts; `POST /api/sites` with `{"site": "example.com"}` adds one
- `GET /api/goals` → the site's goals; `PUT /api/goals` with `{"goals": [...]}` saves them

### Limits

- Analytics Engine keeps data for 3 months, so periods are capped at 45 days (the comparison period doubles that).
- Every event is one Analytics Engine write and one Worker request. Engagement adds roughly one write per page view (a little less: glances under a second and some closed tabs never send one), and link clicks a few more, so a site writes about twice as many data points with it on. The Workers Free plan allows 100,000 Analytics Engine writes and 100,000 Worker requests a day: about 100,000 page views a day without engagement, or about 50,000 with it. Past that, add `data-engagement="false"` to the script tag, or move to Workers Paid.
- At very high volume Analytics Engine samples data. View counts, and engagement averages, are corrected with `_sample_interval`; distinct visitor counts are not. Bounce counts the events stored for a visit, so a sampled single view still counts as one page. When this happens in a period, home says so under the sentence.
- Each comparison (summary, days, breakdowns, flows, engagement, link clicks) is one SQL query covering both periods, with each row labelled by period. Lists keep each period's top rows (100 for breakdowns, 200 for engagement and links); SQL here has no `LIMIT BY`, so the query asks for more (ten times as many for breakdowns and those lists, twice as many for flows) and Lede trims each period. When one period fills that whole answer, as after a tenfold change in traffic on a site with hundreds of pages, the other period is asked for on its own.
- Stats answers are kept for 60 s (15 s for live) in each Worker instance and, on a custom domain, in Cloudflare's edge cache too (Cloudflare documents the Cache API for custom domains, not `workers.dev`).
- Filter values reach SQL hex-encoded (`hex(blob2) = '…'`), because the SQL API documents no string escaping.
