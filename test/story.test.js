import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStory, tellStory, bounceSplit, bounceCaption, waterfall, waterfallCaption, spikeSegment,
  flowShare, flowCaption, onlineStory, crowd, crowdCaption, crowdLine, findings, pagesFinding, todayPace, pageStory, eventsSentence, channelShare, goalStory, suggestGoal, pagesCaption, sourceStory, scrollStory,
  scrollPicture, scrollNumbers, pictureCaption, audienceStory, audienceNote, labelOf, didWhat, dayKey, dayDate,
  unitOf, countNotes, quietRuns, vitalRating, vitalsLine, vitalsFinding } from '../public/story.js';
import { parseQuery } from '../src/api.js';
import { demoStore, demoNotes } from '../src/demo.js';
import { onEachWeekday } from './weekdays.js';
import { channelFor } from '../src/channels.js';

const DAY = 86400;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const strip = html => html.replace(/<[^>]+>/g, '');

// A referrer row as the breakdown API returns it.
const ref = (key, visitors, prevVisitors, bounce = .4, prevBounce = bounce, extra = {}) => ({
  key, visitors, visits: visitors, views: visitors * 2, bounce, duration: 60,
  channel: channelFor(key, new URLSearchParams()),
  ...(prevVisitors == null ? {} : { prev: { visitors: prevVisitors, visits: prevVisitors, views: prevVisitors * 2, bounce: prevBounce, duration: 60 } }),
  ...extra,
});
const totalsOf = (rows) => {
  const agg = side => {
    const rs = rows.map(r => side ? r.prev : r).filter(Boolean);
    const visits = rs.reduce((a, r) => a + r.visits, 0);
    return { visitors: rs.reduce((a, r) => a + r.visitors, 0), visits, views: visits * 2,
      bounce: visits ? rs.reduce((a, r) => a + r.visits * r.bounce, 0) / visits : 0, duration: 60 };
  };
  return { cur: agg(false), prev: agg(true) };
};
// 28 days starting on a Monday, flat at `base` unless `days` overrides a day.
const START = Date.UTC(2026, 8, 28) / 1000;
const series = (base, days = {}, top = {}) => {
  const visitors = Array.from({ length: 28 }, (_, i) => days[i] ?? base);
  return {
    start: START, days: 28,
    cur: { visitors, views: visitors.map(v => v * 2), bounce: visitors.map(() => .4) },
    prev: { visitors: visitors.map(() => base), views: visitors.map(() => base * 2), bounce: visitors.map(() => .4) },
    top: visitors.map((_, i) => top[i]?.[0] ?? 'google.com'),
    topVisitors: visitors.map((v, i) => top[i]?.[1] ?? Math.round(v / 3)),
  };
};
const story = ({ rows, ser, pages = [], flows = [], prevFlows = [], notes }) => {
  const totals = totalsOf(rows);
  const S = readStory({ totals, ser, pages: { rows: pages }, refs: { rows }, flows: { flows, prev: prevFlows }, notes });
  return { S, T: tellStory(S, ser, 28) };
};

/* ---------- bounce: who visited vs how they behaved ---------- */

test('bounce change splits into mix and per-source behaviour that add up to the total', () => {
  const rows = [ref('news.ycombinator.com', 2000, 1000, .6, .48), ref('google.com', 4000, 4000, .37, .37), ref('', 3000, 3000, .30, .29)];
  const { S } = story({ rows, ser: series(300) });
  const B = bounceSplit(S);
  const curV = 9000, prevB = (1000 * .48 + 4000 * .37 + 3000 * .29) / 8000;
  close(B.mix, (2000 * .48 + 4000 * .37 + 3000 * .29) / curV - prevB);
  close(B.top.pts, 2000 * (.6 - .48) / curV);
  assert.equal(B.top.key, 'news.ycombinator.com');
  close(B.mix + B.top.pts + B.rest, B.total);
  close(B.total, S.c.bounce - S.p.bounce);
  assert.equal(B.cause, 'source');
  assert.equal(strip(bounceCaption(B)), 'Bounce rose 4 points, mostly Hacker News readers');
});

test('bounce caption credits who visited when the mix explains most of the change', () => {
  // Same per-source rates; only the share of a high-bounce source grew.
  const rows = [ref('news.ycombinator.com', 4000, 1000, .6, .6), ref('google.com', 4000, 4000, .3, .3)];
  const B = bounceSplit(story({ rows, ser: series(300) }).S);
  assert.equal(B.cause, 'mix');
  close(B.mix, B.total, 1e-12);
  assert.match(strip(bounceCaption(B)), /^Bounce rose \d+ points, mostly from a change in where visitors came from$/);
});

test('sources new this period count toward everyone else, so the split still sums', () => {
  const rows = [ref('google.com', 4000, 4000, .3, .3), ref('claude.ai', 1000, null, .9)];
  const B = bounceSplit(story({ rows, ser: series(180) }).S);
  close(B.mix + (B.top?.pts ?? 0) + B.rest, B.total);
});

async function demoStory(store, day) {
  const q = parseQuery(new URL('https://w.test/api/x?days=30&tz=0'), ['example.com']);
  const [totals, ser, pages, refs, flows] = await Promise.all([store.summary(q), store.series(q),
    store.breakdown(q, 'path'), store.breakdown(q, 'referrer'), store.flows(q)]);
  const S = readStory({ totals, ser, pages, refs, flows });
  const T = tellStory(S, ser, 30);
  assert.equal(S.lead.key, 'google.com', day);
  assert.match(T.html, /mostly to .*\/migration/, day);
  const B = bounceSplit(S);
  assert.ok(Math.abs(B.total) < .005, day);
  close(B.mix + B.top.pts + B.rest, B.total);
}

test('the demo data: search brought most of the growth, mostly to /migration, and bounce barely moved', async () => {
  await demoStory(demoStore, 'today');
});

test('the demo data tells the same story on whatever day of the week it is', async () => {
  await onEachWeekday(demoStory);
});

test('no previous period: no bounce split', () => {
  const rows = [ref('google.com', 4000, null)];
  assert.equal(bounceSplit(story({ rows, ser: series(140) }).S), null);
});

/* ---------- growth waterfall ---------- */

const growth = () => {
  const rows = [ref('news.ycombinator.com', 6000, 3000), ref('google.com', 9000, 9100), ref('', 5000, 5050),
    ref('perplexity.ai', 900, 500), ref('chatgpt.com', 1500, 1000), ref('claude.ai', 450, null)];
  return story({ rows, ser: series(800) });
};

test('waterfall: named sources plus everyone else add up to the total change', () => {
  const { S, T } = growth();
  const W = waterfall(S, T.told);
  const steps = W.steps.filter(s => s.kind !== 'total');
  assert.equal(steps.reduce((a, s) => a + s.value, 0), S.diff);
  assert.equal(W.steps.at(-1).kind, 'total');
  assert.equal(W.steps.at(-1).value, S.diff);
  assert.equal(steps.at(-1).kind, 'else');
  assert.ok(steps.some(s => s.kind === 'named' && s.key === 'news.ycombinator.com'));
});

test('waterfall groups AI assistants into one step when the sentence names the channel', () => {
  const { S, T } = growth();
  assert.ok(T.told.has('ch:ai'), 'AI assistants moved more visitors than the fastest grower alone');
  assert.match(strip(T.html), /AI assistants went from 8% to 12% of all visitors\.$/);
  const W = waterfall(S, T.told);
  const ai = W.steps.find(s => s.channel === 'ai');
  assert.equal(ai.label, 'AI assistants');
  assert.equal(ai.value, 400 + 500 + 450);
  assert.ok(!W.steps.some(s => s.key === 'perplexity.ai'));
  assert.equal(strip(waterfallCaption(W, S).html), 'The extra 4,200 visitors came from two sources');
});

test('the waterfall caption gives the exact total, the same number home and the chart show', () => {
  const W = { total: 3507, steps: [{ kind: 'named', value: 2092, label: 'google.com' }, { kind: 'named', value: 2281, label: 'AI assistants' }, { kind: 'rest', value: -866 }] };
  assert.equal(strip(waterfallCaption(W, { flat: false }).html), 'The extra 3,507 visitors came from two sources');
});

