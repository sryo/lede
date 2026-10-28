// A picture of a page for its view, under the shade of how far down it is read. Cloudflare's Browser
// Rendering takes it, only when someone opens a page's view, never on a schedule. What it keeps in STORE:
//   shot:<day>:<site><path>   the day's jpeg of that page, with the browser time it took as metadata; empty
//                             when it couldn't be taken (and why), so it isn't tried again that day
//   og:<day>:<site><path>     the page's share picture (og:image), or empty, for when there is no jpeg
// Both expire after a day. The day's browser time is the sum over that day's shot keys, so a picture and
// what it cost are one write.
import { getSites, getAccountId } from './settings.js';
import { HttpError } from './errors.js';
import { DEMO_PICTURE } from './demo-picture.js';

// Half of the 10 minutes a day the free plan gives, so Lede never uses up an account's browser time.
export const BUDGET_MS = 5 * 60_000;
const KEEP_S = 86400;
// About 13,000 px of page at half size; anything bigger isn't worth a KV read on every open.
const MAX_BYTES = 2_000_000;

export const SHOT_URL = account => `https://api.cloudflare.com/client/v4/accounts/${account}/browser-rendering/screenshot`;

const dayOf = now => new Date(now).toISOString().slice(0, 10);
const reEscape = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// Cloudflare's browser can't open a page on the owner's own machine.
const reachable = site => site !== 'localhost' && !/^[\d.]+$/.test(site);

// The whole page at 1280 wide, drawn at half size as a jpeg. The tracker is never loaded from Lede's own
// address, so the picture isn't counted as a visit (src/bots.js drops it too, by Cloudflare's headers).
export const shotRequest = (site, path, origin) => ({
  url: `https://${site}${path}`,
  viewport: { width: 1280, height: 800, deviceScaleFactor: 0.5 },
  screenshotOptions: { fullPage: true, type: 'jpeg', quality: 50 },
  gotoOptions: { waitUntil: 'load', timeout: 20_000 },
  rejectRequestPattern: [`^${reEscape(origin)}/(t\\.js|lede|api/event)`],
});

async function spent(env, day) {
  let ms = 0, cursor;
  do {
    const page = await env.STORE.list({ prefix: `shot:${day}:`, cursor });
    for (const k of page.keys) ms += Number(k.metadata?.ms) || 0;
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return ms;
}

// One try at Cloudflare's screenshot. A token without the Browser Rendering permission gets 401 or 403.
async function take(env, site, path, origin, fetchImpl, clock) {
  const t0 = clock();
  try {
    if (!env.ANALYTICS_TOKEN) return { why: 'failed', ms: 0 };
    const res = await fetchImpl(SHOT_URL(await getAccountId(env, fetchImpl)), {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(shotRequest(site, path, origin)),
    });
    const used = Number(res.headers.get('X-Browser-Ms-Used')) || 0;
    if (res.status === 401 || res.status === 403) return { why: 'permission', ms: used };
    if (!res.ok || !(res.headers.get('Content-Type') || '').startsWith('image/')) {
      console.error(`Couldn’t take a picture of ${site}${path} (${res.status}): ${(await res.text()).slice(0, 300)}`);
      return { why: 'failed', ms: used };
    }
    const jpeg = await res.arrayBuffer();
    const ms = Math.round(used || clock() - t0);
    return jpeg.byteLength > MAX_BYTES ? { why: 'failed', ms } : { jpeg, ms };
  } catch (e) {
    console.error(`Couldn’t take a picture of ${site}${path}: ${e.message}`);
    return { why: 'failed', ms: 0 };
  }
}

// The page's og:image, read against the page's address; only a web address.
export function ogImage(html, base) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const at = {};
    for (const [, k, , a, b, c] of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) at[k.toLowerCase()] = a ?? b ?? c;
    if ((at.property || at.name || '').toLowerCase() !== 'og:image' || !at.content) continue;
    try {
      const u = new URL(at.content.replace(/&amp;/g, '&').trim(), base);
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
    } catch {}
  }
  return null;
}

async function shareImage(env, day, site, path, fetchImpl) {
  if (!reachable(site)) return null;
  const key = `og:${day}:${site}${path}`, kept = await env.STORE.get(key);
  if (kept != null) return kept || null;
  let og = null;
  try {
    const page = `https://${site}${path}`;
    const res = await fetchImpl(page, { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(5000) });
    if (res.ok) og = ogImage((await res.text()).slice(0, 300_000), res.url || page);
  } catch {}
  await env.STORE.put(key, og || '', { expirationTtl: KEEP_S });
  return og;
}

// { jpeg, at } when there is a picture of the page from today, else { og, why }: the share picture (or null),
// and why there's no picture: budget (the day's browser time is used up), permission (the token can't take
// pictures) or failed.
export async function pagePicture(env, { site, path, origin }, fetchImpl = fetch, now = Date.now(), clock = () => performance.now()) {
  const day = dayOf(now), key = `shot:${day}:${site}${path}`;
  const kept = await env.STORE.getWithMetadata(key, 'arrayBuffer');
  if (kept.value?.byteLength) return { jpeg: kept.value, at: kept.metadata?.at ?? now };
  let why = kept.metadata?.why;
  if (!why) {
    if (!reachable(site)) why = 'failed';
    else if (await spent(env, day) >= BUDGET_MS) why = 'budget';
    else {
      const got = await take(env, site, path, origin, fetchImpl, clock);
      await env.STORE.put(key, got.jpeg ?? new ArrayBuffer(0), { expirationTtl: KEEP_S, metadata: got.jpeg ? { ms: got.ms, at: now } : { ms: got.ms, why: got.why } });
      if (got.jpeg) return { jpeg: got.jpeg, at: now };
      why = got.why;
    }
  }
  return { og: await shareImage(env, day, site, path, fetchImpl), why };
}

// The demo can't call Cloudflare: /owls has a picture that comes with Lede, other pages have none.
const demoPicture = (path, now) => (path === '/owls' ? { jpeg: DEMO_PICTURE(), at: now } : { og: null, why: 'budget' });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// GET /api/shot?site=&path= → the jpeg (Last-Modified says when it was taken), or JSON { og, why }.
export async function handleShot(req, env, fetchImpl = fetch, now = Date.now()) {
  const url = new URL(req.url);
  try {
    const sites = await getSites(env);
    const site = (url.searchParams.get('site') || sites[0] || '').toLowerCase(), path = url.searchParams.get('path') || '';
    if (!sites.includes(site)) throw new HttpError(400, `Lede isn’t counting ${site}. Open the dashboard without ?site=.`);
    if (!path.startsWith('/') || path.length > 512) throw new HttpError(400, 'Say which page, with a path that starts with “/”.');
    const out = env.DEMO === 'true' ? demoPicture(path, now) : await pagePicture(env, { site, path, origin: url.origin }, fetchImpl, now);
    if (!out.jpeg) return json({ og: out.og, why: out.why });
    // Kept by the browser until the next picture can be taken, at midnight UTC.
    const left = Math.max(60, Math.ceil((86400e3 - now % 86400e3) / 1000));
    return new Response(out.jpeg, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': `private, max-age=${left}`, 'Last-Modified': new Date(out.at).toUTCString() } });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    return json({ error: e instanceof HttpError ? e.message : 'Couldn’t take a picture of the page. Try again in a minute.' }, e.status || 500);
  }
}
