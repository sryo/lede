import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutSeries, dayHint, thenLine, usualDay, todayHint, alignedGap, Span, prevStart, ribbonHint, sourceHint, pageHint, rowLabel } from '../public/story.js';

test('the comparison is the whole weeks that clear the period: 7 days on a week, 35 on 30 days, just before from 43', () => {
  assert.equal(alignedGap(7), 7);
  assert.equal(alignedGap(30), 35);
  assert.equal(alignedGap(13), 14);
  assert.equal(alignedGap(42), 42);
  assert.equal(alignedGap(43), 43, 'no whole week of 43 days fits in the 90 kept, so the days just before');
  assert.equal(alignedGap(45), 45);
  assert.equal(alignedGap(30, 25), 35, 'ending 25 days ago the 35 fit: 90 days exactly');
  assert.equal(alignedGap(30, 26), 30, 'one day further, 35 would reach past the 90 days kept');
});

test('a Span says the period and its comparison in dates once either is not the days just before', () => {
  const now = new Date(2026, 9, 31);
  const plain = Span(30, 0, 30, now);
  assert.equal(+plain, 30);
  assert.equal(`${plain}`, '30');
  assert.equal(plain.now, 'in the last 30 days');
  assert.equal(plain.before, 'the 30 days before');
  const aligned = Span(30, 0, 35, now);
  assert.equal(aligned.before, 'the 30 days to Sep 26');
  assert.equal(aligned.against, 'Aug 28 to Sep 26');
  assert.equal(aligned.range, 'Oct 2 to today');
  const earlier = Span(14, 3, 28, now);
  assert.equal(earlier.now, 'from Oct 15 to Oct 28');
  assert.equal(earlier.over, 'from Oct 15 to Oct 28');
  assert.equal(earlier.these, 'the 14 days to Oct 28');
  assert.equal(earlier.before, 'the 14 days to Sep 30');
  assert.equal(earlier.against, 'Sep 17 to Sep 30');
  assert.equal(earlier.range, 'Oct 15 to Oct 28');
});

test('today says its visitors so far and a usual whole day of its weekday, rounded, never a comparison', () => {
  assert.equal(todayHint('Fri, Oct 30', 560, 2729, 'Friday'), 'Fri, Oct 30: 560 visitors so far\na whole Friday here is usually about 2,700');
  assert.equal(todayHint('Fri, Oct 30', 1, 12345, 'Friday'), 'Fri, Oct 30: 1 visitor so far\na whole Friday here is usually about 12,000');
  assert.equal(todayHint('Fri, Oct 30', 560, null, 'Friday'), 'Fri, Oct 30: 560 visitors so far');
  assert.equal(todayHint('Fri, Oct 30', 0, 0, 'Friday'), 'Fri, Oct 30: 0 visitors so far');
});

test('a usual day is the median of the same weekday over the four weeks before today, and needs three of them', () => {
  // The four weeks before a Friday today, with each earlier Friday given and every other day 9; fewer Fridays, fewer weeks.
  const days = (...fridays) => { const a = Array(7 * fridays.length).fill(9).concat(5); fridays.forEach((v, k) => { a[a.length - 1 - 7 * (k + 1)] = v; }); return a; };
  assert.equal(usualDay(days(2577, 2680, 2778, 2834)), 2778);
  assert.equal(usualDay(days(100, 300, 200)), 200);
  assert.equal(usualDay(days(100, 300)), null);
  assert.equal(usualDay([5]), null);
});

test('a day says its visitors, and how it compares with the same day of the period before, named by its date', () => {
  assert.equal(dayHint('Mon, Oct 26', 1), 'Mon, Oct 26: 1 visitor');
  assert.equal(dayHint('Sun, Oct 11', 1748, 2303, 'Fri, Sep 11'), 'Sun, Oct 11: 1,748 visitors\n24% fewer than the 2,303 on Fri, Sep 11');
  assert.equal(dayHint('Mon, Oct 26', 1200, 3, 'Sat, Sep 26'), 'Mon, Oct 26: 1,200 visitors\n400 times the 3 on Sat, Sep 26');
});

test('a count compared with none, the same or nearly the same says so in words, never 0%', () => {
  assert.equal(thenLine(5, 0, 'Fri, Sep 11'), 'none on Fri, Sep 11');
  assert.equal(thenLine(0, 0, 'Fri, Sep 11'), 'none on Fri, Sep 11 either');
  assert.equal(thenLine(40, 40, 'Fri, Sep 11'), 'the same as the 40 on Fri, Sep 11');
  assert.equal(thenLine(2310, 2303, 'Fri, Sep 11'), 'about the same as the 2,303 on Fri, Sep 11');
  assert.equal(thenLine(0, 12, 'Fri, Sep 11'), '100% fewer than the 12 on Fri, Sep 11');
  assert.equal(thenLine(25, 12, 'Fri, Sep 11'), 'twice the 12 on Fri, Sep 11');
  assert.equal(thenLine(23, 12, 'Fri, Sep 11'), '92% more than the 12 on Fri, Sep 11');
});

