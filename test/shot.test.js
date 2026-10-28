import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { pagePicture, BUDGET_MS, SHOT_URL } from '../src/shot.js';
import { memoryKV, counters, fakeFetch } from '../bench/fakes.mjs';

crypto.subtle.timingSafeEqual ??= (a, b) => Buffer.from(a).equals(Buffer.from(b));

const DAY = 86400e3;
const T0 = Date.UTC(2026, 9, 28, 9);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const env = (extra = {}) => ({ ANALYTICS_TOKEN: 'tok', ACCOUNT_ID: 'acc', STORE: memoryKV(counters(), { sites: '["example.com"]' }), ...extra });

// Cloudflare's screenshot endpoint and the site's own pages, with every call written down.
function cloudflare({ status = 200, ms = 4000, html = '<html><head><meta property="og:image" content="https://example.com/owl.jpg"></head></html>' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    if (u.endsWith('/browser-rendering/screenshot')) {
      if (status !== 200) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status });
      return new Response(JPEG, { headers: { 'Content-Type': 'image/jpeg', 'X-Browser-Ms-Used': String(ms) } });
    }
    if (u.startsWith('https://example.com/')) return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    throw new Error('unexpected fetch ' + u);
  };
  fetchImpl.calls = calls;
  fetchImpl.shots = () => calls.filter(c => c.url.endsWith('/screenshot')).length;
  return fetchImpl;
}
const ask = (e, f, path = '/owls', now = T0) => pagePicture(e, { site: 'example.com', path, origin: 'https://lede.example.workers.dev' }, f, now);

test('shot: takes one picture of the page, full height at 1280 wide, as a small jpeg', async () => {
  const e = env(), f = cloudflare();
  const out = await ask(e, f);
  assert.deepEqual(new Uint8Array(out.jpeg), JPEG);
  assert.equal(f.shots(), 1);
  const call = f.calls[0];
  assert.equal(call.url, SHOT_URL('acc'));
  assert.equal(call.url, 'https://api.cloudflare.com/client/v4/accounts/acc/browser-rendering/screenshot');
  assert.equal(call.headers.Authorization, 'Bearer tok');
  assert.equal(call.body.url, 'https://example.com/owls');
  assert.equal(call.body.viewport.width, 1280);
  assert.equal(call.body.screenshotOptions.fullPage, true);
  assert.equal(call.body.screenshotOptions.type, 'jpeg');
  assert.ok(call.body.screenshotOptions.quality <= 60);
  assert.ok(call.body.viewport.deviceScaleFactor < 1, 'a smaller picture than the page, so long pages stay small');
});

test('shot: the tracker on the pictured page never loads, so the picture is no visit', async () => {
  const e = env(), f = cloudflare();
  await ask(e, f);
  const patterns = f.calls[0].body.rejectRequestPattern.map(p => new RegExp(p));
  const blocked = u => patterns.some(p => p.test(u));
  assert.ok(blocked('https://lede.example.workers.dev/t.js'));
  assert.ok(blocked('https://lede.example.workers.dev/lede'));
  assert.ok(!blocked('https://example.com/t.js'), 'the site’s own scripts still load');
  assert.ok(!blocked('https://example.com/owls'));
});

test('shot: a second open the same day takes no picture', async () => {
  const e = env(), f = cloudflare();
  await ask(e, f);
  const again = await ask(e, f, '/owls', T0 + 3600e3);
  assert.deepEqual(new Uint8Array(again.jpeg), JPEG);
  assert.equal(f.shots(), 1);
  // The picture is kept for a day, and the next day gets a fresh one.
  await ask(e, f, '/owls', T0 + DAY);
  assert.equal(f.shots(), 2);
});

test('shot: the picture and the browser time it took go in one KV write that expires in a day', async () => {
  const puts = [];
  const e = env();
  const put = e.STORE.put;
  e.STORE.put = async (k, v, o) => { puts.push({ k, o }); return put(k, v, o); };
  await ask(e, cloudflare({ ms: 3500 }));
  assert.equal(puts.length, 1);
  assert.equal(puts[0].o.expirationTtl, 86400);
  assert.equal(puts[0].o.metadata.ms, 3500);
});

