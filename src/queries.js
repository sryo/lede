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
export const LISTS = { breakdown: { keep: 100, both: 1000 }, flows: { keep: 10000, both: 20000 }, pages: { keep: 200, both: 2000 } };
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

// sampled: visits with any sampled view (each such row stands for more than one, so w > n).
export const summarySql = (ds, q) =>
  `SELECT p, ${METRICS}, countIf(w > n) AS sampled FROM ${visits(ds, within(q), '', PERIOD(q))} GROUP BY p`;

// d counts days from the start of the previous period, by the day each visit started.
export const seriesSql = (ds, q) =>
  `SELECT p, ${dayOf('t0', bothDays(q))} AS d, ${METRICS} FROM ${visits(ds, within(q), ', toUnixTimestamp(min(timestamp)) AS t0', PERIOD(q))} `
  + 'GROUP BY p, d ORDER BY p, d';

export const topSourceSql = (ds, q) =>
  `SELECT ${dayOf('toUnixTimestamp(timestamp)', curDays(q))} AS d, ${COL.referrer} AS ref, count(DISTINCT ${COL.visitor}) AS visitors `
  + `FROM ${ds} WHERE ${where(q, q.start, q.end)} GROUP BY d, ref ORDER BY d, visitors DESC LIMIT 10000`;

export function breakdownSql(ds, q, dim, only) {
  if (dim === 'path') {
    return `SELECT ${PERIOD(q)} AS p, ${COL.path} AS key, count(DISTINCT ${COL.visitor}) AS visitors, count(DISTINCT ${COL.visit}) AS visits, sum(_sample_interval) AS views `
      + `FROM ${ds} WHERE ${within(q, only)} GROUP BY p, key ORDER BY visitors DESC ${limit(LISTS.breakdown, only)}`;
  }
  return `SELECT p, key, ${METRICS} FROM ${visits(ds, within(q, only), `, ${VISIT_KEYS[dim]} AS key`, PERIOD(q))} `
    + `GROUP BY p, key ORDER BY visitors DESC ${limit(LISTS.breakdown, only)}`;
}

// Visits by the source they came from, and how many of them viewed any of the goal pages.
export const conversionsSql = (ds, q, from, to, goals) =>
  `SELECT src, count() AS visits, sum(hit) AS reached FROM ${visits(ds, where(q, from, to), `, ${VISIT_KEYS.referrer} AS src, `
  + `max(if(${goals.map(g => `hex(${COL.path}) = '${hexOf(g)}'`).join(' OR ')}, 1, 0)) AS hit`)} GROUP BY src ORDER BY visits DESC LIMIT 200`;

// Visitors by the source a visit came from and the page it landed on, for the Sankey.
export const flowSql = (ds, q, only) =>
  `SELECT p, src, landing, count(DISTINCT visitor) AS visitors FROM ${visits(ds, within(q, only), `, ${VISIT_KEYS.referrer} AS src, ${VISIT_KEYS.entry} AS landing`, PERIOD(q))} `
  + `GROUP BY p, src, landing ORDER BY visitors DESC ${limit(LISTS.flows, only)}`;

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

// The day each page or source was first seen in the period, for marking new ones on the timeline.
export const firstSeenSql = (ds, q, dim) =>
  `SELECT ${COL[dim]} AS key, ${dayOf('toUnixTimestamp(min(timestamp))', curDays(q))} AS d, count(DISTINCT ${COL.visitor}) AS visitors `
  + `FROM ${ds} WHERE ${where(q, q.start, q.end)} GROUP BY key ORDER BY visitors DESC LIMIT 200`;

// Per page: page views that sent an engagement event (n), and their engaged milliseconds and scroll
// percentages summed, each weighted by the views a sampled row stands for. Averages are taken in shape.js.
// For one page it also counts the views that got at least 10%, 20%... 100% of the way down (r10...r100),
// so the page's view can show where readers stop without a query of its own.
export const BANDS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
export const engagementSql = (ds, q, only) =>
  `SELECT ${PERIOD(q)} AS p, ${COL.path} AS key, sum(_sample_interval) AS n, sum(_sample_interval * ${COL.engaged}) AS ms, sum(_sample_interval * ${COL.scroll}) AS depth`
  + (q.filters.path == null ? '' : BANDS.map(d => `, sumIf(_sample_interval, ${COL.scroll} >= ${d}) AS r${d}`).join(''))
  + ` FROM ${ds} WHERE ${within(q, only, ['engagement'])} GROUP BY p, key ORDER BY n DESC ${limit(LISTS.pages, only)}`;

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
// SQL here can't pull one parameter out of an address, so the query finds the page views whose address
// holds one and sends each address once per visitor; shape.js reads the words and counts each visitor once.
// Rows past the limit are dropped, which only a site with tens of thousands of searches a period reaches.
const SEARCHED = SEARCH_PARAMS.flatMap(p => [`position('?${p}=' IN ${COL.url}) > 0`, `position('&${p}=' IN ${COL.url}) > 0`]).join(' OR ');
export const siteSearchSql = (ds, q) =>
  `SELECT ${PERIOD(q)} AS p, ${COL.url} AS url, ${COL.visitor} AS visitor FROM ${ds} WHERE ${within(q)} AND (${SEARCHED}) `
  + 'GROUP BY p, url, visitor LIMIT 20000';

// Visitors per ad keyword (utm_term on the page a visit landed on).
export const paidWordsSql = (ds, q) =>
  `SELECT ${PERIOD(q)} AS p, ${COL.utmTerm} AS key, count(DISTINCT ${COL.visitor}) AS visitors FROM ${ds} `
  + `WHERE ${within(q)} AND ${COL.utmTerm} != '' GROUP BY p, key ORDER BY visitors DESC LIMIT 1000`;
