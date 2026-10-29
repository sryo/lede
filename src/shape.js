// Turns raw aggregate rows (from SQL or the demo store) into the JSON the dashboard reads.
// The SQL API returns 64-bit counts as strings, hence the Number() everywhere.
import { SEARCH_PARAMS , BANDS} from './queries.js';

const num = v => Number(v) || 0;

export function metrics(r = {}) {
  const visits = num(r.visits);
  return {
    visitors: num(r.visitors),
    visits,
    views: num(r.views),
    bounce: r.bounces == null ? null : visits ? num(r.bounces) / visits : 0,
    duration: r.total_time == null ? null : visits ? num(r.total_time) / visits : 0,
  };
}

// Rows from a query that reads both periods carry p: 1 for this period, 0 for the one before.
export function byPeriod(rows) {
  const out = { cur: [], prev: [] };
  for (const r of rows) out[num(r.p) === 1 ? 'cur' : 'prev'].push(r);
  return out;
}

// A period with no visits has no row, where a query over just that period would have answered zeros.
const NONE = { visitors: 0, visits: 0, views: 0, bounces: 0, total_time: 0 };

// When a period was sampled, visits and bounces come from the view steps (see summarySql). Time on site
// stays per visit counted: only the visits that kept two or more views have one.
function counted(r, flat) {
  const m = metrics(r);
  if (!flat || r.v1 == null) return m;
  const visits = num(r.v1);
  return { ...m, visits, bounce: visits ? Math.max(0, visits - num(r.v2)) / visits : 0 };
}
const isSampled = rows => rows.some(r => num(r.sampled) > 0);

// sampled, prevSampled: Analytics Engine kept only a sample of some of that period's views.
export function toSummary(rows) {
  const { cur: [cur = NONE], prev: [prev = NONE] } = byPeriod(rows);
  const sampled = isSampled([cur]), prevSampled = isSampled([prev]);
  return { cur: counted(cur, sampled), prev: counted(prev, prevSampled), sampled, prevSampled };
}

// first: the day rows count from, when d doesn't start at this period's first day.
export function toSeries(rows, days, first = 0) {
  const out = { visitors: [], visits: [], views: [], bounce: [], duration: [] };
  const flat = isSampled(rows);
  const byDay = new Map(rows.map(r => [num(r.d) - first, counted(r, flat)]));
  const empty = metrics({ bounces: 0, total_time: 0 });
  for (let d = 0; d < days; d++) {
    const m = byDay.get(d) || empty;
    for (const k in out) out[k].push(m[k]);
  }
  return out;
}

// topSourceSql's rows, one per day: each day's top source and how many visitors it sent.
export function topByDay(rows, days) {
  const top = Array(days).fill(null), visitors = Array(days).fill(0);
  for (const r of rows) {
    const d = num(r.d);
    if (d >= 0 && d < days && top[d] === null) { top[d] = r.ref ?? ''; visitors[d] = num(r.visitors); }
  }
  return { top, topVisitors: visitors };
}

export const toFlows = rows => rows.map(r => ({ source: r.src ?? '', page: r.landing ?? '', visitors: num(r.visitors), visits: num(r.visits), bounces: num(r.bounces) }));

export function toConversions(rows) {
  const out = rows.map(r => ({ key: r.src ?? '', visits: num(r.visits), reached: num(r.reached) }));
  return { rows: out, visits: out.reduce((a, r) => a + r.visits, 0), reached: out.reduce((a, r) => a + r.reached, 0) };
}

// Visits reaching each step, this period and the one before; a period with no visits has no row.
export function toFunnel(rows, steps) {
  const { cur: [c = {}], prev: [p = {}] } = byPeriod(rows);
  return { steps, cur: steps.map((_, i) => num(c[`s${i}`])), prev: steps.map((_, i) => num(p[`s${i}`])) };
}

export const toFirsts = rows => rows.map(r => ({ key: r.key ?? '', day: num(r.d), visitors: num(r.visitors) }));
// The same, from a breakdown's merged rows (see mergeRows).
export const firstsOf = rows => rows.filter(r => r.first != null && r.visitors > 0).map(r => ({ key: r.key, day: r.first, visitors: r.visitors }));

// A page as collect.js stores it: the path of the address, percent-encoded as browsers send it, without
// a trailing slash, so a goal typed as /Café/ matches the views of /caf%C3%A9.
export function pagePath(s) {
  const p = new URL('https://x' + s).pathname;
  return p.length > 1 ? p.replace(/\/+$/, '') : '/';
}

