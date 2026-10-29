import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, timing, noiseFrom, headroom, scheduleDay, sheetDay, limits, floors, exitCode, parseAccepted, since } from '../scripts/compare.mjs';
import { counters, fakeAI, fakeFetch, WEBHOOK } from '../bench/fakes.mjs';
import { baselineRef } from '../scripts/bench.mjs';

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

test('any byte or count increase is a regression, and a Worker answer over 5 ms is below a floor', () => {
  const rows = compare({
    base: side({ 'worker: summary': reps(4), 'browser: home drawn': reps(100) }),
    run: side({ 'worker: summary': reps(5.5), 'browser: home drawn': reps(100) }, { bytes: { 't.js gzip': 101 }, counts: { 'queries: /': 9 } }),
  });
  const v = Object.fromEntries(rows.map(r => [r.metric, r.verdict]));
  assert.deepEqual(v, { 't.js gzip': 'worse', 'queries: /': 'better', 'worker: summary': 'floor', 'browser: home drawn': 'same' });
});

test('a run below a floor fails even when the base was just as low', () => {
  const counts = { 'queries: /': 8, 'visit: writes': 3, 'visit: requests': 2, 'visit: kv writes': 0 };
  const rows = compare({ base: side({}, { counts }), run: side({}, { counts }) });
  assert.deepEqual(rows.filter(r => r.verdict === 'floor').map(r => [r.metric, r.run]), [['visits a day before 100k writes', 33333]]);
  assert.equal(exitCode(rows), 1);
  assert.deepEqual(floors({ ...counts, 'visit: writes': 2 }), [], 'two writes a visit is the promise, exactly');
  assert.deepEqual(floors({ ...counts, 'visit: writes': 2, 'queries: /': 11 }).map(r => r.metric), ['dashboard home loads a day before 10k queries']);
});

test('what costs nothing has no limit', () => {
  assert.equal(limits({ 'queries: /': 0, 'visit: writes': 2, 'visit: requests': 2, 'visit: kv writes': 0 })['visits a day before 1k KV writes'], Infinity);
});

test('a run whose only doubt is an inconclusive timing exits 3, to be rerun; a regression or floor exits 1', () => {
  assert.equal(exitCode([{ verdict: 'same' }, { verdict: 'better' }, { verdict: 'new' }]), 0);
  assert.equal(exitCode([{ verdict: 'same' }, { verdict: 'inconclusive' }]), 3);
  assert.equal(exitCode([{ verdict: 'inconclusive' }, { verdict: 'worse' }]), 1);
  assert.equal(exitCode([{ verdict: 'missing' }]), 1);
  assert.equal(exitCode([{ verdict: 'floor' }]), 1);
});

test('a Bench-Accepted price is read whatever the arrow, commas or colons in the metric', () => {
  const p = parseAccepted([
    'Bench-Accepted: sheet queries: /; 0 -> 2; buys: goal 1; tried: hourly; owner: yes, 2026-10-28',
    'dashboard brotli; 115,973 → 118,230; buys: goal 3',
    'not a price',
    '',
  ].join('\n'));
  assert.deepEqual(p.map(({ metric, before, after }) => [metric, before, after]), [['sheet queries: /', 0, 2], ['dashboard brotli', 115973, 118230]]);
});

test('since a baseline, growth no price covers is unpriced; savings and priced growth are not', () => {
  const from = { bytes: { 'dashboard brotli': 100, 't.js gzip': 50 }, counts: { 'queries: /': 8, 'sheet queries: /': 0 } };
  const to = { bytes: { 'dashboard brotli': 130, 't.js gzip': 48 }, counts: { 'queries: /': 8, 'sheet queries: /': 2 } };
  const rows = since(from, to, parseAccepted('sheet queries: /; 0 -> 2\ndashboard brotli; 100 -> 110'));
  assert.deepEqual(rows.map(r => [r.metric, r.unpriced, r.priced.length]), [
    ['dashboard brotli', true, 1],
    ['t.js gzip', false, 0],
    ['sheet queries: /', false, 1],
  ]);
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
    'the schedules a day: 0 queries, 0 KV reads, 0 KV writes, 0 Workers AI asks',
    'the second line\'s sheet a day at most, per site: 0 queries',
    'dashboard home loads a day before 10k queries: 1,000',
    'visits a day before 100k writes: 50,000',
    'visits a day before 100k Worker requests: 50,000',
    'visits a day before 1k KV writes: unlimited',
    'KV writes a day left after the schedules: 1,000',
  ]);
});

test('the schedules cost every day: 96 spike checks and a seventh of the week\'s story', () => {
  const counts = { 'cron: spikes queries': 2, 'cron: spikes kv reads': 1, 'cron: spikes kv writes': 0, 'cron: spikes ai calls': 0, 'cron: spikes ai tokens': 0,
    'cron: weekly queries': 14, 'cron: weekly kv reads': 7, 'cron: weekly kv writes': 7, 'cron: weekly ai calls': 2, 'cron: weekly ai tokens': 700 };
  assert.deepEqual(scheduleDay(counts), { queries: 194, kvReads: 97, kvWrites: 1, ai: 2 / 7, aiTokens: 100 });
  const lines = headroom({ ...counts, 'queries: /': 8, 'visit: writes': 2, 'visit: requests': 2, 'visit: kv writes': 0 });
  assert.equal(lines[0], 'the schedules a day: 194 queries, 97 KV reads, 1 KV writes, 0.3 Workers AI asks');
  assert.equal(lines[2], 'dashboard home loads a day before 10k queries: 1,225');
  assert.equal(lines.at(-1), 'KV writes a day left after the schedules: 999');
});

test('the second line\'s sheet is counted at most once an hour per period, not on every home load', () => {
  const counts = { 'queries: /': 8, 'sheet queries: /': 2, 'visit: writes': 2, 'visit: requests': 2, 'visit: kv writes': 0, 'cron: spikes queries': 2 };
  assert.equal(sheetDay(counts), 96, '24 builds a day for each of the 7 and 30 days');
  const lines = headroom(counts);
  assert.equal(lines[1], 'the second line\'s sheet a day at most, per site: 96 queries');
  assert.equal(lines[2], 'dashboard home loads a day before 10k queries: 1,214');
});

test('the Workers AI stand-in counts each ask and about how many tokens it sends', async () => {
  const count = counters(), ai = fakeAI(count);
  await ai.run('@cf/model', { messages: [{ role: 'system', content: 'x'.repeat(40) }, { role: 'user', content: 'y'.repeat(9) }], max_tokens: 160 });
  assert.equal(count.ai, 1);
  assert.equal(count.aiTokens, 13, 'a token for every 4 characters, rounded up');
});

test('a message to the alert webhook is counted, not refused', async () => {
  const count = counters(), res = await fakeFetch(count)(WEBHOOK, { method: 'POST', body: 'hi' });
  assert.equal(res.ok, true);
  assert.equal(count.webhooks, 1);
});

test('the bench measures against the commit a saved baseline was taken at', () => {
  assert.equal(baselineRef({ run: { rev: '64b0ea0' } }, 'a1f2474'), '64b0ea0');
  assert.equal(baselineRef({ run: { rev: '64b0ea0+dirty' } }, 'a1f2474'), 'a1f2474', 'saved from uncommitted code, so the commit that recorded it');
  assert.throws(() => baselineRef({ run: { rev: 'unknown' } }, ''), /--base/);
});
