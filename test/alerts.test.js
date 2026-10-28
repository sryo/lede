import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { runAlerts, webhookRequest, plain, splitText, fitsIn, WEEKLY, SPIKES, SUBREQUESTS } from '../src/alerts.js';

crypto.subtle.timingSafeEqual ??= (a, b) => Buffer.from(a).equals(Buffer.from(b));

const DAY = 86400;
// Monday 26 October 2026, 08:00 UTC: the weekly run. The week told is Monday 19 to Sunday 25.
const MONDAY = Date.UTC(2026, 9, 26, 8);
const WEEK_START = Date.UTC(2026, 9, 19) / 1000;
// Wednesday 28 October 2026, 14:30 UTC: a spike check.
const WED = Date.UTC(2026, 9, 28, 14, 30);

function memoryKV(init = {}) {
  const m = new Map(Object.entries(init));
  const kv = {
    reads: 0, writes: 0, puts: [],
    get: async k => { kv.reads++; return m.get(k) ?? null; },
    put: async (k, v, opts) => { kv.writes++; kv.puts.push({ k, v, opts }); m.set(k, v); },
    map: m,
  };
  return kv;
}

// A week where Hacker News sent 220 more people than the week before, mostly to /blog/x.
function weekRows(sql) {
  if (sql.includes('AS landing')) return [
    { p: 1, src: 'news.ycombinator.com', landing: '/blog/x', visitors: '200' }, { p: 0, src: 'news.ycombinator.com', landing: '/blog/x', visitors: '20' },
    { p: 1, src: 'news.ycombinator.com', landing: '/', visitors: '60' }, { p: 0, src: 'news.ycombinator.com', landing: '/', visitors: '20' },
    { p: 1, src: 'google.com', landing: '/', visitors: '500' }, { p: 0, src: 'google.com', landing: '/', visitors: '480' },
  ];
  if (sql.includes('AS d, count(DISTINCT visitor)')) return [1, 0].flatMap(p => Array.from({ length: 7 }, (_, d) => ({ p, d: String(p ? d + 7 : d), visitors: String(p ? 170 : 143), visits: '200', views: '300', bounces: '90', total_time: '6000' })));
  if (sql.includes('AS ref,')) return Array.from({ length: 7 }, (_, d) => ({ d: String(d), ref: 'google.com', visitors: '70' }));
  if (sql.includes('argMin(blob4, timestamp) AS key')) return [
    { p: 1, key: 'google.com', visitors: '500', visits: '600', views: '900', bounces: '200', total_time: '9000' },
    { p: 1, key: '', visitors: '300', visits: '350', views: '500', bounces: '150', total_time: '5000' },
    { p: 1, key: 'news.ycombinator.com', visitors: '260', visits: '270', views: '300', bounces: '200', total_time: '1000' },
    { p: 0, key: 'google.com', visitors: '480', visits: '580', views: '880', bounces: '200', total_time: '9000' },
    { p: 0, key: '', visitors: '300', visits: '350', views: '500', bounces: '150', total_time: '5000' },
    { p: 0, key: 'news.ycombinator.com', visitors: '40', visits: '45', views: '50', bounces: '30', total_time: '100' },
  ];
  if (sql.includes('AS key')) return [
    { p: 1, key: '/', visitors: '700', visits: '800', views: '1000' }, { p: 1, key: '/blog/x', visitors: '300', visits: '310', views: '330' },
    { p: 1, key: '/about', visitors: '100', visits: '100', views: '100' },
    { p: 0, key: '/', visitors: '690', visits: '790', views: '990' }, { p: 0, key: '/blog/x', visitors: '40', visits: '40', views: '40' },
    { p: 0, key: '/about', visitors: '200', visits: '200', views: '200' },
  ];
  return [{ p: 1, visitors: '1200', visits: '1500', views: '2000', bounces: '700', total_time: '60000', sampled: '0' },
    { p: 0, visitors: '1000', visits: '1300', views: '1800', bounces: '600', total_time: '50000', sampled: '0' }];
}