test('waterfall steps follow the order the sentence names them in, even when a later one moved more', () => {
  const src = (key, change, channel) => ({ key, label: key, change, channel, value: 1000 + change, prev: 1000 });
  const S = { p: { visitors: 20000 }, diff: 3507, sources: [src('google.com', 2092, 'search'), src('chatgpt.com', 1200, 'ai'), src('claude.ai', 1081, 'ai'), src('', -866, 'direct')] };
  const W = waterfall(S, new Set(['google.com', 'ch:ai']));
  assert.deepEqual(W.steps.filter(s => s.kind === 'named').map(s => s.label), ['google.com', 'AI assistants']);
});

test('waterfall with no named source shows the two biggest movers', () => {
  const rows = [ref('a.com', 1000, 1010), ref('b.com', 1000, 900), ref('c.com', 1000, 1050), ref('d.com', 1000, 995)];
  const { S } = story({ rows, ser: series(140) });
  const W = waterfall(S, new Set());
  const movers = W.steps.filter(s => s.kind === 'mover').map(s => s.key);
  assert.deepEqual(movers, ['b.com', 'c.com']);
  assert.equal(W.steps.filter(s => s.kind !== 'total').reduce((a, s) => a + s.value, 0), S.diff);
});

test('waterfall is hidden without a previous period', () => {
  const rows = [ref('a.com', 1000, null)];
  const { S, T } = story({ rows, ser: series(40) });
  assert.equal(waterfall(S, T.told), null);
});

/* ---------- daily bars: the spike's top source ---------- */

test('spike segment is the top source\'s visitors on the spike day', () => {
  const rows = [ref('news.ycombinator.com', 4000, 1000), ref('google.com', 6000, 6000)];
  const ser = series(300, { 18: 3000 }, { 18: ['news.ycombinator.com', 2700] });
  const { S } = story({ rows, ser });
  assert.equal(S.spike, 18);
  assert.deepEqual(spikeSegment(S, ser), { day: 18, total: 3000, top: 2700, source: 'news.ycombinator.com' });
});

test('a busy day made by a source the sentence does not lead with still shows that source on its bar', () => {
  const rows = [ref('google.com', 9000, 6000), ref('facebook.com', 1500, 1000)];
  const ser = series(300, { 18: 1400 }, { 18: ['facebook.com', 1150] });
  const { S } = story({ rows, ser });
  assert.notEqual(S.lead?.key, 'facebook.com');
  assert.deepEqual(spikeSegment(S, ser, START), { day: 18, total: 1400, top: 1150, source: 'facebook.com' });
});

test('no spike: no coral segment', () => {
  const rows = [ref('news.ycombinator.com', 1200, 1000), ref('google.com', 6000, 6000)];
  const ser = series(260, { 3: 300 });
  const { S } = story({ rows, ser });
  assert.equal(S.spike, -1);
  assert.equal(spikeSegment(S, ser), null);
});

/* ---------- sankey caption ---------- */

test('sankey share: the named source\'s part of all first visits to the named page', () => {
  const flows = [
    { source: 'news.ycombinator.com', page: '/blog/new', visitors: 2404 },
    { source: 'google.com', page: '/blog/new', visitors: 1000 },
    { source: '', page: '/blog/new', visitors: 596 },
    { source: 'news.ycombinator.com', page: '/', visitors: 2000 },
  ];
  const sh = flowShare(flows, 'news.ycombinator.com', '/blog/new');
  close(sh.share, 2404 / 4000);
  assert.equal(sh.tenths, 6);
  const rows = [ref('news.ycombinator.com', 4404, 1000), ref('google.com', 1000, 1000), ref('', 596, 596)];
  const ser = series(215);
  const { S, T } = story({ rows, ser, flows, pages: [{ key: '/blog/new', visitors: 4000 }, { key: '/', visitors: 2000, prev: { visitors: 2000 } }] });
  assert.equal(T.page, '/blog/new');
  assert.equal(strip(flowCaption(S, T, flows)), '6 in 10 visitors who landed on the new page /blog/new came from Hacker News');
});

test('sankey caption without a named page says where most visits landed', () => {
  const flows = [{ source: 'google.com', page: '/', visitors: 900 }, { source: 'google.com', page: '/docs', visitors: 100 }];
  const rows = [ref('google.com', 1000, 1000)];
  const { S, T } = story({ rows, ser: series(36), flows });
  assert.equal(strip(flowCaption(S, T, flows)), '9 in 10 visitors landed on the home page');
});

/* ---------- the crowd of people online ---------- */

const live = (n, left, extra = []) => ({
  now: n, recent: n + left,
  visitors: [
    ...extra,
    ...Array.from({ length: n }, (_, i) => ({ path: `/p${i}`, referrer: 'google.com', country: 'US', seconds: 30 + i, active: true })),
    ...Array.from({ length: left }, (_, i) => ({ path: `/q${i}`, referrer: '', country: 'DE', seconds: 200, active: false })),
  ],
});

test('crowd: people here first (named source first), then those who left, at most 18', () => {
  const L = live(6, 15, [{ path: '/blog/new', referrer: 'news.ycombinator.com', country: 'US', seconds: 241, active: true }]);
  L.visitors.push(L.visitors.splice(0, 1)[0]);
  L.now = 7;
  L.recent = 22;
  const C = crowd(L, new Set(['news.ycombinator.com']));
  assert.equal(C.length, 18);
  assert.deepEqual(C.slice(0, 7).map(p => p.here), Array(7).fill(true));
  assert.equal(C[0].named, true);
  assert.ok(C.slice(1).every(p => !p.named));
  assert.ok(C.slice(7).every(p => !p.here));
  assert.ok(C.every(p => /^[A-Za-z]$/.test(p.letter)));
  assert.equal(strip(crowdCaption(L)), '7 here now · 22 in the last 30 minutes');
});

test('crowd letters stay with the same person across refreshes', () => {
  const a = crowd(live(3, 2), new Set()), b = crowd({ ...live(3, 2), visitors: live(3, 2).visitors.slice().reverse() }, new Set());
  const byPath = C => Object.fromEntries(C.map(p => [p.v.path, p.letter]));
  assert.deepEqual(byPath(a), byPath(b));
});

test('crowd: nobody online', () => {
  assert.deepEqual(crowd(live(0, 0), new Set()), []);
  assert.equal(strip(crowdCaption(live(0, 0))), 'No one here right now');
  assert.equal(strip(crowdCaption(live(0, 4))), 'No one here right now · 4 in the last 30 minutes');
});

/* ---------- pages and source captions ---------- */

test('pages caption counts growth among shown pages and names new ones', () => {
  const rows = [{ key: '/', value: 300, prev: 290 }, { key: '/docs', value: 200, prev: 150 }, { key: '/blog/new', value: 120, prev: undefined }];
  assert.equal(strip(pagesCaption(rows).html), 'Both pages shown grew; one is new');
  rows[1].prev = 250;
  assert.equal(strip(pagesCaption(rows).html), '1 of 2 pages shown grew; one is new');
  assert.equal(strip(pagesCaption([{ key: '/', value: 10 }, { key: '/docs', value: 4 }]).html), 'Most visited: the home page', 'nothing to compare with yet');
  assert.deepEqual(pagesCaption([]), { html: '', key: null });
});

test('source story: total, change, the burst days and bounce as a percentage, like the bounce card', () => {
  const visitors = Array.from({ length: 28 }, (_, i) => i === 18 ? 2758 : i === 19 ? 389 : 130);
  const ser = { start: START, days: 28, cur: { visitors }, prev: { visitors: visitors.map(() => 128) } };
  const sum = { cur: { visitors: visitors.reduce((a, b) => a + b), bounce: .6 }, prev: { visitors: 128 * 28, bounce: .48 } };
  const s = sourceStory(sum, ser, 'Hacker News', 28);
  assert.equal(strip(s.html), `6,527 visitors from Hacker News, up 82%. Almost half came on Fri, Oct 16–17. 60% of their visits bounced.`);
  assert.equal(s.without, 'Without those two days, Hacker News sent 6% fewer visitors than the 28 days before.');
});

