import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, sqlStore } from '../src/api.js';
import { ranges, dayOf, zoneOffset, summarySql, seriesSql, topSourceSql, breakdownSql, flowSql, firstSeenSql, LISTS, BREAKDOWNS, DAY } from '../src/queries.js';
import { toSummary, toSeriesBoth, byPeriod } from '../src/shape.js';
import { dayDate, todayPace } from '../public/story.js';

const SITES = ['example.com'];
const ENV = { ACCOUNT_ID: 'acc', ANALYTICS_TOKEN: 'tok', DATASET: 'lede' };
const url = s => new URL(`https://worker.test/api/${s}`);
const H = 3600;
const iso = t => new Date(t * 1000).toISOString();
// The local date and time of a unix second in a zone, as "2026-11-01 00:00:00".
const formats = new Map();
const local = (zone, t) => {
  if (!formats.has(zone)) formats.set(zone, new Intl.DateTimeFormat('sv-SE', { timeZone: zone, dateStyle: 'short', timeStyle: 'medium' }));
  return formats.get(zone).format(t * 1000);
};
const lengths = r => r.bounds.slice(1).map((b, i) => b - r.bounds[i]);

// Runs a day expression from dayOf the way SQL would, for one instant.
function evalDay(sql, t) {
  const m = sql.match(/^intDiv\(t - (\d+), 86400\)$/);
  if (m) return Math.floor((t - m[1]) / DAY);
  return sql.split(' + ').reduce((n, term) => n + (t >= Number(term.match(/^if\(t >= (\d+), 1, 0\)$/)[1]) ? 1 : 0), 0);
}

// Every bound is a local midnight, one calendar day after the last, and the dashboard's day labels
// (dayDate: start + i days + noon) land on the same dates, in both periods.
function assertDays(zone, r, days) {
  assert.equal(r.bounds.length, 2 * days + 1);
  assert.equal(r.bounds[0], r.prevStart);
  assert.equal(r.bounds[days], r.start);
  assert.equal(r.bounds[2 * days], r.end);
  const dates = r.bounds.map(b => local(zone, b).slice(0, 10));
  dates.forEach((d, k) => k && assert.equal(Date.parse(d) - Date.parse(dates[k - 1]), DAY * 1000, `${dates[k - 1]} then ${d}`));
  for (let i = 0; i < days; i++) {
    assert.equal(local(zone, dayDate(r.start, i) / 1000).slice(0, 10), dates[days + i], `day ${i}`);
    assert.equal(local(zone, dayDate(r.start - days * DAY, i) / 1000).slice(0, 10), dates[i], `previous day ${i}`);
  }
}

test('New York across the November change: the day the clocks go back is 25 hours', () => {
  const zone = 'America/New_York', now = Date.UTC(2026, 10, 10, 15); // 10:00 EST, 1 Nov is the change
  const r = ranges(30, 300, now, zone);
  assertDays(zone, r, 30);
  assert.ok(r.bounds.every(b => local(zone, b).endsWith('00:00:00')));
  assert.equal(iso(r.start), '2026-10-12T04:00:00.000Z', 'start is midnight EDT');
  assert.equal(iso(r.end), '2026-11-11T05:00:00.000Z', 'end is midnight EST');
  assert.deepEqual(lengths(r).filter(l => l !== DAY), [25 * H]);
  // The previous period stops at 10:00 too, on its own last day.
  assert.equal(local(zone, r.prevEnd), '2026-10-11 10:00:00');
  // An offset alone puts every midnight before the change an hour off.
  const fixed = ranges(30, 300, now);
  assert.equal(fixed.start - r.start, H);
  assert.equal(fixed.end, r.end);
});

test('Lord Howe Island springs forward half an hour, so one day is 23.5 hours', () => {
  const zone = 'Australia/Lord_Howe', now = Date.UTC(2026, 9, 27, 3);
  const r = ranges(30, -660, now, zone);
  assertDays(zone, r, 30);
  assert.ok(r.bounds.every(b => local(zone, b).endsWith('00:00:00')));
  assert.deepEqual(lengths(r).filter(l => l !== DAY), [23.5 * H]);
  assert.equal(local(zone, r.bounds[r.bounds.findIndex((b, k) => r.bounds[k + 1] - b === 23.5 * H)]).slice(0, 10), '2026-10-04');
});

