// Turns raw aggregate rows (from SQL or the demo store) into the JSON the dashboard reads.
// The SQL API returns 64-bit counts as strings, hence the Number() everywhere.

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

// sampled: Analytics Engine kept only a sample of some of this period's views.
export function toSummary(rows) {
  const { cur: [cur = NONE], prev: [prev = NONE] } = byPeriod(rows);
  return { cur: metrics(cur), prev: metrics(prev), sampled: num(cur.sampled) > 0 };
}

// first: the day rows count from, when d doesn't start at this period's first day.
export function toSeries(rows, days, first = 0) {
  const out = { visitors: [], visits: [], views: [], bounce: [], duration: [] };
  const byDay = new Map(rows.map(r => [num(r.d) - first, metrics(r)]));
  const empty = metrics({ bounces: 0, total_time: 0 });
  for (let d = 0; d < days; d++) {
    const m = byDay.get(d) || empty;
    for (const k in out) out[k].push(m[k]);
  }
  return out;
}

// rows are ordered by day, then visitors descending, so the first row seen per day wins.
// Returns each day's top source and how many visitors it sent.
export function topByDay(rows, days) {
  const top = Array(days).fill(null), visitors = Array(days).fill(0);
  for (const r of rows) {
    const d = num(r.d);
    if (d >= 0 && d < days && top[d] === null) { top[d] = r.ref ?? ''; visitors[d] = num(r.visitors); }
  }
  return { top, topVisitors: visitors };
}

export const toFlows = rows => rows.map(r => ({ source: r.src ?? '', page: r.landing ?? '', visitors: num(r.visitors) }));

export function toConversions(rows) {
  const out = rows.map(r => ({ key: r.src ?? '', visits: num(r.visits), reached: num(r.reached) }));
  return { rows: out, visits: out.reduce((a, r) => a + r.visits, 0), reached: out.reduce((a, r) => a + r.reached, 0) };
}

export const toFirsts = rows => rows.map(r => ({ key: r.key ?? '', day: num(r.d), visitors: num(r.visitors) }));

export function toHourly(rows, days) {
  const out = Array(days * 24).fill(0);
  for (const r of rows) {
    const h = num(r.hr);
    if (h >= 0 && h < out.length) out[h] = num(r.visitors);
  }
  return out;
}

// Keys only seen in the previous period are kept with zero visitors, so a source that
// stopped sending anyone still shows up as a loss.
export function mergeRows(cur, prev) {
  const before = new Map(prev.map(r => [r.key ?? '', metrics(r)]));
  const rows = cur.map(r => ({ key: r.key ?? '', ...metrics(r), prev: before.get(r.key ?? '') || null }));
  const seen = new Set(rows.map(r => r.key));
  for (const [key, m] of before) if (!seen.has(key)) rows.push({ key, ...metrics({}), prev: m });
  return rows;
}

// Both periods' days from one set of rows, where d counts from the start of the previous period.
export function toSeriesBoth(rows, days) {
  const { cur, prev } = byPeriod(rows);
  return { cur: toSeries(cur, days, days), prev: toSeries(prev, days) };
}

export function shapeLive(rows, nowSec) {
  const visitors = rows.map(r => ({
    path: r.path,
    referrer: r.referrer ?? '',
    country: r.country ?? '',
    seconds: num(r.last) - num(r.first),
    ago: nowSec - num(r.last),
    active: nowSec - num(r.last) < 300,
  }));
  return { now: visitors.filter(v => v.active).length, recent: visitors.length, visitors };
}

// Engagement rows carry sums (see engagementSql). Each page gets the page views that sent one, how many
// seconds they were read on average, and how far down, as a share of the page.
const reading = r => {
  const n = num(r.n);
  return { views: n, time: n ? num(r.ms) / n / 1000 : 0, scroll: n ? num(r.depth) / n / 100 : 0 };
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
