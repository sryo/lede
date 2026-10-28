// Stand-ins for Cloudflare's bindings and the Analytics Engine SQL API that count every call, so the
// bench can measure what a change costs against the free limits without touching Cloudflare.

export function counters() {
  return { sql: 0, writes: 0, kvReads: 0, kvWrites: 0, kvLists: 0, api: 0, beacons: 0, screenshots: 0, browserMs: 0, ai: 0, aiTokens: 0, webhooks: 0 };
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

// Workers AI, counting each ask and the tokens it sends (a token for about every 4 characters; Neurons
// follow tokens). What comes back is the model saying it has nothing to add, so a line is never shown and
// what's counted is the cost of asking.
export function fakeAI(count) {
  return {
    async run(model, { messages = [] } = {}) {
      count.ai++;
      count.aiTokens += Math.ceil(messages.reduce((n, m) => n + String(m.content ?? '').length, 0) / 4);
      return { response: 'Nothing to add.' };
    },
  };
}

// Answers each query by its shape, with enough rows for every chart to draw. Fixed rows, so two runs
// of the same code do the same work.
const PAGES = ['/', '/blog', '/docs', '/pricing', '/about', '/blog/launch', '/docs/install', '/changelog'];
const REFS = ['google.com', '', 'news.ycombinator.com', 'twitter.com', 'github.com', 'duckduckgo.com', 'reddit.com', 'bing.com'];
const COUNTRIES = ['US', 'AR', 'DE', 'GB', 'FR', 'BR', 'JP', 'IN'];
// Live rows are stamped against the clock the bench starts with, so who is here now stays the same.
export const NOW = Math.floor(Date.now() / 1000);
const both = f => [...f(1), ...f(0)];
const READ = [.95, .9, .85, .8, .5, .45, .4, .38, .36, .35];
const keyed = keys => both(p => keys.map((key, i) => ({ p, key, visitors: String((40 - i * 4) * (p ? 2 : 1)), visits: String(50 - i * 4), views: String(90 - i * 8), bounces: String(20 - i), total_time: String(3000 - i * 200), d: String(i % 30) })));
// Median read and Web Vitals at the 75th percentile, as engagementSql names them.
const vitals = i => ({ median_ms: String(30000 - i * 2000), lcp: String(1800 + i * 300), lcp_n: '12', inp: String(120 + i * 40), inp_n: '4', cls: String(i * 30), cls_n: '12' });

// A big site: every list query answers as many rows as its LIMIT lets it, each row's names made
// different, so the Worker shapes the most it ever has to. Counts and periods stay as the rows they copy.
const KEEP = new Set(['p', 'kind']);
function fill(sql, rows) {
  const limit = Number(/LIMIT (\d+)$/.exec(sql)?.[1]);
  if (!rows.length || !(limit > rows.length) || sql.includes('AS hr')) return rows;
  return Array.from({ length: limit }, (_, i) => Object.fromEntries(Object.entries(rows[i % rows.length])
    .map(([k, v]) => [k, KEEP.has(k) || typeof v !== 'string' || /^\d+$/.test(v) || i < rows.length ? v : `${v}-${i}`])));
}

function rowsFor(sql, big) {
  return big ? fill(sql, siteRows(sql)) : siteRows(sql);
}

function siteRows(sql) {
  if (sql.includes('argMax(blob2')) return Array.from({ length: 6 }, (_, i) => ({ visitor: String(i), path: PAGES[i], referrer: REFS[i], country: COUNTRIES[i], first: String(NOW - 600), last: String(NOW - i * 40) }));
  if (sql.includes('AS hr')) return Array.from({ length: 24 * 30 }, (_, hr) => ({ hr: String(hr), visitors: String(5 + (hr * 7) % 23) }));
  if (sql.includes('AS landing')) return both(p => REFS.flatMap((src, i) => PAGES.slice(0, 4).map((landing, j) => ({ p, src, landing, visitors: String((12 - i - j) * (p ? 2 : 1) + 1) }))));
  if (sql.includes('AS d, count(DISTINCT visitor)')) return both(p => Array.from({ length: 60 }, (_, d) => ({ p, d: String(d), visitors: String(80 + (d * 13) % 40), visits: String(100 + d), views: String(200 + d * 2), bounces: String(40 + d % 9), total_time: String(9000 + d * 50) })));
  if (sql.includes('AS ref,')) return Array.from({ length: 30 }, (_, d) => ({ d: String(d), ref: REFS[d % REFS.length], visitors: String(10 + d % 7) }));
  if (sql.includes('AS reached')) return REFS.map((src, i) => ({ src, visits: String(40 - i * 3), reached: String(9 - i) }));
  // One page's view also asks how many got each tenth of the way down; enough reads to draw its picture.
  if (sql.includes('AS r10')) return both(p => PAGES.map((key, i) => {
    const n = 200 - i * 10;
    return { p, key, n: String(n), ms: String(900000 - i * 50000), depth: String(n * 60), ...vitals(i),
      ...Object.fromEntries(READ.map((x, k) => [`r${(k + 1) * 10}`, String(Math.round(n * x))])) };
  }));
  if (sql.includes('AS ms')) return both(p => PAGES.map((key, i) => ({ p, key, n: String(20 - i), ms: String(900000 - i * 50000), depth: String(1500 - i * 100), ...vitals(i) })));
  if (sql.includes('AS kind')) return both(p => [{ p, kind: 'outbound', key: 'github.com/acme', visitors: '6', clicks: '9' }, { p, kind: 'download', key: 'example.com/guide.pdf', visitors: '2', clicks: '2' }]);
  if (sql.includes('AS key')) return keyed(sql.includes('blob4 AS key') ? REFS : sql.includes('blob9 AS key') ? COUNTRIES : PAGES);
  return both(p => [{ p, visitors: String(p ? 1200 : 1000), visits: '1500', views: '3000', bounces: '700', total_time: '90000', sampled: '0' }]);
}

// A tiny jpeg (one white pixel), and the browser time Cloudflare reports for taking a picture.
const JPEG = Uint8Array.from(atob('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='), c => c.charCodeAt(0));
export const SHOT_MS = 3000;

export const WEBHOOK = 'https://hooks.bench.test/lede';

// A fetch that answers the Analytics Engine SQL API, the account lookup, Browser Rendering's screenshot and
// the alert webhook; anything else is refused. profile.big answers as a big site does (see fill); it can be changed between calls.
export function fakeFetch(count, profile = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/browser-rendering/screenshot')) {
      count.screenshots++;
      count.browserMs += SHOT_MS;
      return new Response(JPEG, { headers: { 'Content-Type': 'image/jpeg', 'X-Browser-Ms-Used': String(SHOT_MS) } });
    }
    if (u.endsWith('/analytics_engine/sql')) {
      count.sql++;
      const data = rowsFor(String(init.body), profile.big);
      return new Response(JSON.stringify({ meta: [], data, rows: data.length }), { status: 200 });
    }
    if (u === WEBHOOK) { count.webhooks++; return new Response('ok'); }
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
    AI: fakeAI(count),
    ASSETS: assets,
  };
}
