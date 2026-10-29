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
When two conflict, the higher one wins.

1. **Insight at a glance.** Every screen opens with what happened and where it came from, in
   one sentence ("Hacker News sent 3 times as many visitors to /pricing"), and says what the
   owner did just before, never that it was the cause. A second line may say one link between
   findings the first can't fit, a link Lede worked out itself, with only its numbers, never
   a cause, and at most one suggestion, labelled as one. The numbers come after, to back it up. No query builder, no
   wall of reports.
2. **Easy.** One line on the site and the first useful sentence follows. Nothing to
   configure, no account anywhere but Cloudflare, installed in minutes. Every error says
   what to do next.
3. **Beautiful, and new.** Each finding gets the clearest way to show it, even one no other
   tool has, rather than a table. Meaningful solid colour, plain words, calm motion, nothing
   decorative. Every screen checked at full size.
4. **The bare minimum, done fully.** Add something only when most of today's owners would
   use it, and remove what they don't. Whatever ships is finished: empty, tiny and huge
   sites, phones, keyboard, both themes.
5. **Fast and live.** Visits show up as they happen. The tracker is as small as it can be and
   never slows the page it's on. The dashboard draws before anyone thinks about waiting.
6. **Cheap.** As few queries, writes and requests as the answer needs, so the free limits
   go as far as they can.

And we go the extra mile: the edge case handled, the sentence rewritten, the byte saved.

## How we know
| Goal | Measure | Where |
|---|---|---|
| 1 | every view leads with a sentence; a story test for each finding; the second line's checks | `test/story.test.js`, `test/insight.test.js` |
| 2 | steps from nothing to the first sentence, written down; every error gives the next step | `docs/how-it-works.md`, `test/` |
| 3 | screens checked at full size, in both themes and on a phone, before a release | by eye |
| 4 | each feature has empty, tiny and large-data cases in the tests and the demo | `test/`, `src/demo.js` |
| 5 | t.js bytes (raw, gzip, brotli), t.js run time, dashboard bytes, home drawn, blocking | `npm run bench` |
| 6 | queries per dashboard page, requests and writes per visit, KV use, Workers AI asks and tokens, the schedules' cost, headroom | `npm run bench` |

Every change is measured (see "Measuring changes" in `docs/how-its-built.md`). Goals 5 and 6
may not get worse, and a change made for them must make them better. When the bench blocks a
change, first make it pay for itself: a leaner way to do the same thing, or a saving elsewhere
in the same change. Never by taking out what the change is for: a feature that's wanted stays
whole, and the work is in making it cost less. Only when that fails, the owner may let it
through, knowing the numbers; it should be rare, and the commit then says what got worse, by
how much, and why it's worth it.
