// The sample at sryo.github.io/lede runs the Worker in the visitor's browser: the dashboard's /api/* requests are
// answered by src/index.js with DEMO on, from an in-memory store, so nothing reaches Cloudflare and no visitor
// can use up anyone's free limits. Nothing here touches window or location, so the tests run it in Node.
import worker from '../src/index.js';

// A KV namespace in a Map, for one page load.
export function memoryKV(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    async get(key, type) {
      const v = m.get(key) ?? null;
      return v != null && type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { m.set(key, String(value)); },
    async delete(key) { m.delete(key); },
  };
}

// No DASHBOARD_PASSWORD, so nobody is asked to sign in and the Workers-only timingSafeEqual is never reached.
// No AI either: the sample has its own insight line. One site is there already, so the dashboard opens on its stats.
export const demoEnv = () => ({ DEMO: 'true', STORE: memoryKV({ sites: '["example.com"]' }) });

const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// A share link would point at a /s/ page that no server here can open, so making or stopping one is refused,
// and the dashboard shows why.
const NO_SHARES = 'Read-only links work on your own Lede, not in this sample.';

// A fetch that answers this origin's /api/* with the Worker and hands everything else to the network. /lede is
// the tracker's address to the Worker, and here it is the page's own, so it never goes there.
export function demoFetch(realFetch, origin, env = demoEnv()) {
  // rememberOrigin runs after the answer; a failure there must not surface as an unhandled rejection.
  const ctx = { waitUntil(p) { p.catch(() => {}); } };
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin + '/');
    if (url.origin !== origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    const req = new Request(input instanceof Request ? input : url, init);
    if (url.pathname === '/api/shares' && (req.method === 'POST' || req.method === 'DELETE')) return Promise.resolve(json({ error: NO_SHARES }, 403));
    // As with a real fetch, an error in the Worker becomes a rejection rather than a throw.
    return Promise.resolve().then(() => worker.fetch(req, env, ctx));
  };
}

// The site is served under base (/lede/), and the dashboard's routes are written for /.
export function withBase(base, { viewToUrl: to, urlToView: from }) {
  return {
    viewToUrl: (...a) => base + to(...a).slice(1),
    urlToView: (p, s) => from(p + '/' === base ? '/' : p.startsWith(base) ? p.slice(base.length - 1) : p, s),
  };
}
