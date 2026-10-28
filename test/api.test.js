import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, sqlStore, handleApi, runSql } from '../src/api.js';
import { ranges, where, hexOf, breakdownSql, flowSql, hourlySql, conversionsSql, engagementSql, linksSql, liveSql, summarySql, seriesSql, topSourceSql, DAY } from '../src/queries.js';
import { demoStore } from '../src/demo.js';
import { onEachWeekday } from './weekdays.js';
import { mergeRows, shapeLive, toEngagement, toAudience } from '../src/shape.js';
import { audienceSql } from '../src/queries.js';

const SITES = ['example.com'];
const ENV = { ACCOUNT_ID: 'acc', ANALYTICS_TOKEN: 'tok', DATASET: 'lede' };
const memoryKV = (init = {}) => { const m = new Map(Object.entries(init)); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const url = s => new URL(`https://worker.test/api/${s}`);

test('periods start at local midnight and the previous one sits right before', () => {
  // 2026-10-27 15:00 UTC, viewer in UTC-3 (getTimezoneOffset() = 180)
  const r = ranges(30, 180, Date.UTC(2026, 9, 27, 15));
  assert.equal(new Date(r.end * 1000).toISOString(), '2026-10-28T03:00:00.000Z');
  assert.equal(r.end - r.start, 30 * DAY);
  assert.equal(r.start - r.prevStart, 30 * DAY);
  // 15:00 UTC is noon in UTC-3, so both periods hold 29 full days and 12 hours.
  assert.equal(r.prevEnd - r.prevStart, 29 * DAY + 12 * 3600);
});

test('breakdowns keep keys that only had visitors in the previous period', () => {
  const rows = mergeRows([{ key: 'a', visitors: '5' }], [{ key: 'a', visitors: '2' }, { key: 'gone', visitors: '9' }]);
  assert.deepEqual(rows.map(r => [r.key, r.visitors, r.prev.visitors]), [['a', 5, 2], ['gone', 0, 9]]);
});

test('filter values are hex-encoded so they cannot escape the SQL literal', () => {
  const q = { site: 'example.com', filters: { path: "/x' OR 1=1 --", referrer: '' } };
  const sql = where(q, 0, 10);
  assert.ok(!sql.includes('OR 1=1'));
  assert.ok(sql.includes(`hex(blob2) = '${hexOf("/x' OR 1=1 --")}'`));
  assert.ok(sql.includes(`hex(blob4) = ''`), 'empty referrer filter matches direct traffic');
  assert.equal(hexOf('/é'), '2FC3A9');
});

test('rejects unknown sites and clamps days', () => {
  assert.throws(() => parseQuery(url('summary?site=other.com'), SITES), /^Error: Lede isn’t counting other\.com\. Open the dashboard without \?site=\.$/);
  assert.equal(parseQuery(url('summary?days=999'), SITES).days, 45);
  assert.deepEqual(parseQuery(url('summary?path=/a&referrer='), SITES).filters, { path: '/a', referrer: '' });
});

test('entry pages are keyed by the first page of each visit', () => {
  const sql = breakdownSql('lede', parseQuery(url('breakdown?days=3'), SITES), 'entry');
  assert.match(sql, /argMin\(blob2, timestamp\) AS key/);
  assert.match(sql, /countIf\(n = 1\) AS bounces/);
});

test('flows key each visit by its first referrer and first page; hours count from local midnight', () => {
  const q = parseQuery(url('flows?days=3'), SITES);
  const flows = flowSql('lede', q);
  assert.match(flows, /argMin\(blob4, timestamp\) AS src/);
  assert.match(flows, /argMin\(blob2, timestamp\) AS landing/);
  assert.match(flows, /GROUP BY p, src, landing/);
  assert.match(hourlySql('lede', q, 3600, 7200), /intDiv\(toUnixTimestamp\(timestamp\) - 3600, 3600\) AS hr/);
  assert.ok(breakdownSql('lede', q, 'path').includes(`intDiv(toUnixTimestamp(min(timestamp)) - ${q.start}, 86400) AS d FROM`), 'the day a page was first seen');
  assert.ok(breakdownSql('lede', q, 'referrer').includes(`intDiv(min(t0) - ${q.start}, 86400) AS d FROM`), 'the day a source first sent a visit');
});

// A fake SQL API that answers by recognizing which query it was sent. Queries that compare the two
// periods read both at once and label each row with p (1 = this period).
// Page views that got at least 10%, 20%... 100% of the way down, as the SQL API names them.
const bands = (...n) => Object.fromEntries(n.map((v, i) => [`r${(i + 1) * 10}`, String(v)]));
function fakeSql(calls) {
  return async (endpoint, init) => {
    calls.push({ endpoint, init });
    const sql = init.body;
    let data;
    if (sql.includes('AS device')) data = [
      { p: 1, country: 'AR', device: 'phone', browser: 'chrome', visitors: '40', visits: '50', views: '60', bounces: '30', total_time: '600' },
      { p: 1, country: 'US', device: 'computer', browser: 'safari', visitors: '30', visits: '40', views: '90', bounces: '10', total_time: '2400' },
      { p: 1, country: 'US', device: 'phone', browser: 'safari', visitors: '10', visits: '10', views: '12', bounces: '6', total_time: '100' },
      { p: 0, country: 'US', device: 'computer', browser: 'safari', visitors: '25', visits: '30', views: '60', bounces: '9', total_time: '1800' },
      { p: 0, country: 'AR', device: 'phone', browser: 'chrome', visitors: '20', visits: '22', views: '30', bounces: '12', total_time: '300' },
    ];
    else if (sql.includes('AS hr')) data = [{ hr: '1', visitors: '4' }, { hr: '50', visitors: '2' }, { hr: '9999', visitors: '9' }];
    else if (sql.includes('AS landing')) data = [{ p: 1, src: 'news.ycombinator.com', landing: '/blog', visitors: '12' }, { p: 0, src: 'news.ycombinator.com', landing: '/blog', visitors: '6' }, { p: 1, src: '', landing: '/', visitors: '5' }, { p: 0, src: '', landing: '/', visitors: '5' }];
    else if (sql.includes('AS d, count(DISTINCT visitor)')) data = [{ p: 1, d: '3', visitors: '5', visits: '6', views: '9', bounces: '3', total_time: '120' }, { p: 1, d: '5', visitors: '1', visits: '1', views: '1', bounces: '1', total_time: '0' }, { p: 0, d: '1', visitors: '7', visits: '7', views: '7', bounces: '7', total_time: '0' }];
    else if (sql.includes('AS ref')) data = [{ d: '0', ref: 'google.com', visitors: '4' }, { d: '0', ref: '', visitors: '1' }];
    else if (sql.includes('AS r10')) data = [{ p: 1, key: '/docs', n: '20', ms: '900000', depth: '1000', ...bands(20, 18, 16, 14, 8, 7, 6, 5, 4, 2) }, { p: 0, key: '/docs', n: '10', ms: '300000', depth: '500', ...bands(10, 10, 9, 8, 7, 6, 5, 5, 5, 5) }];
    else if (sql.includes('AS ms')) data = [{ p: 1, key: '/docs', n: '20', ms: '900000', depth: '1500' }, { p: 1, key: '/new', n: '1', ms: '2000', depth: '100' }, { p: 0, key: '/docs', n: '10', ms: '300000', depth: '500' }];
    else if (sql.includes('AS kind')) data = [{ p: 1, kind: 'outbound', key: 'github.com/acme', visitors: '6', clicks: '9' }, { p: 1, kind: 'download', key: 'example.com/guide.pdf', visitors: '2', clicks: '2' },
      { p: 0, kind: 'outbound', key: 'github.com/acme', visitors: '3', clicks: '4' }];
    else if (sql.includes('AS key')) data = [{ p: 1, key: 'google.com', visitors: '7', visits: '8', views: '12', bounces: '2', total_time: '300', d: '2' }, { p: 1, key: '', visitors: '3', visits: '3', views: '3', bounces: '3', total_time: '0', d: '0' }, { p: 0, key: '', visitors: '2', visits: '2', views: '2', bounces: '1', total_time: '0' }];
    else data = [{ p: 0, visitors: '50', visits: '120', views: '240', bounces: '60', total_time: '6000', sampled: '0' }, { p: 1, visitors: '100', visits: '120', views: '240', bounces: '60', total_time: '6000', sampled: '0' }];
    return new Response(JSON.stringify({ meta: [], data, rows: data.length }), { status: 200 });
  };
}

test('SQL store shapes summary, series and breakdown responses', async () => {
  const calls = [];
  const q = parseQuery(url('summary?days=3'), SITES);
  const store = sqlStore(ENV, fakeSql(calls));

  const summary = await store.summary(q);
  assert.equal(summary.cur.visitors, 100);
  assert.equal(summary.prev.visitors, 50);
  assert.equal(summary.cur.bounce, 0.5);
  assert.equal(summary.cur.duration, 50);
  assert.equal(summary.sampled, false);
  assert.equal(calls.length, 1, 'one query reads both periods');
  assert.equal(calls[0].endpoint, 'https://api.cloudflare.com/client/v4/accounts/acc/analytics_engine/sql');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');

  const series = await store.series(q);
  assert.deepEqual(series.cur.visitors, [5, 0, 1], 'missing days are filled with zero');
  assert.deepEqual(series.prev.visitors, [0, 7, 0]);
  assert.deepEqual(series.top, ['google.com', null, null]);
  assert.deepEqual(series.topVisitors, [4, 0, 0]);
  assert.equal(calls.length, 3, 'days for both periods, and the top sources');

  const { flows, prev: prevFlows } = await store.flows(q);
  assert.deepEqual(flows[0], { source: 'news.ycombinator.com', page: '/blog', visitors: 12 });
  assert.deepEqual(prevFlows[0], { source: 'news.ycombinator.com', page: '/blog', visitors: 6 });
  assert.equal(prevFlows.length, 2);
  const hourly = await store.hourly(q);
  assert.equal(hourly.visitors.length, 72);
  assert.equal(hourly.visitors[1], 4);
  assert.equal(hourly.visitors[50], 2);
  assert.equal(hourly.visitors.reduce((a, b) => a + b), 6, 'hours outside the period are dropped');

  const { rows } = await store.breakdown(q, 'referrer');
  assert.equal(rows[0].key, 'google.com');
  assert.equal(rows[0].prev, null);
  assert.equal(rows[1].key, '');
  assert.equal(rows[1].prev.visitors, 2);
  assert.equal(calls.length, 6);
});

test('demo store answers every route with the same shapes', async () => {
  const q = parseQuery(url('summary?days=30'), SITES);
  const s = await demoStore.summary(q);
  assert.ok(s.cur.visitors > 0 && s.prev.visitors > 0);
  const ser = await demoStore.series(q);
  assert.equal(ser.cur.visitors.length, 30);
  assert.equal(ser.top.length, 30);
  for (const dim of ['path', 'entry', 'exit', 'referrer', 'channel']) {
    const { rows } = await demoStore.breakdown(q, dim);
    assert.ok(rows.length > 0, dim);
    assert.ok(rows[0].prev, dim);
  }
  const filtered = await demoStore.breakdown({ ...q, filters: { path: '/robin' } }, 'referrer');
  assert.ok(filtered.rows.every(r => r.visitors < s.cur.visitors));
  assert.equal(ser.topVisitors.length, 30);
  const { flows, prev: prevFlows } = await demoStore.flows(q);
  assert.ok(flows.length > 0 && flows.every(f => f.visitors > 0));
  assert.ok(prevFlows.length > 0);
  const onPath = await demoStore.flows({ ...q, filters: { path: '/robin' } });
  assert.ok(onPath.flows.every(f => f.page === '/robin'));
  assert.equal((await demoStore.hourly(q)).visitors.length, 30 * 24);
  const firsts = await demoStore.firsts(q);
  assert.ok(firsts.pages.some(r => r.key === '/swift' && r.day > 0), 'the sample adds one new page during the month');
  assert.ok(firsts.sources.some(r => r.key === 'bsky.app' && r.day > 0), 'and one new source');
  const live = await demoStore.live(q);
  assert.equal(live.now, 7);
});

test('referrer breakdowns say which channel each source belongs to', async () => {
  const res = await handleApi(new Request('https://worker.test/api/breakdown?dim=referrer&days=30'), { STORE: memoryKV({ sites: '["example.com"]' }), DEMO: 'true' }, { waitUntil() {} });
  const { rows } = await res.json();
  const ch = k => rows.find(r => r.key === k).channel;
  assert.equal(ch('perplexity.ai'), 'ai');
  assert.equal(ch('google.com'), 'search');
  assert.equal(ch(''), 'direct');
});

test('live visitors say how long ago they were last seen, and none are dropped', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ path: '/', referrer: '', country: 'US', first: 1000 - i * 30 - 60, last: 1000 - i * 30 }));
  const live = shapeLive(rows, 1000);
  assert.equal(live.visitors.length, 40);
  assert.equal(live.visitors[3].ago, 90);
  assert.equal(live.visitors[3].seconds, 60);
  assert.equal(live.now, 10, 'seen in the last 5 minutes');
});

