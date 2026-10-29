# How Lede is built

This page is for anyone, person or agent, changing Lede. What Lede does and how an owner runs it is in [How Lede works](how-it-works.md); why it exists and what wins when goals conflict is in [GOALS.md](../GOALS.md).

## Before you change anything

### Rules that must hold

- **Fields go at the end.** Each event is one Analytics Engine data point, and rows already stored keep their meaning only if new fields are added after the old ones (`src/schema.js`). All 20 blobs are used, so a new text field means giving one up; 10 of the 20 doubles are free.
- **The tracker is built and committed with its source.** `src/tracker.js` is the source, with its comments; `npm run tracker` writes `public/t.js` from it, minified with esbuild (a pinned dev dependency). Commit both: `test/tracker-build.test.js` fails when they differ, and the tracker tests run on both.
- **`public/story.js` has no DOM or browser code.** The Worker imports it (`src/api.js` for the second line, `src/alerts.js` for the weekly message, `src/insight.js` for its formatting, `src/demo.js` for the Online view's usual), and so do the tests.
- **Functions in `public/index.html` stay top-level, with their closing `}` in the first column.** `test/screens.test.js` finds each function by name and cuts it at the first `\n}\n`, then checks the source with regexes.
- **The demo answers everything the Worker does.** `npm run dev` and the published demo run on `src/demo.js`, so every store method needs a demo twin, and the sample must tell the story the tests expect on every weekday (`test/weekdays.js`).
- **Every query has a bench fake.** `bench/fakes.mjs` answers the bench's queries by their SQL aliases; a query it doesn't know gets the summary row, and the counts go wrong.
- **Every error says what to do next,** in the dashboard or in the Worker's logs.
- **Every change is measured.** What a cost may buy, the floors no change goes below, and how the owner accepts a price are in [GOALS.md](../GOALS.md#when-a-change-costs-more); how to run the bench is under [Measuring changes](#measuring-changes).
- **Docs state rules and reasons,** not history: what changed and why goes in the commit message.

### Running it

```bash
npm install
npm run dev      # the dashboard on sample data at http://localhost:8787
npm test         # node --test, every file in test/
npm run tracker  # rebuild public/t.js after changing src/tracker.js
npm run demo     # build the static demo into a temporary folder, which it prints (--out picks another)
npm run bench    # measure this working copy against bench/baseline.json
```

`npm run dev` runs `wrangler dev --local` with `DEMO="true"`, so it never reaches Cloudflare: every answer comes from `src/demo.js`. Workers AI has no local stand-in, so the second line is the sample's fixed text (`DEMO_INSIGHT`). `--test-scheduled` opens `/__scheduled?cron=…`, which runs a schedule and prints its messages.

`npm run demo` builds the dashboard plus the Worker bundled for the browser with `DEMO="true"`; `demo/runtime.js` answers the dashboard's `/api/*` calls by running `src/index.js` in the page, with an in-memory KV. `.github/workflows/demo.yml` publishes it to https://sryo.github.io/lede/ on every push to `main`, so the demo costs nothing on Cloudflare and visitors can't use up its free limits. The copy has no sign-in, calls no Workers AI, can't make read-only links, and keeps saved goals, funnels and notes in memory until the page reloads. The repo's owner has to turn Pages on once, in Settings, Pages, with Source set to GitHub Actions; until then the workflow stops before it publishes anything. The workflow runs only in `sryo/lede`, so the copy the Deploy to Cloudflare button makes in an owner's account skips it.

## Change recipes

| Change | Start at | Also touch | Tests | Bench |
|---|---|---|---|---|
| A card on the overview | `renderFilter(x, {})` in `public/index.html` (the overview is the filter view with no filter); the cards' markup is its template | fetch with `api(route)`, check `stale(body, gen)` before drawing; reuse an answer another card already asks for when you can | the card order regex in `test/screens.test.js`, and `test/funnel.test.js`'s check that funnels come after By weekday and hour | `/overview`'s queries and `/api` calls are counted; any increase is a regression |
| A field on every event | `src/schema.js` (append to `FIELDS` or `NUMBERS`) | send it from `src/tracker.js` (then `npm run tracker`), or read it from the request in `collect()`; return it from `parseEvent`; read it in `src/queries.js` and shape it in `src/shape.js`; give `src/demo.js` and `bench/fakes.mjs` rows for it | `test/collect.test.js` pins the layout; tracker and tracker-build tests | `t.js` bytes, and writes per visit |
| A rule in a sentence | the function in `public/story.js` (see [How the story is picked](#how-the-story-is-picked)) | `readStory` and `tellStory` also feed the weekly message (`src/alerts.js`) and the second line's sheet (`src/api.js`, `src/insight.js`) | `test/story.test.js`, which checks the demo's story on all seven weekdays; `test/insight.test.js`; the weekly tests in `test/alerts.test.js` | usually none |
| An API route | a `case` in `route()` in `src/api.js` | a method on `sqlStore` (`src/api.js`) and on `demoStore` (`src/demo.js`); the `settings` list in `handleApi` if its answers must never be cached; a branch for its SQL alias in `bench/fakes.mjs`; `ROUTES` in `bench/worker.mjs` to time it | `test/api.test.js`, and `test/signin.test.js` for who may call it | queries and Worker time per answer |
| A wrong number on a screen | the `draw*` or `render*` that shows it | follow [The path of a question](#the-path-of-a-question) back: `api()`, `route()`, the `sqlStore` method, the `*Sql` builder in `src/queries.js`, the `to*` shaper in `src/shape.js` | add a case to the test of the layer that was wrong | — |

A read-only link lets every `GET` through except `/api/shares`, for its one site (`asShared` in `src/index.js`). So a new `GET` route is open to anyone the owner shared with; put anything only the owner may see behind a check of `shared`.

## The shape

One Worker (`src/index.js`) with static assets (`public/`). Only `/api/*`, `/lede` and `/s/*` run the Worker (`run_worker_first` in `wrangler.jsonc`); the dashboard page and `t.js` are plain assets, which are free, and the page asks for the password itself. Any other path loads the dashboard, which reads the view from the address.

| Binding | What it holds |
|---|---|
| `EVENTS` (Analytics Engine, dataset `lede`) | one data point per event; read back through the SQL API with the owner's token |
| `STORE` (KV) | sites, the monthly salts, settings per site, read-only links, kept pictures and lines; see [Storage](#storage) |
| `LIVE` (Durable Object `Live`, SQLite) | who was seen in the last 30 minutes, per site, pushed to a watching dashboard |
| `AI` (Workers AI, optional) | writes the second line |
| `ASSETS` | `public/` |
| crons | `0 8 * * 1` (the week's story) and `*/15 * * * *` (spikes), run by `scheduled` in `src/index.js` |

## The path of a visit

`public/t.js` sends `{page URL, referrer, landing query}` to `POST /lede` with `fetch` and `keepalive` (not `sendBeacon`, whose pings tracker blockers drop while it still reports success). The referrer is only its origin and the landing query only its tracking parameters. Besides page views, it sends an engagement event (with the page's speed) each time the tab is hidden or closed, and once more when a single-page app moves on, in the same request as the next page view; clicks on links to other sites and on files; and a ping every 3 minutes while the tab shows. Every page view, engagement event and ping carries when the page view started (`v`), which tells one page view's events from another's. When a page view counts, and what engagement measures, are in [What each number means](how-it-works.md#what-each-number-means). `t.js` is a plain static file, so loading it is free and needs no password; browsers keep it for up to an hour (`public/_headers`), so later page views in a visit don't wait on `workers.dev`.

`collect()` in `src/collect.js` handles the request in this order:

1. `OPTIONS` answers with CORS; anything but `POST` is 405.
2. `unwanted()` (`src/bots.js`): bots, Browser Run, data-center networks, Global Privacy Control when it's honored.
3. A body over 16 KiB is 413, bad JSON 400; a batch of more than 4 events is dropped.
4. `parseEvent()` for each event: its type and URL, the site must be one Lede counts, the source from the referrer or a tag, referrer spam (`src/spam.js`), the channel (`src/channels.js`), and the path without tracking or search parameters.
5. Events sent from another site's page are dropped.
6. The month's salt; `BEACON_LIMIT`, when bound.
7. Device, browser, system, version, language and place, from the request's headers.
8. For each event: the sender's cap (60 a minute) and the address's (about 400), the visit's hour, `identify()` (the visitor and visit hashes), one `writeDataPoint`, and `forward()` to the site's `Live` object while a dashboard watches.
9. Whatever was dropped gets the same empty 204 as what was counted.

The beacon isn't at `/api/event`: blocklists such as EasyPrivacy block that path on `workers.dev`, because self-hosted Plausible uses it. That path still reaches `collect()` for trackers cached before the move.

### The schema

Each event is one data point, indexed by site. The blob order is defined once in `src/schema.js`:
site, path, url, referrer, channel, visitor, visit, type, country, utm_source, utm_medium, utm_campaign, target, device, browser, utm_term, refUrl, os, place, language.

`type` is `pageview`, `engagement`, `outbound`, `download` or `ping`; rows from before there were other types are all page views, and every page-view stat filters on it. `url` (blob3) is the page's path, plus `?q=` and the words on a site search's results page; nothing else from the query is stored. Figures are doubles: `double1` is engaged milliseconds, `double2` scroll depth in percent, `double3` a page view's place in its visit (1 for the first, 2 for the second, 3 for any later one; 0 on other events and on rows from before it was recorded), and `double4` to `double6` the page's LCP and INP in milliseconds and its CLS times 1,000 plus 1, on engagement events (0 when the browser didn't measure it; CLS is one higher so a page that never shifts still counts). `double7` is when the page view started, in ms, on page views, engagement events and pings (0 on rows from before it was sent), and `double8` is 1 on an engagement event that says the page view was left (its tab hidden or closed, or a single-page app moving on; 0 on rows from before). Pings also carry the page view's engaged time and depth so far in `double1` and `double2`. `target` is the clicked link's host and path, without its query. `device` (blob14) and `browser` (blob15) are empty on rows written before Lede recorded them. `refUrl` (blob17) is the referring address as the browser sent it, without its `#` (most browsers send only the site); `os` (blob18) the operating system, with the version iPhones and Android send; `place` (blob19) Cloudflare's city and region as `city|region`; `language` (blob20) the browser's first language, such as `es-AR`. `double9` is the screen's width in CSS pixels, on page views, and `double10` the browser's major version. All are empty or 0 on rows written before Lede recorded them. `utm_term` (blob16) is the ad keyword of the page the visit landed on, cleaned as search words are, and empty on rows from before it was collected.

## The path of a question

1. The dashboard's `api(route, params)` in `public/index.html` adds the site, period and time zone and fetches `/api/<route>`.
2. `fetch` in `src/index.js`: a change (anything but `GET`/`HEAD`) from another site is 403; `/api/signin` and `/api/signout`; without the password's cookie, `asShared()` lets a read-only link's `GET`s through for its one site, checked before any cache is looked at, so a link can never be served another site's cached answer; then `/api/shot` goes to `src/shot.js` and the rest to `handleApi()`.
3. `handleApi()` in `src/api.js` looks in the edge cache, then calls `route()`, a `switch` on the route's name; an unknown name is 404.
4. `route()` calls a method on the store: `sqlStore(env)`, or `demoStore` when `DEMO="true"`.
5. `sqlStore` builds SQL with `src/queries.js` and runs it with `runSql()` against the Analytics Engine SQL API.
6. `src/shape.js` turns the rows into the JSON the dashboard reads. The SQL API returns 64-bit counts as strings, hence `Number()` everywhere.

**Both periods in one query.** Each comparison (summary, days, breakdowns, flows, engagement, link clicks) is one SQL query covering both periods, each row labeled by period (`p`). Lists keep each period's top rows (100 for breakdowns, 200 for engagement and links); SQL here has no `LIMIT BY`, so the query asks for ten times as many and Lede trims each period. An answer whose list may have had more says `cut: true`; asked again with `all`, it keeps each period's top 1,000 (the query asks for 2,000). When one period fills the whole answer, as after a tenfold change in traffic on a site with hundreds of pages, the other period is asked for on its own (`lists()` in `src/api.js`).

**What the SQL can't do,** and how Lede gets around it:
- Filter values reach SQL hex-encoded (`hex(blob2) = '…'`), because the SQL API documents no string escaping.
- Countries, devices and browsers are one query: visits grouped by all three at once, then added up per list. A visitor's hash covers their IP and user agent, so each visitor sits in one group and the lists add up. Systems, languages and screens are another, places a third (`breakdown` with `dim=place`), and the three campaign tags a fourth.
- There are no window functions, joins or `IN (subquery)`, so `/api/next` asks twice: first for the visits that viewed the page in both periods (by the first 12 characters of their ID, ordered by ID, which is a hash, so the first ones are a random sample), then for every page view of up to 250 of those visits per period, written into the query as a list. The Worker sorts each visit's views by time and pairs each view of the page with the next one. 250 visits per period is what fits the SQL API's 10 KiB.
- One parameter can't be taken out of an address, so the site search query sends back each search address once per visitor (up to 20,000 a query, both periods together) and the Worker reads the words.

### Caching

| Layer | Where | How long |
|---|---|---|
| The dashboard's memo | `api()` in `public/index.html`, by full URL | 5 minutes; `fresh` skips it and the browser's copy |
| The browser | `Cache-Control: private, max-age` from `handleApi()` | 60 s, 15 s for live; settings routes `no-store` |
| The edge | `caches.default` in `handleApi()`; Cloudflare documents the Cache API for custom domains, not `workers.dev` | `s-maxage`, the same 60 s or 15 s |
| The instance | `remember()` in `src/api.js`: up to 200 answers in progress or done, `GET` only; `ask.stat` lets one route reuse another's | the same |
| Settings | `remembered()` in `src/settings.js`: sites, shares and salts | 60 s per instance |

Goals, notes, funnels, sites and shares are never cached (the `settings` list in `handleApi()`). The demo caches nothing at the edge.

### The demo store

With `DEMO="true"`, `handleApi()` uses `demoStore` from `src/demo.js` instead of `sqlStore`; it answers the same methods from generated sample rows (`demoStore` also has `firsts`, which `src/api.js` works out from other answers for SQL). Settings, the second line, the live socket and the schedules have demo branches of their own (`demoAlertStore`, `DEMO_INSIGHT`, `DEMO_FUNNEL`). The sample is built for the day it runs on, so `test/weekdays.js` runs the story tests on each of seven days.

## How the story is picked

All of this is in `public/story.js` unless it says otherwise. Every sentence is a pure function of answers the dashboard already has, so it can be tested in Node and run in the Worker.

### Home's sentence

`readStory()` works out the facts, `tellStory()` says them.

- **Unit.** Visitors, unless only one of the two periods holds the start of a UTC month (when visitor IDs start again); then visits (`unitOf`).
- **Flat.** A change smaller than 3% of the period before, or twice its square root, whichever is larger, is not explained: "About as many visitors as the 7 days before (+12)."
- **Lead.** Of the sources that moved the same way as the total, the one that moved most. A **second** is named with it when it moved at least 85% as much. With no second, when the lead moved more than the total did, the biggest mover the other way is named too (the **counter**).
- **How much.** On a rise: the lead "sent all" (exactly) or "nearly all" (95% or more) of the extra, "N of the D extra" (25% or more), or "the rise was spread across sources" (less). A fall says the same the other way.
- **Mostly to.** On a rise with no second: the page the lead's visitors landed on, when it took at least half of what the lead's pages gained (current flows minus previous ones, per page, adding up only the pages that gained); "the new page" when it had no visitors before.
- **Spike.** `findSpike()` needs 7 days. The peak is a spike when it is over 1.6 times the usual day (the median of the same weekday with 14 days or more, else of all days), at least 1.3 times the next-busiest day, and above the usual by twice its square root and 5 at least. It is the lead's when the lead was that day's top source and sent at least half of the day's extra visitors. On a fall, a spike in the period before is named instead.
- **The second claim.** A note when one explains the change (below), else the first of `findings()`, ranked by how many visitors each moved:

| Finding | Needs | Ranked by |
|---|---|---|
| Fastest rise | not named yet; at least 1% of the total; 20 or more before; up by 10 and twice the square root of before, and 5% | the change (the highest ratio wins among sources) |
| New source | no fastest rise; none before; 20 or more and 1% of the total | its visitors |
| Vanished | 30 or more before, and a tenth of that or less now | the visitors lost |
| Rose or fell | `moved()`: 30 or more before, a change of 30, twice the square root and 10% of before; and the total was flat, or moved the other way | the change |
| Channel | 2 sources or more; its share moved 2 points the same way as its visitors, which `moved()`; named sources made less than half of it | the share moved times the visitors |

`findings(…).slice(1)` is the overview's What else changed (`moreFindings`).

**Notes.** `noteChange()` looks for two things, on the noted day or the day after, inside the current period:
- **A lasting move.** `levelShift()` finds the day that best splits both periods' finished days into two levels (a CUSUM split, with weekdays evened out from 28 days on, 7 days before the split and 3 after at least). It counts when it moves the same way as the total, by 10% of the level before or more, and the days after it make at least half the period's change. It says "Visitors rose 40% after you posted…".
- **A big day.** A finished day with 1.5 times a usual day like it, clear of it by twice the usual's square root and 5. It says "twice" or "N times" from 1.95, else the percent.

`didWhat()` turns a note that starts with a past tense ("Posted…", or one of the irregular verbs in `DONE`) into "you posted…"; any other note is quoted.

### The `told` set

`tellStory()` returns `told`, the keys of everything its sentence names: the lead, second and counter, and the finding it used, a channel as `ch:<channel>` so channel and source keys don't collide. Everything drawn after reads it so nothing is said twice and what the sentence names is drawn solid or bold: home's tiles (`drawFlow`, `drawNow`), What else changed, the overview's lists (`dimSection`'s `boldKeys`), the Bounce and Online screens, and `findEvents`. The page the sentence names is returned on its own, as `T.page`.

### Every other sentence

| Where | Function | Rule |
|---|---|---|
| Home's Did they stay, the Bounce screen | `bounceSplit`, `bounceCaption` | splits bounce's change into the mix of sources and their behavior; "mix" when that is 60% of the change the same way, a source when it made 30% |
| Same | `bounceStandout` | the source or page with the most extra bounces: 50 visits or more, 10 points above the site |
| Bounce screen | `bounciestPair`, `outcomeStory` | the same rule over source and page pairs; under 30 visits, too few |
| Home's flow tile | `pairStay`, `flowCaption` | the lead's page left 10 points above or below the site, with 50 visits; "N in 10 who landed on it came from the lead" |
| Sources | `waterfallMovers`, `waterfallCaption` | the 3 that moved most, AI assistants as one; "nearly all" from 95% |
| Pages, home's tile, a source's view, the weekly message | `pagesFinding`, `pagesCaption` | the page that moved most, by `moved()`, other than the one the sentence names |
| A source or channel | `sourceStory`, `readsMore`, `channelShare` | a page the source reads at half again everyone's share and a tenth of its readers, with 30 of them, from a source with 100 visitors; a channel's share when it moved a point |
| Where readers are | `audienceStory` | a share moved 2 points the same way as the visitors, by `moved()`; phones and computers 10 points apart, 50 visits each; under 30 visits, too few |
| A page | `pageStory`, `pageVerdict` | weighed against the site at 5 points; slow to load on poor LCP |
| How far down | `scrollStory`, `scrollPicture` | under 50 views, counts; the tenth where at least 10% stop and 1.5 times the median tenth |
| What readers do next | `nextStory`, `nextItems` | under 20 views, counts; a change in leaving at 5 points and more than twice its standard error |
| By weekday and hour | `busyWindow`, `hoursStory` | 300 visitors; three hours in a row with a quarter of them |
| Online | `onlineStory`, `lanes`, `onlinePace`, `usualHalfHour` | a page with at least 2 people and half of everyone; usual from the same weekday's half hour, said from 1.75 times or under 0.6 |
| The crowd | `crowd`, `figureScale`, `apportion` | the smallest of 1, 2, 5, 10, 20… a figure that fits; largest remainders, one figure at least for any group with people |
| Today so far | `todayPace` | against a usual same weekday so far; "about as busy" within 10% |
| What happened | `findEvents` (`public/index.html`), `quietRuns`, `eventsSentence` | the spike, quiet runs under 0.35 of usual, new pages and sources with 20 visitors and 0.5% of the total, notes, a week that moved 10% |
| Links people clicked | `linksStory` | the fastest riser needs 30 before and a quarter more |
| Goals | `goalStory`, `goalFromPage`, `suggestGoal` | counts under 50 visits; a source with 100 visits, at half or twice the rate |
| Page speed | `speedStory`, `vitalsFinding`, `readingMap` | 30 measures; a busy poor page with 50 visitors and 5% of all; Read or skimmed needs 3 pages with 20 views |
| Funnels | `funnelStory` | under 30 visits at the first step, too few; "most dropped off" when one step lost more than half |
| Keywords | `keywordsStory` | under 20, "a few"; a change from 10 before, said at 15% |
| Page names in blocks | `fitLabel` | the best of 12, 11 and 10 px, across or turned, broken after `/` or `-` or at a syllable; cut in the middle when nothing fits |

## The dashboard

`public/index.html` is the whole dashboard: markup, styles and script in one file, with no build step. The logic that decides what to say is in `public/story.js`, and the addresses in `public/routes.js`.

- **Start.** `boot()` reads the view from the address, asks for the sites, prefetches home's answers (`prefetchHome()`, the same requests `drawHome()` makes, so they're already in the memo), draws home and opens the view in the address alongside it.
- **Home.** `renderHome()` sets `homeDrawn` to `drawHome()`, which fetches its answers in parallel, runs `readStory`/`tellStory` and keeps the result in `HOME` (`S`, `T`, the series and hours). Views opened from home wait for `homeDrawn` and read `HOME`, so they don't ask again.
- **Views.** `openView()` and `zoom()` open a view over the one before, `back()` and the browser's history close it; `urlToView()` and `viewToUrl()` in `public/routes.js` map addresses to views and back. Each view is drawn by `view(body, fn)`: it counts a generation in `body._gen`, and every answer checks `stale(body, gen)` before drawing, so a late answer for a view already left draws nothing. The `render*` functions lay out a view; the `draw*` functions draw one chart or card.
- **Reused answers.** A view reads what home or another card already asked for when it can, so it costs no query of its own: the overview's strips of sources and pages come from home's rows, Online's usual from home's hours, the Bounce screen from home's flows (which carry each pair's visits and bounces), Read or skimmed from the engagement rows the Pages list reads, and a page's goal numbers from the same rows as where readers went next. Funnels are learned with the goals at the start (the same KV read); the overview asks for their numbers only when it opens, one call and one query per funnel, and nothing when there is none.
- **Lists.** `cutList()` shows a list's first rows and a button that shows the rest in place, asking with `all` only when the server cut it.
- **Size.** `observe(el, fn)` redraws a chart when its box changes size; `release()` stops that when a view closes.
- **Names.** Every hostname on screen goes through `public/hosts.js`, which shows accented names as people write them.
- **Colors.** By kind: visitors blue, sources amber, pages violet, bounce red, here now green, defined once on `:root`; `test/colors.test.js` checks their contrast.

## The second line, inside

`src/insight.js` builds the sheet, asks Workers AI and checks the answer; `GET /api/insight` in `src/api.js` runs `readStory`/`tellStory` for home's sentence and passes both to it.

- `factSheet()` lists the numbered candidates, in order of interest, rounded as [The second line](how-it-works.md#the-second-line) says. Reading time, Web Vitals and search words are asked for with the rest; home doesn't need them, so building the sheet costs 2 queries of its own (search words and the words ads paid for come from one).
- `problem()` checks a line against the sheet: every number, page, site and source from one and the same candidate, no causal words, at most 2 sentences and 280 characters.
- `lineFor()` keeps one KV entry per site and period, `insight:<site>:<days>`, with `{text, hash, at, tried}`: the line, the SHA-256 of the sheet it came from, when it was written and when Workers AI was last asked; it deletes itself after a day. Within the hour after the last try (or after this instance last checked the kept line), the kept line stands and no sheet is built. After that, a line kept under 6 hours is shown while it still passes `problem()` against the new sheet, or for as long as the sheet is the same; Workers AI is asked again only when there's no entry or the sheet changed. A try that came to nothing is kept too, and each instance asks once at a time.
- Failures are logged once a day per instance (`once()`), with what to do next.

## Storage

The KV keys are listed, with what each holds and how long, at the top of `src/settings.js`. Settings for a site (goals, funnels, notes and the tab icon) are one key, `settings:<site>`, so the dashboard reads them with one request and saving one is one write. The tab icon's pick costs no read of its own for that reason. Older versions kept goals, funnels and notes in keys of their own (`goals:`, `funnels:`, `notes:`); the first read moves them into `settings:<site>`. The stats routes read the sites from each instance's copy, kept for a minute, and read KV again only for a site they don't know yet. When each site's data starts (`added:<site>`, for the spike's usual) is looked up once and kept. Pictures (`shot:<day>:<site><path>`, with the browser time each took, and `shot:<day>:` when the account's browser time is gone) and share pictures (`og:…`) are in `src/shot.js`; the day's browser time is the sum over that day's keys (one KV list), and once it's spent each instance stops listing for the rest of the day.

Read-only links are one `shares` key, read at most once a minute per instance, so a wrong token costs at most one KV read and a token of the wrong length none. The token is 24 random bytes; opening `/s/<token>` sets an `HttpOnly` `lede_share` cookie and goes to `/?site=<site>`. With that cookie (and without the password's, which wins), `GET /api/sites` answers with just that site and `shared: true`.

The `Live` object (`src/live.js`) keeps one SQLite table of who was seen in the last 30 minutes, one row per page view (`here`), and in `cut`, until when its counts are a floor, after it started from a query that reached its 1,000 page views. It pushes what `/api/live` would answer over a WebSocket, at most once a second, to each dashboard watching. A dashboard opening the socket hands it `/api/live`'s query first, so it starts from what Analytics Engine has. It only hears of events while someone watches: each Worker instance asks it at most once a minute per site whether anyone is, and the beacon never waits for it. The dashboard closes the socket while its tab is hidden; without the object (the sample data, or a deploy without it) the socket never opens and the dashboard asks every minute.

## Schedules

`src/alerts.js`, run by `scheduled` in `src/index.js`. The week's story uses `readStory`, `tellStory` and `pagesFinding` from `public/story.js`, the same code home uses, with the span "this week" against "the week before". A schedule on the Free plan may make 50 requests; `SUBREQUESTS` counts them, and a site is told only while there's room left for it. What each schedule reads and costs is under [Get the story by message](how-it-works.md#get-the-story-by-message).

## Tests

`npm test` runs `node --test`, which loads every file in `test/`.

- **story**, **hints**, **hosts**, **routes:** the pure functions in `public/`. `test/story.test.js` checks the demo's story on each weekday through `test/weekdays.js`, which fakes the date and loads a fresh sample for each.
- **screens:** reads `public/index.html` as text, finds each function by name, cuts it at `\n}\n` and checks it with regexes: the overview's card order, which answers each view asks for, what it draws.
- **colors:** reads the color tokens from `public/index.html` and checks their contrast.
- **api**, **queries**, **keywords**, **next**, **funnel:** the SQL builders, `src/shape.js` and the demo store's answers.
- **collect**, **bots**, **devices:** the beacon, its filters and the data point's layout.
- **tracker**, **tracker-build:** every tracker case runs on both `src/tracker.js` and `public/t.js`, in `node:vm` with a fake window; the build test checks `public/t.js` is the build of the source.
- **signin**, **headers**, **settings:** the password, read-only links and cross-site checks through the whole Worker; `public/_headers`; the KV keys.
- **live:** the Durable Object, with `node:sqlite` standing in for its storage.
- **shot**, **insight**, **alerts:** pictures, the second line and the messages, with the fakes from `bench/fakes.mjs`.
- **demo**, **bench:** the demo build, and the bench's judge.

## Measuring changes

Every change is measured before it goes in. Performance work must improve the numbers; any other change may make them worse only at a price the owner accepts, as [GOALS.md](../GOALS.md#when-a-change-costs-more) says.

```sh
npm run bench            # this working copy against the commit in bench/baseline.json
npm run bench:compare    # judges it; exits 1 on a regression or a floor, 3 when a timing needs a rerun
npm run bench:since      # what changed since main's baseline, and the prices accepted for it (or: -- <ref>)
```

`scripts/bench.mjs` runs both versions without Cloudflare: the Worker in Node with stand-ins for Analytics Engine and KV that count every query and write (`bench/fakes.mjs`, `bench/server.mjs`), and the dashboard and tracker in headless Chrome Canary with the CPU slowed 4x. It records:

- **Bytes**: `t.js` as sites receive it (`public/t.js`, so run `npm run tracker` first), and everything the dashboard can load, raw, gzip and brotli. Any increase is a regression.
- **Counts**: Analytics Engine queries, `/api` calls, page pictures and their browser time, KV reads, writes and lists, and Workers AI asks and the tokens they send (a token for about every 4 characters; Neurons follow tokens) per dashboard page, with the second line's sheet counted apart, since it's built at most once an hour per period; requests, writes and KV use per visit, and the `Live` object's requests per visit while no dashboard watches, plus requests and writes for a visit that leaves the tab and comes back, and one through a single-page app; and the same for one spike check and one week's story, run with an alert webhook set (`bench/cron.mjs`). These are what the free limits count, they don't vary between runs, and any increase is a regression. The judge also prints what the schedules take a day (96 spike checks and a seventh of the week's story), and how much a day the rest leaves room for.
- **Timings**: the Worker per visit and per stats answer, what `t.js` adds to a page, and how long the dashboard home takes to draw and how long it blocks. The two versions run in turn, rep after rep, and the judge looks at the ratio of each pair. A timing is worse when the bootstrap 95% range of the median ratio sits wholly above the threshold for that metric (in `bench/noise.json`, twice what unchanged code swings, at least 5%) and the medians differ by more than 0.05 ms. A range that crosses the threshold is inconclusive: rerun before believing it. A Worker answer over 5 ms fails on its own, to stay well under the 10 ms of CPU free Workers get.

- **Floors**: GOALS.md's floors, as `FLOORS` and `CEILING_MS` in `scripts/compare.mjs`: visits a day before the free writes and Worker requests, home loads a day before the free queries, and a small site's Worker answer under 5 ms. A run below one fails whatever the base did, and no price lets it through.
- **Since**: `npm run bench:since` compares `main`'s `bench/baseline.json` with this one, metric by metric (bytes and counts only, since timings compare only within one run), and reads every `Bench-Accepted:` trailer in between. Growth that the prices for its metric don't add up to is shown as unpriced. The owner reads it before `next` is merged into `main`.

A regression blocks the change until it pays for itself or the owner accepts its price, as GOALS.md says; an inconclusive timing is rerun first. Put the before and after numbers that changed in the commit message. A new baseline, whether the change made Lede smaller, cheaper or faster or the owner accepted a price, is recorded with `node scripts/bench.mjs --save-baseline` in a commit of its own, which carries a `Bench-Accepted:` trailer for each price. After a Chrome Canary update or a move to another machine, measure the noise again: `node scripts/bench.mjs --aa` then `node scripts/compare.mjs --noise bench/runs/aa.json`. Runs land in `bench/runs/`, which git ignores.

## API

All stats routes take `site`, `days` (1–45), `tzName` (the viewer's time zone, such as `America/New_York`), `tz` (`Date#getTimezoneOffset()`, used when `tzName` is missing or unknown), and optional filters `path`, `referrer` (`""` = direct) and `channel`.

Days run from local midnight to local midnight in `tzName`, so the day the clocks change is 23 or 25 hours long (23.5 or 24.5 on Lord Howe Island), as it really was. With only `tz`, one offset is used for the whole period. Today is only partly over, so the previous period stops at the same time of day.

- `GET /api/summary` → visitors, visits, views, bounce, duration for the period and the one before; `sampled: true` when Analytics Engine kept only a sample of some of this period's views, and `prevSampled` the same for the period before; `split: {cur, prev}`, true when that period holds the start of a month (UTC), when visitor IDs start again; and, only when neither period has a view, `ever`: whether the site had any view in the last 90 days
- `GET /api/series` → the same metrics per day, plus each day's top source and how many visitors it sent
- `GET /api/breakdown?dim=path|entry|exit|referrer|channel|country|campaign|medium|tag|refUrl|os|place|language|screen` (`BREAKDOWNS` in `src/queries.js`; referrer rows also carry the channel the host falls in); `cut: true` when a list was cut short, and `&all` for each period's top 1,000. Engagement and links take `all` and say `cut` the same way
- `GET /api/systems` → `os`, `language` and `screen` lists like audience's, from one query; `screen` keys are width bands by their least width: `1` (under 600), `600`, `1024`, `1440`
- `GET /api/campaigns` → `campaign`, `medium` and `tag` (utm_source, source or ref) lists like audience's, from one query of the tagged visits
- `GET /api/audience` → `country`, `device` and `browser` lists (visitors, visits, views, bounce, duration, and last period's), and `partial`: `"cur"` or `"prev"` when that period has visits stored before devices and browsers were recorded, else `null`. Devices and browsers then carry no previous figures.
- `GET /api/flows` → visitors by the source a visit came from and the page it landed on, with that pair's visits and the visits that left after one page
- `GET /api/firsts` → the day each page and source was first seen in the period
- `GET /api/hourly` → visitors per hour of the period, counted in whole days back from today's local midnight, so today's hours match the clock even after a daylight-saving change earlier in the period
- `GET /api/live` → visitors in the last 30 minutes, with who is active in the last 5
- `GET /api/live/ws` (a WebSocket) → the same answer, pushed as it changes; `404` without the `Live` Durable Object
- `GET /api/conversions?goal=/signup&goal=/thanks` → visits per source, and how many of them viewed a goal page
- `GET /api/engagement` → per page: page views that sent an engagement event, average seconds on the page, `median` time per view (ms) and share scrolled, with last period's, and page speed: `lcp`, `inp` (ms) and `cls` (as its score), each the 75th percentile of the views that measured it, or `null` when none did, and `lcpN`, `inpN` and `clsN`, how many views measured each (only views with a tap or click measure INP). With `path`, the page also gets `reach`: the share of those views that got at least 10%, 20%... 100% of the way down, counted in the same query
- `GET /api/next?path=/pricing` → for each period: views of the page, how many were the visit's last (`left`), how many visits viewed it, and the pages viewed straight after it, most first; `sampled` says when a period's figures come from a random sample of visits
- `GET /api/links` → `outbound` links and `downloads`, each with visitors, clicks and last period's visitors
- `GET /api/keywords` → `site` (words searched on the site) and `paid` (ad keywords), each a list of `{key, visitors, prev}` with last period's visitors (`null` when no one used the word then), most used first, up to 1,000
- `GET /api/shot?site=&path=` → today's picture of the page as a jpeg, or `{og, why}`: the page's share picture (or `null`) and why there's no picture: `budget` (the day's browser time is used), `permission` (the token can't take pictures), `busy` (Cloudflare's browser didn't answer and spent no browser time; asking again a minute later tries again) or `failed`
- `POST /api/signin` with `{"password"}` sets the cookie; `POST /api/signout` clears it
- `GET /api/insight` → `{text}`: the second line under home's sentence, or `204` when there's none (no Workers AI, fewer than 30 visitors, no Neurons left, or a line that failed a check)
- `GET /api/sites` → the sites Lede counts, `demo`, and `insight`: whether to ask for the second line; `POST /api/sites` with `{"site": "example.com"}` adds one
- `GET /api/goals` → the site's goals, its notes, its tab icon (`icon`, 0 to 8, or null for the automatic one) and its funnels too (as `GET /api/funnels` gives them), so the dashboard reads them with one request and knows whether the Overview has funnels to read; `PUT /api/goals` with `{"goals": [...]}` saves them
- `GET /api/notes` → the site's notes, `[{day: "2026-10-16", text: "Posted on Hacker News"}]`, oldest first; `PUT /api/notes` with `{"day", "text"}` adds or replaces that day's note; `DELETE /api/notes?day=2026-10-16` removes it. Each answers with the notes as they now are. A change is one KV write, and one that changes nothing writes nothing; the newest 100 notes are kept.
- `PUT /api/icon` with `{"icon": 3}` keeps that colorway for the site's tab icon; `{"icon": null}` goes back to the automatic one
- `GET /api/funnels` → the site's funnels, each a list of steps; `PUT /api/funnels` with `{"funnels": [["/pricing", "/signup"], ...]}` saves up to five, each two to five different paths of up to 200 characters
- `GET /api/funnel?steps=/pricing&steps=/signup&steps=/thanks` → `steps`, and `cur` and `prev`: the visits that reached each step in order, this period and the one before. One SQL query reads both periods, and only views of the step pages. The filters don't apply.
- `GET /api/shares` → the read-only links, newest first; `POST /api/shares` with `{"site": "example.com"}` makes one; `DELETE /api/shares?token=…` stops one. Password only.

## File map

| Piece | Where |
|---|---|
| Tracker | `src/tracker.js`, built to `public/t.js` |
| Beacon (`POST /lede`) | `src/collect.js`, with `src/bots.js`, `src/spam.js`, `src/channels.js`, `src/devices.js`, `src/schema.js` |
| Routing, password, read-only links | `src/index.js` |
| Stats API | `src/api.js`, `src/queries.js`, `src/shape.js`, `src/errors.js` (`HttpError`, an error with the status to answer) |
| Settings and KV | `src/settings.js` |
| Here now, live | `src/live.js` |
| Page pictures | `src/shot.js`, and `src/demo-picture.js` for the demo's one picture, of /owls (kept under 16 KB, since every Worker carries it) |
| Second line | `src/insight.js` |
| Messages | `src/alerts.js` |
| Sample data | `src/demo.js` |
| Dashboard | `public/index.html`, `public/story.js`, `public/routes.js`, `public/hosts.js`. The crowd's figures are [Wee People](https://github.com/propublica/weepeople) by ProPublica (CC BY-NC-ND 3.0), in `public/weepeople.woff2`. |
| Static files | `public/_headers`, `public/robots.txt`, the icons |
| Demo site | `demo/`, `scripts/build-demo.mjs`, `.github/workflows/demo.yml` |
| Bench | `scripts/bench.mjs`, `scripts/compare.mjs`, `bench/` |
| Analytics Engine's delay | `scripts/ae-lag.mjs` |
| Tests | `test/` |
