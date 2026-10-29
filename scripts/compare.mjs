#!/usr/bin/env node
// Judges an A/B run from scripts/bench.mjs. Every number is lower-is-better.
//   bytes, counts   any increase is a regression
//   timings         judged on the paired ratios run/base, rep by rep. A bootstrap 95% range of their
//                   median decides: worse when the whole range is above 1 + REL and the medians differ
//                   by more than ABS ms, better when the whole range is below 1 - REL, inconclusive when
//                   the range crosses a threshold (rerun before believing it), same otherwise.
//                   REL per metric comes from bench/noise.json (an A/A run, see --noise), default 10%.
//   floors          GOALS.md's floors, "Free to run" in numbers: a run below one fails whatever the base
//                   did, and no Bench-Accepted price lets it through. A small site's Worker answer over
//                   CEILING_MS is one: free Workers stop at 10 ms of CPU.
// Exits 1 on any regression, floor or missing timing; 3 when the only doubt is an inconclusive timing,
// which is rerun before the change lands.
//   node scripts/compare.mjs [bench/runs/latest.json]
//   node scripts/compare.mjs --noise bench/runs/aa.json   writes bench/noise.json from an A/A run
//   node scripts/compare.mjs --since main                 what changed since main's baseline, and its prices

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REL = 0.10, ABS_MS = 0.05, CEILING_MS = 5, MIN_REL = 0.05;

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

export function timing(base, run, rel = REL) {
  const b = median(base), r = median(run), ratios = ratiosOf(base, run);
  const ratio = median(ratios), [lo, hi] = bootstrap(ratios);
  let verdict = 'same';
  if (Math.abs(r - b) > ABS_MS) {
    if (lo > 1 + rel) verdict = 'worse';
    else if (hi < 1 - rel) verdict = 'better';
    else if (hi > 1 + rel || lo < 1 - rel) verdict = 'inconclusive';
  }
  return { base: b, run: r, ratio, lo, hi, verdict };
}

export function compare(ab, noise = {}) {
  const rows = [];
  for (const group of ['bytes', 'counts']) {
    for (const k of new Set([...Object.keys(ab.base[group]), ...Object.keys(ab.run[group])])) {
      const b = ab.base[group][k], r = ab.run[group][k];
      rows.push({ metric: k, kind: group, base: b, run: r,
        verdict: b == null ? 'new' : r == null ? 'missing' : r > b ? 'worse' : r < b ? 'better' : 'same' });
    }
  }
  for (const k of new Set([...Object.keys(ab.base.times), ...Object.keys(ab.run.times)])) {
    const b = ab.base.times[k], r = ab.run.times[k];
    if (!b || !r) { rows.push({ metric: k, kind: 'ms', verdict: b ? 'missing' : 'new' }); continue; }
    const t = timing(b, r, noise[k] ?? REL);
    if (k.startsWith('worker:') && t.run > CEILING_MS) t.verdict = 'floor';
    rows.push({ metric: k, kind: 'ms', ...t });
  }
  return [...rows, ...floors(ab.run.counts)];
}

export const exitCode = rows => rows.some(r => ['worse', 'missing', 'floor'].includes(r.verdict)) ? 1
  : rows.some(r => r.verdict === 'inconclusive') ? 3 : 0;

