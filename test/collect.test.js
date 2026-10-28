import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent, identify, visitHour, collect, senderCap, SENDER_LIMIT, SENDER_WINDOW } from '../src/collect.js';
import { channelFor } from '../src/channels.js';
import { FIELDS } from '../src/schema.js';

const SITES = ['example.com'];
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';
// What a browser sends with the tracker's sendBeacon.
const BEACON = { 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://example.com', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Accept-Language': 'en-GB,en;q=0.9' };

test('drops events from sites that are not listed', () => {
  assert.equal(parseEvent({ u: 'https://evil.test/' }, SITES), null);
  assert.equal(parseEvent({ u: 'not a url' }, SITES), null);
  assert.equal(parseEvent({}, SITES), null);
});

test('normalizes host, path and query', () => {
  const ev = parseEvent({ u: 'https://www.example.com/pricing/?plan=pro&utm_source=x&gclid=1', r: '', l: '' }, SITES);
  assert.equal(ev.site, 'example.com');
  assert.equal(ev.path, '/pricing');
  assert.equal(ev.url, '/pricing?plan=pro');
});

test('ignores self-referrals and strips www from referrers', () => {
  assert.equal(parseEvent({ u: 'https://example.com/a', r: 'https://www.example.com/' }, SITES).referrer, '');
  assert.equal(parseEvent({ u: 'https://example.com/a', r: 'https://www.google.com/search?q=x' }, SITES).referrer, 'google.com');
});

test('keeps the landing page UTM tags on every page of the visit', () => {
  const ev = parseEvent({ u: 'https://example.com/docs', r: 'https://news.ycombinator.com/', l: '?utm_source=HN&utm_campaign=launch' }, SITES);
  assert.equal(ev.utmSource, 'hn');
  assert.equal(ev.utmCampaign, 'launch');
  assert.equal(ev.channel, 'social');
});

test('classifies channels', () => {
  const q = s => new URLSearchParams(s);
  assert.equal(channelFor('', q('')), 'direct');
  assert.equal(channelFor('google.co.uk', q('')), 'search');
  assert.equal(channelFor('gemini.google.com', q('')), 'ai');
  assert.equal(channelFor('chatgpt.com', q('')), 'ai');
  assert.equal(channelFor('', q('utm_source=chatgpt.com')), 'ai');
  assert.equal(channelFor('google.com', q('gclid=abc')), 'paid');
  assert.equal(channelFor('', q('utm_medium=email')), 'email');
  assert.equal(channelFor('t.co', q('')), 'social');
  assert.equal(channelFor('youtube.com', q('')), 'video');
  assert.equal(channelFor('someblog.dev', q('')), 'referral');
  assert.equal(channelFor('notgoogle.com', q('')), 'referral');
});

test('visitor IDs follow the salt, and visits are scoped to the hour they started', async () => {
  const a = await identify('october', 'example.com', '1.2.3.4', 'UA', new Date('2026-10-05T10:15:00Z'));
  const b = await identify('october', 'example.com', '1.2.3.4', 'UA', new Date('2026-10-20T11:45:00Z'));
  const c = await identify('november', 'example.com', '1.2.3.4', 'UA', new Date('2026-11-01T10:15:00Z'));
  assert.equal(a.visitor, b.visitor);
  assert.notEqual(a.visit, b.visit);
  assert.notEqual(a.visitor, c.visitor);
  assert.match(a.visitor, /^[0-9a-f]{32}$/);
  // A visit that started at 10:00 and is still going at 11:05 keeps its ID.
  const later = new Date('2026-10-05T11:05:00Z');
  const d = await identify('october', 'example.com', '1.2.3.4', 'UA', later, visitHour(Date.parse('2026-10-05T10:00:00Z'), later));
  assert.equal(d.visit, a.visit);
});

test('the visit hour from the tracker is only trusted when it makes sense', () => {
  const now = new Date('2026-10-05T11:05:00Z'), hour = Date.parse('2026-10-05T10:00:00Z');
  assert.equal(visitHour(hour, now).getTime(), hour);
  assert.equal(visitHour(hour + 1, now), now, 'not on the hour');
  assert.equal(visitHour(hour + 2 * 3600e3, now), now, 'in the future');
  assert.equal(visitHour(hour - 2 * 86400e3, now), now, 'too long ago');
  assert.equal(visitHour('10', now), now);
  assert.equal(visitHour(undefined, now), now);
});

test('collect writes one data point in schema order and skips bots', async () => {
  const points = [];
  const kv = new Map([['sites', '["example.com"]'], ['salt', 's']]);
  const env = { STORE: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) }, EVENTS: { writeDataPoint: p => points.push(p) } };
  const req = ua => new Request('https://worker.test/api/event', {
    method: 'POST',
    headers: { ...BEACON, 'User-Agent': ua, 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ u: 'https://example.com/pricing', r: 'https://duckduckgo.com/', l: '' }),
  });
  assert.equal((await collect(req(SAFARI), env)).status, 204);
  assert.equal((await collect(req('Googlebot/2.1'), env)).status, 204);
  assert.equal(points.length, 1);
  const p = points[0];
  assert.deepEqual(p.indexes, ['example.com']);
  assert.equal(p.blobs.length, FIELDS.length);
  const row = Object.fromEntries(FIELDS.map((f, i) => [f, p.blobs[i]]));
  assert.equal(row.path, '/pricing');
  assert.equal(row.referrer, 'duckduckgo.com');
  assert.equal(row.channel, 'search');
  assert.equal(row.type, 'pageview');
});