test('Kolkata has no daylight saving: every day is 86,400 s and days are counted with intDiv', () => {
  const zone = 'Asia/Kolkata', now = Date.UTC(2026, 9, 27, 3);
  const r = ranges(45, -330, now, zone);
  assertDays(zone, r, 45);
  assert.ok(lengths(r).every(l => l === DAY));
  assert.equal(iso(r.start), '2026-09-12T18:30:00.000Z');
  assert.deepEqual(r, ranges(45, -330, now), 'the same as the offset alone');
  const q = parseQuery(url(`series?days=45&tzName=${zone}`), SITES, now);
  assert.ok(seriesSql('lede', q).includes(`intDiv(t0 - ${r.prevStart}, 86400) AS d`));
});

test('a midnight the clocks skip starts the day at the change; one shown twice starts at the first', () => {
  // Havana springs from 00:00 to 01:00 on 8 March 2026.
  const havana = ranges(30, 300, Date.UTC(2026, 2, 20, 3), 'America/Havana');
  assertDays('America/Havana', havana, 30);
  const skipped = havana.bounds.find(b => local('America/Havana', b).startsWith('2026-03-08'));
  assert.equal(local('America/Havana', skipped), '2026-03-08 01:00:00');
  assert.equal(local('America/Havana', skipped - 1), '2026-03-07 23:59:59');
  // Santiago goes from 00:00 back to 23:00 on 5 April 2026, so 4 April has 25 hours.
  const chile = ranges(30, 240, Date.UTC(2026, 3, 20, 3), 'America/Santiago');
  assertDays('America/Santiago', chile, 30);
  assert.deepEqual(lengths(chile).filter(l => l !== DAY), [25 * H]);
});

test('a name that is not a time zone falls back to the offset', () => {
  const now = Date.UTC(2026, 10, 10, 15);
  assert.equal(zoneOffset('Mars/Olympus_Mons'), null);
  assert.equal(zoneOffset('x'.repeat(65)), null);
  assert.equal(zoneOffset(''), null);
  const { tz, filters, site, days, ...r } = parseQuery(url('summary?days=30&tz=300&tzName=Mars/Olympus_Mons'), SITES, now);
  assert.deepEqual(r, ranges(30, 300, now));
  assert.equal(parseQuery(url('summary?days=30&tz=300&tzName=America/New_York'), SITES, now).start, ranges(30, 300, now, 'America/New_York').start);
});

test('SQL puts every instant in the local day it belongs to, across a daylight-saving change', () => {
  for (const [zone, now] of [['America/New_York', Date.UTC(2026, 10, 10, 15)], ['Australia/Lord_Howe', Date.UTC(2026, 9, 27, 3)], ['America/Havana', Date.UTC(2026, 2, 20, 3)]]) {
    const r = ranges(30, 0, now, zone);
    const both = dayOf('t', r.bounds.slice(0, 60)), cur = dayOf('t', r.bounds.slice(30, 60));
    assert.match(both, /^if\(t >= \d+, 1, 0\)( \+ if\(t >= \d+, 1, 0\)){58}$/, 'one comparison per midnight after the first');
    const first = Date.parse(local(zone, r.prevStart).slice(0, 10));
    for (let t = r.prevStart; t < r.end; t += 30 * 60) {
      const want = (Date.parse(local(zone, t).slice(0, 10)) - first) / DAY / 1000;
      assert.equal(evalDay(both, t), want, `${zone} ${local(zone, t)}`);
      if (t >= r.start) assert.equal(evalDay(cur, t), want - 30);
    }
  }
});

test('every query stays well under the 10 KiB limit for 45 days with a clock change and filters', () => {
  const q = parseQuery(url(`series?days=45&tzName=America/New_York&path=${'/a'.repeat(100)}&referrer=news.ycombinator.com&channel=social`), SITES, Date.UTC(2026, 10, 10, 15));
  const sqls = [summarySql('lede', q), seriesSql('lede', q), topSourceSql('lede', q), flowSql('lede', q), firstSeenSql('lede', q, 'path'),
    ...BREAKDOWNS.map(dim => breakdownSql('lede', q, dim))];
  assert.ok(seriesSql('lede', q).includes(' + if('), 'days are counted by midnight');
  for (const sql of sqls) assert.ok(new TextEncoder().encode(sql).length < 8 * 1024, `${sql.length} bytes: ${sql.slice(0, 60)}`);
});