/* ---------- the crowd as a line, in the order people arrived ---------- */

// Last seen `ago` seconds ago after `stay` seconds on the site, so they arrived ago + stay seconds ago.
const seen = (path, ago, stay = 30, referrer = '') => ({ path, referrer, country: 'US', seconds: stay, active: ago < 300, ago });

test('crowd line: people here now first, then those who left, each in the order they arrived', () => {
  const L = { now: 2, recent: 4, visitors: [seen('/now', 10, 20), seen('/long', 60, 1500, 'news.ycombinator.com'), seen('/gone', 900, 60), seen('/older', 1200, 30)] };
  const C = crowdLine(L, new Set(['news.ycombinator.com']));
  assert.deepEqual(C.people.map(p => p.v.path), ['/long', '/now', '/older', '/gone']);
  assert.deepEqual(C.people.map(p => p.here), [true, true, false, false]);
  assert.equal(C.people[0].named, true);
  assert.equal(C.more, 0);
});

test('crowd line drops the earliest of those who left first when there are too many', () => {
  const L = { now: 1, recent: 5, visitors: [seen('/here', 10), ...[1, 2, 3, 4].map(i => seen(`/p${i}`, i * 100 + 300))] };
  const C = crowdLine(L, new Set(), 3);
  assert.deepEqual(C.people.map(p => p.v.path), ['/here', '/p2', '/p1']);
  assert.equal(C.more, 2);
});

test('crowd line with nobody online is empty', () => {
  assert.deepEqual(crowdLine({ now: 0, recent: 0, visitors: [] }, new Set()), { people: [], more: 0 });
});

test('the sentence makes two claims: who moved the total (and where to), and whose visitors rose fastest', () => {
  const rows = [ref('news.ycombinator.com', 4000, 1000, .7, .5), ref('google.com', 6000, 6000), ref('perplexity.ai', 900, 500)];
  const ser = series(300, { 18: 3000 }, { 18: ['news.ycombinator.com', 2700] });
  const { S, T } = story({ rows, ser });
  assert.equal(S.spike, 18, 'the spike is still found, for the chart');
  assert.equal(strip(T.html), 'Hacker News sent 3,000 of the 3,400 extra visitors. perplexity.ai sent 80% more visitors than before, the fastest rise of any source.');
});

/* ---------- findings: the second claim, ranked by how many visitors each one moved ---------- */

test('a drop hidden by a rise elsewhere is named', () => {
  // Hacker News leads the rise, five sources each grew a little, and Google fell 10%.
  const rows = [ref('news.ycombinator.com', 4000, 1000), ref('google.com', 18000, 20000),
    ...['a.com', 'b.com', 'c.com', 'd.com', 'e.com'].map(k => ref(k, 10500, 10000))];
  const { T } = story({ rows, ser: series(3000) });
  assert.equal(strip(T.html), 'Hacker News sent 3,000 of the 3,500 extra visitors. google.com sent 2,000 fewer visitors (−10%).');
  assert.ok(T.told.has('google.com'));
});

test('a flat period still says what moved', () => {
  const rows = [ref('google.com', 10200, 10000), ref('bing.com', 0, 200), ref('', 5000, 5000)];
  const { T } = story({ rows, ser: series(540) });
  assert.equal(strip(T.html), 'About as many visitors as the 28 days before (±0). bing.com sent no visitors, down from 200.');
});

test('a channel growing across several sources is a finding of its own', () => {
  const rows = [ref('google.com', 10000, 10000), ref('chatgpt.com', 500, 200), ref('claude.ai', 300, null), ref('perplexity.ai', 400, 200)];
  const { S } = story({ rows, ser: series(400) });
  const f = findings(S, new Set()).find(x => x.kind === 'channel');
  assert.equal(f.key, 'ai');
  assert.equal(strip(f.html), 'AI assistants went from 4% to 11% of all visitors.');
});

test('findings skip what the sentence already named, biggest first', () => {
  const rows = [ref('google.com', 18000, 20000), ref('x.com', 3000, 1000)];
  const { S } = story({ rows, ser: series(750) });
  const keys = findings(S, new Set()).map(f => f.key);
  assert.ok(keys.indexOf('google.com') >= 0);
  assert.ok(!findings(S, new Set(['google.com'])).some(f => f.key === 'google.com'));
});

test('pages caption names the page that moved most, leaving out the one the sentence names', () => {
  const rows = [{ key: '/', value: 30000, prev: 29500 }, { key: '/pricing', value: 7000, prev: 8500 }, { key: '/docs', value: 8400, prev: 8000 },
    { key: '/blog/new', value: 3000 }];
  assert.equal(strip(pagesFinding(rows, '/blog/new').html), '/pricing lost 1,500 visitors (−18%)');
  assert.equal(pagesFinding([{ key: '/', value: 100, prev: 98 }], null), null);
});

/* ---------- today's pace ---------- */

test('today against the same weekday so far, counting finished hours only', () => {
  // 28 days from Monday Sep 28; day 27 is Sunday Oct 25. Usual hours have 10 visitors, today's have 15.
  const visitors = Array.from({ length: 28 * 24 }, (_, i) => Math.floor(i / 24) === 27 ? 15 : 10);
  const hourly = { start: START, days: 28, visitors };
  const at = (h, m) => START + 27 * DAY + h * 3600 + m * 60;
  const P = todayPace(hourly, at(10, 10));
  assert.equal(P.today, 150);
  assert.equal(P.usual, 100);
  assert.equal(P.pct, 50);
  assert.equal(strip(P.html), 'Today so far: 50% busier than a usual Sunday');
  assert.equal(todayPace(hourly, at(1, 30)), null, 'too early in the day to say');
});

test('a channel whose share only shifted because another source moved is not a finding', () => {
  // Search stays put while Hacker News triples, so search's share falls without search changing.
  const rows = [ref('news.ycombinator.com', 6000, 2000), ref('google.com', 9200, 9000), ref('bing.com', 1000, 1000), ref('', 4000, 4000)];
  const { S } = story({ rows, ser: series(700) });
  assert.ok(!findings(S, new Set(['news.ycombinator.com'])).some(f => f.kind === 'channel'));
});

/* ---------- sub-page sentences ---------- */

test('page sentence: visitors, change or new, and where most first visits came from', () => {
  const flows = [{ source: 'news.ycombinator.com', page: '/blog/new', visitors: 2404 }, { source: 'google.com', page: '/blog/new', visitors: 1000 },
    { source: '', page: '/blog/new', visitors: 596 }];
  const totals = { cur: { visitors: 2985 }, prev: { visitors: 0 } };
  assert.equal(strip(pageStory(totals, flows, '/blog/new', 30)), '2,985 visitors on /blog/new, none in the 30 days before. 6 in 10 of those who landed here came from Hacker News.');
  const spread = [{ source: 'a.com', page: '/p', visitors: 20 }, { source: 'b.com', page: '/p', visitors: 18 }, { source: 'c.com', page: '/p', visitors: 17 }, { source: 'd.com', page: '/p', visitors: 16 }];
  assert.equal(strip(pageStory({ cur: { visitors: 900 }, prev: { visitors: 800 } }, spread, '/p', 30)), '900 visitors on /p, up 13%. Those who landed here came from many places, the most from a.com.');
  assert.equal(strip(pageStory({ cur: { visitors: 5 }, prev: { visitors: 5 } }, [], '/p', 30)), '5 visitors on /p, about the same as before.');
});

test('events sentence counts what stood out', () => {
  assert.equal(eventsSentence([], 30), 'Nothing unusual in the last 30 days.');
  assert.equal(eventsSentence([{}], 30), 'One thing stood out.');
  assert.equal(eventsSentence([{}, {}, {}, {}], 30), 'Four things stood out.');
});

test('the home page is named in words, not as a slash', () => {
  assert.equal(strip(pagesFinding([{ key: '/', value: 6600, prev: 7507 }], null).html), 'The home page lost 907 visitors (−12%)');
});