export function toHourly(rows, days) {
  const out = Array(days * 24).fill(0);
  for (const r of rows) {
    const h = num(r.hr);
    if (h >= 0 && h < out.length) out[h] = num(r.visitors);
  }
  return out;
}

// Keys only seen in the previous period are kept with zero visitors, so a source that
// stopped sending anyone still shows up as a loss. first: the day of this period the key was first seen,
// when the rows say (breakdowns do).
export function mergeRows(cur, prev) {
  const before = new Map(prev.map(r => [r.key ?? '', metrics(r)]));
  const rows = cur.map(r => ({ key: r.key ?? '', ...metrics(r), ...(r.d != null && { first: num(r.d) }), prev: before.get(r.key ?? '') || null }));
  const seen = new Set(rows.map(r => r.key));
  for (const [key, m] of before) if (!seen.has(key)) rows.push({ key, ...metrics({}), prev: m });
  return rows;
}

// Rows by country, device and browser together, added up into one list each, biggest first. Rows stored before
// Lede recorded devices and browsers have neither: they count for countries only. When either period holds
// any, partial says which (this period wins), and devices and browsers carry no previous figures, since a
// change against a period only partly recorded would be made up.
export function toAudience(cur, prev) {
  const unknown = rows => rows.some(r => !r.device);
  const partial = unknown(cur) ? 'cur' : unknown(prev) ? 'prev' : null;
  const list = dim => mergeRows(addUp(cur, dim, dim === 'country'), dim === 'country' || !partial ? addUp(prev, dim, dim === 'country') : []);
  return { country: list('country'), device: list('device'), browser: list('browser'), partial };
}

// Rows by several keys added up into one list for one of them, biggest first; rows without it are left out
// unless blank counts (a visit from no known country is still one).
function addUp(rows, dim, blank = false) {
  const by = new Map();
  for (const r of rows) {
    const key = r[dim] ?? '';
    if (!blank && (!key || key === '0')) continue;
    const t = by.get(key) || by.set(key, { key, ...NONE }).get(key);
    for (const k in NONE) t[k] += num(r[k]);
  }
  return [...by.values()].sort((a, b) => b.visitors - a.visitors);
}
const listsBy = (cur, prev, dims) => Object.fromEntries(dims.map(d => [d, mergeRows(addUp(cur, d), addUp(prev, d))]));

// Systems, languages and screen-width bands from systemsSql's rows; campaigns, mediums and sources from campaignsSql's.
export const toSystems = (cur, prev) => listsBy(cur, prev, ['os', 'language', 'screen']);
export const toCampaigns = (cur, prev) => listsBy(cur, prev, ['campaign', 'medium', 'tag']);

// Both periods' days from one set of rows, where d counts from the start of the previous period.
export function toSeriesBoth(rows, days) {
  const { cur, prev } = byPeriod(rows);
  return { cur: toSeries(cur, days, days), prev: toSeries(prev, days) };
}

// liveSql's page views (or the Live object's), one row per visitor, last seen first: first and last seen,
// where they came from (their first page view's), here, when they were last seen on a page view they haven't
// left (0 with none), and the page they're on (with none, the one they left last). A page view is left when
// out says so, or (liveSql's) it was left (hid) after it was last seen otherwise (shown); a tie is still here.
export function byVisitor(views) {
  const by = new Map();
  for (const r of [...views].sort((a, b) => num(a.first) - num(b.first))) {
    const out = r.out != null ? num(r.out) > 0 : num(r.hid) > num(r.shown), last = num(r.last);
    const v = by.get(r.visitor);
    if (!v) { by.set(r.visitor, { path: r.path, referrer: r.referrer ?? '', country: r.country ?? '', first: num(r.first), last, here: out ? 0 : last }); continue; }
    if (out ? !v.here && last >= v.last : last >= v.here) v.path = r.path;
    if (!out) v.here = Math.max(v.here, last);
    v.last = Math.max(v.last, last);
  }
  return [...by.values()].sort((a, b) => b.last - a.last);
}

