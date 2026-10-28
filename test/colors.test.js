import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The dashboard's colour tokens, light and dark, read from its first two :root blocks.
const css = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const tokens = block => Object.fromEntries([...block.matchAll(/--([\w-]+):(#[0-9A-Fa-f]{6})/g)].map(m => [m[1], m[2]]));
const light = tokens(/:root\{([\s\S]*?)\n\}/.exec(css)[1]), dark = { ...light, ...tokens(/prefers-color-scheme:dark\)\{:root\{([\s\S]*?)\}\}/.exec(css)[1]) };
const lum = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };

test('names on a solid page block, the treemap\'s named page, read at AA in both themes', () => {
  for (const [theme, t] of [['light', light], ['dark', dark]]) {
    const r = contrast(t.page, t['on-page']);
    assert.ok(r >= 4.5, `${theme}: ${t['on-page']} on ${t.page} is ${r.toFixed(2)}:1`);
  }
});
