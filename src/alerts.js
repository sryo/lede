// Messages sent to a webhook on a schedule, so the owner hears what changed without opening the dashboard:
// the week's story every Monday, and a line when far more people than usual are here at once.
// Nothing is read or sent until ALERT_WEBHOOK is set.
import { sqlStore, withChannels, runSql } from './api.js';
import { demoAlertStore } from './demo.js';
import { getSites } from './settings.js';
import { DAY, hexOf } from './queries.js';
import { COL } from './schema.js';
import { channelFor } from './channels.js';
import { readStory, tellStory, pagesFinding, labelOf, fmtInt, fmtDay, dayDate, pageName, sum } from '../public/story.js';
import { viewToUrl } from '../public/routes.js';
import { displayHost } from '../public/hosts.js';

// The schedules in wrangler.jsonc. Any other schedule runs the weekly story.
export const WEEKLY = '0 8 * * 1';
export const SPIKES = '*/15 * * * *';

/* ---------- delivery ---------- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"' };
// The home sentence is HTML with links on its names; a message keeps the words. Paths carry
// non-breaking hyphens and <wbr> so they wrap well on screen.
export const plain = html => html.replace(/<[^>]+>/g, '').replace(/‑/g, '-').replace(/&(amp|lt|gt|quot);/g, (_, e) => ENTITIES[e]);

const DISCORD = /(^|\.)discord(app)?\.com$/;

// Slack and Discord want JSON; ntfy and most other webhooks take the text as it is.
export function webhookRequest(url, text) {
  const host = new URL(url).hostname;
  const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (host === 'hooks.slack.com') return json({ text: text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) });
  if (DISCORD.test(host)) return json({ content: text.slice(0, 2000), allowed_mentions: { parse: [] } });
  return { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text };
}

// How much one message may hold: Discord takes 2,000 characters, Slack 40,000, and ntfy 4,096 bytes
// (past that it sends the text as a file), which other webhooks get too.
const utf8 = new TextEncoder();
export function fitsIn(url) {
  const host = new URL(url).hostname;
  if (host === 'hooks.slack.com') return s => s.length <= 40_000;
  if (DISCORD.test(host)) return s => s.length <= 2000;
  return s => utf8.encode(s).length <= 4096;
}

// The text as a few messages that each fit, cut between sites if it can, else between lines, else anywhere.
export function splitText(text, fits) {
  const parts = [];
  const chars = s => {
    let cur = '';
    for (const c of s) {
      if (cur && !fits(cur + c)) { parts.push(cur); cur = ''; }
      cur += c;
    }
    if (cur) parts.push(cur);
  };
  const pack = (pieces, sep, tooBig) => {
    let cur = null;
    for (const piece of pieces) {
      if (cur != null && fits(cur + sep + piece)) { cur += sep + piece; continue; }
      if (cur != null) parts.push(cur);
      cur = null;
      if (fits(piece)) cur = piece;
      else tooBig(piece);
    }
    if (cur != null) parts.push(cur);
  };
  pack(text.split('\n\n'), '\n\n', block => pack(block.split('\n'), '\n', chars));
  return parts;
}

// True once the whole message is out. A webhook that fails is logged and the rest isn't sent. In the demo
// without a webhook, the message goes to the console instead.
async function send(env, text, fetchImpl) {
  if (!env.ALERT_WEBHOOK) { console.log(`Lede alert:\n${text}`); return true; }
  for (const part of splitText(text, fitsIn(env.ALERT_WEBHOOK))) {
    try {
      const res = await fetchImpl(env.ALERT_WEBHOOK, webhookRequest(env.ALERT_WEBHOOK, part));
      if (res.ok) continue;
      console.error(`The alert webhook answered ${res.status}, so the message wasn’t sent. Check ALERT_WEBHOOK.`);
    } catch (e) {
      console.error(`Couldn’t reach the alert webhook (${e.message}), so the message wasn’t sent. Check ALERT_WEBHOOK.`);
    }
    return false;
  }
  return true;
}

async function dashboard(env) {
  return (env.DASHBOARD_URL || await env.STORE.get('origin') || '').replace(/\/+$/, '');
}

/* ---------- the weekly story ---------- */