test('captions return the key they name, so lists bold it even when the words differ from the key', () => {
  assert.equal(pagesFinding([{ key: '/', value: 6600, prev: 7507 }], null).key, '/');
  assert.equal(pagesFinding([{ key: '/q&a', value: 600, prev: 1200 }], null).key, '/q&a', 'escaped in the HTML, raw in the key');
  assert.equal(pagesCaption([{ key: '/', value: 10 }, { key: '/docs', value: 4 }]).key, '/');
  assert.equal(pagesCaption([{ key: '/', value: 300, prev: 290 }]).key, null, 'names no page');
  const step = (kind, key, label, value, channel) => ({ kind, key, label, value, ...(channel ? { channel } : {}) });
  const one = { total: 1000, steps: [step('named', 'a&b.com', 'a&b.com', 600), step('named', 'x.com', 'x.com', -100), step('else', null, 'Everyone else', 500)] };
  const cap = waterfallCaption(one, { flat: false });
  assert.equal(strip(cap.html), 'a&amp;b.com sent 600 of the 1,000 extra visitors');
  assert.equal(cap.key, 'a&b.com');
  const ai = { total: 1000, steps: [step('named', null, 'AI assistants', 600, 'ai'), step('named', 'x.com', 'x.com', -100), step('else', null, 'Everyone else', 500)] };
  assert.equal(waterfallCaption(ai, { flat: false }).key, 'ch:ai');
  assert.equal(waterfallCaption({ total: 3507, steps: [step('named', 'google.com', 'google.com', 2092), step('named', '', 'Direct', 2281)] }, { flat: false }).key, null, 'two places, none named alone');
  assert.equal(waterfallCaption(null, {}).key, null);
});

test('a channel page says how its share of all visitors moved', () => {
  const all = { cur: { visitors: 69000 }, prev: { visitors: 63600 } };
  const ai = { cur: { visitors: 6041 }, prev: { visitors: 3492 } };
  assert.equal(strip(channelShare(ai, all, 'AI assistants')), 'AI assistants went from 5% to 9% of all visitors.');
  assert.equal(channelShare({ cur: { visitors: 100 }, prev: { visitors: 100 } }, { cur: { visitors: 1000 }, prev: { visitors: 1000 } }, 'Email'), null);
});

/* ---------- goals ---------- */

const conv = rows => ({ rows, visits: rows.reduce((a, r) => a + r.visits, 0), reached: rows.reduce((a, r) => a + r.reached, 0) });

test('goal line: the overall rate, and the named source when it converts very differently', () => {
  const c = conv([{ key: 'google.com', visits: 30000, reached: 450 }, { key: 'news.ycombinator.com', visits: 7000, reached: 7 }, { key: '', visits: 20000, reached: 300 }]);
  assert.equal(strip(goalStory(c, ['/signup'], 'news.ycombinator.com')), '1.3% of visits reached /signup; from Hacker News only 0.1%.');
});

test('goal line names the best source when the named one converts like everyone else', () => {
  const c = conv([{ key: 'google.com', visits: 30000, reached: 300 }, { key: 'github.com', visits: 3000, reached: 120 }, { key: '', visits: 20000, reached: 200 }]);
  assert.equal(strip(goalStory(c, ['/signup', '/thanks'], 'google.com')), '1.2% of visits reached a goal; visits from github.com did best, 4.0%.');
  assert.equal(goalStory(conv([{ key: 'a.com', visits: 20, reached: 1 }]), ['/signup'], null), null, 'too few visits to say');
});

test('a page that looks like a goal is suggested once there are none', () => {
  const rows = [{ key: '/', value: 3000 }, { key: '/pricing', value: 900 }, { key: '/signup', value: 300 }, { key: '/thank-you', value: 40 }];
  assert.equal(suggestGoal(rows), '/signup');
  assert.equal(suggestGoal([{ key: '/', value: 10 }, { key: '/docs', value: 5 }]), null);
});

test('the online sentence says how many are here before saying "of them"', () => {
  const v = (referrer, path, seconds) => ({ referrer, path, seconds, active: true, ago: 10 });
  const live = { now: 3, recent: 5, visitors: [v('google.com', '/a', 120), v('google.com', '/b', 60), v('', '/a', 30)] };
  assert.equal(strip(onlineStory(live, new Set(['google.com']), '/x')), '3 people are here now; 2 of them came from google.com. Everyone here now arrived in the last 2 minutes.');
  const one = { now: 1, recent: 1, visitors: [v('', '/a', 30)] };
  assert.equal(strip(onlineStory(one, new Set(), null)), 'One person is here now, on /a. They arrived in the last minute.');
});

/* ---------- how far down a page is read ---------- */

const read = (views, ...reach) => ({ views, reach });

test('scroll: says where half the readers have stopped', () => {
  const say = r => strip(scrollStory(r).html);
  assert.equal(say(read(400, .95, .85, .75, .6, .45, .4, .35, .3, .25, .2)), 'Half your readers stop before the middle of this page.');
  assert.equal(say(read(400, .9, .7, .45, .4, .35, .3, .25, .2, .15, .1)), "Half your readers stop before they're 30% of the way down this page.");
  assert.equal(say(read(400, 1, .98, .95, .9, .85, .8, .7, .6, .55, .3)), 'Half your readers stop just short of the end.');
  assert.equal(say(read(400, 1, .98, .95, .9, .85, .8, .78, .75, .72, .7)), 'Most readers reach the end.');
  assert.equal(say(read(400, 1, 1, 1, 1, 1, 1, 1, 1, 1, .95)), 'Nearly all readers reach the end.');
  assert.equal(say(read(400, 1, 1, .9, .8, .7, .6, .6, .5, .5, .5)), 'Half your readers reach the end.');
});

test('scroll: names the steepest drop, when one stands out', () => {
  const owls = scrollStory(read(900, .93, .87, .81, .76, .43, .4, .37, .35, .34, .33));
  assert.equal(owls.drop, 4);
  assert.equal(strip(owls.sub), 'More readers stop between 40% and 50% of the way down than anywhere else: 33% of them.');
  const first = scrollStory(read(900, .8, .75, .7, .66, .62, .58, .55, .52, .5, .48));
  assert.equal(strip(first.sub), 'More readers stop in the first 10% of the page than anywhere else: 20% of them.');
  const last = scrollStory(read(900, 1, .98, .96, .94, .92, .9, .88, .86, .84, .6));
  assert.equal(strip(last.sub), 'More readers stop between 90% and the end than anywhere else: 24% of them.');
  const even = scrollStory(read(900, .96, .92, .88, .84, .8, .76, .72, .68, .64, .6));
  assert.equal(even.drop, -1, 'a page read evenly has no drop worth naming');
  assert.equal(even.sub, null);
  const all = scrollStory(read(900, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1));
  assert.deepEqual([all.drop, all.sub], [-1, null], 'a page that fits on one screen');
});

test('scroll: too few readers is said plainly, with no chart to read into', () => {
  const few = scrollStory(read(12, .5, .4, .3, .2, .1, .1, .1, .1, .1, .1));
  assert.equal(strip(few.html), 'Only 12 views of this page so far, too few to say how far people read.');
  assert.deepEqual([few.few, few.drop, few.sub], [true, -1, null]);
  assert.equal(strip(scrollStory(read(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)).html), 'Only one view of this page so far, too few to say how far people read.');
  assert.equal(scrollStory(read(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)), null);
  assert.equal(scrollStory(read(49, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)).few, true);
  assert.equal(scrollStory({ views: 50 }), null, 'no bands, nothing to say');
  assert.equal(scrollStory(undefined), null);
});

test('scroll: the demo /owls page tells its drop', async () => {
  const q = parseQuery(new URL('https://w.test/api/engagement?days=30&path=%2Fowls'), ['example.com']);
  const { rows: [r] } = await demoStore.engagement(q);
  const S = scrollStory(r);
  assert.equal(strip(S.html), 'Half your readers stop before the middle of this page.');
  assert.match(strip(S.sub), /^More readers stop between 40% and 50% of the way down than anywhere else: \d+% of them\.$/);
});

/* ---------- countries, devices and browsers ---------- */

