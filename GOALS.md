# Lede: goals

## Why Lede exists
Lede tells the truth about a site, and makes it easy to read.

It started because the tools at hand didn't. Cloudflare's analytics counted mostly bots and
showed almost no people. The webmaster tools showed visits and impressions but no real
keywords. Lede counts people, not requests, and when something can't be known it says so
instead of guessing.

Its model is Measure Map, the blog stats tool from 2005. The point isn't to answer any query
or fill a report; it's to show, as it happens, how the small things you do (a post, a
rewrite, a link someone shared) change who reads you, with almost nothing to set up.

Lede does what nine in ten of today's site owners need, and nothing they don't. What it does,
it should do better than any other tool, and look better too.

## What we never trade away
- **People, not bots.** Anything that isn't a person reading is left out, and the docs say
  what and why.
- **True to the data.** No conclusion the numbers can't back. Small samples and gaps are
  said plainly, never dressed up as a trend.
- **Private.** Visits are stored in the site owner's own Cloudflare account and go nowhere
  else: not to Lede's makers, not to anyone. There are two exceptions: the messages the owner
  can turn on, which go to the webhook they choose, and the totals behind home's second line,
  which go to Workers AI in the same account, where Cloudflare doesn't keep them or train on
  them. No cookies on visitors, and nothing follows a person across sites or months. What the
  dashboard shows can't point to one person: rare words, emails and long numbers are left out.
- **Free to run.** A small site stays inside Cloudflare's free limits. Workers AI is
  optional, and Lede works the same without it.
- **Simple to own.** One Worker, no runtime dependencies, one button to deploy.

## Goals, in priority order
A change ships only through the gates: it keeps what we never trade away, the tests pass
(they guard goals 1 to 4), and it stays above the floors below. Between changes that pass,
and between goals that conflict, the higher goal wins. Goals 5 and 6 give ground only at a
price (see "When a change costs more").

1. **Insight at a glance.** Every screen opens with what happened and where it came from, in
   one sentence ("Hacker News sent 3 times as many visitors to /pricing"), and says what the
   owner did just before, never that it was the cause. A second line may say one link between
   findings the first can't fit, a link Lede worked out itself, with only its numbers, never
   a cause, and at most one suggestion, labeled as one. The numbers come after, to back it up. No query builder, no
   wall of reports.
2. **Easy.** One line on the site and the first useful sentence follows. Nothing to
   configure, no account anywhere but Cloudflare, installed in minutes. Every error says
   what to do next.
3. **Beautiful, and new.** Each finding gets the clearest way to show it, even one no other
   tool has, rather than a table. Meaningful solid color, plain words, calm motion, nothing
   decorative. Every screen checked at full size.
4. **The bare minimum, done fully.** Add something only when most of today's owners would
   use it, and remove what they don't. Whatever ships is finished: empty, tiny and huge
   sites, phones, keyboard, both themes.
5. **Fast and live.** Visits show up as they happen. The tracker is as small as it can be and
   never slows the page it's on. The dashboard draws before anyone thinks about waiting.
6. **Cheap.** As few queries, writes and requests as the answer needs, so the free limits
   go as far as they can.

And we go the extra mile: the edge case handled, the sentence rewritten, the byte saved.

## Floors
The floors are "Free to run" in numbers, as `node scripts/compare.mjs` prints them. No change
goes below one, whoever accepts it.
- Visits a day before the free 100,000 writes, and before the free 100,000 Worker requests:
  at least 50,000, the README's promise. A plain visit is at it today, so a visit can't cost
  one more write or request.
- Dashboard home loads a day before the free 10,000 queries: at least 1,000.
- Every Worker answer for a small site (the bench's `worker:` lines): under 5 ms, half the CPU
  free Workers get.

A floor moves only when Cloudflare's free limits do. Visits that switch tabs or move through a
single-page app cost more; they are priced, not floored, as the README's "about" allows.

## How we know
| Goal | Measure | Where |
|---|---|---|
| 1 | every view leads with a sentence; a story test for each finding; the second line's checks | `test/story.test.js`, `test/insight.test.js` |
| 2 | steps from nothing to the first sentence, written down; every error gives the next step | `docs/how-it-works.md`, `test/` |
| 3 | screens checked at full size, in both themes and on a phone, before a release | by eye |
| 4 | each feature has empty, tiny and large-data cases in the tests and the demo | `test/`, `src/demo.js` |
| 5 | t.js bytes (raw, gzip, brotli), t.js run time, Worker time per answer, dashboard bytes, home drawn, blocking | `npm run bench` |
| 6 | queries per dashboard page, requests and writes per visit, KV use, Workers AI asks and tokens, the schedules' cost, headroom | `npm run bench` |

## When a change costs more
Every change is measured (see "Measuring changes" in `docs/how-its-built.md`). A change made
for goals 5 or 6 must make them better. Any other change may make them worse only to buy one of:
- one of what we never trade away;
- a correctness or security fix, with a test that failed before it;
- a higher goal, named by its clause with the check that shows it: a story test, or why most
  owners would use it.

Never for nothing, and never below a floor.

Where a thing is shown is part of its price. In order:
- A leaner way beats a smaller feature.
- A query the view already makes beats a new one.
- A kept answer beats asking again.
- Hourly beats every load.
- Its own screen beats every load.

A cost paid on every home load or every visit needs the strongest case.

When the bench shows a cost, first make the change pay for itself, down that list: a leaner way
to do the same thing, or a saving elsewhere in the same change. Never by taking out what the
change is for: a feature that's wanted stays whole, and the work is in making it cost less.
After three real tries, each with the number it reached, it goes to the owner.

Only the owner accepts a price, in their own words; an agent may propose one. The price goes in
the commit that records the new baseline, a commit of its own, as is any change to what the
bench measures, which needs the owner too. One trailer for each number that got worse and each
thing it bought, never several under one, named and counted as the bench names them:

    Bench-Accepted: <metric>; <before> -> <after>; buys: <goal and its check>; tried: <each try and what it reached>; owner: <their words>, <date>

The second line's sheet is the model:

    Bench-Accepted: sheet queries: /; 0 -> 2; buys: goal 1, the second line's links need reading times, page speeds and search words (test/insight.test.js); tried: asked at most once an hour instead of every load (3 a load -> 2 an hour), site search and ad words in one query (overview 12 -> 10); owner: <their words>, 2026-10-28

Small prices add up. Before `next` is merged into `main`, the owner reads every price since the
last merge (`git log --format='%(trailers:key=Bench-Accepted)' main..next`) and each number's
net change from `main`'s baseline. When the total since the last pass that made Lede cheaper has
grown more than 10% on any number, or by any query per home load, the next work is such a pass,
and it never removes features.

A timing that comes out inconclusive is rerun before the change lands; it isn't a pass. The
same numbers with less code is a better change.