test('one source keeps one name across redirectors, mobile hosts and Android apps', () => {
  const ref = r => parseEvent({ u: 'https://example.com/', r }, SITES);
  assert.equal(ref('https://l.facebook.com/l.php?u=x').referrer, 'facebook.com');
  assert.equal(ref('https://t.co/abc').referrer, 'x.com');
  assert.equal(ref('https://old.reddit.com/r/birds').referrer, 'reddit.com');
  assert.equal(ref('android-app://com.google.android.gm/').channel, 'email');
  assert.equal(ref('android-app://com.google.android.googlequicksearchbox/').referrer, 'google.com');
  assert.equal(ref('not a url').referrer, '');
});

test('collect drops oversized bodies and headless browsers', async () => {
  const points = [];
  const kv = new Map([['sites', '["example.com"]'], ['salt', 's']]);
  const env = { STORE: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) }, EVENTS: { writeDataPoint: p => points.push(p) } };
  const req = (ua, body) => new Request('https://worker.test/api/event', { method: 'POST', headers: { ...BEACON, 'User-Agent': ua }, body });
  const ok = JSON.stringify({ u: 'https://example.com/' });
  const browser = SAFARI;
  assert.equal((await collect(req(browser, JSON.stringify({ u: 'https://example.com/?' + 'a'.repeat(9000) })), env)).status, 413);
  await collect(req('Mozilla/5.0', ok), env);
  await collect(new Request('https://worker.test/lede', { method: 'POST', headers: { ...BEACON, 'User-Agent': browser, Origin: 'https://copy.test' }, body: ok }), env);
  assert.equal(points.length, 0);
  await collect(new Request('https://worker.test/lede', { method: 'POST', headers: { ...BEACON, 'User-Agent': browser, Origin: 'https://www.example.com' }, body: ok }), env);
  assert.equal(points.length, 1);
  points.length = 0;
  await collect(req('Mozilla/5.0 (X11) HeadlessChrome/120', ok), env);
  await collect(req('facebookexternalhit/1.1', ok), env);
  assert.equal(points.length, 0);
});

