// What Lede's numbers mean against Cloudflare's free limits, and how much timings swing on unchanged code.
// `fium compare` judges a run (scripts/bench.mjs writes it in fium's format); this is what it can't know.

export const ABS_MS = 0.05, CEILING_MS = 5, MIN_REL = 0.05;

const median = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Seeded, so the same run always gets the same verdict.
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }
export function bootstrap(ratios, n = 2000) {
  const rand = rng(42), logs = ratios.map(Math.log), meds = [];
  for (let i = 0; i < n; i++) meds.push(median(logs.map(() => logs[(rand() * logs.length) | 0])));
  meds.sort((a, b) => a - b);
  return [Math.exp(meds[Math.floor(n * 0.025)]), Math.exp(meds[Math.ceil(n * 0.975) - 1])];
}

export const ratiosOf = (base, run) => run.map((x, i) => (base[i] > 0 ? x / base[i] : x > 0 ? 2 : 1));

// bench/noise.json from an A/A run: rel is twice the spread that unchanged code shows, never under 5%;
// abs is a gap in ms too small to count, whatever the ratio.
export function noiseFrom(aa) {
  const rel = {};
  for (const [k, b] of Object.entries(aa.base.times)) {
    const [lo, hi] = bootstrap(ratiosOf(b, aa.run.times[k]));
    rel[k] = Math.round(Math.max(MIN_REL, 2 * Math.max(hi - 1, 1 - lo)) * 1000) / 1000;
  }
  return { rel, abs: Object.fromEntries(Object.keys(rel).map(k => [k, ABS_MS])) };
}

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