// A row as /api/audience returns it: visitors (as many visits), bounce, and last period's visitors (null: no change to show).
const ar = (key, visitors, prev, bounce = .4) => ({ key, visitors, visits: visitors, bounce, prev: prev == null ? null : { visitors: prev, visits: prev } });
// A steady site: the same countries, devices and browsers as before, and phones and computers leave alike.
const steady = (over = {}) => ({
  country: [ar('US', 500, 500), ar('GB', 200, 200), ar('DE', 100, 100)],
  device: [ar('phone', 450, 450, .45), ar('computer', 300, 300, .4), ar('tablet', 50, 50)],
  browser: [ar('chrome', 400, 400), ar('safari', 300, 300), ar('firefox', 100, 100)],
  partial: null, ...over,
});

test('audience: says plainly when nothing stands out, or when there are too few visits to tell', () => {
  assert.equal(audienceStory(steady(), 30).html, 'Nothing stands out about where readers are or what they use.');
  const few = { country: [ar('US', 20, 18)], device: [ar('phone', 20, 18)], browser: [ar('safari', 20, 18)], partial: null };
  assert.equal(audienceStory(few, 30).html, 'Too few visits yet to say much about where readers are or what they use.');
  assert.equal(audienceStory({ country: [], device: [], browser: [], partial: null }, 30), null, 'no visitors, no card');
});

test('audience: phones leaving sooner than computers, said with who most readers are', () => {
  const phones = steady({ device: [ar('phone', 500, 500, .62), ar('computer', 300, 300, .38)] });
  const s = audienceStory(phones, 30);
  assert.equal(strip(s.html), 'Most readers are on phones, and readers on phones leave sooner: 62% of their visits bounce, against 38% on computers.');
  assert.deepEqual([s.dim, s.key], ['device', 'phone']);
  const desk = steady({ device: [ar('computer', 500, 500, .38), ar('phone', 300, 300, .62)] });
  assert.equal(strip(audienceStory(desk, 30).html), 'Most readers are on computers, but readers on phones leave sooner: 62% of their visits bounce, against 38% on computers.');
  const even = steady({ device: [ar('phone', 400, 400, .3), ar('computer', 400, 400, .5), ar('tablet', 200, 200)] });
  assert.equal(strip(audienceStory(even, 30).html), 'Readers on computers leave sooner: 50% of their visits bounce, against 30% on phones.');
});

test('audience: a bounce gap needs 10 points and 50 visits on each side', () => {
  const near = steady({ device: [ar('phone', 500, 500, .47), ar('computer', 300, 300, .38)] });
  assert.match(audienceStory(near, 30).html, /^Nothing stands out/);
  const thin = steady({ device: [ar('phone', 750, 750, .7), ar('computer', 49, 49, .2)] });
  assert.match(audienceStory(thin, 30).html, /^Nothing stands out/);
});

test('audience: a country whose share of readers moved', () => {
  const up = steady({ country: [ar('US', 500, 520), ar('GB', 200, 210), ar('AR', 84, 40)] });
  const s = audienceStory(up, 30);
  assert.equal(strip(s.html), 'Readers from Argentina doubled, from 40 to 84.');
  assert.deepEqual([s.dim, s.key], ['country', 'AR']);
  const down = steady({ country: [ar('US', 500, 500), ar('DE', 110, 200), ar('GB', 200, 200)] });
  assert.equal(strip(audienceStory(down, 30).html), 'Readers from Germany fell 45%, from 200 to 110.');
  const us = steady({ country: [ar('US', 700, 500), ar('GB', 200, 200)] });
  assert.equal(strip(audienceStory(us, 30).html), 'Readers from the United States rose 40%, from 500 to 700.');
});

test('audience: when the whole site doubled, a country that doubled with it is not a finding', () => {
  const all = steady({ country: [ar('US', 1000, 500), ar('GB', 400, 200), ar('AR', 80, 40)] });
  assert.match(audienceStory(all, 30).html, /^Nothing stands out/);
});

test('audience: devices and browsers that moved, named in words', () => {
  const ff = steady({ browser: [ar('chrome', 400, 400), ar('safari', 300, 330), ar('firefox', 200, 100)] });
  assert.equal(strip(audienceStory(ff, 30).html), 'Readers using Firefox doubled, from 100 to 200.');
  const apps = steady({ browser: [ar('chrome', 400, 400), ar('safari', 300, 300), ar('app', 150, 50)] });
  assert.equal(strip(audienceStory(apps, 30).html), 'Readers inside apps tripled, from 50 to 150.');
  const tabs = steady({ device: [ar('phone', 450, 450, .45), ar('computer', 300, 300, .4), ar('tablet', 120, 50)] });
  assert.equal(strip(audienceStory(tabs, 30).html), 'Readers on tablets rose 140%, from 50 to 120.');
});

test('audience: the finding that moved the most readers wins', () => {
  // Phones' bounce gap stands for 500 × 24 pts = 120 visits; Argentina's share moved by about 122 readers.
  const both = steady({ device: [ar('phone', 500, 500, .62), ar('computer', 300, 300, .38)],
    country: [ar('US', 500, 520), ar('GB', 200, 210), ar('AR', 200, 70)] });
  assert.equal(audienceStory(both, 30).key, 'AR');
  const gap = steady({ device: [ar('phone', 500, 500, .72), ar('computer', 300, 300, .38)],
    country: [ar('US', 500, 520), ar('GB', 200, 210), ar('AR', 200, 70)] });
  assert.equal(audienceStory(gap, 30).key, 'phone');
});

test('audience: unknown countries and other browsers are never the finding', () => {
  const odd = steady({ country: [ar('US', 500, 500), ar('', 200, 50), ar('T1', 150, 40), ar('XX', 150, 40)],
    browser: [ar('chrome', 400, 400), ar('other', 300, 50)] });
  assert.match(audienceStory(odd, 30).html, /^Nothing stands out/);
});

test('audience: a period only partly recorded shows no change, and the note says which', () => {
  // The API sends no previous figures for devices and browsers when either period is partly recorded.
  const part = steady({ device: [ar('phone', 450, null, .45), ar('computer', 300, null, .4)], browser: [ar('chrome', 400, null), ar('firefox', 300, null)], partial: 'cur' });
  assert.match(audienceStory(part, 30).html, /^Nothing stands out/);
  assert.equal(audienceNote(part, 30), 'Lede began recording devices and browsers during these 30 days, so they cover only the visits since then and show no change yet.');
  assert.equal(audienceNote({ ...part, partial: 'prev' }, 7), 'Lede began recording devices and browsers during the 7 days before, so they show no change yet.');
  assert.equal(audienceNote(steady(), 30), '');
  // The bounce gap only needs this period, so it still counts.
  const gap = { ...part, device: [ar('phone', 500, null, .62), ar('computer', 300, null, .38)] };
  assert.equal(audienceStory(gap, 30).key, 'phone');
});

test('countries, devices and browsers read as words', () => {
  assert.equal(labelOf('country', 'US'), 'United States');
  assert.equal(labelOf('country', 'AR'), 'Argentina');
  assert.equal(labelOf('country', 'T1'), 'T1', 'a code Intl does not know stays as it is');
  assert.equal(labelOf('country', ''), 'Unknown');
  assert.equal(labelOf('device', 'phone'), 'Phones');
  assert.equal(labelOf('device', 'computer'), 'Computers');
  assert.equal(labelOf('browser', 'samsung'), 'Samsung Internet');
  assert.equal(labelOf('browser', 'app'), 'Inside apps');
  assert.equal(labelOf('browser', 'other'), 'Other browsers');
});

test('demo: the countries, devices and browsers card leads with a finding', async () => {
  const A = await demoStore.audience(parseQuery(new URL('https://worker.test/api/audience?days=30'), ['example.com']));
  const s = audienceStory(A, 30);
  assert.ok(s.key && !/^Nothing/.test(s.html), s.html);
  assert.equal(audienceNote(A, 30), '');
});

/* ---------- the owner's notes ---------- */

// The owner's note on day i of the test series.
const note = (i, text) => ({ day: dayKey(dayDate(START, i)), text });
// Flat at 300, then `to` a day from day 10 (Thu, Oct 8) on: a change that lasts.
const stepped = to => series(300, Object.fromEntries(Array.from({ length: 18 }, (_, k) => [10 + k, to])));
const rose = [ref('news.ycombinator.com', 2260, 100), ref('google.com', 8300, 8300)];

