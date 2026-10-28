// Sample data for local development (DEMO="true"). It answers the same questions as the SQL
// store, returning the same raw row fields, so the dashboard can't tell the difference.
import { metrics, toSeries, toFlows, toFirsts, mergeRows, shapeLive, toConversions, toEngagement, toLinks } from './shape.js';
import { hourlyStart } from './queries.js';

// A field guide to birds. w: traffic weight, vpv: views per visit, br: bounce rate, dur: seconds, en/ex: entry & exit weighting
const PATHS = [
  { key: '/', w: 30, vpv: 1.9, br: .44, dur: 62, en: 1.45, ex: .95 },
  { key: '/robin', w: 9, vpv: 2.4, br: .27, dur: 96, en: .7, ex: 1.15 },
  { key: '/by-song', w: 7, vpv: 3.1, br: .22, dur: 148, en: .9, ex: .8 },
  { key: '/feeders', w: 5, vpv: 2.2, br: .31, dur: 84, en: .6, ex: .7 },
  { key: '/owls', w: 4, vpv: 2.6, br: .25, dur: 171, en: 1.1, ex: 1.2 },
  { key: '/migration', w: 3, vpv: 1.5, br: .52, dur: 118, en: 1.6, ex: 1.5 },
  { key: '/heron', w: 2.6, vpv: 1.6, br: .38, dur: 54, en: .5, ex: 1.4 },
  { key: '/wren', w: 2.4, vpv: 2, br: .4, dur: 58, en: .8, ex: .9 },
  { key: '/nests', w: 2.1, vpv: 1.7, br: .47, dur: 71, en: .9, ex: 1 },
  { key: '/swift', w: 1.9, vpv: 2.1, br: .35, dur: 102, en: 1.3, ex: .9 },
  { key: '/kingfisher', w: 1.1, vpv: 1.8, br: .39, dur: 47, en: .6, ex: 1 },
  { key: '/about', w: .7, vpv: 1.2, br: .62, dur: 39, en: .7, ex: 1.3 },
];
// vf: visits per visitor, bm/dm: bounce & duration modifiers
const SOURCES = [
  { key: 'google.com', ch: 'search', w: 34, vf: 1.2, bm: 1.1, dm: 1 },
  { key: '', ch: 'direct', w: 27, vf: 1.55, bm: .85, dm: 1.12 },
  { key: 'facebook.com', ch: 'social', w: 5, vf: 1.1, bm: 1.2, dm: .82 },
  { key: 'ebird.org', ch: 'referral', w: 4.2, vf: 1.25, bm: .8, dm: 1.25 },
  { key: 'duckduckgo.com', ch: 'search', w: 4, vf: 1.2, bm: 1, dm: 1 },
  { key: 'reddit.com', ch: 'social', w: 3.8, vf: 1.12, bm: 1.2, dm: .9 },
  { key: 'chatgpt.com', ch: 'ai', w: 3.6, vf: 1.2, bm: .78, dm: 1.35 },
  { key: 'pinterest.com', ch: 'social', w: 2.8, vf: 1.1, bm: 1.25, dm: .85 },
  { key: 'bing.com', ch: 'search', w: 2.4, vf: 1.2, bm: 1.05, dm: .95 },
  { key: 'perplexity.ai', ch: 'ai', w: 1.3, vf: 1.2, bm: .8, dm: 1.3 },
  { key: 'claude.ai', ch: 'ai', w: 1.6, vf: 1.2, bm: .75, dm: 1.4 },
  { key: 'bsky.app', ch: 'social', w: 1.4, vf: 1.1, bm: 1.1, dm: .95 },
];
// Seconds a page view is read, and how far down (%): the long guides hold people, the home page is a crossroads.
const READ = {
  '/': [28, 52], '/robin': [64, 71], '/by-song': [112, 63], '/feeders': [58, 68], '/owls': [121, 77], '/migration': [83, 58],
  '/heron': [41, 66], '/wren': [44, 70], '/nests': [52, 61], '/swift': [76, 72], '/kingfisher': [36, 64], '/about': [22, 81],
};
// Links off the site and files to download: the page they're on, and the share of its visitors who click.
// Files live on the site itself, so their host is filled in per site.
const LINKS = [
  { kind: 'outbound', key: 'xeno-canto.org/explore', from: '/by-song', rate: .11 },
  { kind: 'outbound', key: 'allaboutbirds.org/guide/American_Robin', from: '/robin', rate: .09 },
  { kind: 'outbound', key: 'merlin.allaboutbirds.org', from: '/by-song', rate: .07 },
  { kind: 'outbound', key: 'ebird.org/submit', from: '/migration', rate: .06 },
  { kind: 'outbound', key: 'nestwatch.org', from: '/nests', rate: .08 },
  { kind: 'outbound', key: 'audubon.org/native-plants', from: '/feeders', rate: .05 },
  { kind: 'outbound', key: 'inaturalist.org/observations', from: '/heron', rate: .04 },
  { kind: 'download', key: '/files/owl-calls.mp3', from: '/owls', rate: .1 },
  { kind: 'download', key: '/files/feeder-plans.pdf', from: '/feeders', rate: .07 },
  { kind: 'download', key: '/files/song-chart.pdf', from: '/by-song', rate: .05 },
  { kind: 'download', key: '/files/backyard-checklist.pdf', from: '/', rate: .02 },
];
const N = 90;
// An ordinary month with one of each thing the dashboard notices: as autumn goes on, search sends
// more people to /migration and AI assistants grow slowly; a new page, /swift, goes up; bsky.app starts
// sending visitors; a Facebook group shares /owls for one busy day; one quiet day looks like an outage;
// and the last week is a little busier than the one before.
const FIRST_DAY = { '/swift': N - 19, 'bsky.app': N - 16 };
const BUSY = N - 12, QUIET = N - 25;
// How much more search traffic /migration gets on day d: none until 30 days ago, then up to 3.5×.
const season = d => 1 + Math.max(0, d - (N - 30)) / 30 * 2.5;