// Who is here now: `here` people seen in the last 5 minutes (n on /blog/x, most from Hacker News), plus a few earlier.
function liveRows(nowSec, here, onPage = here, src = 'news.ycombinator.com') {
  return [
    ...Array.from({ length: here }, (_, i) => ({ visitor: `v${i}`, path: i < onPage ? '/blog/x' : `/p${i % 3}`, referrer: i % 4 === 3 ? 'google.com' : src, country: 'US', first: String(nowSec - 200), last: String(nowSec - 10 - i) })),
    ...Array.from({ length: 3 }, (_, i) => ({ visitor: `old${i}`, path: '/', referrer: '', country: 'US', first: String(nowSec - 1500), last: String(nowSec - 900) })),
  ];
}

// The SQL API and the webhook, faked. `usual` is visitors per day in the same 5 minutes over the last 14 days,
// `since` how long ago the site's first event was (in days), `seen` whether the crowd's source sent anyone before.
function fakes({ rows = weekRows, here = 0, onPage, src, usual = [], since = 30, seen = false, hook = 200 } = {}) {
  const sent = [], sql = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/analytics_engine/sql')) {
      const body = String(init.body);
      sql.push(body);
      const nowSec = Math.floor(fetchImpl.now / 1000);
      const data = body.includes('argMax(blob2') ? liveRows(nowSec, here, onPage, src)
        : body.includes('* 86400 < 300') ? usual.map((v, d) => ({ d: String(d), visitors: String(v) }))
          : body.includes('min(timestamp)) AS first') ? [{ first: String(nowSec - since * DAY) }]
            : body.includes('count() AS n FROM') ? [{ n: seen ? '3' : '0' }]
              : rows(body);
      return new Response(JSON.stringify({ meta: [], data, rows: data.length }), { status: 200 });
    }
    if (typeof hook === 'function') return hook(u, init);
    sent.push({ url: u, init, body: init.body });
    return new Response('ok', { status: hook });
  };
  return { sent, sql, fetchImpl };
}

const env = (extra = {}) => ({
  ACCOUNT_ID: 'acc', ANALYTICS_TOKEN: 'tok', ALERT_WEBHOOK: 'https://ntfy.sh/my-lede',
  STORE: memoryKV({ sites: '["example.com"]', origin: 'https://lede.example.workers.dev', 'added:example.com': String(Date.UTC(2026, 6, 1) / 1000) }), ...extra,
});

async function run(cron, e, f, nowMs) {
  f.fetchImpl.now = nowMs;
  await runAlerts(cron, e, nowMs, f.fetchImpl);
}

/* ---------- where the message goes ---------- */

test('Slack gets {text}, Discord gets {content}, anything else (ntfy) gets the plain text', () => {
  const slack = webhookRequest('https://hooks.slack.com/services/T/B/x', 'A & B <c>');
  assert.equal(slack.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(slack.body), { text: 'A &amp; B &lt;c&gt;' }, 'Slack reads &, < and > as markup');
  const discord = webhookRequest('https://discord.com/api/webhooks/1/abc', 'Hi @everyone');
  assert.equal(JSON.parse(discord.body).content, 'Hi @everyone');
  assert.deepEqual(JSON.parse(discord.body).allowed_mentions, { parse: [] }, 'a page name never pings a whole server');
  assert.equal(JSON.parse(webhookRequest('https://discordapp.com/api/webhooks/1/abc', 'x').body).content, 'x');
  assert.ok(JSON.parse(webhookRequest('https://discord.com/api/webhooks/1/abc', 'y'.repeat(3000)).body).content.length <= 2000, 'Discord takes at most 2000 characters');
  const ntfy = webhookRequest('https://ntfy.sh/my-lede', 'Plain words');
  assert.equal(ntfy.body, 'Plain words');
  assert.match(ntfy.headers['Content-Type'], /^text\/plain/);
});

