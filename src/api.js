import * as Q from './queries.js';
import { toSummary, toSeriesBoth, byPeriod, topByDay, toFlows, toFirsts, toHourly, mergeRows, shapeLive, toConversions, toEngagement, toLinks } from './shape.js';
import { getSites, addSite, getAccountId } from './settings.js';
import { HttpError } from './errors.js';
import { demoStore } from './demo.js';
import { channelFor } from './channels.js';

export { HttpError };

const MAX_DAYS = 45; // the previous period doubles it, and Analytics Engine keeps 90 days
const CACHE_SECONDS = { live: 15, default: 60 };

function int(v, fallback, min, max) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function parseQuery(url, sites, nowMs = Date.now()) {
  if (!sites.length) throw new HttpError(400, 'Add your site\'s address first.');
  const site = (url.searchParams.get('site') || sites[0]).toLowerCase();
  if (!sites.includes(site)) throw new HttpError(400, `Unknown site "${site}".`);
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
    throw new HttpError(503, 'Lede needs a Cloudflare token to read the stats. Make one with the link in Lede’s docs, under “Deploy from the command line”, then run npx wrangler secret put ANALYTICS_TOKEN and paste it.');
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
    throw new HttpError(502, 'Cloudflare didn’t answer the stats query. Try again in a minute.');
  }
  return JSON.parse(text).data;
}

export function sqlStore(env, fetchImpl = fetch) {
  const ds = env.DATASET || 'lede';
  if (!/^\w+$/.test(ds)) throw new HttpError(500, 'DATASET may only contain letters, digits and underscores.');
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
    async live(q) {
      return shapeLive(await run(Q.liveSql(ds, q.site)), Math.floor(Date.now() / 1000));
    },
    async conversions(q, goals) {
      return toConversions(await run(Q.conversionsSql(ds, q, q.start, q.end, goals)));
    },
    async engagement(q) {
      const { cur, prev } = await lists(only => Q.engagementSql(ds, q, only), Q.LISTS.pages);
      return toEngagement(cur, prev);
    },
    async links(q) {
      const { cur, prev } = await lists(only => Q.linksSql(ds, q, only), Q.LISTS.pages);
      return toLinks(cur, prev);
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
    throw new HttpError(400, 'Goals must be a list of up to ten paths that start with "/".');
  }
  return [...new Set(list)];
}

// Goals are kept in KV, so everyone who opens the dashboard sees the same ones.
async function goals(req, q, env) {
  const key = `goals:${q.site}`;
  if (req.method === 'PUT') {
    const list = parseGoals((await req.json().catch(() => ({}))).goals);
    await env.STORE.put(key, JSON.stringify(list));
    return { goals: list };
  }
  return { goals: JSON.parse(await env.STORE.get(key) || '[]') };
}

async function route(name, url, env, store, req) {
  const demo = env.DEMO === 'true';
  if (name === 'sites') {
    if (req.method === 'POST') return { sites: await addSite(env, (await req.json().catch(() => ({}))).site), demo };
    return { sites: await getSites(env, { fresh: true }), demo };
  }
  const q = parseQuery(url, await getSites(env, { fresh: true }));
  if (name === 'goals') return goals(req, q, env);
  switch (name) {
    case 'summary': return store.summary(q);
    case 'series': return store.series(q);
    case 'flows': return store.flows(q);
    case 'hourly': return store.hourly(q);
    case 'firsts': return store.firsts(q);
    case 'live': return store.live(q);
    case 'engagement': return store.engagement(q);
    case 'links': return store.links(q);
    case 'conversions': {
      const list = url.searchParams.getAll('goal');
      return store.conversions(q, parseGoals(list.length ? list : null));
    }
    case 'breakdown': {
      const dim = url.searchParams.get('dim');
      if (!Q.BREAKDOWNS.includes(dim)) throw new HttpError(400, `dim must be one of: ${Q.BREAKDOWNS.join(', ')}.`);
      const out = await store.breakdown(q, dim);
      // The channel a referrer host falls in when no UTM tags say otherwise.
      if (dim === 'referrer') out.rows = out.rows.map(r => ({ ...r, channel: channelFor(r.key, new URLSearchParams()) }));
      return out;
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
  const settings = name === 'goals' || name === 'sites';
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
    return json({ error: e instanceof HttpError ? e.message : 'Something went wrong reading stats.' }, e.status || 500);
  }
}
