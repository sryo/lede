import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, sqlStore, handleApi } from '../src/api.js';
import { nextVisitsSql, nextRowsSql, hexOf, NEXT } from '../src/queries.js';
import { pickVisits, pairNext } from '../src/shape.js';
import { demoStore } from '../src/demo.js';
import { nextStory, nextItems } from '../public/story.js';

const SITES = ['example.com'];
const ENV = { ACCOUNT_ID: 'acc', ANALYTICS_TOKEN: 'tok', DATASET: 'lede' };
const url = s => new URL(`https://worker.test/api/${s}`);
const strip = html => html.replace(/<[^>]+>/g, '');
// A page view as the rows query returns it: period, visit id prefix, path, unix second.
const view = (v, path, t, p = 1) => ({ p, v, path, t: String(t) });
const period = (views, left, next, visits = views) => ({ views, left, visits, next: Object.entries(next).map(([key, n]) => ({ key, views: n })) });

/* ---------- pairing ---------- */

test('next: each view of the page is paired with the view that follows it in the same visit', () => {
  const rows = [
    view('a', '/pricing', 10), view('a', '/signup', 20),
    view('b', '/', 5), view('b', '/pricing', 6),
    view('c', '/pricing', 1), view('c', '/docs', 2), view('c', '/pricing', 3), view('c', '/signup', 4),
  ];
  const { cur, prev } = pairNext(rows, '/pricing');
  assert.equal(cur.views, 4);
  assert.equal(cur.left, 1, 'nothing follows /pricing in visit b, so it left');
  assert.equal(cur.visits, 3);
  assert.deepEqual(cur.next, [{ key: '/signup', views: 2 }, { key: '/docs', views: 1 }]);
  assert.deepEqual(prev, { views: 0, left: 0, visits: 0, next: [] });
});

test('next: rows are put in time order first, and a reload of the same page is not a next page', () => {
  const rows = [view('a', '/signup', 30), view('a', '/pricing', 10), view('a', '/pricing', 20)];
  const { cur } = pairNext(rows, '/pricing');
  assert.equal(cur.views, 1);
  assert.deepEqual(cur.next, [{ key: '/signup', views: 1 }]);
});

test('next: the two periods are counted apart, and a visit split between them leaves at the border', () => {
  const rows = [view('a', '/pricing', 1, 0), view('a', '/signup', 2, 1), view('b', '/pricing', 1, 0), view('b', '/docs', 2, 0)];
  const { cur, prev } = pairNext(rows, '/pricing');
  assert.equal(cur.views, 0);
  assert.equal(prev.views, 2);
  assert.equal(prev.left, 1);
  assert.deepEqual(prev.next, [{ key: '/docs', views: 1 }]);
});

test('next: no rows gives empty periods', () => {
  assert.deepEqual(pairNext([], '/x'), { cur: { views: 0, left: 0, visits: 0, next: [] }, prev: { views: 0, left: 0, visits: 0, next: [] } });
});

test('next: visits are picked per period up to the cap, and anything that is not an id prefix is dropped', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({ p: 1, v: `00000000000${i}` })),
    { p: 0, v: '0000000000aa' }, { p: 0, v: "x' OR 1=1" }, { p: 1, v: '' },
  ];
  const picked = pickVisits(rows, 3);
  assert.deepEqual(picked.ids, ['000000000000', '000000000001', '000000000002', '0000000000aa']);
  assert.ok(picked.keep.has('1|000000000002') && !picked.keep.has('1|000000000003'));
  assert.ok(picked.keep.has('0|0000000000aa'));
  assert.deepEqual(picked.sampled, { cur: true, prev: false });
  assert.deepEqual(pickVisits([], 3), { ids: [], keep: new Set(), sampled: { cur: false, prev: false } });
});

/* ---------- SQL ---------- */

test('next: one query finds the visits that viewed the page in both periods, picked by id so the pick is random', () => {
  const q = parseQuery(url('next?path=/pricing&days=7'), SITES);
  const sql = nextVisitsSql('lede', q);
  assert.match(sql, /substring\(blob7, 1, 12\) AS v/);
  assert.match(sql, /AS p, /);
  assert.ok(sql.includes(`hex(blob2) = '${hexOf('/pricing')}'`));
  assert.match(sql, /GROUP BY p, v ORDER BY v LIMIT 2000$/);
});

test('next: the second query reads every page view of those visits, not just this page, in visit and time order', () => {
  const q = parseQuery(url('next?path=/pricing&referrer=google.com'), SITES);
  const sql = nextRowsSql('lede', q, ['0123456789ab', 'ba9876543210']);
  assert.ok(!sql.includes(hexOf('/pricing')), 'the page filter is lifted so the next page can be seen');
  assert.ok(sql.includes(`hex(blob4) = '${hexOf('google.com')}'`), 'other filters stay');
  assert.match(sql, /substring\(blob7, 1, 12\) IN \('0123456789ab', 'ba9876543210'\)/);
  assert.match(sql, /blob8 = 'pageview'/);
  assert.match(sql, /ORDER BY v, t LIMIT 10000$/);
  const ids = Array.from({ length: 2 * NEXT.keep }, (_, i) => i.toString(16).padStart(12, 'f'));
  const longest = nextRowsSql('lede', { ...q, filters: { referrer: 'x'.repeat(512) } }, ids);
  assert.ok(longest.length < 10240, `${longest.length} bytes fits the SQL API's 10 KiB`);
});

