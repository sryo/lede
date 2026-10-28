import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSite, getSites, addSite, getSalt, getAccountId, makeShare, stopShare, sharedSite } from '../src/settings.js';
import { handleApi } from '../src/api.js';
import { collect } from '../src/collect.js';

const memoryKV = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { m, get: async k => m.get(k) ?? null, put: async (k, v, opts) => { m.set(k, v); if (opts) m.set(`${k}#opts`, opts); }, delete: async k => { m.delete(k); } };
};
const call = (path, env, init) => handleApi(new Request(`https://worker.test/api/${path}`, init), env, { waitUntil() {} });

test('a site is typed as an address and kept as a bare hostname', () => {
  assert.equal(normalizeSite('https://www.Example.com/pricing?x=1'), 'example.com');
  assert.equal(normalizeSite('  blog.example.co.uk  '), 'blog.example.co.uk');
  assert.equal(normalizeSite('localhost:3000'), 'localhost');
  assert.equal(normalizeSite(''), null);
  assert.equal(normalizeSite('not a site'), null);
  assert.equal(normalizeSite('javascript:alert(1)'), null);
});

test('the first site added is saved once and makes the salt that hashes visitors', async () => {
  const env = { STORE: memoryKV() };
  assert.deepEqual(await getSites(env), []);
  assert.deepEqual(await addSite(env, 'https://example.com/'), ['example.com']);
  assert.deepEqual(await addSite(env, 'www.example.com'), ['example.com']);
  const key = `salt:${new Date().toISOString().slice(0, 7)}`;
  assert.match(env.STORE.m.get(key), /^[0-9a-f]{64}$/);
  const salt = env.STORE.m.get(key);
  await addSite(env, 'docs.example.com');
  assert.equal(env.STORE.m.get(key), salt);
  assert.deepEqual(await getSites(env), ['example.com', 'docs.example.com']);
});

test('the salt is made once and then reused', async () => {
  const env = { STORE: memoryKV() };
  const a = await getSalt(env), b = await getSalt({ STORE: env.STORE });
  assert.equal(a, b);
});

test('each month has its own salt, which deletes itself after the month', async () => {
  const store = memoryKV();
  const oct = await getSalt({ STORE: store }, new Date('2026-10-10T12:00:00Z'));
  const nov = await getSalt({ STORE: store }, new Date('2026-11-02T12:00:00Z'));
  assert.notEqual(oct, nov);
  assert.equal(store.m.get('salt:2026-10#opts').expiration, Date.UTC(2026, 10, 2) / 1000);
  // Late in the month, next month's salt is made ahead of time (another instance, without the first's copy).
  const elsewhere = { ...store };
  await getSalt({ STORE: elsewhere }, new Date('2026-11-27T12:00:00Z'));
  assert.match(store.m.get('salt:2026-12'), /^[0-9a-f]{64}$/);
  assert.equal(await getSalt({ STORE: elsewhere }, new Date('2026-12-01T00:00:00Z')), store.m.get('salt:2026-12'));
});

test('the old permanent secret keeps this month\'s visitor IDs, then is deleted', async () => {
  const store = memoryKV({ salt: 'old-secret' });
  const salt = await getSalt({ STORE: store }, new Date('2026-10-10T12:00:00Z'));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('old-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('2026-10'))).toString('hex');
  assert.equal(salt, derived);
  assert.equal(store.m.has('salt'), false);
});

test('the dashboard asks for a site, then answers for it', async () => {
  const env = { STORE: memoryKV(), DEMO: 'true' };
  const first = await call('sites', env);
  assert.equal(first.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await first.json(), { sites: [], demo: true, insight: true });
  const before = await call('summary?days=30', env);
  assert.equal(before.status, 400);
  assert.match((await before.json()).error, /site’s address/);

  const bad = await call('sites', env, { method: 'POST', body: JSON.stringify({ site: 'nope' }) });
  assert.equal(bad.status, 400);
  const added = await call('sites', env, { method: 'POST', body: JSON.stringify({ site: 'https://www.example.com' }) });
  assert.deepEqual(await added.json(), { sites: ['example.com'], demo: true, insight: true });
  assert.equal((await call('summary?days=30', env)).status, 200);
});

test('collect only counts sites that were added, hashing with the stored salt', async () => {
  const points = [];
  const env = { STORE: memoryKV(), EVENTS: { writeDataPoint: p => points.push(p) } };
  const send = () => collect(new Request('https://worker.test/lede', {
    method: 'POST',
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15', 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://example.com', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ u: 'https://example.com/', r: '', l: '' }),
  }), env);
  assert.equal((await send()).status, 204);
  assert.equal(points.length, 0);
  await addSite(env, 'example.com');
  await send();
  await send();
  assert.equal(points.length, 2);
  assert.equal(points[0].blobs[5], points[1].blobs[5]);
});