function rng(seed) {
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function affinity(s, p) {
  if (s === 'ebird.org' && (p === '/by-song' || p === '/migration')) return 4;
  if (s === 'pinterest.com' && (p === '/feeders' || p === '/nests')) return 3;
  if (s === 'reddit.com' && p === '/owls') return 2.5;
  if ((s === 'chatgpt.com' || s === 'perplexity.ai' || s === 'claude.ai') && p === '/by-song') return 2.2;
  if (s === '' && (p === '/robin' || p === '/by-song')) return 1.8;
  if (s === 'google.com' && p === '/') return 1.3;
  return 1;
}

let matrix;
// matrix[day][source][path] = visitors, for the N days ending today.
function data() {
  if (matrix) return matrix;
  const r = rng(11);
  const today = new Date();
  matrix = Array.from({ length: N }, (_, d) => {
    const dow = new Date(today.getTime() - (N - 1 - d) * 864e5).getDay();
    let total = 2150 * (dow === 6 ? .62 : dow === 0 ? .58 : 1) * (1 + d * .0025) * (.9 + r() * .2);
    if (d === BUSY) total *= 1.95;
    if (d === QUIET) total *= .3;
    if (d >= N - 7) total *= 1.12;
    const live = key => !(d < (FIRST_DAY[key] ?? -1));
    const sw = SOURCES.map(s => {
      let w = s.w * (.85 + r() * .3) * live(s.key);
      if (s.ch === 'ai') w *= .4 + d / N * 1.2;
      if (s.ch === 'search') w *= 1 + Math.max(0, d - (N - 30)) / 30 * .25;
      if (s.key === 'facebook.com' && d === BUSY) w *= 24;
      return w;
    });
    const swSum = sw.reduce((a, b) => a + b);
    return SOURCES.map((s, si) => {
      const a = PATHS.map(p => p.w * affinity(s.key, p.key) * live(p.key) * (s.ch === 'search' && p.key === '/migration' ? season(d) : 1)
        * (s.key === 'facebook.com' && d === BUSY && p.key === '/owls' ? 12 : 1));
      const aSum = a.reduce((x, y) => x + y);
      return PATHS.map((p, pi) => total * sw[si] / swSum * a[pi] / aSum * (.85 + r() * .3));
    });
  });
  return matrix;
}

// Returns the same raw fields as the SQL queries.
function agg(f, d0, d1, pathFactor = () => 1) {
  const m = data();
  const out = { visitors: 0, visits: 0, views: 0, bounces: 0, total_time: 0 };
  for (let d = Math.max(0, d0); d < d1; d++) {
    SOURCES.forEach((S, si) => {
      if (f.referrer != null && S.key !== f.referrer) return;
      if (f.channel != null && S.ch !== f.channel) return;
      PATHS.forEach((P, pi) => {
        if (f.path != null && P.key !== f.path) return;
        const v = m[d][si][pi] * pathFactor(P);
        const visits = v * S.vf;
        out.visitors += v;
        out.visits += visits;
        out.views += visits * P.vpv;
        out.bounces += visits * Math.min(.95, P.br * S.bm);
        out.total_time += visits * P.dur * S.dm;
      });
    });
  }
  return out;
}

const windows = q => ({ cur: [N - q.days, N], prev: [N - 2 * q.days, N - q.days] });

function keysFor(dim) {
  if (dim === 'path' || dim === 'entry' || dim === 'exit') return PATHS.map(p => ['path', p.key]);
  if (dim === 'referrer') return SOURCES.map(s => ['referrer', s.key]);
  if (dim === 'channel') return [...new Set(SOURCES.map(s => s.ch))].map(c => ['channel', c]);
  return [];
}

const LIVE = [
  { path: '/migration', referrer: 'google.com', country: 'US', ago: 20, span: 241 },
  { path: '/robin', referrer: 'google.com', country: 'GB', ago: 45, span: 132 },
  { path: '/by-song', referrer: 'ebird.org', country: 'CA', ago: 70, span: 305 },
  { path: '/owls', referrer: 'reddit.com', country: 'DE', ago: 95, span: 77 },
  { path: '/', referrer: 'duckduckgo.com', country: 'NL', ago: 130, span: 44 },
  { path: '/feeders', referrer: '', country: 'AR', ago: 160, span: 19 },
  { path: '/', referrer: '', country: 'US', ago: 240, span: 8 },
  ...Array.from({ length: 11 }, (_, i) => ({ path: PATHS[i % 5].key, referrer: SOURCES[i % 4].key, country: ['US', 'BR', 'IN', 'JP', 'CA'][i % 5], ago: 400 + i * 120, span: 30 + i * 17 })),
];

// Visitors by source and landing page for days [d0, d1). With a path filter every visit
// "lands" on that path, as in SQL, where the filter applies before the first page is taken.
function demoFlows(f, [d0, d1]) {
  const rows = [];
  SOURCES.forEach((S, si) => {
    if (f.referrer != null && S.key !== f.referrer) return;
    if (f.channel != null && S.ch !== f.channel) return;
    // Of a page's visitors from this source, the share that landed there, by the page's entry weighting;
    // the most-entered page gets 90%, so a page never has more visitors landing on it than viewing it.
    const by = PATHS.map((P, pi) => {
      let v = 0;
      for (let d = Math.max(0, d0); d < d1; d++) v += data()[d][si][pi];
      return v;
    });
    const maxEn = Math.max(...PATHS.map(P => P.en));
    if (f.path != null) {
      const pi = PATHS.findIndex(P => P.key === f.path);
      if (pi >= 0) rows.push({ src: S.key, landing: f.path, visitors: Math.round(by[pi]) });
      return;
    }
    PATHS.forEach((P, pi) => rows.push({ src: S.key, landing: P.key, visitors: Math.round(by[pi] * .9 * P.en / maxEn) }));
  });
  return toFlows(rows.filter(r => r.visitors > 0).sort((a, b) => b.visitors - a.visitors));
}

export const demoStore = {
  async summary(q) {
    const w = windows(q);
    return { cur: metrics(agg(q.filters, ...w.cur)), prev: metrics(agg(q.filters, ...w.prev)) };
  },
  async series(q) {
    const w = windows(q);
    const days = from => Array.from({ length: q.days }, (_, i) => ({ d: i, ...agg(q.filters, from + i, from + i + 1) }));
    const top = [], topVisitors = [];
    for (let i = 0; i < q.days; i++) {
      let best = null, most = 0;
      for (const s of SOURCES) {
        const v = agg({ ...q.filters, referrer: s.key }, w.cur[0] + i, w.cur[0] + i + 1).visitors;
        if (v > most) { most = v; best = s.key; }
      }
      top.push(best);
      topVisitors.push(Math.round(most));
    }
    return { start: q.start, days: q.days, cur: toSeries(days(w.cur[0]), q.days), prev: toSeries(days(w.prev[0]), q.days), top, topVisitors };
  },
  async breakdown(q, dim) {
    const w = windows(q);
    const factor = dim === 'entry' ? p => p.en : dim === 'exit' ? p => p.ex : undefined;
    const rows = range => keysFor(dim)
      .map(([name, key]) => {
        const r = { key, ...agg({ ...q.filters, [name]: key }, ...range, factor) };
        if (dim === 'path') { delete r.bounces; delete r.total_time; }
        return r;
      })
      .filter(r => r.visitors >= 1)
      .sort((a, b) => b.visitors - a.visitors);
    return { dim, rows: mergeRows(rows(w.cur), rows(w.prev)) };
  },
  async flows(q) {
    const w = windows(q);
    return { flows: demoFlows(q.filters, w.cur), prev: demoFlows(q.filters, w.prev) };
  },
  async firsts(q) {
    const w = windows(q), f = q.filters, m = data();
    const firstOf = (list, test) => toFirsts(list.map((item, i) => {
      let day = -1, visitors = 0;
      for (let d = w.cur[0]; d < w.cur[1]; d++) {
        let v = 0;
        SOURCES.forEach((S, si) => PATHS.forEach((P, pi) => {
          if (test(i, si, pi) && (f.path == null || P.key === f.path) && (f.referrer == null || S.key === f.referrer)) v += m[d][si][pi];
        }));
        if (v >= 1 && day < 0) day = d - w.cur[0];
        visitors += v;
      }
      return { key: item.key, d: day, visitors: Math.round(visitors) };
    }).filter(r => r.d >= 0).sort((a, b) => b.visitors - a.visitors));
    return { start: q.start, pages: firstOf(PATHS, (i, si, pi) => pi === i), sources: firstOf(SOURCES, (i, si) => si === i) };
  },
  async hourly(q) {
    const w = windows(q);
    // Birders are up early: a morning peak and a smaller evening one.
    const shape = Array.from({ length: 24 }, (_, h) => .08 + Math.exp(-(((h - 8) / 2.6) ** 2)) + .6 * Math.exp(-(((h - 19) / 2.4) ** 2)));
    const sum = shape.reduce((a, b) => a + b), daily = shape.map(v => v / sum);
    const visitors = [];
    for (let d = w.cur[0]; d < w.cur[1]; d++) {
      const all = agg(q.filters, d, d + 1).visitors;
      for (let h = 0; h < 24; h++) visitors.push(Math.round(all * daily[h]));
    }
    return { start: hourlyStart(q), days: q.days, visitors };
  },
  async conversions(q, goals) {
    const w = windows(q), m = data(), rows = [];
    // How readily each source's visitors reach a goal: people scrolling a feed look and leave,
    // birders coming from eBird and those typing the address come to act.
    const intent = { 'facebook.com': .3, 'pinterest.com': .45, 'reddit.com': .6, 'ebird.org': 1.7, '': 1.25 };
    SOURCES.forEach((S, si) => {
      let visits = 0, reached = 0;
      for (let d = w.cur[0]; d < w.cur[1]; d++) PATHS.forEach((P, pi) => {
        visits += m[d][si][pi] * S.vf;
        if (goals.includes(P.key)) reached += m[d][si][pi] * (intent[S.key] ?? 1);
      });
      if (visits >= 1) rows.push({ src: S.key, visits, reached });
    });
    return toConversions(rows.sort((a, b) => b.visits - a.visits));
  },
  async engagement(q) {
    const w = windows(q), f = q.filters, m = data();
    // Four in five page views send one; the rest are glances or tabs the browser closed first.
    // Sources whose visitors stay longer read longer and further.
    const rows = ([d0, d1]) => PATHS.map((P, pi) => {
      const r = { key: P.key, n: 0, ms: 0, depth: 0 };
      if (f.path != null && P.key !== f.path) return r;
      const [secs, pct] = READ[P.key];
      SOURCES.forEach((S, si) => {
        if ((f.referrer != null && S.key !== f.referrer) || (f.channel != null && S.ch !== f.channel)) return;
        let n = 0;
        for (let d = Math.max(0, d0); d < d1; d++) n += m[d][si][pi] * S.vf * P.vpv * .8;
        r.n += n;
        r.ms += n * secs * 1000 * S.dm;
        r.depth += n * Math.min(100, pct * (.85 + .15 * S.dm));
      });
      return r;
    }).filter(r => r.n >= 1).sort((a, b) => b.n - a.n);
    return toEngagement(rows(w.cur), rows(w.prev));
  },
  async links(q) {
    const w = windows(q), f = q.filters, m = data();
    const rows = ([d0, d1]) => LINKS.map(L => {
      const pi = PATHS.findIndex(P => P.key === L.from);
      let visitors = 0;
      if (f.path == null || f.path === L.from) SOURCES.forEach((S, si) => {
        if ((f.referrer != null && S.key !== f.referrer) || (f.channel != null && S.ch !== f.channel)) return;
        for (let d = Math.max(0, d0); d < d1; d++) visitors += m[d][si][pi] * L.rate;
      });
      return { kind: L.kind, key: L.kind === 'download' ? q.site + L.key : L.key, visitors: Math.round(visitors), clicks: Math.round(visitors * 1.2) };
    }).filter(r => r.visitors > 0).sort((a, b) => b.visitors - a.visitors);
    return toLinks(rows(w.cur), rows(w.prev));
  },
  async live() {
    const now = Math.floor(Date.now() / 1000);
    return shapeLive(LIVE.map(v => ({ ...v, first: now - v.ago - v.span, last: now - v.ago })), now);
  },
};
