// What Lede's numbers mean against Cloudflare's free limits.
// `fium compare` judges a run (scripts/bench.mjs writes it in fium's format); this is what it can't know.

export const CEILING_MS = 5;

// What the schedules cost a day, whoever opens the dashboard: the spike check every 15 minutes, and the
// week's story once a week. Counts missing from an older run are taken as none.
const SPIKE_RUNS = 96, WEEK = 7;
export function scheduleDay(counts) {
  const day = what => SPIKE_RUNS * (counts[`cron: spikes ${what}`] ?? 0) + (counts[`cron: weekly ${what}`] ?? 0) / WEEK;
  return { queries: day('queries'), kvReads: day('kv reads'), kvWrites: day('kv writes'), ai: day('ai calls'), aiTokens: day('ai tokens') };
}

// The second line's sheet (src/insight.js) is built at most once an hour for each period opened, 7 and 30
// days, whoever loads home: a day's worst case for one site.
const SHEETS = 24 * 2;
export const sheetDay = counts => SHEETS * (counts['sheet queries: /'] ?? 0);

// Headroom against the free limits: how many of each a day before Cloudflare stops serving, after what
// the schedules take of the same allowance. Infinity when it costs none.
export function limits(counts) {
  const per = (limit, x) => (x > 0 ? Math.floor(limit / x) : Infinity);
  const day = scheduleDay(counts);
  return {
    'dashboard home loads a day before 10k queries': per(10000 - day.queries - sheetDay(counts), counts['queries: /']),
    'visits a day before 100k writes': per(100000, counts['visit: writes']),
    'visits a day before 100k Worker requests': per(100000, counts['visit: requests']),
    'visits a day before 1k KV writes': per(1000 - day.kvWrites, counts['visit: kv writes']),
  };
}

export function headroom(counts) {
  const n = x => (Math.round(x * 10) / 10).toLocaleString('en-US');
  const day = scheduleDay(counts);
  return [
    `the schedules a day: ${n(day.queries)} queries, ${n(day.kvReads)} KV reads, ${n(day.kvWrites)} KV writes, ${n(day.ai)} Workers AI asks`,
    `the second line's sheet a day at most, per site: ${n(sheetDay(counts))} queries`,
    ...Object.entries(limits(counts)).map(([k, v]) => `${k}: ${v === Infinity ? 'unlimited' : v.toLocaleString('en-US')}`),
    `KV writes a day left after the schedules: ${Math.floor(1000 - day.kvWrites).toLocaleString('en-US')}`,
  ];
}

// GOALS.md's floors. 50,000 page views a day is the README's promise; a floor moves only when
// Cloudflare's free limits do.
export const FLOORS = {
  'visits a day before 100k writes': 50000,
  'visits a day before 100k Worker requests': 50000,
  'dashboard home loads a day before 10k queries': 1000,
};

export function floors(counts) {
  const have = limits(counts);
  return Object.entries(FLOORS).filter(([k, min]) => have[k] < min)
    .map(([k, min]) => ({ metric: k, kind: 'floor', base: min, run: have[k], verdict: 'floor' }));
}