/* ---------- goals ---------- */

const call = (path, env, init) => handleApi(new Request(`https://worker.test/api/${path}`, init), env, { waitUntil() {} });

test('a visit reached a goal when any of its pages is one of the goals, counted per first referrer', () => {
  const q = parseQuery(url('conversions?days=30'), SITES, Date.UTC(2026, 9, 27, 15));
  const sql = conversionsSql('lede', q, q.start, q.end, ['/signup', '/thanks']);
  assert.match(sql, /argMin\(blob4, timestamp\) AS src/);
  assert.ok(sql.includes(`hex(blob2) = '${hexOf('/signup')}' OR hex(blob2) = '${hexOf('/thanks')}'`));
  assert.match(sql, /GROUP BY src/);
});

test('demo conversions: visits and visits that reached the goal, per source', async () => {
  const q = parseQuery(url('conversions?days=30'), SITES);
  const c = await demoStore.conversions(q, ['/feeders']);
  assert.ok(c.visits > 0 && c.reached > 0 && c.reached < c.visits);
  assert.ok(c.rows.every(r => r.reached <= r.visits));
  const fb = c.rows.find(r => r.key === 'facebook.com'), all = c.reached / c.visits;
  assert.ok(fb.reached / fb.visits < all, 'people scrolling a feed mostly look and leave');
});

