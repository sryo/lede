import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factSheet, check, problem, insight, MODEL } from '../src/insight.js';
import { handleApi } from '../src/api.js';
import { runAlerts, WEEKLY, SUBREQUESTS } from '../src/alerts.js';
import { DEMO_INSIGHT } from '../src/demo.js';
import { readStory, tellStory } from '../public/story.js';

const DAY = 86400;
const START = Date.UTC(2026, 9, 21) / 1000;

// A week where Hacker News sent 220 more visitors, most of them to /pricing, which loads slowly.
const totals = { cur: { visitors: 1240, visits: 1500, views: 2000, bounce: .47 }, prev: { visitors: 1020, visits: 1300, views: 1800, bounce: .46 }, split: { cur: false, prev: false } };
const ser = { start: START, days: 7, cur: { visitors: [150, 160, 170, 400, 120, 120, 120] }, prev: { visitors: [146, 146, 146, 146, 146, 146, 144] },
  top: ['google.com', 'google.com', 'google.com', 'news.ycombinator.com', 'google.com', 'google.com', 'google.com'], topVisitors: [80, 80, 80, 260, 80, 80, 80] };
const row = (key, channel, visitors, prev, bounce) => ({ key, channel, visitors, visits: visitors, bounce, prev: { visitors: prev, visits: prev, bounce } });
const refs = { rows: [row('google.com', 'search', 600, 600, .3), row('news.ycombinator.com', 'social', 300, 80, .8), row('', 'direct', 340, 340, .4)] };
const pages = { rows: [{ key: '/', visitors: 700, prev: { visitors: 690 } }, { key: '/pricing', visitors: 400, prev: { visitors: 100 } }] };
const flows = { flows: [{ source: 'news.ycombinator.com', page: '/pricing', visitors: 250 }, { source: 'google.com', page: '/', visitors: 500 }],
  prev: [{ source: 'news.ycombinator.com', page: '/pricing', visitors: 40 }, { source: 'google.com', page: '/', visitors: 500 }] };
const engagement = { rows: [{ key: '/pricing', views: 120, median: 20000, lcp: 4700, inp: 560, cls: .09 }, { key: '/', views: 400, median: 130000, lcp: 1800, inp: 120, cls: .02 }] };
const keywords = { site: [{ key: 'pricing', visitors: 12, prev: 4 }], paid: [] };
const span = { now: 'this week', before: 'the week before' };
const S = readStory({ totals, ser, pages, refs, flows }), T = tellStory(S, ser, 7, span);
const facts = factSheet({ site: 'example.com', span, S, T, ser, pages, flows, engagement, keywords, notes: [{ day: '2026-10-24', text: 'Posted on Hacker News' }] });

test('the fact sheet holds totals, the sentence, sources, pages, landings, speed, words and notes, and no addresses', () => {
  assert.match(facts, /Total: 1,240 visitors; the week before: 1,020 \(\+220, \+22%\)/);
  assert.match(facts, /Summary the owner already reads: Hacker News sent .+/);
  assert.match(facts, /- Hacker News \(news\.ycombinator\.com\): 300; 80; \+220, \+275%; bounce 80%/);
  assert.match(facts, /- \/pricing: 400; 100/);
  assert.match(facts, /- Hacker News \(news\.ycombinator\.com\) → \/pricing: 250; 40/);
  assert.match(facts, /- \/pricing: 0m 20s; LCP 4\.7 s \(poor\), INP 560 ms \(poor\), CLS 0\.09 \(good\)/);
  assert.match(facts, /- \/: 2m 10s/);
  assert.match(facts, /“pricing” 12; 4/);
  assert.match(facts, /Sat, Oct 24: “Posted on Hacker News” \(400 visitors that day\)/);
  assert.doesNotMatch(facts, /https?:|visitor id/i);
});

test('a line that uses the facts, however it writes the numbers, passes', () => {
  assert.equal(problem('Most of Hacker News’s 300 visitors began on /pricing, where half left within 20 s and LCP is 4.7 s. Worth checking: what /pricing loads first.', facts), '');
  assert.ok(check('About 1.2k visitors came, 22% more, and readers of the home page stayed 2m 10s.', facts));
  assert.ok(check('1,240 visitors, and news.ycombinator.com sent 300 of them, mostly to /pricing.', facts));
  assert.ok(check('Hacker News readers bounced more (80%) after your note on Oct 24.', facts), '“after your note” is timing, not a cause');
  assert.ok(check('The home page held readers for 130 seconds.', facts), '2m 10s written in seconds');
});

