import * as Q from './queries.js';
import { toSummary, toSeriesBoth, byPeriod, topByDay, toFlows, toFirsts, toHourly, mergeRows, shapeLive, toConversions, toEngagement, toLinks, toKeywords, toAudience, pickVisits, pairNext, toFunnel } from './shape.js';
import { getSites, addSite, getAccountId } from './settings.js';
import { HttpError } from './errors.js';
import { demoStore, demoNotes, DEMO_FUNNEL } from './demo.js';
import { channelFor } from './channels.js';

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
    async summary(q) {
      return toSummary(await run(Q.summarySql(ds, q)));
    },
    async series(q) {
      const [days, top] = await Promise.all([run(Q.seriesSql(ds, q)), run(Q.topSourceSql(ds, q))]);
      return { start: q.start, days: q.days, ...toSeriesBoth(days, q.days), ...topByDay(top, q.days) };
    },
    async breakdown(q, dim) {
      const { cur, prev } = await lists(only => Q.breakdownSql(ds, q, dim, only), Q.LISTS.breakdown);
      return { dim, rows: mergeRows(cur, prev) };
    },
    async flows(q) {
      const { cur, prev } = await lists(only => Q.flowSql(ds, q, only), Q.LISTS.flows);
      return { flows: toFlows(cur), prev: toFlows(prev) };
    },
    async firsts(q) {
      const [pages, sources] = await Promise.all(['path', 'referrer'].map(dim => run(Q.firstSeenSql(ds, q, dim))));
      return { start: q.start, pages: toFirsts(pages), sources: toFirsts(sources) };
    },
    async hourly(q) {
      const from = Q.hourlyStart(q);
      return { start: from, days: q.days, visitors: toHourly(await run(Q.hourlySql(ds, q, from, q.end)), q.days) };
    },
    // Where readers of the page went next; see Q.NEXT for why it takes two queries.
    async next(q) {
      const path = q.filters.path;
      const picked = pickVisits(await run(Q.nextVisitsSql(ds, q)), Q.NEXT.keep);
      let rows = picked.ids.length ? await run(Q.nextRowsSql(ds, q, picked.ids)) : [];
      // Rows come in visit order, so a full answer may have cut the last visit short, which would read as leaving.
      if (rows.length >= Q.NEXT.rows) rows = rows.filter(r => r.v !== rows.at(-1).v);
      rows = rows.filter(r => picked.keep.has(`${Number(r.p) === 1 ? 1 : 0}|${r.v}`));
      return { path, sampled: picked.sampled.cur, ...pairNext(rows, path) };
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

const json = (body, status = 200, maxAge = 0) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': maxAge ? `max-age=${maxAge}` : 'no-store' },
});

// Goal pages: up to ten paths, each starting with a slash.
export function parseGoals(list) {
  if (!Array.isArray(list) || list.length > 10 || !list.every(g => typeof g === 'string' && g.startsWith('/') && g.length <= 512)) {
    throw new HttpError(400, 'Goals are up to ten pages, each starting with “/”, like /signup.');
  }
  return [...new Set(list)];
}

// Goals are kept in KV, so everyone who opens the dashboard sees the same ones. Reading them also
// answers with the notes and the funnels, since the dashboard needs them as it opens: one request instead of three,
// and the Overview asks for funnel numbers only when there is a funnel.
async function goals(req, q, env, demo) {
  const key = `goals:${q.site}`;
  if (req.method === 'PUT') {
    const list = parseGoals((await req.json().catch(() => ({}))).goals);
    await env.STORE.put(key, JSON.stringify(list));
    return { goals: list };
  }
  const [list, saved, f] = await Promise.all([env.STORE.get(key), readNotes(q, env, demo), funnels(req, q, env)]);
  return { goals: JSON.parse(list || '[]'), notes: saved, ...f };
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

// Until the owner changes the demo's notes, it shows the one it comes with.
async function readNotes(q, env, demo) {
  const saved = await env.STORE.get(`notes:${q.site}`);
  return saved ? JSON.parse(saved) : demo ? demoNotes(q) : [];
}

// Each change is one KV write, and one that changes nothing writes nothing.
async function notes(req, url, q, env, demo) {
  const list = await readNotes(q, env, demo);
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
  if (JSON.stringify(next) !== JSON.stringify(list)) await env.STORE.put(`notes:${q.site}`, JSON.stringify(next));
  return { notes: next };
}

// The channel a referrer host falls in when no UTM tags say otherwise.
export const withChannels = out => ({ ...out, rows: out.rows.map(r => ({ ...r, channel: channelFor(r.key, new URLSearchParams()) })) });

// A funnel: two to five different pages a visit goes through, in order. Steps are shorter than goals
// (200 characters), so five of them, written twice each as hex, keep the query well under 10 KiB.
export function parseFunnel(steps) {
  const ok = Array.isArray(steps) && steps.length >= 2 && steps.length <= 5 && new Set(steps).size === steps.length
    && steps.every(s => typeof s === 'string' && s.startsWith('/') && s.length <= 200);
  if (!ok) throw new HttpError(400, 'A funnel is two to five different pages, each starting with “/”.');
  return steps;
}

export function parseFunnels(list) {
  if (!Array.isArray(list) || list.length > 5) throw new HttpError(400, 'You can keep up to five funnels.');
  const byKey = new Map(list.map(parseFunnel).map(f => [f.join('\n'), f]));
  return [...byKey.values()];
}

// Funnels are kept in KV beside the goals. The sample site shows one until a list is saved.
async function funnels(req, q, env) {
  const key = `funnels:${q.site}`;
  if (req.method === 'PUT') {
    const list = parseFunnels((await req.json().catch(() => ({}))).funnels);
    await env.STORE.put(key, JSON.stringify(list));
    return { funnels: list };
  }
  const saved = await env.STORE.get(key);
  return { funnels: saved ? JSON.parse(saved) : env.DEMO === 'true' ? [DEMO_FUNNEL] : [] };
}

async function route(name, url, env, store, req) {
  const demo = env.DEMO === 'true';
  if (name === 'sites') {
    if (req.method === 'POST') return { sites: await addSite(env, (await req.json().catch(() => ({}))).site), demo };
    return { sites: await getSites(env, { fresh: true }), demo };
  }
  const q = parseQuery(url, await getSites(env, { fresh: true }));
  if (name === 'goals') return goals(req, q, env, demo);
  if (name === 'notes') return notes(req, url, q, env, demo);
  if (name === 'funnels') return funnels(req, q, env);
  switch (name) {
    case 'summary': return store.summary(q);
    case 'series': return store.series(q);
    case 'flows': return store.flows(q);
    case 'hourly': return store.hourly(q);
    case 'firsts': return store.firsts(q);
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
const recent = new Map();
const RECENT_MAX = 200;

function remember(key, seconds, answer) {
  const hit = recent.get(key);
  if (hit && Date.now() < hit.until) return hit.answer;
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
  if (cache) {
    const hit = await cache.match(req.url);
    if (hit) return hit;
  }
  try {
    const answer = () => route(name, url, env, demo ? demoStore : sqlStore(env), req);
    const body = await (demo || settings || req.method !== 'GET' ? answer() : remember(req.url, maxAge, answer));
    const res = json(body, 200, maxAge);
    if (cache) ctx.waitUntil(cache.put(req.url, res.clone()));
    return res;
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    return json({ error: e instanceof HttpError ? e.message : 'Something went wrong reading the stats. Try again in a minute.' }, e.status || 500);
  }
}