test('shot: stops at five minutes of browser time a day, and starts again the next day', async () => {
  const count = counters(), e = env({ STORE: memoryKV(count, { sites: '["example.com"]' }) }), f = cloudflare({ ms: 60_000 });
  for (let i = 0; i < 5; i++) assert.ok((await ask(e, f, `/p${i}`)).jpeg, `picture ${i + 1}`);
  assert.equal(BUDGET_MS, 5 * 60_000);
  const spent = await ask(e, f, '/p5');
  assert.equal(f.shots(), 5, 'no sixth picture');
  assert.equal(spent.jpeg, undefined);
  assert.equal(spent.why, 'budget');
  assert.equal(spent.og, 'https://example.com/owl.jpg', 'the page’s own share picture instead');
  const lists = count.kvLists;
  assert.equal((await ask(e, f, '/p6')).why, 'budget');
  assert.equal(count.kvLists, lists, 'once the day’s time is spent, KV isn’t listed again that day');
  const tomorrow = await ask(e, f, '/p5', T0 + DAY);
  assert.ok(tomorrow.jpeg);
  assert.equal(f.shots(), 6);
});

test('shot: without a browser time header, the time is measured', async () => {
  const e = env();
  const f = async (url, init) => {
    if (String(url).endsWith('/screenshot')) return new Response(JPEG, { headers: { 'Content-Type': 'image/jpeg' } });
    throw new Error('unexpected');
  };
  let t = 0;
  const out = await pagePicture(e, { site: 'example.com', path: '/owls', origin: 'https://l.test' }, f, T0, () => (t += 2500));
  assert.ok(out.jpeg);
  const { metadata } = await e.STORE.getWithMetadata(`shot:2026-10-28:example.com/owls`, 'arrayBuffer');
  assert.equal(metadata.ms, 2500);
});

test('shot: a token without the Browser Rendering permission falls back quietly, and tries once a day', async () => {
  const e = env(), f = cloudflare({ status: 403 });
  const out = await ask(e, f);
  assert.deepEqual(out, { og: 'https://example.com/owl.jpg', why: 'permission' });
  await ask(e, f);
  assert.equal(f.shots(), 1, 'not asked again today');
  assert.equal(f.calls.filter(c => c.url.startsWith('https://example.com/')).length, 1, 'the share picture is remembered too');
});

const html = body => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

test('shot: a page Cloudflare can’t picture falls back the same way, and isn’t tried again that day', async () => {
  const puts = [];
  const e = env();
  const put = e.STORE.put;
  e.STORE.put = async (k, v, o) => { puts.push({ k, o }); return put(k, v, o); };
  const f = cloudflare({ status: 422 });
  assert.deepEqual(await ask(e, f), { og: 'https://example.com/owl.jpg', why: 'failed' });
  assert.equal(puts.find(p => p.k.startsWith('shot:')).o.expirationTtl, 86400);
  await ask(e, f);
  assert.equal(f.shots(), 1);
});

test('shot: a busy browser (429, 5xx or no answer) is asked again a minute later', async () => {
  for (const status of [429, 500, 503]) {
    const puts = [], e = env(), f = cloudflare({ status });
    const put = e.STORE.put;
    e.STORE.put = async (k, v, o) => { puts.push({ k, o }); return put(k, v, o); };
    assert.deepEqual(await ask(e, f), { og: 'https://example.com/owl.jpg', why: 'busy' }, `${status}`);
    assert.equal(puts.find(p => p.k.startsWith('shot:')).o.expirationTtl, 60, 'KV’s shortest expiry');
  }
  const thrown = async u => { if (String(u).endsWith('/screenshot')) throw new Error('network'); return html('<meta content="/img/share.png" property="og:image">'); };
  assert.deepEqual(await ask(env(), thrown), { og: 'https://example.com/img/share.png', why: 'busy' }, 'a relative share picture is read against the page');
});

const putsOf = e => {
  const puts = [], put = e.STORE.put;
  e.STORE.put = async (k, v, o) => { puts.push({ k, o }); return put(k, v, o); };
  return puts;
};
const answer = (status, ms) => async u => (String(u).endsWith('/screenshot')
  ? new Response('no', { status, headers: ms ? { 'X-Browser-Ms-Used': String(ms) } : {} }) : html(''));

test('shot: an answer that spent browser time stays in the day’s budget, and isn’t asked again that day', async () => {
  const e = env(), puts = putsOf(e);
  let shots = 0;
  const slow = async u => (String(u).endsWith('/screenshot') ? (shots++, answer(504, 20_000)(u)) : html(''));
  assert.deepEqual(await ask(e, slow), { og: null, why: 'failed' });
  const marker = puts.find(p => p.k.startsWith('shot:'));
  assert.equal(marker.o.expirationTtl, 86400, 'kept all day, so its 20 s are still counted');
  assert.equal(marker.o.metadata.ms, 20_000);
  assert.equal((await ask(e, slow, '/owls', T0 + 120e3)).why, 'failed');
  assert.equal(shots, 1, 'not asked again a minute later');
});

