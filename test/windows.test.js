import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitWindows, windowSteps } from '../public/story.js';

// The strip holds 90 days, index 89 being today. ae is the period's last day, L its length and off how many days before
// its end the comparison ended (the comparison's last day is ae - off).
const N = 90;

test('the period can go back until its comparison reaches the first day kept', () => {
  assert.deepEqual(fitWindows({ L: 30, ae: 70, off: 35 }), { L: 30, ae: 70, off: 35 }, 'well past 45 days ago');
  assert.equal(fitWindows({ L: 30, ae: 59, off: 30 }).ae, 59, 'the comparison just before it starts on the first day');
  assert.equal(fitWindows({ L: 30, ae: 40, off: 30 }).ae, 59, 'no further: both windows are 30 days and 60 is all there is');
  assert.equal(fitWindows({ L: 7, ae: 3, off: 7 }).ae, 13);
});

test('a period that goes back keeps the comparison whole weeks clear of it, as far as they fit', () => {
  assert.equal(fitWindows({ L: 30, ae: 89, off: 0 }).off, 35);
  assert.equal(fitWindows({ L: 30, ae: 84, off: 0 }).off, 35, 'ended 5 days ago: 5 + 35 + 30 is 70 of the 90');
  assert.equal(fitWindows({ L: 30, ae: 64, off: 0 }).off, 35, 'ended 25 days ago: 25 + 35 + 30 is exactly the 90');
  assert.equal(fitWindows({ L: 30, ae: 63, off: 0 }).off, 30, 'one day further, 35 would start before the first day kept: just before');
});

test('moving the period leaves the comparison where it is, pushed ahead only when they would collide', () => {
  assert.equal(fitWindows({ L: 30, ae: 85, off: 35, pin: 54 }).off, 31, 'the comparison ended on day 54 and still does');
  assert.equal(fitWindows({ L: 30, ae: 80, off: 35, pin: 54 }).off, 30, 'it would overlap the period, so it sits just before it');
  assert.equal(fitWindows({ L: 30, ae: 75, off: 35, pin: 54 }).off, 30);
  assert.equal(fitWindows({ L: 30, ae: 60, off: 35, pin: 54 }).off, 30, 'and stays clear of the first day: the period stops where it fits');
  assert.equal(fitWindows({ L: 30, ae: 40, off: 35, pin: 54 }).ae, 59);
});

test('the comparison steps by whole weeks, just before the period or further, wherever it fits', () => {
  assert.deepEqual(windowSteps(30, 89), [30, 35, 42, 49, 56]);
  assert.deepEqual(windowSteps(30, 70), [30, 35]);
  assert.deepEqual(windowSteps(14, 89), [14, 21, 28, 35, 42, 49, 56, 63, 70]);
  assert.equal(fitWindows({ L: 30, ae: 89, off: 38, manual: true }).off, 35, 'dropped between two weeks, it lands on the nearer');
  assert.equal(fitWindows({ L: 30, ae: 89, off: 38, manual: true, alt: true }).off, 38, 'Alt places it anywhere');
  assert.equal(fitWindows({ L: 30, ae: 89, off: 20, manual: true, alt: true }).off, 30, 'but never overlapping the period');
});

test('a period is 7 to 45 days', () => {
  assert.equal(fitWindows({ L: 3, ae: 89, off: 7 }).L, 7);
  assert.equal(fitWindows({ L: 60, ae: 89, off: 60 }).L, 45);
});