// Here now: seen in the last 5 minutes on a page view they haven't left (here, see byVisitor; rows without it
// count when the visitor was last seen at all). now and recent count everyone; visitors lists the LIVE_LIST seen
// last, so the answer stays small however big the crowd. groups count everyone by page, source, here or not, and
// band: how long they've been on the site, under 1, 5, 15 or 30 minutes (0 to 3), for the crowd to draw in
// proportion. atLeast: the rows were cut short (liveSql's LIMIT), so every count is a floor.
export const LIVE_LIST = 200;
const BANDS_S = [60, 300, 900];
export function shapeLive(rows, nowSec, atLeast = false) {
  const all = rows.map(r => ({
    path: r.path,
    referrer: r.referrer ?? '',
    country: r.country ?? '',
    seconds: num(r.last) - num(r.first),
    ago: nowSec - num(r.last),
    active: nowSec - num(r.here ?? r.last) < 300,
  })).sort((a, b) => a.ago - b.ago);
  const by = new Map();
  for (const v of all) {
    const band = BANDS_S.filter(s => v.seconds >= s).length, key = `${v.path}\n${v.referrer}\n${+v.active}\n${band}`;
    const g = by.get(key);
    if (g) g.n++; else by.set(key, { path: v.path, referrer: v.referrer, here: v.active, band, n: 1 });
  }
  return { now: all.filter(v => v.active).length, recent: all.length, atLeast, visitors: all.slice(0, LIVE_LIST), groups: [...by.values()] };
}

// Engagement rows carry sums (see engagementSql). Each page gets the page views that sent one, how many
// seconds they were read on average, and how far down, as a share of the page; the median engaged ms
// (one long read doesn't move it); and the 75th percentile of LCP and INP in ms and of CLS as its score
// (stored ×1000), each null when no view measured it, with lcpN, inpN and clsN, the views each was measured
// on (INP only comes from views with a tap or click). A single page also gets reach: the share of those
// views still there 10%, 20%... 100% of the way down.
const vital = (r, k, scale = 1) => num(r[`${k}_n`]) > 0 ? num(r[k]) / scale : null;
const reading = r => {
  const n = num(r.n), out = { views: n, time: n ? num(r.ms) / n / 1000 : 0, scroll: n ? num(r.depth) / n / 100 : 0 };
  out.median = num(r.median_ms);
  out.lcp = vital(r, 'lcp');
  out.inp = vital(r, 'inp');
  out.cls = vital(r, 'cls', 1000);
  for (const k of ['lcp', 'inp', 'cls']) out[`${k}N`] = num(r[`${k}_n`]);
  // Only the page a view asked for has its bands counted (see engagementSql).
  if (r.r10 != null && (r.asked == null || num(r.asked) > 0)) out.reach = BANDS.map(d => n ? num(r[`r${d}`]) / n : 0);
  return out;
};
export function toEngagement(cur, prev) {
  const before = new Map(prev.map(r => [r.key ?? '', reading(r)]));
  return { rows: cur.map(r => ({ key: r.key ?? '', ...reading(r), prev: before.get(r.key ?? '') || null })) };
}

// Outbound links and downloads, each with last period's visitors (null when nobody clicked it then).
export function toLinks(cur, prev) {
  const id = r => `${r.kind}|${r.key ?? ''}`;
  const before = new Map(prev.map(r => [id(r), num(r.visitors)]));
  const out = { outbound: [], downloads: [] };
  for (const r of cur) {
    const list = r.kind === 'outbound' ? out.outbound : r.kind === 'download' ? out.downloads : null;
    list?.push({ key: r.key ?? '', visitors: num(r.visitors), clicks: num(r.clicks), prev: before.get(id(r)) ?? null });
  }
  return out;
}

/* ---------- keywords ---------- */

// A search or ad word as the lists count it: lowercased, spaces squeezed, cut at 80 characters.
export function keyword(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80).trim();
}

// The words searched for on a page address such as /search?q=owl+calls&page=2. Parsing the query decodes
// + and %20, and every other parameter (the result page) is dropped, so all pages of one search are one word.
export function searchWord(url) {
  const at = String(url ?? '').indexOf('?');
  if (at < 0) return '';
  let params;
  try { params = new URLSearchParams(url.slice(at + 1)); } catch { return ''; }
  for (const p of SEARCH_PARAMS) {
    const v = params.get(p);
    if (!v) continue;
    // URLSearchParams turns a broken escape into U+FFFD; that's not a word anyone typed.
    return v.includes('�') ? '' : keyword(v);
  }
  return '';
}

const KEEP_WORDS = 1000;

function wordList(cur, prev) {
  return [...cur].sort((a, b) => b[1] - a[1]).slice(0, KEEP_WORDS)
    .map(([key, visitors]) => ({ key, visitors, prev: prev.get(key) || null }));
}

