import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, timing, noiseFrom, headroom } from '../scripts/compare.mjs';

const side = (times, extra = {}) => ({ rev: 'x', bytes: { 't.js gzip': 100 }, counts: { 'queries: /': 10 }, times, ...extra });
const reps = (v, n = 15, jitter = 0.01) => Array.from({ length: n }, (_, i) => v * (1 + (i % 3 - 1) * jitter));

test('a timing is worse only when its whole range is past the threshold and the gap is real', () => {
  assert.equal(timing(reps(10), reps(13)).verdict, 'worse');
  assert.equal(timing(reps(10), reps(7)).verdict, 'better');
  assert.equal(timing(reps(10), reps(10.3)).verdict, 'same');
  assert.equal(timing(reps(0.01), reps(0.03)).verdict, 'same', 'a tiny absolute gap is noise');
});

test('a timing that swings across the threshold is inconclusive, not a pass or a fail', () => {
  const base = reps(10, 15, 0), run = Array.from({ length: 15 }, (_, i) => (i % 2 ? 13 : 9.6));
  assert.equal(timing(base, run).verdict, 'inconclusive');
});

test('any byte or count increase is a regression, and a Worker answer over 5 ms fails on its own', () => {
  const rows = compare({
    base: side({ 'worker: summary': reps(4), 'browser: home drawn': reps(100) }),
    run: side({ 'worker: summary': reps(5.5), 'browser: home drawn': reps(100) }, { bytes: { 't.js gzip': 101 }, counts: { 'queries: /': 9 } }),
  });
  const v = Object.fromEntries(rows.map(r => [r.metric, r.verdict]));
  assert.deepEqual(v, { 't.js gzip': 'worse', 'queries: /': 'better', 'worker: summary': 'worse', 'browser: home drawn': 'same' });
});

test('a timing that only one side has is missing or new', () => {
  const rows = compare({ base: side({ a: reps(1) }), run: side({ b: reps(1) }) });
  assert.deepEqual(rows.filter(r => r.kind === 'ms').map(r => [r.metric, r.verdict]), [['a', 'missing'], ['b', 'new']]);
});

test('the noise threshold is twice what unchanged code swings, at least 5%', () => {
  const n = noiseFrom({ base: { times: { calm: reps(10), wild: reps(10) } }, run: { times: { calm: reps(10), wild: reps(10).map((x, i) => x * (i % 2 ? 1.2 : 0.85)) } } });
  assert.equal(n.calm, 0.05);
  assert.ok(n.wild > 0.2);
});

test('headroom says how much a day fits in the free limits', () => {
  assert.deepEqual(headroom({ 'queries: /': 10, 'visit: writes': 2, 'visit: requests': 2, 'visit: kv writes': 0 }), [
    'dashboard home loads a day before 10k queries: 1,000',
    'visits a day before 100k writes: 50,000',
    'visits a day before 100k Worker requests: 50,000',
    'visits a day before 1k KV writes: unlimited',
  ]);
});