test('one query reads both periods, grouping visits by period so none straddles the two', () => {
  const q = parseQuery(url('summary?days=7&referrer='), SITES, Date.UTC(2026, 9, 27, 15));
  const sql = summarySql('lede', q);
  const window = `((timestamp >= toDateTime(${q.prevStart}) AND timestamp < toDateTime(${q.prevEnd})) OR (timestamp >= toDateTime(${q.start}) AND timestamp < toDateTime(${q.end})))`;
  assert.ok(sql.includes(window));
  assert.ok(sql.includes(`if(timestamp >= toDateTime(${q.start}), 1, 0) AS p`));
  assert.match(sql, /GROUP BY p, visit\) GROUP BY p$/);
  assert.match(sql, /countIf\(w > n\) AS sampled/);
  assert.equal(sql.match(/hex\(blob4\) = ''/g).length, 1, 'filters apply once, to both windows');
  assert.match(seriesSql('lede', q), /GROUP BY p, d ORDER BY p, d$/);
  for (const dim of BREAKDOWNS) {
    const both = breakdownSql('lede', q, dim);
    assert.ok(both.includes(window) && both.includes('GROUP BY p, key'), dim);
    assert.ok(both.endsWith(`LIMIT ${LISTS.breakdown.both}`), dim);
    const prev = breakdownSql('lede', q, dim, 'prev');
    assert.ok(prev.includes(`timestamp >= toDateTime(${q.prevStart}) AND timestamp < toDateTime(${q.prevEnd})`) && !prev.includes(' OR '), dim);
    assert.ok(prev.endsWith(`LIMIT ${LISTS.breakdown.keep}`), dim);
  }
  assert.ok(flowSql('lede', q, 'cur').endsWith(`LIMIT ${LISTS.flows.keep}`));
  // The top sources per day only need this period.
  assert.ok(!topSourceSql('lede', q).includes(' OR '));
});

test('merged rows split into periods; a period with no visits reads as zeros, not missing', () => {
  assert.deepEqual(byPeriod([{ p: 1, k: 'a' }, { p: '0', k: 'b' }, { p: '1', k: 'c' }]), { cur: [{ p: 1, k: 'a' }, { p: '1', k: 'c' }], prev: [{ p: '0', k: 'b' }] });
  const s = toSummary([{ p: 1, visitors: '10', visits: '12', views: '30', bounces: '6', total_time: '600', sampled: '3' }]);
  assert.deepEqual(s.prev, { visitors: 0, visits: 0, views: 0, bounce: 0, duration: 0 });
  assert.equal(s.cur.bounce, .5);
  assert.equal(s.sampled, true);
  assert.deepEqual(toSummary([]), { cur: s.prev, prev: s.prev, sampled: false });
  assert.equal(toSummary([{ p: 0, visitors: '1', sampled: '4' }]).sampled, false, 'only this period counts');
  // d counts from the start of the previous period: 0–2 are the days before, 3–5 this period's.
  const ser = toSeriesBoth([{ p: 0, d: '0', visitors: '4' }, { p: 0, d: '2', visitors: '1' }, { p: 1, d: '3', visitors: '9' }, { p: 1, d: '5', visitors: '2' }], 3);
  assert.deepEqual(ser.prev.visitors, [4, 0, 1]);
  assert.deepEqual(ser.cur.visitors, [9, 0, 2]);
});

test('summary says when a period was sampled', async () => {
  const store = sqlStore(ENV, async () => new Response(JSON.stringify({ data: [{ p: 1, visitors: '9', visits: '9', views: '40', bounces: '1', total_time: '0', sampled: '2' }] })));
  const s = await store.summary(parseQuery(url('summary?days=3'), SITES));
  assert.equal(s.sampled, true);
  assert.equal(s.prev.visitors, 0);
});