// A fake SQL API answering the two queries the next route sends.
function fakeNext(calls, rows) {
  return async (endpoint, init) => {
    calls.push(init.body);
    const data = init.body.includes(' IN (') ? rows : [{ p: 1, v: 'aaaaaaaaaaaa' }, { p: 1, v: 'bbbbbbbbbbbb' }, { p: 0, v: 'cccccccccccc' }];
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
}

test('SQL store: next pairs the rows of the picked visits', async () => {
  const calls = [];
  const rows = [
    view('aaaaaaaaaaaa', '/pricing', 1), view('aaaaaaaaaaaa', '/signup', 2),
    view('bbbbbbbbbbbb', '/pricing', 1),
    view('cccccccccccc', '/pricing', 1, 0), view('cccccccccccc', '/docs', 2, 0),
    // Picked for this period only, so its earlier part is left out.
    view('aaaaaaaaaaaa', '/pricing', 0, 0),
  ];
  const out = await sqlStore(ENV, fakeNext(calls, rows)).next(parseQuery(url('next?path=/pricing'), SITES));
  assert.equal(calls.length, 2);
  assert.equal(out.path, '/pricing');
  assert.equal(out.sampled, false);
  assert.deepEqual(out.cur, period(2, 1, { '/signup': 1 }));
  assert.deepEqual(out.prev, period(1, 0, { '/docs': 1 }));
});

test('SQL store: when the row limit cuts a visit short, that visit is dropped rather than counted as leaving', async () => {
  const calls = [];
  const rows = Array.from({ length: NEXT.rows }, (_, i) => view(i < NEXT.rows - 1 ? 'aaaaaaaaaaaa' : 'bbbbbbbbbbbb', i % 2 ? '/a' : '/pricing', i));
  const out = await sqlStore(ENV, fakeNext(calls, rows)).next(parseQuery(url('next?path=/pricing'), SITES));
  assert.equal(out.cur.visits, 1);
  assert.equal(out.cur.views, (NEXT.rows - 1) / 2 + 0.5 | 0);
});

test('SQL store: when one period fills the first answer, the other is asked for on its own, and both say whether they were sampled', async () => {
  const calls = [];
  const id = i => i.toString(16).padStart(12, '0');
  const fetchImpl = async (_, init) => {
    calls.push(init.body);
    if (init.body.includes(' IN (')) return new Response(JSON.stringify({ data: [] }));
    const prev = init.body.includes(' OR ') ? [{ p: 0, v: id(1) }] : Array.from({ length: NEXT.keep + 1 }, (_, i) => ({ p: 0, v: id(i) }));
    const cur = Array.from({ length: NEXT.both - prev.length }, (_, i) => ({ p: 1, v: id(i) }));
    return new Response(JSON.stringify({ data: init.body.includes(' OR ') ? [...cur, ...prev] : prev }));
  };
  const out = await sqlStore(ENV, fetchImpl).next(parseQuery(url('next?path=/pricing'), SITES));
  assert.equal(calls.length, 3, 'both, then the previous period alone, then the rows');
  assert.ok(calls[1].endsWith(`LIMIT ${NEXT.keep + 1}`) && !calls[1].includes(' OR '));
  assert.deepEqual([out.sampled, out.prevSampled], [true, true]);
});

test('SQL store: a page nobody viewed asks once and answers empty', async () => {
  const calls = [];
  const fetchImpl = async (e, init) => { calls.push(init.body); return new Response(JSON.stringify({ data: [] }), { status: 200 }); };
  const out = await sqlStore(ENV, fetchImpl).next(parseQuery(url('next?path=/nobody'), SITES));
  assert.equal(calls.length, 1);
  assert.deepEqual(out.cur, period(0, 0, {}));
});

test('the next route needs a page', async () => {
  const env = { ...ENV, DEMO: 'true', STORE: { get: async () => JSON.stringify(SITES) } };
  const res = await handleApi(new Request('https://worker.test/api/next'), env, { waitUntil() {} });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /page/);
  const ok = await handleApi(new Request('https://worker.test/api/next?path=/robin'), env, { waitUntil() {} });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).path, '/robin');
});

/* ---------- demo ---------- */

test('demo: every page has a next step, some readers leave, and the counts add up', async () => {
  const q = parseQuery(url('next?days=30'), SITES);
  for (const path of ['/', '/robin', '/by-song', '/about']) {
    const out = await demoStore.next({ ...q, filters: { path } });
    const c = out.cur;
    assert.ok(c.views >= 20, path);
    assert.ok(c.left > 0 && c.left < c.views, path);
    assert.equal(c.left + c.next.reduce((a, r) => a + r.views, 0), c.views, path);
    assert.ok(c.next.every(r => r.key !== path), `${path} never follows itself`);
    assert.ok(out.prev.views > 0, path);
  }
  const none = await demoStore.next({ ...q, filters: { path: '/no-such-page' } });
  assert.equal(none.cur.views, 0);
});

