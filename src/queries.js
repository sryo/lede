import { COL } from './schema.js';

export const DAY = 86400;

// Filters the dashboard can apply, and the column each one matches.
export const FILTERS = { path: COL.path, referrer: COL.referrer, channel: COL.channel };

// Breakdowns computed per visit: the key is taken from the visit's first (or last) event.
const VISIT_KEYS = {
  entry: `argMin(${COL.path}, timestamp)`,
  exit: `argMax(${COL.path}, timestamp)`,
  referrer: `argMin(${COL.referrer}, timestamp)`,
  channel: `argMin(${COL.channel}, timestamp)`,
  country: `argMin(${COL.country}, timestamp)`,
};
export const BREAKDOWNS = ['path', ...Object.keys(VISIT_KEYS)];

// The SQL API has no documented string escaping, so user-supplied values are compared
// as hex: hex(column) = '2F70...' can't break out of the literal whatever the value holds.
export function hexOf(s) {
  return [...new TextEncoder().encode(s)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// A function giving a time zone's offset (seconds east of UTC) at a unix second, or null when the name
// isn't a zone Intl knows. Workers carry the full time zone database, so this follows every rule change.
export function zoneOffset(name) {
  if (!name || name.length > 64) return null;
  let f;
  try {
    f = new Intl.DateTimeFormat('en-US', { timeZone: name, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  } catch { return null; }
  return t => {
    const p = Object.fromEntries(f.formatToParts(t * 1000).map(x => [x.type, x.value]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - t;
  };
}

// The unix second a local day starts, given off (as from zoneOffset) and that day's midnight written as
// if it were UTC (wall). The offset an hour or so either side of midnight is all that matters, and the
// offsets a day either side of wall bracket it; they only differ when the clocks change near this midnight.
function midnight(off, wall) {
  const a = off(wall - DAY), b = off(wall + DAY);
  if (a === b) return wall - a;
  // Clocks going back can show midnight twice (Chile does): the day starts at the first.
  const at = [wall - a, wall - b].filter(t => t + off(t) === wall);
  if (at.length) return Math.min(...at);
  // Clocks springing forward over midnight (Cuba, Lebanon) skip it: the day starts at the change.
  let lo = Math.min(wall - a, wall - b), hi = Math.max(wall - a, wall - b);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (mid + off(mid) >= wall) hi = mid; else lo = mid;
  }
  return hi;
}

// Local-midnight boundaries for the current and previous period, in unix seconds. bounds holds every
// midnight from prevStart to end, so bounds[days] is start: the days a daylight-saving change makes
// 23 or 25 hours long (23.5 or 24.5 on Lord Howe Island) are as long as they really were.
// tzName is the viewer's IANA zone; without a valid one, tz (Date#getTimezoneOffset(): minutes behind
// UTC) is applied to the whole window, as older dashboards expect.
// Today is only partly over, so the previous period stops at the same time of day (to the minute):
// both periods then cover the same span and their totals can be compared.
export function ranges(days, tz, nowMs = Date.now(), tzName) {
  const off = zoneOffset(tzName) || (() => -tz * 60);
  const now = Math.floor(nowMs / 60000) * 60;
  const today = Math.floor((now + off(now)) / DAY) * DAY;
  const bounds = Array.from({ length: 2 * days + 1 }, (_, k) => midnight(off, today + (k - 2 * days + 1) * DAY));
  const start = bounds[days], todayStart = bounds[2 * days - 1];
  return { start, end: bounds[2 * days], prevStart: bounds[0], prevEnd: Math.min(start, bounds[days - 1] + now - todayStart), bounds };
}

// Which day an instant t (a SQL expression in unix seconds) falls in, counted from bounds[0], given the
// midnights that follow it. Days are usually 86,400 s and intDiv does it; when the clocks change in the
// window, it counts the midnights already passed instead. if() rather than a bare comparison, because
// only if() is documented as turning a condition into a number. With 89 midnights (45 days twice) the
// longest query is still near 3 KB of the 10 KiB allowed.
export function dayOf(t, bounds) {
  const even = bounds.every((b, i) => !i || b - bounds[i - 1] === DAY);
  if (even) return `intDiv(${t} - ${bounds[0]}, ${DAY})`;
  return bounds.slice(1).map(b => `if(${t} >= ${b}, 1, 0)`).join(' + ');
}
const curDays = q => q.bounds.slice(q.days, 2 * q.days);
const bothDays = q => q.bounds.slice(0, 2 * q.days);

const span = (from, to) => `timestamp >= toDateTime(${from}) AND timestamp < toDateTime(${to})`;

// Stats count page views only, unless a query asks for other types of event (engagement, link clicks).
// Rows written before there were other types are all page views.
function match(q, time, types = ['pageview']) {
  const type = types.map(t => `${COL.type} = '${t}'`).join(' OR ');
  const parts = [`index1 = '${q.site}'`, types.length > 1 ? `(${type})` : type, time];
  for (const [name, col] of Object.entries(FILTERS)) {
    if (q.filters[name] != null) parts.push(`hex(${col}) = '${hexOf(q.filters[name])}'`);
  }
  return parts.join(' AND ');
}

export const where = (q, from, to, types) => match(q, span(from, to), types);

// Queries that compare the two periods read both at once and label each row with p: 1 for this period,
// 0 for the one before. only ('cur' or 'prev') narrows one to a single period, with the same rows.
const PERIOD = q => `if(timestamp >= toDateTime(${q.start}), 1, 0)`;
export function within(q, only, types) {
  if (only === 'cur') return where(q, q.start, q.end, types);
  if (only === 'prev') return where(q, q.prevStart, q.prevEnd, types);
  return match(q, `((${span(q.prevStart, q.prevEnd)}) OR (${span(q.start, q.end)}))`, types);
}

// Lists keep each period's top rows, but this SQL has no LIMIT BY, so a query reading both periods asks
// for more rows (both) and the store trims each period to keep. That gives the same lists as one query
// per period unless one period alone fills nearly all of both, as when traffic rose or fell tenfold
// across a site with hundreds of pages; the other period's list can then come back short, and the
// store asks for that period on its own.
export const LISTS = { breakdown: { keep: 100, both: 1000 }, flows: { keep: 10000, both: 20000 }, pages: { keep: 200, both: 2000 }, audience: { keep: 2000, both: 4000 } };
const limit = (list, only) => `LIMIT ${only ? list.keep : list.both}`;

// One row per visit: n = events stored, w = page views they stand for (more than n once
// Analytics Engine samples), dur = seconds between its first and last event.
// Bounce looks at n: a sampled single view stands for several views but is still one page.
// With p, visits are grouped by period too, so a visit that runs from one period into the other is
// split between them, as it would be with one query per period.
function visits(ds, cond, extra = '', p = '') {
  return `(SELECT ${p ? `${p} AS p, ` : ''}${COL.visit} AS visit, argMin(${COL.visitor}, timestamp) AS visitor, count() AS n, sum(_sample_interval) AS w, `
    + `toUnixTimestamp(max(timestamp)) - toUnixTimestamp(min(timestamp)) AS dur${extra} `
    + `FROM ${ds} WHERE ${cond} GROUP BY ${p ? 'p, ' : ''}visit)`;
}

// Bounce = visits with one view. Time on site only counts visits with more than one view.
const METRICS = 'count(DISTINCT visitor) AS visitors, count() AS visits, sum(w) AS views, '
  + 'countIf(n = 1) AS bounces, sumIf(dur, n > 1) AS total_time';

// Once Analytics Engine samples, a visit whose views were mostly left out still counts as one visit
// (a bounce, if one view is left), so visits and bounces run low. Page views carry step: 1 for a visit's
// first view, 2 for its second, 3 after, 0 from trackers older than step. Each sampled row stands for
// _sample_interval rows like it, so the weighted count of step 1 is the visits and of step 2 the visits
// that didn't bounce, whatever was left out. v1 and v2 count that way only for sampled visits whose views
// carry a step, and exactly for the rest: a visit kept whole is one visit even when it has two step-1
// views, as when a second tab joins it or the tracker can't keep its count.
const STEPS = `, sumIf(_sample_interval, ${COL.step} = 1) AS k1, sumIf(_sample_interval, ${COL.step} = 2) AS k2, countIf(${COL.step} = 0) AS k0`;
const FLAT = 'countIf(w > n) AS sampled, countIf(k0 > 0 OR w = n) + sumIf(k1, k0 = 0 AND w > n) AS v1, '
  + 'countIf((k0 > 0 OR w = n) AND n > 1) + sumIf(k2, k0 = 0 AND w > n) AS v2';

// sampled: visits with any sampled view (each such row stands for more than one, so w > n).
export const summarySql = (ds, q) =>
  `SELECT p, ${METRICS}, ${FLAT} FROM ${visits(ds, within(q), STEPS, PERIOD(q))} GROUP BY p`;

// d counts days from the start of the previous period, by the day each visit started.
export const seriesSql = (ds, q) =>
  `SELECT p, ${dayOf('t0', bothDays(q))} AS d, ${METRICS}, ${FLAT} FROM ${visits(ds, within(q), `, toUnixTimestamp(min(timestamp)) AS t0${STEPS}`, PERIOD(q))} `
  + 'GROUP BY p, d ORDER BY p, d';

// Whether the site has had any page view at all, whatever the filters: Analytics Engine keeps 90 days.
export const everSql = (ds, site) =>
  `SELECT 1 AS seen FROM ${ds} WHERE index1 = '${site}' AND ${COL.type} = 'pageview' AND timestamp > now() - INTERVAL '90' DAY LIMIT 1`;

// Visitor IDs change at the start of each UTC month (see getSalt), so a period holding one counts
// someone who came either side of it twice.
const nextMonth = t => { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000; };
export const monthSplit = q => ({ cur: nextMonth(q.start) < q.end, prev: nextMonth(q.prevStart) < q.prevEnd });

// Each day's source with the most visitors: one row per day, so a busy day's sources can't crowd
// the quieter days out of the answer. The inner count isn't named visitors: the outer alias would
// shadow it, putting max() inside argMax().
export const topSourceSql = (ds, q) =>
  `SELECT d, argMax(ref, n) AS ref, max(n) AS visitors FROM (SELECT ${dayOf('toUnixTimestamp(timestamp)', curDays(q))} AS d, ${COL.referrer} AS ref, `
  + `count(DISTINCT ${COL.visitor}) AS n FROM ${ds} WHERE ${where(q, q.start, q.end)} GROUP BY d, ref) GROUP BY d ORDER BY d LIMIT ${q.days}`;

// d is the day of this period each key was first seen, so the timeline can mark new pages and sources
// without a query of its own (this period's rows only).
export function breakdownSql(ds, q, dim, only) {
  if (dim === 'path') {
    return `SELECT ${PERIOD(q)} AS p, ${COL.path} AS key, count(DISTINCT ${COL.visitor}) AS visitors, count(DISTINCT ${COL.visit}) AS visits, sum(_sample_interval) AS views, `
      + `${dayOf('toUnixTimestamp(min(timestamp))', curDays(q))} AS d FROM ${ds} WHERE ${within(q, only)} GROUP BY p, key ORDER BY visitors DESC ${limit(LISTS.breakdown, only)}`;
  }
  return `SELECT p, key, ${METRICS}, ${dayOf('min(t0)', curDays(q))} AS d FROM ${visits(ds, within(q, only), `, ${VISIT_KEYS[dim]} AS key, toUnixTimestamp(min(timestamp)) AS t0`, PERIOD(q))} `
    + `GROUP BY p, key ORDER BY visitors DESC ${limit(LISTS.breakdown, only)}`;
}

// Visits by country, device and browser together, so one query answers all three lists: a visitor's hash
// covers their IP and user agent, so each visitor sits in one row and the rows add up per list.
export const audienceSql = (ds, q, only) =>
  `SELECT p, country, device, browser, ${METRICS} FROM ${visits(ds, within(q, only), `, ${VISIT_KEYS.country} AS country, argMin(${COL.device}, timestamp) AS device, `
  + `argMin(${COL.browser}, timestamp) AS browser`, PERIOD(q))} GROUP BY p, country, device, browser ORDER BY visitors DESC ${limit(LISTS.audience, only)}`;

// Visits by the source they came from, and how many of them viewed any of the goal pages.
export const conversionsSql = (ds, q, from, to, goals) =>
  `SELECT src, count() AS visits, sum(hit) AS reached FROM ${visits(ds, where(q, from, to), `, ${VISIT_KEYS.referrer} AS src, `
  + `max(if(${goals.map(g => `hex(${COL.path}) = '${hexOf(g)}'`).join(' OR ')}, 1, 0)) AS hit`)} GROUP BY src ORDER BY visits DESC LIMIT 200`;

// A funnel: per period, the visits that viewed each step after the step before, any view of it counting,
// not only the first. With no window functions or arrays, each visit keeps the first (a) and last (z)
// time it viewed each step (NEVER and 0 when it didn't), and lo carries the earliest the visit can have
// been at a step: the first view of step 0, then the later of that and each next step's first view. A
// visit reaches step k when every step up to k was last seen after lo of the one before. That holds for
// every visit that went through the steps in order, and for two steps it's exact; with more, a visit
// can count that saw a middle step only before and after the ones around it. Only views of the step
// pages are read. The dashboard's filters don't apply: a path filter would leave out every step but one.
const NEVER = 4294967295;
export function funnelSql(ds, q, steps) {
  const is = s => `hex(${COL.path}) = '${hexOf(s)}'`;
  // The last step's first view and the first step's last view are never needed.
  const times = steps.flatMap((s, i) => [
    ...(i < steps.length - 1 ? [`min(if(${is(s)}, toUnixTimestamp(timestamp), ${NEVER})) AS a${i}`] : []),
    ...(i ? [`max(if(${is(s)}, toUnixTimestamp(timestamp), 0)) AS z${i}`] : []),
  ]).join(', ');
  const lo = steps.reduce((acc, _, i) => [...acc, i ? `if(a${i} > ${acc[i - 1]}, a${i}, ${acc[i - 1]})` : 'a0'], []);
  const reached = steps.map((_, k) => `countIf(${['a0 < ' + NEVER, ...steps.slice(1, k + 1).map((_, j) => `z${j + 1} > ${lo[j]}`)].join(' AND ')}) AS s${k}`).join(', ');
  const cond = `${within({ ...q, filters: {} })} AND (${steps.map(is).join(' OR ')})`;
  return `SELECT p, ${reached} FROM (SELECT ${PERIOD(q)} AS p, ${COL.visit} AS visit, ${times} FROM ${ds} WHERE ${cond} GROUP BY p, visit) GROUP BY p`;
}

// Visitors by the source a visit came from and the page it landed on, for the Sankey.
// landing keeps only the visits that landed on that page, for its own view.
export const flowSql = (ds, q, only, landing) =>
  `SELECT p, src, landing, count(DISTINCT visitor) AS visitors FROM ${visits(ds, within(q, only), `, ${VISIT_KEYS.referrer} AS src, ${VISIT_KEYS.entry} AS landing`, PERIOD(q))} `
  + `${landing == null ? '' : `WHERE hex(landing) = '${hexOf(landing)}' `}GROUP BY p, src, landing ORDER BY visitors DESC ${limit(LISTS.flows, only)}`;

// Where the hourly answer's hour 0 sits: whole days of 24 hours back from today's local midnight, so
// today's hour k is the hour starting k hours after midnight, whatever the clocks did earlier in the
// window, and the answer is exactly days * 24 hours long. Days before a daylight-saving change come out an
// hour off their own midnight instead (the answer starts an hour into the period, or an hour before it):
// the dashboard places each hour by its real time where that matters.
export const hourlyStart = q => q.bounds[2 * q.days - 1] - (q.days - 1) * DAY;

// Visitors per hour since from (hourlyStart for the period).
export const hourlySql = (ds, q, from, to) =>
  `SELECT intDiv(toUnixTimestamp(timestamp) - ${from}, 3600) AS hr, count(DISTINCT ${COL.visitor}) AS visitors `
  + `FROM ${ds} WHERE ${where(q, from, to)} GROUP BY hr ORDER BY hr LIMIT 2000`;

// Per page: page views that sent an engagement event (n), and their engaged milliseconds and scroll
// percentages summed, each weighted by the views a sampled row stands for. Averages are taken in shape.js.
// For one page it also counts the views that got at least 10%, 20%... 100% of the way down (r10...r100),
// so the page's view can show where readers stop without a query of its own (see engagementSql).
// It also takes the median engaged time, and the 75th percentile of each Web Vital (what Google's
// thresholds are judged on) over the views that measured it: a view with 0 had none (an older tracker,
// a browser without the API, no tap or key for INP). CLS is stored one higher, so a page that never
// shifts counts with 0 and Firefox and Safari, which don't report shifts, are left out.
// lcp_n, inp_n, cls_n: the views each one comes from.
export const BANDS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const VITALS = [['lcp', COL.lcp], ['inp', COL.inp], ['cls', `(${COL.cls} - 1)`]]
  .map(([k, v]) => `, quantileExactWeighted(0.75)(${v}, if(${COL[k]} > 0, _sample_interval, 0)) AS ${k}, sumIf(_sample_interval, ${COL[k]} > 0) AS ${k}_n`).join('');
// A page's own view asks for every page too, so its sentence can say how the page compares: the reach bands
// count that page's views alone, and its row comes first, so the LIMIT never leaves it out.
export const engagementSql = (ds, q, only) => {
  const path = q.filters.path, page = path == null ? null : `hex(${COL.path}) = '${hexOf(path)}'`;
  const all = page ? { ...q, filters: { ...q.filters, path: null } } : q;
  return `SELECT ${PERIOD(q)} AS p, ${COL.path} AS key, sum(_sample_interval) AS n, sum(_sample_interval * ${COL.engaged}) AS ms, sum(_sample_interval * ${COL.scroll}) AS depth`
    + `, quantileExactWeighted(0.5)(${COL.engaged}, _sample_interval) AS median_ms${VITALS}${page ? `, max(${page}) AS asked` : ''}`
    + (page ? BANDS.map(d => `, sumIf(_sample_interval, ${page} AND ${COL.scroll} >= ${d}) AS r${d}`).join('') : '')
    + ` FROM ${ds} WHERE ${within(all, only, ['engagement'])} GROUP BY p, key ORDER BY ${page ? 'asked DESC, ' : ''}n DESC ${limit(LISTS.pages, only)}`;
};

// Links to other sites and files, by the visitors who clicked them.
export const linksSql = (ds, q, only) =>
  `SELECT ${PERIOD(q)} AS p, ${COL.type} AS kind, ${COL.target} AS key, count(DISTINCT ${COL.visitor}) AS visitors, sum(_sample_interval) AS clicks `
  + `FROM ${ds} WHERE ${within(q, only, ['outbound', 'download'])} GROUP BY p, kind, key ORDER BY visitors DESC ${limit(LISTS.pages, only)}`;

export const liveSql = (ds, site) =>
  `SELECT ${COL.visitor} AS visitor, argMax(${COL.path}, timestamp) AS path, argMin(${COL.referrer}, timestamp) AS referrer, `
  + `argMin(${COL.country}, timestamp) AS country, toUnixTimestamp(min(timestamp)) AS first, toUnixTimestamp(max(timestamp)) AS last `
  + `FROM ${ds} WHERE index1 = '${site}' AND (${COL.type} = 'pageview' OR ${COL.type} = 'ping') AND timestamp > now() - INTERVAL '30' MINUTE GROUP BY visitor ORDER BY last DESC LIMIT 200`;

// How many people are usually here at this time of day: visitors seen in the same 5 minutes (the span
// "here now" counts) on each of the days days before now, one row per day that had any.
export const usualSql = (ds, site, nowSec, days) => {
  const from = nowSec - days * DAY - 300, at = `(toUnixTimestamp(timestamp) - ${from})`;
  return `SELECT intDiv(${at}, ${DAY}) AS d, count(DISTINCT ${COL.visitor}) AS visitors FROM ${ds} `
    + `WHERE index1 = '${site}' AND (${COL.type} = 'pageview' OR ${COL.type} = 'ping') `
    + `AND timestamp >= toDateTime(${from}) AND timestamp < toDateTime(${nowSec - DAY}) AND ${at} - intDiv(${at}, ${DAY}) * ${DAY} < 300 GROUP BY d`;
};

// The query parameters site search pages commonly put the words in (WordPress uses s).
export const SEARCH_PARAMS = ['q', 's', 'search', 'query', 'keyword', 'keywords', 'k'];
// Site searches and ad keywords, from one query over the same page views. SQL here can't pull one parameter
// out of an address, so a page view whose address holds one comes back once per visitor and address (surl, v),
// and shape.js reads the words and counts each visitor once. A page view with an ad keyword (utm_term on the
// page a visit landed on) is counted per keyword instead (visitors, v empty), unless it was a search too: an
// ad can land on the site's search, and then its row carries both. Rows past the limit are dropped, which only
// a site with tens of thousands of searches a period reaches; the keywords with the most visitors come first.
const SEARCHED = '(' + SEARCH_PARAMS.flatMap(p => [`position('?${p}=' IN ${COL.url}) > 0`, `position('&${p}=' IN ${COL.url}) > 0`]).join(' OR ') + ')';
export const keywordsSql = (ds, q) =>
  `SELECT ${PERIOD(q)} AS p, if(${SEARCHED}, ${COL.url}, '') AS surl, ${COL.utmTerm} AS term, if(${SEARCHED}, ${COL.visitor}, '') AS v, `
  + `count(DISTINCT ${COL.visitor}) AS visitors FROM ${ds} WHERE ${within(q)} AND (${SEARCHED} OR ${COL.utmTerm} != '') `
  + 'GROUP BY p, surl, term, v ORDER BY visitors DESC LIMIT 21000';

// What readers do after a page. This SQL has no window functions (no lag or lead) and no joins, and
// IN only takes a written list, so the next page can't be found in one query. Instead: the first query
// lists the visits that viewed the page in both periods, by the first 12 characters of their ID (48 bits,
// so two visits of one site sharing them is vanishingly rare). Ordered by ID, which is a hash, the first
// ones are a random sample. The second query reads every page view of up to keep of those visits per
// period, and the Worker pairs each view of the page with the one after it (pairNext). keep is what fits
// the SQL API's 10 KiB with the longest filters; rows is far more views than that many visits make.
export const NEXT = { keep: 250, both: 2000, rows: 10000 };
const VISIT_ID = `substring(${COL.visit}, 1, 12)`;

// only asks for one period, with one more than keep, which is enough to tell whether it had more.
export const nextVisitsSql = (ds, q, only) =>
  `SELECT ${PERIOD(q)} AS p, ${VISIT_ID} AS v FROM ${ds} WHERE ${within(q, only)} GROUP BY p, v ORDER BY v LIMIT ${only ? NEXT.keep + 1 : NEXT.both}`;

// ids must already be checked to be 12 hex characters (pickVisits does), since they go in as written.
export function nextRowsSql(ds, q, ids) {
  const all = { ...q, filters: { ...q.filters, path: null } };
  return `SELECT ${PERIOD(q)} AS p, ${VISIT_ID} AS v, ${COL.path} AS path, toUnixTimestamp(timestamp) AS t FROM ${ds} `
    + `WHERE ${within(all)} AND ${VISIT_ID} IN (${ids.map(id => `'${id}'`).join(', ')}) ORDER BY v, t LIMIT ${NEXT.rows}`;
}
