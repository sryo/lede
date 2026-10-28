// Stand-ins for Cloudflare's bindings and the Analytics Engine SQL API that count every call, so the
// bench can measure what a change costs against the free limits without touching Cloudflare.

export function counters() {
  return { sql: 0, writes: 0, kvReads: 0, kvWrites: 0, kvLists: 0, api: 0, beacons: 0, screenshots: 0, browserMs: 0 };
}

// KV as Workers has it, for what Lede uses: text or bytes, metadata, and listing by prefix. Expiry isn't
// kept; nothing here lives long enough to see it.
export function memoryKV(count, init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, { v }]));
  const as = (e, type) => {
    if (!e) return null;
    const { v } = e, text = typeof v === 'string';
    if (type === 'arrayBuffer') return text ? new TextEncoder().encode(v).buffer : v.slice(0);
    const s = text ? v : new TextDecoder().decode(v);
    return type === 'json' ? JSON.parse(s) : s;
  };
  const typeOf = t => (typeof t === 'object' ? t?.type : t);
  return {
    get: async (k, t) => { count.kvReads++; return as(m.get(k), typeOf(t)); },
    getWithMetadata: async (k, t) => { count.kvReads++; const e = m.get(k); return { value: as(e, typeOf(t)), metadata: e?.metadata ?? null }; },
    put: async (k, v, o = {}) => {
      count.kvWrites++;
      const bytes = v instanceof ArrayBuffer ? v.slice(0) : ArrayBuffer.isView(v) ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : null;
      m.set(k, { v: bytes ?? String(v), metadata: o.metadata ?? null });
    },
    delete: async k => { count.kvWrites++; m.delete(k); },
    list: async ({ prefix = '' } = {}) => {
      count.kvLists++;
      const keys = [...m].filter(([k]) => k.startsWith(prefix)).map(([name, e]) => (e.metadata ? { name, metadata: e.metadata } : { name }));
      return { keys, list_complete: true };
    },
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
const READ = [.95, .9, .85, .8, .5, .45, .4, .38, .36, .35];
const keyed = keys => both(p => keys.map((key, i) => ({ p, key, visitors: String((40 - i * 4) * (p ? 2 : 1)), visits: String(50 - i * 4), views: String(90 - i * 8), bounces: String(20 - i), total_time: String(3000 - i * 200) })));

function rowsFor(sql) {
  if (sql.includes('argMax(blob2')) return Array.from({ length: 6 }, (_, i) => ({ visitor: String(i), path: PAGES[i], referrer: REFS[i], country: COUNTRIES[i], first: String(NOW - 600), last: String(NOW - i * 40) }));
  if (sql.includes('AS hr')) return Array.from({ length: 24 * 30 }, (_, hr) => ({ hr: String(hr), visitors: String(5 + (hr * 7) % 23) }));
  if (sql.includes('AS landing')) return both(p => REFS.flatMap((src, i) => PAGES.slice(0, 4).map((landing, j) => ({ p, src, landing, visitors: String((12 - i - j) * (p ? 2 : 1) + 1) }))));
  if (sql.includes('AS d, count(DISTINCT visitor)')) return both(p => Array.from({ length: 60 }, (_, d) => ({ p, d: String(d), visitors: String(80 + (d * 13) % 40), visits: String(100 + d), views: String(200 + d * 2), bounces: String(40 + d % 9), total_time: String(9000 + d * 50) })));
  if (sql.includes('AS ref,')) return Array.from({ length: 30 }, (_, d) => ({ d: String(d), ref: REFS[d % REFS.length], visitors: String(10 + d % 7) }));
  if (sql.includes('AS key, intDiv')) return PAGES.concat(REFS).map((key, i) => ({ key, d: String(i % 30), visitors: String(3 + i) }));
  if (sql.includes('AS reached')) return REFS.map((src, i) => ({ src, visits: String(40 - i * 3), reached: String(9 - i) }));
  // One page's view also asks how many got each tenth of the way down; enough reads to draw its picture.
  if (sql.includes('AS r10')) return both(p => PAGES.map((key, i) => {
    const n = 200 - i * 10;
    return { p, key, n: String(n), ms: String(900000 - i * 50000), depth: String(n * 60),
      ...Object.fromEntries(READ.map((x, k) => [`r${(k + 1) * 10}`, String(Math.round(n * x))])) };
  }));
  if (sql.includes('AS ms')) return both(p => PAGES.map((key, i) => ({ p, key, n: String(20 - i), ms: String(900000 - i * 50000), depth: String(1500 - i * 100) })));
  if (sql.includes('AS kind')) return both(p => [{ p, kind: 'outbound', key: 'github.com/acme', visitors: '6', clicks: '9' }, { p, kind: 'download', key: 'example.com/guide.pdf', visitors: '2', clicks: '2' }]);
  if (sql.includes('AS key')) return keyed(sql.includes('blob4 AS key') ? REFS : sql.includes('blob9 AS key') ? COUNTRIES : PAGES);
  return both(p => [{ p, visitors: String(p ? 1200 : 1000), visits: '1500', views: '3000', bounces: '700', total_time: '90000', sampled: '0' }]);
}

// A tiny jpeg (one white pixel), and the browser time Cloudflare reports for taking a picture.
const JPEG = Uint8Array.from(atob('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='), c => c.charCodeAt(0));
export const SHOT_MS = 3000;

// A fetch that answers the Analytics Engine SQL API, the account lookup and Browser Rendering's screenshot;
// anything else is refused.
export function fakeFetch(count) {
  return async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/browser-rendering/screenshot')) {
      count.screenshots++;
      count.browserMs += SHOT_MS;
      return new Response(JPEG, { headers: { 'Content-Type': 'image/jpeg', 'X-Browser-Ms-Used': String(SHOT_MS) } });
    }
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