test('shot: a 429 that comes again a minute later means the account’s browser time is spent for the day', async () => {
  const count = counters(), e = env({ STORE: memoryKV(count, { sites: '["example.com"]' }) }), puts = putsOf(e);
  let shots = 0;
  const full = async u => (String(u).endsWith('/screenshot') ? (shots++, answer(429)(u)) : html(''));
  assert.equal((await ask(e, full, '/a')).why, 'busy');
  assert.equal((await ask(e, full, '/b', T0 + 10e3)).why, 'busy', 'two at once are only too many at once');
  assert.equal((await ask(e, full, '/c', T0 + 61e3)).why, 'budget');
  const day = puts.find(p => p.k === 'shot:2026-10-28:');
  assert.equal(day.o.metadata.ms, BUDGET_MS, 'every instance now sees the day’s time as used');
  assert.equal(day.o.expirationTtl, 86400);
  const lists = count.kvLists;
  assert.equal((await ask(e, full, '/d', T0 + 300e3)).why, 'budget');
  assert.equal(shots, 3, 'no more calls today');
  assert.equal(count.kvLists, lists, 'and no more KV lists');
  assert.ok((await ask(e, cloudflare(), '/d', T0 + DAY)).jpeg, 'tomorrow it starts again');
});

test('shot: a picture between two 429s shows the account still has browser time', async () => {
  const e = env();
  let n = 0;
  const f = async u => {
    if (!String(u).endsWith('/screenshot')) return html('');
    return ++n === 2 ? new Response(JPEG, { headers: { 'Content-Type': 'image/jpeg', 'X-Browser-Ms-Used': '3000' } }) : answer(429)(u);
  };
  assert.equal((await ask(e, f, '/a')).why, 'busy');
  assert.ok((await ask(e, f, '/b', T0 + 30e3)).jpeg);
  assert.equal((await ask(e, f, '/c', T0 + 120e3)).why, 'busy');
});

test('shot: a token that can’t tell which account to use isn’t asked again every minute', async () => {
  const e = env({ ACCOUNT_ID: undefined }), puts = putsOf(e);
  let lookups = 0;
  const two = async u => {
    if (String(u).endsWith('/client/v4/accounts')) return lookups++, new Response(JSON.stringify({ result: [{ id: 'a' }, { id: 'b' }] }));
    if (String(u).endsWith('/screenshot')) throw new Error('unexpected');
    return html('');
  };
  assert.deepEqual(await ask(e, two), { og: null, why: 'failed' });
  assert.equal(puts.find(p => p.k.startsWith('shot:')).o.expirationTtl, 86400);
  await ask(e, two, '/owls', T0 + 120e3);
  assert.equal(lookups, 1);
  const offline = async u => { if (String(u).endsWith('/client/v4/accounts')) throw new Error('offline'); return html(''); };
  assert.equal((await ask(env({ ACCOUNT_ID: undefined }), offline)).why, 'busy', 'no answer at all is only busy');
});

test('shot: a failure never takes the place of a picture kept meanwhile', async () => {
  const e = env();
  const f = async u => {
    if (!String(u).endsWith('/screenshot')) throw new Error('unexpected');
    // Another open of the same page got its picture while this one waited.
    await e.STORE.put('shot:2026-10-28:example.com/owls', JPEG.buffer.slice(0), { metadata: { ms: 3000, at: T0 - 5000 } });
    return new Response('busy', { status: 503 });
  };
  const out = await ask(e, f);
  assert.deepEqual(new Uint8Array(out.jpeg), JPEG);
  assert.equal(out.at, T0 - 5000);
  assert.ok((await e.STORE.getWithMetadata('shot:2026-10-28:example.com/owls', 'arrayBuffer')).value.byteLength, 'still there');
});

// A body that never ends: reading all of it would never finish.
const endless = (chunk, type) => {
  const bytes = new TextEncoder().encode(chunk);
  return new Response(new ReadableStream({ pull: c => c.enqueue(bytes) }), { headers: { 'Content-Type': type } });
};

test('shot: only an HTML page is read for its share picture, and only its start', async () => {
  const share = '<meta property="og:image" content="https://example.com/owl.jpg">';
  const page = res => async u => (String(u).endsWith('/screenshot') ? new Response('', { status: 422 }) : res());
  assert.equal((await ask(env(), page(() => new Response(share, { headers: { 'Content-Type': 'application/json' } })))).og, null, 'not a page');
  assert.equal((await ask(env(), page(() => endless(share + 'x'.repeat(65536), 'text/html')))).og, 'https://example.com/owl.jpg', 'an endless page stops being read');
  assert.equal((await ask(env(), page(() => html('x'.repeat(400_000) + share)))).og, null, 'past the first 300 KB');
});

