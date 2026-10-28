import { unwanted, isSpam } from './bots.js';
import { channelFor, referrerHost, sourceTag } from './channels.js';
import { deviceOf, browserOf } from './devices.js';
import { toDataPoint } from './schema.js';
import { keyword, searchWord } from './shape.js';
import { getSites, getSalt } from './settings.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const MAX = 512;
const MAX_BODY = 8192; // a page URL, a referrer and a landing query

const stripWww = h => h.toLowerCase().replace(/^www\./, '');
const clip = s => s.slice(0, MAX);
const trimPath = p => p.length > 1 ? p.replace(/\/+$/, '') : '/';

export const TYPES = ['pageview', 'engagement', 'outbound', 'download', 'ping'];
// A focused tab left open on one page for hours isn't reading, so engaged time stops counting at 30 minutes.
const MAX_ENGAGED = 30 * 60e3;
// A Web Vital out of these bounds is a broken measurement, kept as unknown (0).
const vital = (v, max) => typeof v === 'number' && v >= 0 && v <= max ? Math.round(v) : 0;

// Parts of a link's path that can name a person or unlock something: an email address, 7 or more digits
// that aren't a date (20261005), a UUID, 16 or more hex characters, or a long token mixing upper and
// lower case with digits. Each is kept as *, with the file's extension, so downloads of one kind of file
// stay together.
const DATE = /^(19|20)\d\d(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;
function secret(s) {
  return /[^@]@[^@]+\./.test(s) || /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i.test(s) || /[\da-f]{16}/i.test(s)
    || (s.match(/\d{7,}/g) || []).some(d => !DATE.test(d))
    || (s.match(/[A-Za-z\d]{20,}/g) || []).some(t => /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t));
}
export function scrubPath(path) {
  return path.split('/').map(part => {
    let text = part;
    try { text = decodeURIComponent(part); } catch {}
    if (!secret(text)) return part;
    const ext = text.match(/\.[a-z\d]{1,5}$/i)?.[0];
    return ext && secret(text.slice(0, -ext.length)) ? '*' + ext : '*';
  }).join('/');
}

// The type-specific part of an event, or null if it doesn't make sense. Engagement carries e (engaged ms)
// and s (scroll depth, %), and the page view's Web Vitals when the browser measured them: lcp and inp in
// ms, cls times 1000. Outbound links and downloads carry o, the link's address without its query, of
// which only the host and path are kept (see scrubPath). A ping only says the page is still showing.
function details(type, body, site) {
  if (type === 'pageview' || type === 'ping') return {};
  if (type === 'engagement') {
    const { e, s } = body;
    if (typeof e !== 'number' || typeof s !== 'number' || !Number.isFinite(e) || !Number.isFinite(s) || e < 1000) return null;
    return {
      engaged: Math.min(MAX_ENGAGED, Math.round(e)), scroll: Math.min(100, Math.max(0, Math.round(s))),
      lcp: vital(body.lcp, 60e3), inp: vital(body.inp, 60e3), cls: vital(body.cls, 10e3),
    };
  }
  if (typeof body.o !== 'string' || body.o.length > 2048) return null;
  let to;
  try { to = new URL(body.o); } catch { return null; }
  if (to.protocol !== 'https:' && to.protocol !== 'http:') return null;
  const host = stripWww(to.hostname);
  if (type === 'outbound' && host === site) return null;
  return { target: clip(host + scrubPath(trimPath(to.pathname))) };
}

