import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factSheet, check, problem, insight, lineFor, hashOf, MODEL } from '../src/insight.js';
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
const engagement = { rows: [{ key: '/pricing', views: 120, median: 21000, lcp: 4740, inp: 563, cls: .09, lcpN: 100, inpN: 40, clsN: 100 },
  { key: '/', views: 400, median: 128000, lcp: 1800, inp: 120, cls: .02, lcpN: 300, inpN: 20, clsN: 300 }] };
const keywords = { site: [{ key: 'pricing', visitors: 12, prev: 4 }], paid: [] };
const span = { now: 'this week', before: 'the week before' };
const S = readStory({ totals, ser, pages, refs, flows }), T = tellStory(S, ser, 7, span);
const facts = factSheet({ site: 'example.com', span, S, T, ser, pages, flows, engagement, keywords, notes: [{ day: '2026-10-24', text: 'Posted on Hacker News' }] });

test('the sheet is candidates Lede worked out, each joining two kinds of facts, rounded, with no addresses', () => {
  assert.match(facts, /^Site: example\.com\. Compared: this week, against the week before\. Total: 1,200 visitors, 1,000 before\./);
  assert.match(facts, /Summary the owner already reads \(don’t repeat it\)|Summary the owner already reads \(don't repeat it\): Hacker News sent .+/);
  assert.match(facts, /\n\d\. Visits from Hacker News \(news\.ycombinator\.com\) that began on \/pricing: 250 visitors this week, 40 the week before; \/pricing had 400 visitors in all, 100 before\./, 'a source and where its visits began');
  assert.match(facts, /\. Visits from google\.com bounce 30%, against 47% for all visits; most of them began on \/, 500 visitors\./, 'a source that bounces unlike the site');
  assert.match(facts, /\. \/pricing: the slowest of the top pages to load, LCP 4\.7 s \(poor\), INP 560 ms \(poor\); readers stay 0m 20s/, 'speed and reading time; INP from 20 taps on / is too few');
  assert.match(facts, /\. “pricing” was searched on the site by 12 visitors this week, 4 the week before; \/pricing had 400 visitors/, 'a search word and the page it names');
  assert.match(facts, /\. After your note on Sat, Oct 24 \(“Posted on Hacker News”\): 400 visitors that day, against 150 on a usual day/);
  assert.doesNotMatch(facts, /https?:|visitor id/i);
  const quiet = factSheet({ site: 'example.com', span, S, T, ser, pages: { rows: [] }, flows: { flows: [], prev: [] } });
  assert.equal(quiet.includes('Candidates:'), true, 'the note still connects');
  assert.equal(factSheet({ site: 'example.com', span, S: { ...S, sources: [] }, T, ser: { ...ser, cur: { visitors: [0] } }, pages: { rows: [] }, flows: { flows: [], prev: [] } }), '', 'nothing to connect: no sheet, no ask');
});

test('a line backed by one candidate passes, however it writes the numbers', () => {
  assert.equal(problem('Visits from Hacker News that began on /pricing rose to 250 this week, from 40. Worth checking: what /pricing shows them first.', facts), '');
  assert.ok(check('/pricing is the slowest top page, LCP 4.7 s, and readers stay only 20 seconds.', facts));
  assert.ok(check('Visits from google.com bounce 30%, well under the 47% of all visits, and most began on /.', facts));
  assert.ok(check('Searches for “pricing” went from 4 to 12 visitors, and /pricing had about 400.', facts));
  assert.ok(check('After your note on Oct 24, about 400 visitors came that day, against 150 usually.', facts), '“after your note” is timing, not a cause');
});

test('a line that joins two candidates, or makes up a number, page or site, a cause, or runs long is turned down', () => {
  assert.match(problem('Hacker News visits began on /pricing, which loads in 4.7 s.', facts), /no one candidate backs it/, 'two true facts joined into one');
  assert.match(problem('Visits from google.com bounce 30% and began on /pricing.', facts), /no one candidate backs it/);
  assert.match(problem('Visits from Hacker News that began on /pricing: 312 this week.', facts), /number that isn’t in the facts \(312\)/);
  assert.match(problem('Visits from Hacker News that began on /pricing: about 1,240.', facts), /number/);
  assert.match(problem('Readers of /blog stayed longest.', facts), /page that isn’t in the facts \(\/blog\)/);
  assert.match(problem('reddit.com sent more readers to /pricing.', facts), /site that isn’t in the facts \(reddit\.com\)/);
  assert.match(problem('See https://example.com/pricing for more.', facts), /address/);
  for (const why of ['because of your post', 'due to your post', 'which drove readers to it', 'thanks to your note', 'and that led to more sign-ups', 'which caused the rise'])
    assert.match(problem(`Hacker News sent 250 visitors to /pricing, ${why}.`, facts), /why something happened/, why);
  assert.match(problem('Hacker News sent 250 visitors. They landed on /pricing. Worth checking: /pricing.', facts), /more than two sentences/);
  assert.match(problem(`Hacker News sent 250 visitors to /pricing${', and so on'.repeat(30)}.`, facts), /over 280/);
  assert.equal(check('', facts), false);
});

test('insight asks Workers AI with the rules and the facts, reads either answer shape, and checks it', async () => {
  const asked = [];
  const env = answer => ({ AI: { run: async (model, input) => { asked.push({ model, input }); return answer; } } });
  assert.equal(await insight(env({ response: ' 1. “Hacker News sent 250 visitors to /pricing.” ' }), facts), 'Hacker News sent 250 visitors to /pricing.', 'the candidate’s number is dropped');
  assert.equal(asked[0].model, MODEL);
  assert.equal(asked[0].input.max_tokens, 160);
  assert.match(asked[0].input.messages[0].content, /Never say why something happened/);
  assert.ok(asked[0].input.messages[1].content.endsWith(facts));
  assert.equal(await insight(env({ choices: [{ message: { content: 'google.com visits bounce 30%.' } }] }), facts), 'google.com visits bounce 30%.');
  assert.equal(await insight(env({ response: '“pricing” was searched by 12 visitors, and /pricing had 400.' }), facts), '“pricing” was searched by 12 visitors, and /pricing had 400.', 'a quoted word keeps its quotes');
  assert.equal(await insight(env({ response: 'Nothing to add.' }), facts), null);
  const errors = [], error = console.error;
  console.error = m => errors.push(m);
  try {
    assert.equal(await insight(env({ response: 'Hacker News sent 999 visitors.' }), facts), null);
    assert.equal(await insight({}, facts), null, 'no binding');
  } finally { console.error = error; }
  assert.match(errors[0], /didn’t pass Lede’s checks \(.*number that isn’t in the facts \(999\)/);
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

test('after home, the line adds only the reading, speed and search-word queries; the same facts ask Workers AI once, and the line is kept in KV per site and period', async () => {
  await withSql(2, async calls => {
    let runs = 0;
    const env = { ...ENV(), AI: { run: async (model, { messages }) => { runs++; assert.match(messages[1].content, /Hacker News/); return { response: 'Hacker News sent 40 visitors to /blog. Worth checking: /blog.' }; } } };
    const qs = 'site=example.com&days=7&tz=0&tzName=UTC';
    await Promise.all(HOME.map(r => get(`${r.replace('&', `?${qs}&`)}${r.includes('&') ? '' : `?${qs}`}`, env)));
    const home = calls.length;
    const res = await get(`insight?${qs}`, env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: 'Hacker News sent 40 visitors to /blog. Worth checking: /blog.' });
    assert.equal(calls.length - home, 2, 'reading and speed (1) and search words with ad keywords (1); the rest home just asked for');
    assert.equal(runs, 1);
    assert.equal(env.STORE.puts[0].key, 'insight:example.com:7');
    assert.equal(JSON.parse(env.STORE.puts[0].v).text, 'Hacker News sent 40 visitors to /blog. Worth checking: /blog.');
    assert.equal(env.STORE.puts[0].opts.expirationTtl, 86400);
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
      assert.deepEqual(env.STORE.puts.map(p => JSON.parse(p.v).text), [null, null], 'the try is kept, so it isn’t asked again on every load');
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

/* ---------- keeping a line ---------- */

test('a kept line is shown while it passes the checks; a new one is asked at most once an hour per site and period', async () => {
  const H = 3600_000, T0 = Date.UTC(2026, 9, 28, 9), errors = [], error = console.error;
  let runs = 0, answer = 'Hacker News sent 250 visitors to /pricing.';
  const env = { STORE: memoryKV(), AI: { run: async () => { runs++; return { response: answer }; } } };
  const ask = async (f, at) => lineFor(env, 'k1', f, T0 + at * H);
  const other = facts.replace('by 12 visitors', 'by 13 visitors');
  const no250 = other.replace('250 visitors this week', '260 visitors this week'), no30 = no250.replace('bounce 30%', 'bounce 31%');
  console.error = m => errors.push(m);
  let built = 0;
  const lazy = f => async () => (built++, f);
  try {
    assert.equal(await ask(facts, 0), answer);
    assert.deepEqual(JSON.parse(env.STORE.puts[0].v), { text: answer, hash: await hashOf(facts), at: T0, tried: T0 });
    assert.equal(await ask(lazy(other), .5), answer, 'within the hour the kept line stands');
    assert.equal(built, 0, 'and no sheet is built, so no query is made');
    assert.equal(await ask(lazy(other), 5), answer, 'new facts, but the line still holds and is under 6 hours old');
    assert.equal(built, 1);
    assert.equal(await ask(lazy(other), 5.5), answer, 'checked within the hour: no sheet again');
    assert.equal(built, 1);
    assert.equal(runs, 1);
    answer = 'google.com visits bounce 30%.';
    assert.equal(await ask(no250, 6.1), answer, 'the line no longer holds: asked again');
    assert.equal(runs, 2);
    assert.equal(await ask(no30, 6.5), answer, 'asked under an hour ago: the kept line stands');
    assert.equal(runs, 2);
    answer = 'google.com visits bounce 31%.';
    assert.equal(await ask(no30, 7.2), answer, 'an hour on, it no longer holds: asked again');
    assert.equal(await ask(no30, 14), answer, 'the same facts keep their line past 6 hours');
    assert.equal(runs, 3);
    answer = 'google.com visits bounce 30%.';
    assert.equal(await ask(other, 15.1), answer);
    assert.equal(runs, 4);
    assert.equal(env.STORE.puts.at(-1).opts.expirationTtl, 86400);
  } finally { console.error = error; }
});

test('a failed try is kept for an hour, and one instance asks once at a time', async () => {
  const H = 3600_000, T0 = Date.UTC(2026, 9, 28, 9), errors = [], error = console.error;
  let runs = 0;
  const env = { STORE: memoryKV(), AI: { run: async () => { runs++; await new Promise(r => setTimeout(r, 5)); return { response: 'Nothing to add.' }; } } };
  console.error = m => errors.push(m);
  try {
    assert.deepEqual(await Promise.all([lineFor(env, 'k2', facts, T0), lineFor(env, 'k2', facts, T0)]), [null, null]);
    assert.equal(runs, 1, 'both loads wait for the one request');
    const other = facts.replace('by 12 visitors', 'by 13 visitors');
    assert.equal(await lineFor(env, 'k2', other, T0 + .5 * H), null);
    assert.equal(runs, 1, 'not again within the hour');
    assert.equal(await lineFor({ ...env, STORE: memoryKV() }, 'k2', other, T0 + .5 * H), null, 'nor after KV lost it, in this instance');
    assert.equal(runs, 1);
    await lineFor(env, 'k2', other, T0 + 1.5 * H);
    assert.equal(runs, 2, 'an hour on, with new facts');
  } finally { console.error = error; }
});
