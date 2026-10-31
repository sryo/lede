import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noiseFrom, headroom, scheduleDay, sheetDay, limits, floors } from '../scripts/headroom.mjs';
import { counters, fakeAI, fakeFetch, WEBHOOK } from '../bench/fakes.mjs';
import { baselineRef, houseOf, houseFiles, parseArgs } from '../scripts/bench.mjs';

const reps = (v, n = 15, jitter = 0.01) => Array.from({ length: n }, (_, i) => v * (1 + (i % 3 - 1) * jitter));

test('a run below a floor fails even when the base was just as low', () => {
  const counts = { 'queries: /': 8, 'visit: writes': 3, 'visit: requests': 2, 'visit: kv writes': 0 };
  assert.deepEqual(floors(counts).map(r => [r.metric, r.run]), [['visits a day before 100k writes', 33333]]);
  assert.deepEqual(floors({ ...counts, 'visit: writes': 2 }), [], 'two writes a visit is the promise, exactly');
  assert.deepEqual(floors({ ...counts, 'visit: writes': 2, 'queries: /': 11 }).map(r => r.metric), ['dashboard home loads a day before 10k queries']);
});

test('what costs nothing has no limit', () => {
  assert.equal(limits({ 'queries: /': 0, 'visit: writes': 2, 'visit: requests': 2, 'visit: kv writes': 0 })['visits a day before 1k KV writes'], Infinity);
});

test('the noise threshold is twice what unchanged code swings, at least 5%', () => {
  const n = noiseFrom({ base: { times: { calm: reps(10), wild: reps(10) } }, run: { times: { calm: reps(10), wild: reps(10).map((x, i) => x * (i % 2 ? 1.2 : 0.85)) } } });
  assert.equal(n.rel.calm, 0.05);
  assert.ok(n.rel.wild > 0.2);
  assert.equal(n.abs.wild, 0.05, 'a gap of 0.05 ms or less is too small to count');
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

test('the house run format names each number by kind, and floors and the Worker ceiling become limits', () => {
  const counts = { 'queries: /': 8, 'sheet queries: /': 2, 'ai tokens: /': 550, 'visit: writes': 2, 'visit: requests': 2, 'visit: kv writes': 0 };
  const h = houseOf({ rev: 'x', bytes: { 't.js gzip': 100 }, counts, times: { 'worker: summary': [1, 2], 'browser: home drawn': [90] } });
  assert.deepEqual(h.metrics['t.js gzip'], { dir: 'lower', kind: 'bytes', samples: [100] });
  assert.deepEqual(h.metrics['queries: /'], { dir: 'lower', kind: 'count', samples: [8] });
  assert.equal(h.metrics['ai tokens: /'].kind, 'tokens');
  assert.deepEqual(h.metrics['worker: summary'], { dir: 'lower', kind: 'time', samples: [1, 2] });
  assert.deepEqual(h.metrics['visits a day before 100k writes'], { dir: 'higher', kind: 'limit', samples: [50000] });
  assert.equal(h.limits['visits a day before 100k writes'], 50000);
  assert.equal(h.limits['dashboard home loads a day before 10k queries'], 1000);
  assert.equal(h.limits['worker: summary'], 5);
  assert.equal(h.limits['browser: home drawn'], undefined);
});

test('house files sit beside the run, and the bench\'s judging flags default to the latest run and main', () => {
  assert.deepEqual(houseFiles('bench/runs/latest.json'), { run: 'bench/runs/latest.house.json', base: 'bench/runs/latest.house-base.json' });
  assert.equal(parseArgs(['--compare']).compare, 'bench/runs/latest.json');
  assert.equal(parseArgs(['--since']).since, 'main');
  assert.equal(parseArgs(['--since', 'next']).since, 'next');
  assert.equal(parseArgs(['--noise']).noise, 'bench/runs/aa.json');
});
