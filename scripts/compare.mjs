#!/usr/bin/env node
// Judges an A/B run from scripts/bench.mjs. Every number is lower-is-better.
//   bytes, counts   any increase is a regression
//   timings         judged on the paired ratios run/base, rep by rep. A bootstrap 95% range of their
//                   median decides: worse when the whole range is above 1 + REL and the medians differ
//                   by more than ABS ms, better when the whole range is below 1 - REL, inconclusive when
//                   the range crosses a threshold (rerun before believing it), same otherwise.
//                   REL per metric comes from bench/noise.json (an A/A run, see --noise), default 10%.
//   ceiling         a Worker answer over CEILING_MS fails whatever the base did: free Workers stop at
//                   10 ms of CPU.
// Exits 1 on any regression or a timing that's missing.
//   node scripts/compare.mjs [bench/runs/latest.json]
//   node scripts/compare.mjs --noise bench/runs/aa.json   writes bench/noise.json from an A/A run

import { readFileSync, writeFileSync } from 'node:fs';
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
    if (k.startsWith('worker:') && t.run > CEILING_MS) t.verdict = 'worse';
    rows.push({ metric: k, kind: 'ms', ...t });
  }
  return rows;
}

// From an A/A run: twice the spread that unchanged code shows, never under 5%.
export function noiseFrom(aa) {
  const out = {};
  for (const [k, b] of Object.entries(aa.base.times)) {
    const [lo, hi] = bootstrap(ratiosOf(b, aa.run.times[k]));
    out[k] = Math.round(Math.max(MIN_REL, 2 * Math.max(hi - 1, 1 - lo)) * 1000) / 1000;
  }
  return out;
}

// Headroom against the free limits: how many of each a day before Cloudflare stops serving.
export function headroom(counts) {
  const per = (limit, n) => (n > 0 ? Math.floor(limit / n).toLocaleString('en-US') : 'unlimited');
  return [
    `dashboard home loads a day before 10k queries: ${per(10000, counts['queries: /'])}`,
    `visits a day before 100k writes: ${per(100000, counts['visit: writes'])}`,
    `visits a day before 100k Worker requests: ${per(100000, counts['visit: requests'])}`,
    `visits a day before 1k KV writes: ${per(1000, counts['visit: kv writes'])}`,
  ];
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
  const unsure = rows.filter(r => r.verdict === 'inconclusive');
  console.log(`${rows.filter(r => r.verdict === 'better').length} better, ${bad.length} regression(s), ${unsure.length} inconclusive`);
  process.exit(bad.length ? 1 : 0);
}