test('a rate changes by points, and a day with no visits says so', () => {
  assert.equal(thenLine(.41, .38, 'Wed, Sep 3', 1), '3 points higher than the 38% on Wed, Sep 3');
  assert.equal(thenLine(.37, .38, 'Wed, Sep 3', 1), '1 point lower than the 38% on Wed, Sep 3');
  assert.equal(thenLine(.38, .38, 'Wed, Sep 3', 1), 'the same as the 38% on Wed, Sep 3');
  assert.equal(thenLine(.364, .366, 'Wed, Sep 3', 1), '1 point lower than the 37% on Wed, Sep 3', 'as the percentages read: 36% and 37%');
  assert.equal(thenLine(.381, .379, 'Wed, Sep 3', 1), 'the same as the 38% on Wed, Sep 3');
  assert.equal(thenLine(.41, null, 'Wed, Sep 3', 1), 'no visits on Wed, Sep 3');
  assert.equal(thenLine(null, null, 'Wed, Sep 3', 1), 'no visits on Wed, Sep 3 either');
  assert.equal(thenLine(null, .38, 'Wed, Sep 3', 1), '38% on Wed, Sep 3');
});

test('a ribbon names where it starts and ends and how many came that way', () => {
  assert.equal(ribbonHint('google.com', '/budismo-coreano', 2), 'google.com → /budismo-coreano: 2 visitors');
  assert.equal(ribbonHint('Direct', '/', 1), 'Direct → /: 1 visitor');
});

test('a source says its visitors and how that changed', () => {
  assert.equal(sourceHint('google.com', 5, 3), 'google.com: 5 visitors, 2 more than before');
  assert.equal(sourceHint('google.com', 1, 4), 'google.com: 1 visitor, 3 fewer than before');
  assert.equal(sourceHint('google.com', 4, 4), 'google.com: 4 visitors, the same as before');
  assert.equal(sourceHint('t.co', 2, 0), 't.co: 2 visitors, none before');
  assert.equal(sourceHint('google.com', 1, 4, 'visits'), 'google.com: 1 visit, 3 fewer than before');
});

test('a page says how many landed on it', () => {
  assert.equal(pageHint('/budismo-coreano', 1), '/budismo-coreano: 1 visitor landed here');
  assert.equal(pageHint('other pages', 7), 'other pages: 7 visitors landed here');
});

test('a list row read out says its share and its change, as the columns show them', () => {
  assert.equal(rowLabel('google.com', 1200, 1000, 10000), 'google.com: 1,200 visitors, 12% of the total, up 20%');
  assert.equal(rowLabel('/pricing', 90, 100, 1000), '/pricing: 90 visitors, 9% of the total, down 10%');
  assert.equal(rowLabel('/docs', 100, 100, 1000), '/docs: 100 visitors, 10% of the total, the same as before');
  assert.equal(rowLabel('t.co', 1, null, 10), 't.co: 1 visitor, 10% of the total, new');
  assert.equal(rowLabel('t.co', 3, undefined, 0), 't.co: 3 visitors, new');
});

test('a period is cut from the 45-day series: its days, and a window of the same length where the comparison sits', () => {
  const D = 45, all = Array.from({ length: 2 * D }, (_, i) => i), ser = { start: 1000, days: D,
    prev: { visitors: all.slice(0, D), visits: all.slice(0, D) }, cur: { visitors: all.slice(D), visits: all.slice(D) },
    top: all.slice(D).map(String), topVisitors: all.slice(D) };
  const s = cutSeries(ser, 7);
  assert.equal(s.days, 7);
  assert.equal(s.start, 1000 + 38 * 86400);
  assert.deepEqual(s.cur.visitors, [83, 84, 85, 86, 87, 88, 89]);
  assert.deepEqual(s.prev.visits, [76, 77, 78, 79, 80, 81, 82]);
  assert.deepEqual(s.top, ['83', '84', '85', '86', '87', '88', '89']);
  assert.deepEqual(cutSeries(ser, 45).prev.visitors, all.slice(0, 45));
  // The period ended 3 days ago and is compared with the days that ended 14 before that, so a day sits over its weekday.
  const m = cutSeries(ser, 7, 3, 14);
  assert.deepEqual(m.cur.visitors, [80, 81, 82, 83, 84, 85, 86]);
  assert.deepEqual(m.prev.visitors, [66, 67, 68, 69, 70, 71, 72]);
  assert.equal(m.start, 1000 + 35 * 86400, 'its first day, 35 days into the 45');
  assert.deepEqual(m.top, ['80', '81', '82', '83', '84', '85', '86']);
  assert.equal(m.back, 3);
  assert.equal(m.gap, 14);
  assert.equal(prevStart(m), m.start - 14 * 86400, 'the comparison starts gap days before the period');
  assert.equal(prevStart(cutSeries(ser, 7)), s.start - 7 * 86400, 'by default, the days just before');
});