test('a long message goes as a few that each fit, cut between sites, then lines, then anywhere', () => {
  const short = s => s.length <= 20;
  assert.deepEqual(splitText('one\ntwo\n\nthree', short), ['one\ntwo\n\nthree']);
  assert.deepEqual(splitText('a.org week\nline\n\nb.org week\nline', short), ['a.org week\nline', 'b.org week\nline']);
  assert.deepEqual(splitText('a.org, the week of Oct 19\nNo visitors.', short), ['a.org, the week of O', 'ct 19', 'No visitors.']);
  assert.ok(fitsIn('https://discord.com/api/webhooks/1/a')('x'.repeat(2000)));
  assert.ok(!fitsIn('https://discord.com/api/webhooks/1/a')('x'.repeat(2001)));
  assert.ok(!fitsIn('https://ntfy.sh/t')('é'.repeat(2049)), 'ntfy counts bytes, and é is two');
  assert.ok(fitsIn('https://hooks.slack.com/services/T/B/x')('x'.repeat(40_000)));
});

test('a story longer than Discord takes goes as several messages, all of it, in order', async () => {
  const sites = Array.from({ length: 6 }, (_, i) => `site${i}.example.com`);
  const long = '/about/' + 'owls-'.repeat(60);
  const f = fakes({ rows: sql => weekRows(sql).map(r => (r.key === '/about' ? { ...r, key: long } : r)) });
  await run(WEEKLY, env({ ALERT_WEBHOOK: 'https://discord.com/api/webhooks/1/abc', STORE: memoryKV({ sites: JSON.stringify(sites) }) }), f, MONDAY);
  const parts = f.sent.map(s => JSON.parse(s.body).content);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(p => p.length <= 2000));
  assert.deepEqual(parts.join('\n\n').match(/^site\d/gm), sites.map(s => s.slice(0, 5)), 'every site, each whole, in order');
});

test('the week’s story stops before a Free schedule runs out of requests, and names the sites left out', async () => {
  const sites = Array.from({ length: 10 }, (_, i) => `s${i}.org`);
  const f = fakes(), e = env({ STORE: memoryKV({ sites: JSON.stringify(sites) }) });
  await run(WEEKLY, e, f, MONDAY);
  assert.ok(f.sql.length <= SUBREQUESTS, `${f.sql.length} queries`);
  assert.ok(f.sql.length + e.STORE.reads + f.sent.length <= 50, 'Cloudflare’s 50, with each site’s notes and the message');
  const body = f.sent.map(s => s.body).join('\n\n');
  assert.match(body, /^s5\.org, the week of/m);
  assert.ok(!/^s6\.org, the week/m.test(body));
  assert.match(body, /\n\nToo many sites for one message, so s6\.org, s7\.org, s8\.org and s9\.org aren’t in it\. Their week is on the dashboard\.$/);
});

test('the week’s story says what came after the owner’s note, read with one KV read', async () => {
  const e = env(), read = [], get = e.STORE.get;
  e.STORE.get = key => { read.push(key); return get(key); };
  e.STORE.map.set('settings:example.com', JSON.stringify({ notes: [{ day: '2026-10-21', text: 'Posted on Hacker News' }] }));
  // From Wednesday on, about 200 a day instead of 143.
  const rows = sql => sql.includes('AS d, count(DISTINCT visitor)')
    ? [1, 0].flatMap(p => Array.from({ length: 7 }, (_, d) => ({ p, d: String(p ? d + 7 : d), visitors: String(p && d >= 2 ? 200 : 143), visits: '200', views: '300', bounces: '90', total_time: '6000' })))
    : weekRows(sql);
  const f = fakes({ rows });
  await run(WEEKLY, e, f, MONDAY);
  assert.match(f.sent[0].body, /after you posted on Hacker News \(Wed, Oct 21\)\./);
  assert.equal(read.filter(k => k.startsWith('settings:')).length, 1);
});

