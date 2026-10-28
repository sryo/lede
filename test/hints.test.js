import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayHint, ribbonHint, sourceHint, pageHint } from '../public/story.js';

test('a day says its visitors, and the same day of the period before when there is one', () => {
  assert.equal(dayHint('Mon 26 Oct', 1), 'Mon 26 Oct: 1 visitor');
  assert.equal(dayHint('Mon 26 Oct', 1200, 3, 30), 'Mon 26 Oct: 1,200 visitors · 30 days earlier: 3');
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
});

test('a page says how many landed on it', () => {
  assert.equal(pageHint('/budismo-coreano', 1), '/budismo-coreano: 1 visitor landed here');
  assert.equal(pageHint('other pages', 7), 'other pages: 7 visitors landed here');
});
