// Stand-ins for Cloudflare's bindings and the Analytics Engine SQL API that count every call, so the
// bench can measure what a change costs against the free limits without touching Cloudflare.

export function counters() {
  return { sql: 0, writes: 0, kvReads: 0, kvWrites: 0, api: 0, beacons: 0 };
}

export function memoryKV(count, init = {}) {
  const m = new Map(Object.entries(init));
  return {
    get: async k => { count.kvReads++; return m.get(k) ?? null; },
    put: async (k, v) => { count.kvWrites++; m.set(k, v); },
  };
}

export const events = count => ({ writeDataPoint() { count.writes++; } });

// Answers each query by its shape, with enough rows for every chart to draw. Fixed rows, so two runs
// of the same code do the same work.
const PAGES = ['/', '/blog', '/docs', '/pricing', '/about', '/blog/launch', '/docs/install', '/changelog'];
const REFS = ['google.com', '', 'news.ycombinator.com', 'twitter.com', 'github.com', 'duckduckgo.com', 'reddit.com', 'bing.com'];
const COUNTRIES = ['US', 'AR', 'DE', 'GB', 'FR', 'BR', 'JP', 'IN'];
// Live rows are stamped against the clock the bench starts with, so who is here now stays the same.
const NOW = Math.floor(Date.now() / 1000);
const both = f => [...f(1), ...f(0)];
const keyed = keys => both(p => keys.map((key, i) => ({ p, key, visitors: String((40 - i * 4) * (p ? 2 : 1)), visits: String(50 - i * 4), views: String(90 - i * 8), bounces: String(20 - i), total_time: String(3000 - i * 200) })));

function rowsFor(sql) {
  if (sql.includes('argMax(blob2')) return Array.from({ length: 6 }, (_, i) => ({ visitor: String(i), path: PAGES[i], referrer: REFS[i], country: COUNTRIES[i], first: String(NOW - 600), last: String(NOW - i * 40) }));
  if (sql.includes('AS hr')) return Array.from({ length: 24 * 30 }, (_, hr) => ({ hr: String(hr), visitors: String(5 + (hr * 7) % 23) }));
  if (sql.includes('AS landing')) return both(p => REFS.flatMap((src, i) => PAGES.slice(0, 4).map((landing, j) => ({ p, src, landing, visitors: String((12 - i - j) * (p ? 2 : 1) + 1) }))));
  if (sql.includes('AS d, count(DISTINCT visitor)')) return both(p => Array.from({ length: 60 }, (_, d) => ({ p, d: String(d), visitors: String(80 + (d * 13) % 40), visits: String(100 + d), views: String(200 + d * 2), bounces: String(40 + d % 9), total_time: String(9000 + d * 50) })));
  if (sql.includes('AS ref,')) return Array.from({ length: 30 }, (_, d) => ({ d: String(d), ref: REFS[d % REFS.length], visitors: String(10 + d % 7) }));
  if (sql.includes('AS key, intDiv')) return PAGES.concat(REFS).map((key, i) => ({ key, d: String(i % 30), visitors: String(3 + i) }));
  if (sql.includes('AS reached')) return REFS.map((src, i) => ({ src, visits: String(40 - i * 3), reached: String(9 - i) }));
  if (sql.includes('AS ms')) return both(p => PAGES.map((key, i) => ({ p, key, n: String(20 - i), ms: String(900000 - i * 50000), depth: String(1500 - i * 100) })));
  if (sql.includes('AS kind')) return both(p => [{ p, kind: 'outbound', key: 'github.com/acme', visitors: '6', clicks: '9' }, { p, kind: 'download', key: 'example.com/guide.pdf', visitors: '2', clicks: '2' }]);
  if (sql.includes('AS key')) return keyed(sql.includes('blob4 AS key') ? REFS : sql.includes('blob9 AS key') ? COUNTRIES : PAGES);
  return both(p => [{ p, visitors: String(p ? 1200 : 1000), visits: '1500', views: '3000', bounces: '700', total_time: '90000', sampled: '0' }]);
}

// A fetch that answers the Analytics Engine SQL API and the account lookup; anything else is refused.
export function fakeFetch(count) {
  return async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/analytics_engine/sql')) {
      count.sql++;
      const data = rowsFor(String(init.body));
      return new Response(JSON.stringify({ meta: [], data, rows: data.length }), { status: 200 });
    }
    if (u === 'https://api.cloudflare.com/client/v4/accounts') return new Response(JSON.stringify({ success: true, result: [{ id: 'acc' }] }));
    throw new Error(`bench: unexpected fetch to ${u}`);
  };
}

export const SITES = ['example.com', '127.0.0.1'];

export function benchEnv(count, { demo = false, assets } = {}) {
  return {
    ...(demo ? { DEMO: 'true' } : { ANALYTICS_TOKEN: 'tok', ACCOUNT_ID: 'acc' }),
    STORE: memoryKV(count, { sites: JSON.stringify(SITES) }),
    EVENTS: events(count),
    ASSETS: assets,
  };
}
