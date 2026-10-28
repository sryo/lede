import { unwanted, isSpam } from './bots.js';
import { channelFor, referrerHost } from './channels.js';
import { deviceOf, browserOf } from './devices.js';
import { toDataPoint } from './schema.js';
import { keyword } from './shape.js';
import { getSites, getSalt } from './settings.js';

const TRACKING_PARAMS = /^(utm_\w+|gclid|gbraid|wbraid|msclkid|fbclid|ttclid|twclid|li_fat_id|dclid|mc_cid|mc_eid|_ga)$/;
const CORS = { 'Access-Control-Allow-Origin': '*' };
const MAX = 512;
const MAX_BODY = 8192; // a page URL, a referrer and a landing query

const stripWww = h => h.toLowerCase().replace(/^www\./, '');
const clip = s => s.slice(0, MAX);
const trimPath = p => p.length > 1 ? p.replace(/\/+$/, '') : '/';

export const TYPES = ['pageview', 'engagement', 'outbound', 'download', 'ping'];
// A focused tab left open on one page for hours isn't reading, so engaged time stops counting at 30 minutes.
const MAX_ENGAGED = 30 * 60e3;

// The type-specific part of an event, or null if it doesn't make sense. Engagement carries e (engaged ms)
// and s (scroll depth, %); outbound links and downloads carry o, the link's address without its query,
// of which only the host and path are kept. A ping only says the page is still showing.
function details(type, body, site) {
  if (type === 'pageview' || type === 'ping') return {};
  if (type === 'engagement') {
    const { e, s } = body;
    if (typeof e !== 'number' || typeof s !== 'number' || !Number.isFinite(e) || !Number.isFinite(s) || e < 1000) return null;
    return { engaged: Math.min(MAX_ENGAGED, Math.round(e)), scroll: Math.min(100, Math.max(0, Math.round(s))) };
  }
  if (typeof body.o !== 'string' || body.o.length > 2048) return null;
  let to;
  try { to = new URL(body.o); } catch { return null; }
  if (to.protocol !== 'https:' && to.protocol !== 'http:') return null;
  const host = stripWww(to.hostname);
  if (type === 'outbound' && host === site) return null;
  return { target: clip(host + trimPath(to.pathname)) };
}

// Turns the tracker's payload into the fields we store, or null if the event should be dropped.
// body: { t: type (pageview when left out), u: page URL, r: referrer of the page the visit landed on,
//         l: query string of that landing page, h: the hour the visit started, in ms (see visitHour),
//         and the type's own fields (see details) }
export function parseEvent(body, sites) {
  if (!body || typeof body.u !== 'string') return null;
  const type = body.t ?? 'pageview';
  if (!TYPES.includes(type)) return null;
  let page;
  try { page = new URL(body.u); } catch { return null; }
  if (page.protocol !== 'https:' && page.protocol !== 'http:') return null;
  const site = stripWww(page.hostname);
  if (!sites.includes(site)) return null;

  let referrer = '';
  if (typeof body.r === 'string' && body.r) {
    // An unparseable referrer counts as direct.
    const host = referrerHost(body.r);
    if (host !== site) referrer = host;
  }
  if (referrer && isSpam(referrer)) return null;
  const landing = new URLSearchParams(typeof body.l === 'string' ? body.l.slice(0, 2048) : '');

  const extra = details(type, body, site);
  if (!extra) return null;
  const path = trimPath(page.pathname);
  const kept = [...page.searchParams].filter(([k]) => !TRACKING_PARAMS.test(k));
  const query = kept.length ? '?' + new URLSearchParams(kept) : '';

  return {
    site,
    type,
    ...extra,
    path: clip(path),
    url: clip(path + query),
    referrer: clip(referrer),
    channel: channelFor(referrer, landing),
    utmSource: clip((landing.get('utm_source') || landing.get('ref') || '').toLowerCase()),
    utmMedium: clip((landing.get('utm_medium') || '').toLowerCase()),
    utmCampaign: clip(landing.get('utm_campaign') || ''),
    // The ad keyword, cleaned as search words are (see keyword), since it can carry what someone typed.
    utmTerm: keyword(landing.get('utm_term')),
  };
}

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).slice(0, 32);
}