test('a note says what the owner did, as something they did', () => {
  assert.equal(didWhat('Posted on Hacker News'), 'you posted on Hacker News');
  assert.equal(didWhat('I rewrote the home page.'), 'you rewrote the home page');
  assert.equal(didWhat('Sent the newsletter'), 'you sent the newsletter');
  assert.equal(didWhat('New homepage'), null);
  assert.equal(didWhat('Speed test'), null);
});

test('a rise that starts the day after a note is told as coming after it, and nothing more', () => {
  const { S, T } = story({ rows: rose, ser: stepped(420), notes: [note(9, 'Posted on Hacker News')] });
  assert.equal(S.note.kind, 'shift');
  assert.equal(strip(T.html), 'Hacker News sent all of the 2,160 extra visitors. Visitors rose 40% after you posted on Hacker News (Wed, Oct 7).');
});

test('a rise that starts on the noted day is cited too', () => {
  const { T } = story({ rows: rose, ser: stepped(420), notes: [note(10, 'New homepage')] });
  assert.match(strip(T.html), /Visitors rose 40% after your note “New homepage” \(Thu, Oct 8\)\.$/);
});

test('a note is not cited when the change started at another time', () => {
  for (const day of [3, 8, 11, 20]) {
    const { S, T } = story({ rows: rose, ser: stepped(420), notes: [note(day, 'Posted on Hacker News')] });
    assert.equal(S.note, null, `note on day ${day}`);
    assert.doesNotMatch(T.html, /after you/);
  }
});

test('a fall that starts after a note is told the same way', () => {
  const { T } = story({ rows: [ref('google.com', 6780, 8400)], ser: stepped(210), notes: [note(10, 'Moved to a new host')] });
  assert.match(strip(T.html), /Visitors fell 30% after you moved to a new host \(Thu, Oct 8\)\.$/);
});

test('a flat period cites no note', () => {
  const { S } = story({ rows: [ref('google.com', 8400, 8400)], ser: series(300), notes: [note(10, 'Posted on Hacker News')] });
  assert.equal(S.note, null);
});

test('a busy day on a noted day, or the day after, is told as that day', () => {
  const rows = [ref('facebook.com', 1400, 1000), ref('google.com', 7400, 7400)];
  const ser = series(300, { 18: 700 }, { 18: ['facebook.com', 450] });
  const said = day => strip(story({ rows, ser, notes: [note(day, 'Shared /owls in a Facebook group')] }).T.html);
  assert.match(said(18), /Fri, Oct 16 had twice the visitors of a usual Friday, the day you shared \/owls in a Facebook group\.$/);
  assert.match(said(17), /, the day after you shared \/owls in a Facebook group\.$/);
  assert.doesNotMatch(said(19), /Facebook group/);
  assert.doesNotMatch(said(16), /Facebook group/);
});

test('today is not over, so it is never the busy day a note is cited for', () => {
  const { S } = story({ rows: [ref('google.com', 9000, 8400)], ser: series(300, { 27: 900 }), notes: [note(27, 'Posted on Hacker News')] });
  assert.equal(S.note, null);
});

test('a note is the owner\'s own text, so the sentence escapes it', () => {
  const { T } = story({ rows: rose, ser: stepped(420), notes: [note(10, '<i>Launch</i> day')] });
  assert.ok(T.html.includes('“&lt;i&gt;Launch&lt;/i&gt; day”'));
});

test('the demo has a note on its busy day, and home cites it', async () => {
  const q = parseQuery(new URL(`https://w.test/api/x?days=30&tz=${new Date().getTimezoneOffset()}`), ['example.com']);
  const [totals, ser, pages, refs, flows] = await Promise.all([demoStore.summary(q), demoStore.series(q),
    demoStore.breakdown(q, 'path'), demoStore.breakdown(q, 'referrer'), demoStore.flows(q)]);
  const notes = demoNotes(q);
  assert.equal(notes.length, 1);
  const S = readStory({ totals, ser, pages, refs, flows, notes });
  assert.equal(S.note?.kind, 'day');
  assert.equal(ser.top[S.note.day], 'facebook.com');
  assert.match(strip(tellStory(S, ser, 30).html), /the day you shared \/owls in a Facebook birding group\.$/);
});

/* ---------- the picture of the page, shaded where readers have gone ---------- */

test('scroll picture: darker further down, as fewer still read', () => {
  const owls = read(900, .93, .87, .81, .76, .43, .4, .37, .35, .34, .33);
  const P = scrollPicture(owls);
  assert.equal(P.stops.length, 11, 'the top, then the end of each tenth');
  assert.deepEqual(P.stops.map(s => s.at), [0, .1, .2, .3, .4, .5, .6, .7, .8, .9, 1]);
  assert.equal(P.stops[0].shade, 0, 'everyone sees the top');
  for (let i = 1; i < 11; i++) assert.ok(P.stops[i].shade >= P.stops[i - 1].shade, 'never lighter further down');
  close(P.stops[5].shade / P.stops[10].shade, (1 - .43) / (1 - .33), 1e-9);
  assert.ok(P.stops[10].shade < 1, 'the page still shows through where few read');
  const all = scrollPicture(read(900, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1));
  assert.ok(all.stops.every(s => s.shade === 0), 'a page everyone reads to the end has no shade');
});

test('scroll picture: labels the top, the steepest drop and the end', () => {
  const P = scrollPicture(read(900, .93, .87, .81, .76, .43, .4, .37, .35, .34, .33));
  assert.equal(P.top, '93% at 10%');
  assert.equal(P.end, '33% reach the end');
  assert.deepEqual(P.drop, { at: .45, label: '76% → 43%' });
  assert.equal(P.aria, 'A picture of the page, darker where fewer read: 93% still reading at 10% of the way down, 76% → 43% between 40% and 50% of the way down, 33% reach the end.');
  const first = scrollPicture(read(900, .8, .75, .7, .66, .62, .58, .55, .52, .5, .48));
  assert.deepEqual(first.drop, { at: .05, label: '100% → 80%' });
  const even = scrollPicture(read(900, .96, .92, .88, .84, .8, .76, .72, .68, .64, .6));
  assert.equal(even.drop, null, 'no line when no drop stands out');
  assert.equal(even.aria, 'A picture of the page, darker where fewer read: 96% still reading at 10% of the way down, 60% reach the end.');
  assert.equal(P.bands.length, 10);
  assert.equal(P.bands[4], '50% of the way down: 43% still reading');
});

test('scroll picture: none under the reads threshold, only the sentence', () => {
  assert.equal(scrollPicture(read(12, .5, .4, .3, .2, .1, .1, .1, .1, .1, .1)), null);
  assert.equal(scrollPicture(read(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)), null);
  assert.equal(scrollPicture({ views: 400 }), null);
});

test('scroll numbers: with no picture, the shares either side of the drop and at the end', () => {
  const nums = r => scrollNumbers(r).map(x => [x.value, x.label, x.drop]);
  assert.deepEqual(nums(read(900, .93, .87, .81, .76, .43, .4, .37, .35, .34, .33)),
    [['76%', 'read past 40%', false], ['43%', 'read past the middle', true], ['33%', 'reach the end', false]]);
  assert.deepEqual(nums(read(900, .9, .7, .45, .4, .35, .3, .28, .26, .24, .22)).map(x => x[1]), ['read past 20%', 'read past 30%', 'reach the end']);
  // A drop in the first tenth: nobody is "past 0%", so the middle comes in instead.
  assert.deepEqual(nums(read(900, .8, .75, .7, .66, .62, .58, .55, .52, .5, .48)),
    [['80%', 'read past 10%', true], ['62%', 'read past the middle', false], ['48%', 'reach the end', false]]);
  // A drop in the last tenth is the end itself.
  assert.deepEqual(nums(read(900, 1, .98, .96, .94, .92, .9, .88, .86, .84, .6)),
    [['84%', 'read past 90%', false], ['60%', 'reach the end', true]]);
  // No drop stands out: the top, the middle and the end, none in violet.
  assert.deepEqual(nums(read(900, .96, .92, .88, .84, .8, .76, .72, .68, .64, .6)),
    [['96%', 'read past 10%', false], ['80%', 'read past the middle', false], ['60%', 'reach the end', false]]);
  assert.equal(scrollNumbers(read(12, .5, .4, .3, .2, .1, .1, .1, .1, .1, .1)), null, 'too few reads: the sentence alone');
});

