import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build, HEADER } from '../scripts/tracker.mjs';

const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

test('public/t.js is what npm run tracker makes from src/tracker.js, so the two never drift', () => {
  assert.equal(read('public/t.js'), build(read('src/tracker.js')), 'run npm run tracker');
});

test('public/t.js says where it comes from and how to make it again', () => {
  const first = read('public/t.js').split('\n')[0];
  assert.equal(first, HEADER);
  assert.match(first, /src\/tracker\.js/);
  assert.match(first, /npm run tracker/);
});

test('the readable tracker keeps its comments; the one sites load has only the header', () => {
  const comments = f => read(f).split('\n').filter(l => l.trim().startsWith('//')).length;
  assert.ok(comments('src/tracker.js') >= 30);
  assert.equal(comments('public/t.js'), 1);
  assert.ok(!read('public/t.js').includes('/*'));
});

test('minifying leaves strings and regexes that look like comments alone', () => {
  const out = build("(function () { var a = '// not a comment', b = /\\/\\/x/; window.x = a + b; })();");
  assert.ok(out.includes('"// not a comment"'));
  assert.ok(out.includes('/\\/\\/x/'));
});

test('minifying writes nothing the oldest browsers Lede counts can\'t run', () => {
  const out = build('(function () { window.x = window.a?.b ?? 1; })();');
  assert.ok(!out.includes('?.') && !out.includes('??'), out);
});