test('demo: no page has more visitors landing on it than viewing it, for any source', async () => {
  const q = parseQuery(url('flows?days=30'), SITES);
  const { flows } = await demoStore.flows(q);
  for (const src of ['claude.ai', 'google.com', '']) {
    const { rows } = await demoStore.breakdown({ ...q, filters: { referrer: src } }, 'path');
    for (const f of flows.filter(x => x.source === src)) {
      const viewed = rows.find(r => r.key === f.page)?.visitors ?? 0;
      assert.ok(f.visitors <= viewed + 1, `${src || 'Direct'} → ${f.page}: ${f.visitors} landed, ${viewed} viewed`);
    }
  }
});

test('a failed stats query says so in plain words, without the raw upstream reply', async () => {
  const store = sqlStore(ENV, async () => new Response('upstream timeout at node 7', { status: 500 }));
  const q = parseQuery(url('summary?days=3'), SITES);
  const realError = console.error; console.error = () => {};
  try {
    await assert.rejects(store.summary(q), e => e.status === 502 && !/upstream|500/.test(e.message) && /try again/i.test(e.message));
  } finally { console.error = realError; }
});

test('a token that may not read the stats is named as the cause, with how to make a new one', async () => {
  const realError = console.error; console.error = () => {};
  try {
    for (const status of [401, 403]) {
      const store = sqlStore(ENV, async () => new Response('Authentication error', { status }));
      await assert.rejects(store.summary(parseQuery(url('summary?days=3'), SITES)),
        e => e.status === 502 && /^Your Cloudflare token can’t read the stats\. Make a new one/.test(e.message) && e.message.includes('docs/how-it-works.md'));
    }
  } finally { console.error = realError; }
});

