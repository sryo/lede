// Runs Lede's schedules on one copy, with the counting stand-ins and an alert webhook set (nothing is read
// without one), and prints what one run of each costs. The first spike check also finds when each site's data
// starts, which happens once, so the second one is counted. The fixed rows have no crowd, so no spike message.
//   node bench/cron.mjs --root <dir>      prints {"cron: spikes queries": N, …}

import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { counters, benchEnv, fakeFetch, NOW, WEBHOOK } from './fakes.mjs';

const argv = process.argv.slice(2);
const root = resolve(argv[argv.indexOf('--root') + 1]);

const count = counters();
globalThis.fetch = fakeFetch(count);
const worker = (await import(pathToFileURL(join(root, 'src/index.js')).href)).default;
const env = { ...benchEnv(count), ALERT_WEBHOOK: WEBHOOK };

async function run(cron, scheduledTime) {
  for (const k in count) count[k] = 0;
  const waits = [];
  await worker.scheduled({ cron, scheduledTime }, env, { waitUntil: p => waits.push(p) });
  await Promise.allSettled(waits);
  return { ...count };
}

const QUARTER = 900_000, start = Math.floor(NOW * 1000 / QUARTER) * QUARTER;
await run('*/15 * * * *', start);
const out = {};
for (const [name, c] of [['spikes', await run('*/15 * * * *', start + QUARTER)], ['weekly', await run('0 8 * * 1', start + 2 * QUARTER)]]) {
  out[`cron: ${name} queries`] = c.sql;
  out[`cron: ${name} kv reads`] = c.kvReads;
  out[`cron: ${name} kv writes`] = c.kvWrites;
  out[`cron: ${name} kv lists`] = c.kvLists;
  out[`cron: ${name} ai calls`] = c.ai;
  out[`cron: ${name} ai tokens`] = c.aiTokens;
  out[`cron: ${name} webhooks`] = c.webhooks;
}
console.log(JSON.stringify(out));
