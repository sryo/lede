// The facts behind the home screen and the sentences that tell them. No DOM here, so node tests can run it.
import { displayHost } from './hosts.js';

/* ---------- formatting ---------- */
export const CHANNELS = { paid: 'Paid', email: 'Email', ai: 'AI assistants', search: 'Search', video: 'Video', social: 'Social', referral: 'Referral', direct: 'Direct' };
// Hosts whose name doesn't read as the site people know.
const NAMES = { 'news.ycombinator.com': 'Hacker News' };
const USES = { samsung: 'Samsung Internet', app: 'Inside apps', other: 'Other browsers' };
let regions;
// Countries by name; a code Intl doesn't know (T1, for Tor) stays as it is.
const country = k => { try { return (regions ??= new Intl.DisplayNames('en', { type: 'region' })).of(k); } catch { return k; } };
export const labelOf = (dim, key) => dim === 'channel' ? (CHANNELS[key] || key || 'Unknown') : dim === 'referrer' ? (NAMES[key] || displayHost(key) || 'Direct')
  : !key ? 'Unknown' : dim === 'country' ? country(key) : USES[key] || key[0].toUpperCase() + key.slice(1) + (dim === 'device' ? 's' : '');
export const fmtN = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(2) + 'k' : String(Math.round(n));
export const fmtInt = n => Math.round(n).toLocaleString('en-US');
export const count = n => n < 1e5 ? fmtInt(n) : fmtN(n);
export const fmtSigned = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + fmtInt(Math.abs(n));

// Hover hints on the charts.
const many = (n, u = 'visitors') => `${fmtInt(n)} ${Math.round(n) === 1 ? u.slice(0, -1) : u}`;
const visitors = n => many(n);
export const dayHint = (day, n, before, days) => `${day}: ${visitors(n)}${before == null ? '' : ` · ${days} days earlier: ${fmtInt(before)}`}`;
export const ribbonHint = (from, to, n) => `${from} → ${to}: ${visitors(n)}`;
export const sourceHint = (label, n, prev, u = 'visitors') => `${label}: ${many(n, u)}, `
  + (!prev ? 'none before' : n > prev ? `${fmtInt(n - prev)} more than before` : n < prev ? `${fmtInt(prev - n)} fewer than before` : 'the same as before');
export const pageHint = (label, n) => `${label}: ${visitors(n)} landed here`;
// A list row read out: what its columns show, in words.
export const rowLabel = (label, n, prev, total) => `${label}: ${visitors(n)}${total ? `, ${Math.round(n / total * 100)}% of the total` : ''}`
  + (prev ? `, ${changeWords(n, prev)}` : n ? ', new' : '');