// keywordsSql's rows as the two lists toKeywords counts: a search row (surl) for the words, and a row per ad
// keyword, where a search an ad landed on counts its one visitor.
export function splitKeywords(rows) {
  const site = [], paid = [], landed = new Map();
  for (const r of rows) {
    if (r.surl) site.push({ p: r.p, url: r.surl, visitor: r.v });
    if (!r.term) continue;
    if (!r.surl) { paid.push({ p: r.p, key: r.term, visitors: r.visitors }); continue; }
    const k = `${num(r.p) === 1 ? 1 : 0}\n${r.term}`;
    if (!landed.has(k)) landed.set(k, new Set());
    landed.get(k).add(r.v);
  }
  for (const [k, who] of landed) {
    const [p, key] = k.split('\n');
    paid.push({ p: Number(p), key, visitors: String(who.size) });
  }
  return { site, paid };
}

// site: rows of { p, url, visitor }, one per visitor and search address, so a visitor who paged through
// the results or typed the word twice is counted once. paid: rows of { p, key, visitors } per ad keyword,
// already cleaned when collected; cleaning again merges what older rows spelled differently.
export function toKeywords(site, paid) {
  const seen = [new Map(), new Map()];
  for (const r of site) {
    const word = searchWord(r.url), m = seen[num(r.p) === 1 ? 1 : 0];
    if (!word) continue;
    if (!m.has(word)) m.set(word, new Set());
    m.get(word).add(r.visitor);
  }
  const people = seen.map(m => new Map([...m].map(([k, s]) => [k, s.size])));
  const ads = [new Map(), new Map()];
  for (const r of paid) {
    const word = keyword(r.key), m = ads[num(r.p) === 1 ? 1 : 0];
    if (word) m.set(word, (m.get(word) || 0) + num(r.visitors));
  }
  return { site: wordList(people[1], people[0]), paid: wordList(ads[1], ads[0]) };
}

// From the visits that viewed a page (nextVisitsSql, ordered by ID), up to keep per period. Only IDs that
// are 12 hex characters are taken, since they go into the next query as written. keep holds "p|id", so a
// visit picked for one period doesn't bring in its part in the other. sampled: a period had more.
export function pickVisits(rows, keep) {
  const ids = [], seen = new Set(), picked = new Set(), n = { 1: 0, 0: 0 }, sampled = { cur: false, prev: false };
  for (const r of rows) {
    const p = num(r.p) === 1 ? 1 : 0, v = String(r.v ?? '');
    if (!/^[0-9a-f]{12}$/.test(v)) continue;
    if (n[p] >= keep) { sampled[p ? 'cur' : 'prev'] = true; continue; }
    n[p]++;
    picked.add(`${p}|${v}`);
    if (!seen.has(v)) { seen.add(v); ids.push(v); }
  }
  return { ids, keep: picked, sampled };
}

// Pairs each view of path with the page viewed next in the same visit, or none: the reader left.
// Views are put in time order first, and the same page viewed again straight after (a reload) is one view.
// views: views of the page, left: views nothing followed, visits: visits that viewed it,
// next: the pages that followed, most first.
// goals: pages that count as reaching a goal; with any, each period also counts the visits that viewed one after the page.
export function pairNext(rows, path, goals = []) {
  const visits = new Map();
  for (const r of rows) {
    const k = `${num(r.p) === 1 ? 1 : 0}|${r.v}`;
    if (!visits.has(k)) visits.set(k, []);
    visits.get(k).push(r);
  }
  const tally = () => ({ views: 0, left: 0, visits: 0, reached: 0, to: new Map() });
  const goal = new Set(goals);
  const out = { 1: tally(), 0: tally() };
  for (const [k, list] of visits) {
    list.sort((a, b) => num(a.t) - num(b.t));
    const seq = [];
    for (const r of list) if (seq.at(-1) !== (r.path ?? '')) seq.push(r.path ?? '');
    const t = out[k[0]];
    let seen = false;
    const first = seq.indexOf(path);
    if (first >= 0 && seq.slice(first + 1).some(p => goal.has(p))) t.reached++;
    seq.forEach((p, i) => {
      if (p !== path) return;
      seen = true;
      t.views++;
      if (i === seq.length - 1) t.left++;
      else t.to.set(seq[i + 1], (t.to.get(seq[i + 1]) || 0) + 1);
    });
    if (seen) t.visits++;
  }
  const done = ({ views, left, visits, reached, to }) => ({
    views, left, visits, ...(goals.length && { reached }), next: [...to].map(([key, n]) => ({ key, views: n })).sort((a, b) => b.views - a.views || (a.key < b.key ? -1 : 1)),
  });
  return { cur: done(out[1]), prev: done(out[0]) };
}
