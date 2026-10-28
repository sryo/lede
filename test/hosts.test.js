import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayHost } from '../public/hosts.js';

test('a site with accents shows the way it was typed, not its punycode', () => {
  assert.equal(displayHost('xn--meique-xwa.com.ar'), 'meñique.com.ar');
  assert.equal(displayHost('www.xn--mnchen-3ya.de'), 'www.münchen.de');
  assert.equal(displayHost('xn--fiqs8s.cn'), '中国.cn');
  for (const label of ['meñique', 'münchen', 'españa', 'bücher', '中国', 'пример', 'café-au-lait']) {
    assert.equal(displayHost(new URL(`https://${label}.com`).hostname), `${label}.com`, label);
  }
});

test('plain hostnames and broken punycode stay as they are', () => {
  assert.equal(displayHost('example.com'), 'example.com');
  assert.equal(displayHost(''), '');
  assert.equal(displayHost('xn--.com'), 'xn--.com');
  assert.equal(displayHost('xn--zz-!!.com'), 'xn--zz-!!.com');
});
