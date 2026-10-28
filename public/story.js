// The facts behind the home screen and the sentences that tell them. No DOM here, so node tests can run it.
import { displayHost } from './hosts.js';

/* ---------- formatting ---------- */
export const CHANNELS = { paid: 'Paid', email: 'Email', ai: 'AI assistants', search: 'Search', video: 'Video', social: 'Social', referral: 'Referral', direct: 'Direct' };
// Hosts whose name doesn't read as the site people know.
const NAMES = { 'news.ycombinator.com': 'Hacker News' };
export const labelOf = (dim, key) => dim === 'channel' ? (CHANNELS[key] || key || 'Unknown') : dim === 'referrer' ? (NAMES[key] || displayHost(key) || 'Direct') : (key || '(none)');
export const fmtN = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(2) + 'k' : String(Math.round(n));
export const fmtInt = n => Math.round(n).toLocaleString('en-US');
export const count = n => n < 1e5 ? fmtInt(n) : fmtN(n);
export const fmtSigned = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + fmtInt(Math.abs(n));

// Hover hints on the charts.
const visitors = n => `${fmtInt(n)} ${Math.round(n) === 1 ? 'visitor' : 'visitors'}`;
export const dayHint = (day, n, before, days) => `${day}: ${visitors(n)}${before == null ? '' : ` · ${days} days earlier: ${fmtInt(before)}`}`;
export const ribbonHint = (from, to, n) => `${from} → ${to}: ${visitors(n)}`;
export const sourceHint = (label, n, prev) => `${label}: ${visitors(n)}, `
  + (!prev ? 'none before' : n > prev ? `${fmtInt(n - prev)} more than before` : n < prev ? `${fmtInt(prev - n)} fewer than before` : 'the same as before');
export const pageHint = (label, n) => `${label}: ${visitors(n)} landed here`;
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
const periodWord = days => days >= 28 ? 'month' : days === 7 ? 'week' : `${days} days`;
const readers = label => label === 'Direct' ? 'direct visitors' : `${label} readers`;

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
export function readStory({ totals, ser, pages, refs, flows }) {
  const c = totals.cur, p = totals.prev, diff = c.visitors - p.visitors;
  const sources = refs.rows.map(r => ({ key: r.key, label: labelOf('referrer', r.key), channel: r.channel, value: r.visitors, prev: r.prev?.visitors || 0,
    change: r.visitors - (r.prev?.visitors || 0), bounce: r.bounce, prevBounce: r.prev?.bounce, visits: r.visits, prevVisits: r.prev?.visits || 0 }));
  // Changes within normal noise are not explained.
  const flat = !p.visitors || Math.abs(diff) < Math.max(p.visitors * .03, 2 * Math.sqrt(p.visitors));
  const S = { c, p, diff, flat, sources, lead: null, second: null, counter: null, page: null, spike: -1, prevSpike: -1, fast: null, fresh: null };
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
  const share = s => s.value >= c.visitors * .01;
  S.fast = sources.filter(s => !named.has(s) && share(s) && s.prev >= 20 && s.change >= Math.max(10, 2 * Math.sqrt(s.prev)) && s.value >= s.prev * 1.05)
    .sort((a, b) => b.value / b.prev - a.value / a.prev)[0] || null;
  if (!S.fast) S.fresh = sources.filter(s => !named.has(s) && !s.prev && s.value >= 20 && share(s)).sort((a, b) => b.value - a.value)[0] || null;
  return S;
}

