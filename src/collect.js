import { unwanted, isSpam } from './bots.js';
import { channelFor, referrerHost } from './channels.js';
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

// Browsers say which page sent the beacon. One that says another site's page is a copy or a forgery.
function fromSite(origin, site) {
  if (origin == null) return true;
  try { return stripWww(new URL(origin).hostname) === site; } catch { return false; }
}

export async function collect(req, env) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }
  if (req.method !== 'POST') return new Response('Use POST', { status: 405, headers: CORS });

  const ua = req.headers.get('User-Agent') || '';
  if (unwanted(req, env, ua)) return new Response(null, { status: 204, headers: CORS });

  let body;
  const text = await req.text();
  if (text.length > MAX_BODY) return new Response('Too large', { status: 413, headers: CORS });
  try { body = JSON.parse(text); } catch { return new Response('Invalid JSON', { status: 400, headers: CORS }); }
  const ev = parseEvent(body, await getSites(env));
  if (!ev || !fromSite(req.headers.get('Origin'), ev.site)) return new Response(null, { status: 204, headers: CORS });

  const now = new Date();
  const ids = await identify(await getSalt(env, now), ev.site, req.headers.get('CF-Connecting-IP') || '', ua, now, visitHour(body.h, now));
  env.EVENTS.writeDataPoint(toDataPoint({ ...ev, ...ids, country: req.cf?.country || '' }));
  return new Response(null, { status: 204, headers: CORS });
}
