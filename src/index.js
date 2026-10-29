import { collect } from './collect.js';
import { handleApi } from './api.js';
import { handleShot } from './shot.js';
import { runAlerts } from './alerts.js';
import { rememberOrigin, sharedSite } from './settings.js';

// The Durable Object behind "here now" as it happens (see src/live.js).
export { Live } from './live.js';

async function sameSecret(a, b) {
  const enc = s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [x, y] = await Promise.all([enc(a), enc(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}

const COOKIE = 'lede';
const YEAR = 365 * 24 * 3600;
const json = (body, status, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const sha = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
  .map(b => b.toString(16).padStart(2, '0')).join('');

// The cookie holds a hash of the password, so changing DASHBOARD_PASSWORD signs everyone out.
const pass = password => sha(`lede|${password}`);

// A password left empty (or only spaces) when deploying means none, as if it weren't set.
const secretOf = env => (env.DASHBOARD_PASSWORD?.trim() ? env.DASHBOARD_PASSWORD : '');

// Only the stats need the password, and only when DASHBOARD_PASSWORD is set. The dashboard page
// itself is public code; without the cookie it shows its own password card.
const cookieValue = (req, name) => (req.headers.get('Cookie') || '').split(/;\s*/).find(c => c.startsWith(`${name}=`))?.slice(name.length + 1);

async function signedIn(req, env) {
  const secret = secretOf(env);
  if (!secret) return true;
  const cookie = cookieValue(req, COOKIE);
  return cookie != null && sameSecret(cookie, await pass(secret));
}

// A read-only link, /s/<token>, leaves its token in a cookie and opens the dashboard on its site.
const SHARE = 'lede_share';
async function openShare(env, token) {
  const site = await sharedSite(env, token);
  if (!site) return new Response('This link doesn’t work any more. Ask whoever shared it for a new one.', { status: 404 });
  return new Response(null, { status: 302, headers: {
    Location: `/?site=${encodeURIComponent(site)}`,
    'Set-Cookie': `${SHARE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${YEAR}`,
  } });
}

// With a link's cookie, only reading that one site gets through. The site is checked here, before
// handleApi, so its edge cache and recent answers are never reached for another site. A request
// without a site gets the link's own written in, so it can't land on the owner's cached answer for the first site.
async function asShared(req, env, ctx, url) {
  const site = await sharedSite(env, cookieValue(req, SHARE));
  if (!site) return json({ error: 'Enter your password.', signIn: true }, 401);
  // An empty ?site= means the first site, as in parseQuery.
  const asked = url.searchParams.get('site');
  if (req.method !== 'GET' || url.pathname === '/api/shares' || (asked && asked.toLowerCase() !== site)) {
    return json({ error: 'This link can only show stats.' }, 403);
  }
  if (!asked) {
    url.searchParams.set('site', site);
    req = new Request(url, req);
  }
  return url.pathname === '/api/shot' ? handleShot(req, env) : handleApi(req, env, ctx, site);
}

// Wrong passwords: TRIES per WINDOW from one address in each isolate, then 429 until the window ends.
// The address is kept only as a hash, and only while it has tries counted. SIGNIN_LIMIT is Cloudflare's
// rate limiter, used when it's bound in wrangler.jsonc; it counts across a location's Worker instances.
const TRIES = 10;
const WINDOW = 10 * 60_000;
const MAX_ADDRESSES = 10_000;
const misses = new Map();

function waitFor(who, now) {
  const m = misses.get(who);
  if (m && now - m.start >= WINDOW) misses.delete(who);
  return m && m.n >= TRIES && now - m.start < WINDOW ? Math.ceil((m.start + WINDOW - now) / 1000) : 0;
}

function missed(who, now) {
  const m = misses.get(who);
  if (m) { m.n++; return; }
  if (misses.size >= MAX_ADDRESSES) misses.delete(misses.keys().next().value);
  misses.set(who, { start: now, n: 1 });
}

const tooMany = seconds => {
  const minutes = Math.ceil(seconds / 60);
  return json({ error: `Too many wrong passwords. Try again in ${minutes} minute${minutes > 1 ? 's' : ''}.` }, 429, { 'Retry-After': String(seconds) });
};

async function signIn(req, env) {
  const secret = secretOf(env);
  if (!secret) return new Response(null, { status: 204 });
  const who = await sha(`signin|${req.headers.get('CF-Connecting-IP') || ''}`), now = Date.now();
  const wait = waitFor(who, now);
  if (wait) return tooMany(wait);
  if (env.SIGNIN_LIMIT && !(await env.SIGNIN_LIMIT.limit({ key: who })).success) return tooMany(60);
  const { password = '' } = await req.json().catch(() => ({}));
  if (!await sameSecret(String(password), secret)) {
    missed(who, now);
    return json({ error: 'That’s not the password. Try again.' }, 401);
  }
  misses.delete(who);
  return new Response(null, { status: 204, headers: { 'Set-Cookie': `${COOKIE}=${await pass(secret)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${YEAR}` } });
}

// Signing out works whether or not the cookie is still good, so it's never refused.
const signOut = () => new Response(null, { status: 204, headers: { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` } });

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
    // /api/event still works, for trackers that browsers cached with that path.
    if (pathname === '/lede' || pathname === '/api/event') return collect(req, env, ctx);
    if (pathname.startsWith('/s/') && req.method === 'GET') return openShare(env, pathname.slice(3));
    // Everything else but /api/* is served straight from the assets (see wrangler.jsonc); this is for local dev.
    if (!pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (crossSite(req, url)) return json({ error: 'Changes can only be made from the dashboard.' }, 403);
    const res = pathname === '/api/signin' && req.method === 'POST' ? await signIn(req, env)
      : pathname === '/api/signout' && req.method === 'POST' ? signOut()
        // The password wins over a link's cookie, so the owner opening their own link still sees everything.
        : !await signedIn(req, env) ? await asShared(req, env, ctx, url)
          : pathname === '/api/shot' ? await handleShot(req, env)
            : await handleApi(req, env, ctx);
    // Alerts link to the dashboard, but a schedule doesn't know the Worker's address. The dashboard asks for
    // the sites when it opens, and signs in from the same address.
    if (res.ok && (pathname === '/api/signin' || pathname === '/api/sites')) ctx.waitUntil(rememberOrigin(env, url.origin));
    return res;
  },
  // The weekly story and spike alerts (src/alerts.js), on the crons in wrangler.jsonc.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlerts(event.cron, env, event.scheduledTime));
  },
};
