import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// public/_headers: a path line, then its indented header lines.
function rules() {
  const out = {};
  let path;
  for (const line of readFileSync(new URL('../public/_headers', import.meta.url), 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { path = line.trim(); out[path] = {}; continue; }
    const i = line.indexOf(':');
    out[path][line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

test('browsers keep the tracker for a while, but not forever', () => {
  const cc = rules()['/t.js']?.['cache-control'];
  assert.ok(cc, '/t.js has no Cache-Control rule');
  const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1]);
  assert.ok(maxAge >= 300 && maxAge <= 86400, `max-age ${maxAge} is outside 300 to 86400`);
  assert.ok(!/immutable/.test(cc), 'the tracker URL has no fingerprint, so it must not be immutable');
});

test('the font rule is unchanged', () => {
  assert.equal(rules()['/weepeople.woff2']?.['cache-control'], 'public, max-age=31536000, immutable');
});
