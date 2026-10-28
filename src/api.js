import * as Q from './queries.js';
import { toSummary, toSeriesBoth, byPeriod, topByDay, toFlows, firstsOf, toHourly, mergeRows, shapeLive, toConversions, toEngagement, toLinks, toKeywords, toAudience, pickVisits, pairNext, toFunnel, pagePath } from './shape.js';
import { getSites, addSite, getAccountId, getSettings, saveSettings } from './settings.js';
import { HttpError } from './errors.js';
import { demoStore, demoNotes, DEMO_FUNNEL, DEMO_INSIGHT } from './demo.js';
import { channelFor } from './channels.js';
import { factSheet, insight, hashOf, MIN_VISITORS } from './insight.js';
import { readStory, tellStory } from '../public/story.js';

export { HttpError };

const MAX_DAYS = 45; // the previous period doubles it, and Analytics Engine keeps 90 days
const CACHE_SECONDS = { live: 15, default: 60 };

function int(v, fallback, min, max) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function parseQuery(url, sites, nowMs = Date.now()) {
  if (!sites.length) throw new HttpError(400, 'Add your site’s address first.');
  const site = (url.searchParams.get('site') || sites[0]).toLowerCase();
  if (!sites.includes(site)) throw new HttpError(400, `Lede isn’t counting ${site}. Open the dashboard without ?site=.`);
  const days = int(url.searchParams.get('days'), 30, 1, MAX_DAYS);
  const tz = int(url.searchParams.get('tz'), 0, -840, 840);
  // The viewer's IANA zone, such as America/New_York. ranges() falls back to tz when it isn't one.
  const tzName = url.searchParams.get('tzName');
  const filters = {};
  for (const name of Object.keys(Q.FILTERS)) {
    const v = url.searchParams.get(name);
    if (v == null) continue;
    if (v.length > 512) throw new HttpError(400, `The ${name} filter is too long.`);
    filters[name] = v;
  }
  return { site, days, tz, filters, ...Q.ranges(days, tz, nowMs, tzName) };
}

// The SQL API answers 429 when queried too often and 503 when busy; one more try, after the wait it
// asks for (at most two seconds), usually gets through.
const RETRY = [429, 503];
const MAX_WAIT_MS = 2000;

