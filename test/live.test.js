import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Live, forward, watch } from '../src/live.js';
import { collect } from '../src/collect.js';

// A Durable Object's ctx, for what Live uses: its SQLite (ctx.storage.sql, on Node's own) and the sockets
// watching it.
function ctxOf(sockets = []) {
  const db = new DatabaseSync(':memory:');
  const exec = (q, ...b) => {
    const s = db.prepare(q);
    return /^\s*SELECT/i.test(q) ? { toArray: () => s.all(...b).map(r => ({ ...r })) } : (s.run(...b), { toArray: () => [] });
  };
  return { storage: { sql: { exec } }, getWebSockets: () => sockets, acceptWebSocket: ws => sockets.push(ws) };
}
const post = (live, path, body) => live.fetch(new Request(`https://live${path}`, { method: 'POST', body: JSON.stringify(body) }));

test('live: who is here comes from each page view, and a hidden tab leaves at once', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000_000 });
  const live = new Live(ctxOf());
  await post(live, '/event', { visitor: 'a', view: 1, path: '/x', referrer: 'news.ycombinator.com', country: 'AR' });
  await post(live, '/event', { visitor: 'b', view: 2, path: '/y' });
  await post(live, '/event', { visitor: 'b', view: 3, path: '/z' });
  t.mock.timers.tick(60e3);
  await post(live, '/event', { visitor: 'b', view: 3, left: 1 });
  let s = live.snapshot(Math.floor(Date.now() / 1000));
  assert.deepEqual([s.now, s.recent], [2, 2], 'b still has a tab showing');
  assert.equal(s.visitors.find(v => v.referrer === '').path, '/y', 'on the page still showing, not the one hidden');
  t.mock.timers.tick(1000);
  await post(live, '/event', { visitor: 'b', view: 2, left: 1 });
  s = live.snapshot(Math.floor(Date.now() / 1000));
  assert.deepEqual([s.now, s.recent], [1, 2], 'gone with their last tab, though still among the recent');
  assert.equal(s.visitors.find(v => !v.active).path, '/y', 'on the page they left last');
  await post(live, '/event', { visitor: 'b', view: 2, path: '/y' });
  assert.equal(live.snapshot(Math.floor(Date.now() / 1000)).now, 2, 'and back with a ping');
  await post(live, '/event', { visitor: 'b', view: 2, left: 1 });
  await post(live, '/event', { visitor: 'b', view: 4, path: '/w' });
  s = live.snapshot(Math.floor(Date.now() / 1000));
  assert.deepEqual([s.now, s.visitors.find(v => v.path !== '/x').path], [2, '/w'], 'a single-page app moving on leaves the page behind for the next');
  t.mock.timers.tick(31 * 60e3);
  assert.equal(live.snapshot(Math.floor(Date.now() / 1000)).recent, 0, 'half an hour on, nobody');
});

test('live: the seed gives who Analytics Engine has, until the visitor\'s own page views come', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000 });
  const now = 1_000_000;
  const live = new Live(ctxOf());
  await post(live, '/seed', [{ visitor: 'a', path: '/old', first: now - 600, last: now - 60 }, { visitor: 'c', path: '/c', first: now - 900, last: now - 400 }, { nope: 1 }]);
  let s = live.snapshot(now);
  assert.deepEqual([s.now, s.recent], [1, 2]);
  await post(live, '/event', { visitor: 'a', view: 7, path: '/new' });
  s = live.snapshot(now);
  assert.equal(s.visitors[0].path, '/new');
  await post(live, '/seed', [{ visitor: 'a', path: '/stale', first: now - 900, last: now - 900 }]);
  assert.equal(live.snapshot(now).visitors[0].path, '/new', 'a later seed doesn\'t undo what the object has heard');
});

test('live: watching dashboards get who is here at most once a second', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000_000 });
  const got = [], live = new Live(ctxOf([{ send: m => got.push(JSON.parse(m)) }]));
  for (let i = 0; i < 5; i++) await post(live, '/event', { visitor: `v${i}`, view: 1, path: '/' });
  assert.equal(got.length, 0);
  t.mock.timers.tick(1000);
  assert.deepEqual(got.map(s => s.now), [5]);
  const res = await post(live, '/event', { visitor: 'v9', view: 1, path: '/' });
  assert.deepEqual(await res.json(), { watching: 1 }, 'collect learns someone is watching');
});

// A LIVE binding that records each request and answers how many dashboards watch.
function liveBinding(watching) {
  const asked = [];
  return { asked, LIVE: { idFromName: n => n, get: site => ({ fetch: async (url, init) => { asked.push([site, new URL(url).pathname, init?.body && JSON.parse(init.body)]); return Response.json({ watching: watching() }); } }) } };
}
const flush = () => new Promise(r => setTimeout(r, 0));

test('live: collect hands events on only while a dashboard watches, asking at most once a minute while none does', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-05T10:50:00Z') });
  let watching = 0;
  const { asked, LIVE } = liveBinding(() => watching);
  const ctx = { waitUntil: p => p }, env = { LIVE };
  const ev = (type, extra = {}) => ({ site: 'gate.test', type, visitor: 'v', path: '/', referrer: '', country: 'AR', view: 5, ...extra });
  forward(env, ctx, ev('pageview')); await flush();
  forward(env, ctx, ev('ping')); await flush();
  assert.equal(asked.length, 1, 'nobody watching: the next ask waits a minute');
  forward(env, ctx, ev('engagement')); forward(env, ctx, ev('outbound'));
  assert.equal(asked.length, 1, 'only page views, pings and hidden tabs are for "here now"');
  watching = 1;
  t.mock.timers.tick(60e3);
  forward(env, ctx, ev('ping')); await flush();
  forward(env, ctx, ev('engagement', { left: 1 })); await flush();
  assert.equal(asked.length, 3, 'watched: each one goes');
  assert.deepEqual(asked[2], ['gate.test', '/event', { visitor: 'v', view: 5, path: '/', referrer: '', country: 'AR', left: 1 }]);
  forward({}, ctx, ev('ping'));
  forward(env, undefined, ev('ping'));
  assert.equal(asked.length, 3, 'without the binding, or outside a request, nothing');
});

test('live: a dashboard that opens its socket seeds the object first, and is heard of at once', async () => {
  const { asked, LIVE } = liveBinding(() => 1);
  await watch({ LIVE }, 'seed.test', [{ visitor: 'a' }]);
  assert.deepEqual(asked.map(([, path]) => path), ['/seed', '/watch']);
  forward({ LIVE }, { waitUntil: p => p }, { site: 'seed.test', type: 'ping', visitor: 'a' });
  assert.equal(asked.length, 3);
});

test('live: collect forwards what it wrote, with the visitor it hashed', async () => {
  const { asked, LIVE } = liveBinding(() => 1);
  const kv = new Map([['sites', '["collect.test"]'], ['salt', 's']]);
  const env = { LIVE, STORE: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) }, EVENTS: { writeDataPoint() {} } };
  await watch(env, 'collect.test', []);
  await collect(new Request('https://worker.test/lede', {
    method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15', 'CF-Connecting-IP': '9.9.9.9' },
    body: JSON.stringify({ u: 'https://collect.test/docs', v: Date.parse('2026-10-05T10:50:00Z') }),
  }), env, { waitUntil: p => p });
  await flush();
  const [, path, e] = asked.at(-1);
  assert.equal(path, '/event');
  assert.match(e.visitor, /^[\da-f]{32}$/);
  assert.deepEqual([e.path, e.view, e.left], ['/docs', Date.parse('2026-10-05T10:50:00Z'), 0]);
});