// A fake SQL API for breakdowns: answers the query over both periods with rows, and a single-period
// query with that period's own list.
function listSql(calls, both, single) {
  return async (endpoint, init) => {
    calls.push(init.body);
    const data = init.body.includes(' OR ') ? both : single(init.body.includes('LIMIT 100') ? 'cur' : 'prev');
    return new Response(JSON.stringify({ data }));
  };
}
const row = (p, key, visitors) => ({ p, key, visitors: String(visitors), visits: String(visitors), views: String(visitors), bounces: '0', total_time: '0' });

test('breakdowns keep the top 100 of each period from one query', async () => {
  const calls = [];
  // Ordered by visitors across both periods, as SQL returns them.
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push(row(1, `/c${i}`, 1000 - i), row(0, `/p${i}`, 999 - i));
  const store = sqlStore(ENV, listSql(calls, rows, () => assert.fail('no second query')));
  const { rows: out } = await store.breakdown(parseQuery(url('breakdown?days=3'), SITES), 'path');
  assert.equal(calls.length, 1);
  const cur = out.filter(r => r.visitors > 0), gone = out.filter(r => r.visitors === 0);
  assert.equal(cur.length, 100);
  assert.equal(cur.at(-1).key, '/c99');
  assert.equal(gone.length, 100, 'the previous period\'s own top 100, kept as losses');
  assert.equal(gone.at(-1).prev.visitors, 900);
});

test('when one period fills the whole answer, the other is asked for on its own', async () => {
  const calls = [];
  // Traffic fell tenfold: the previous period's long tail outranks most of this period.
  const rows = [...Array.from({ length: 995 }, (_, i) => row(0, `/p${i}`, 5000 - i)), ...Array.from({ length: 5 }, (_, i) => row(1, `/c${i}`, 3000 - i))];
  const own = Array.from({ length: 100 }, (_, i) => row(1, `/c${i}`, 3000 - i));
  const store = sqlStore(ENV, listSql(calls, rows, only => (assert.equal(only, 'cur'), own)));
  const { rows: out } = await store.breakdown(parseQuery(url('breakdown?days=3'), SITES), 'path');
  assert.equal(calls.length, 2);
  assert.equal(out.filter(r => r.visitors > 0).length, 100);
  assert.equal(out.filter(r => r.visitors === 0).length, 100);
});

test("today's hours match the local clock after a daylight-saving change earlier in the period", async () => {
  // Berlin two days after the clocks went back, New York nine days after, Berlin four days after they sprang forward.
  for (const [zone, now] of [['Europe/Berlin', Date.UTC(2026, 9, 27, 9, 30)], ['America/New_York', Date.UTC(2026, 10, 10, 15, 30)], ['Europe/Berlin', Date.UTC(2026, 3, 2, 8, 30)]]) {
    const q = parseQuery(url(`hourly?days=30&tzName=${zone}`), SITES, now);
    let sql;
    // Every hour has 10 visitors and today's so far 15; the hours still to come would have 1,000.
    const store = sqlStore(ENV, async (_, init) => (sql = init.body, new Response(JSON.stringify({ data: Array.from({ length: 30 * 24 },
      (_, hr) => ({ hr, visitors: hr < 29 * 24 ? 10 : hr < 29 * 24 + 10 ? 15 : 1000 })) }))));
    const hourly = await store.hourly(q), t = now / 1000;
    assert.equal(hourly.visitors.length, 30 * 24);
    assert.ok(sql.includes(`toUnixTimestamp(timestamp) - ${hourly.start}, 3600`) && sql.includes(`timestamp < toDateTime(${q.end})`), zone);
    assert.equal(q.end - hourly.start, 30 * DAY, 'exactly as many hours as there are slots');
    const h = Math.floor((t - hourly.start) / H);
    assert.equal(Math.floor(h / 24), 29, zone);
    assert.equal(h % 24, Number(local(zone, t).slice(11, 13)), `${zone} ${local(zone, t)}`);
    assert.equal(local(zone, hourly.start + 29 * DAY), `${local(zone, t).slice(0, 10)} 00:00:00`, 'hour 0 of today is local midnight');
    const P = todayPace(hourly, t);
    assert.deepEqual([P.today, P.usual], [150, 100], zone);
    assert.equal(todayPace(hourly, t - 8 * H), null, 'too early in the day to say');
  }
});
