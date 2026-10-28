// A picture of a page for its view, under the shade of how far down it is read. Cloudflare's Browser
// Rendering takes it, only when someone opens a page's view, never on a schedule. What it keeps in STORE:
//   shot:<day>:<site><path>   the day's jpeg of that page, with the browser time it took as metadata; empty
//                             when it couldn't be taken (and why), so it isn't tried again that day, or for
//                             a minute when Cloudflare was only busy
//   shot:<day>:               once Cloudflare says the account's browser time is used up: the whole budget
//   og:<day>:<site><path>     the page's share picture (og:image), or empty, for when there is no jpeg
// Both expire after a day. The day's browser time is the sum over that day's shot keys, so a picture and
// what it cost are one write.
import { getSites, getAccountId } from './settings.js';
import { HttpError } from './errors.js';
import { DEMO_PICTURE } from './demo-picture.js';

// Half of the 10 minutes a day the free plan gives, so Lede never uses up an account's browser time.
export const BUDGET_MS = 5 * 60_000;
const KEEP_S = 86400;
// KV's shortest expiry. A busy browser is asked again after it, not tomorrow.
const BUSY_S = 60;
// About 13,000 px of page at half size; anything bigger isn't worth a KV read on every open.
const MAX_BYTES = 2_000_000;
// The share picture is in the page's <head>; the rest of a long page isn't read.
const MAX_HTML = 300_000;

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

// Once the day's browser time is used up, each isolate stops listing KV for it until the next day.
const usedUp = new WeakMap();
// Cloudflare also answers 429 once the account's own browser time for the day is gone. Two 429s a minute or
// more apart, with no picture between them, aren't only too many at once, so the day's time counts as spent.
const first429 = new WeakMap();
function spent(store, day, now) {
  const was = first429.get(store);
  if (was?.day === day) return now - was.at >= BUSY_S * 1000;
  first429.set(store, { day, at: now });
  return false;
}

async function overBudget(env, day) {
  if (usedUp.get(env.STORE) === day) return true;
  let ms = 0, cursor;
  do {
    const page = await env.STORE.list({ prefix: `shot:${day}:`, cursor });
    for (const k of page.keys) ms += Number(k.metadata?.ms) || 0;
    cursor = page.list_complete || ms >= BUDGET_MS ? null : page.cursor;
  } while (cursor);
  if (ms >= BUDGET_MS) usedUp.set(env.STORE, day);
  return ms >= BUDGET_MS;
}

// The body's first max bytes; the rest is never downloaded.
async function firstBytes(res, max) {
  const reader = res.body?.getReader(), parts = [];
  let n = 0;
  while (reader && n < max) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.byteLength;
  }
  reader?.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(n, max));
  let at = 0;
  for (const p of parts) {
    if (at >= out.length) break;
    const part = p.subarray(0, out.length - at);
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// One try at Cloudflare's screenshot. A token without the Browser Rendering permission gets 401 or 403;
// a 429, a 5xx or no answer at all means the browser is busy, and the next open a minute later tries again.
// An answer that spent browser time (a page too slow to load, say) isn't asked again until tomorrow, so
// that time stays in the day's budget.
async function take(env, site, path, origin, fetchImpl, clock) {
  if (!env.ANALYTICS_TOKEN) return { why: 'failed', ms: 0 };
  let account;
  try {
    account = await getAccountId(env, fetchImpl);
  } catch (e) {
    // A token that reaches no account, or more than one, stays that way until the owner changes it.
    const later = !(e instanceof HttpError);
    console.error(`Couldn’t take a picture of ${site}${path} (${e.message}).${later ? ' Lede tries again in a minute.' : ''}`);
    return { why: later ? 'busy' : 'failed', ms: 0 };
  }
  const t0 = clock();
  try {
    const res = await fetchImpl(SHOT_URL(account), {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(shotRequest(site, path, origin)),
    });
    const used = Number(res.headers.get('X-Browser-Ms-Used')) || 0;
    if (res.status === 401 || res.status === 403) return { why: 'permission', ms: used };
    if (!res.ok || !(res.headers.get('Content-Type') || '').startsWith('image/')) {
      const busy = (res.status === 429 || res.status >= 500) && !used;
      console.error(`Couldn’t take a picture of ${site}${path} (${res.status}${busy ? ', Cloudflare’s browser is busy; Lede tries again in a minute' : ''}): `
        + new TextDecoder().decode(await firstBytes(res, 300)));
      return { why: busy ? 'busy' : 'failed', ms: used, status: res.status };
    }
    const jpeg = await firstBytes(res, MAX_BYTES + 1);
    const ms = Math.round(used || clock() - t0);
    return jpeg.byteLength > MAX_BYTES ? { why: 'failed', ms } : { jpeg: jpeg.buffer, ms };
  } catch (e) {
    console.error(`Couldn’t take a picture of ${site}${path} (${e.message}). Lede tries again in a minute.`);
    return { why: 'busy', ms: 0 };
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
    if (res.ok && /^\s*(text\/html|application\/xhtml\+xml)/i.test(res.headers.get('Content-Type') || '')) {
      og = ogImage(new TextDecoder().decode(await firstBytes(res, MAX_HTML)), res.url || page);
    } else res.body?.cancel().catch(() => {});
  } catch {}
  await env.STORE.put(key, og || '', { expirationTtl: KEEP_S });
  return og;
}

// { jpeg, at } when there is a picture of the page from today, else { og, why }: the share picture (or null),
// and why there's no picture: budget (the day's browser time is used up), permission (the token can't take
// pictures), busy (Cloudflare's browser didn't answer; try again in a minute) or failed.
export async function pagePicture(env, { site, path, origin }, fetchImpl = fetch, now = Date.now(), clock = () => performance.now()) {
  const day = dayOf(now), key = `shot:${day}:${site}${path}`;
  const kept = await env.STORE.getWithMetadata(key, 'arrayBuffer');
  if (kept.value?.byteLength) return { jpeg: kept.value, at: kept.metadata?.at ?? now };
  let why = kept.metadata?.why;
  if (!why) {
    if (!reachable(site)) why = 'failed';
    else if (await overBudget(env, day)) why = 'budget';
    else {
      const got = await take(env, site, path, origin, fetchImpl, clock);
      if (got.jpeg) {
        first429.delete(env.STORE);
        await env.STORE.put(key, got.jpeg, { expirationTtl: KEEP_S, metadata: { ms: got.ms, at: now } });
        return { jpeg: got.jpeg, at: now };
      }
      if (got.status === 429 && spent(env.STORE, day, now)) {
        console.error('Cloudflare says this account’s browser time for today is used up, so Lede takes no more pictures until tomorrow (UTC).');
        await env.STORE.put(`shot:${day}:`, new ArrayBuffer(0), { expirationTtl: KEEP_S, metadata: { ms: BUDGET_MS, why: 'budget' } });
        usedUp.set(env.STORE, day);
        return { og: await shareImage(env, day, site, path, fetchImpl), why: 'budget' };
      }
      // Another open may have kept a picture while this one waited; a failure never takes its place.
      const since = await env.STORE.getWithMetadata(key, 'arrayBuffer');
      if (since.value?.byteLength) return { jpeg: since.value, at: since.metadata?.at ?? now };
      await env.STORE.put(key, new ArrayBuffer(0), { expirationTtl: got.why === 'busy' ? BUSY_S : KEEP_S, metadata: { ms: got.ms, why: got.why } });
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
