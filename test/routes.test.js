import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viewToUrl, urlToView } from '../public/routes.js';

const round = (view, opts) => {
  const url = new URL(viewToUrl(view, opts), 'https://lede.test');
  return urlToView(url.pathname, url.search);
};

test('every view has its own address', () => {
  assert.equal(viewToUrl(null), '/');
  assert.equal(viewToUrl({ v: 'overview' }), '/overview');
  assert.equal(viewToUrl({ v: 'bounce' }), '/bounce');
  assert.equal(viewToUrl({ v: 'online' }), '/online');
  assert.equal(viewToUrl({ v: 'sources' }), '/sources');
  assert.equal(viewToUrl({ v: 'pages' }), '/pages');
  assert.equal(viewToUrl({ v: 'events' }), '/events');
  assert.equal(viewToUrl({ v: 'filter', f: { referrer: 'google.com' } }), '/sources/google.com');
  assert.equal(viewToUrl({ v: 'filter', f: { referrer: '' } }), '/sources/direct');
  assert.equal(viewToUrl({ v: 'filter', f: { channel: 'ai' } }), '/channels/ai');
  assert.equal(viewToUrl({ v: 'filter', f: { path: '/migration' } }), '/page/migration');
  assert.equal(viewToUrl({ v: 'filter', f: { path: '/' } }), '/page/');
  assert.equal(viewToUrl({ v: 'filter', f: { path: '/docs/install' } }), '/page/docs/install');
  assert.equal(viewToUrl({ v: 'filter', f: { path: '/migration', referrer: 'google.com' } }), '/page/migration?referrer=google.com');
});

test('the period and site ride along only when they differ from the default', () => {
  assert.equal(viewToUrl({ v: 'bounce' }, { days: 7 }), '/bounce?days=7');
  assert.equal(viewToUrl({ v: 'bounce' }, { days: 30 }), '/bounce');
  assert.equal(viewToUrl(null, { days: 7, site: 'b.example' }), '/?days=7&site=b.example');
});

test('an address opens the view it names, so a refresh lands in the same place', () => {
  const views = [null, { v: 'overview' }, { v: 'bounce' }, { v: 'online' }, { v: 'sources' }, { v: 'pages' }, { v: 'events' },
    { v: 'filter', f: { referrer: 'google.com' } }, { v: 'filter', f: { referrer: '' } }, { v: 'filter', f: { channel: 'ai' } },
    { v: 'filter', f: { path: '/' } }, { v: 'filter', f: { path: '/a b/ñ' } }, { v: 'filter', f: { path: '/migration', referrer: 'google.com' } }];
  for (const view of views) assert.deepEqual(round(view, { days: 7, site: 's.example' }), { view, days: 7, site: 's.example' }, JSON.stringify(view));
  assert.deepEqual(urlToView('/', ''), { view: null, days: null, site: null });
});

test('a site with accents reads as typed in the address and opens the same site', () => {
  assert.equal(viewToUrl(null, { site: 'xn--meique-xwa.com.ar' }), '/?site=me%C3%B1ique.com.ar');
  assert.equal(urlToView('/', '?site=me%C3%B1ique.com.ar').site, 'xn--meique-xwa.com.ar');
  assert.equal(urlToView('/', '?site=xn--meique-xwa.com.ar').site, 'xn--meique-xwa.com.ar');
});

test('an unknown address opens home', () => {
  assert.deepEqual(urlToView('/nope/x', ''), { view: null, days: null, site: null });
  assert.deepEqual(urlToView('/bounce', '?days=99'), { view: { v: 'bounce' }, days: null, site: null });
});
