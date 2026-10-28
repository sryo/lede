import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

// Workers has this; Node doesn't.
crypto.subtle.timingSafeEqual ??= (a, b) => Buffer.from(a).equals(Buffer.from(b));

const kv = () => {
  const m = new Map([['sites', '["example.com"]']]);
  return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } };
};
const env = (extra = {}) => ({ DASHBOARD_PASSWORD: 'pw', DEMO: 'true', STORE: kv(), ASSETS: { fetch: async () => new Response('page') }, ...extra });
const call = (e, path, init = {}) => worker.fetch(new Request(`https://lede.test${path}`, init), e, { waitUntil() {} });
const signIn = (e, password, headers = {}) => call(e, '/api/signin', {
  method: 'POST', headers: { Origin: 'https://lede.test', ...headers }, body: JSON.stringify({ password }),
});
const cookieOf = res => (res.headers.get('Set-Cookie') || '').split(';')[0];

test('without the password the stats answer 401 and the browser shows no sign-in box of its own', async () => {
  const res = await call(env(), '/api/sites');
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('WWW-Authenticate'), null);
  assert.deepEqual(await res.json(), { error: 'Enter your password.', signIn: true });
});

test('the right password sets a cookie that opens the stats; a wrong one says so', async () => {
  const e = env();
  const wrong = await signIn(e, 'nope');
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, 'That’s not the password. Try again.');
  assert.equal(wrong.headers.get('Set-Cookie'), null);

  const right = await signIn(e, 'pw');
  assert.equal(right.status, 204);
  assert.match(right.headers.get('Set-Cookie'), /^lede=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
  const res = await call(e, '/api/sites', { headers: { Cookie: `other=1; ${cookieOf(right)}` } });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray((await res.json()).sites));
});

test('changing the password signs everyone out', async () => {
  const cookie = cookieOf(await signIn(env(), 'pw'));
  assert.equal((await call(env({ DASHBOARD_PASSWORD: 'new' }), '/api/sites', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await call(env(), '/api/sites', { headers: { Cookie: 'lede=' + '0'.repeat(64) } })).status, 401);
});

test('signing in only works from the dashboard itself', async () => {
  assert.equal((await signIn(env(), 'pw', { Origin: 'https://evil.test' })).status, 403);
});

test('the dashboard page, the tracker beacon and an open dashboard need no password', async () => {
  assert.equal(await (await call(env(), '/bounce')).text(), 'page');
  assert.notEqual((await call(env(), '/lede', { method: 'POST', body: '{}' })).status, 401);
  const open = env({ DASHBOARD_PASSWORD: undefined });
  assert.equal((await call(open, '/api/sites')).status, 200);
  assert.equal((await signIn(open, 'anything')).status, 204);
});

test('an empty password, or only spaces, counts as none', async () => {
  for (const DASHBOARD_PASSWORD of ['', '  ']) {
    assert.equal((await call(env({ DASHBOARD_PASSWORD }), '/api/sites')).status, 200);
    const res = await signIn(env({ DASHBOARD_PASSWORD }), '');
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Set-Cookie'), null);
  }
});

const from = ip => ({ 'CF-Connecting-IP': ip });

test('after 10 wrong passwords from one address, it waits 10 minutes, even for the right one', async () => {
  const e = env();
  for (let i = 0; i < 10; i++) assert.equal((await signIn(e, `guess${i}`, from('203.0.113.7'))).status, 401);
  const stopped = await signIn(e, 'pw', from('203.0.113.7'));
  assert.equal(stopped.status, 429);
  assert.equal((await stopped.json()).error, 'Too many wrong passwords. Try again in 10 minutes.');
  assert.ok(Number(stopped.headers.get('Retry-After')) > 590);
  assert.equal(stopped.headers.get('Set-Cookie'), null);
  assert.equal((await signIn(e, 'pw', from('198.51.100.2'))).status, 204, 'another address still signs in');
  const now = Date.now;
  try {
    Date.now = () => now() + 10 * 60_000;
    assert.equal((await signIn(e, 'pw', from('203.0.113.7'))).status, 204, 'ten minutes later');
  } finally { Date.now = now; }
});

test('signing in clears the wrong tries before it', async () => {
  const e = env();
  for (let i = 0; i < 9; i++) await signIn(e, 'nope', from('192.0.2.9'));
  assert.equal((await signIn(e, 'pw', from('192.0.2.9'))).status, 204);
  for (let i = 0; i < 9; i++) assert.equal((await signIn(e, 'nope', from('192.0.2.9'))).status, 401);
});

test('Cloudflare’s rate limiter, when bound, counts sign-ins too, by a hash of the address', async () => {
  const keys = [];
  const e = env({ SIGNIN_LIMIT: { limit: async ({ key }) => (keys.push(key), { success: keys.length < 2 }) } });
  assert.equal((await signIn(e, 'pw', from('192.0.2.50'))).status, 204);
  const res = await signIn(e, 'pw', from('192.0.2.50'));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '60');
  assert.match(keys[0], /^[0-9a-f]{64}$/);
  assert.ok(!keys[0].includes('192.0.2.50'));
});

test('signing out clears the cookie, and only from the dashboard', async () => {
  const out = await call(env(), '/api/signout', { method: 'POST', headers: { Origin: 'https://lede.test' } });
  assert.equal(out.status, 204);
  assert.match(out.headers.get('Set-Cookie'), /^lede=; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=0$/);
  assert.equal((await call(env(), '/api/signout', { method: 'POST', headers: { Origin: 'https://evil.test' } })).status, 403);
});