test('the account comes from the token when there is only one', async () => {
  const seen = [];
  const one = async (u, init) => { seen.push([u, init.headers.Authorization]); return new Response(JSON.stringify({ success: true, result: [{ id: 'acc1', name: 'Me' }] })); };
  const env = { STORE: memoryKV(), ANALYTICS_TOKEN: 'tok' };
  assert.equal(await getAccountId(env, one), 'acc1');
  assert.deepEqual(seen[0], ['https://api.cloudflare.com/client/v4/accounts', 'Bearer tok']);
  assert.equal(env.STORE.m.get('account'), 'acc1');
  assert.equal(await getAccountId({ STORE: env.STORE, ANALYTICS_TOKEN: 'tok' }, async () => { throw new Error('not again'); }), 'acc1');

  assert.equal(await getAccountId({ STORE: memoryKV(), ANALYTICS_TOKEN: 'tok', ACCOUNT_ID: 'set' }, one), 'set');

  const two = async () => new Response(JSON.stringify({ success: true, result: [{ id: 'a' }, { id: 'b' }] }));
  await assert.rejects(getAccountId({ STORE: memoryKV(), ANALYTICS_TOKEN: 'tok' }, two), /more than one account.*ACCOUNT_ID/);
});

test('a dashboard load reads the saved account once, not once per query', async () => {
  const store = memoryKV({ account: 'acc1' });
  let reads = 0;
  const get = store.get;
  store.get = k => { reads++; return get(k); };
  const env = { STORE: store, ANALYTICS_TOKEN: 'tok' };
  const ids = await Promise.all(Array.from({ length: 15 }, () => getAccountId(env)));
  assert.deepEqual(new Set(ids), new Set(['acc1']));
  assert.equal(await getAccountId(env), 'acc1');
  assert.equal(reads, 1);
});

test('a failed account lookup is tried again on the next query', async () => {
  const env = { STORE: memoryKV(), ANALYTICS_TOKEN: 'tok' };
  await assert.rejects(getAccountId(env, async () => new Response('{}')), /can’t see which account.*ANALYTICS_TOKEN/);
  const one = async () => new Response(JSON.stringify({ result: [{ id: 'acc1' }] }));
  assert.equal(await getAccountId(env, one), 'acc1');
});

test('goals are saved for everyone who opens the dashboard', async () => {
  const env = { STORE: memoryKV({ sites: '["example.com"]' }), DEMO: 'true' };
  assert.deepEqual((await (await call('goals?site=example.com', env)).json()).goals, []);
  const saved = await call('goals?site=example.com', env, { method: 'PUT', body: JSON.stringify({ goals: ['/signup', '/signup', '/thanks'] }) });
  assert.deepEqual(await saved.json(), { goals: ['/signup', '/thanks'] });
  assert.deepEqual((await (await call('goals?site=example.com', env)).json()).goals, ['/signup', '/thanks']);
  const bad = await call('goals?site=example.com', env, { method: 'PUT', body: JSON.stringify({ goals: ['signup'] }) });
  assert.equal(bad.status, 400);
});

test('goals are read as the pages Lede stores: no trailing slash, encoded as browsers send them', async () => {
  const env = { STORE: memoryKV({ sites: '["example.com"]' }) };
  const saved = await call('goals?site=example.com', env, { method: 'PUT', body: JSON.stringify({ goals: ['/Pricing/', '/café', '/caf%C3%A9', '/thanks?from=mail'] }) });
  assert.deepEqual(await saved.json(), { goals: ['/Pricing', '/caf%C3%A9', '/thanks'] });
  const long = await call('goals?site=example.com', env, { method: 'PUT', body: JSON.stringify({ goals: ['/' + 'é'.repeat(40)] }) });
  assert.equal(long.status, 400, '40 characters, but 240 once encoded');
  assert.match((await long.json()).error, /up to 200 characters, where an accented letter counts as six/);
});