// The sentence, and the set of sources it names. It says who moved the total (and where they landed) and who is
// growing fastest; the spike and the bounce have tiles of their own, so it leaves them out.
export function tellStory(S, ser, days) {
  const told = new Set();
  const src = s => { told.add(s.key); return `<button type="button" class="link told" data-f="referrer" data-k="${esc(s.key)}">${esc(s.label)}</button>`; };
  const page = k => `<button type="button" class="link told" data-f="path" data-k="${esc(k)}">${k === '/' ? 'the home page' : pathHTML(k)}</button>`;
  const { c, p, diff, lead, second, counter } = S, parts = [];
  if (!c.visitors && !p.visitors) return { html: `No visitors in the last ${days} days yet.`, told, page: null };
  if (!p.visitors) return { html: 'This is the first period with visitors, so there is nothing to compare it with yet.', told, page: null };
  const n = v => fmtInt(Math.abs(v));
  if (S.flat || !lead) parts.push(`About as many visitors as the ${days} days before (${fmtSigned(diff)}).`);
  else if (diff > 0) {
    let s;
    if (second) s = `${src(lead)} (${fmtSigned(lead.change)}) and ${src(second)} (${fmtSigned(second.change)}) grew the most`;
    else if (lead.change > diff) s = `${src(lead)} sent ${n(lead.change)} more visitors` + (counter ? `, while ${src(counter)} sent ${n(counter.change)} fewer` : '');
    else if (lead.change >= diff * .95) s = `${src(lead)} brought ${lead.change === diff ? 'all' : 'nearly all'} of the ${n(diff)} extra visitors`;
    else if (lead.change >= diff * .25) s = `${src(lead)} brought ${n(lead.change)} of the ${n(diff)} extra visitors`;
    else s = `The rise was spread across sources; ${src(lead)} grew most, by ${n(lead.change)}`;
    if (S.page) s += `, mostly to ${S.page.isNew ? 'the new page ' : ''}${page(S.page.key)}`;
    parts.push(s + '.');
  } else {
    if (second) parts.push(`${src(lead)} (${fmtSigned(lead.change)}) and ${src(second)} (${fmtSigned(second.change)}) fell the most.`);
    else if (-lead.change > -diff) parts.push(`${src(lead)} sent ${n(lead.change)} fewer visitors` + (counter ? `, while ${src(counter)} sent ${n(counter.change)} more.` : '.'));
    else if (lead.change <= diff * .95) parts.push(`${lead.change === diff ? 'All' : 'Nearly all'} of the ${n(diff)} fewer visitors were from ${src(lead)}.`);
    else if (-lead.change >= -diff * .25) parts.push(`Of the ${n(diff)} fewer visitors, ${n(lead.change)} were from ${src(lead)}.`);
    else parts.push(`The drop was spread across sources; ${src(lead)} fell most, by ${n(lead.change)}.`);
    if (S.prevSpike >= 0) parts.push(`The ${days} days before included a spike on ${fmtDate(dayDate(ser.start - ser.days * 86400, S.prevSpike), 'long')}.`);
  }
  // The second claim is whichever finding moved the most visitors among those not named yet.
  const f = findings(S, told)[0];
  if (f) { parts.push(f.html); told.add(f.kind === 'channel' ? `ch:${f.key}` : f.key); }
  return { html: parts.join(' '), told, page: S.page?.key ?? null };
}

/* ---------- findings ---------- */

const srcLink = s => `<button type="button" class="link told" data-f="referrer" data-k="${esc(s.key)}">${esc(s.label)}</button>`;
const signedPct = (v, p) => { const x = Math.round((v - p) / p * 100); return (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x) + '%'; };
// A change worth a sentence: big enough against noise and against what the source sent before.
const moved = (change, prev) => prev >= 30 && Math.abs(change) >= Math.max(30, 2 * Math.sqrt(prev)) && Math.abs(change) >= prev * .1;