test('scroll picture: the caption says what the picture is and when it was taken', () => {
  assert.equal(pictureCaption({ path: '/owls', days: 30, kind: 'shot' }), 'Picture of /owls taken today. Readers counted over the last 30 days.');
  assert.equal(pictureCaption({ path: '/', days: 7, kind: 'shot' }), 'Picture of the home page taken today. Readers counted over the last 7 days.');
  assert.equal(pictureCaption({ path: '/owls', days: 1, kind: 'shot' }), 'Picture of /owls taken today. Readers counted today.');
  assert.equal(pictureCaption({ path: '/owls', days: 30, kind: 'none', why: 'budget' }), 'No picture of the page yet; Lede takes one tomorrow. Readers counted over the last 30 days.');
  assert.equal(pictureCaption({ path: '/owls', days: 30, kind: 'none', why: 'failed' }), 'Cloudflare couldn’t take a picture of this page. Readers counted over the last 30 days.');
  assert.equal(pictureCaption({ path: '/owls', days: 30, kind: 'og', why: 'budget' }),
    'This is the picture /owls shows when shared on social sites, not the page itself. Lede takes a picture of the page tomorrow. Readers counted over the last 30 days.');
  // Waiting won't help when the token can't take pictures, so it says what to do.
  assert.equal(pictureCaption({ path: '/owls', days: 30, kind: 'none', why: 'permission' }),
    'To show a picture of the page here, give Lede’s Cloudflare token the Browser Run permission. Readers counted over the last 30 days.');
  assert.equal(pictureCaption({ path: '/owls', days: 30, kind: 'og', why: 'permission' }),
    'This is the picture /owls shows when shared on social sites, not the page itself. For a picture of the page, give Lede’s Cloudflare token the Browser Run permission. Readers counted over the last 30 days.');
  assert.equal(pictureCaption({ path: '/owls', days: 30, kind: 'wait' }), 'Readers counted over the last 30 days.', 'while the picture is on its way');
  assert.equal(pictureCaption({ path: '/a<b', days: 30, kind: 'shot' }), 'Picture of /a&lt;b taken today. Readers counted over the last 30 days.', 'escaped');
});

/* ---------- claims that must match the numbers ---------- */

test('the page the lead sent its visitors to is named with the lead, not with the source that moved the other way', () => {
  const rows = [ref('news.ycombinator.com', 1400, 1000), ref('google.com', 2800, 3000)];
  const flows = [{ source: 'news.ycombinator.com', page: '/pricing', visitors: 600 }, { source: 'google.com', page: '/', visitors: 2800 }];
  const prevFlows = [{ source: 'news.ycombinator.com', page: '/pricing', visitors: 200 }, { source: 'google.com', page: '/', visitors: 3000 }];
  const pages = [{ key: '/pricing', visitors: 600, prev: { visitors: 200 } }, { key: '/', visitors: 2800, prev: { visitors: 3000 } }];
  const { T } = story({ rows, ser: series(150), flows, prevFlows, pages });
  assert.equal(strip(T.html), 'Hacker News sent 400 more visitors, mostly to /pricing, while google.com sent 200 fewer.');
});

test('a source that sent a tenth of what it did before is not said to have stopped', () => {
  const rows = [ref('google.com', 10200, 10000), ref('bing.com', 15, 200), ref('', 5000, 5000)];
  const { T } = story({ rows, ser: series(540) });
  assert.equal(strip(T.html), 'About as many visitors as the 28 days before (+15). bing.com sent only 15 visitors, down from 200.');
});

test('the fastest rise is told in the past, as a rise, not as a trend', () => {
  const rows = [ref('news.ycombinator.com', 4000, 1000), ref('google.com', 6000, 6000), ref('perplexity.ai', 300, 80)];
  const { T } = story({ rows, ser: series(300) });
  assert.equal(strip(T.html), 'Hacker News sent 3,000 of the 3,220 extra visitors. perplexity.ai went from 80 to 300 visitors, the fastest rise of any source.');
});

test('a new source is told as having sent visitors where there were none before', () => {
  const rows = [ref('news.ycombinator.com', 4000, 1000), ref('google.com', 6000, 6000), ref('claude.ai', 300, null)];
  const { T } = story({ rows, ser: series(300) });
  assert.equal(strip(T.html), 'Hacker News sent 3,000 of the 3,300 extra visitors. claude.ai sent 300 visitors, none in the 28 days before.');
});

test('countries whose English name takes "the" get it', () => {
  for (const [k, name] of [['PH', 'the Philippines'], ['AE', 'the United Arab Emirates'], ['BS', 'the Bahamas'], ['VG', 'the British Virgin Islands']]) {
    const up = steady({ country: [ar('US', 500, 520), ar('GB', 200, 210), ar(k, 84, 40)] });
    assert.equal(strip(audienceStory(up, 30).html), `Readers from ${name} doubled, from 40 to 84.`);
  }
});

test('one person here, from a named source, reads as a sentence of its own', () => {
  const live = { now: 1, recent: 1, visitors: [{ referrer: 'news.ycombinator.com', path: '/a', seconds: 30, active: true, ago: 10 }] };
  assert.equal(strip(onlineStory(live, new Set(['news.ycombinator.com']), '/a')), 'One person is here now. They came from Hacker News and are reading /a. They arrived in the last minute.');
});

/* ---------- a site gone quiet ---------- */

test('no visitors now after a period with some: how many there were, and what to check', () => {
  const rows = [ref('google.com', 0, 900), ref('', 0, 340)];
  const { T } = story({ rows, ser: series(0) });
  assert.equal(strip(T.html), 'No visitors in the last 28 days, down from 1,240 in the 28 days before. Check that Lede’s line is still on every page.');
  assert.equal(T.told.size, 0, 'no source is named for a drop that is everyone');
  assert.equal(T.page, null);
});

test('no visitors in either period is said as before, for the weekly message too', () => {
  const { T } = story({ rows: [], ser: series(0) });
  assert.equal(T.html, 'No visitors in the last 28 days.');
});

test('quiet days in a row are one run; today is left out, since it isn\'t over', () => {
  const cur = Array.from({ length: 28 }, (_, i) => i >= 20 ? 3 : 100);
  assert.deepEqual(quietRuns(cur), [{ start: 20, end: 26, visitors: 21, usual: 100 }]);
  const two = cur.map((v, i) => i === 5 || i === 9 ? 10 : i >= 20 ? 100 : v);
  assert.deepEqual(quietRuns(two).map(q => [q.start, q.end]), [[5, 5], [9, 9]]);
});

test('a period with no visitors at all is quiet against the period before', () => {
  const zero = Array(28).fill(0);
  assert.deepEqual(quietRuns(zero), [], 'nothing to say what usual is');
  const runs = quietRuns(zero, Array(28).fill(80));
  assert.deepEqual(runs, [{ start: 0, end: 26, visitors: 0, usual: 80 }]);
  assert.deepEqual(quietRuns(zero, Array(28).fill(10)), [], 'a small site\'s quiet days are noise');
});

/* ---------- a month start inside one period ---------- */

test('when only one period crosses a month start, the story compares visits, not visitors', () => {
  // Visitor IDs start afresh on the 1st, so this period counts many returning readers twice.
  const rows = [ref('google.com', 1500, 1000, .4, .4, { visits: 1100, prev: { visitors: 1000, visits: 1000, views: 2000, bounce: .4, duration: 60 } }),
    ref('', 600, 400, .4, .4, { visits: 410, prev: { visitors: 400, visits: 400, views: 800, bounce: .4, duration: 60 } })];
  const totals = totalsOf(rows), ser = series(50);
  totals.cur.visits = 1510; totals.cur.visitors = 2100;
  const read = split => readStory({ totals: { ...totals, split }, ser, pages: { rows: [] }, refs: { rows }, flows: { flows: [], prev: [] } });
  const S = read({ cur: true, prev: false });
  assert.equal(S.unit, 'visits');
  assert.equal(S.diff, 110);
  assert.equal(S.sources[0].change, 100);
  assert.match(strip(tellStory(S, ser, 28).html), /^google\.com sent 100 of the 110 extra visits\./);
  assert.equal(read({ cur: true, prev: true }).unit, 'visitors', 'both cross one: alike, so visitors');
  assert.equal(read(undefined).unit, 'visitors', 'an answer without split reads as before');
  assert.equal(read({ cur: true, prev: true }).diff, 700);
});