test('shot: a picture past 2 MB is none, and isn’t read to its end', async () => {
  const f = async u => (String(u).endsWith('/screenshot') ? endless('y'.repeat(65536), 'image/jpeg') : html(''));
  assert.deepEqual(await ask(env(), f), { og: null, why: 'failed' });
});

test('shot: with no picture and no share picture, nothing, and the reason', async () => {
  const f = cloudflare({ status: 422, html: '<html><head><title>Owls</title></head></html>' });
  assert.deepEqual(await ask(env(), f), { og: null, why: 'failed' });
  const down = async () => { throw new Error('down'); };
  assert.deepEqual(await ask(env(), down), { og: null, why: 'busy' });
  const odd = cloudflare({ status: 422, html: '<meta property="og:image" content="javascript:alert(1)">' });
  assert.deepEqual(await ask(env(), odd), { og: null, why: 'failed' }, 'only a web address');
});

test('shot: sites Cloudflare can’t reach are not pictured', async () => {
  const e = env({ STORE: memoryKV(counters(), { sites: '["localhost"]' }) }), f = cloudflare();
  const out = await pagePicture(e, { site: 'localhost', path: '/', origin: 'http://localhost:8787' }, f, T0);
  assert.deepEqual(out, { og: null, why: 'failed' });
  assert.equal(f.calls.length, 0);
});

/* ---------- the endpoint ---------- */

const call = (e, path, headers = {}) => worker.fetch(new Request(`https://lede.test${path}`, { headers }), e, { waitUntil() {} });

test('shot endpoint: only for someone signed in, like the stats', async () => {
  const res = await call(env({ DASHBOARD_PASSWORD: 'pw' }), '/api/shot?site=example.com&path=/owls');
  assert.equal(res.status, 401);
  assert.equal((await res.json()).signIn, true);
});

test('shot endpoint: the jpeg, kept by the browser for a while; otherwise what to show instead', async () => {
  const before = globalThis.fetch;
  try {
    globalThis.fetch = cloudflare();
    const res = await call(env(), '/api/shot?site=example.com&path=/owls');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
    assert.match(res.headers.get('Cache-Control'), /^private, max-age=\d+$/);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), JPEG);

    globalThis.fetch = cloudflare({ status: 403 });
    const none = await call(env(), '/api/shot?site=example.com&path=/owls');
    assert.equal(none.status, 200);
    assert.match(none.headers.get('Content-Type'), /json/);
    assert.deepEqual(await none.json(), { og: 'https://example.com/owl.jpg', why: 'permission' });
  } finally { globalThis.fetch = before; }
});

test('shot endpoint: a site Lede doesn’t count, or no page, is refused', async () => {
  assert.equal((await call(env(), '/api/shot?site=evil.com&path=/')).status, 400);
  assert.equal((await call(env(), '/api/shot?site=example.com')).status, 400);
  assert.equal((await call(env(), '/api/shot?site=example.com&path=owls')).status, 400);
});

test('shot endpoint: the demo shows a bundled picture of /owls, and Cloudflare is never asked', async () => {
  const before = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('no fetch in the demo'); };
    const e = env({ DEMO: 'true', ANALYTICS_TOKEN: undefined });
    const res = await call(e, '/api/shot?site=example.com&path=/owls');
    assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8], 'a jpeg');
    assert.ok(bytes.length < 16_000, `small, since every Worker carries it: ${bytes.length} bytes`);
    const other = await call(e, '/api/shot?site=example.com&path=/robin');
    assert.deepEqual(await other.json(), { og: null, why: 'budget' }, 'other pages show the plain column, as when the day’s browser time is spent');
  } finally { globalThis.fetch = before; }
});

test('bench: the fake Cloudflare answers screenshots and counts them and their browser time', async () => {
  const count = counters();
  const f = fakeFetch(count);
  const res = await f(SHOT_URL('acc'), { method: 'POST', body: JSON.stringify({ url: 'https://example.com/blog' }) });
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
  assert.ok(Number(res.headers.get('X-Browser-Ms-Used')) > 0);
  assert.equal(count.screenshots, 1);
  assert.equal(count.browserMs, Number(res.headers.get('X-Browser-Ms-Used')));
});
