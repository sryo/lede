import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { strip, HEADER } from '../scripts/tracker.mjs';

const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

test('public/t.js is what npm run tracker makes from src/tracker.js, so the two never drift', () => {
  assert.equal(read('public/t.js'), strip(read('src/tracker.js')), 'run npm run tracker');
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
});

test('strip drops comment lines and blank lines, and nothing else', () => {
  const src = [
    '// A comment.',
    '(function () {',
    '',
    '  // Indented comment.',
    "  var a = '// not a comment', b = /\\/\\/x/;",
    '  var c = "x"; ',
    '   ',
    '})();',
    '',
  ].join('\n');
  assert.equal(strip(src), [
    HEADER,
    '(function () {',
    "  var a = '// not a comment', b = /\\/\\/x/;",
    '  var c = "x"; ',
    '})();',
    '',
  ].join('\n'));
});

test('strip refuses strings that run over lines, where a dropped line could be part of the string', () => {
  assert.throws(() => strip('var a;\nvar s = `x\n// y`;\n'), /line 2/);
  assert.throws(() => strip("var s = 'a\\\n// b';\n"), /line 1/);
});