test('engagement keeps its figures in range, and anything odd about it drops the event', () => {
  const ev = body => parseEvent({ u: 'https://example.com/docs/', t: 'engagement', ...body }, SITES);
  const ok = ev({ e: 4200.4, s: 63.6 });
  assert.deepEqual([ok.type, ok.path, ok.engaged, ok.scroll], ['engagement', '/docs', 4200, 64]);
  assert.equal(ev({ e: 5 * 3600e3, s: 250 }).engaged, 30 * 60e3, 'a tab left open stops counting at 30 minutes');
  assert.equal(ev({ e: 2000, s: 250 }).scroll, 100);
  assert.equal(ev({ e: 2000, s: -3 }).scroll, 0);
  assert.equal(ev({ e: 400, s: 50 }), null, 'under a second');
  assert.equal(ev({ e: '4000', s: 50 }), null);
  assert.equal(ev({ e: 4000 }), null);
  assert.equal(ev({ e: Infinity, s: 50 }), null);
  assert.equal(parseEvent({ u: 'https://example.com/', t: 'purchase' }, SITES), null, 'unknown types');
  assert.equal(parseEvent({ u: 'https://example.com/' }, SITES).type, 'pageview', 'older trackers send no type');
});

test('a ping says someone is still on a page, and carries nothing else', () => {
  const ev = parseEvent({ u: 'https://example.com/docs/?ref=x', t: 'ping', r: 'https://news.ycombinator.com/', e: 9000, o: 'https://a.test/' }, SITES);
  assert.deepEqual([ev.type, ev.path, ev.referrer, ev.engaged, ev.target], ['ping', '/docs', 'news.ycombinator.com', undefined, undefined]);
});

test('link clicks keep only the host and path of the link', () => {
  const ev = (t, o) => parseEvent({ u: 'https://example.com/docs', t, o }, SITES);
  assert.equal(ev('outbound', 'https://www.GitHub.com/acme/repo/?token=x').target, 'github.com/acme/repo');
  assert.equal(ev('download', 'https://example.com/files/guide.pdf').target, 'example.com/files/guide.pdf');
  assert.equal(ev('outbound', 'https://www.example.com/pricing'), null, 'a link within the site is not outbound');
  assert.equal(ev('outbound', 'javascript:alert(1)'), null);
  assert.equal(ev('outbound', 'not a url'), null);
  assert.equal(ev('download', undefined), null);
  assert.equal(ev('outbound', 'https://a.test/' + 'x'.repeat(3000)), null);
});

test('collect writes engagement as doubles and the link in its own blob, hashed like a page view', async () => {
  const points = [];
  const kv = new Map([['sites', '["example.com"]'], ['salt', 's']]);
  const env = { STORE: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) }, EVENTS: { writeDataPoint: p => points.push(p) } };
  const send = body => collect(new Request('https://worker.test/lede', {
    method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) Safari/605', 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify({ u: 'https://example.com/docs', ...body }),
  }), env);
  await send({});
  await send({ t: 'engagement', e: 12000, s: 80 });
  await send({ t: 'download', o: 'https://example.com/files/guide.pdf' });
  assert.equal(points.length, 3);
  const rows = points.map(p => Object.fromEntries(FIELDS.map((f, i) => [f, p.blobs[i]])));
  assert.deepEqual(FIELDS.slice(12), ['target', 'device', 'browser', 'utmTerm'], 'new fields go at the end, so stored rows keep their layout');
  assert.deepEqual(rows.map(r => r.type), ['pageview', 'engagement', 'download']);
  assert.deepEqual(points.map(p => p.doubles), [[0, 0], [12000, 80], [0, 0]]);
  assert.deepEqual(rows.map(r => r.target), ['', '', 'example.com/files/guide.pdf']);
  assert.ok(rows.every(r => r.visitor === rows[0].visitor && r.visit === rows[0].visit && r.path === '/docs'));
});

test('the sender cap lets everything under the limit through', () => {
  const allow = senderCap({ limit: 60, window: 60e3, max: 100 });
  for (let i = 0; i < 60; i++) assert.equal(allow('a', i * 100), true, `event ${i + 1}`);
});