test('a made-up number, page or site, a cause, or too long a line is turned down', () => {
  assert.match(problem('Hacker News sent 312 visitors to /pricing.', facts), /number that isn’t in the facts \(312\)/);
  assert.match(problem('About 1,200 visitors came.', facts), /number/, '1,200 is not 1,240 written another way');
  assert.match(problem('47 visitors bounced.', facts), /number/, '47 is only in the facts as a share');
  assert.match(problem('Readers of /blog stayed longest.', facts), /page that isn’t in the facts \(\/blog\)/);
  assert.match(problem('reddit.com sent more readers to /pricing.', facts), /site that isn’t in the facts \(reddit\.com\)/);
  assert.match(problem('See https://example.com/pricing for more.', facts), /address/);
  for (const why of ['because of your post', 'due to your post', 'which drove readers to it', 'thanks to your note', 'and that led to more sign-ups', 'which caused the rise'])
    assert.match(problem(`Hacker News sent 300 visitors to /pricing, ${why}.`, facts), /why something happened/, why);
  assert.match(problem('Hacker News sent 300 visitors. They landed on /pricing. Worth checking: /pricing.', facts), /more than two sentences/);
  assert.match(problem(`Hacker News sent 300 visitors to /pricing${', and so on'.repeat(30)}.`, facts), /over 280/);
  assert.equal(check('', facts), false);
});

test('insight asks Workers AI with the rules and the facts, reads either answer shape, and checks it', async () => {
  const asked = [];
  const env = answer => ({ AI: { run: async (model, input) => { asked.push({ model, input }); return answer; } } });
  assert.equal(await insight(env({ response: ' “Hacker News sent 300 visitors to /pricing.” ' }), facts), 'Hacker News sent 300 visitors to /pricing.');
  assert.equal(asked[0].model, MODEL);
  assert.equal(asked[0].input.max_tokens, 160);
  assert.match(asked[0].input.messages[0].content, /Never say why something happened/);
  assert.ok(asked[0].input.messages[1].content.endsWith(facts));
  assert.equal(await insight(env({ choices: [{ message: { content: 'Google sent 600 visitors.' } }] }), facts), 'Google sent 600 visitors.');
  assert.equal(await insight(env({ response: 'Nothing to add.' }), facts), null);
  const errors = [], error = console.error;
  console.error = m => errors.push(m);
  try {
    assert.equal(await insight(env({ response: 'Hacker News sent 999 visitors.' }), facts), null);
    assert.equal(await insight({}, facts), null, 'no binding');
  } finally { console.error = error; }
  assert.match(errors[0], /didn’t pass Lede’s checks \(it has a number that isn’t in the facts \(999\)\)/);
});

/* ---------- the route ---------- */

// The SQL API, answering by the shape of each query; k changes the totals, so each test has facts of its own.
function fakeSql(calls, k) {
  return async (endpoint, init) => {
    const sql = String(init.body);
    calls.push(sql);
    let data;
    if (sql.includes('AS landing')) data = [{ p: 1, src: 'news.ycombinator.com', landing: '/blog', visitors: '40' }, { p: 0, src: 'news.ycombinator.com', landing: '/blog', visitors: '10' }];
    else if (sql.includes('AS d, count(DISTINCT visitor)')) data = [{ p: 1, d: '3', visitors: '50', visits: '60', views: '90', bounces: '30', total_time: '1200' }, { p: 0, d: '1', visitors: '30', visits: '30', views: '30', bounces: '20', total_time: '0' }];
    else if (sql.includes('AS ref')) data = [{ d: '3', ref: 'news.ycombinator.com', visitors: '40' }];
    else if (sql.includes('AS key')) data = [{ p: 1, key: 'news.ycombinator.com', visitors: '70', visits: '80', views: '120', bounces: '20', total_time: '300', d: '2' }, { p: 0, key: 'news.ycombinator.com', visitors: '20', visits: '20', views: '20', bounces: '10', total_time: '0' }];
    else data = [{ p: 1, visitors: String(100 + k), visits: '120', views: '240', bounces: '60', total_time: '6000', sampled: '0' }, { p: 0, visitors: '50', visits: '60', views: '120', bounces: '30', total_time: '3000', sampled: '0' }];
    return new Response(JSON.stringify({ meta: [], data, rows: data.length }), { status: 200 });
  };
}
function memoryKV(init = {}) {
  const m = new Map(Object.entries(init));
  const kv = { puts: [], get: async key => m.get(key) ?? null, put: async (key, v, opts) => { kv.puts.push({ key, v, opts }); m.set(key, v); } };
  return kv;
}
async function withSql(k, fn) {
  const calls = [], real = globalThis.fetch;
  globalThis.fetch = fakeSql(calls, k);
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}
const ENV = () => ({ ACCOUNT_ID: 'acc', ANALYTICS_TOKEN: 'tok', STORE: memoryKV({ sites: '["example.com"]' }) });
const get = (path, env) => handleApi(new Request(`https://worker.test/api/${path}`), env, { waitUntil() {} });
const HOME = ['summary', 'series', 'breakdown&dim=path', 'breakdown&dim=referrer', 'flows'];

