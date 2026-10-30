import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayHint, thenLine, ribbonHint, sourceHint, pageHint, rowLabel } from '../public/story.js';

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
