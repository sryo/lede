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
  assert.equal(viewToUrl({ v: 'overview' }, { days: 14 }), '/overview?days=14');
});

test('an address opens the view it names, so a refresh lands in the same place', () => {
  const views = [null, { v: 'overview' }, { v: 'bounce' }, { v: 'online' }, { v: 'sources' }, { v: 'pages' }, { v: 'events' },
    { v: 'filter', f: { referrer: 'google.com' } }, { v: 'filter', f: { referrer: '' } }, { v: 'filter', f: { channel: 'ai' } },
    { v: 'filter', f: { path: '/' } }, { v: 'filter', f: { path: '/a b/ñ' } }, { v: 'filter', f: { path: '/migration', referrer: 'google.com' } }];
  for (const view of views) assert.deepEqual(round(view, { days: 7, site: 's.example' }), { view, days: 7, back: 0, gap: null, site: 's.example' }, JSON.stringify(view));
  assert.deepEqual(urlToView('/', ''), { view: null, days: null, back: 0, gap: null, site: null });
});

test('a site with accents reads as typed in the address and opens the same site', () => {
  assert.equal(viewToUrl(null, { site: 'xn--meique-xwa.com.ar' }), '/?site=me%C3%B1ique.com.ar');
  assert.equal(urlToView('/', '?site=me%C3%B1ique.com.ar').site, 'xn--meique-xwa.com.ar');
  assert.equal(urlToView('/', '?site=xn--meique-xwa.com.ar').site, 'xn--meique-xwa.com.ar');
});

test('an unknown address opens home', () => {
  assert.deepEqual(urlToView('/nope/x', ''), { view: null, days: null, back: 0, gap: null, site: null });
  assert.deepEqual(urlToView('/bounce', '?days=99'), { view: { v: 'bounce' }, days: null, back: 0, gap: null, site: null });
  for (const d of ['6', '46', '12.5', 'x']) assert.equal(urlToView('/', `?days=${d}`).days, null, d);
  assert.equal(urlToView('/', '?days=12').days, 12);
});

test('an old /funnels link opens the Overview, where the funnels are', () => {
  assert.deepEqual(urlToView('/funnels', ''), { view: { v: 'overview' }, days: null, back: 0, gap: null, site: null });
});

test('a period that ended earlier, and a comparison the owner placed, are in the address', () => {
  assert.equal(viewToUrl({ v: 'overview' }, { days: 14, back: 3, gap: 28 }), '/overview?days=14&back=3&gap=28');
  assert.equal(viewToUrl(null, { days: 30, back: 0, gap: null }), '/', 'the defaults leave the address short');
  assert.deepEqual(round({ v: 'overview' }, { days: 14, back: 3, gap: 28 }), { view: { v: 'overview' }, days: 14, back: 3, gap: 28, site: null });
  // The period lies in the last 45 days, the comparison in the 90 kept and clear of it; a gap that is the default is none.
  assert.equal(urlToView('/', '?back=20').back, 0, '30 days back 20 reaches past the 45 days that know each day\'s source');
  assert.equal(urlToView('/', '?days=14&back=31').back, 31);
  assert.equal(urlToView('/', '?days=14&back=32').back, 0);
  assert.equal(urlToView('/', '?back=x').back, 0);
  assert.equal(urlToView('/', '?days=14&gap=13').gap, null, 'a comparison can\'t overlap the period');
  assert.equal(urlToView('/', '?days=14&gap=14').gap, null, 'the weeks that clear 14 days are 14: nothing to say');
  assert.equal(urlToView('/', '?days=30&gap=35').gap, null);
  assert.equal(urlToView('/', '?days=30&gap=30').gap, 30);
  assert.equal(urlToView('/', '?days=30&gap=60').gap, 60);
  assert.equal(urlToView('/', '?days=30&gap=61').gap, null, 'both periods stay inside the 90 days kept');
});