test('a page or source on its own says its change in visits when the month splits one period', () => {
  const totals = { cur: { visitors: 900, visits: 500 }, prev: { visitors: 400, visits: 400 }, split: { cur: false, prev: true } };
  assert.equal(unitOf(totals), 'visits');
  assert.equal(strip(pageStory(totals, [], '/docs', 7)), '900 visitors on /docs, visits up 25%.');
  const ser = { start: START, days: 7, cur: { visitors: Array(7).fill(100) }, prev: { visitors: Array(7).fill(60) } };
  assert.equal(strip(sourceStory(totals, ser, 'Google', 7).html), '900 visitors from Google, visits up 25%.');
});

test('the notes under the sentence say which period was sampled, and when the month splits one', () => {
  assert.deepEqual(countNotes({ sampled: false }, 30), []);
  assert.deepEqual(countNotes({ sampled: true }, 30), ['These 30 days were busy enough that Cloudflare kept only some of the views, so visitor counts may run a little low.']);
  assert.match(countNotes({ sampled: false, prevSampled: true }, 7)[0], /^The 7 days before were busy enough/);
  assert.match(countNotes({ sampled: true, prevSampled: true }, 7)[0], /^These 7 days and the 7 before were busy enough/);
  assert.deepEqual(countNotes({ split: { cur: true, prev: false } }, 7),
    ['Lede counts each visitor once a month, and these 7 days cross the start of one, so the two are compared on visits instead of visitors.']);
  assert.match(countNotes({ split: { cur: false, prev: true } }, 7)[0], /the 7 days before cross the start of one/);
  assert.deepEqual(countNotes({ split: { cur: true, prev: true } }, 30), []);
});

test('a source\'s busy days are weighed against its days added up, not its visitors', () => {
  // Someone who came on two days is one visitor but counts on both days, so the days add up to more.
  const visitors = Array.from({ length: 28 }, (_, i) => i === 18 ? 2758 : i === 19 ? 389 : 130);
  const ser = { start: START, days: 28, cur: { visitors }, prev: { visitors: visitors.map(() => 128) } };
  const totals = { cur: { visitors: 5000, bounce: .6 }, prev: { visitors: 3000, bounce: .48 } };
  const s = sourceStory(totals, ser, 'Hacker News', 28);
  assert.match(strip(s.html), /Almost half came on Fri, Oct 16–17\./, '3,147 of 6,527 days added up, not of 5,000 visitors');
  assert.equal(s.without, 'Without those two days, Hacker News sent 6% fewer visitors than the 28 days before.');
});

/* ---------- speed ---------- */

test('speed is good, needs work or poor, by Google\'s thresholds', () => {
  assert.equal(vitalRating('lcp', 2500), 'good');
  assert.equal(vitalRating('lcp', 2501), 'needs work');
  assert.equal(vitalRating('lcp', 4001), 'poor');
  assert.equal(vitalRating('inp', 200), 'good');
  assert.equal(vitalRating('inp', 500), 'needs work');
  assert.equal(vitalRating('inp', 501), 'poor');
  assert.equal(vitalRating('cls', .1), 'good');
  assert.equal(vitalRating('cls', .2), 'needs work');
  assert.equal(vitalRating('cls', .26), 'poor');
  assert.equal(vitalRating('cls', null), null);
});

test('a page\'s speed line: what 3 in 4 views got, in plain words, only for what was measured', () => {
  assert.equal(strip(vitalsLine({ views: 400, lcp: 2140, inp: 180, cls: .05, lcpN: 300, inpN: 90, clsN: 300 }).html),
    'Of the views measured, 3 in 4 loaded within 2.1 s (good), answered a tap or click within 180 ms (good) and moved their layout by 0.05 or less (good).');
  assert.equal(strip(vitalsLine({ views: 400, lcp: 4800, inp: null, cls: null }).html), 'Of the views measured, 3 in 4 loaded within 4.8 s (poor).');
  assert.deepEqual(vitalsLine({ views: 400, lcp: 3000, inp: 300, inpN: 60 }).ratings, { lcp: 'needs work', inp: 'needs work' });
  assert.equal(vitalsLine({ views: 12, lcp: 2000 }).html, 'Too few views yet to say how fast this page is.');
  assert.equal(vitalsLine({ views: 400 }), null, 'nothing measured yet, nothing said');
  assert.equal(vitalsLine({ views: 400, lcp: null, inp: null, cls: null }), null);
});

test('each speed measure needs enough views that measured it, not just enough views', () => {
  // 40 views, a tap on only 4 of them: their answer time is left out, not called poor.
  const r = { views: 40, lcp: 2000, inp: 650, lcpN: 36, inpN: 4 };
  assert.deepEqual(vitalsLine(r).ratings, { lcp: 'good' });
  assert.doesNotMatch(vitalsLine(r).html, /tap/);
  assert.equal(vitalsLine({ views: 400, inp: 650 }).html, 'Too few views yet to say how fast this page is.', 'without its own count, INP is never enough');
  assert.equal(vitalsLine({ views: 400, lcp: 2000, lcpN: 12 }).html, 'Too few views yet to say how fast this page is.');
  assert.equal(vitalsFinding([{ key: '/', views: 500, inp: 650, inpN: 4 }], [{ key: '/', value: 600 }], 1000), null);
  assert.equal(vitalsFinding([{ key: '/', views: 500, inp: 650 }], [{ key: '/', value: 600 }], 1000), null);
});

test('layout movement arrives as its score, the way the engagement answer gives it', () => {
  // An engagement row as the API shapes it: stored CLS 300 (×1000) comes out as .3.
  const row = { key: '/', views: 200, time: 40, scroll: .5, median: 30000, lcp: 2100, inp: null, cls: .3, lcpN: 150, clsN: 150, prev: null };
  const V = vitalsLine(row);
  assert.equal(V.ratings.cls, 'poor');
  assert.match(strip(V.html), /moved their layout by 0\.30 or less \(poor\)/);
  assert.equal(vitalsLine({ ...row, cls: .12 }).ratings.cls, 'needs work');
});

test('speed finding: the busiest page slow for many readers, never a small one', () => {
  const rows = [{ key: '/pricing', views: 900, lcp: 4800, inp: 120, inpN: 300 }, { key: '/blog/x', views: 300, lcp: 6000 }, { key: '/tiny', views: 40, inp: 900, inpN: 40 }, { key: '/', views: 2000, lcp: 1800, inp: 150, inpN: 600 }];
  const pageRows = [{ key: '/pricing', value: 1240 }, { key: '/blog/x', value: 400 }, { key: '/tiny', value: 30 }, { key: '/', value: 5000 }];
  const F = vitalsFinding(rows, pageRows, 8000);
  assert.equal(F.key, '/pricing');
  assert.equal(strip(F.html), '/pricing is slow for many of its 1,240 visitors: of the views measured, 1 in 4 took 4.8 s or longer to load.');
  assert.equal(vitalsFinding(rows.slice(2), pageRows, 8000), null, 'a slow page with few visitors is no finding');
  const both = vitalsFinding([{ key: '/app', views: 500, lcp: 4500, inp: 700, inpN: 150 }], [{ key: '/app', value: 600 }], 1000);
  assert.equal(strip(both.html), '/app is slow for many of its 600 visitors: of the views measured, 1 in 4 took 4.5 s or longer to load, and 1 in 4 waited 700 ms or longer for a tap or click to answer.');
  const answer = vitalsFinding([{ key: '/', views: 500, inp: 650, inpN: 120 }], [{ key: '/', value: 600 }], 1000);
  assert.equal(strip(answer.html), 'The home page is slow for many of its 600 visitors: of the views measured, 1 in 4 waited 650 ms or longer for a tap or click to answer.');
});