// Turns the tracker's payload into the fields we store, or null if the event should be dropped.
// body: { t: type (pageview when left out), u: page URL, r: referrer of the page the visit landed on,
//         l: the tags in that landing page's query, h: when the visit started, in ms (see visitHour),
//         k: a page view's place in its visit, 3 for any after the second, and the type's own fields (see details) }
export function parseEvent(body, sites) {
  if (!body || typeof body.u !== 'string') return null;
  const type = body.t ?? 'pageview';
  if (!TYPES.includes(type)) return null;
  let page;
  try { page = new URL(body.u); } catch { return null; }
  if (page.protocol !== 'https:' && page.protocol !== 'http:') return null;
  const site = stripWww(page.hostname);
  if (!sites.includes(site)) return null;

  const landing = new URLSearchParams(typeof body.l === 'string' ? body.l.slice(0, 2048) : '');
  // An unparseable referrer counts as direct. Without one, the landing page's source tag names where
  // the visit came from, as apps, newsletters and links in PDFs send no referrer.
  let referrer = typeof body.r === 'string' && body.r ? referrerHost(body.r) : '';
  if (!referrer) referrer = sourceTag(landing);
  if (referrer === site) referrer = '';
  if (referrer && isSpam(referrer)) return null;

  const extra = details(type, body, site);
  if (!extra) return null;
  const path = trimPath(page.pathname);
  // Of the page's query only what was searched for is kept, cleaned as search words are, since the rest
  // can hold a reset token, an email address or a session ID.
  const word = searchWord(page.search);

  return {
    site,
    type,
    ...extra,
    path: clip(path),
    url: clip(path + (word ? '?' + new URLSearchParams({ q: word }) : '')),
    step: type === 'pageview' && [1, 2, 3].includes(body.k) ? body.k : 0,
    referrer: clip(referrer),
    channel: channelFor(referrer, landing),
    utmSource: clip((landing.get('utm_source') || landing.get('source') || landing.get('ref') || '').toLowerCase()),
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

const HOUR = 3600e3;
const hourOf = date => new Date(Math.floor(date.getTime() / HOUR) * HOUR);

// The tracker sends when its visit started, so a visit that runs past the hour isn't cut in two: the
// hour for a tab's first visit, the minute for a later one (see identify). A clock a few minutes fast
// sends a start that hasn't come yet here; it's kept, or the visit's first beacons would join the one
// before while the rest, arriving after it, make another. Anything that isn't a whole minute from the
// last day (a wrong clock, a made-up value) is ignored, and the visit starts this hour.
const SKEW = 5 * 60e3;
export function visitHour(h, now) {
  const ago = now.getTime() - h;
  return Number.isInteger(h) && h % 60e3 === 0 && ago >= -SKEW && ago < 86400e3 ? new Date(h) : hourOf(now);
}

// salt is the month's the visit started in (see getSalt), so the same person gets a new visitor ID each
// month and IDs can't be linked across months. Nothing that identifies a person is stored.
// A visit is a visitor's activity from the clock hour it started, for as long as pages keep coming
// less than 30 minutes apart (the tracker decides that); a new tab starts from the current hour, so
// its pages join a visit already open in another tab. A tab that starts another visit later in the
// same hour sends that minute, so the two stay two visits.
export async function identify(salt, site, ip, ua, now, started = hourOf(now)) {
  const visitor = await sha256(`${salt}|${site}|${ip}|${ua}`);
  const visit = await sha256(`${visitor}|${started.toISOString().slice(0, started.getTime() % HOUR ? 16 : 13)}`);
  return { visitor, visit };
}

// A visit that started last month keeps last month's salt until it ends, so it isn't cut in two at
// midnight on the 1st. That salt is only read, never made: KV keeps it for a day after its month, and
// once it's gone (or there never was one) the visit carries on with this month's. Salts never change,
// so each isolate reads each one once.
const pastSalts = new WeakMap();
export function visitSalt(env, started, now, current) {
  const month = started.toISOString().slice(0, 7);
  if (month >= now.toISOString().slice(0, 7)) return current;
  const byMonth = pastSalts.get(env.STORE) || new Map();
  pastSalts.set(env.STORE, byMonth);
  if (!byMonth.has(month)) byMonth.set(month, env.STORE.get(`salt:${month}`).catch(() => null));
  return byMonth.get(month).then(salt => salt || current);
}

// The free plan allows 100,000 Analytics Engine writes a day, so one script, or one page stuck in a loop,
// could use them all and leave the owner with no stats. A person sends far fewer: a view and an
// engagement event per page, a few link clicks and a ping every 3 minutes. Even someone flicking
// through a page every 5 seconds sends about 25 a minute, so 60 a minute per sender (a browser, by its
// address and user agent, on one site) is never reached by a reader, while a loop firing many a second
// is cut within the minute. An office or a phone network puts many readers behind one address, so the
// address alone gets a looser cap, which still stops a script that changes its user agent each time.
export const SENDER_LIMIT = 60;
export const ADDRESS_LIMIT = 400;
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
const underAddressCap = senderCap({ limit: ADDRESS_LIMIT, window: SENDER_WINDOW, max: 10_000 });

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
  const sender = senderKey(`${salt}|${ip}|${ua}|${ev.site}`);
  if (!underCap(sender, now.getTime()) || !underAddressCap(senderKey(`${salt}|${ip}`), now.getTime())
    || (env.BEACON_LIMIT && !(await env.BEACON_LIMIT.limit({ key: sender })).success)) {
    return new Response(null, { status: 204, headers: CORS });
  }
  const started = visitHour(body.h, now);
  const ids = await identify(await visitSalt(env, started, now, salt), ev.site, ip, ua, now, started);
  env.EVENTS.writeDataPoint(toDataPoint({
    ...ev, ...ids, country: req.cf?.country || '', device: deviceOf(ua, req.headers.get('Sec-CH-UA-Mobile')), browser: browserOf(ua),
  }));
  return new Response(null, { status: 204, headers: CORS });
}