test('goals and funnels saved by an older version are read as they would be saved now, so no card fails on every load', async () => {
  const settings = {
    goals: ['/signup/', '/signup', '/' + 'x'.repeat(300), 'nope'],
    funnels: [['/pricing', '/pricing/'], ['/a', '/b/', '/' + 'é'.repeat(40)], ['/a/', '/b'], ['/c', '/d']],
  };
  const env = { STORE: memoryKV({ sites: '["example.com"]', 'settings:example.com': JSON.stringify(settings) }) };
  const read = await (await call('goals?site=example.com', env)).json();
  assert.deepEqual(read.goals, ['/signup']);
  assert.deepEqual(read.funnels, [['/a', '/b'], ['/c', '/d']], 'one page twice is no funnel; a step too long is left out');
  assert.deepEqual((await (await call('funnels?site=example.com', env)).json()).funnels, read.funnels);
  // What the dashboard sends back as it opens is accepted.
  const goals = read.goals.map(g => `goal=${encodeURIComponent(g)}`).join('&');
  for (const f of read.funnels) assert.equal((await call(`funnel?site=example.com&${f.map(s => `steps=${encodeURIComponent(s)}`).join('&')}`, { ...env, DEMO: 'true' })).status, 200);
  assert.equal((await call(`conversions?site=example.com&${goals}`, { ...env, DEMO: 'true' })).status, 200);
});

test('goals, funnels and notes share one key per site; the old keys move there the first time they are read', async () => {
  const STORE = memoryKV({ sites: '["example.com"]', 'goals:example.com': '["/signup"]', 'notes:example.com': '[{"day":"2026-10-16","text":"Hi"}]' });
  let reads = 0;
  const get = STORE.get;
  STORE.get = k => (reads++, get(k));
  const env = { STORE };
  assert.deepEqual(await (await call('goals?site=example.com', env)).json(), { goals: ['/signup'], funnels: [], notes: [{ day: '2026-10-16', text: 'Hi' }] });
  assert.deepEqual(JSON.parse(STORE.m.get('settings:example.com')), { goals: ['/signup'], notes: [{ day: '2026-10-16', text: 'Hi' }] }, 'so the weekly message reads one key');
  await call('funnels?site=example.com', env, { method: 'PUT', body: JSON.stringify({ funnels: [['/', '/signup']] }) });
  assert.deepEqual(JSON.parse(STORE.m.get('settings:example.com')), { goals: ['/signup'], notes: [{ day: '2026-10-16', text: 'Hi' }], funnels: [['/', '/signup']] });
  reads = 0;
  assert.deepEqual(await (await call('goals?site=example.com', env)).json(), { goals: ['/signup'], funnels: [['/', '/signup']], notes: [{ day: '2026-10-16', text: 'Hi' }] });
  assert.equal(reads, 1, 'the sites come from the isolate\'s copy, and the settings are one read');
});

test('stats read the sites once a minute per isolate, and again at once for a site just added or when the dashboard asks for them', async () => {
  const STORE = memoryKV({ sites: '["a.example"]' });
  let reads = 0;
  const get = STORE.get;
  STORE.get = k => (k === 'sites' && reads++, get(k));
  const env = { STORE, DEMO: 'true' };
  const together = await Promise.all([0, 1, 2].map(i => call(`summary?site=a.example&n=${i}`, env)));
  assert.ok(together.every(r => r.status === 200));
  assert.equal(reads, 1, 'requests arriving together share one read');
  assert.equal((await call('summary?site=a.example&n=3', env)).status, 200);
  assert.equal(reads, 1);
  STORE.m.set('sites', '["a.example","b.example"]');
  assert.equal((await call('summary?site=b.example', env)).status, 200, 'not in the copy, so read again');
  assert.equal(reads, 2);
  assert.equal((await call('summary?site=c.example', env)).status, 400);
  reads = 0;
  await call('sites', env);
  await call('summary?site=a.example&n=4', env);
  assert.equal(reads, 1, 'the dashboard\'s own read of the sites is kept for the stats after it');
});