// Monday to Sunday in UTC, the week before the day it runs, against the week before that.
export function weekQuery(site, nowMs) {
  const end = Math.floor(nowMs / 1000 / DAY) * DAY;
  const bounds = Array.from({ length: 15 }, (_, k) => end - (14 - k) * DAY);
  return { site, days: 7, tz: 0, filters: {}, start: bounds[7], end, prevStart: bounds[0], prevEnd: bounds[7], bounds };
}

const people = (n, one) => `${fmtInt(n)} ${Math.round(n) === 1 ? one : `${one}s`}`;

// What backs the sentence up: the total, the top source, and the page that moved most (or was read most).
function supporting(S, pageRows, toldPage) {
  const { c, p, diff } = S, u = S.unit || 'visitors', one = u.slice(0, -1), lines = [];
  const pct = p[u] >= 30 ? ` (${diff > 0 ? '+' : '−'}${Math.round(Math.abs(diff) / p[u] * 100)}%)` : '';
  // A flat week's sentence already says it was about the same, and a week with no one already says how many
  // came before, so the total stands alone or not at all. diff is in S.unit: visits when only one of the
  // two weeks crosses a month start.
  if (c.visitors) lines.push(!p.visitors || S.flat ? `${people(c[u], one)}.`
    : `${people(c[u], one)}, ${fmtInt(Math.abs(diff))} ${diff > 0 ? 'more' : 'fewer'} than the week before${pct}.`);
  const top = S.sources.filter(s => s.value > 0).sort((a, b) => b.value - a.value)[0];
  if (top) lines.push(top.key ? `${top.label} sent the most visitors: ${fmtInt(top.value)}.` : `More visitors came direct than from any source: ${fmtInt(top.value)}.`);
  const moved = pagesFinding(pageRows, toldPage);
  const read = pageRows.filter(r => r.value > 0).sort((a, b) => b.value - a.value)[0];
  if (moved) lines.push(`${plain(moved.html)}.`);
  else if (read) lines.push(`Most visited page: ${pageName(read.key)}, with ${people(read.value, 'visitor')}.`);
  return lines;
}

async function weekText(store, site, nowMs, link) {
  const q = weekQuery(site, nowMs);
  // Every query settles before the next site starts, so none of this site's is still asking then.
  const got = await Promise.allSettled([store.summary(q), store.series(q), store.breakdown(q, 'path'),
    store.breakdown(q, 'referrer').then(withChannels), store.flows(q)]);
  const failed = got.find(g => g.status === 'rejected');
  if (failed) throw failed.reason;
  const [totals, ser, pages, refs, flows] = got.map(g => g.value);
  const S = readStory({ totals, ser, pages, refs, flows }), T = tellStory(S, ser, q.days, { now: 'this week', before: 'the week before' });
  const pageRows = pages.rows.map(r => ({ key: r.key, value: r.visitors, prev: r.prev?.visitors }));
  return [`${displayHost(site)}, the week of ${fmtDay(dayDate(q.start, 0))}`, plain(T.html),
    ...(S.c.visitors || S.p.visitors ? supporting(S, pageRows, T.page) : []), ...(link ? [link] : [])].join('\n');
}

// A schedule on the Free plan may make 50 subrequests, KV reads among them: here the sites, the dashboard's
// address and the account. A site's week takes 6 to 9 queries (one more for each of its three lists when a
// period needs a query of its own) and a query Cloudflare refuses at first is asked again, so sites are told
// one at a time while the fewest could fit, and none may take the requests the message needs. A site that
// runs out is named with those that didn't fit.
export const SUBREQUESTS = 50 - 3;
const PER_SITE = 6;

const names = list => list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;

const tooMany = left => `Too many sites for one message, so ${names(left.map(displayHost))} ${left.length > 1 ? 'aren’t' : 'isn’t'} in it. Their week is on the dashboard.`;

