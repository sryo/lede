import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent } from '../src/collect.js';
import { parseQuery, sqlStore, handleApi } from '../src/api.js';
import { siteSearchSql, paidWordsSql, SEARCH_PARAMS } from '../src/queries.js';
import { keyword, searchWord, toKeywords } from '../src/shape.js';
import { demoStore } from '../src/demo.js';
import { keywordsStory, keywordsCard, KEYWORDS_EMPTY } from '../public/story.js';
import { viewToUrl, urlToView } from '../public/routes.js';

const SITES = ['example.com'];
const ENV = { ACCOUNT_ID: 'acc', ANALYTICS_TOKEN: 'tok', DATASET: 'lede' };
const url = s => new URL(`https://worker.test/api/${s}`);
const memoryKV = (init = {}) => { const m = new Map(Object.entries(init)); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const strip = html => html.replace(/<[^>]+>/g, '');

/* ---------- one word ---------- */

test('a keyword is lowercased, trimmed, its spaces squeezed and its length capped at 80', () => {
  assert.equal(keyword('  Owl   Calls '), 'owl calls');
  assert.equal(keyword('x'.repeat(200)).length, 80);
  assert.equal(keyword(''), '');
  assert.equal(keyword(null), '');
});

test('a keyword that looks like an email or holds 6 digits in a row is dropped', () => {
  assert.equal(keyword('jane.doe@example.com'), '');
  assert.equal(keyword('order for Jane@Mail.co'), '');
  assert.equal(keyword('track 123456'), '');
  assert.equal(keyword('+44 7700900123'), '');
  assert.equal(keyword('12345 main st'), '12345 main st', 'five digits are a zip code or a model number');
  // An email past the 80th character is still caught: the check runs before the cut.
  assert.equal(keyword('a'.repeat(76) + ' me@x.io'), '');
});

test('a search word is read from the common search parameters of a page address', () => {
  assert.equal(searchWord('/search?q=Owl+Calls'), 'owl calls');
  assert.equal(searchWord('/search?q=owl%20calls&page=2'), 'owl calls');
  assert.equal(searchWord('/?s=Feeders'), 'feeders');
  for (const p of SEARCH_PARAMS) assert.equal(searchWord(`/x?${p}=wren`), 'wren', p);
  assert.equal(searchWord('/x?page=2&query=heron'), 'heron');
  assert.equal(searchWord('/faq?id=4'), '');
  assert.equal(searchWord('/search?q='), '');
  assert.equal(searchWord('/search?q=me%40mail.com'), '');
  assert.equal(searchWord('/search'), '');
  assert.equal(searchWord('/search?q=%E0%A4%A'), '', 'a broken escape is not a word');
});

/* ---------- collect ---------- */

test('the ad keyword (utm_term) of the landing page is kept, cleaned', () => {
  const ev = l => parseEvent({ u: 'https://example.com/', r: 'https://www.google.com/', l }, SITES);
  assert.equal(ev('?utm_source=google&utm_medium=cpc&utm_term=Bird+Feeder').utmTerm, 'bird feeder');
  assert.equal(ev('?utm_term=' + 'w'.repeat(300)).utmTerm.length, 80);
  assert.equal(ev('?utm_term=bob%40mail.com').utmTerm, '');
  assert.equal(ev('?utm_term=call+0612345678').utmTerm, '');
  assert.equal(ev('').utmTerm, '');
});

/* ---------- SQL ---------- */

test('site searches read page views whose address holds a search parameter, both periods in one query', () => {
  const q = parseQuery(url('keywords?days=7'), SITES);
  const sql = siteSearchSql('lede', q);
  assert.match(sql, /^SELECT if\(timestamp >= toDateTime\(\d+\), 1, 0\) AS p, blob3 AS url, blob6 AS visitor FROM lede WHERE /);
  assert.match(sql, /blob8 = 'pageview'/);
  for (const p of SEARCH_PARAMS) {
    assert.ok(sql.includes(`position('?${p}=' IN blob3) > 0`), p);
    assert.ok(sql.includes(`position('&${p}=' IN blob3) > 0`), p);
  }
  assert.match(sql, /GROUP BY p, url, visitor LIMIT \d+$/);
  assert.ok(sql.length < 10240);
});

test('paid words count visitors per ad keyword, both periods in one query', () => {
  const q = parseQuery(url('keywords'), SITES);
  const sql = paidWordsSql('lede', q);
  assert.match(sql, /blob16 AS key, count\(DISTINCT blob6\) AS visitors/);
  assert.match(sql, /blob16 != ''/);
  assert.match(sql, /GROUP BY p, key ORDER BY visitors DESC LIMIT \d+$/);
});

test('the SQL store runs one query per list and shapes them', async () => {
  const sent = [];
  const fetchImpl = async (_, init) => {
    sent.push(init.body);
    const data = init.body.includes('blob16 AS key')
      ? [{ p: 1, key: 'bird feeder', visitors: '7' }, { p: 0, key: 'bird feeder', visitors: '3' }]
      : [{ p: 1, url: '/search?q=Owls', visitor: 'a' }, { p: 1, url: '/search?q=owls&page=2', visitor: 'b' }];
    return new Response(JSON.stringify({ data }));
  };
  const out = await sqlStore(ENV, fetchImpl).keywords(parseQuery(url('keywords'), SITES));
  assert.equal(sent.length, 2);
  assert.deepEqual(out, { site: [{ key: 'owls', visitors: 2, prev: null }], paid: [{ key: 'bird feeder', visitors: 7, prev: 3 }] });
});

/* ---------- shaping ---------- */

test('search words merge result pages and spellings, count each visitor once, and hide words fewer than 2 used', () => {
  const site = [
    { p: 1, url: '/search?q=Pricing', visitor: 'a' },
    { p: 1, url: '/search?q=pricing&page=2', visitor: 'a' },
    { p: 1, url: '/search?q=pricing+', visitor: 'b' },
    { p: 1, url: '/search?s=PRICING', visitor: 'c' },
    { p: 1, url: '/search?q=refund', visitor: 'a' },
    { p: 1, url: '/search?q=refund&page=3', visitor: 'a' },
    { p: 1, url: '/search?q=me@x.com', visitor: 'd' },
    { p: 1, url: '/search?q=me@x.com', visitor: 'e' },
    { p: '0', url: '/search?q=pricing', visitor: 'z' },
    { p: '0', url: '/search?q=pricing', visitor: 'y' },
    { p: 0, url: '/search?q=gone', visitor: 'y' },
  ];
  const out = toKeywords(site, []);
  assert.deepEqual(out.site, [{ key: 'pricing', visitors: 3, prev: 2 }]);
  assert.deepEqual(out.paid, []);
});

test('paid words are merged after cleaning and the ones under 2 visitors are hidden', () => {
  const paid = [
    { p: 1, key: 'Bird Feeder', visitors: '5' }, { p: 1, key: 'bird feeder', visitors: '2' },
    { p: 1, key: 'owl box', visitors: '1' }, { p: 1, key: '', visitors: '9' },
    { p: 0, key: 'bird feeder', visitors: '1' },
  ];
  assert.deepEqual(toKeywords([], paid).paid, [{ key: 'bird feeder', visitors: 7, prev: 1 }]);
});

test('lists are sorted by visitors and capped', () => {
  const site = [];
  for (let w = 0; w < 150; w++) for (let v = 0; v < 2 + (w % 5); v++) site.push({ p: 1, url: `/s?q=w${w}`, visitor: `v${v}` });
  const out = toKeywords(site, []).site;
  assert.equal(out.length, 100);
  assert.ok(out.every((r, i) => !i || out[i - 1].visitors >= r.visitors));
});

/* ---------- API and demo ---------- */

test('GET /api/keywords answers both lists from the demo, with change against the period before', async () => {
  const res = await handleApi(new Request('https://worker.test/api/keywords?days=30'), { STORE: memoryKV({ sites: '["example.com"]' }), DEMO: 'true' }, { waitUntil() {} });
  assert.equal(res.status, 200);
  const k = await res.json();
  assert.ok(k.site.length >= 5 && k.paid.length >= 3);
  for (const list of [k.site, k.paid]) {
    assert.ok(list.every(r => r.visitors >= 2 && typeof r.key === 'string' && r.key === r.key.toLowerCase()));
    assert.ok(list.every((r, i) => !i || list[i - 1].visitors >= r.visitors));
  }
  // The demo's messy addresses come out merged and the private ones left out.
  assert.equal(new Set(k.site.map(r => r.key)).size, k.site.length);
  assert.ok(!k.site.some(r => /@|\d{6}/.test(r.key)));
  // The season's search grows: the top word is more than twice what it was.
  assert.equal(k.site[0].key, 'owl calls');
  assert.ok(k.site[0].visitors >= 2 * k.site[0].prev);
  assert.ok(k.site.some(r => r.prev == null), 'a word new this period');
});

test('the demo scales with the period', async () => {
  const q = d => parseQuery(url(`keywords?days=${d}`), SITES);
  const [week, month] = await Promise.all([demoStore.keywords(q(7)), demoStore.keywords(q(30))]);
  assert.ok(month.site[0].visitors > week.site[0].visitors);
});

/* ---------- the sentence ---------- */

const w = (key, visitors, prev = null) => ({ key, visitors, prev });

test('the sentence names the most searched word and how it changed', () => {
  assert.equal(strip(keywordsStory({ site: [w('pricing', 90, 30), w('refund', 20, 20)], paid: [] })),
    'People searched your site for pricing most, 3× more than before.');
  assert.equal(strip(keywordsStory({ site: [w('pricing', 60, 50)], paid: [] })), 'People searched your site for pricing most, up 20%.');
  assert.equal(strip(keywordsStory({ site: [w('pricing', 30, 60)], paid: [] })), 'People searched your site for pricing most, down 50%.');
  assert.equal(strip(keywordsStory({ site: [w('pricing', 52, 50)], paid: [] })), 'People searched your site for pricing most.');
  assert.equal(strip(keywordsStory({ site: [w('pricing', 40), w('refund', 30, 25)], paid: [] })), 'People searched your site for pricing most, new this period.');
  assert.equal(strip(keywordsStory({ site: [w('pricing', 40)], paid: [] })), 'People searched your site for pricing most.',
    'with nothing searched before, new says nothing');
});

test('a small sample is said plainly, never as a trend', () => {
  assert.equal(strip(keywordsStory({ site: [w('pricing', 6, 2), w('refund', 3, 3)], paid: [] })), 'A few people searched your site, most often for pricing.');
});

test('the words ads paid for get their own sentence, or lead when nobody searched the site', () => {
  assert.equal(strip(keywordsStory({ site: [w('pricing', 90, 30)], paid: [w('bird feeder', 40, 20)] })),
    'People searched your site for pricing most, 3× more than before. Of the words your ads paid for, bird feeder brought the most visitors, 2× more than before.');
  assert.equal(strip(keywordsStory({ site: [], paid: [w('bird feeder', 40, 38)] })), 'Of the words your ads paid for, bird feeder brought the most visitors.');
  assert.equal(strip(keywordsStory({ site: [], paid: [w('bird feeder', 4)] })), 'A few visitors came from your ads; bird feeder brought the most.');
});

test('with no words, it says so', () => {
  assert.equal(keywordsStory({ site: [], paid: [] }), 'No search words yet.');
});

test('words people typed are escaped', () => {
  const html = keywordsStory({ site: [w('<img src=x onerror=alert(1)>', 40)], paid: [w('"><b>', 40)] });
  assert.ok(!html.includes('<img') && !html.includes('"><b>'));
});

test('the empty lists say what to do', () => {
  assert.match(KEYWORDS_EMPTY.site, /\?q= or \?s=/);
  assert.match(KEYWORDS_EMPTY.paid, /utm_term/);
});

/* ---------- the card on the overview ---------- */

const many = n => Array.from({ length: n }, (_, i) => w(`word ${i}`, 50 - i, 40));

test('the card opens on site searches, or on ads when nobody searched the site', () => {
  assert.equal(keywordsCard({ site: [w('pricing', 40)], paid: [w('bird feeder', 40)] }).k, 'site');
  assert.equal(keywordsCard({ site: [], paid: [w('bird feeder', 40)] }).k, 'paid');
  assert.equal(keywordsCard({ site: [], paid: [] }).k, 'site', 'with nothing, the site search empty state says how to get words');
});

test('the card leads with the sentence for the list it shows', () => {
  const K = { site: [w('pricing', 90, 30)], paid: [w('bird feeder', 40, 20)] };
  assert.equal(strip(keywordsCard(K, 'site').say), 'People searched your site for pricing most, 3× more than before.');
  assert.equal(strip(keywordsCard(K, 'paid').say), 'Of the words your ads paid for, bird feeder brought the most visitors, 2× more than before.');
});

test('an empty list says what to do instead of a sentence', () => {
  const c = keywordsCard({ site: [], paid: [w('bird feeder', 40)] }, 'site');
  assert.equal(c.say, '');
  assert.equal(c.empty, KEYWORDS_EMPTY.site);
  assert.deepEqual(c.rows, []);
  assert.equal(keywordsCard({ site: [w('pricing', 40)], paid: [] }, 'paid').empty, KEYWORDS_EMPTY.paid);
  assert.equal(keywordsCard({ site: [w('pricing', 40)], paid: [] }).empty, '');
});

test('the card shows the top 5 words, and all of them when asked', () => {
  const K = { site: many(12), paid: many(5) };
  const c = keywordsCard(K, 'site');
  assert.deepEqual(c.rows.map(r => r.key), ['word 0', 'word 1', 'word 2', 'word 3', 'word 4']);
  assert.equal(c.all, 12);
  assert.equal(c.total, K.site.reduce((a, r) => a + r.visitors, 0), 'share is of everyone who used a word in the list');
  assert.equal(keywordsCard(K, 'site', true).rows.length, 12);
  assert.equal(keywordsCard(K, 'site', true).all, 0, 'once open, no row asks for more');
  assert.equal(keywordsCard(K, 'paid').all, 0, 'five words need no more');
});

test('the card rows are list rows: key, label, value, last period', () => {
  assert.deepEqual(keywordsCard({ site: [w('pricing', 40, 12)], paid: [] }).rows, [{ key: 'pricing', label: 'pricing', value: 40, prev: 12 }]);
});

/* ---------- the address ---------- */

test('keywords have no view of their own; an old link opens the overview, where their card is', () => {
  assert.equal(viewToUrl({ v: 'keywords' }), '/');
  assert.deepEqual(urlToView('/keywords', '?days=7'), { view: { v: 'overview' }, days: 7, site: null });
});