test('notes on days are saved for everyone, one per day, and each change is one write', async () => {
  const env = { STORE: memoryKV({ sites: '["example.com"]' }) };
  let writes = 0;
  const put = env.STORE.put;
  env.STORE.put = (...a) => { writes++; return put(...a); };
  const notes = async (q = '', init) => (await call(`notes?site=example.com${q}`, env, init)).json();
  const save = body => notes('', { method: 'PUT', body: JSON.stringify(body) });
  assert.deepEqual(await notes(), { notes: [] });
  assert.deepEqual(await save({ day: '2026-10-16', text: '  Posted on Hacker News ' }), { notes: [{ day: '2026-10-16', text: 'Posted on Hacker News' }] });
  await save({ day: '2026-10-02', text: 'New homepage' });
  assert.deepEqual(await save({ day: '2026-10-16', text: 'Posted on Hacker News again' }), { notes: [
    { day: '2026-10-02', text: 'New homepage' }, { day: '2026-10-16', text: 'Posted on Hacker News again' }] });
  assert.equal(writes, 3);
  await save({ day: '2026-10-16', text: 'Posted on Hacker News again' });
  assert.equal(writes, 3, 'saving the same note again writes nothing');
  assert.deepEqual(await notes('&day=2026-10-02', { method: 'DELETE' }), { notes: [{ day: '2026-10-16', text: 'Posted on Hacker News again' }] });
  await notes('&day=2026-10-03', { method: 'DELETE' });
  assert.equal(writes, 4, 'removing a note that is not there writes nothing');
  assert.deepEqual(await notes(), { notes: [{ day: '2026-10-16', text: 'Posted on Hacker News again' }] });
  // The dashboard reads goals, notes and funnels with one request.
  assert.deepEqual(await (await call('goals?site=example.com', env)).json(), { goals: [], notes: [{ day: '2026-10-16', text: 'Posted on Hacker News again' }], funnels: [] });
});

test('a note is a real day and a few words, at most 80 characters', async () => {
  const env = { STORE: memoryKV({ sites: '["example.com"]' }) };
  const save = async body => call('notes?site=example.com', env, { method: 'PUT', body: JSON.stringify(body) });
  for (const bad of [{ day: '2026-13-01', text: 'x' }, { day: '16/10/2026', text: 'x' }, { day: '2026-10-16', text: '   ' },
    { day: '2026-10-16', text: 'x'.repeat(81) }, { day: '2026-10-16', text: 42 }, {}]) {
    const res = await save(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match((await res.json()).error, /note/i);
  }
  assert.equal((await save({ day: '2026-10-16', text: 'é'.repeat(80) })).status, 200);
  assert.equal((await call('notes?site=example.com', env, { method: 'DELETE' })).status, 400);
});

test('only the newest 100 notes are kept, since stats only go back three months', async () => {
  const days = Array.from({ length: 101 }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 864e5).toISOString().slice(0, 10));
  const env = { STORE: memoryKV({ sites: '["example.com"]', 'notes:example.com': JSON.stringify(days.slice(1).map(day => ({ day, text: 'x' }))) }) };
  const res = await call('notes?site=example.com', env, { method: 'PUT', body: JSON.stringify({ day: days[0], text: 'oldest' }) });
  const { notes } = await res.json();
  assert.equal(notes.length, 100);
  assert.ok(!notes.some(n => n.text === 'oldest'));
});

test('the demo starts with a note on its busy day, until the owner changes the notes', async () => {
  const env = { STORE: memoryKV({ sites: '["example.com"]' }), DEMO: 'true' };
  const { notes } = await (await call('notes?site=example.com&days=30', env)).json();
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /Facebook/);
  const after = await (await call('notes?site=example.com', env, { method: 'PUT', body: JSON.stringify({ day: '2026-10-02', text: 'New homepage' }) })).json();
  assert.equal(after.notes.length, 2);
});

test('stats explain a missing token instead of failing silently', async () => {
  const res = await call('summary', { STORE: memoryKV({ sites: '["example.com"]' }) });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /ANALYTICS_TOKEN/);
});

test('a share link is 24 random bytes in base64url, kept with its site in one KV key', async () => {
  const env = { STORE: memoryKV({ sites: '["a.com"]' }) };
  const share = await makeShare(env, 'a.com');
  assert.match(share.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(share.site, 'a.com');
  assert.notEqual((await makeShare(env, 'a.com')).token, share.token);
  assert.equal(Object.keys(JSON.parse(env.STORE.m.get('shares'))).length, 2);
  assert.equal(await sharedSite(env, share.token), 'a.com');
  await stopShare(env, share.token);
  assert.equal(await sharedSite(env, share.token), null);
});