// The tracker sends the hour its visit started, so a visit that runs past the hour isn't cut in two.
// Anything that isn't a whole hour from the last day (a wrong clock, a made-up value) is ignored.
export function visitHour(h, now) {
  const ago = now.getTime() - h;
  return Number.isInteger(h) && h % 3600e3 === 0 && ago >= 0 && ago < 86400e3 ? new Date(h) : now;
}

// salt is this month's (see getSalt), so the same person gets a new visitor ID each month and IDs
// can't be linked across months. Nothing that identifies a person is stored.
// A visit is a visitor's activity from the clock hour it started, for as long as pages keep coming
// less than 30 minutes apart (the tracker decides that); a new tab starts from the current hour.
export async function identify(salt, site, ip, ua, now, started = now) {
  const visitor = await sha256(`${salt}|${site}|${ip}|${ua}`);
  const visit = await sha256(`${visitor}|${started.toISOString().slice(0, 13)}`);
  return { visitor, visit };
}

// The free plan allows 100,000 Analytics Engine writes a day, so one script, or one page stuck in a loop,
// could use them all and leave the owner with no stats. A person sends far fewer: a view and an
// engagement event per page, a few link clicks and a ping every 3 minutes. Even someone flicking
// through a page every 5 seconds sends about 25 a minute, so 60 a minute per sender (an address on
// one site) is never reached by a reader, while a loop firing many a second is cut within the minute.
export const SENDER_LIMIT = 60;
export const SENDER_WINDOW = 60e3;

// Counts events per sender in fixed windows, in this Worker instance's memory (nothing is written).
// A sender whose window ended is re-added at the end, so the Map stays in order of window start and
// the oldest windows are dropped first once it holds `max` senders.
export function senderCap({ limit, window, max }) {
  const seen = new Map();
  const allow = (key, now) => {
    let w = seen.get(key);
    if (!w || now - w.start >= window) {
      seen.delete(key);
      w = { start: now, n: 0 };
      seen.set(key, w);
      for (const [k, old] of seen) {
        if (seen.size <= max && now - old.start < window) break;
        seen.delete(k);
      }
    }
    return ++w.n <= limit;
  };
  allow.size = () => seen.size;
  return allow;
}

// A 53-bit hash (cyrb53) for the sender's key. It's only held in memory for a minute and is salted, so it
// needs no SHA-256, which would double the hashing every beacon pays for.
function senderKey(text) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

const underCap = senderCap({ limit: SENDER_LIMIT, window: SENDER_WINDOW, max: 10_000 });

// Browsers say which page sent the beacon. One that says another site's page is a copy or a forgery.
function fromSite(origin, site) {
  if (origin == null) return true;
  try { return stripWww(new URL(origin).hostname) === site; } catch { return false; }
}

export async function collect(req, env) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }
  if (req.method !== 'POST') return new Response('Send events with POST.', { status: 405, headers: CORS });

  const ua = req.headers.get('User-Agent') || '';
  if (unwanted(req, env, ua)) return new Response(null, { status: 204, headers: CORS });

  let body;
  const text = await req.text();
  if (text.length > MAX_BODY) return new Response('The event is too large.', { status: 413, headers: CORS });
  try { body = JSON.parse(text); } catch { return new Response('The event isn’t valid JSON.', { status: 400, headers: CORS }); }
  const ev = parseEvent(body, await getSites(env));
  if (!ev || !fromSite(req.headers.get('Origin'), ev.site)) return new Response(null, { status: 204, headers: CORS });

  const now = new Date();
  const salt = await getSalt(env, now);
  const ip = req.headers.get('CF-Connecting-IP') || '';
  // The sender is a hash, so no address is kept in memory. BEACON_LIMIT is Cloudflare's rate limiter,
  // used when it's bound in wrangler.jsonc (see docs/how-it-works.md, Limits); it counts across this
  // location's Worker instances, which the in-memory cap can't.
  const sender = senderKey(`${salt}|${ip}|${ev.site}`);
  if (!underCap(sender, now.getTime()) || (env.BEACON_LIMIT && !(await env.BEACON_LIMIT.limit({ key: sender })).success)) {
    return new Response(null, { status: 204, headers: CORS });
  }
  const ids = await identify(salt, ev.site, ip, ua, now, visitHour(body.h, now));
  env.EVENTS.writeDataPoint(toDataPoint({
    ...ev, ...ids, country: req.cf?.country || '', device: deviceOf(ua, req.headers.get('Sec-CH-UA-Mobile')), browser: browserOf(ua),
  }));
  return new Response(null, { status: 204, headers: CORS });
}