export async function runSql(env, sql, fetchImpl = fetch, wait = ms => new Promise(r => setTimeout(r, ms))) {
  if (!env.ANALYTICS_TOKEN) {
    throw new HttpError(503, 'Lede needs a Cloudflare token to read the stats. Make one with the link in docs/how-it-works.md, under “Deploy from the command line”, then run npx wrangler secret put ANALYTICS_TOKEN and paste it.');
  }
  const account = await getAccountId(env, fetchImpl);
  const ask = () => fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.ANALYTICS_TOKEN}` },
    body: sql,
  });
  let res = await ask();
  if (RETRY.includes(res.status)) {
    const after = Number(res.headers.get('Retry-After'));
    await wait(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, MAX_WAIT_MS) : 500);
    res = await ask();
  }
  const text = await res.text();
  if (!res.ok) {
    console.error(`Analytics Engine query failed (${res.status}): ${text.slice(0, 300)}`);
    if (res.status === 401 || res.status === 403) throw new HttpError(502, 'Your Cloudflare token can’t read the stats. Make a new one with the link in docs/how-it-works.md, under “Deploy from the command line”, then run npx wrangler secret put ANALYTICS_TOKEN and paste it.');
    // Any other refusal won't go away by asking again. Analytics Engine makes a dataset on its first
    // write, so one it can't find has had no visit yet, or is read under another name than it's written.
    // Only an answer that names the dataset as missing says so: the rest are about the query itself.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      const ds = env.DATASET || 'lede';
      if (text.includes(ds) && !/column/i.test(text) && /unknown (table|dataset)|not (be )?found|(does not|doesn['’]t) exist/i.test(text)) {
        throw new HttpError(502, `Cloudflare has no stats called “${ds}” yet. Open a page of your site that has Lede’s line, then reload. If it still says this, check that DATASET in wrangler.jsonc matches the dataset under analytics_engine_datasets.`);
      }
      throw new HttpError(502, `Cloudflare refused Lede’s stats query (${res.status}). Asking again won’t help. The Worker’s logs say what Cloudflare didn’t accept: run npx wrangler tail, then reload.`);
    }
    throw new HttpError(502, 'Cloudflare didn’t send the stats back. Try again in a minute.');
  }
  return JSON.parse(text).data;
}

export function sqlStore(env, fetchImpl = fetch) {
  const ds = env.DATASET || 'lede';
  if (!/^\w+$/.test(ds)) throw new HttpError(500, 'DATASET in wrangler.jsonc may only contain letters, digits and underscores. Change it, then deploy again.');
  const run = sql => runSql(env, sql, fetchImpl);
  // Each period's top keep rows from one query over both; see Q.LISTS for when a period needs a query of its own.
  const lists = async (build, { keep, both }) => {
    const rows = await run(build());
    const out = byPeriod(rows);
    for (const only of ['cur', 'prev']) {
      if (rows.length >= both && out[only].length < keep) out[only] = byPeriod(await run(build(only)))[only];
      out[only] = out[only].slice(0, keep);
    }
    return out;
  };
  return {
    // ever: with nothing in either period, whether the site has had any view at all, so a new site
    // can be told apart from one gone quiet. Asked only then.
    async summary(q) {
      const out = toSummary(await run(Q.summarySql(ds, q)));
      if (!out.cur.views && !out.prev.views) out.ever = (await run(Q.everSql(ds, q.site))).length > 0;
      return out;
    },
    async series(q) {
      const [days, top] = await Promise.all([run(Q.seriesSql(ds, q)), run(Q.topSourceSql(ds, q))]);
      return { start: q.start, days: q.days, ...toSeriesBoth(days, q.days), ...topByDay(top, q.days) };
    },
    async breakdown(q, dim) {
      const { cur, prev } = await lists(only => Q.breakdownSql(ds, q, dim, only), Q.LISTS.breakdown);
      return { dim, rows: mergeRows(cur, prev) };
    },
    async flows(q, landing) {
      const { cur, prev } = await lists(only => Q.flowSql(ds, q, only, landing), Q.LISTS.flows);
      return { flows: toFlows(cur), prev: toFlows(prev) };
    },
    async hourly(q) {
      const from = Q.hourlyStart(q);
      return { start: from, days: q.days, visitors: toHourly(await run(Q.hourlySql(ds, q, from, q.end)), q.days) };
    },
    // Where readers of the page went next; see Q.NEXT for why it takes two queries. When the first fills
    // its limit, a period with no more than keep of its visits in it may have been cut short by the
    // other, so it's asked for on its own.
    async next(q) {
      const path = q.filters.path;
      let found = await run(Q.nextVisitsSql(ds, q));
      if (found.length >= Q.NEXT.both) {
        const by = byPeriod(found);
        for (const only of ['cur', 'prev']) if (by[only].length <= Q.NEXT.keep) by[only] = await run(Q.nextVisitsSql(ds, q, only));
        found = [...by.cur, ...by.prev];
      }
      const picked = pickVisits(found, Q.NEXT.keep);
      let rows = picked.ids.length ? await run(Q.nextRowsSql(ds, q, picked.ids)) : [];
      // Rows come in visit order, so a full answer may have cut the last visit short, which would read as leaving.
      if (rows.length >= Q.NEXT.rows) rows = rows.filter(r => r.v !== rows.at(-1).v);
      rows = rows.filter(r => picked.keep.has(`${Number(r.p) === 1 ? 1 : 0}|${r.v}`));
      return { path, sampled: picked.sampled.cur, prevSampled: picked.sampled.prev, ...pairNext(rows, path) };
    },
    async live(q, nowSec = Math.floor(Date.now() / 1000)) {
      return shapeLive(await run(Q.liveSql(ds, q.site)), nowSec);
    },
    // Rows per day; days with nobody have none.
    async usual(site, nowSec, days) {
      return (await run(Q.usualSql(ds, site, nowSec, days))).map(r => Number(r.visitors) || 0);
    },
    async conversions(q, goals) {
      return toConversions(await run(Q.conversionsSql(ds, q, q.start, q.end, goals)));
    },
    async funnel(q, steps) {
      return toFunnel(await run(Q.funnelSql(ds, q, steps)), steps);
    },
    async engagement(q) {
      const { cur, prev } = await lists(only => Q.engagementSql(ds, q, only), Q.LISTS.pages);
      return toEngagement(cur, prev);
    },
    async links(q) {
      const { cur, prev } = await lists(only => Q.linksSql(ds, q, only), Q.LISTS.pages);
      return toLinks(cur, prev);
    },
    async keywords(q) {
      const [site, paid] = await Promise.all([run(Q.siteSearchSql(ds, q)), run(Q.paidWordsSql(ds, q))]);
      return toKeywords(site, paid);
    },
    async audience(q) {
      const { cur, prev } = await lists(only => Q.audienceSql(ds, q, only), Q.LISTS.audience);
      return toAudience(cur, prev);
    },
  };
}

// Stats are behind the password, so only the viewer's own browser may keep a copy.
const BROWSER = maxAge => maxAge ? `private, max-age=${maxAge}` : 'no-store';
const json = (body, status = 200, maxAge = 0) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': BROWSER(maxAge) },
});

// A goal or funnel step read as a stored page (see pagePath), or null when it isn't one. Encoded, as
// pagePath leaves it, it's at most 200 characters, so an accented letter counts as six (é is %C3%A9).
const PAGE_CHARS = 200;
const LONG = `up to ${PAGE_CHARS} characters, where an accented letter counts as six`;
function pageOf(s) {
  if (typeof s !== 'string' || !s.startsWith('/') || s.length > 512) return null;
  const page = pagePath(s);
  return page.length <= PAGE_CHARS ? page : null;
}

// Goal pages: up to ten. Ten of them, written as hex, keep the query well under 10 KiB.
export function parseGoals(list) {
  const pages = Array.isArray(list) ? list.map(pageOf) : null;
  if (!pages || pages.length > 10 || pages.includes(null)) {
    throw new HttpError(400, `Goals are up to ten pages, each starting with “/” and ${LONG}, like /signup.`);
  }
  return [...new Set(pages)];
}

// Goals and funnels saved by older versions can fail today's checks (a longer page, /a and /a/ as two
// steps), and the dashboard sends them back as saved. So they are read as they would be saved now,
// leaving out what can't be, and no card fails on every load.
const listOf = v => Array.isArray(v) ? v : [];
const storedGoals = list => [...new Set(listOf(list).map(pageOf).filter(Boolean))].slice(0, 10);
const storedFunnels = list => [...new Map(listOf(list)
  .map(f => [...new Set(listOf(f).map(pageOf).filter(Boolean))].slice(0, 5))
  .filter(f => f.length >= 2).map(f => [f.join('\n'), f])).values()].slice(0, 5);

// Goals, funnels and notes are kept in KV under one key per site (see settings.js), so everyone who
// opens the dashboard sees the same ones. Reading the goals also answers with the notes and the funnels,
// since the dashboard needs them as it opens: one request and one read instead of three, and the
// Overview asks for funnel numbers only when there is a funnel.
// Until the owner changes them, the sample site shows a note and a funnel.
function settingsOf(saved, q, demo) {
  return {
    goals: storedGoals(saved.goals),
    funnels: saved.funnels ? storedFunnels(saved.funnels) : demo ? [DEMO_FUNNEL] : [],
    notes: saved.notes || (demo ? demoNotes(q) : []),
  };
}

async function goals(req, q, env, demo) {
  const saved = await getSettings(env, q.site);
  if (req.method === 'PUT') {
    const list = parseGoals((await req.json().catch(() => ({}))).goals);
    await saveSettings(env, q.site, { ...saved, goals: list });
    return { goals: list };
  }
  return settingsOf(saved, q, demo);
}

// The owner's notes on days ("Posted on Hacker News"): one per day, YYYY-MM-DD in the owner's time zone.
// Stats go back three months, so the newest 100 are plenty.
const NOTE_CHARS = 80;
const MAX_NOTES = 100;
// A real date: 2026-02-30 rolls over to March, so it isn't one.
const isDay = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(Date.parse(d) || 0).toISOString().startsWith(d);

export function parseNote(body) {
  const day = body?.day, text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!isDay(day)) throw new HttpError(400, 'A note needs a day, written like 2026-10-16.');
  if (!text || [...text].length > NOTE_CHARS) throw new HttpError(400, `A note is a few words, up to ${NOTE_CHARS} characters.`);
  return { day, text };
}

// Each change is one KV write, and one that changes nothing writes nothing.
async function notes(req, url, q, env, demo) {
  const saved = await getSettings(env, q.site), list = settingsOf(saved, q, demo).notes;
  if (req.method === 'GET') return { notes: list };
  let next;
  if (req.method === 'PUT') {
    const note = parseNote(await req.json().catch(() => null));
    next = [...list.filter(n => n.day !== note.day), note].sort((a, b) => a.day < b.day ? -1 : 1).slice(-MAX_NOTES);
  } else if (req.method === 'DELETE') {
    const day = url.searchParams.get('day');
    if (!isDay(day)) throw new HttpError(400, 'Say which day’s note to remove, like ?day=2026-10-16.');
    next = list.filter(n => n.day !== day);
  } else throw new HttpError(405, 'Notes are read with GET, saved with PUT and removed with DELETE.');
  if (JSON.stringify(next) !== JSON.stringify(list)) await saveSettings(env, q.site, { ...saved, notes: next });
  return { notes: next };
}

// The channel a referrer host falls in when no UTM tags say otherwise.
export const withChannels = out => ({ ...out, rows: out.rows.map(r => ({ ...r, channel: channelFor(r.key, new URLSearchParams()) })) });

// A funnel: two to five different pages a visit goes through, in order, read as stored pages (see
// pageOf). Five of them, written as hex up to three times each, keep the query under 10 KiB.
export function parseFunnel(steps) {
  const pages = Array.isArray(steps) ? steps.map(pageOf) : [];
  if (pages.includes(null)) throw new HttpError(400, `Each step of a funnel is a page starting with “/”, ${LONG}.`);
  if (pages.length < 2 || pages.length > 5 || new Set(pages).size < pages.length) {
    throw new HttpError(400, 'A funnel is two to five different pages, each starting with “/”. A slash at the end doesn’t make another page: /pricing/ is /pricing.');
  }
  return pages;
}

export function parseFunnels(list) {
  if (!Array.isArray(list) || list.length > 5) throw new HttpError(400, 'You can keep up to five funnels.');
  const byKey = new Map(list.map(parseFunnel).map(f => [f.join('\n'), f]));
  return [...byKey.values()];
}

async function funnels(req, q, env, demo) {
  const saved = await getSettings(env, q.site);
  if (req.method === 'PUT') {
    const list = parseFunnels((await req.json().catch(() => ({}))).funnels);
    await saveSettings(env, q.site, { ...saved, funnels: list });
    return { funnels: list };
  }
  return { funnels: settingsOf(saved, q, demo).funnels };
}

// The isolate's copy of the sites, read again only when the site asked for isn't in it: one just added.
async function sitesFor(url, env) {
  const sites = await getSites(env), want = url.searchParams.get('site')?.toLowerCase();
  return sites.length && (!want || sites.includes(want)) ? sites : getSites(env, { fresh: true });
}

// A line from Workers AI is kept 6 hours, in the instance and in KV, under a hash of the facts it was made from.
const INSIGHT_SECONDS = 6 * 3600;

// The line under home's sentence (src/insight.js), or null. It reads the answers home just asked for, so a
// home load that ran them costs no query; engagement and keywords come in only when a view already asked.
async function insightFor(q, env, ask) {
  const [totals, ser, pages, refs, flows, saved] = await Promise.all([ask.stat('summary'), ask.stat('series'),
    ask.stat('breakdown', { dim: 'path' }), ask.stat('breakdown', { dim: 'referrer' }), ask.stat('flows'), getSettings(env, q.site)]);
  if (totals.cur.visitors < MIN_VISITORS) return null;
  const notes = settingsOf(saved, q, false).notes;
  const S = readStory({ totals, ser, pages, refs, flows, notes }), T = tellStory(S, ser, q.days);
  const facts = factSheet({ site: q.site, span: { now: `in the last ${q.days} days`, before: `the ${q.days} days before` },
    S, T, ser, pages, flows, notes, engagement: await ask.seen('engagement'), keywords: await ask.seen('keywords') });
  const key = `insight:${q.site}:${await hashOf(facts)}`;
  return remember(key, INSIGHT_SECONDS, async () => {
    const stored = await env.STORE.get(key).catch(() => null);
    if (stored) return stored;
    const text = await insight(env, facts);
    if (text) await env.STORE.put(key, text, { expirationTtl: INSIGHT_SECONDS }).catch(() => {});
    return text;
  });
}

// ask.stat(name, params) answers as /api/<name> would for the same query, sharing its queries when both are
// asked at once; ask.seen(name) is that answer only when it's already kept, else null.
async function route(name, url, env, store, req, ask) {
  const demo = env.DEMO === 'true';
  if (name === 'sites') {
    // insight: whether to ask for the line under home's sentence; without Workers AI there's none.
    const answer = sites => ({ sites, demo, insight: demo || !!env.AI });
    if (req.method === 'POST') return answer(await addSite(env, (await req.json().catch(() => ({}))).site));
    return answer(await getSites(env, { fresh: true }));
  }
  const q = parseQuery(url, await sitesFor(url, env));
  if (name === 'insight') {
    if (demo) return { text: DEMO_INSIGHT };
    const text = env.AI ? await insightFor(q, env, ask) : null;
    return text ? { text } : null;
  }
  if (name === 'goals') return goals(req, q, env, demo);
  if (name === 'notes') return notes(req, url, q, env, demo);
  if (name === 'funnels') return funnels(req, q, env, demo);
  switch (name) {
    case 'summary': return { ...await store.summary(q), split: Q.monthSplit(q) };
    case 'series': return store.series(q);
    case 'flows': {
      const landing = url.searchParams.get('landing');
      if (landing != null && landing.length > 512) throw new HttpError(400, 'The landing filter is too long.');
      return store.flows(q, landing ?? undefined);
    }
    case 'hourly': return store.hourly(q);
    // The day each page and source was first seen comes with the breakdowns; this answers it on its own.
    case 'firsts': {
      if (store.firsts) return store.firsts(q);
      const [pages, sources] = await Promise.all([ask.stat('breakdown', { dim: 'path' }), ask.stat('breakdown', { dim: 'referrer' })]);
      return { start: q.start, pages: firstsOf(pages.rows), sources: firstsOf(sources.rows) };
    }
    case 'live': return store.live(q);
    case 'engagement': return store.engagement(q);
    case 'links': return store.links(q);
    case 'keywords': return store.keywords(q);
    case 'audience': return store.audience(q);
    case 'next':
      if (q.filters.path == null) throw new HttpError(400, 'Say which page with ?path=.');
      return store.next(q);
    case 'funnel': return store.funnel(q, parseFunnel(url.searchParams.getAll('steps')));
    case 'conversions': {
      const list = url.searchParams.getAll('goal');
      return store.conversions(q, parseGoals(list.length ? list : null));
    }
    case 'breakdown': {
      const dim = url.searchParams.get('dim');
      if (!Q.BREAKDOWNS.includes(dim)) throw new HttpError(400, `The dim parameter must be one of: ${Q.BREAKDOWNS.join(', ')}.`);
      const out = await store.breakdown(q, dim);
      return dim === 'referrer' ? withChannels(out) : out;
    }
    default: throw new HttpError(404, 'Unknown API route.');
  }
}

// The edge cache only works on a custom domain, so each isolate also keeps recent answers itself.
// The promise is kept, so a dashboard asking the same thing twice at once runs the queries once.
// Answers are kept by route and parameters, whatever order the parameters come in.
const recent = new Map();
const RECENT_MAX = 200;
const keyOf = url => `${url.pathname}?${new URLSearchParams([...url.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))}`;

const kept = key => { const hit = recent.get(key); return hit && Date.now() < hit.until ? hit : null; };

function remember(key, seconds, answer) {
  const hit = kept(key);
  if (hit) return hit.answer;
  if (recent.size >= RECENT_MAX) recent.delete(recent.keys().next().value);
  const entry = { until: Date.now() + seconds * 1000, answer: answer().catch(e => { recent.delete(key); throw e; }) };
  recent.set(key, entry);
  return entry.answer;
}

export async function handleApi(req, env, ctx) {
  const url = new URL(req.url);
  const name = url.pathname.replace(/^\/api\//, '');
  const demo = env.DEMO === 'true';
  const settings = name === 'goals' || name === 'notes' || name === 'funnels' || name === 'sites';
  const maxAge = settings ? 0 : CACHE_SECONDS[name] || CACHE_SECONDS.default;
  // Each stats request runs several SQL queries, so successful answers are cached briefly at the edge.
  const cache = !demo && !settings && typeof caches !== 'undefined' ? caches.default : null;
  // The edge keeps its copy for s-maxage; the viewer's browser gets the private header either way.
  if (cache) {
    const hit = await cache.match(req.url);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set('Cache-Control', BROWSER(maxAge));
      return res;
    }
  }
  try {
    const store = demo ? demoStore : sqlStore(env);
    const keep = (u, answer) => (demo || settings || req.method !== 'GET' ? answer() : remember(keyOf(u), maxAge, answer));
    const at = (other, params = {}) => {
      const u = new URL(url);
      u.pathname = `/api/${other}`;
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      return u;
    };
    const ask = {
      stat: (other, params) => { const u = at(other, params); return keep(u, () => route(other, u, env, store, req, ask)); },
      seen: other => kept(keyOf(at(other)))?.answer.catch(() => null) ?? null,
    };
    const body = await keep(url, () => route(name, url, env, store, req, ask));
    if (body == null) return new Response(null, { status: 204, headers: { 'Cache-Control': BROWSER(maxAge) } });
    const res = json(body, 200, maxAge);
    if (cache) {
      const copy = new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `s-maxage=${maxAge}` } });
      ctx.waitUntil(cache.put(req.url, copy));
    }
    return res;
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    return json({ error: e instanceof HttpError ? e.message : 'Something went wrong reading the stats. Try again in a minute.' }, e.status || 500);
  }
}
