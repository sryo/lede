// Messages sent to a webhook on a schedule, so the owner hears what changed without opening the dashboard:
// the week's story every Monday, and a line when far more people than usual are here at once.
// Nothing is read or sent until ALERT_WEBHOOK is set.
import { sqlStore, withChannels } from './api.js';
import { demoAlertStore } from './demo.js';
import { getSites } from './settings.js';
import { DAY } from './queries.js';
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

// Slack and Discord want JSON; ntfy and most other webhooks take the text as it is.
export function webhookRequest(url, text) {
  const host = new URL(url).hostname;
  const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (host === 'hooks.slack.com') return json({ text: text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) });
  if (/(^|\.)discord(app)?\.com$/.test(host)) return json({ content: text.slice(0, 2000), allowed_mentions: { parse: [] } });
  return { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text };
}

// True once the message is out. A webhook that fails is logged and skipped. In the demo without a
// webhook, the message goes to the console instead.
async function send(env, text, fetchImpl) {
  if (!env.ALERT_WEBHOOK) { console.log(`Lede alert:\n${text}`); return true; }
  try {
    const res = await fetchImpl(env.ALERT_WEBHOOK, webhookRequest(env.ALERT_WEBHOOK, text));
    if (res.ok) return true;
    console.error(`The alert webhook answered ${res.status}. Check ALERT_WEBHOOK.`);
  } catch (e) {
    console.error(`Couldn't reach the alert webhook (${e.message}). Check ALERT_WEBHOOK.`);
  }
  return false;
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
  const { c, p, diff } = S, lines = [];
  const pct = p.visitors >= 30 ? ` (${diff > 0 ? '+' : '−'}${Math.round(Math.abs(diff) / p.visitors * 100)}%)` : '';
  // A flat week's sentence already says it was about the same, so the total stands alone.
  lines.push(!c.visitors ? `No visitors this week, down from ${fmtInt(p.visitors)} the week before.`
    : !p.visitors || S.flat ? `${people(c.visitors, 'visitor')}.`
      : `${people(c.visitors, 'visitor')}, ${fmtInt(Math.abs(diff))} ${diff > 0 ? 'more' : 'fewer'} than the week before${pct}.`);
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
  const [totals, ser, pages, refs, flows] = await Promise.all([store.summary(q), store.series(q), store.breakdown(q, 'path'),
    store.breakdown(q, 'referrer').then(withChannels), store.flows(q)]);
  const S = readStory({ totals, ser, pages, refs, flows }), T = tellStory(S, ser, q.days, { now: 'this week', before: 'the week before' });
  const pageRows = pages.rows.map(r => ({ key: r.key, value: r.visitors, prev: r.prev?.visitors }));
  return [`${displayHost(site)}, the week of ${fmtDay(dayDate(q.start, 0))}`, plain(T.html),
    ...(S.c.visitors || S.p.visitors ? supporting(S, pageRows, T.page) : []), ...(link ? [link] : [])].join('\n');
}

async function weekly(env, store, nowMs, fetchImpl) {
  const sites = await getSites(env), origin = await dashboard(env);
  const link = site => origin && origin + viewToUrl(null, { days: 7, site: sites.length > 1 ? site : null });
  const told = await Promise.allSettled(sites.map(site => weekText(store, site, nowMs, link(site))));
  for (const r of told) if (r.status === 'rejected') console.error(`Weekly story: ${r.reason?.message || r.reason}`);
  const blocks = told.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (blocks.length) await send(env, blocks.join('\n\n'), fetchImpl);
}

/* ---------- spikes ---------- */

// "Here now" must reach both MIN_PEOPLE and twice the usual (or the usual plus MIN_PEOPLE, for quiet hours).
const MIN_PEOPLE = 10;
const USUAL_DAYS = 14;
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

export function spikeText(here, full, usual, site) {
  const [page, onPage] = most(here, v => v.path);
  const focus = onPage * 2 >= here.length, crowd = focus ? here.filter(v => v.path === page) : here;
  const [src, fromSrc] = most(crowd, v => v.referrer);
  const n = `${full ? 'At least ' : ''}${fmtInt(here.length)}`;
  const all = onPage === here.length, where = all ? `${n} people are on ${pageName(page)} of ${displayHost(site)} right now`
    : `${n} people are on ${displayHost(site)} right now${focus ? `, ${fmtInt(onPage)} of them on ${pageName(page)}` : ''}`;
  // After "12 of them on /x", "most of those" says the count is of the people on that page.
  const mostOf = focus && !all ? 'most of those' : 'most';
  const from = fromSrc * 2 > crowd.length
    ? (src ? `${mostOf} from ${labelOf('referrer', src)}` : `${focus && !all ? 'most of those' : 'most of them'} direct visitors`)
    : (src ? `more from ${labelOf('referrer', src)} than anywhere else` : 'more direct visitors than from any one source');
  const r = Math.round(usual);
  return `${where}, ${from}. Usually ${r ? `about ${fmtInt(r)}` : 'hardly anyone'} at this time of day.`;
}

async function spike(env, store, site, nowSec, many, fetchImpl) {
  const live = await store.live({ site }, nowSec);
  const here = live.visitors.filter(v => v.active);
  if (here.length < MIN_PEOPLE) return;
  const key = `spike:${site}`, day = new Date(nowSec * 1000).toISOString().slice(0, 10);
  const was = JSON.parse(await env.STORE.get(key) || 'null');
  const sent = was?.day === day ? was.sent : 0;
  if (sent >= PER_DAY || (was && nowSec - was.at < APART)) return;
  const usual = sum(await store.usual(site, nowSec, USUAL_DAYS)) / USUAL_DAYS;
  if (here.length < Math.max(2 * usual, usual + MIN_PEOPLE)) return;
  const full = live.visitors.length >= LIVE_MAX && live.visitors[LIVE_MAX - 1].active;
  const origin = await dashboard(env);
  const text = spikeText(here, full, usual, site) + (origin ? `\n${origin}${viewToUrl({ v: 'online' }, { site: many ? site : null })}` : '');
  if (await send(env, text, fetchImpl)) await env.STORE.put(key, JSON.stringify({ day, sent: sent + 1, at: nowSec }), { expirationTtl: 2 * DAY });
}

async function spikes(env, store, nowMs, fetchImpl) {
  const sites = await getSites(env), nowSec = Math.floor(nowMs / 1000);
  await Promise.all(sites.map(site => spike(env, store, site, nowSec, sites.length > 1, fetchImpl)
    .catch(e => console.error(`Spike check for ${site}: ${e.message}`))));
}

/* ---------- the schedule ---------- */

export async function runAlerts(cron, env, nowMs = Date.now(), fetchImpl = fetch) {
  const demo = env.DEMO === 'true';
  if (!env.ALERT_WEBHOOK && !demo) return;
  const on = (env.ALERTS ?? 'weekly,spikes').split(',').map(s => s.trim().toLowerCase());
  const kind = cron === SPIKES ? 'spikes' : 'weekly';
  if (!on.includes(kind)) return;
  try {
    const store = demo ? demoAlertStore : sqlStore(env, fetchImpl);
    await (kind === 'spikes' ? spikes : weekly)(env, store, nowMs, fetchImpl);
  } catch (e) {
    console.error(`Alerts: ${e.message}`);
  }
}