// From an A/A run: twice the spread that unchanged code shows, never under 5%.
export function noiseFrom(aa) {
  const out = {};
  for (const [k, b] of Object.entries(aa.base.times)) {
    const [lo, hi] = bootstrap(ratiosOf(b, aa.run.times[k]));
    out[k] = Math.round(Math.max(MIN_REL, 2 * Math.max(hi - 1, 1 - lo)) * 1000) / 1000;
  }
  return out;
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

/* ---------- prices ---------- */

// A Bench-Accepted trailer (GOALS.md): "<metric>; <before> -> <after>; buys: …". Metric names hold colons,
// so the fields are split at semicolons.
export function parseAccepted(text) {
  const num = s => Number(s.replace(/,/g, ''));
  return text.split('\n').map(line => line.trim()).map(line => {
    const m = line.replace(/^Bench-Accepted:\s*/i, '').match(/^(.+?);\s*([\d.,]+)\s*(?:->|→)\s*([\d.,]+)/);
    return m && { metric: m[1].trim(), before: num(m[2]), after: num(m[3]), line };
  }).filter(Boolean);
}

// What changed between two baselines, with the prices paid for it. Bytes and counts come out the same on
// every run, so the net change is exact; timings only compare within one run, so they're left out.
// Growth past what the prices for that metric add up to is unpriced.
export function since(from, to, accepted = []) {
  const rows = [];
  for (const group of ['bytes', 'counts']) {
    for (const k of new Set([...Object.keys(from[group] || {}), ...Object.keys(to[group] || {})])) {
      const a = from[group]?.[k], b = to[group]?.[k];
      if (a === b) continue;
      const priced = accepted.filter(p => p.metric === k);
      const paid = priced.reduce((s, p) => s + Math.max(0, p.after - p.before), 0);
      rows.push({ metric: k, from: a, to: b, priced, unpriced: a != null && b != null && b - a > paid });
    }
  }
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--noise') {
    const aa = JSON.parse(readFileSync(resolve(ROOT, args[1] || 'bench/runs/aa.json'), 'utf8'));
    const noise = noiseFrom(aa);
    writeFileSync(resolve(ROOT, 'bench/noise.json'), JSON.stringify(noise, null, 2) + '\n');
    for (const [k, v] of Object.entries(noise)) console.log(`${k.padEnd(34)} ±${(v * 100).toFixed(1)}%`);
    process.exit(0);
  }
  if (args[0] === '--since') {
    const ref = args[1] || 'main';
    const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
    let from;
    try { from = JSON.parse(git('show', `${ref}:bench/baseline.json`)).run; } catch { console.error(`${ref} has no bench/baseline.json`); process.exit(2); }
    const to = JSON.parse(readFileSync(resolve(ROOT, 'bench/baseline.json'), 'utf8')).run;
    const accepted = parseAccepted(git('log', '--format=%(trailers:key=Bench-Accepted,valueonly,unfold)', `${ref}..HEAD`));
    const rows = since(from, to, accepted);
    const n = v => v == null ? '-' : v.toLocaleString('en-US');
    console.log(`baseline at ${ref} (${from.rev}) → now (${to.rev}): ${accepted.length} price(s) accepted`);
    for (const r of rows) {
      const pct = r.from && r.to != null ? ` ${r.to > r.from ? '+' : ''}${(((r.to - r.from) / r.from) * 100).toFixed(1)}%` : '';
      console.log(`${(r.unpriced ? 'UNPRICED' : r.to < r.from ? 'BETTER' : 'PRICED').padEnd(12)} ${r.metric.padEnd(34)} ${n(r.from).padStart(10)} → ${n(r.to).padStart(10)}${pct}`);
      for (const p of r.priced) console.log(`             ${p.line}`);
    }
    const unpriced = rows.filter(r => r.unpriced).length;
    console.log(`${rows.length} changed, ${unpriced} unpriced`);
    process.exit(0);
  }
  const ab = JSON.parse(readFileSync(resolve(ROOT, args[0] || 'bench/runs/latest.json'), 'utf8'));
  if (!ab.base) { console.error('not an A/B run; rerun scripts/bench.mjs without --save-baseline'); process.exit(2); }
  let noise = {};
  try { noise = JSON.parse(readFileSync(resolve(ROOT, 'bench/noise.json'), 'utf8')); } catch {}
  const rows = compare(ab, noise);
  const fmt = (v, kind) => v == null ? '-' : kind === 'ms' ? v.toFixed(3) : String(v);
  console.log(`base ${ab.base.rev} vs run ${ab.run.rev} (${ab.browser}, ${ab.reps} reps)`);
  for (const r of rows) {
    const change = r.kind === 'ms' && r.ratio != null ? ` ${r.ratio >= 1 ? '+' : ''}${((r.ratio - 1) * 100).toFixed(1)}% [${((r.lo - 1) * 100).toFixed(0)}, ${((r.hi - 1) * 100).toFixed(0)}]`
      : r.base && r.run != null && r.base !== r.run ? ` ${r.run > r.base ? '+' : ''}${(((r.run - r.base) / r.base) * 100).toFixed(1)}%` : '';
    console.log(`${r.verdict.toUpperCase().padEnd(12)} ${r.metric.padEnd(34)} ${fmt(r.base, r.kind).padStart(10)} → ${fmt(r.run, r.kind).padStart(10)}${change}`);
  }
  for (const line of headroom(ab.run.counts)) console.log('  ' + line);
  const bad = rows.filter(r => ['worse', 'missing'].includes(r.verdict));
  const below = rows.filter(r => r.verdict === 'floor');
  const unsure = rows.filter(r => r.verdict === 'inconclusive');
  console.log(`${rows.filter(r => r.verdict === 'better').length} better, ${bad.length} regression(s), ${below.length} below a floor, ${unsure.length} inconclusive`);
  const code = exitCode(rows);
  if (code === 3) console.log('rerun before the change lands: npm run bench && npm run bench:compare');
  process.exit(code);
}