/* ---------- the sentence ---------- */

test('next sentence: the biggest two steps, in order, as shares', () => {
  const s = nextStory({ path: '/pricing', cur: period(100, 38, { '/signup': 22, '/docs': 20, '/': 20 }), prev: period(0, 0, {}) });
  assert.equal(strip(s.html), 'After /pricing, 38% leave the site and 22% go on to /signup.');
  assert.equal(s.told, '/signup');
  const most = nextStory({ path: '/', cur: period(50, 10, { '/robin': 30, '/owls': 10 }), prev: period(0, 0, {}) });
  assert.equal(strip(most.html), 'After the home page, 60% go on to /robin and 20% leave the site.');
});

test('next sentence: everyone leaving, and nobody leaving, are said plainly', () => {
  assert.equal(strip(nextStory({ path: '/a', cur: period(40, 40, {}), prev: period(0, 0, {}) }).html), 'Everyone leaves the site after /a.');
  assert.equal(strip(nextStory({ path: '/a', cur: period(40, 0, { '/b': 30, '/c': 10 }), prev: period(0, 0, {}) }).html),
    'After /a, 75% go on to /b and none leave the site.');
});

test('next sentence: a small number of views is told as counts, never as shares', () => {
  const s = nextStory({ path: '/a', cur: period(7, 4, { '/b': 2, '/c': 1 }), prev: period(0, 0, {}) });
  assert.equal(strip(s.html), 'Only 7 views of this page so far: 4 ended the visit here and 2 went on to /b.');
  assert.ok(!/%/.test(s.html));
  assert.equal(s.told, null, 'nothing is singled out on a small sample');
  assert.equal(strip(nextStory({ path: '/a', cur: period(1, 1, {}), prev: period(0, 0, {}) }).html), 'Only 1 view of this page so far: it ended the visit here.');
  assert.equal(strip(nextStory({ path: '/a', cur: period(2, 0, { '/b': 2 }), prev: period(0, 0, {}) }).html), 'Only 2 views of this page so far: 2 went on to /b.');
});

test('next sentence: nothing to say when nobody viewed the page', () => {
  assert.equal(nextStory({ path: '/a', cur: period(0, 0, {}), prev: period(0, 0, {}) }), null);
  assert.equal(nextStory(null), null);
});

test('next sentence: a clear change in how many leave is told; noise is not', () => {
  const big = nextStory({ path: '/a', cur: period(400, 120, { '/b': 280 }), prev: period(400, 200, { '/b': 200 }) }, 30);
  assert.match(strip(big.html), /In the 30 days before, 50% left\.$/);
  const noise = nextStory({ path: '/a', cur: period(30, 12, { '/b': 18 }), prev: period(30, 15, { '/b': 15 }) });
  assert.ok(!/before/.test(noise.html));
  const fewBefore = nextStory({ path: '/a', cur: period(400, 120, { '/b': 280 }), prev: period(10, 9, { '/b': 1 }) });
  assert.ok(!/before/.test(fewBefore.html), 'a small earlier period is not compared');
});

test('next sentence: a sample says how many visits it was worked out from', () => {
  const s = nextStory({ path: '/a', sampled: true, cur: period(300, 100, { '/b': 200 }, 250), prev: period(0, 0, {}) });
  assert.equal(s.note, 'Worked out from 250 visits picked at random.');
  assert.equal(nextStory({ path: '/a', cur: period(300, 100, { '/b': 200 }), prev: period(0, 0, {}) }).note, '');
});

test('next sentence: paths are escaped', () => {
  const s = nextStory({ path: '/<b>', cur: period(40, 10, { '/"x"': 30 }), prev: period(0, 0, {}) });
  assert.ok(!s.html.includes('<b>/<b>') && s.html.includes('&lt;b&gt;'));
});

/* ---------- the fan's items ---------- */

test('next items: the top four pages, the rest as other pages, then leaving the site', () => {
  const items = nextItems(period(100, 30, { '/b': 20, '/c': 15, '/d': 12, '/e': 10, '/f': 8, '/g': 5 }), '/b');
  assert.deepEqual(items.map(i => [i.key, i.label, i.value, i.kind, !!i.story]), [
    ['/b', '/b', 20, 'page', true], ['/c', '/c', 15, 'page', false], ['/d', '/d', 12, 'page', false], ['/e', '/e', 10, 'page', false],
    [null, '2 other pages', 13, 'page', false], [null, 'Left the site', 30, 'left', false],
  ]);
});

test('next items: one other page is singular, and nothing is listed for empty parts', () => {
  const items = nextItems(period(10, 0, { '/b': 1, '/c': 1, '/d': 1, '/e': 1, '/f': 6 }), null);
  assert.equal(items.at(-1).label, '1 other page');
  assert.ok(!items.some(i => i.kind === 'left'));
  assert.deepEqual(nextItems(period(0, 0, {}), null), []);
  assert.deepEqual(nextItems(period(3, 3, {}), null).map(i => i.label), ['Left the site']);
});