test('a busy week, with queries asked twice, still fits in a Free schedule’s 50 requests', async () => {
  // Each list's query over both weeks comes back full, so every list asks again for the week before: 9 queries a site.
  const full = sql => {
    const both = Number(sql.match(/LIMIT (1000|20000)$/)?.[1]), rows = weekRows(sql);
    if (!both) return rows;
    const row = rows.find(r => r.p === 1);
    return Array.from({ length: both }, (_, i) => ({ ...row, ...('key' in row ? { key: `${row.key}${i}` } : { landing: `${row.landing}${i}` }) }));
  };
  const sites = Array.from({ length: 10 }, (_, i) => `s${i}.org`);
  const f = fakes({ rows: full }), inner = f.fetchImpl;
  // Some queries are refused once, and asked again.
  let requests = 0, sql = 0;
  const refused = new Set();
  f.fetchImpl = async (u, init) => {
    requests++;
    if (String(u).endsWith('/analytics_engine/sql') && !refused.has(init.body) && ++sql % 3 === 2) {
      refused.add(init.body);
      return new Response('slow down', { status: 429 });
    }
    return inner(u, init);
  };
  inner.now = MONDAY;
  await run(WEEKLY, env({ ALERT_WEBHOOK: 'https://discord.com/api/webhooks/1/abc', STORE: memoryKV({ sites: JSON.stringify(sites), origin: 'https://lede.example.workers.dev' }) }), f, MONDAY);
  assert.ok(f.sent.length >= 1);
  assert.ok(requests + 3 <= 50, `${requests} requests and 3 KV reads`);
  const body = f.sent.map(s => JSON.parse(s.body).content).join('\n\n');
  const told = body.match(/^s\d\.org(?=, the week of)/gm);
  assert.ok(told.length >= 3, `${told.length} sites told`);
  assert.deepEqual(told, sites.slice(0, told.length), 'in order');
  assert.ok(body.endsWith(`so ${sites.slice(told.length).slice(0, -1).join(', ')} and s9.org aren’t in it. Their week is on the dashboard.`), 'the rest are named');
});

test('sentences lose their links and keep their words', () => {
  assert.equal(plain('<button type="button" class="link told" data-f="referrer" data-k="a">Hacker News</button> sent 3 &amp; 4 to /blog/<wbr>my‑post.'),
    'Hacker News sent 3 & 4 to /blog/my-post.');
});

/* ---------- nothing set, nothing sent ---------- */

test('without ALERT_WEBHOOK nothing is sent and no stats are read', async () => {
  const f = fakes({ here: 40 });
  const e = env({ ALERT_WEBHOOK: undefined });
  await run(WEEKLY, e, f, MONDAY);
  await run(SPIKES, e, f, WED);
  assert.equal(f.sent.length, 0);
  assert.equal(f.sql.length, 0);
  assert.equal(e.STORE.writes, 0);
});

test('ALERTS picks which messages go out', async () => {
  const f = fakes({ here: 40 });
  await run(SPIKES, env({ ALERTS: 'weekly' }), f, WED);
  assert.equal(f.sql.length, 0, 'spikes are off, so nothing is read');
  await run(WEEKLY, env({ ALERTS: 'spikes' }), f, MONDAY);
  assert.equal(f.sent.length, 0);
  await run(WEEKLY, env({ ALERTS: ' Weekly , spikes ' }), f, MONDAY);
  assert.equal(f.sent.length, 1);
});

test('a webhook that fails or can’t be reached breaks nothing', async () => {
  for (const hook of [500, () => { throw new Error('offline'); }]) {
    const f = fakes({ hook, here: 40 });
    await run(WEEKLY, env(), f, MONDAY);
    await run(SPIKES, env(), f, WED);
  }
  const f = fakes();
  await run(WEEKLY, env({ ANALYTICS_TOKEN: undefined }), f, MONDAY);
  assert.equal(f.sent.length, 0, 'no token, no stats, no message');
});

/* ---------- the weekly story ---------- */