async function weekly(env, store, nowMs, fetchImpl, budget) {
  const sites = await getSites(env), origin = await dashboard(env);
  const link = site => origin && origin + viewToUrl(null, { days: 7, site: sites.length > 1 ? site : null });
  const told = [], left = [];
  const text = () => [...told.map(t => t.text), ...(left.length ? [tooMany(left)] : [])].join('\n\n');
  const parts = () => (env.ALERT_WEBHOOK ? splitText(text(), fitsIn(env.ALERT_WEBHOOK)).length : 0);
  for (const site of sites) {
    // Room for this site's block and the line naming the rest, each perhaps a part of its own.
    const room = SUBREQUESTS - parts() - 2;
    if (left.length || budget.used() + PER_SITE > room) { left.push(site); continue; }
    budget.cap(room);
    try {
      told.push({ site, text: await weekText(store, site, nowMs, link(site)) });
    } catch (e) {
      if (budget.used() >= room) left.push(site);
      else console.error(`Couldn’t write the week’s story for ${site} (${e.message}). It tries again next Monday.`);
    }
  }
  budget.cap(SUBREQUESTS);
  // A block longer than one part could still leave the message too many; the last sites told make room.
  while (told.length && budget.used() + parts() > SUBREQUESTS) left.unshift(told.pop().site);
  if (told.length || left.length) await send(env, text(), fetchImpl);
}

/* ---------- spikes ---------- */

// "Here now" must reach both MIN_PEOPLE and twice the usual (or the usual plus MIN_PEOPLE, for quiet hours).
const MIN_PEOPLE = 10;
const USUAL_DAYS = 14;
// The usual is an average over the days the site already had data; with fewer than this there is none yet.
const MIN_DAYS = 3;
// At most PER_DAY messages a site a day (UTC), APART seconds apart, so one long spike is told once.
const PER_DAY = 2;
const APART = 3 * 3600;
// The live query returns at most this many people.
const LIVE_MAX = 200;

