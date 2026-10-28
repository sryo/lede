import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { runAlerts, webhookRequest, plain, WEEKLY, SPIKES } from '../src/alerts.js';

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
function liveRows(nowSec, here, onPage = here) {
  return [
    ...Array.from({ length: here }, (_, i) => ({ visitor: `v${i}`, path: i < onPage ? '/blog/x' : `/p${i % 3}`, referrer: i % 4 === 3 ? 'google.com' : 'news.ycombinator.com', country: 'US', first: String(nowSec - 200), last: String(nowSec - 10 - i) })),
    ...Array.from({ length: 3 }, (_, i) => ({ visitor: `old${i}`, path: '/', referrer: '', country: 'US', first: String(nowSec - 1500), last: String(nowSec - 900) })),
  ];
}

// The SQL API and the webhook, faked. `usual` is visitors per day in the same 5 minutes over the last 14 days.
function fakes({ rows = weekRows, here = 0, onPage, usual = [], hook = 200 } = {}) {
  const sent = [], sql = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/analytics_engine/sql')) {
      const body = String(init.body);
      sql.push(body);
      const nowSec = Math.floor(fetchImpl.now / 1000);
      const data = body.includes('argMax(blob2') ? liveRows(nowSec, here, onPage)
        : body.includes('* 86400 < 300') ? usual.map((v, d) => ({ d: String(d), visitors: String(v) }))
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
  STORE: memoryKV({ sites: '["example.com"]', origin: 'https://lede.example.workers.dev' }), ...extra,
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
    'Top source: google.com, with 500 visitors.',
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
  assert.match(body, /\n\nquiet\.org, the week of Oct 19\nNo visitors in the last 7 days yet\.$/);
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
    '42 people are on /blog/x right now, most from Hacker News. Usually about 2 at this time of day.',
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
  assert.match(half.sent[0].body, /^20 people are on example\.com right now, 12 of them on \/blog\/x, most from Hacker News\./);
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
  assert.match(logged[0], /^Lede alert:\nbirds\.example, the week of Oct 19\n.+\.\n[\d,]+ visitors, /);
  assert.match(logged[1], /^Lede alert:\n24 people are on birds\.example right now, 17 of them on \/migration, most from Hacker News\. Usually about 2 at this time of day\.$/);
});