test('the weekly message tells the week Monday to Sunday with the sentence home shows, then backs it up', async () => {
  const f = fakes();
  await run(WEEKLY, env(), f, MONDAY);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].url, 'https://ntfy.sh/my-lede');
  assert.equal(f.sent[0].body, [
    'example.com, the week of Oct 19',
    'Hacker News sent 220 more visitors, mostly to /blog/x.',
    '1,200 visitors, 200 more than the week before (+20%).',
    'google.com sent the most visitors: 500.',
    '/about lost 100 visitors (−50%).',
    'https://lede.example.workers.dev/?days=7',
  ].join('\n'));
  // The week is read whole, in UTC, against the week before it.
  assert.ok(f.sql.every(s => s.includes(`toDateTime(${WEEK_START})`) || s.includes(`toDateTime(${WEEK_START - 7 * DAY})`)));
  assert.ok(f.sql.some(s => s.includes(`toDateTime(${WEEK_START + 7 * DAY})`)));
  assert.equal(f.sql.length, 6, 'six stats queries a site, once a week');
});

test('each site gets its own story in one message, quiet ones said plainly', async () => {
  const f = fakes({ rows: sql => sql.includes("index1 = 'quiet.org'") ? [] : weekRows(sql) });
  await run(WEEKLY, env({ STORE: memoryKV({ sites: '["example.com","quiet.org"]' }) }), f, MONDAY);
  assert.equal(f.sent.length, 1);
  const body = f.sent[0].body;
  assert.match(body, /^example\.com, the week of Oct 19\n/);
  assert.match(body, /\n\nquiet\.org, the week of Oct 19\nNo visitors this week\.$/);
  assert.ok(!body.includes('https://'), 'no dashboard address known yet, so no link');
});

test('the dashboard link names the site when there is more than one, and DASHBOARD_URL wins', async () => {
  const f = fakes();
  await run(WEEKLY, env({ DASHBOARD_URL: 'https://stats.example.com/', STORE: memoryKV({ sites: '["example.com","b.org"]' }) }), f, MONDAY);
  assert.match(f.sent[0].body, /\nhttps:\/\/stats\.example\.com\/\?days=7&site=example\.com\n/);
});

/* ---------- spikes ---------- */

test('a crowd well above the usual for the hour sends one line, with where they are and where from', async () => {
  const f = fakes({ here: 42, usual: [3, 2, 4, 1, 0, 2, 3, 5, 2, 1, 2, 3, 4, 2] });
  const e = env();
  await run(SPIKES, e, f, WED);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].body, [
    '42 people are on /blog/x of example.com right now, most from Hacker News. Usually about 2 at this time of day.',
    'https://lede.example.workers.dev/online',
  ].join('\n'));
  assert.equal(f.sql.length, 2, 'who is here now, then the usual');
  // The usual is the same 5 minutes on each of the 14 days before.
  const usual = f.sql[1], nowSec = WED / 1000;
  assert.ok(usual.includes(`toDateTime(${nowSec - 14 * DAY - 300})`));
  assert.ok(usual.includes(`toDateTime(${nowSec - DAY})`));
  assert.equal(e.STORE.writes, 1);
  assert.ok(e.STORE.puts[0].opts.expirationTtl >= DAY, 'the count deletes itself');
});

test('a crowd spread over the site names the site', async () => {
  const f = fakes({ here: 20, onPage: 6 });
  await run(SPIKES, env(), f, WED);
  assert.match(f.sent[0].body, /^20 people are on example\.com right now, most from Hacker News\. Usually hardly anyone at this time of day\.\n/);
  const half = fakes({ here: 20, onPage: 12 });
  await run(SPIKES, env(), half, WED);
  assert.match(half.sent[0].body, /^20 people are on example\.com right now, 12 of them on \/blog\/x, most of those from Hacker News\./);
});

test('fewer than 10 people, or a usual crowd, sends nothing; under 10 costs one query and no KV', async () => {
  const few = fakes({ here: 9 });
  const e = env();
  await run(SPIKES, e, few, WED);
  assert.equal(few.sent.length, 0);
  assert.equal(few.sql.length, 1);
  assert.equal(e.STORE.writes, 0);
  const usual = fakes({ here: 30, usual: Array(14).fill(20) });
  await run(SPIKES, env(), usual, WED);
  assert.equal(usual.sent.length, 0, '30 against a usual 20 is a busy moment, not a spike');
});

