import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, sqlStore, handleApi, parseFunnel, parseFunnels } from '../src/api.js';
import { funnelSql, hexOf } from '../src/queries.js';
import { toFunnel } from '../src/shape.js';
import { demoStore, DEMO_FUNNEL } from '../src/demo.js';
import { readFileSync } from 'node:fs';
import { funnelStory, funnelName, parseSteps, stepHint, funnelBars, funnelOffer, FUNNEL_EMPTY } from '../public/story.js';
import { viewToUrl, urlToView } from '../public/routes.js';

const SITES = ['example.com'];
const url = s => new URL(`https://worker.test/api/${s}`);
const memoryKV = (init = {}) => { const m = new Map(Object.entries(init)); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const call = (path, env, init) => handleApi(new Request(`https://worker.test/api/${path}`, init), env, { waitUntil() {} });
const strip = html => html.replace(/<[^>]+>/g, '');
const STEPS = ['/pricing', '/signup', '/thanks'];

/* ---------- SQL ---------- */

test('a funnel is one query over both periods that only reads the step pages', () => {
  const q = parseQuery(url('funnel?days=30'), SITES, Date.UTC(2026, 9, 27, 15));
  const sql = funnelSql('lede', q, STEPS);
  assert.match(sql, /GROUP BY p, visit/, 'each visit, in each period');
  assert.match(sql, /GROUP BY p$/, 'then one row per period');
  assert.ok(sql.includes(`toDateTime(${q.prevStart})`) && sql.includes(`toDateTime(${q.start})`), 'both periods');
  const only = `(hex(blob2) = '${hexOf('/pricing')}' OR hex(blob2) = '${hexOf('/signup')}' OR hex(blob2) = '${hexOf('/thanks')}')`;
  assert.ok(sql.includes(only), 'rows for other pages are never read into the visits');
  STEPS.forEach((s, i) => assert.ok(sql.includes(`min(if(hex(blob2) = '${hexOf(s)}', toUnixTimestamp(timestamp), 4294967295)) AS t${i}`), `first time of step ${i}`));
  assert.match(sql, /blob8 = 'pageview'/, 'page views only');
});

test('each step counts visits whose first view of it came strictly after the step before', () => {
  const q = parseQuery(url('funnel?days=7'), SITES, Date.UTC(2026, 9, 27, 15));
  const sql = funnelSql('lede', q, STEPS);
  assert.ok(sql.includes('countIf(t0 < 4294967295) AS s0'));
  assert.ok(sql.includes('countIf(t0 < t1 AND t1 < 4294967295) AS s1'));
  assert.ok(sql.includes('countIf(t0 < t1 AND t1 < t2 AND t2 < 4294967295) AS s2'));
});

test('a funnel ignores the dashboard filters: a path filter would leave out every other step', () => {
  const q = parseQuery(url('funnel?days=7&path=/pricing&referrer=google.com'), SITES, Date.UTC(2026, 9, 27, 15));
  const sql = funnelSql('lede', q, STEPS);
  assert.ok(!sql.includes(`hex(blob4)`));
  assert.equal(sql.split(`hex(blob2) = '${hexOf('/pricing')}'`).length, 3, 'only in the step list and its own first time');
});

test('funnel rows become counts per step for each period, zero when a period had no visits', () => {
  assert.deepEqual(toFunnel([{ p: '1', s0: '120', s1: '30', s2: '9' }], STEPS), { steps: STEPS, cur: [120, 30, 9], prev: [0, 0, 0] });
  assert.deepEqual(toFunnel([{ p: 0, s0: '80', s1: '20', s2: '4' }, { p: 1, s0: '5', s1: '1', s2: '0' }], STEPS), { steps: STEPS, cur: [5, 1, 0], prev: [80, 20, 4] });
});

test('the SQL store asks one query per funnel', async () => {
  const sent = [];
  const fetchImpl = async (u, init) => { sent.push(init.body); return new Response(JSON.stringify({ data: [{ p: 1, s0: '10', s1: '4' }, { p: 0, s0: '8', s1: '2' }] })); };
  const store = sqlStore({ ACCOUNT_ID: 'acc', ANALYTICS_TOKEN: 'tok' }, fetchImpl);
  const f = await store.funnel(parseQuery(url('funnel'), SITES), ['/a', '/b']);
  assert.equal(sent.length, 1);
  assert.deepEqual(f, { steps: ['/a', '/b'], cur: [10, 4], prev: [8, 2] });
});

/* ---------- API ---------- */

test('a funnel is two to five different pages, each starting with a slash', () => {
  assert.deepEqual(parseFunnel(['/a', '/b']), ['/a', '/b']);
  assert.deepEqual(parseFunnel(['/a', '/b', '/c', '/d', '/e']).length, 5);
  for (const bad of [null, ['/a'], ['/a', '/b', '/c', '/d', '/e', '/f'], ['/a', 'b'], ['/a', '/a'], ['/a', '/' + 'x'.repeat(200)], ['/a', 3]]) {
    assert.throws(() => parseFunnel(bad), e => e.status === 400 && /two to five/.test(e.message), JSON.stringify(bad)?.slice(0, 40));
  }
});

test('up to five funnels are kept, without repeats', () => {
  assert.deepEqual(parseFunnels([['/a', '/b'], ['/a', '/b'], ['/b', '/c']]), [['/a', '/b'], ['/b', '/c']]);
  assert.throws(() => parseFunnels(Array.from({ length: 6 }, (_, i) => ['/a', `/${i}`])), e => e.status === 400);
  assert.throws(() => parseFunnels('nope'), e => e.status === 400);
});

test('funnels are saved per site for everyone who opens the dashboard', async () => {
  const STORE = memoryKV({ sites: '["example.com","b.example"]' }), env = { STORE };
  assert.deepEqual(await (await call('funnels?site=example.com', env)).json(), { funnels: [] });
  const put = await call('funnels?site=example.com', env, { method: 'PUT', body: JSON.stringify({ funnels: [STEPS] }) });
  assert.deepEqual(await put.json(), { funnels: [STEPS] });
  assert.deepEqual(await (await call('funnels?site=example.com', env)).json(), { funnels: [STEPS] });
  assert.deepEqual(await (await call('funnels?site=b.example', env)).json(), { funnels: [] }, 'another site has its own');
  const bad = await call('funnels?site=example.com', env, { method: 'PUT', body: JSON.stringify({ funnels: [['/only']] }) });
  assert.equal(bad.status, 400);
  assert.equal((await call('funnels?site=example.com', env)).headers.get('Cache-Control'), 'no-store');
});

test('the sample site comes with a funnel until one is saved, and a saved empty list stays empty', async () => {
  const env = { STORE: memoryKV({ sites: '["example.com"]' }), DEMO: 'true' };
  assert.deepEqual(await (await call('funnels?site=example.com', env)).json(), { funnels: [DEMO_FUNNEL] });
  await call('funnels?site=example.com', env, { method: 'PUT', body: JSON.stringify({ funnels: [] }) });
  assert.deepEqual(await (await call('funnels?site=example.com', env)).json(), { funnels: [] });
});

test('the goals the dashboard loads at the start carry the funnels, so the Overview asks for funnel numbers only when there is one', async () => {
  const env = { STORE: memoryKV({ sites: '["example.com"]' }) };
  assert.deepEqual(await (await call('goals?site=example.com', env)).json(), { goals: [], notes: [], funnels: [] });
  await call('funnels?site=example.com', env, { method: 'PUT', body: JSON.stringify({ funnels: [STEPS] }) });
  await call('goals?site=example.com', env, { method: 'PUT', body: JSON.stringify({ goals: ['/thanks'] }) });
  assert.deepEqual(await (await call('goals?site=example.com', env)).json(), { goals: ['/thanks'], notes: [], funnels: [STEPS] });
  const demo = { STORE: memoryKV({ sites: '["example.com"]' }), DEMO: 'true' };
  assert.deepEqual((await (await call('goals?site=example.com', demo)).json()).funnels, [DEMO_FUNNEL]);
});

test('GET /api/funnel answers both periods for the steps given, and refuses a bad list', async () => {
  const env = { STORE: memoryKV({ sites: '["example.com"]' }), DEMO: 'true' };
  const res = await call('funnel?site=example.com&steps=/&steps=/feeders&steps=/nests', env);
  const f = await res.json();
  assert.deepEqual(f.steps, ['/', '/feeders', '/nests']);
  for (const side of [f.cur, f.prev]) {
    assert.equal(side.length, 3);
    assert.ok(side[0] > 0);
    side.forEach((n, i) => i && assert.ok(n <= side[i - 1], 'no step has more visits than the one before'));
  }
  assert.equal((await call('funnel?site=example.com&steps=/', env)).status, 400);
});

/* ---------- demo ---------- */

test('demo: the sample funnel has one drop much bigger than the others', async () => {
  const f = await demoStore.funnel(parseQuery(url('funnel?days=30'), SITES), DEMO_FUNNEL);
  assert.ok(DEMO_FUNNEL.length >= 3);
  const lost = f.cur.slice(1).map((n, i) => f.cur[i] - n).sort((a, b) => b - a);
  assert.ok(lost[0] >= lost[1] * 2, `biggest ${lost[0]}, next ${lost[1]}`);
  assert.ok(f.cur[0] >= 100, 'enough visits to say');
  assert.ok(f.cur.every(Number.isInteger) && f.prev.every(Number.isInteger));
});

test('demo: any pages make a funnel, and a page with no visits stops it', async () => {
  const q = parseQuery(url('funnel?days=7'), SITES);
  const f = await demoStore.funnel(q, ['/owls', '/nowhere', '/robin']);
  assert.ok(f.cur[0] > 0);
  assert.deepEqual(f.cur.slice(1), [0, 0]);
});

/* ---------- story ---------- */

const F = (cur, prev = cur.map(() => 0), steps = STEPS.slice(0, cur.length)) => ({ steps, cur, prev });

test('funnel sentence: how many saw the first step, how many finished, and where most were lost', () => {
  const s = funnelStory(F([120, 30, 9]), 30);
  assert.equal(strip(s.html), 'Of 120 visits that saw /pricing, 9 finished. Most were lost between /pricing and /signup.');
  assert.equal(s.drop, 1, 'the drop into the second step');
});

test('funnel sentence calls it the biggest drop when no one drop is most of the loss', () => {
  const s = funnelStory(F([200, 110, 40, 10], undefined, ['/a', '/b', '/c', '/d']), 30);
  assert.equal(strip(s.html), 'Of 200 visits that saw /a, 10 finished. The biggest drop was between /a and /b.');
  assert.equal(s.drop, 1);
});

test('funnel sentence: everyone finished, no one finished, the home page by name', () => {
  assert.equal(strip(funnelStory(F([50, 50]), 30).html), 'Of 50 visits that saw /pricing, all 50 finished.');
  assert.equal(funnelStory(F([50, 50]), 30).drop, -1);
  assert.equal(strip(funnelStory(F([60, 0], undefined, ['/', '/signup']), 30).html), 'Of 60 visits that saw the home page, none finished. Most were lost between the home page and /signup.');
});

test('small funnels are said plainly, with no drop picked out', () => {
  const s = funnelStory(F([12, 4, 1]), 30);
  assert.equal(strip(s.html), 'Too few visits to say yet: 12 saw /pricing and 1 finished.');
  assert.equal(s.drop, -1);
  assert.equal(strip(funnelStory(F([0, 0]), 7).html), 'No visits saw /pricing in the last 7 days.');
});

test('steps typed in one line, separated by spaces, commas or arrows', () => {
  assert.deepEqual(parseSteps('/pricing → /signup, /thanks'), { steps: STEPS });
  assert.deepEqual(parseSteps(' /pricing > /signup  /thanks '), { steps: STEPS });
  assert.match(parseSteps('/pricing').error, /at least two pages/);
  assert.match(parseSteps('/a /b /c /d /e /f').error, /at most five/);
  assert.match(parseSteps('/pricing signup').error, /starts with a slash/);
  assert.match(parseSteps('/a /a').error, /twice/);
  assert.match(parseSteps('').error, /at least two pages/);
});

test('each step hints at its visits, the share of the step before, and how many were lost on the way', () => {
  const f = F([120, 30, 9], undefined, ['/', '/signup', '/thanks']);
  assert.equal(stepHint(f, 0), 'Home page: 120 visits');
  assert.equal(stepHint(f, 1), '/signup: 30 visits, 25% of those at the home page; 90 lost on the way');
  assert.equal(stepHint(F([5, 5]), 1), '/signup: 5 visits, 100% of those at /pricing');
});

test('a funnel is named by its steps', () => {
  assert.equal(funnelName(['/', '/signup']), 'Home page → /signup');
  assert.equal(funnelName(STEPS), '/pricing → /signup → /thanks');
});

/* ---------- the Overview card ---------- */

test('the funnel chart: violet for visits that go on, a pale neutral for visits lost, never the bounce red', () => {
  const bars = funnelBars([120, 30, 9], 1, 200);
  assert.equal(bars[0].lost, 0, 'nothing is lost before the first step');
  assert.equal(bars[2].lostFill, 'var(--lost-p)', 'an ordinary drop is a paler neutral than the biggest, but still visible');
  assert.equal(bars[1].lostFill, 'var(--lost)', 'the biggest drop is a slightly stronger neutral');
  assert.ok(bars[1].hot && !bars[2].hot, 'only the biggest drop is picked out');
  assert.ok(!JSON.stringify(funnelBars([120, 30, 9], 1, 200)).includes('bnc'));
  assert.ok(funnelBars([12, 4, 1], -1, 200).every(b => !b.hot && (b.lostFill === 'var(--lost-p)' || !b.lost)), 'too few to say: no drop picked out');
});

test('the funnel chart scales to the first step, and the bar with the lost visits on it reaches the step before', () => {
  const [a, b, c] = funnelBars([100, 50, 25], 1, 200);
  assert.equal(a.h, 200);
  assert.equal(b.h, 100);
  assert.equal(b.h + b.lost, a.h);
  assert.equal(c.h + c.lost, b.h);
});

test('the finishing step never shrinks to a sliver: a step with visits keeps a visible bar', () => {
  const bars = funnelBars([37686, 3391, 2102], 1, 160);
  assert.ok(bars[2].h >= 8, `last bar ${bars[2].h}px`);
  assert.ok(bars[1].h >= 8);
  assert.equal(bars[2].h + bars[2].lost, bars[1].h, 'the lost part still meets the step before');
  assert.equal(funnelBars([50, 0], 1, 160)[1].h, 0, 'a step no one reached has no bar');
});

test('with no funnel, the card says what a funnel shows in one sentence', () => {
  assert.equal(FUNNEL_EMPTY, 'A funnel shows where visits drop off on their way to a page that matters, such as a sign-up.');
});

test('the add field is filled in from the first goal: the busiest other page, then the goal', () => {
  const rows = [{ key: '/' }, { key: '/signup' }, { key: '/blog' }];
  assert.equal(funnelOffer(rows, ['/signup', '/thanks'], []), '/ → /signup');
  assert.equal(funnelOffer([{ key: '/signup' }, { key: '/blog' }], ['/signup'], []), '/blog → /signup', 'not the goal itself');
  assert.equal(funnelOffer(rows, [], []), '', 'no goal, nothing filled in');
  assert.equal(funnelOffer(rows, ['/signup'], [['/', '/pricing', '/signup']]), '', 'not when a saved funnel already goes there');
  assert.equal(funnelOffer([], ['/signup'], []), '');
});

test('the dashboard has no funnels view: funnels are a card on the Overview', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(!/v:'funnels'|case 'funnels'/.test(html), 'nothing opens a funnels view');
  assert.ok(!html.includes('where visits drop off on the way here'), 'the goal card has no funnels row');
  assert.ok(!html.includes('class="link">Funnels<'), 'the goal line has no Funnels link');
  assert.match(html, /By weekday and hour[\s\S]*funnels-card[\s\S]*data-group="pages"/, 'the card sits after By weekday and hour, before Pages');
});

/* ---------- address ---------- */

test('an old /funnels link opens the Overview', () => {
  assert.deepEqual(urlToView('/funnels', '?days=7'), { view: { v: 'overview' }, days: 7, site: null });
  assert.equal(viewToUrl({ v: 'funnels' }), '/');
});
