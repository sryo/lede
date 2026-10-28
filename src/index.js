import { collect } from './collect.js';
import { handleApi } from './api.js';

async function sameSecret(a, b) {
  const enc = s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [x, y] = await Promise.all([enc(a), enc(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}

const COOKIE = 'lede';
const YEAR = 365 * 24 * 3600;
const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// The cookie holds a hash of the password, so changing DASHBOARD_PASSWORD signs everyone out.
async function pass(password) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`lede|${password}`));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Only the stats need the password, and only when DASHBOARD_PASSWORD is set. The dashboard page
// itself is public code; without the cookie it shows its own password card.
async function signedIn(req, env) {
  if (!env.DASHBOARD_PASSWORD) return true;
  const cookie = (req.headers.get('Cookie') || '').split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`));
  return !!cookie && sameSecret(cookie.slice(COOKIE.length + 1), await pass(env.DASHBOARD_PASSWORD));
}

async function signIn(req, env) {
  const { password = '' } = await req.json().catch(() => ({}));
  if (env.DASHBOARD_PASSWORD && !await sameSecret(String(password), env.DASHBOARD_PASSWORD)) {
    return json({ error: 'That’s not the password.' }, 401);
  }
  const headers = env.DASHBOARD_PASSWORD
    ? { 'Set-Cookie': `${COOKIE}=${await pass(env.DASHBOARD_PASSWORD)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${YEAR}` }
    : {};
  return new Response(null, { status: 204, headers });
}

// A page elsewhere could post a form here. Changes (signing in, adding a site, saving goals) are only
// taken from the dashboard's own origin.
function crossSite(req, url) {
  if (req.method === 'GET' || req.method === 'HEAD') return false;
  const origin = req.headers.get('Origin');
  return req.headers.get('Sec-Fetch-Site') === 'cross-site' || (origin != null && origin !== url.origin);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const { pathname } = url;
    // Blocklists match /api/event on workers.dev (it's Plausible's path), so the tracker posts to /lede.
    // The old path still works for trackers browsers cached before the move.
    if (pathname === '/lede' || pathname === '/api/event') return collect(req, env);
    // Everything else but /api/* is served straight from the assets (see wrangler.jsonc); this is for local dev.
    if (!pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (crossSite(req, url)) return new Response('Changes can only be made from the dashboard.', { status: 403 });
    if (pathname === '/api/signin' && req.method === 'POST') return signIn(req, env);
    if (!await signedIn(req, env)) return json({ error: 'Enter your password.', signIn: true }, 401);
    return handleApi(req, env, ctx);
  },
};