test('with many sites, a spike run stays within a Free schedule’s requests and looks at the next sites each time', async () => {
  const sites = Array.from({ length: 60 }, (_, i) => `s${i}.org`), e = env({ STORE: memoryKV({ sites: JSON.stringify(sites) }) });
  const looked = new Set();
  for (const step of [0, 1, 2]) {
    const f = fakes({ here: 40 });
    await run(SPIKES, e, f, WED + step * 15 * 60e3);
    const live = f.sql.filter(b => b.includes('argMax(blob2'));
    assert.ok(f.sql.length + f.sent.length <= SUBREQUESTS, `run ${step}: ${f.sql.length + f.sent.length} requests`);
    assert.ok(live.length < sites.length && f.sent.length >= 1, 'a slice of the sites, and a crowd still told');
    for (const b of live) looked.add(b.match(/index1 = '([^']+)'/)[1]);
  }
  assert.equal(looked.size, sites.length, 'three runs look at every site');
});

test('at most two spike messages a day per site, hours apart, and the count starts again the next day', async () => {
  const f = fakes({ here: 50 });
  const e = env();
  const at = mins => WED + mins * 60000;
  await run(SPIKES, e, f, at(0));
  await run(SPIKES, e, f, at(15));
  assert.equal(f.sent.length, 1, 'the same spike isn’t told again 15 minutes later');
  const queries = f.sql.length;
  await run(SPIKES, e, f, at(30));
  assert.equal(f.sql.length, queries + 1, 'while it can’t send, it doesn’t ask for the usual');
  await run(SPIKES, e, f, at(180));
  await run(SPIKES, e, f, at(400));
  assert.equal(f.sent.length, 2);
  await run(SPIKES, e, f, Date.UTC(2026, 9, 29, 1));
  assert.equal(f.sent.length, 3);
  assert.equal(e.STORE.writes, 3, 'one KV write per message sent');
});

test('a new site gets no spike message for its first 3 days, then a usual from the days it had', async () => {
  const STORE = memoryKV({ sites: '["example.com"]' });
  const young = fakes({ here: 40, since: 2.5 });
  await run(SPIKES, env({ STORE }), young, WED);
  assert.equal(young.sent.length, 0, 'two days isn’t enough to know the usual');
  assert.equal(STORE.map.get('added:example.com'), String(WED / 1000 - 2.5 * DAY), 'the first event is kept');
  assert.equal(young.sql.length, 2, 'who is here now, then when the site began');
  const later = fakes({ here: 40, usual: [10, 10, 10, 10] });
  const now = WED + 2 * DAY * 1000;
  await run(SPIKES, env({ STORE }), later, now);
  assert.equal(later.sql.length, 2, 'when it began is asked once, then read from KV');
  assert.ok(later.sql[1].includes(`toDateTime(${now / 1000 - 4 * DAY - 300})`), 'the usual over the 4 days it had');
  assert.match(later.sent[0].body, /Usually about 10 at this time of day\./, 'not 40 over 14 days');
});

test('a spike names a source people know, or one that sent visitors before; never an unknown host', async () => {
  const unknown = fakes({ here: 40, src: 'secret-plans.example' });
  await run(SPIKES, env(), unknown, WED);
  assert.match(unknown.sent[0].body, /^40 people are on \/blog\/x of example\.com right now, most from a site that sent nobody in the 2 weeks before\./);
  assert.ok(!unknown.sent[0].body.includes('secret-plans'));
  assert.ok(unknown.sql[2].includes("hex(blob4) = '"), 'asked whether it sent anyone before');
  const seen = fakes({ here: 40, src: 'owl-forum.example', seen: true });
  await run(SPIKES, env(), seen, WED);
  assert.match(seen.sent[0].body, /most from owl-forum\.example\./);
  const known = fakes({ here: 40 });
  await run(SPIKES, env(), known, WED);
  assert.equal(known.sql.length, 2, 'Hacker News is known, so nothing more is asked');
});

test('a crowd bigger than the live list can show says so', async () => {
  const f = fakes({ here: 200 });
  await run(SPIKES, env(), f, WED);
  assert.match(f.sent[0].body, /^At least 200 people are on/);
});

/* ---------- wiring ---------- */

