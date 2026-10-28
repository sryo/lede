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
  const e = env(), f = cloudflare({ ms: 60_000 });
  for (let i = 0; i < 5; i++) assert.ok((await ask(e, f, `/p${i}`)).jpeg, `picture ${i + 1}`);
  assert.equal(BUDGET_MS, 5 * 60_000);
  const spent = await ask(e, f, '/p5');
  assert.equal(f.shots(), 5, 'no sixth picture');
  assert.equal(spent.jpeg, undefined);
  assert.equal(spent.why, 'budget');
  assert.equal(spent.og, 'https://example.com/owl.jpg', 'the page’s own share picture instead');
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

test('shot: any other failure falls back the same way', async () => {
  const e = env(), f = cloudflare({ status: 500 });
  assert.deepEqual(await ask(e, f), { og: 'https://example.com/owl.jpg', why: 'failed' });
  const thrown = async u => { if (String(u).endsWith('/screenshot')) throw new Error('network'); return new Response('<meta content="/img/share.png" property="og:image">'); };
  assert.deepEqual(await ask(env(), thrown), { og: 'https://example.com/img/share.png', why: 'failed' }, 'a relative share picture is read against the page');
});

test('shot: with no picture and no share picture, nothing, and the reason', async () => {
  const f = cloudflare({ status: 500, html: '<html><head><title>Owls</title></head></html>' });
  assert.deepEqual(await ask(env(), f), { og: null, why: 'failed' });
  const down = async () => { throw new Error('down'); };
  assert.deepEqual(await ask(env(), down), { og: null, why: 'failed' });
  const odd = cloudflare({ status: 500, html: '<meta property="og:image" content="javascript:alert(1)">' });
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
