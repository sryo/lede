import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent, identify, visitHour, visitSalt, collect, scrubPath, senderCap, SENDER_LIMIT, ADDRESS_LIMIT, SENDER_WINDOW } from '../src/collect.js';
import { channelFor } from '../src/channels.js';
import { FIELDS, NUMBERS } from '../src/schema.js';

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
  assert.equal(ev.url, '/pricing');
});

test('a page address keeps only the word searched for, cleaned as search words are', () => {
  const url = u => parseEvent({ u: 'https://example.com' + u }, SITES).url;
  assert.equal(url('/search?q=Owl++Calls&page=2&session=abc123'), '/search?q=owl+calls');
  assert.equal(url('/find?query=robin&email=a%40b.co#top'), '/find?q=robin');
  assert.equal(url('/reset?token=9f8e7d6c5b4a&email=a%40b.co'), '/reset', 'a reset link keeps nothing of its query');
  assert.equal(url('/search?q=call+me+on+0612345678'), '/search', 'a word that could name someone is dropped');
  assert.equal(url('/search?q=a@b.co'), '/search');
  assert.equal(url('/verify?s=f3a9bc0de1f2a3b4c5d6e7f8a9b0c1d2'), '/verify', 'a token in a search parameter is dropped');
  assert.equal(url('/login?k=Xk9mQ2pL7vR4tY8wZ3bNaQ'), '/login', 'mixed case is checked before it is lowercased');
  assert.equal(url('/search?s=Release+Notes+2026'), '/search?q=release+notes+2026');
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

test('without a referrer, the landing page\'s source tag says where the visit came from', () => {
  const ev = (l, r = '') => parseEvent({ u: 'https://example.com/', r, l }, SITES);
  assert.deepEqual([ev('?utm_source=fb').referrer, ev('?utm_source=fb').channel], ['facebook.com', 'social']);
  assert.deepEqual([ev('?source=Newsletter').referrer, ev('?source=Newsletter').channel, ev('?source=Newsletter').utmSource], ['newsletter', 'referral', 'newsletter']);
  assert.deepEqual([ev('?ref=hn').referrer, ev('?ref=hn').channel], ['news.ycombinator.com', 'social']);
  assert.equal(ev('?utm_source=www.Google.co.uk').referrer, 'google.com');
  assert.equal(ev('?utm_source=chatgpt.com').channel, 'ai');
  assert.equal(ev('?utm_source=fb', 'https://news.ycombinator.com').referrer, 'news.ycombinator.com', 'a referrer wins over the tag');
  assert.equal(ev('?utm_source=example.com').referrer, '', 'the site itself is not a source');
  assert.equal(ev('?utm_source=' + encodeURIComponent('me@mail.com hi')).referrer, '', 'only a plain word or host');
  assert.equal(ev('?utm_source=' + 'a'.repeat(80)).referrer, '');
  assert.deepEqual([ev('').referrer, ev('').channel], ['', 'direct']);
  assert.equal(ev('&utm_medium=email&utm_source=digest').channel, 'email', 'the tags as the tracker sends them, picked out of the query');
});

test('one search engine, app or mail service is one source, wherever it sends from', () => {
  const ev = r => parseEvent({ u: 'https://example.com/', r }, SITES);
  const ref = r => ev(r).referrer;
  assert.deepEqual(['https://www.google.co.uk/', 'https://google.de', 'https://www.google.com.br/'].map(ref), ['google.com', 'google.com', 'google.com']);
  assert.deepEqual(['https://yandex.com.tr/', 'https://yandex.kz/', 'https://ya.ru/'].map(ref), ['yandex.ru', 'yandex.ru', 'yandex.ru']);
  assert.equal(ev('https://ya.ru/').channel, 'search');
  assert.equal(ref('https://t.me/'), 'telegram.org');
  assert.equal(ref('https://l.threads.com/'), 'threads.com');
  assert.equal(ref('https://go.bsky.app/'), 'bsky.app');
  assert.deepEqual([ref('https://pplx.ai/'), ev('https://pplx.ai/').channel], ['perplexity.ai', 'ai']);
  assert.deepEqual([ref('https://nam12.safelinks.protection.outlook.com/'), ev('https://nam12.safelinks.protection.outlook.com/').channel], ['outlook.office.com', 'email']);
  assert.equal(ev('https://teams.microsoft.com/').channel, 'email');
  assert.equal(ref('https://sites.google.com/'), 'sites.google.com', 'a site on Google Sites is its own source');
  assert.equal(ev('https://sites.google.com/').channel, 'referral');
  assert.equal(ev('https://news.yahoo.com/').channel, 'referral');
  assert.equal(ev('https://search.yahoo.com/').channel, 'search');
  assert.equal(ref('https://google.example.org/'), 'google.example.org', 'only Google\'s own domains');
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
  assert.equal(channelFor('', q('utm_source=youtube')), 'video', 'the source tag counts for every channel');
  assert.equal(channelFor('', q('utm_source=gmail')), 'email');
  assert.equal(channelFor('', q('utm_source=bing')), 'search');
  assert.equal(channelFor('', q('li_fat_id=1')), 'paid');
  assert.equal(channelFor('', q('twclid=1')), 'paid');
  assert.equal(channelFor('', q('dclid=1')), 'paid');
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

test('the visit start from the tracker is only trusted when it makes sense', () => {
  const now = new Date('2026-10-05T11:05:00Z'), hour = Date.parse('2026-10-05T10:00:00Z'), thisHour = Date.parse('2026-10-05T11:00:00Z');
  assert.equal(visitHour(hour, now).getTime(), hour);
  assert.equal(visitHour(hour + 17 * 60e3, now).getTime(), hour + 17 * 60e3, 'a minute');
  assert.equal(visitHour(hour + 1, now).getTime(), thisHour, 'not on the minute');
  assert.equal(visitHour(hour + 2 * 3600e3, now).getTime(), thisHour, 'in the future');
  assert.equal(visitHour(thisHour + 6 * 60e3, now).getTime(), thisHour + 6 * 60e3, 'a clock a little fast');
  assert.equal(visitHour(thisHour + 11 * 60e3, now).getTime(), thisHour, 'a clock far ahead');
  assert.equal(visitHour(hour - 2 * 86400e3, now).getTime(), thisHour, 'too long ago');
  assert.equal(visitHour('10', now).getTime(), thisHour);
  assert.equal(visitHour(undefined, now).getTime(), thisHour);
});

test('a second visit in the same hour is its own visit, while every tab of the first shares one', async () => {
  const now = new Date('2026-10-05T10:50:00Z');
  const id = h => identify('october', 'example.com', '1.2.3.4', 'UA', now, visitHour(h, now));
  const first = await id(Date.parse('2026-10-05T10:00:00Z')), again = await id(Date.parse('2026-10-05T10:41:00Z'));
  assert.notEqual(again.visit, first.visit);
  assert.equal(again.visitor, first.visitor);
  assert.equal((await id(undefined)).visit, first.visit, 'a tracker that sends no start joins the hour\'s visit');
  assert.equal((await id(Date.parse('2026-10-05T10:41:00Z'))).visit, again.visit);
});

test('a tab whose clock runs a few seconds fast keeps its later visit whole', async () => {
  const h = Date.parse('2026-10-05T14:41:00Z');
  const at = (when, start) => identify('october', 'example.com', '1.2.3.4', 'UA', new Date(when), visitHour(start, new Date(when)));
  const earlier = await at('2026-10-05T14:40:57Z', Date.parse('2026-10-05T14:00:00Z'));
  const view = await at('2026-10-05T14:40:57Z', h), engagement = await at('2026-10-05T14:45:00Z', h);
  assert.equal(view.visit, engagement.visit);
  assert.notEqual(view.visit, earlier.visit, 'not joined to the visit before');
});

const store = entries => {
  const kv = new Map(entries), puts = [];
  return { kv, puts, STORE: { get: async k => kv.get(k) ?? null, put: async (k, v) => (puts.push(k), kv.set(k, v)), delete: async k => kv.delete(k) } };
};

test('a visit that runs past midnight on the 1st keeps the salt of the month it started in, and never makes one', async () => {
  const { STORE, puts } = store([['salt:2026-10', 'october']]);
  const oct31 = new Date('2026-10-31T23:00:00Z'), nov1 = new Date('2026-11-01T00:10:00Z');
  assert.equal(await visitSalt({ STORE }, oct31, nov1, 'november'), 'october');
  assert.equal(await visitSalt({ STORE }, nov1, nov1, 'november'), 'november');
  assert.equal(await visitSalt({ STORE }, nov1, new Date('2026-10-31T23:59:58Z'), 'october'), 'october', 'a clock ahead into next month');
  assert.equal(await visitSalt({ STORE }, new Date('2026-09-30T23:00:00Z'), new Date('2026-10-01T00:10:00Z'), 'october'), 'october', 'gone or never made: this month\'s');
  assert.deepEqual(puts, []);
});

test('collect writes both halves of a visit across the 1st with one visitor and one visit', async t => {
  const points = [];
  const { STORE, puts } = store([['sites', '["example.com"]'], ['salt:2026-10', 'october'], ['salt:2026-11', 'november']]);
  const env = { STORE, EVENTS: { writeDataPoint: p => points.push(p) } };
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-31T23:40:00Z') });
  const send = h => collect(new Request('https://worker.test/lede', {
    method: 'POST', headers: { ...BEACON, 'User-Agent': SAFARI, 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify({ u: 'https://example.com/', h }),
  }), env);
  await send(Date.parse('2026-10-31T23:00:00Z'));
  t.mock.timers.setTime(Date.parse('2026-11-01T00:10:00Z'));
  await send(Date.parse('2026-10-31T23:00:00Z'));
  await send(Date.parse('2026-11-01T00:00:00Z'));
  const rows = points.map(p => Object.fromEntries(FIELDS.map((f, i) => [f, p.blobs[i]])));
  assert.equal(rows[1].visit, rows[0].visit);
  assert.equal(rows[1].visitor, rows[0].visitor);
  assert.notEqual(rows[2].visitor, rows[0].visitor, 'the next visit has November\'s visitor ID, which can\'t be linked to October\'s');
  assert.deepEqual(puts, []);
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

test('a page view says where it falls in its visit, so visits and bounces survive sampling', () => {
  const step = (k, t) => parseEvent({ u: 'https://example.com/', k, t, e: 2000, s: 10 }, SITES).step;
  assert.deepEqual([1, 2, 3].map(k => step(k)), [1, 2, 3]);
  assert.deepEqual([0, 4, 1.5, '1', -1, null, undefined].map(k => step(k)), [0, 0, 0, 0, 0, 0, 0], 'anything else is unknown');
  assert.equal(step(1, 'engagement'), 0, 'only page views have a place');
});

test('Web Vitals ride on the engagement event, and a broken measurement is unknown', () => {
  const ev = body => parseEvent({ u: 'https://example.com/', t: 'engagement', e: 2000, s: 10, ...body }, SITES);
  const v = body => { const e = ev(body); return [e.lcp, e.inp, e.cls]; };
  assert.deepEqual(v({ lcp: 2400.4, inp: 180.6, cls: 105 }), [2400, 181, 105]);
  assert.deepEqual(v({}), [0, 0, 0], 'not measured');
  assert.deepEqual(v({ lcp: 60001, inp: -1, cls: 10001 }), [0, 0, 0], 'out of bounds');
  assert.deepEqual(v({ lcp: '2400', inp: NaN, cls: Infinity }), [0, 0, 0]);
  assert.deepEqual(v({ lcp: 60000, inp: 0, cls: 10000 }), [60000, 0, 10000]);
  assert.equal(parseEvent({ u: 'https://example.com/', lcp: 2400 }, SITES).lcp, undefined, 'a page view carries none');
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
  assert.equal(ev('download', 'https://cdn.test/invoices/88123456/Invoice-88123456.pdf').target, 'cdn.test/invoices/*/*.pdf');
});

test('a link\'s path loses what could name a person or unlock something, and keeps the rest', () => {
  assert.equal(scrubPath('/u/jane.doe@mail.com/files'), '/u/*/files');
  assert.equal(scrubPath('/u/jane.doe%40mail.com'), '/u/*');
  assert.equal(scrubPath('/order/12345678'), '/order/*');
  assert.equal(scrubPath('/reports/20261005.pdf'), '/reports/20261005.pdf', 'a date is not a number to hide');
  assert.equal(scrubPath('/d/0b9d1c1e-3f5a-4c8e-9d2b-6a7f8e9d0c1b/report.pdf'), '/d/*/report.pdf');
  assert.equal(scrubPath('/blob/9fceb02d0ae598e95dc970b74767f19372d61af8/README.md'), '/blob/*/README.md');
  assert.equal(scrubPath('/reset/Xk9mQ2pL7vR4tY8wZ3bN'), '/reset/*');
  assert.equal(scrubPath('/files/a1b2c3d4e5f6a7b8c9d0.zip'), '/files/*.zip', 'the kind of file stays');
  assert.equal(scrubPath('/watch/dQw4w9WgXcQ'), '/watch/dQw4w9WgXcQ', 'a short ID is a page, not a secret');
  assert.equal(scrubPath('/acme/repo/issues/1234'), '/acme/repo/issues/1234');
  assert.equal(scrubPath('/getting-started-with-the-new-api'), '/getting-started-with-the-new-api');
  assert.equal(scrubPath('/Release-Notes-2026-October-Edition'), '/Release-Notes-2026-October-Edition', 'words with capitals and a year are a title');
  assert.equal(scrubPath('/%E0%A4%A'), '/%E0%A4%A', 'a broken escape is kept as it was');
  assert.equal(scrubPath('/img/logo@2x.png'), '/img/logo@2x.png', 'a retina image is not an email');
  assert.equal(scrubPath('/lodash@4.17.21/lodash.min.js'), '/lodash@4.17.21/lodash.min.js', 'nor is a package version');
  assert.equal(scrubPath('/u/jane@mail.co.uk.pdf'), '/u/*.pdf');
});

test('collect writes engagement as doubles and the link in its own blob, hashed like a page view', async () => {
  const points = [];
  const kv = new Map([['sites', '["example.com"]'], ['salt', 's']]);
  const env = { STORE: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) }, EVENTS: { writeDataPoint: p => points.push(p) } };
  const send = body => collect(new Request('https://worker.test/lede', {
    method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) Safari/605', 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify({ u: 'https://example.com/docs', ...body }),
  }), env);
  await send({ k: 2 });
  await send({ t: 'engagement', e: 12000, s: 80, lcp: 1840.6, inp: 96, cls: 42 });
  await send({ t: 'download', o: 'https://example.com/files/guide.pdf' });
  assert.equal(points.length, 3);
  const rows = points.map(p => Object.fromEntries(FIELDS.map((f, i) => [f, p.blobs[i]])));
  assert.deepEqual(FIELDS.slice(12), ['target', 'device', 'browser', 'utmTerm'], 'new fields go at the end, so stored rows keep their layout');
  assert.deepEqual(NUMBERS, ['engaged', 'scroll', 'step', 'lcp', 'inp', 'cls'], 'and new numbers too');
  assert.deepEqual(rows.map(r => r.type), ['pageview', 'engagement', 'download']);
  assert.deepEqual(points.map(p => p.doubles), [[0, 0, 2, 0, 0, 0], [12000, 80, 0, 1841, 96, 42], [0, 0, 0, 0, 0, 0]]);
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

test('collect caps each browser on its own, and an address that changes its user agent as one', async () => {
  const points = [];
  const kv = new Map([['sites', '["example.com"]'], ['salt', 's']]);
  const env = { STORE: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) }, EVENTS: { writeDataPoint: p => points.push(p) } };
  const send = (ua, ip = '192.0.2.44') => collect(new Request('https://worker.test/lede', {
    method: 'POST', headers: { ...BEACON, 'User-Agent': ua, 'CF-Connecting-IP': ip }, body: JSON.stringify({ u: 'https://example.com/' }),
  }), env);
  for (let i = 0; i < SENDER_LIMIT; i++) await send(SAFARI);
  await send(SAFARI.replace('18.6', '18.5'));
  assert.equal(points.length, SENDER_LIMIT + 1, 'another reader behind the same address still counts');
  for (let i = 0; i < ADDRESS_LIMIT + 50; i++) await send(SAFARI.replace('605.1.15', `605.1.${i}`));
  assert.equal(points.length, ADDRESS_LIMIT);
  await send(SAFARI, '192.0.2.45');
  assert.equal(points.length, ADDRESS_LIMIT + 1, 'another address still counts');
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

test('collect stores the device and browser family in the blobs reserved for them, and nothing new in the visitor hash', async () => {
  const points = [];
  const kv = new Map([['sites', '["example.com"]'], ['salt', 's']]);
  const env = { STORE: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) }, EVENTS: { writeDataPoint: p => points.push(p) } };
  const send = (ua, extra = {}) => collect(new Request('https://worker.test/lede', {
    method: 'POST', headers: { ...BEACON, 'User-Agent': ua, 'CF-Connecting-IP': '1.2.3.4', ...extra }, body: JSON.stringify({ u: 'https://example.com/docs' }),
  }), env);
  const android = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
  await send(SAFARI);
  await send('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1');
  await send(android, { 'Sec-CH-UA-Mobile': '?1' });
  await send(android, { 'Sec-CH-UA-Mobile': '?0' });
  assert.equal(points.length, 4);
  const rows = points.map(p => Object.fromEntries(FIELDS.map((f, i) => [f, p.blobs[i]])));
  assert.deepEqual(rows.map(r => [r.device, r.browser]), [['computer', 'safari'], ['phone', 'safari'], ['phone', 'chrome'], ['tablet', 'chrome']]);
  assert.deepEqual(points.map(p => [p.blobs[13], p.blobs[14]]), rows.map(r => [r.device, r.browser]), 'blob14 and blob15');
  assert.ok(rows.every(r => r.utmTerm === ''));
  assert.equal(rows[2].visitor, rows[3].visitor, 'the hint that settles the device is not part of who the visitor is');
});