test('the Worker runs alerts on its crons, and wrangler.jsonc schedules both', async () => {
  const conf = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.ok(conf.includes(`"${WEEKLY}"`) && conf.includes(`"${SPIKES}"`));
  assert.equal(WEEKLY, '0 8 * * 1');
  const waits = [];
  await worker.scheduled({ cron: SPIKES, scheduledTime: WED }, { STORE: memoryKV() }, { waitUntil: p => waits.push(p) });
  assert.equal(waits.length, 1);
  await waits[0];
});

test('signing in and adding a site remember the dashboard’s address for the links', async () => {
  const STORE = memoryKV({ sites: '["example.com"]' });
  const waits = [];
  const ctx = { waitUntil: p => waits.push(p) };
  const e = { DASHBOARD_PASSWORD: 'pw', DEMO: 'true', STORE };
  const res = await worker.fetch(new Request('https://lede.me.workers.dev/api/signin', { method: 'POST', headers: { Origin: 'https://lede.me.workers.dev' }, body: '{"password":"pw"}' }), e, ctx);
  assert.equal(res.status, 204);
  await Promise.all(waits);
  assert.equal(STORE.map.get('origin'), 'https://lede.me.workers.dev');
  const writes = STORE.writes;
  await worker.fetch(new Request('https://lede.me.workers.dev/api/signin', { method: 'POST', headers: { Origin: 'https://lede.me.workers.dev' }, body: '{"password":"pw"}' }), e, ctx);
  await Promise.all(waits);
  assert.equal(STORE.writes, writes, 'the same address isn’t written again');
  const wrong = await worker.fetch(new Request('https://evil.test/api/signin', { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '{"password":"no"}' }), e, ctx);
  assert.equal(wrong.status, 401);
  await Promise.all(waits);
  assert.equal(STORE.map.get('origin'), 'https://lede.me.workers.dev', 'a failed sign-in remembers nothing');
});

test('opening the dashboard remembers its address, checking KV once per isolate', async () => {
  const STORE = memoryKV({ sites: '["example.com"]' });
  const waits = [];
  const open = () => worker.fetch(new Request('https://lede.you.workers.dev/api/sites'), { STORE }, { waitUntil: p => waits.push(p) });
  assert.equal((await open()).status, 200);
  await Promise.all(waits);
  assert.equal(STORE.map.get('origin'), 'https://lede.you.workers.dev');
  const [reads, writes] = [STORE.reads, STORE.writes];
  await open();
  await Promise.all(waits);
  assert.equal(STORE.writes, writes);
  assert.equal(STORE.reads, reads + 1, 'only the sites themselves are read again');
});

test('adding a site from the dashboard remembers its address too', async () => {
  const STORE = memoryKV({ sites: '[]' });
  const waits = [];
  const res = await worker.fetch(new Request('https://stats.me.dev/api/sites', { method: 'POST', headers: { Origin: 'https://stats.me.dev' }, body: '{"site":"me.dev"}' }),
    { STORE }, { waitUntil: p => waits.push(p) });
  assert.equal(res.status, 200);
  await Promise.all(waits);
  assert.equal(STORE.map.get('origin'), 'https://stats.me.dev');
});

test('npm run dev (the demo) prints both messages when no webhook is set', async () => {
  const logged = [], log = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    const e = { DEMO: 'true', STORE: memoryKV({ sites: '["birds.example"]' }) };
    const offline = () => { throw new Error('the demo fetches nothing'); };
    await runAlerts(WEEKLY, e, MONDAY, offline);
    await runAlerts(SPIKES, e, WED, offline);
  } finally { console.log = log; }
  assert.equal(logged.length, 2);
  assert.match(logged[0], /^Lede alert:\nbirds\.example, the week of Oct 19\n.+\.\nReaders stay longest on \/owls.+\.\n[\d,]+ visitors[.,]/, 'the demo’s fixed second line, with no Workers AI');
  assert.match(logged[1], /^Lede alert:\n24 people are on birds\.example right now, 17 of them on \/migration, most of those from Hacker News\. Usually about 2 at this time of day\.$/);
});