const changeWords = (n, prev) => { const x = Math.round((n - prev) / prev * 100); return x > 0 ? `up ${x}%` : x < 0 ? `down ${-x}%` : 'the same as before'; };
export const fmtPct = x => Math.round(x * 100) + '%';
export const fmtDur = t => { const s = Math.round(t); return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
export const fmtDay = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
export const fmtWeekday = (d, style = 'short') => d.toLocaleDateString('en-US', { weekday: style });
export const fmtDate = (d, style = 'short') => `${fmtWeekday(d, style)}, ${fmtDay(d)}`;
// Noon avoids landing on the previous date when a day is 23 hours long (DST).
export const dayDate = (start, i) => new Date((start + i * 86400 + 43200) * 1000);
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const maxOf = a => a.reduce((m, v) => Math.max(m, v || 0), 0);
export const sum = a => a.reduce((s, v) => s + (v || 0), 0);
export const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
export const byMove = (a, b) => Math.abs(b.change) - Math.abs(a.change);
// In sentences the home page is named in words; a bare "/" reads like a typo.
export const pageName = k => k === '/' ? 'the home page' : k;
// A path that wraps after an inner slash, never at a hyphen (which would read like a minus at the start of a line).
export const pathHTML = k => esc(k).replace(/-/g, '\u2011').replace(/(?<=.)\//g, '/<wbr>');
const pctChange = (c, p) => p ? Math.round((c - p) / p * 100) : null;
// Lede counts a visitor once a month: the ID starts afresh at each UTC month start, so a period that crosses one
// counts some people twice. When only one of the two periods crosses one, they are compared on visits instead.
export const unitOf = totals => totals.split && !totals.split.cur !== !totals.split.prev ? 'visits' : 'visitors';
export const readers = label => label === 'Direct' ? 'direct visitors' : `${label} readers`;

/* ---------- the story ---------- */

// A day is a spike when it stands well clear of a normal day (the same weekday, once there are
// two weeks to compare) and of the next-busiest day, so busy weekends don't count.
export function findSpike(vals, start) {
  const n = vals.length; if (n < 7) return -1;
  const i = vals.indexOf(maxOf(vals)), peak = vals[i], others = vals.filter((_, j) => j !== i);
  const wd = j => dayDate(start, j).getDay();
  const base = n >= 14 ? median(others.filter((_, j) => wd(j < i ? j : j + 1) === wd(i))) : median(others);
  return base > 0 && peak > base * 1.6 && peak >= maxOf(others) * 1.3 && peak - base >= 30 ? i : -1;
}

// Works out the facts behind the summary sentence: which sources moved the total, whether a spike
// or a landing page explains it, and who is growing fastest. Only what the sentence ends up naming
// gets the story colour.
// unit: what the totals and sources are compared on (see unitOf); diff, value, prev and change are in it.
export function readStory({ totals, ser, pages, refs, flows, notes }) {
  const u = unitOf(totals), c = totals.cur, p = totals.prev, diff = c[u] - p[u];
  const sources = refs.rows.map(r => ({ key: r.key, label: labelOf('referrer', r.key), channel: r.channel, value: r[u], prev: r.prev?.[u] || 0,
    change: r[u] - (r.prev?.[u] || 0), bounce: r.bounce, prevBounce: r.prev?.bounce, visits: r.visits, prevVisits: r.prev?.visits || 0 }));
  // Changes within normal noise are not explained.
  const flat = !p[u] || Math.abs(diff) < Math.max(p[u] * .03, 2 * Math.sqrt(p[u]));
  const S = { c, p, diff, flat, sources, unit: u, lead: null, second: null, counter: null, page: null, spike: -1, prevSpike: -1, fast: null, fresh: null };
  if (!flat) {
    const sign = Math.sign(diff), same = sources.filter(s => Math.sign(s.change) === sign).sort(byMove);
    S.lead = same[0] || null;
    if (S.lead && same[1] && Math.abs(same[1].change) >= Math.abs(S.lead.change) * .85) S.second = same[1];
    // When the lead moved more than the total did, the biggest move the other way is named too.
    if (S.lead && !S.second && Math.abs(S.lead.change) > Math.abs(diff)) S.counter = sources.filter(s => Math.sign(s.change) === -sign).sort(byMove)[0] || null;
  }
  const { lead } = S;
  if (lead && diff > 0 && !S.second) {
    // The spike is the lead's only if the lead sent most of that day's extra visitors.
    const spike = findSpike(ser.cur.visitors, ser.start);
    if (spike >= 0 && ser.top[spike] === lead.key) {
      const extra = ser.cur.visitors[spike] - median(ser.cur.visitors), usual = lead.value / ser.days;
      if (ser.topVisitors[spike] - usual >= extra * .5) S.spike = spike;
    }
    // "Mostly to <page>": at least half of the lead's gain landed on one page.
    const gain = new Map();
    for (const f of flows.flows) if (f.source === lead.key) gain.set(f.page, (gain.get(f.page) || 0) + f.visitors);
    for (const f of flows.prev || []) if (f.source === lead.key) gain.set(f.page, (gain.get(f.page) || 0) - f.visitors);
    const gains = [...gain].filter(([, g]) => g > 0).sort((a, b) => b[1] - a[1]);
    if (gains.length && gains[0][1] >= sum(gains.map(g => g[1])) * .5) {
      const row = pages.rows.find(r => r.key === gains[0][0]);
      S.page = { key: gains[0][0], isNew: !!row && !row.prev?.visitors };
    }
  }
  if (diff < 0 && !flat) S.prevSpike = findSpike(ser.prev.visitors, ser.start - ser.days * 86400);
  const named = new Set([lead, S.second, S.counter].filter(Boolean));
  const share = s => s.value >= c[u] * .01;
  S.fast = sources.filter(s => !named.has(s) && share(s) && s.prev >= 20 && s.change >= Math.max(10, 2 * Math.sqrt(s.prev)) && s.value >= s.prev * 1.05)
    .sort((a, b) => b.value / b.prev - a.value / a.prev)[0] || null;
  if (!S.fast) S.fresh = sources.filter(s => !named.has(s) && !s.prev && s.value >= 20 && share(s)).sort((a, b) => b.value - a.value)[0] || null;
  S.note = noteChange(S, ser, notes);
  return S;
}

// The sentence, and the set of sources it names. It says who moved the total (and where they landed) and who is
// growing fastest; the spike and the bounce have tiles of their own, so it leaves them out.
// span names the two stretches compared: the dashboard's "in the last 7 days" and "the 7 days before", or a message's weeks.
export function tellStory(S, ser, days, span = { now: `in the last ${days} days`, before: `the ${days} days before` }) {
  const told = new Set();
  const src = s => { told.add(s.key); return `<button type="button" class="link told" data-f="referrer" data-k="${esc(s.key)}">${esc(s.label)}</button>`; };
  const page = k => `<button type="button" class="link told" data-f="path" data-k="${esc(k)}">${k === '/' ? 'the home page' : pathHTML(k)}</button>`;
  const { c, p, diff, lead, second, counter } = S, u = S.unit || 'visitors', parts = [];
  if (!c.visitors && !p.visitors) return { html: `No visitors ${span.now}.`, told, page: null };
  // Nobody at all after a period with visitors is more likely the tracker gone missing than readers.
  if (!c.visitors) return { html: `No visitors ${span.now}, down from ${fmtInt(p.visitors)} in ${span.before}. Check that Lede’s line is still on every page.`, told, page: null };
  if (!p.visitors) return { html: `There were no visitors in ${span.before}, so there’s nothing to compare with yet.`, told, page: null };
  const n = v => fmtInt(Math.abs(v));
  if (S.flat || !lead) parts.push(`About as many ${u} as ${span.before} (${fmtSigned(diff)}).`);
  else if (diff > 0) {
    // Where the lead's visitors landed goes right after the lead, so it is never read as the other source's.
    const to = S.page ? `, mostly to ${S.page.isNew ? 'the new page ' : ''}${page(S.page.key)}` : '';
    if (second) parts.push(`${src(lead)} (${fmtSigned(lead.change)}) and ${src(second)} (${fmtSigned(second.change)}) sent the most extra ${u}.`);
    else if (lead.change > diff) parts.push(`${src(lead)} sent ${n(lead.change)} more ${u}${to}` + (counter ? `, while ${src(counter)} sent ${n(counter.change)} fewer.` : '.'));
    else if (lead.change >= diff * .95) parts.push(`${src(lead)} sent ${lead.change === diff ? 'all' : 'nearly all'} of the ${n(diff)} extra ${u}${to}.`);
    else if (lead.change >= diff * .25) parts.push(`${src(lead)} sent ${n(lead.change)} of the ${n(diff)} extra ${u}${to}.`);
    else parts.push(`The rise was spread across sources; ${src(lead)} sent ${n(lead.change)} more ${u}${to}, the most of any.`);
  } else {
    if (second) parts.push(`The biggest falls were in ${u} from ${src(lead)} (${fmtSigned(lead.change)}) and ${src(second)} (${fmtSigned(second.change)}).`);
    else if (-lead.change > -diff) parts.push(`${src(lead)} sent ${n(lead.change)} fewer ${u}` + (counter ? `, while ${src(counter)} sent ${n(counter.change)} more.` : '.'));
    else if (lead.change <= diff * .95) parts.push(`${src(lead)} sent ${n(lead.change)} fewer ${u}, ${lead.change === diff ? 'all' : 'nearly all'} of the drop.`);
    else if (-lead.change >= -diff * .25) parts.push(`${src(lead)} sent ${n(lead.change)} fewer ${u}, out of ${n(diff)} fewer in all.`);
    else parts.push(`The drop was spread across sources; ${src(lead)} sent ${n(lead.change)} fewer ${u}, the most of any.`);
    if (S.prevSpike >= 0) parts.push(`${span.before[0].toUpperCase()}${span.before.slice(1)} had a big day on ${fmtDate(dayDate(ser.start - ser.days * 86400, S.prevSpike))}.`);
  }
  // The second claim is what the owner did, when the change came right after it; otherwise whichever
  // finding moved the most visitors among those not named yet.
  const f = S.note ? null : findings(S, told, span.before)[0];
  if (S.note) parts.push(noteSentence(S.note, ser));
  else if (f) { parts.push(f.html); told.add(f.kind === 'channel' ? `ch:${f.key}` : f.key); }
  return { html: parts.join(' '), told, page: S.page?.key ?? null };
}

/* ---------- the owner's notes ---------- */

// A day as notes name it, YYYY-MM-DD, in the viewer's time zone.
export const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const mean = a => sum(a) / (a.length || 1);
const DONE = new Set(['sent', 'wrote', 'rewrote', 'made', 'built', 'rebuilt', 'ran', 'gave', 'began', 'put', 'got', 'took', 'sold', 'told', 'spoke',
  'set', 'cut', 'won', 'held', 'led', 'met', 'did', 'redid', 'went', 'left', 'lost', 'found', 'brought', 'taught', 'shut', 'hit', 'let', 'read', 'spent']);

// "Posted on Hacker News" → "you posted on Hacker News". A note that doesn't start with something done
// ("New homepage") gives null and is quoted instead.
export function didWhat(text) {
  const t = String(text).trim().replace(/[.!]+$/, '').replace(/^(I|we)\s+/i, ''), w = t.split(/\s/)[0].toLowerCase();
  return (/^[a-z]{2,}ed$/.test(w) && !/eed$/.test(w)) || DONE.has(w) ? `you ${t[0].toLowerCase()}${t.slice(1)}` : null;
}

// Where a lasting change began, over both periods with the unfinished last day of each left out:
// the split where the running total of (day − average) bottoms out (for a rise) or peaks (for a fall),
// after each weekday is evened out against its own average, so weekends don't pull the split.
function levelShift(ser, sign) {
  const n = ser.cur.visitors.length, pts = [];
  const add = (vals, start, off) => vals.forEach((v, i) => { if (i < n - 1) pts.push({ i: i + off, v, wd: dayDate(start, i).getDay() }); });
  add(ser.prev.visitors, ser.start - n * 86400, -n);
  add(ser.cur.visitors, ser.start, 0);
  const all = mean(pts.map(p => p.v));
  if (!all) return null;
  const w = pts.length >= 28 ? [0, 1, 2, 3, 4, 5, 6].map(d => mean(pts.filter(p => p.wd === d).map(p => p.v)) / all || 1) : Array(7).fill(1);
  const x = pts.map(p => p.v / w[p.wd]), m = mean(x);
  let acc = 0, low = 0, k = -1;
  x.forEach((v, j) => {
    if (j >= 7 && x.length - j >= 3 && sign * acc < low) { low = sign * acc; k = j; }
    acc += v - m;
  });
  if (k < 0) return null;
  const before = mean(pts.slice(0, k).map(p => p.v)), after = pts.slice(k).map(p => p.v);
  return { i: pts[k].i, before, after: mean(after), usual: median(after), cur: after.filter((_, j) => pts[k + j].i >= 0).length };
}

// The owner's note that the change (or a busy day) came on or right after, or null. Only the timing is
// claimed: a note is something that happened before, never the cause.
//   shift: visitors moved to a new level that lasted, from the noted day or the next one, in the direction
//          the period moved and making at least half of that move;
//   day:   the noted day or the next one had at least 1.5 times the visitors of a usual day like it.
export function noteChange(S, ser, notes) {
  if (!notes?.length || !S.p.visitors) return null;
  const cur = ser.cur.visitors, n = cur.length, byDay = new Map(notes.map(x => [x.day, x]));
  const noteOn = i => i >= 0 && i < n ? byDay.get(dayKey(dayDate(ser.start, i))) : undefined;
  const sign = Math.sign(S.diff);
  if (!S.flat) {
    const L = levelShift(ser, sign);
    const rise = L && L.after - L.before;
    if (L && L.before && Math.sign(rise) === sign && Math.abs(rise) >= L.before * .1 && sign * (L.usual - L.before) >= Math.abs(rise) * .5
      && Math.abs(rise) * L.cur >= Math.abs(S.diff) * .5) {
      for (const lag of [0, 1]) {
        const note = noteOn(L.i - lag);
        if (note) return { kind: 'shift', day: L.i - lag, lag, pct: Math.round(rise / L.before * 100), note };
      }
    }
  }
  // A usual day: the same weekday in both periods (unfinished days left out), or any day when there are too few.
  const days = [...ser.prev.visitors.slice(0, n - 1).map((v, i) => ({ v, d: dayDate(ser.start - n * 86400, i) })),
    ...cur.slice(0, n - 1).map((v, i) => ({ v, d: dayDate(ser.start, i), i }))];
  for (let i = 0; i < n - 1; i++) {
    for (const lag of [0, 1]) {
      const note = noteOn(i - lag);
      if (!note) continue;
      const wd = dayDate(ser.start, i).getDay(), others = days.filter(x => x.i !== i), same = others.filter(x => x.d.getDay() === wd);
      const like = same.length >= 2, usual = median((like ? same : others).map(x => x.v));
      if (usual > 0 && cur[i] >= usual * 1.5 && cur[i] - usual >= 30) return { kind: 'day', day: i, lag, ratio: cur[i] / usual, weekday: like ? fmtWeekday(dayDate(ser.start, i), 'long') : null, note };
    }
  }
  return null;
}

// "Visitors rose 40% after you posted on Hacker News (Wed, Oct 7)." or
// "Fri, Oct 16 had twice the visitors of a usual Friday, the day you shared /owls in a Facebook group."
export function noteSentence(N, ser) {
  const did = didWhat(N.note.text), quoted = `your note “${esc(N.note.text.trim())}”`;
  if (N.kind === 'shift') {
    const noted = fmtDate(dayDate(ser.start, N.day));
    return `Visitors ${N.pct > 0 ? 'rose' : 'fell'} ${Math.abs(N.pct)}% after ${did ? esc(did) : quoted} (${noted}).`;
  }
  const x = Math.round(N.ratio), like = N.weekday ? `a usual ${N.weekday}` : 'a usual day';
  const how = N.ratio >= 1.95 ? `${x === 2 ? 'twice' : `${x} times`} the visitors of ${like}` : `${Math.round((N.ratio - 1) * 100)}% more visitors than ${like}`;
  const when = did ? `the day ${N.lag ? 'after ' : ''}${esc(did)}` : `the day ${N.lag ? 'after' : 'of'} ${quoted}`;
  return `${fmtDate(dayDate(ser.start, N.day))} had ${how}, ${when}.`;
}

/* ---------- findings ---------- */

const srcLink = s => `<button type="button" class="link told" data-f="referrer" data-k="${esc(s.key)}">${esc(s.label)}</button>`;
const signedPct = (v, p) => { const x = Math.round((v - p) / p * 100); return (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x) + '%'; };
// A change worth a sentence: big enough against noise and against what the source sent before.
const moved = (change, prev) => prev >= 30 && Math.abs(change) >= Math.max(30, 2 * Math.sqrt(prev)) && Math.abs(change) >= prev * .1;

// Everything worth saying that `told` doesn't already cover, biggest first. `impact` is how many visitors it moved.
// Kinds: fast (the fastest rise), fresh (new source), vanished (a tenth or less of before), drop or rise (against the
// total's direction, or either way when the total is flat), channel (a channel's share of visitors, spread over several sources).
// before names the earlier stretch: "the 7 days before".
export function findings(S, told, before = 'the days before') {
  const { c, p, diff } = S, u = S.unit || 'visitors', out = [];
  if (!p.visitors) return out;
  const free = s => !told.has(s.key);
  if (S.fast && free(S.fast)) {
    const f = S.fast, x = f.value / f.prev;
    out.push({ kind: 'fast', key: f.key, impact: f.change, html: (x >= 3
      ? `${srcLink(f)} went from ${fmtInt(f.prev)} to ${fmtInt(f.value)} ${u}`
      : `${srcLink(f)} sent ${fmtInt((x - 1) * 100)}% more ${u} than before`) + ', the fastest rise of any source.' });
  }
  if (S.fresh && free(S.fresh)) out.push({ kind: 'fresh', key: S.fresh.key, impact: S.fresh.value, html: `${srcLink(S.fresh)} sent ${fmtInt(S.fresh.value)} ${u}, none in ${before}.` });
  for (const s of S.sources) {
    if (!free(s) || s === S.fast) continue;
    if (s.prev >= 30 && s.value <= s.prev * .1) out.push({ kind: 'vanished', key: s.key, impact: s.prev - s.value,
      html: `${srcLink(s)} sent ${s.value ? `only ${many(s.value, u)}` : `no ${u}`}, down from ${fmtInt(s.prev)}.` });
    else if (moved(s.change, s.prev) && (S.flat || Math.sign(s.change) !== Math.sign(diff))) out.push({ kind: s.change < 0 ? 'drop' : 'rise', key: s.key, impact: Math.abs(s.change),
      html: `${srcLink(s)} sent ${fmtInt(Math.abs(s.change))} ${s.change < 0 ? 'fewer' : 'more'} ${u} (${signedPct(s.value, s.prev)}).` });
  }
  const byChannel = new Map();
  for (const s of S.sources) {
    if (!s.channel) continue;
    const g = byChannel.get(s.channel) || { cur: 0, prev: 0, n: 0, change: 0, named: 0 };
    g.cur += s.value; g.prev += s.prev; g.n++; g.change += s.change; if (!free(s)) g.named += s.change;
    byChannel.set(s.channel, g);
  }
  for (const [ch, g] of byChannel) {
    const a = g.prev / p[u], b = g.cur / c[u];
    // One source is a source, not a channel. The channel itself must have moved, the same way as its share,
    // so a share that only shifted because another source moved doesn't count; nor does one a named source made.
    if (g.n < 2 || Math.abs(b - a) < .02 || !moved(g.change, g.prev) || Math.sign(g.change) !== Math.sign(b - a)
      || Math.abs(g.named) >= Math.abs(g.change) * .5) continue;
    out.push({ kind: 'channel', key: ch, impact: Math.abs(b - a) * c.visitors,
      html: `<button type="button" class="link told" data-f="channel" data-k="${esc(ch)}">${esc(labelOf('channel', ch))}</button> went from ${fmtPct(a)} to ${fmtPct(b)} of all ${u}.` });
  }
  return out.sort((x, y) => y.impact - x.impact);
}

// The page that gained or lost the most, apart from the one the sentence names. `key` is the page it names,
// so a list under it can bold that row without reading names back out of the HTML.
export function pagesFinding(rows, toldPage) {
  const m = rows.filter(r => r.key !== toldPage && r.prev && moved(r.value - r.prev, r.prev))
    .sort((a, b) => Math.abs(b.value - b.prev) - Math.abs(a.value - a.prev))[0];
  if (!m) return null;
  const change = m.value - m.prev;
  return { key: m.key, html: `<b>${m.key === '/' ? 'The home page' : pathHTML(m.key)}</b> ${change > 0 ? 'gained' : 'lost'} ${fmtInt(Math.abs(change))} visitors (${signedPct(m.value, m.prev)})` };
}

/* ---------- today ---------- */

// Today so far against a usual day at the same hour: the same weekday earlier in the period, or, with fewer
// than two of those, other weekdays (or weekend days). Only finished hours count, and not before 3am.
export function todayPace(hourly, nowSec) {
  if (!hourly?.visitors?.length) return null;
  const h = Math.floor((nowSec - hourly.start) / 3600), day = Math.floor(h / 24), hour = h % 24;
  if (day < 1 || day >= hourly.days || hour < 3) return null;
  const upTo = d => sum(hourly.visitors.slice(d * 24, d * 24 + hour));
  const weekend = d => [0, 6].includes(dayDate(hourly.start, d).getDay());
  let past = [], name = fmtWeekday(dayDate(hourly.start, day), 'long');
  for (let d = day - 7; d >= 0; d -= 7) past.push(d);
  if (past.length < 2) {
    past = [];
    for (let d = 0; d < day; d++) if (weekend(d) === weekend(day)) past.push(d);
    name = weekend(day) ? 'weekend day' : 'weekday';
  }
  if (past.length < 2) return null;
  const usual = median(past.map(upTo)), today = upTo(day);
  if (usual < 20) return null;
  const pct = Math.round((today - usual) / usual * 100);
  const html = `Today so far: ${Math.abs(pct) < 10 ? 'about as busy as' : `<b>${Math.abs(pct)}%</b> ${pct > 0 ? 'busier' : 'quieter'} than`} a usual ${name}`;
  return { today, usual, pct, html };
}

/* ---------- what the counts can't say ---------- */

// Under the home sentence, when the numbers come with a catch: Cloudflare kept only some of the views, or only
// one of the two periods crosses the start of a month (see unitOf).
export function countNotes(totals, days) {
  const out = [], cur = totals.sampled, prev = totals.prevSampled;
  if (cur || prev) out.push(`${cur && prev ? `These ${days} days and the ${days} before were` : cur ? `These ${days} days were` : `The ${days} days before were`} busy enough that Cloudflare kept only some of the views, so visitor counts may run a little low.`);
  if (unitOf(totals) === 'visits') out.push(`Lede counts each visitor once a month, and ${totals.split.cur ? `these ${days} days cross` : `the ${days} days before cross`} the start of one, so the two are compared on visits instead of visitors.`);
  return out;
}

// Runs of days far quieter than usual (under 35% of a usual day), today left out since it isn't over.
// A usual day is the period's median, or the period before's when most of this one had no visitors at all.
export function quietRuns(cur, prev = []) {
  const n = cur.length, usual = median(cur) || median(prev), out = [];
  if (usual < 20) return out;
  for (let i = 0; i < n - 1; i++) {
    if (cur[i] >= usual * .35) continue;
    const last = out.at(-1);
    if (last && last.end === i - 1) { last.end = i; last.visitors += cur[i]; }
    else out.push({ start: i, end: i, visitors: cur[i], usual });
  }
  return out;
}

/* ---------- daily bars ---------- */

// The part of the spike's bar that came from its top source.
// The busy day's bar shows the source that made it: the lead's spike, or any spike one source sent most of.
export function spikeSegment(S, ser) {
  let i = S.spike;
  if (i < 0) {
    i = findSpike(ser.cur.visitors, ser.start);
    if (i < 0 || ser.top[i] == null) return null;
    const src = S.sources.find(s => s.key === ser.top[i]), usual = (src?.value || 0) / ser.cur.visitors.length;
    if (ser.topVisitors[i] - usual < (ser.cur.visitors[i] - median(ser.cur.visitors)) * .5) return null;
  }
  if (ser.top[i] == null) return null;
  const total = ser.cur.visitors[i];
  return { day: i, total, top: Math.min(total, ser.topVisitors[i]), source: ser.top[i] };
}

/* ---------- where the change came from ---------- */

// Steps from 0 to the total change: one per source the sentence names (AI assistants as one step
// when it names one of them), everyone else, then the total. With nothing named, the two biggest movers.
export function waterfall(S, told) {
  if (!S.p.visitors) return null;
  const live = S.sources.filter(s => s.value || s.prev);
  const named = live.filter(s => told.has(s.key));
  const steps = [];
  const groupAI = told.has('ch:ai') || named.some(s => s.channel === 'ai');
  for (const s of named) if (!(groupAI && s.channel === 'ai')) steps.push({ kind: 'named', key: s.key, label: s.label, value: s.change });
  if (groupAI) steps.push({ kind: 'named', key: null, channel: 'ai', label: CHANNELS.ai, value: sum(live.filter(s => s.channel === 'ai').map(s => s.change)) });
  if (!steps.length) for (const s of live.slice().sort(byMove).slice(0, 2)) steps.push({ kind: 'mover', key: s.key, label: s.label, value: s.change });
  // Named steps keep the sentence's order, so the chart reads in the same order as the words; movers go by size.
  const said = [...told], at = st => st.channel ? Math.min(said.indexOf('ch:ai') >>> 0, ...named.filter(s => s.channel === 'ai').map(s => said.indexOf(s.key) >>> 0)) : said.indexOf(st.key) >>> 0;
  steps.sort((a, b) => a.kind === 'named' && b.kind === 'named' ? at(a) - at(b) : b.value - a.value);
  steps.push({ kind: 'else', key: null, label: 'Everyone else', value: S.diff - sum(steps.map(s => s.value)) });
  steps.push({ kind: 'total', key: null, label: 'Total', value: S.diff });
  return { steps, total: S.diff };
}

// `key` is the source the caption names (`ch:ai` for the AI assistants step), or null when it names none.
export function waterfallCaption(W, S) {
  const u = S.unit || 'visitors';
  const say = (html, step = null) => ({ html, key: step ? (step.channel ? `ch:${step.channel}` : step.key) : null });
  if (!W) return say('Nothing to compare with yet');
  if (S.flat) return say(`About as many ${u} as before (${fmtSigned(S.diff)})`);
  const parts = W.steps.filter(s => s.kind === 'named' || s.kind === 'mover');
  const word = ['one source', 'two sources', 'three sources'][parts.length - 1];
  const along = parts.filter(s => Math.sign(s.value) === Math.sign(W.total));
  const covered = sum(along.map(s => s.value)) / W.total;
  if (W.total > 0) {
    if (word && along.length === parts.length && covered >= .8) return say(`The extra <b>${fmtInt(W.total)}</b> ${u} came from ${word}`);
    if (along.length) return say(`<b>${esc(along[0].label)}</b> sent ${fmtInt(along[0].value)} of the ${fmtInt(W.total)} extra ${u}`, along[0]);
    return say(`<b>${fmtInt(W.total)}</b> more ${u}, spread across sources`);
  }
  if (word && along.length === parts.length && covered >= .8) return say(`The <b>${fmtInt(-W.total)}</b> fewer ${u} were from ${word}`);
  if (along.length) return say(`<b>${esc(along[0].label)}</b> sent ${fmtInt(-along[0].value)} fewer ${u}, out of ${fmtInt(-W.total)} fewer in all`, along[0]);
  return say(`<b>${fmtInt(-W.total)}</b> fewer ${u}, spread across sources`);
}

/* ---------- bounce: who visited vs how they behaved ---------- */

// Splits the change in bounce rate (cur − prev) into:
//   mix:        Σ visits_cur(s)·bounce_prev(s) / Σ visits_cur(s) − bounce_prev   (last period's rates on this period's sources)
//   behaviour:  visits_cur(s)·(bounce_cur(s) − bounce_prev(s)) / visits_cur      (each source's own change, weighted by its share)
//   rest:       whatever is left, so mix + top + rest = total (other sources' behaviour, sources new this period).
export function bounceSplit(S) {
  const { c, p } = S;
  if (!p.visits || !c.visits) return null;
  const total = c.bounce - p.bounce;
  const known = S.sources.filter(s => s.visits && s.prevBounce != null && s.bounce != null), seen = sum(known.map(s => s.visits));
  const mix = seen ? sum(known.map(s => s.visits * s.prevBounce)) / seen - p.bounce : 0;
  const by = known.map(s => ({ key: s.key, label: s.label, pts: s.visits * (s.bounce - s.prevBounce) / c.visits }))
    .sort((a, b) => Math.sign(total || 1) * (b.pts - a.pts));
  const top = by[0] && Math.sign(by[0].pts) === Math.sign(total) ? by[0] : null;
  const rest = total - mix - (top?.pts ?? 0);
  let cause;
  if (Math.round(Math.abs(total) * 100) === 0) cause = 'same';
  else if (Math.sign(mix) === Math.sign(total) && Math.abs(mix) >= Math.abs(total) * .6) cause = 'mix';
  else if (top && Math.abs(top.pts) >= Math.abs(total) * .3) cause = 'source';
  else cause = 'spread';
  return { total, mix, top, rest, by, cause, cur: c.bounce, prev: p.bounce };
}

export function bounceCaption(B) {
  if (!B) return 'Nothing to compare with yet';
  const pts = Math.round(Math.abs(B.total) * 100), unit = pts === 1 ? 'point' : 'points';
  if (B.cause === 'same') return 'Bounce about the same as before';
  const head = `Bounce ${B.total > 0 ? 'rose' : 'fell'} ${pts} ${unit}`;
  if (B.cause === 'mix') return `${head}, mostly from a change in where visitors came from`;
  if (B.cause === 'source') return `${head}, mostly <b>${esc(readers(B.top.label))}</b>`;
  return `${head}, spread across sources`;
}

/* ---------- sources → pages ---------- */

export function flowShare(flows, source, page) {
  const into = sum(flows.filter(f => f.page === page).map(f => f.visitors));
  const n = sum(flows.filter(f => f.page === page && f.source === source).map(f => f.visitors));
  const share = into ? n / into : 0;
  return { share, tenths: Math.round(share * 10), n, into };
}

export function flowCaption(S, T, flows) {
  if (!flows.length) return 'No visits yet';
  if (S.lead && T.page) {
    const { tenths } = flowShare(flows, S.lead.key, T.page);
    const what = S.page?.isNew ? `the new page ${pathHTML(T.page)}` : esc(pageName(T.page));
    if (tenths >= 1) return `<b>${tenths} in 10</b> visitors who landed on ${what} came from <b>${esc(S.lead.label)}</b>`;
  }
  const byPage = new Map();
  for (const f of flows) byPage.set(f.page, (byPage.get(f.page) || 0) + f.visitors);
  const [page, v] = [...byPage].sort((a, b) => b[1] - a[1])[0];
  const tenths = Math.round(v / sum([...byPage.values()]) * 10);
  return tenths >= 1 ? `<b>${tenths} in 10</b> visitors landed on <b>${esc(pageName(page))}</b>` : `Visitors landed on ${byPage.size} different pages`;
}

/* ---------- who is here now ---------- */

// Wee People letters that read as one standing person each.
const PEOPLE = 'RoKhuBqAbCeFgHiJlN';
const hash = s => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };

// One figure per visitor: those here now first (a source the sentence names first of all), then those who left.
// A visitor's figure comes from who they are, so it stays the same across refreshes.
export function crowd(live, told, max = 18) {
  if (!live) return [];
  const people = live.visitors.map(v => ({ v, here: !!v.active, named: !!v.active && told.has(v.referrer), letter: PEOPLE[hash(`${v.path}|${v.referrer}|${v.country}`) % PEOPLE.length] }));
  const order = p => p.here ? (p.named ? 0 : 1) : 2;
  return people.map((p, i) => [p, i]).sort((a, b) => order(a[0]) - order(b[0]) || a[1] - b[1]).map(([p]) => p).slice(0, max);
}

// The crowd as a line: people here now first, then those who left, each group in the order it arrived
// (someone last seen `ago` seconds ago after `seconds` on the site arrived ago + seconds ago). Past `max`,
// the earliest arrivals are dropped, those who left before anyone here, and `more` counts them, so one figure stays one person.
export function crowdLine(live, told, max = 30) {
  const byArrival = (a, b) => (b.v.ago + b.v.seconds) - (a.v.ago + a.v.seconds);
  const all = crowd(live, told, Infinity), here = all.filter(p => p.here).sort(byArrival), gone = all.filter(p => !p.here).sort(byArrival);
  const keepHere = here.slice(Math.max(0, here.length - max)), keepGone = gone.slice(Math.max(0, gone.length - (max - keepHere.length)));
  return { people: [...keepHere, ...keepGone], more: all.length - keepHere.length - keepGone.length };
}

export function crowdCaption(live) {
  // The second count is everyone seen in the last 30 minutes, those here now included.
  const recent = live?.recent || 0;
  const tail = recent > (live?.now || 0) ? ` <span class="muted">· ${fmtInt(recent)} in the last 30 minutes</span>` : '';
  if (!live?.now) return `No one here right now${tail}`;
  return `<i class="sw here"></i><b>${fmtInt(live.now)}</b> here now${tail}`;
}

// The online view's sentence: who among those here came from a source the summary names, and since when.
export function onlineStory(live, told, page) {
  const here = (live?.visitors || []).filter(v => v.active);
  if (!here.length) return 'No one is here right now.';
  // The count comes first, so "of them" always has something to refer to.
  const parts = [], named = here.filter(v => told.has(v.referrer));
  const opener = here.length === 1 ? 'One person is here now' : `${fmtInt(here.length)} people are here now`;
  if (named.length) {
    const who = labelOf('referrer', named[0].referrer), reading = named.every(v => v.path === page), one = here.length === 1;
    const them = one ? '. They' : named.length === 1 ? '; one of them' : `; ${named.length} of them`;
    parts.push(`${opener}${them} came from <b class="told src">${esc(who)}</b>`
      + (reading && page ? ` and ${named.length === 1 && !one ? 'is' : 'are'} reading <b>${esc(pageName(page))}</b>.` : '.'));
  } else {
    const byPage = new Map();
    for (const v of here) byPage.set(v.path, (byPage.get(v.path) || 0) + 1);
    const [top, k] = [...byPage].sort((a, b) => b[1] - a[1])[0];
    parts.push(here.length === 1 ? `${opener}, on ${esc(pageName(top))}.` : k > 1 ? `${opener}; ${k} of them are on <b>${esc(pageName(top))}</b>.` : `${opener}, each on a different page.`);
  }
  const mins = Math.max(1, Math.ceil(maxOf(here.map(v => v.seconds)) / 60));
  parts.push(here.length === 1 ? `They arrived ${mins === 1 ? 'in the last minute' : `${mins} minutes ago`}.` : `Everyone here now arrived in the last ${mins} minutes.`);
  return parts.join(' ');
}

/* ---------- pages ---------- */

// Like pagesFinding, `key` is the page the caption names, if it names one.
export function pagesCaption(rows) {
  const fresh = rows.filter(r => !r.prev).length, old = rows.filter(r => r.prev);
  const grew = old.filter(r => r.value > r.prev).length;
  const newPart = n => n === 1 ? 'one is new' : `${n} are new`;
  if (!rows.length) return { html: '', key: null };
  // With nothing to compare with, every page is "new", which says nothing; name the busiest instead.
  if (!old.length) {
    const top = rows.slice().sort((a, b) => b.value - a.value)[0].key;
    return { html: `Most visited: <b>${top === '/' ? 'the home page' : pathHTML(top)}</b>`, key: top };
  }
  const head = grew === old.length ? (old.length > 1 ? (old.length === 2 ? 'Both pages shown grew' : `All ${old.length} pages shown grew`) : `${old[0].key === '/' ? 'The home page' : pathHTML(old[0].key)} grew`)
    : grew === 0 ? 'No page shown grew' : `${grew} of ${old.length} pages shown grew`;
  return { html: fresh ? `${head}; <b>${newPart(fresh)}</b>` : head, key: null };
}

/* ---------- one source ---------- */

const shareWords = x => x >= .9 ? 'Nearly all' : x >= .6 ? 'Most' : x >= .5 ? 'Over half' : x >= .4 ? 'Almost half' : x >= .25 ? `${Math.round(x * 100)}%` : null;

// "6,482 visitors from Hacker News, up 82%. Almost half came on Fri, Oct 16–17. 60% of their visits bounced."
// The burst is the spike day plus the days right after it that stayed well above a usual day.
// The burst is weighed against the days added up, never against the period's visitors: someone who came on
// two days is one visitor but counts on both days.
export function sourceStory(totals, ser, label, days) {
  const c = totals.cur, p = totals.prev, cur = ser.cur.visitors, u = unitOf(totals), parts = [];
  const pct = pctChange(c[u], p[u]), daily = sum(cur);
  let first = `<b>${fmtInt(c.visitors)}</b> visitors from ${esc(label)}`;
  if (pct != null) first += pct ? `, <b>${u === 'visits' ? 'visits ' : ''}${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}%</b>` : ', about the same as before';
  let without = null, burstHTML = null;
  const spike = findSpike(cur, ser.start);
  if (spike >= 0) {
    const usual = median(cur);
    let end = spike;
    while (end + 1 < cur.length && cur[end + 1] > usual * 2) end++;
    const burst = sum(cur.slice(spike, end + 1)), words = shareWords(burst / daily);
    const a = dayDate(ser.start, spike), b = dayDate(ser.start, end);
    const when = end === spike ? fmtDate(a) : `${fmtWeekday(a)}, ${fmtDay(a)}–${b.getMonth() === a.getMonth() ? b.getDate() : fmtDay(b)}`;
    if (words) {
      burstHTML = `${words} came on <b class="told time">${when}</b>`;
      const k = end - spike + 1, rest = pctChange(daily - burst, sum(ser.prev?.visitors || []));
      if (rest != null) without = `Without ${k === 1 ? 'that day' : k === 2 ? 'those two days' : `those ${k} days`}, ${label} sent `
        + (rest ? `${Math.abs(rest)}% ${rest > 0 ? 'more' : 'fewer'} visitors than` : 'about as many visitors as') + ` the ${days} days before.`;
    }
  }
  parts.push(first + '.');
  if (burstHTML) parts.push(burstHTML + '.');
  // Bounce is a share of visits, not of visitors, so it gets a sentence of its own that says so.
  if (c.bounce != null && c.visitors >= 20) parts.push(`<b>${fmtPct(c.bounce)}</b> of their visits bounced.`);
  return { html: parts.join(' '), without };
}

/* ---------- countries, devices and browsers ---------- */

const lower = (dim, k) => labelOf(dim, k).toLowerCase();
// Countries whose English name takes "the".
const THE = /^(US|GB|NL|PH|AE|DO|BS|GM|CF|KY|MV|MH|SB|FO|TC|VG|VI)$/;
const who = (dim, k) => dim == 'country' ? `Readers from ${THE.test(k) ? 'the ' : ''}<b>${esc(labelOf(dim, k))}</b>`
  : dim == 'device' ? `Readers on <b>${lower(dim, k)}</b>` : k == 'app' ? 'Readers inside <b>apps</b>' : `Readers using <b>${esc(labelOf(dim, k))}</b>`;

// The finding that moved the most readers ({ html, dim, key }), by the rules in docs/how-it-works.md; null with no visitors.
export function audienceStory(A) {
  const total = rows => sum(rows.map(r => r.visitors));
  if (!total(A.country)) return null;
  let best = { impact: 0, html: `${sum(A.country.map(r => r.visits)) < 30 ? 'Too few visits yet to say much' : 'Nothing stands out'} about where readers are or what they use.` };
  const offer = (impact, dim, key, html) => { if (impact > best.impact) best = { impact, dim, key, html }; };
  for (const dim of ['country', 'device', 'browser']) for (const r of A[dim]) {
    const v = r.visitors, was = r.prev?.visitors, x = v / was, m = Math.round(x), c = total(A[dim]), shift = v / c - was / sum(A[dim].map(r => r.prev?.visitors));
    if (!/^(|XX|T1|other)$/.test(r.key) && moved(v - was, was) && Math.abs(shift) >= .02 && shift * (v - was) > 0) offer(Math.abs(shift) * c, dim, r.key,
      `${who(dim, r.key)} ${Math.abs(x - m) <= .15 && m > 1 && m < 4 ? ['doubled', 'tripled'][m - 2] : `${x > 1 ? 'rose' : 'fell'} ${Math.round(Math.abs(x - 1) * 100)}%`}, from ${fmtInt(was)} to ${fmtInt(v)}.`);
  }
  const [hi, lo] = ['phone', 'computer'].map(k => A.device.find(r => r.key == k)).sort((a, b) => b?.bounce - a?.bounce), all = total(A.device);
  if (lo?.visits >= 50 && hi.visits >= 50 && Math.round(hi.bounce * 100) - Math.round(lo.bounce * 100) >= 10) {
    const big = [hi, lo].find(r => r.visitors > all / 2), leave = `readers on ${lower('device', hi.key)} leave sooner: <b>${fmtPct(hi.bounce)}</b> of their visits bounce, against ${fmtPct(lo.bounce)} on ${lower('device', lo.key)}.`;
    offer(hi.visits * (hi.bounce - lo.bounce), 'device', hi.key, big ? `Most readers are on ${lower('device', big.key)}, ${big == hi ? 'and' : 'but'} ${leave}` : leave[0].toUpperCase() + leave.slice(1));
  }
  return best;
}

export const audienceNote = ({ partial: p }, days) => p ? `Lede began recording devices and browsers during ${p == 'cur' ? 'these' : 'the'} ${days} days${p == 'cur' ? '' : ' before'}, so they ${p == 'cur' ? 'cover only the visits since then and ' : ''}show no change yet.` : '';

/* ---------- other sub-pages ---------- */

// "2,985 visitors on /blog/new, none in the 30 days before. 6 in 10 of those who landed here came from Hacker News."
// flows: the visits that landed on this page, by source.
export function pageStory(totals, flows, path, days) {
  const u = unitOf(totals), c = totals.cur.visitors, pct = pctChange(totals.cur[u], totals.prev[u]);
  let s = `<b>${fmtInt(c)}</b> visitors on ${path === '/' ? 'the home page' : pathHTML(path)}`;
  s += pct == null ? `, none in the ${days} days before` : pct ? `, <b>${u === 'visits' ? 'visits ' : ''}${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}%</b>` : ', about the same as before';
  s += '.';
  const into = sum(flows.map(f => f.visitors));
  if (into >= 20) {
    const by = new Map();
    for (const f of flows) by.set(f.source, (by.get(f.source) || 0) + f.visitors);
    const [key, v] = [...by].sort((a, b) => b[1] - a[1])[0], share = v / into, who = `<b>${esc(labelOf('referrer', key))}</b>`;
    s += share >= .35 ? ` <b>${Math.round(share * 10)} in 10</b> of those who landed here came from ${who}.` : ` Those who landed here came from many places, the most from ${who}.`;
  }
  return s;
}

// How far down one page is read, from r.reach: the share of its readers still there 10%, 20%... 100% of the way
// down. It says where half have stopped and names the tenth that loses clearly the most (drop, from 0).
// Under 50 reads a tenth is a handful of people, so it says only that.
export function scrollStory(r) {
  const reach = r?.reach, n = Math.round(r?.views || 0), half = '<b>Half</b> your readers ';
  if (!reach || !n) return null;
  if (n < 50) return { few: true, drop: -1, sub: null, html: `Only ${n > 1 ? n + ' views' : 'one view'} of this page so far, too few to say how far people read.` };
  const at = (reach.findIndex(x => x < .5) + 1) * 10, end = reach[9];
  const html = !at ? (end >= .85 ? '<b>Nearly all</b> readers ' : end > .5 ? '<b>Most</b> readers ' : half) + 'reach the end.'
    : half + (at === 50 ? 'stop before <b>the middle</b> of this page.' : at === 100 ? 'stop just short of the end.' : `stop before they're <b>${at}%</b> of the way down this page.`);
  // An even fade loses a few points every tenth; a drop loses clearly more.
  const drops = reach.map((x, i) => (reach[i - 1] ?? 1) - x), most = maxOf(drops);
  const drop = most >= .1 && most >= 1.5 * median(drops) ? drops.indexOf(most) : -1;
  const where = drop ? `between ${drop}0% and ${drop === 9 ? 'the end' : `${drop + 1}0% of the way down`}` : 'in the first 10% of the page';
  return { few: false, drop, where, html, sub: drop < 0 ? null : `More readers stop ${where} than anywhere else: <b>${fmtPct(most)}</b> of them.` };
}

// The same reads over a picture of the page: a shade that darkens, tenth by tenth, as the share still reading
// falls (shade 0 where everyone reads, never fully dark), a line through the middle of the tenth the sentence
// names, and hover text per tenth. Under the reads threshold there is no picture, only the sentence.
export function scrollPicture(r) {
  const S = scrollStory(r);
  if (!S || S.few) return null;
  const R = r.reach, d = S.drop, top = `${fmtPct(R[0])} at 10%`, end = `${fmtPct(R[9])} reach the end`;
  const drop = d < 0 ? null : { at: (d + .5) / 10, label: `${fmtPct(R[d - 1] ?? 1)} → ${fmtPct(R[d])}` };
  return {
    stops: [1, ...R].map((x, i) => ({ at: i / 10, shade: (1 - x) * .85 })),
    top, end, drop,
    bands: R.map((x, i) => `${i + 1}0% of the way down: ${fmtPct(x)} still reading`),
    aria: `A picture of the page, darker where fewer read: ${fmtPct(R[0])} still reading at 10% of the way down, ${drop ? `${drop.label} ${S.where}, ` : ''}${end}.`,
  };
}

// With no picture to shade: the share still reading either side of the drop (drop: true after it) and at the end,
// or, with no drop worth naming, at the top, the middle and the end.
export function scrollNumbers(r) {
  const S = scrollStory(r);
  if (!S || S.few) return null;
  const R = r.reach, d = S.drop;
  return [...new Set([...(d > 0 ? [d - 1, d] : [0, 4]), 9])].map(i =>
    ({ value: fmtPct(R[i]), label: i === 9 ? 'reach the end' : i === 4 ? 'read past the middle' : `read past ${i + 1}0%`, drop: i === d }));
}

// Under the picture: what it is and when it was taken, or why there is none yet. kind is shot (Cloudflare's
// picture of the page), og (the picture the page shares on social sites), none, or wait (still on its way).
export function pictureCaption({ path, days, kind, why }) {
  const page = esc(pageName(path)), fix = 'give Lede’s Cloudflare token the Browser Run permission';
  const later = why === 'failed' ? 'Cloudflare couldn’t take a picture of this page. ' : why === 'permission' ? `For a picture of the page, ${fix}. ` : 'Lede takes a picture of the page tomorrow. ';
  const what = kind === 'shot' ? `Picture of ${page} taken today. `
    : kind === 'og' ? `This is the picture ${page} shows when shared on social sites, not the page itself. ${later}`
      : kind === 'none' ? (why === 'permission' ? `To show a picture of the page here, ${fix}. ` : why === 'failed' ? later : 'No picture of the page yet; Lede takes one tomorrow. ') : '';
  return what + (days === 1 ? 'Readers counted today.' : `Readers counted over the last ${days} days.`);
}

// What readers do after a page (from /api/next): the two biggest steps, leaving the site or going on to a
// page, as shares; on fewer than 20 views, as counts. told: the page the sentence names, for the fan.
// A change in how many leave is told when both periods have 20 views and it is well clear of chance.
export function nextStory(next, days) {
  const c = next?.cur;
  if (!c?.views) return null;
  const page = next.path === '/' ? 'the home page' : pathHTML(next.path), top = c.next[0];
  const to = r => `<b>${pathHTML(r.key)}</b>`;
  const note = next.sampled ? `Worked out from ${fmtInt(c.visits)} visits picked at random.` : '';
  if (c.views < 20) {
    const parts = [];
    if (c.left) parts.push(c.views === 1 ? 'it ended the visit here' : `${c.left} ended the visit here`);
    if (top) parts.push(`${top.views} went on to ${to(top)}`);
    return { html: `Only ${c.views} ${c.views === 1 ? 'view' : 'views'} of this page so far: ${parts.join(' and ')}.`, note, told: null };
  }
  let html;
  if (!top) html = `Everyone leaves the site after <b>${page}</b>.`;
  else {
    const leave = c.left ? `<b>${fmtPct(c.left / c.views)}</b> leave the site` : 'none leave the site';
    const go = `<b>${fmtPct(top.views / c.views)}</b> go on to ${to(top)}`;
    html = `After <b>${page}</b>, ${top.views > c.left ? `${go} and ${leave}` : `${leave} and ${go}`}.`;
  }
  const p = next.prev;
  if (p?.views >= 20) {
    const a = c.left / c.views, b = p.left / p.views, se = Math.sqrt(a * (1 - a) / c.views + b * (1 - b) / p.views);
    if (Math.abs(a - b) >= .05 && Math.abs(a - b) > 2 * se) html += ` In the ${days} days before, ${fmtPct(b)} left.`;
  }
  return { html, note, told: top?.key ?? null };
}

// The steps after a page as the fan draws them: the top four pages, the rest as one, then leaving the site.
export function nextItems(cur, told) {
  const top = cur.next.slice(0, 4), rest = cur.next.slice(4);
  const items = top.map(r => ({ key: r.key, label: r.key, value: r.views, kind: 'page', story: r.key === told }));
  if (rest.length) items.push({ key: null, label: `${rest.length} other ${rest.length === 1 ? 'page' : 'pages'}`, value: sum(rest.map(r => r.views)), kind: 'page', story: false });
  if (cur.left) items.push({ key: null, label: 'Left the site', value: cur.left, kind: 'left', story: false });
  return items;
}

const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
export function eventsSentence(events, days) {
  if (!events.length) return `Nothing unusual in the last ${days} days.`;
  const n = events.length;
  return `${COUNT_WORDS[n] ?? n} ${n === 1 ? 'thing' : 'things'} stood out.`;
}

// A channel's share of all visitors, when it moved by at least a point: the reason a channel gets named on home.
export function channelShare(ch, all, label) {
  if (!ch.prev.visitors || !all.prev.visitors || !all.cur.visitors) return null;
  const a = ch.prev.visitors / all.prev.visitors, b = ch.cur.visitors / all.cur.visitors;
  if (Math.abs(b - a) < .01) return null;
  return `<b>${esc(label)}</b> went from ${fmtPct(a)} to ${fmtPct(b)} of all visitors.`;
}

/* ---------- goals ---------- */

export const fmtRate = x => x < .1 ? (x * 100).toFixed(1) + '%' : Math.round(x * 100) + '%';

// "1.3% of visits reached /signup; from Hacker News only 0.1%." The source the summary names gets a mention when it
// converts at half or twice the overall rate; otherwise the source that did best, when it did twice as well.
export function goalStory(conv, goals, leadKey) {
  if (!conv || conv.visits < 50) return null;
  const all = conv.reached / conv.visits, what = goals.length === 1 ? esc(pageName(goals[0])) : 'a goal';
  let s = `<b>${fmtRate(all)}</b> of visits reached ${what}`;
  const rate = r => r.reached / r.visits, big = conv.rows.filter(r => r.visits >= 100);
  const lead = big.find(r => r.key === leadKey);
  if (lead && all && (rate(lead) <= all / 2 || rate(lead) >= all * 2)) {
    s += `; from <b>${esc(labelOf('referrer', lead.key))}</b> ${rate(lead) < all ? 'only ' : ''}${fmtRate(rate(lead))}`;
  } else {
    const best = big.slice().sort((a, b) => rate(b) - rate(a))[0];
    if (best && all && rate(best) >= all * 2) s += `; visits from <b>${esc(labelOf('referrer', best.key))}</b> did best, ${fmtRate(rate(best))}`;
  }
  return s + '.';
}

const GOAL_LIKE = /^\/(sign-?up|register|thank|checkout|subscribe|contact|demo|trial|get-started)/i;
// The busiest page that looks like a goal, to offer as one when none is set.
export function suggestGoal(rows) {
  return rows.filter(r => GOAL_LIKE.test(r.key)).sort((a, b) => b.value - a.value)[0]?.key ?? null;
}

/* ---------- keywords ---------- */

// A word's change, unless too few used it to call it a change. any: the list had words before, so "new" means something.
// how: "often" for searches, "many" for the visitors an ad word sent.
function wordChange(r, any, how) {
  if (r.visitors < 20 || (r.prev && r.prev < 10)) return '';
  if (!r.prev) return any ? ', a word no one used before' : '';
  const x = r.visitors / r.prev, pct = Math.round((x - 1) * 100), m = Math.round(x);
  return x >= 2 ? `, ${m === 2 ? 'twice' : `${m} times`} as ${how} as before` : Math.abs(pct) >= 15 ? `, ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}%` : '';
}

// "The word people searched your site for most was pricing, 3 times as often as before." Then the ads' top word.
export function keywordsStory({ site, paid }) {
  const say = (list, few, most, how) => {
    const r = list[0], w = `<b>${esc(r.key)}</b>`;
    return r.visitors < 20 ? few(w) : most(w) + wordChange(r, list.some(x => x.prev), how) + '.';
  };
  const parts = [];
  if (site.length) parts.push(say(site, w => `A few people searched your site, most often for ${w}.`, w => `The word people searched your site for most was ${w}`, 'often'));
  if (paid.length) parts.push(say(paid, w => `A few visitors came from your ads; ${w} brought the most.`, w => `Of the words your ads paid for, ${w} brought the most visitors`, 'many'));
  return parts.join(' ') || 'No search words yet.';
}

// The overview's Keywords card on list k (ads when only they have words): sentence or what to do, the top 5 rows.
export function keywordsCard(K, k = !K.site.length && K.paid.length ? 'paid' : 'site', open = false) {
  const list = K[k], rows = (open ? list : list.slice(0, 5)).map(r => ({ key: r.key, label: r.key, value: r.visitors, prev: r.prev }));
  return { k, rows, all: open || list.length <= 5 ? 0 : list.length, total: list.reduce((a, r) => a + r.visitors, 0),
    say: list.length ? keywordsStory({ site: [], paid: [], [k]: list }) : '', empty: list.length ? '' : KEYWORDS_EMPTY[k] };
}

// What an empty list tells the owner to do.
export const KEYWORDS_EMPTY = {
  site: 'No searches yet. Lede reads the words after ?q= or ?s= in your search page’s address, so searches from a box that puts them there show up here.',
  paid: 'No ad words yet. Add utm_term={keyword} to your ads’ links, and the words people searched to see the ad show up here.',
};
/* ---------- funnels ---------- */

// Below this many visits at the first step, a funnel is too small to say where people are lost.
const FUNNEL_MIN = 30;
const stepName = k => esc(pageName(k));
const stepLabel = k => k === '/' ? 'Home page' : k;
export const funnelName = steps => steps.map(stepLabel).join(' → ');
export function stepHint({ steps, cur }, i) {
  const s = `${stepLabel(steps[i])}: ${fmtInt(cur[i])} ${cur[i] === 1 ? 'visit' : 'visits'}`, lost = i ? cur[i - 1] - cur[i] : 0;
  if (!i) return s;
  return `${s}, ${cur[i - 1] ? fmtPct(cur[i] / cur[i - 1]) : '0%'} of those at ${pageName(steps[i - 1])}${lost ? `; ${fmtInt(lost)} dropped off on the way` : ''}`;
}

// "Of 120 visits that reached /pricing, 9 got to /thanks. Most dropped off between /pricing and /signup."
// drop: the step most visits never reached (the loss is between drop - 1 and drop), or -1 when none is picked out.
export function funnelStory({ steps, cur }, days) {
  const first = cur[0], last = cur[cur.length - 1], from = stepName(steps[0]), to = stepName(steps.at(-1));
  if (!first) return { html: `No visits reached ${from} in the last ${days} days.`, drop: -1 };
  if (first < FUNNEL_MIN) return { html: `<b>${fmtInt(first)}</b> ${first === 1 ? 'visit' : 'visits'} reached ${from} and <b>${fmtInt(last)}</b> got to ${to}, too few yet to say where visits drop off.`, drop: -1 };
  const lost = cur.map((n, i) => i ? cur[i - 1] - n : 0), drop = lost.indexOf(Math.max(...lost));
  const done = last === first ? `all <b>${fmtInt(last)}</b>` : last ? `<b>${fmtInt(last)}</b>` : '<b>none</b>';
  let s = `Of <b>${fmtInt(first)}</b> visits that reached ${from}, ${done} got to ${to}.`;
  if (last === first) return { html: s, drop: -1 };
  const where = `between ${stepName(steps[drop - 1])} and ${stepName(steps[drop])}`;
  s += lost[drop] * 2 > first - last ? ` Most dropped off ${where}.` : ` The biggest drop was ${where}.`;
  return { html: s, drop };
}

// A funnel's bars in px of span: each step's visits, at least 8px so the last step stays visible, and on top the
// visits lost on the way to it, up to the step before: a pale neutral, stronger for the biggest drop. Never bounce red.
export function funnelBars(cur, drop, span) {
  const hs = cur.map(v => v && Math.max(8, Math.round(span * v / cur[0])));
  return hs.map((h, i) => ({ v: cur[i], h, lost: i && Math.max(0, hs[i - 1] - h), hot: i === drop, lostFill: `var(--${i === drop ? 'lost' : 'lost-p'})` }));
}

export const FUNNEL_EMPTY = 'Type the pages a visit goes through, in order, to see where visits drop off.';

// Filled in, ready to save: the busiest page, then the first goal, unless a saved funnel already goes there.
export function funnelOffer(rows, goals, funnels) {
  const last = goals[0], first = rows.find(r => r.key !== last)?.key;
  return last && first && !funnels.some(f => f[0] === first && f.at(-1) === last) ? `${first}, ${last}` : '';
}

// Steps typed on one line: "/pricing, /signup, /thanks" (spaces and arrows work too).
export function parseSteps(text) {
  const steps = text.split(/[\s,→>]+/).filter(Boolean);
  if (steps.length < 2) return { error: 'Type at least two pages, in the order a visit sees them.' };
  if (steps.length > 5) return { error: 'A funnel can have at most five pages.' };
  const bad = steps.find(s => !s.startsWith('/'));
  if (bad) return { error: `Each page starts with a slash: /${bad}, not ${bad}.` };
  if (new Set(steps).size < steps.length) return { error: 'A page can only be in a funnel once.' };
  return { steps };
}

/* ---------- speed ---------- */

// Web Vitals at the 75th percentile, against Google's thresholds: good up to the first, poor past the second.
// lcp (loading) and inp (answering a tap or click) are in ms; cls (how much the layout moves) is ×1000.
export const VITALS = { lcp: [2500, 4000], inp: [200, 500], cls: [100, 250] };
// Below this many views a 75th percentile is a handful of people.
const VITALS_MIN = 30;
export const vitalRating = (k, v) => v == null ? null : v <= VITALS[k][0] ? 'good' : v > VITALS[k][1] ? 'poor' : 'needs work';
export const fmtVital = (k, v) => k === 'cls' ? (v / 1000).toFixed(2) : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
const VITAL_WORDS = { lcp: v => `loaded within ${v}`, inp: v => `answered a tap or click within ${v}`, cls: v => `moved their layout by ${v} or less` };
const listed = a => a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a.at(-1)}` : a[0];

// One page's speed, from an engagement row: "3 in 4 views loaded within 2.1 s (good) and …". Null with no measures.
export function vitalsLine(r) {
  const have = Object.keys(VITALS).filter(k => r?.[k] != null);
  if (!have.length) return null;
  if ((r.views || 0) < VITALS_MIN) return { html: 'Too few views yet to say how fast this page is.', ratings: {} };
  const ratings = Object.fromEntries(have.map(k => [k, vitalRating(k, r[k])]));
  return { ratings, html: `3 in 4 views ${listed(have.map(k => `${VITAL_WORDS[k](`<b>${fmtVital(k, r[k])}</b>`)} (${ratings[k]})`))}.` };
}
export const VITALS_HINT = 'Good is within 2.5 s to load, 200 ms to answer and 0.1 of layout movement; poor is over 4 s, 500 ms and 0.25.';

// The busiest page that is slow for many of its readers: poor loading or answering, at least 50 visitors and
// 5% of all of them. rows: engagement rows; pageRows: { key, value } with visitors.
export function vitalsFinding(rows, pageRows, total) {
  const seen = new Map(pageRows.map(r => [r.key, r.value]));
  const slow = rows.map(r => ({ r, v: seen.get(r.key) || 0, load: vitalRating('lcp', r.lcp) === 'poor', answer: vitalRating('inp', r.inp) === 'poor' }))
    .filter(x => (x.load || x.answer) && x.r.views >= VITALS_MIN && x.v >= 50 && x.v >= total * .05)
    .sort((a, b) => b.v - a.v)[0];
  if (!slow) return null;
  const { r, v } = slow, parts = [];
  if (slow.load) parts.push(`1 in 4 views took ${fmtVital('lcp', r.lcp)} or longer to load`);
  if (slow.answer) parts.push(`${slow.load ? '1 in 4' : '1 in 4 views'} waited ${fmtVital('inp', r.inp)} or longer for a tap or click to answer`);
  const page = `<button type="button" class="link told" data-f="path" data-k="${esc(r.key)}">${r.key === '/' ? 'The home page' : pathHTML(r.key)}</button>`;
  return { key: r.key, html: `${page} is slow for many of its ${fmtInt(v)} visitors: ${parts.join(', and ')}.` };
}