test('without Workers AI there is no line: 204, no query, and the dashboard isn’t told to ask', async () => {
  await withSql(1, async calls => {
    const env = ENV();
    const res = await get('insight?days=7&n=none', env);
    assert.equal(res.status, 204);
    assert.equal(calls.length, 0);
    assert.equal((await (await get('sites', env)).json()).insight, false);
    assert.equal((await (await get('sites', { ...env, AI: { run() {} } })).json()).insight, true);
  });
});

test('the demo answers its own line and never asks Workers AI', async () => {
  const env = { DEMO: 'true', STORE: memoryKV({ sites: '["example.com"]' }), AI: { run() { throw new Error('the demo asks nothing'); } } };
  const res = await get('insight?days=30', env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: DEMO_INSIGHT });
});

test('after home, the line costs no query; the same facts ask Workers AI once, and it is kept in KV for 6 hours', async () => {
  await withSql(2, async calls => {
    let runs = 0;
    const env = { ...ENV(), AI: { run: async (model, { messages }) => { runs++; assert.match(messages[1].content, /Hacker News/); return { response: 'Hacker News sent 40 visitors to /blog. Worth checking: /blog.' }; } } };
    const qs = 'site=example.com&days=7&tz=0&tzName=UTC';
    await Promise.all(HOME.map(r => get(`${r.replace('&', `?${qs}&`)}${r.includes('&') ? '' : `?${qs}`}`, env)));
    const home = calls.length;
    const res = await get(`insight?${qs}`, env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: 'Hacker News sent 40 visitors to /blog. Worth checking: /blog.' });
    assert.equal(calls.length, home, 'every answer it needs was just asked for by home');
    assert.equal(runs, 1);
    assert.match(env.STORE.puts[0].key, /^insight:example\.com:[0-9a-f]{64}$/);
    assert.equal(env.STORE.puts[0].opts.expirationTtl, 21600);
    // Another address (its own queries) with the same facts: the kept line, and no second ask.
    assert.equal((await get(`insight?${qs}&n=again`, env)).status, 200);
    assert.equal(runs, 1);
  });
});

test('Workers AI out of Neurons (3036) gives 204 and one log line that says what to do', async () => {
  await withSql(3, async () => {
    const errors = [], error = console.error;
    console.error = m => errors.push(m);
    try {
      const env = { ...ENV(), AI: { run: async () => { throw new Error('3036: You have used up your daily free allocation of 10,000 neurons.'); } } };
      assert.equal((await get('insight?days=7&n=quota', env)).status, 204);
      assert.equal((await get('insight?days=30&n=quota', env)).status, 204);
      assert.equal(env.STORE.puts.length, 0, 'nothing is kept');
    } finally { console.error = error; }
    assert.equal(errors.length, 1, 'once a day');
    assert.match(errors[0], /used up \(3036\).+until 00:00 UTC/);
  });
});

test('the weekly message adds the line after the sentence, and counts the Workers AI request', async () => {
  const week = async sites => {
    const sent = [], sql = [];
    let runs = 0;
    const fetchImpl = async (url, init = {}) => {
      if (String(url).endsWith('/analytics_engine/sql')) return fakeSql(sql, 4)(url, init);
      sent.push(init.body);
      return new Response('ok');
    };
    const env = { ...ENV(), STORE: memoryKV({ sites: JSON.stringify(sites) }), ALERT_WEBHOOK: 'https://ntfy.sh/t',
      AI: { run: async () => { runs++; return { response: 'Hacker News sent 40 visitors to /blog.' }; } } };
    await runAlerts(WEEKLY, env, Date.UTC(2026, 9, 26, 8) + 7 * DAY, fetchImpl);
    return { sent, sql, runs };
  };
  const one = await week(['example.com']);
  assert.equal(one.runs, 1);
  assert.equal(one.sent[0].split('\n')[2], 'Hacker News sent 40 visitors to /blog.');
  const many = await week(Array.from({ length: 10 }, (_, i) => `site${i}.example.com`));
  assert.ok(many.sql.length + many.runs + many.sent.length <= SUBREQUESTS, 'the Workers AI requests count against the schedule’s 50');
  assert.match(many.sent.at(-1), /Too many sites for one message/);
});