const most = (list, key) => {
  const n = new Map();
  for (const v of list) n.set(key(v), (n.get(key(v)) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0];
};

// The page most of the crowd is on (when at least half are), and the source most of those came from.
function crowdOf(here) {
  const [page, onPage] = most(here, v => v.path);
  const focus = onPage * 2 >= here.length, crowd = focus ? here.filter(v => v.path === page) : here;
  const [src, fromSrc] = most(crowd, v => v.referrer);
  return { page, onPage, focus, crowd, src, fromSrc };
}

// named: false keeps the source's host out of the message (see known below).
export function spikeText(here, full, usual, site, named = true) {
  const { page, onPage, focus, crowd, src, fromSrc } = crowdOf(here);
  const n = `${full ? 'At least ' : ''}${fmtInt(here.length)}`;
  const all = onPage === here.length, where = all ? `${n} people are on ${pageName(page)} of ${displayHost(site)} right now`
    : `${n} people are on ${displayHost(site)} right now${focus ? `, ${fmtInt(onPage)} of them on ${pageName(page)}` : ''}`;
  // After "12 of them on /x", "most of those" says the count is of the people on that page.
  const mostOf = focus && !all ? 'most of those' : 'most';
  const name = named ? labelOf('referrer', src) : 'a site that sent nobody in the 2 weeks before';
  const from = fromSrc * 2 > crowd.length
    ? (src ? `${mostOf} from ${name}` : `${focus && !all ? 'most of those' : 'most of them'} direct visitors`)
    : (src ? `more from ${name} than from anywhere else` : 'more direct visitors than from any one source');
  const r = Math.round(usual);
  return `${where}, ${from}. Usually ${r ? `about ${fmtInt(r)}` : 'hardly anyone'} at this time of day.`;
}

// A message names a source people know (a search engine, a social site, an AI assistant…) or one that sent
// visitors before; a host never seen could be spam, or a page its owner meant to keep to themselves.
const known = src => !src || channelFor(src, new URLSearchParams()) !== 'referral';

// How many of the USUAL_DAYS days before had the site's data in them, from its first event. That is asked
// once and kept in KV (added:<site>), so a new site's empty first days aren't averaged in as quiet ones.
async function daysOfData(env, store, site, nowSec) {
  const key = `added:${site}`;
  let first = Number(await env.STORE.get(key)) || 0;
  if (!first) {
    first = await store.firstSeen(site, nowSec);
    if (first) await env.STORE.put(key, String(first));
  }
  return first ? Math.max(0, Math.min(USUAL_DAYS, Math.floor((nowSec - 300 - first) / DAY))) : USUAL_DAYS;
}

async function spike(env, store, site, nowSec, many, fetchImpl) {
  const live = await store.live({ site }, nowSec);
  const here = live.visitors.filter(v => v.active);
  if (here.length < MIN_PEOPLE) return;
  const key = `spike:${site}`, day = new Date(nowSec * 1000).toISOString().slice(0, 10);
  const was = JSON.parse(await env.STORE.get(key) || 'null');
  const sent = was?.day === day ? was.sent : 0;
  if (sent >= PER_DAY || (was && nowSec - was.at < APART)) return;
  const days = await daysOfData(env, store, site, nowSec);
  if (days < MIN_DAYS) return;
  const usual = sum(await store.usual(site, nowSec, days)) / days;
  if (here.length < Math.max(2 * usual, usual + MIN_PEOPLE)) return;
  const full = live.visitors.length >= LIVE_MAX && live.visitors[LIVE_MAX - 1].active;
  const { src } = crowdOf(here), named = known(src) || await store.sentBefore(site, src, nowSec);
  const origin = await dashboard(env);
  const text = spikeText(here, full, usual, site, named) + (origin ? `\n${origin}${viewToUrl({ v: 'online' }, { site: many ? site : null })}` : '');
  if (await send(env, text, fetchImpl)) await env.STORE.put(key, JSON.stringify({ day, sent: sent + 1, at: nowSec }), { expirationTtl: 2 * DAY });
}

async function spikes(env, store, nowMs, fetchImpl) {
  const sites = await getSites(env), nowSec = Math.floor(nowMs / 1000);
  await Promise.all(sites.map(site => spike(env, store, site, nowSec, sites.length > 1, fetchImpl)
    .catch(e => console.error(`Couldn’t check ${site} for a crowd (${e.message}). It tries again in 15 minutes.`))));
}

/* ---------- the schedule ---------- */

// The two questions only messages ask, beside the dashboard's own.
const since = nowSec => `timestamp >= toDateTime(${nowSec - (USUAL_DAYS + 1) * DAY})`;
export const firstSeenSql = (ds, site, nowSec) =>
  `SELECT toUnixTimestamp(min(timestamp)) AS first FROM ${ds} WHERE index1 = '${site}' AND ${COL.type} = 'pageview' AND ${since(nowSec)}`;
export const sentBeforeSql = (ds, site, src, nowSec) =>
  `SELECT count() AS n FROM ${ds} WHERE index1 = '${site}' AND ${COL.type} = 'pageview' AND hex(${COL.referrer}) = '${hexOf(src)}' `
  + `AND ${since(nowSec)} AND timestamp < toDateTime(${nowSec - DAY})`;

function alertStore(env, fetchImpl) {
  const store = sqlStore(env, fetchImpl), ds = env.DATASET || 'lede', run = sql => runSql(env, sql, fetchImpl);
  return {
    ...store,
    async firstSeen(site, nowSec) { return Number((await run(firstSeenSql(ds, site, nowSec)))[0]?.first) || 0; },
    async sentBefore(site, src, nowSec) { return Number((await run(sentBeforeSql(ds, site, src, nowSec)))[0]?.n) > 0; },
  };
}
// The demo's crowd has come for weeks, from sources it knows.
const demoStore = { ...demoAlertStore, firstSeen: async () => 0, sentBefore: async () => true };

export async function runAlerts(cron, env, nowMs = Date.now(), fetchImpl = fetch) {
  const demo = env.DEMO === 'true';
  if (!env.ALERT_WEBHOOK && !demo) return;
  const on = (env.ALERTS ?? 'weekly,spikes').split(',').map(s => s.trim().toLowerCase());
  const kind = cron === SPIKES ? 'spikes' : 'weekly';
  if (!on.includes(kind)) return;
  let used = 0, cap = Infinity;
  const counted = (...a) => (used >= cap ? Promise.reject(new Error('no requests left on this schedule')) : (used++, fetchImpl(...a)));
  const budget = { used: () => used, cap: n => { cap = n; } };
  try {
    const store = demo ? demoStore : alertStore(env, counted);
    await (kind === 'spikes' ? spikes : weekly)(env, store, nowMs, counted, budget);
  } catch (e) {
    console.error(`Couldn’t send Lede’s messages (${e.message}). They try again on the next schedule.`);
  }
}