test('the sender cap cuts a burst over the limit, and starts again with the next window', () => {
  const allow = senderCap({ limit: 60, window: 60e3, max: 100 });
  const sent = Array.from({ length: 500 }, (_, i) => allow('a', 1000 + i)).filter(Boolean).length;
  assert.equal(sent, 60);
  assert.equal(allow('a', 1000 + 59_999), false, 'still the same minute');
  assert.equal(allow('a', 1000 + 60e3), true, 'a new minute');
});

test('the sender cap counts each sender on its own', () => {
  const allow = senderCap({ limit: 3, window: 60e3, max: 100 });
  for (let i = 0; i < 3; i++) allow('a', 0);
  assert.equal(allow('a', 0), false);
  assert.equal(allow('b', 0), true);
});

test('the sender cap remembers a bounded number of senders', () => {
  const allow = senderCap({ limit: 1, window: 60e3, max: 50 });
  for (let i = 0; i < 10_000; i++) allow('s' + i, i);
  assert.ok(allow.size() <= 50, `remembers ${allow.size()}`);
  // The newest senders are the ones kept.
  assert.equal(allow('s9999', 10_000), false);
});

test('the sender cap never cuts a person reading, even a fast one', () => {
  const allow = senderCap({ limit: SENDER_LIMIT, window: SENDER_WINDOW, max: 100 });
  // An hour of reading: a page every 5 s for the first minute (each a view and an engagement event),
  // four link clicks, one page left open with a ping every 3 minutes, and 20 restored tabs at once.
  const times = [];
  for (let s = 0; s < 60; s += 5) times.push(s * 1e3, s * 1e3 + 4e3);
  times.push(10e3, 20e3, 30e3, 40e3);
  for (let m = 3; m < 60; m += 3) times.push(m * 60e3);
  for (let i = 0; i < 20; i++) times.push(30 * 60e3 + i * 50);
  times.sort((a, b) => a - b);
  assert.ok(times.every(t => allow('reader', t)));
});

test('collect answers a sender over the cap like any dropped beacon, and writes nothing', async () => {
  const points = [];
  const kv = new Map([['sites', '["example.com"]'], ['salt', 's']]);
  const env = { STORE: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) }, EVENTS: { writeDataPoint: p => points.push(p) } };
  const send = ip => collect(new Request('https://worker.test/lede', {
    method: 'POST', headers: { ...BEACON, 'User-Agent': SAFARI, 'CF-Connecting-IP': ip }, body: JSON.stringify({ u: 'https://example.com/' }),
  }), env);
  const answers = [];
  for (let i = 0; i < SENDER_LIMIT + 40; i++) answers.push((await send('203.0.113.9')).status);
  assert.ok(answers.every(s => s === 204));
  assert.equal(points.length, SENDER_LIMIT);
  await send('203.0.113.10');
  assert.equal(points.length, SENDER_LIMIT + 1, 'another sender still counts');
});

test('collect also asks the Workers rate limiter when one is bound', async () => {
  const points = [], keys = [];
  const kv = new Map([['sites', '["example.com"]'], ['salt', 's']]);
  const env = {
    STORE: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) }, EVENTS: { writeDataPoint: p => points.push(p) },
    BEACON_LIMIT: { limit: async ({ key }) => (keys.push(key), { success: keys.length < 2 }) },
  };
  const send = () => collect(new Request('https://worker.test/lede', {
    method: 'POST', headers: { ...BEACON, 'User-Agent': SAFARI, 'CF-Connecting-IP': '198.51.100.7' }, body: JSON.stringify({ u: 'https://example.com/' }),
  }), env);
  assert.equal((await send()).status, 204);
  assert.equal((await send()).status, 204);
  assert.equal(points.length, 1);
  assert.match(keys[0], /^[0-9a-f]{8,14}$/, 'the key is a hash, not the address');
  assert.ok(!keys[0].includes('198.51'));
  assert.equal(keys[0], keys[1]);
});