test('a refused query is not asked again, and says what to check', async () => {
  const realError = console.error; console.error = () => {};
  try {
    let asked = 0;
    const store = sqlStore(ENV, async () => (asked++, new Response('bad query', { status: 400 })));
    await assert.rejects(store.summary(parseQuery(url('summary?days=3'), SITES)), e => e.status === 502 && /Asking again won’t help/.test(e.message) && /DATASET in wrangler\.jsonc/.test(e.message));
    assert.equal(asked, 1);
    const missing = sqlStore({ ...ENV, DATASET: 'stats' }, async () => new Response('{"errors":[{"message":"unknown table: stats"}]}', { status: 422 }));
    await assert.rejects(missing.summary(parseQuery(url('summary?days=3'), SITES)), e => /^Cloudflare has no stats called “stats” yet\. Open a page of your site/.test(e.message));
  } finally { console.error = realError; }
});

test('the dataset the stats are read from is the one the Worker writes to', async () => {
  const { readFileSync } = await import('node:fs');
  const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const written = config.match(/"analytics_engine_datasets":\s*\[\{\s*"binding":\s*"EVENTS",\s*"dataset":\s*"(\w+)"/)[1];
  const vars = config.match(/"DATASET":\s*"(\w+)"/);
  let sql;
  await sqlStore({ ACCOUNT_ID: 'acc', ANALYTICS_TOKEN: 'tok', ...(vars && { DATASET: vars[1] }) }, async (_, init) => (sql = init.body, new Response('{"data":[]}'))).hourly(parseQuery(url('hourly?days=1'), SITES));
  assert.ok(sql.includes(` FROM ${written} WHERE`), `read from ${written}`);
});

test('engagement answers the median read and Web Vitals per page, CLS as its score, null with no data', async () => {
  const store = sqlStore(ENV, async () => new Response(JSON.stringify({ data: [
    { p: 1, key: '/docs', n: '20', ms: '900000', depth: '1500', median_ms: '31000', lcp: '2600', lcp_n: '14', inp: '240', inp_n: '5', cls: '120', cls_n: '14' },
    { p: 1, key: '/old', n: '3', ms: '9000', depth: '100', median_ms: '2000', lcp: '0', lcp_n: '0', inp: '0', inp_n: '0', cls: '0', cls_n: '0' },
  ] })));
  const { rows } = await store.engagement(parseQuery(url('engagement?days=7'), SITES));
  assert.deepEqual([rows[0].median, rows[0].lcp, rows[0].inp, rows[0].cls], [31000, 2600, 240, .12]);
  assert.deepEqual([rows[1].lcp, rows[1].inp, rows[1].cls], [null, null, null]);
});

test('demo: pages have a median read under their mean, and Web Vitals, one poor on LCP', async () => {
  const { rows } = await demoStore.engagement(parseQuery(url('engagement?days=30'), SITES));
  for (const r of rows) assert.ok(r.median > 0 && r.median / 1000 < r.time * 1.2, r.key);
  assert.ok(rows.find(r => r.key === '/owls').lcp > 4000);
  assert.equal(rows.find(r => r.key === '/about').lcp, null, 'a page with no data yet');
  assert.ok(rows.every(r => r.cls == null || r.cls < 1), 'CLS as a score');
});

test('flows can be just the visits that landed on one page', async () => {
  const q = parseQuery(url('flows?days=7'), SITES);
  assert.ok(flowSql('lede', q, undefined, '/blog').includes(`FROM lede WHERE`) && flowSql('lede', q, undefined, '/blog').includes(`) WHERE hex(landing) = '${hexOf('/blog')}' GROUP BY p, src, landing`));
  assert.ok(!flowSql('lede', q).includes('hex(landing)'));
  const env = { STORE: memoryKV({ sites: '["example.com"]' }), DEMO: 'true' };
  const res = await handleApi(new Request('https://worker.test/api/flows?days=30&landing=/owls'), env, { waitUntil() {} });
  const { flows, prev } = await res.json();
  assert.ok(flows.length > 0 && flows.every(f => f.page === '/owls') && prev.every(f => f.page === '/owls'));
});

test('breakdowns say the day each key was first seen, so the home screen asks no query for it', async () => {
  const calls = [];
  const env = { ...ENV, STORE: memoryKV({ sites: '["example.com"]' }) };
  const fetchImpl = fakeSql(calls);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, init) => fetchImpl(u, init);
  try {
    const qs = 'site=example.com&days=3&tz=0&n=firsts-test';
    const get = path => handleApi(new Request(`https://worker.test/api/${path}`), env, { waitUntil() {} }).then(r => r.json());
    const [paths, refs, firsts] = await Promise.all([get(`breakdown?${qs}&dim=path`), get(`breakdown?${qs}&dim=referrer`), get(`firsts?${qs}`)]);
    assert.equal(calls.length, 2, 'firsts reuses the two breakdowns');
    assert.deepEqual(firsts.sources, refs.rows.filter(r => r.visitors > 0).map(r => ({ key: r.key, day: r.first, visitors: r.visitors })));
    assert.equal(firsts.pages.length, paths.rows.filter(r => r.visitors > 0).length);
    // Asked on its own, in another order, it runs them itself.
    await get(`firsts?days=3&site=example.com&tz=0&n=alone`);
    assert.equal(calls.length, 4);
  } finally { globalThis.fetch = realFetch; }
  const merged = mergeRows([{ key: '/new', visitors: '4', d: '2' }], []);
  assert.equal(merged[0].first, 2);
});

test('stats may be kept by the viewer\'s browser only; the edge keeps its own copy', async () => {
  const put = [];
  const cache = { match: async () => undefined, put: async (k, r) => put.push([k, r]) };
  globalThis.caches = { default: cache };
  try {
    const env = { ...ENV, STORE: memoryKV({ sites: '["example.com"]' }) };
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeSql([]);
    let res;
    const waits = [];
    try { res = await handleApi(new Request('https://worker.test/api/summary?days=3&n=cache'), env, { waitUntil: p => waits.push(p) }); await Promise.all(waits); } finally { globalThis.fetch = realFetch; }
    assert.equal(res.headers.get('Cache-Control'), 'private, max-age=60');
    assert.equal(put[0][1].headers.get('Cache-Control'), 's-maxage=60');
    cache.match = async () => new Response('{"cur":{}}', { headers: { 'Cache-Control': 's-maxage=60' } });
    const hit = await handleApi(new Request('https://worker.test/api/summary?days=3&n=cache'), env, { waitUntil() {} });
    assert.equal(hit.headers.get('Cache-Control'), 'private, max-age=60');
    assert.deepEqual(await hit.json(), { cur: {} });
  } finally { delete globalThis.caches; }
});

async function busyAndQuiet(store, label) {
  const q = parseQuery(url('series?days=30'), SITES);
  const ser = await store.series(q);
  const v = ser.cur.visitors, sorted = v.slice().sort((a, b) => a - b), usual = sorted[15];
  const busy = v.indexOf(Math.max(...v)), quiet = v.indexOf(Math.min(...v));
  assert.ok(v[busy] >= usual * 1.5, `the busy day stands out (${label})`);
  assert.equal(ser.top[busy], 'facebook.com', label);
  assert.ok(v[quiet] <= usual * .4, `the quiet day looks like an outage (${label})`);
  return { busy, quiet };
}

test('demo: the sample has one busy day, led by facebook.com, and one quiet day', async () => {
  await busyAndQuiet(demoStore, 'today');
});

// The sample is built back from today, so weekends fall on different days of it depending on the date.
test('demo: the busy and quiet days stand out on whatever day of the week it is, always on the same days of the period', async () => {
  const spots = new Set();
  await onEachWeekday(async (store, day) => spots.add(JSON.stringify(await busyAndQuiet(store, day))));
  assert.equal(spots.size, 1, 'the busy and quiet days sit at the same place in the period every day');
});

test('changes are refused when another site sends them with the saved password', async () => {
  const { default: worker } = await import('../src/index.js');
  // Workers has this; Node doesn't.
  crypto.subtle.timingSafeEqual ??= (a, b) => Buffer.from(a).equals(Buffer.from(b));
  const kv = new Map([['sites', '["example.com"]']]);
  const env = { DASHBOARD_PASSWORD: 'pw', STORE: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) } };
  const signIn = await worker.fetch(new Request('https://lede.test/api/signin', {
    method: 'POST', headers: { Origin: 'https://lede.test' }, body: JSON.stringify({ password: 'pw' }),
  }), env, { waitUntil() {} });
  const cookie = signIn.headers.get('Set-Cookie').split(';')[0];
  const post = headers => worker.fetch(new Request('https://lede.test/api/sites', {
    method: 'POST', headers: { Cookie: cookie, ...headers }, body: JSON.stringify({ site: 'evil.test' }),
  }), env, { waitUntil() {} });
  const refused = await post({ Origin: 'https://evil.test' });
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: 'Changes can only be made from the dashboard.' }, 'JSON, so the dashboard can show it');
  assert.equal((await post({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.deepEqual(JSON.parse(kv.get('sites')), ['example.com']);
  assert.equal((await post({ Origin: 'https://lede.test', 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  assert.deepEqual(JSON.parse(kv.get('sites')), ['example.com', 'evil.test']);
  // Notes too: another site can neither add one nor remove one.
  const note = (method, headers, q = '') => worker.fetch(new Request(`https://lede.test/api/notes?site=example.com${q}`, {
    method, headers: { Cookie: cookie, ...headers }, body: method === 'PUT' ? JSON.stringify({ day: '2026-10-16', text: 'Hi' }) : undefined,
  }), env, { waitUntil() {} });
  assert.equal((await note('PUT', { Origin: 'https://evil.test' })).status, 403);
  assert.equal(kv.get('settings:example.com'), undefined);
  assert.equal((await note('PUT', { Origin: 'https://lede.test' })).status, 200);
  assert.equal((await note('DELETE', { 'Sec-Fetch-Site': 'cross-site' }, '&day=2026-10-16')).status, 403);
  assert.equal(JSON.parse(kv.get('settings:example.com')).notes.length, 1);
});

test('a rate-limited stats query is tried once more', async () => {
  const replies = [new Response('slow down', { status: 429, headers: { 'Retry-After': '30' } }), new Response(JSON.stringify({ data: [{ x: 1 }] }))];
  const waited = [];
  const data = await runSql(ENV, 'SELECT 1', async () => replies.shift(), async ms => waited.push(ms));
  assert.deepEqual(data, [{ x: 1 }]);
  assert.deepEqual(waited, [2000]);
});

/* ---------- engagement and links ---------- */

test('stats count page views only; engagement and link queries ask for their own events', () => {
  const q = parseQuery(url('summary?days=7&path=%2Fdocs'), SITES);
  assert.ok(where(q, 0, 10).includes(`blob8 = 'pageview'`));
  const all = [summarySql, seriesSql, topSourceSql, flowSql].map(f => f('lede', q))
    .concat(hourlySql('lede', q, q.start, q.end), breakdownSql('lede', q, 'path'), breakdownSql('lede', q, 'referrer'), conversionsSql('lede', q, q.start, q.end, ['/a']));
  for (const sql of all) {
    assert.ok(sql.includes(`blob8 = 'pageview'`), sql);
    assert.ok(!sql.includes(`'ping'`), 'a ping is not a page view, a visit or a bounce');
  }
  const live = liveSql('lede', 'example.com');
  assert.ok(live.includes(`blob8 = 'pageview'`) && live.includes(`blob8 = 'ping'`), 'someone still reading a page is here now');
  assert.ok(!live.includes(`'engagement'`), 'someone leaving a page is not someone here now');
  const eng = engagementSql('lede', q);
  assert.ok(eng.includes(`blob8 = 'engagement'`) && !eng.includes(`'pageview'`));
  assert.match(eng, /sum\(_sample_interval \* double1\) AS ms, sum\(_sample_interval \* double2\) AS depth/);
  assert.ok(eng.includes(`hex(blob2) = '${hexOf('/docs')}'`), 'filters still apply');
  const links = linksSql('lede', q);
  assert.ok(links.includes(`(blob8 = 'outbound' OR blob8 = 'download')`));
  assert.match(links, /blob8 AS kind, blob13 AS key, count\(DISTINCT blob6\) AS visitors/);
});

test('SQL store averages engagement per page and splits links from downloads', async () => {
  const calls = [];
  const q = parseQuery(url('engagement?days=7'), SITES);
  calls.prevStart = q.prevStart;
  const store = sqlStore(ENV, fakeSql(calls));
  const { rows } = await store.engagement(q);
  const none = { median: 0, lcp: null, inp: null, cls: null };
  assert.deepEqual(rows[0], { key: '/docs', views: 20, time: 45, scroll: .75, ...none, prev: { views: 10, time: 30, scroll: .5, ...none } });
  assert.equal(rows[1].prev, null);
  const links = await store.links(q);
  assert.deepEqual(links.outbound, [{ key: 'github.com/acme', visitors: 6, clicks: 9, prev: 3 }]);
  assert.deepEqual(links.downloads, [{ key: 'example.com/guide.pdf', visitors: 2, clicks: 2, prev: null }]);
});

test('the engagement query for one page also counts how many got 10%, 20%... 100% of the way down, in the same query', () => {
  const page = engagementSql('lede', parseQuery(url('engagement?days=7&path=%2Fdocs'), SITES));
  for (let d = 10; d <= 100; d += 10) assert.ok(page.includes(`sumIf(_sample_interval, double2 >= ${d}) AS r${d}`), `band ${d}`);
  assert.match(page, /^SELECT if\(timestamp >= toDateTime\(\d+\), 1, 0\) AS p, /, 'both periods at once');
  const all = engagementSql('lede', parseQuery(url('engagement?days=7'), SITES));
  assert.ok(!all.includes('AS r10'), 'the list of every page has no use for them');
});

test('scroll bands become the share of readers still there at each tenth of the page', async () => {
  const { rows: [r] } = toEngagement([{ key: '/a', n: '40', ms: '0', depth: '0', ...bands(40, 40, 30, 30, 20, 20, 10, 10, 10, 4) }], []);
  assert.deepEqual(r.reach, [1, 1, .75, .75, .5, .5, .25, .25, .25, .1]);
  assert.equal(toEngagement([{ key: '/a', n: '4', ms: '0', depth: '0' }], []).rows[0].reach, undefined, 'only a single page asks for them');
  assert.deepEqual(toEngagement([{ key: '/a', n: '0', ...bands(0, 0, 0, 0, 0, 0, 0, 0, 0, 0) }], []).rows[0].reach, Array(10).fill(0));
  const calls = [];
  const store = sqlStore(ENV, fakeSql(calls));
  const { rows } = await store.engagement(parseQuery(url('engagement?days=7&path=%2Fdocs'), SITES));
  assert.equal(calls.length, 1, 'no query of its own');
  assert.deepEqual(rows[0].reach, [1, .9, .8, .7, .4, .35, .3, .25, .2, .1]);
  assert.deepEqual(rows[0].prev.reach, [1, 1, .9, .8, .7, .6, .5, .5, .5, .5]);
});

test('demo: /owls loses a third of its readers halfway down; other pages fade gently', async () => {
  const q = parseQuery(url('engagement?days=30'), SITES);
  const page = async k => (await demoStore.engagement({ ...q, filters: { path: k } })).rows[0];
  const owls = await page('/owls');
  assert.equal(owls.reach.length, 10);
  assert.ok(owls.reach.every((x, i) => x > 0 && x <= 1 && (!i || x <= owls.reach[i - 1])), 'nobody gets further by scrolling less');
  const drops = owls.reach.map((x, i) => (i ? owls.reach[i - 1] : 1) - x);
  assert.equal(drops.indexOf(Math.max(...drops)), 4, 'the drop comes between 40% and 50%');
  assert.ok(Math.max(...drops) > .25 && owls.reach[4] < .5);
  assert.ok(owls.prev.reach, 'last period too');
  const robin = await page('/robin');
  assert.ok(Math.max(...robin.reach.map((x, i) => (i ? robin.reach[i - 1] : 1) - x)) < .15);
  assert.ok(Math.abs(owls.scroll - (owls.reach.reduce((a, b) => a + b) - owls.reach[9] / 2 + .5) / 10) < .06, 'the average agrees with the bands');
  const all = await demoStore.engagement(q);
  assert.ok(all.rows.every(r => !r.reach), 'the list of every page leaves them out');
});

test('demo: pages are read for a plausible time, and links and downloads follow the page filter', async () => {
  const q = parseQuery(url('engagement?days=30'), SITES);
  const { rows } = await demoStore.engagement(q);
  assert.ok(rows.length > 5 && rows.every(r => r.time > 5 && r.time < 300 && r.scroll > 0 && r.scroll <= 1));
  const time = k => rows.find(r => r.key === k).time;
  assert.ok(time('/owls') > time('/'), 'a long guide holds people longer than the home page');
  const one = await demoStore.engagement({ ...q, filters: { path: '/owls' } });
  assert.deepEqual(one.rows.map(r => r.key), ['/owls']);
  const links = await demoStore.links(q);
  assert.ok(links.outbound.length && links.downloads.length);
  assert.ok(links.downloads.every(r => r.key.startsWith('example.com/')), 'files sit on the site itself');
  const owls = await demoStore.links({ ...q, filters: { path: '/owls' } });
  assert.deepEqual(owls.downloads.map(r => r.key), ['example.com/files/owl-calls.mp3']);
  const res = await handleApi(new Request('https://worker.test/api/links?days=7'), { STORE: memoryKV({ sites: '["example.com"]' }), DEMO: 'true' }, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).outbound.length > 0);
});

/* ---------- countries, devices and browsers ---------- */

test('countries, devices and browsers come from one query, keyed by each visit\'s first event', () => {
  const q = parseQuery(url('audience?days=7'), SITES);
  const sql = audienceSql('lede', q);
  for (const [col, as] of [['blob9', 'country'], ['blob14', 'device'], ['blob15', 'browser']]) assert.ok(sql.includes(`argMin(${col}, timestamp) AS ${as}`), as);
  assert.match(sql, /GROUP BY p, country, device, browser/);
  assert.ok(sql.includes(`toDateTime(${q.prevStart})`) && sql.includes(`toDateTime(${q.start})`), 'both periods at once');
  assert.ok(sql.includes("blob8 = 'pageview'"));
});

// One row per country, device and browser, as audienceSql returns them.
const aud = (p, country, device, browser, visitors, bounces = 0) => ({ p, country, device, browser, visitors: String(visitors), visits: String(visitors), views: String(visitors * 2), bounces: String(bounces), total_time: '0' });

test('the three lists add up their rows, biggest first, each with last period\'s figures', () => {
  const A = toAudience([aud(1, 'US', 'phone', 'safari', 30, 15), aud(1, 'US', 'computer', 'chrome', 20, 5), aud(1, 'AR', 'phone', 'chrome', 40, 20)],
    [aud(0, 'US', 'phone', 'safari', 10), aud(0, 'AR', 'phone', 'chrome', 10)]);
  assert.deepEqual(A.country.map(r => [r.key, r.visitors, r.prev?.visitors]), [['US', 50, 10], ['AR', 40, 10]]);
  assert.deepEqual(A.device.map(r => [r.key, r.visitors, r.bounce, r.prev?.visitors ?? null]), [['phone', 70, 35 / 70, 20], ['computer', 20, .25, null]]);
  assert.deepEqual(A.browser.map(r => r.key), ['chrome', 'safari']);
  assert.equal(A.partial, null);
});

test('visits stored before devices were recorded count for countries only, and the part-recorded period shows no change', () => {
  // Recording started during this period: its unrecorded visits are left out, and nothing is compared.
  const cur = toAudience([aud(1, 'US', '', '', 50), aud(1, 'US', 'phone', 'safari', 20)], [aud(0, 'US', '', '', 60)]);
  assert.equal(cur.partial, 'cur');
  assert.deepEqual(cur.country.map(r => [r.key, r.visitors, r.prev.visitors]), [['US', 70, 60]]);
  assert.deepEqual(cur.device.map(r => [r.key, r.visitors, r.prev]), [['phone', 20, null]]);
  assert.deepEqual(cur.browser.map(r => [r.key, r.prev]), [['safari', null]]);
  // Recording started during the period before: this period is whole, but there is still nothing to compare with.
  const prev = toAudience([aud(1, 'US', 'phone', 'safari', 50)], [aud(0, 'US', '', '', 30), aud(0, 'US', 'phone', 'safari', 5)]);
  assert.equal(prev.partial, 'prev');
  assert.deepEqual(prev.device.map(r => [r.key, r.visitors, r.prev]), [['phone', 50, null]]);
  assert.equal(prev.country[0].prev.visitors, 35);
  // Nothing at all yet.
  assert.deepEqual(toAudience([], []), { country: [], device: [], browser: [], partial: null });
});

test('SQL store answers countries, devices and browsers with one query', async () => {
  const calls = [];
  const store = sqlStore(ENV, fakeSql(calls));
  const A = await store.audience(parseQuery(url('audience?days=7'), SITES));
  assert.equal(calls.length, 1);
  assert.deepEqual(A.country.map(r => [r.key, r.visitors, r.prev?.visitors]), [['AR', 40, 20], ['US', 40, 25]]);
  assert.deepEqual(A.device.map(r => [r.key, r.visitors]), [['phone', 50], ['computer', 30]]);
  assert.equal(A.device[0].bounce, 36 / 60);
});

test('demo: countries, devices and browsers add up to everyone, and phones leave sooner than computers', async () => {
  const res = await handleApi(new Request('https://worker.test/api/audience?days=30'), { STORE: memoryKV({ sites: '["example.com"]' }), DEMO: 'true' }, { waitUntil() {} });
  assert.equal(res.status, 200);
  const A = await res.json();
  const s = await demoStore.summary(parseQuery(url('summary?days=30'), SITES));
  for (const dim of ['country', 'device', 'browser']) {
    assert.ok(A[dim].length > 1 && A[dim].every(r => r.key && r.prev), dim);
    assert.ok(Math.abs(A[dim].reduce((a, r) => a + r.visitors, 0) - s.cur.visitors) < 1, `${dim} adds up to everyone`);
  }
  const by = Object.fromEntries(A.device.map(r => [r.key, r]));
  assert.ok(by.phone.bounce - by.computer.bounce >= .1);
  assert.equal(A.partial, null);
});