// Everything worth saying that `told` doesn't already cover, biggest first. `impact` is how many visitors it moved.
// Kinds: fast (growing fastest), fresh (new source), vanished, drop or rise (against the total's direction, or
// either way when the total is flat), channel (a channel's share of visitors, spread over several sources).
export function findings(S, told) {
  const { c, p, diff } = S, out = [];
  if (!p.visitors) return out;
  const free = s => !told.has(s.key);
  if (S.fast && free(S.fast)) {
    const f = S.fast, x = f.value / f.prev;
    out.push({ kind: 'fast', key: f.key, impact: f.change, html: x >= 3
      ? `${srcLink(f)} is growing fastest, from ${fmtInt(f.prev)} to ${fmtInt(f.value)} visitors.`
      : `${srcLink(f)} is growing fastest, up ${fmtInt((x - 1) * 100)}%.` });
  }
  if (S.fresh && free(S.fresh)) out.push({ kind: 'fresh', key: S.fresh.key, impact: S.fresh.value, html: `New this period: ${srcLink(S.fresh)}, with ${fmtInt(S.fresh.value)} visitors.` });
  for (const s of S.sources) {
    if (!free(s) || s === S.fast) continue;
    if (s.prev >= 30 && s.value <= s.prev * .1) out.push({ kind: 'vanished', key: s.key, impact: s.prev - s.value, html: `${srcLink(s)} stopped sending visitors; it sent ${fmtInt(s.prev)} before.` });
    else if (moved(s.change, s.prev) && (S.flat || Math.sign(s.change) !== Math.sign(diff))) out.push({ kind: s.change < 0 ? 'drop' : 'rise', key: s.key, impact: Math.abs(s.change),
      html: `${srcLink(s)} sent ${fmtInt(Math.abs(s.change))} ${s.change < 0 ? 'fewer' : 'more'} visitors (${signedPct(s.value, s.prev)}).` });
  }
  const byChannel = new Map();
  for (const s of S.sources) {
    if (!s.channel) continue;
    const g = byChannel.get(s.channel) || { cur: 0, prev: 0, n: 0, change: 0, named: 0 };
    g.cur += s.value; g.prev += s.prev; g.n++; g.change += s.change; if (!free(s)) g.named += s.change;
    byChannel.set(s.channel, g);
  }
  for (const [ch, g] of byChannel) {
    const a = g.prev / p.visitors, b = g.cur / c.visitors;
    // One source is a source, not a channel. The channel itself must have moved, the same way as its share,
    // so a share that only shifted because another source moved doesn't count; nor does one a named source made.
    if (g.n < 2 || Math.abs(b - a) < .02 || !moved(g.change, g.prev) || Math.sign(g.change) !== Math.sign(b - a)
      || Math.abs(g.named) >= Math.abs(g.change) * .5) continue;
    out.push({ kind: 'channel', key: ch, impact: Math.abs(b - a) * c.visitors,
      html: `<button type="button" class="link told" data-f="channel" data-k="${esc(ch)}">${esc(labelOf('channel', ch))}</button> went from ${fmtPct(a)} to ${fmtPct(b)} of visitors.` });
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
  return { key: m.key, html: `<b>${m.key === '/' ? 'The home page' : esc(m.key)}</b> ${change > 0 ? 'gained' : 'lost'} ${fmtInt(Math.abs(change))} visitors (${signedPct(m.value, m.prev)})` };
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
  const html = Math.abs(pct) < 10 ? `Today about as busy as a usual ${name}` : `Today <b>${pct > 0 ? '+' : '−'}${Math.abs(pct)}%</b> vs a usual ${name}`;
  return { today, usual, pct, html };
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

export function daysCaption(S, ser, days) {
  const cur = ser.cur.visitors;
  if (S.spike >= 0) {
    const d = dayDate(ser.start, S.spike), others = cur.filter((_, j) => j !== S.spike), m = sum(others) / others.length;
    const sd = Math.sqrt(sum(others.map(v => (v - m) ** 2)) / others.length);
    return sd <= m * .35 ? `A steady ${periodWord(days)}, except <b>one ${fmtWeekday(d, 'long')}</b>` : `<b>${fmtDate(d)}</b> stood out`;
  }
  if (!sum(cur)) return 'No visitors yet';
  const i = cur.indexOf(maxOf(cur));
  return `Busiest day: <b>${fmtDate(dayDate(ser.start, i))}</b> · ${fmtInt(cur[i])}`;
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
  const say = (html, step = null) => ({ html, key: step ? (step.channel ? `ch:${step.channel}` : step.key) : null });
  if (!W) return say('Nothing to compare with yet');
  if (S.flat) return say(`About as many visitors as before (${fmtSigned(S.diff)})`);
  const parts = W.steps.filter(s => s.kind === 'named' || s.kind === 'mover');
  const word = ['one place', 'two places', 'three places'][parts.length - 1];
  const along = parts.filter(s => Math.sign(s.value) === Math.sign(W.total));
  const covered = sum(along.map(s => s.value)) / W.total;
  if (W.total > 0) {
    if (word && along.length === parts.length && covered >= .8) return say(`The extra <b>${fmtInt(W.total)}</b> visitors came from ${word}`);
    if (along.length) return say(`<b>${esc(along[0].label)}</b> brought ${fmtInt(along[0].value)} of the ${fmtInt(W.total)} extra visitors`, along[0]);
    return say(`<b>${fmtInt(W.total)}</b> more visitors, spread across sources`);
  }
  if (word && along.length === parts.length && covered >= .8) return say(`The <b>${fmtInt(-W.total)}</b> fewer visitors were from ${word}`);
  if (along.length) return say(`<b>${esc(along[0].label)}</b> sent ${fmtInt(-along[0].value)} of the ${fmtInt(-W.total)} fewer visitors`, along[0]);
  return say(`<b>${fmtInt(-W.total)}</b> fewer visitors, spread across sources`);
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
  const pts = Math.round(Math.abs(B.total) * 100), unit = pts === 1 ? 'pt' : 'pts';
  if (B.cause === 'same') return 'Bounce about the same as before';
  const head = `Bounce ${B.total > 0 ? 'rose' : 'fell'} ${pts} ${unit}`;
  if (B.cause === 'mix') return `${head}, mostly because of who visited`;
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
    const what = S.page?.isNew ? 'the new page' : esc(pageName(T.page));
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
  const tail = recent > (live?.now || 0) ? ` <span class="muted">· ${fmtInt(recent)} in the last 30 min</span>` : '';
  if (!live?.now) return `No one here right now${tail}`;
  return `<i class="sw here"></i><b>${fmtInt(live.now)}</b> here now${tail}`;
}

// The online view's sentence: who among those here came from a source the summary names, and since when.
export function onlineStory(live, told, page) {
  const here = (live?.visitors || []).filter(v => v.active);
  if (!here.length) return 'No one is on the site right now.';
  // The count comes first, so "of them" always has something to refer to.
  const parts = [], named = here.filter(v => told.has(v.referrer));
  const opener = here.length === 1 ? 'One person is here now' : `${fmtInt(here.length)} people are here now`;
  if (named.length) {
    const who = labelOf('referrer', named[0].referrer), reading = named.every(v => v.path === page);
    const them = here.length === 1 ? 'they' : named.length === 1 ? 'one of them' : `${named.length} of them`;
    parts.push(`${opener}; ${them} came from <b class="told src">${esc(who)}</b>`
      + (reading && page ? ` and ${named.length === 1 ? 'is' : 'are'} reading <b>${esc(pageName(page))}</b>.` : '.'));
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
    return { html: `Most visited: <b>${esc(pageName(top))}</b>`, key: top };
  }
  const head = grew === old.length ? (old.length > 1 ? 'All pages grew' : 'It grew') : grew === 0 ? 'No page grew' : `${grew} of ${old.length} pages grew`;
  return { html: fresh ? `${head}; <b>${newPart(fresh)}</b>` : head, key: null };
}

/* ---------- one source ---------- */

const shareWords = x => x >= .9 ? 'Nearly all' : x >= .6 ? 'Most' : x >= .5 ? 'Over half' : x >= .4 ? 'Almost half' : x >= .25 ? `${Math.round(x * 100)}%` : null;

// "6,482 visitors from Hacker News, up 82%. Almost half came on Fri, Oct 16–17, and 6 in 10 bounced."
// The burst is the spike day plus the days right after it that stayed well above a usual day.
export function sourceStory(totals, ser, label, days) {
  const c = totals.cur, p = totals.prev, cur = ser.cur.visitors, parts = [];
  const pct = pctChange(c.visitors, p.visitors);
  let first = `<b>${fmtInt(c.visitors)}</b> visitors from ${esc(label)}`;
  if (pct != null) first += pct ? `, <b>${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}%</b>` : ', about the same as before';
  let without = null, burstHTML = null;
  const spike = findSpike(cur, ser.start);
  if (spike >= 0) {
    const usual = median(cur);
    let end = spike;
    while (end + 1 < cur.length && cur[end + 1] > usual * 2) end++;
    const burst = sum(cur.slice(spike, end + 1)), words = shareWords(burst / c.visitors);
    const a = dayDate(ser.start, spike), b = dayDate(ser.start, end);
    const when = end === spike ? fmtDate(a) : `${fmtWeekday(a)}, ${fmtDay(a)}–${b.getMonth() === a.getMonth() ? b.getDate() : fmtDay(b)}`;
    if (words) {
      burstHTML = `${words} came on <b class="told time">${when}</b>`;
      const k = end - spike + 1, rest = pctChange(c.visitors - burst, p.visitors);
      if (rest != null) without = `Without ${k === 1 ? 'that day' : k === 2 ? 'those two days' : `those ${k} days`}, ${label} sent `
        + (rest ? `${Math.abs(rest)}% ${rest > 0 ? 'more' : 'fewer'} visitors than` : 'about as many visitors as') + ` the ${days} days before.`;
    }
  }
  const tenths = c.bounce != null && c.visitors >= 20 ? Math.round(c.bounce * 10) : null;
  const left = tenths != null ? `<b>${fmtPct(c.bounce)}</b> bounced` : null;
  parts.push(first + '.');
  if (burstHTML && left) parts.push(`${burstHTML}, and ${left}.`);
  else if (burstHTML) parts.push(burstHTML + '.');
  else if (left) parts.push(left + '.');
  return { html: parts.join(' '), without };
}

/* ---------- other sub-pages ---------- */

// "2,985 visitors on /blog/new, new this period. 6 in 10 first visits came from Hacker News."
// flows: the visits that landed on this page, by source.
export function pageStory(totals, flows, label) {
  const c = totals.cur.visitors, p = totals.prev.visitors, pct = pctChange(c, p);
  let s = `<b>${fmtInt(c)}</b> visitors on ${esc(label)}`;
  s += pct == null ? ', new this period' : pct ? `, <b>${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}%</b>` : ', about the same as before';
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
    if (best && all && rate(best) >= all * 2) s += `; <b>${esc(labelOf('referrer', best.key))}</b> did best, ${fmtRate(rate(best))}`;
  }
  return s + '.';
}

const GOAL_LIKE = /^\/(sign-?up|register|thank|checkout|subscribe|contact|demo|trial|get-started)/i;
// The busiest page that looks like a goal, to offer as one when none is set.
export function suggestGoal(rows) {
  return rows.filter(r => GOAL_LIKE.test(r.key)).sort((a, b) => b.value - a.value)[0]?.key ?? null;
}

/* ---------- keywords ---------- */

// A word's change, unless too few used it to call it a trend. any: the list had words before, so "new" means something.
function wordChange(r, any) {
  if (r.visitors < 20 || (r.prev && r.prev < 10)) return '';
  if (!r.prev) return any ? ', new this period' : '';
  const x = r.visitors / r.prev, pct = Math.round((x - 1) * 100);
  return x >= 2 ? `, ${Math.round(x)}× more than before` : Math.abs(pct) >= 15 ? `, ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}%` : '';
}

// "People searched your site for pricing most, 3× more than before." Then the ads' top word.
export function keywordsStory({ site, paid }) {
  const say = (list, few, most) => {
    const r = list[0], w = `<b>${esc(r.key)}</b>`;
    return r.visitors < 20 ? few(w) : most(w) + wordChange(r, list.some(x => x.prev)) + '.';
  };
  const parts = [];
  if (site.length) parts.push(say(site, w => `A few people searched your site, most often for ${w}.`, w => `People searched your site for ${w} most`));
  if (paid.length) parts.push(say(paid, w => `A few visitors came from your ads; ${w} brought the most.`, w => `Of the words your ads paid for, ${w} brought the most visitors`));
  return parts.join(' ') || 'No search words yet.';
}

// What an empty list tells the owner to do.
export const KEYWORDS_EMPTY = {
  site: 'No searches yet. Lede reads the words after ?q= or ?s= in your search page’s address, so a search box that puts them there shows up here.',
  paid: 'No ad words yet. Add utm_term={keyword} to your ads’ links, and the words people searched to see the ad show up here.',
};
