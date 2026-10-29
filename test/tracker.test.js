import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Every test runs on the readable tracker and on public/t.js, the minified copy that sites receive,
// so minifying it can't change what it does.
const FILES = ['src/tracker.js', 'public/t.js'];
let SOURCE;
const test = (name, fn) => {
  for (const file of FILES) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    nodeTest(`${name} [${file}]`, () => { SOURCE = source; return fn(); });
  }
};

// Runs the tracker against a stand-in page and returns what it sent, plus handles to navigate.
// sent holds the page views; events holds everything else (engagement, outbound links, downloads).
// marked gives the elements an endless page marks with data-lede-page: path → [top, height] in the document.
// storage is the tab's sessionStorage, shared to load another page in the same tab. vitals gives the page
// a PerformanceObserver, whose entries perf() hands to the tracker, and queue() leaves for it to take.
// activation is when a prerendered page was opened.
function page(href, { referrer = '', prerendering = false, hidden = false, ignore = false, engagement, height = 2000, marked = {}, now = Date.parse('2026-10-05T10:50:00Z'), storage = new Map(), vitals = false, activation = 0 } = {}) {
  const sent = [], events = [], beacons = [], requests = [], listeners = {}, docListeners = {}, timers = [], observers = {}, queued = {};
  let focused = true;
  const clock = { now };
  let location = new URL(href);
  const on = map => (type, fn) => { (map[type] ||= []).push(fn); };
  const fire = (map, type, e = {}) => (map[type] || []).slice().forEach(fn => fn(e));
  const window = {
    document: {
      currentScript: { src: 'https://lede.test/t.js', getAttribute: k => (k === 'data-engagement' ? engagement ?? null : null) },
      referrer, prerendering, visibilityState: hidden ? 'hidden' : 'visible',
      hasFocus: () => focused, documentElement: { scrollHeight: height },
      querySelector: selector => {
        const box = marked[selector.match(/^\[data-lede-page="(.*)"\]$/)?.[1]];
        return box ? { getBoundingClientRect: () => ({ top: box[0] - window.scrollY, height: box[1] }) } : null;
      },
      addEventListener: on(docListeners),
      removeEventListener: (type, fn) => { docListeners[type] = (docListeners[type] || []).filter(f => f !== fn); },
    },
    navigator: { sendBeacon: (url, body) => { beacons.push(url); record(url, body); return true; } },
    fetch: (url, init) => { requests.push(init); record(url, init.body); return Promise.resolve({ status: 204 }); },
    scrollY: 0, innerHeight: 800,
    localStorage: { getItem: k => (ignore && k === 'lede_ignore' ? '1' : null) },
    Date: { now: () => clock.now },
    Math,
    setTimeout: (fn, ms) => timers.push({ at: clock.now + ms, fn }),
    history: { pushState(_, __, url) { location = new URL(url, location); }, replaceState(_, __, url) { location = new URL(url, location); } },
    sessionStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    addEventListener: on(listeners),
    URL,
    PerformanceObserver: vitals ? class {
      constructor(cb) { this.cb = cb; }
      observe(o) { this.type = o.type; observers[o.type] = this.cb; }
      takeRecords() { return (queued[this.type] || []).splice(0); }
    } : undefined,
    performance: { getEntriesByType: type => (type === 'navigation' ? [{ activationStart: activation }] : []) },
  };
  if (!vitals) delete window.PerformanceObserver;
  // A request can carry several events.
  const record = (url, body) => { for (const e of [].concat(JSON.parse(body))) { const b = { to: url, ...e }; (b.t ? events : sent).push(b); } };
  Object.defineProperty(window, 'location', { get: () => location });
  window.window = window;
  vm.runInNewContext(SOURCE, window);
  // A click on a link, as the browser reports it: the event's target is something inside the link.
  const click = (link, e = { type: 'click', button: 0 }) => fire(docListeners, e.type, { ...e, target: { closest: () => link && { href: new URL(link, location).href } } });
  return {
    sent,
    events,
    beacons,
    requests,
    click,
    push: url => window.history.pushState({}, '', url),
    replace: url => window.history.replaceState(null, '', url),
    jump: hash => { location = new URL(hash, location); fire(listeners, 'popstate'); },
    restore: () => fire(listeners, 'pageshow', { persisted: true }),
    open: () => { window.document.prerendering = false; fire(docListeners, 'prerenderingchange'); },
    show: () => { window.document.visibilityState = 'visible'; fire(listeners, 'visibilitychange'); fire(docListeners, 'visibilitychange'); },
    hide: () => { window.document.visibilityState = 'hidden'; fire(listeners, 'visibilitychange'); fire(docListeners, 'visibilitychange'); },
    leave: () => fire(listeners, 'pagehide'),
    blur: () => { focused = false; fire(listeners, 'blur'); },
    focus: () => { focused = true; fire(listeners, 'focus'); },
    scroll: y => { window.scrollY = y; fire(listeners, 'scroll'); },
    // Runs the timers that come due on the way, in order, each at its own time.
    wait: ms => {
      const until = clock.now + ms;
      for (let next; (next = timers.filter(t => t.at <= until).sort((a, b) => a.at - b.at)[0]);) {
        timers.splice(timers.indexOf(next), 1);
        clock.now = next.at;
        next.fn();
      }
      clock.now = until;
    },
    resize: height => { window.document.documentElement.scrollHeight = height; },
    key: () => fire(listeners, 'keydown'),
    perf: (type, entries) => observers[type]?.({ getEntries: () => entries }),
    queue: (type, entries) => { (queued[type] ||= []).push(...entries); },
    observed: () => Object.keys(observers).sort(),
    storage,
  };
}

test('tracker: one view per page, not per anchor jump', () => {
  const p = page('https://example.com/docs');
  p.jump('#install');
  p.jump('#usage');
  assert.equal(p.sent.length, 1);
  p.push('/docs/next');
  assert.equal(p.sent.length, 2);
  assert.equal(p.sent[1].u, 'https://example.com/docs/next');
});

test('tracker: a prerendered page counts only once it is opened', () => {
  const p = page('https://example.com/', { prerendering: true });
  assert.equal(p.sent.length, 0);
  p.open();
  assert.equal(p.sent.length, 1);
});

test('tracker: a page restored by the back button counts again', () => {
  const p = page('https://example.com/');
  p.restore();
  assert.equal(p.sent.length, 2);
});

test('tracker: coming from the www host is the same site, not a new source', () => {
  const p = page('https://example.com/a', { referrer: 'https://news.ycombinator.com/' });
  assert.equal(p.sent[0].r, 'https://news.ycombinator.com/');
  const q = page('https://example.com/b', { referrer: 'https://www.example.com/a' });
  assert.equal(q.sent[0].r, '');
});

test('tracker: sends the referring address without its #, and the landing page\'s tags', () => {
  const p = page('https://example.com/a?utm_source=news&token=secret&gclid=1&q=owls', { referrer: 'https://news.ycombinator.com/item?id=4242#c1' });
  assert.deepEqual([p.sent[0].r, p.sent[0].l], ['https://news.ycombinator.com/item?id=4242', '?utm_source=news&gclid=1']);
  assert.equal(p.sent[0].u, 'https://example.com/a?utm_source=news&token=secret&gclid=1&q=owls', 'the page itself is the server\'s to clean');
  assert.equal(page('https://example.com/', { referrer: 'android-app://com.google.android.gm/' }).sent[0].r, 'android-app://com.google.android.gm/');
  assert.equal(page('https://example.com/?li_fat_id=1&twclid=2&dclid=3&fbclid=4&source=pdf&ref=hn').sent[0].l, '?li_fat_id=1&twclid=2&dclid=3&fbclid=4&source=pdf&ref=hn');
  assert.equal(page('https://example.com/?mc_cid=a&mc_eid=b&_hsenc=c&_hsmi=d&via=e&igshid=f&yclid=g&srsltid=h').sent[0].l, '?mc_cid=a&mc_eid=b&_hsenc=c&_hsmi=d&via=e&igshid=f&yclid=g&srsltid=h', 'email tools’ and other sites’ tags too');
  assert.equal(page('https://example.com/?q=owls&utm_medium=email').sent[0].l, '&utm_medium=email', 'the server reads it as a query all the same');
  assert.deepEqual([page('https://example.com/?q=owls').sent[0].l, page('https://example.com/').sent[0].r], ['', '']);
});

test('tracker: a link within the site that carries tags doesn\'t replace where the visit came from', () => {
  const storage = new Map();
  page('https://example.com/a', { referrer: 'https://news.ycombinator.com/', storage });
  const next = page('https://example.com/b?ref=footer', { referrer: 'https://example.com/a', storage });
  assert.deepEqual([next.sent[0].r, next.sent[0].l], ['https://news.ycombinator.com/', '']);
  const first = page('https://example.com/b?utm_source=news', { referrer: 'https://example.com/a' });
  assert.equal(first.sent[0].l, '?utm_source=news', 'a tab with no source yet takes the tags');
  const elsewhere = page('https://example.com/c?utm_source=mail', { storage });
  assert.deepEqual([elsewhere.sent[0].r, elsewhere.sent[0].l], ['', '?utm_source=mail'], 'tags from outside the site start afresh');
});

test('tracker: posts to /lede, not the blocklisted /api/event', () => {
  assert.equal(page('https://example.com/').sent[0].to, 'https://lede.test/lede');
});

test('tracker: a tab opened in the background counts once it is looked at', () => {
  const p = page('https://example.com/', { hidden: true });
  assert.equal(p.sent.length, 0);
  p.show();
  p.show();
  assert.equal(p.sent.length, 1);
});

test('tracker: a visit keeps the hour it started until half an hour passes without a page', () => {
  const p = page('https://example.com/a', { engagement: 'false' });
  const started = Date.parse('2026-10-05T10:00:00Z');
  p.wait(20 * 60e3); p.push('/b');
  p.wait(29 * 60e3); p.push('/c');
  p.hide(); p.wait(31 * 60e3); p.show(); p.push('/d');
  assert.deepEqual(p.sent.map(s => s.h), [started, started, started, Date.parse('2026-10-05T12:10:00Z')], 'the next visit starts on its minute, so another in the same hour stays apart');
});

test('tracker: each page view says where it falls in its visit, up to 3', () => {
  const p = page('https://example.com/a', { engagement: 'false' });
  for (const path of ['/b', '/c', '/d']) { p.wait(60e3); p.push(path); }
  p.hide(); p.wait(40 * 60e3); p.show(); p.push('/e');
  assert.deepEqual(p.sent.map(s => s.k), [1, 2, 3, 3, 1]);
  const storage = new Map();
  page('https://example.com/a', { storage });
  assert.equal(page('https://example.com/b', { storage }).sent[0].k, 2, 'counted across page loads in the tab');
  assert.equal(page('https://example.com/b').sent[0].k, 1, 'a new tab is a new count');
  assert.equal(page('https://example.com/b', { referrer: 'https://www.example.com/a' }).sent[0].k, 3,
    'a new tab opened from a link on the site carries on that visit, so it adds no visit or bounce');
  assert.equal(page('https://example.com/b', { referrer: 'https://news.ycombinator.com/' }).sent[0].k, 1);
});

test('tracker: a visit carries on while someone reads one page for long, and its pings say so', () => {
  const p = page('https://example.com/a');
  for (let i = 0; i < 4; i++) { p.wait(10 * 60e3); p.scroll(100 * (i + 1)); }
  p.push('/b');
  assert.equal(p.sent[1].h, p.sent[0].h, '40 minutes on one page, still showing, is still the visit');
  assert.ok(pings(p).every(e => e.h === p.sent[0].h));
});

test('tracker: pings stop after half an hour without a scroll, a click or a key, and start again with one', () => {
  const p = page('https://example.com/a');
  p.wait(60 * 60e3);
  assert.equal(pings(p).length, 9, 'up to 30 minutes after the page view');
  p.key();
  assert.equal(pings(p).length, 10, 'back at once');
  assert.equal(pings(p).at(-1).h, Date.parse('2026-10-05T11:50:00Z'), 'and, after an hour away, on a new visit');
  p.wait(9 * 60e3);
  assert.equal(pings(p).length, 13);
  p.push('/b');
  assert.equal(p.sent[1].h, pings(p).at(-1).h);
  assert.equal(p.sent[1].k, 1, 'the first page view of that visit');
});

test('tracker: sends with fetch keepalive, since tracker blockers drop sendBeacon pings', () => {
  const p = page('https://example.com/a');
  p.wait(2000);
  p.hide();
  assert.equal(p.sent.length, 1);
  assert.equal(p.events.length, 1);
  assert.deepEqual(p.beacons, []);
  assert.ok(p.requests.every(r => r.method === 'POST' && r.keepalive === true));
});

test('tracker: localStorage.lede_ignore leaves your own visits out', () => {
  assert.equal(page('https://example.com/', { ignore: true }).sent.length, 0);
});

test('tracker: a page view sends its totals each time its tab is hidden, so reading after coming back counts', () => {
  const p = page('https://example.com/docs');
  p.wait(4000); p.scroll(700); p.scroll(200);
  p.hide();
  p.show(); p.wait(5000); p.hide(); p.leave();
  assert.deepEqual(engaged(p).map(e => [e.u, e.e, e.s, e.x]), [['https://example.com/docs', 4000, 75, 1], ['https://example.com/docs', 9000, 75, 1]],
    'closing the tab right after hiding it has nothing new to say');
  assert.equal(engaged(p)[0].h, p.sent[0].h, 'the visit is the page view\'s');
  assert.ok(engaged(p).every(e => e.v === p.sent[0].v), 'and so is the view, which the server keeps the largest of');
  assert.equal(p.sent[0].v, Date.parse('2026-10-05T10:50:00Z'));
});

test('tracker: flicking between tabs sends no more totals until there is something new to say', () => {
  const p = page('https://example.com/docs');
  p.wait(4000); p.hide();
  for (let i = 0; i < 3; i++) { p.show(); p.wait(900); p.hide(); }
  assert.equal(engaged(p).length, 1, '3 seconds more, a deeper scroll or a new Web Vital');
  p.show(); p.scroll(500); p.hide();
  assert.equal(engaged(p).length, 2);
  assert.equal(engaged(p)[1].s, 65);
});

test('tracker: engaged time stops while the window is in the background', () => {
  const p = page('https://example.com/');
  p.wait(2000); p.blur(); p.wait(60e3); p.focus(); p.wait(1500);
  p.push('/next');
  assert.equal(p.events.length, 1);
  assert.equal(p.events[0].e, 3500);
  assert.equal(p.events[0].u, 'https://example.com/', 'sent for the page being left, before the next view');
  assert.equal(p.sent.length, 2);
});

test('tracker: a glance under a second sends nothing, and data-engagement="false" turns it off', () => {
  const p = page('https://example.com/');
  p.wait(600); p.hide();
  assert.equal(p.events.length, 0);
  p.show(); p.wait(1200); p.leave();
  assert.equal(p.events.length, 1, 'coming back to the page keeps counting');
  const off = page('https://example.com/', { engagement: 'false' });
  off.wait(10e3); off.hide(); off.leave();
  assert.equal(off.events.length, 0);
  assert.equal(off.sent.length, 1);
});

test('tracker: replacing the address with another page is a view, as when an endless page scrolls into the next', () => {
  const p = page('https://example.com/chapter-1');
  p.wait(5000);
  p.replace('/chapter-2');
  p.wait(5000);
  assert.deepEqual(p.sent.map(s => s.u), ['https://example.com/chapter-1', 'https://example.com/chapter-2']);
  assert.deepEqual([p.events[0].t, p.events[0].u], ['engagement', 'https://example.com/chapter-1'], 'the chapter left behind was read');
  p.replace('/chapter-1');
  p.wait(5000);
  assert.equal(p.sent.length, 3, 'scrolling back up to read it again');
});

test('tracker: flicking back and forth across the border between two chapters is not a view each time', () => {
  const p = page('https://example.com/chapter-1');
  for (let i = 0; i < 3; i++) {
    p.replace('/chapter-2'); p.wait(1000);
    p.replace('/chapter-1'); p.wait(1000);
  }
  p.wait(60e3);
  assert.equal(p.sent.length, 1, 'it settled back where it was');
  p.replace('/chapter-2'); p.wait(4000);
  assert.equal(p.sent.length, 1, 'not yet: 5 seconds on the new page');
  p.replace('/chapter-3'); p.wait(5000);
  assert.deepEqual(p.sent.map(s => s.u), ['https://example.com/chapter-1', 'https://example.com/chapter-3'], 'only where it came to rest');
  p.replace('/chapter-4'); p.replace('/chapter-4?q=x'); p.wait(5000);
  assert.equal(p.sent.at(-1).u, 'https://example.com/chapter-4?q=x', 'tidying the new address on the way still counts it');
});

test('tracker: a tab not looked at yet counts the page it shows once it is, not each address it went through', () => {
  const p = page('https://example.com/a', { hidden: true });
  p.replace('/b');
  assert.equal(p.sent.length, 0);
  p.show();
  assert.deepEqual(p.sent.map(s => s.u), ['https://example.com/b']);
});

test('tracker: replacing only the query or the hash is the same page', () => {
  const p = page('https://example.com/?utm_source=news&q=a');
  p.replace('/');
  p.replace('/?q=b');
  p.replace('/?q=b#results');
  assert.equal(p.sent.length, 1, 'sites tidy the address in place, as when dropping utm tags after landing');
  p.jump('#results');
  assert.equal(p.sent.length, 1, 'the tidied address is the page now, so an anchor jump after it is not a view');
  p.push('/?q=c');
  assert.equal(p.sent.length, 2, 'a pushed query is still a new view');
});

const pings = p => p.events.filter(e => e.t === 'ping');

test('tracker: a visible tab says it is still here every 3 minutes, so a long read stays here now', () => {
  const p = page('https://example.com/docs', { referrer: 'https://news.ycombinator.com/' });
  p.wait(2 * 60e3);
  assert.equal(pings(p).length, 0);
  p.wait(60e3);
  assert.equal(pings(p).length, 1);
  assert.deepEqual([pings(p)[0].u, pings(p)[0].r, pings(p)[0].h], ['https://example.com/docs', 'https://news.ycombinator.com/', p.sent[0].h]);
  p.wait(6 * 60e3);
  assert.equal(pings(p).length, 3);
  assert.equal(p.sent.length, 1, 'a ping is not another page view');
});

test('tracker: a window in the background is still here while its tab shows; a hidden tab is not', () => {
  const p = page('https://example.com/');
  p.blur(); p.wait(3 * 60e3);
  assert.equal(pings(p).length, 1, 'reading in one window while another has focus');
  p.hide(); p.wait(10 * 60e3);
  assert.equal(pings(p).length, 1);
  p.show();
  assert.equal(pings(p).length, 2, 'coming back after a while says so at once');
  p.wait(3 * 60e3);
  assert.equal(pings(p).length, 3);
});

test('tracker: a tab whose hiding was sent pings as it shows again; flicking away and back doesn\'t, and each ping names the page now showing', () => {
  const p = page('https://example.com/a');
  p.wait(60e3); p.hide(); p.wait(10e3); p.show();
  assert.equal(pings(p).length, 1, 'it left "here now" as it was hidden, so it says it is back');
  p.wait(500); p.hide(); p.wait(1000); p.show();
  assert.equal(pings(p).length, 1, 'nothing was sent as it was hidden, and it was seen less than 3 minutes ago');
  p.push('/b');
  p.wait(3 * 60e3);
  assert.deepEqual(pings(p).map(e => e.u), ['https://example.com/a', 'https://example.com/b'], 'the clock starts again with each page view');
  p.replace('/c');
  p.wait(5000 + 3 * 60e3);
  assert.equal(pings(p).at(-1).u, 'https://example.com/c');
});

test('tracker: a prerendered or background tab pings only once it is looked at', () => {
  const p = page('https://example.com/', { hidden: true });
  p.wait(10 * 60e3);
  assert.equal(p.events.length, 0);
  p.show();
  p.wait(3 * 60e3);
  assert.equal(pings(p).length, 1);
});

test('tracker: a page that fits on screen is read to the end without scrolling', () => {
  const p = page('https://example.com/', { height: 600 });
  p.wait(2000); p.leave();
  assert.equal(p.events[0].s, 100);
});

test('tracker: a single-page app\'s next page doesn\'t change how far the last one was scrolled', () => {
  const p = page('https://example.com/long', { height: 4000 });
  p.wait(3000); p.scroll(600);
  p.resize(1000);
  p.push('/short');
  assert.equal(p.events[0].s, 35, 'measured on the long page, not as 1400px of a 1000px page');
  p.wait(2000); p.leave();
  assert.equal(p.events[1].s, 100, 'the short page fits on screen, which a second after it opens shows');
});

test('tracker: a page that fits on screen is read to the end, even when a single-page app moves on', () => {
  const p = page('https://example.com/', { height: 600 });
  p.wait(2000);
  p.resize(5000);
  p.push('/next');
  assert.equal(p.events[0].s, 100);
});

test('tracker: an endless page that marks each page is measured within it, not the whole document', () => {
  // Two 3000px chapters in a 9000px document, with a third already added below.
  const marked = { '/chapter-1': [0, 3000], '/chapter-2': [3000, 3000] };
  const p = page('https://example.com/chapter-1', { height: 9000, marked });
  p.wait(3000); p.scroll(1600);
  p.leave();
  assert.equal(p.events[0].s, 80, 'the bottom of the window is 2400px into a 3000px chapter, not 27% of the document');
});

test('tracker: a chapter scrolled past into the next one was read to the end, and the next starts at its own top', () => {
  const marked = { '/chapter-1': [0, 3000], '/chapter-2': [3000, 3000] };
  const p = page('https://example.com/chapter-1', { height: 9000, marked });
  p.wait(3000); p.scroll(2900);
  p.replace('/chapter-2');
  p.wait(5000);
  assert.equal(p.events[0].s, 100);
  p.scroll(3700); p.wait(2000);
  p.leave();
  assert.equal(p.events[1].s, 50, 'half of the second chapter, not 50% of the document from its top');
});

test('tracker: scrolling up into the chapter before leaves the one being read where it got to', () => {
  // The chapter before was added above, so the one the reader landed on now starts 3000px down.
  const marked = { '/chapter-1': [0, 3000], '/chapter-2': [3000, 3000] };
  const p = page('https://example.com/chapter-2', { height: 6000, marked });
  p.scroll(3700); p.wait(3000);
  p.scroll(2000);
  p.replace('/chapter-1');
  p.wait(5000);
  assert.equal(p.events[0].s, 50);
});

test('tracker: clicks on links to other sites, on files, and on email, phone and message links are sent, without the #', () => {
  const p = page('https://example.com/docs', { referrer: 'https://news.ycombinator.com/' });
  p.click('https://github.com/acme/repo?token=secret#readme');
  p.click('/files/guide.PDF?v=2');
  p.click('https://www.example.com/pricing');
  p.click('mailto:hi@example.com');
  p.click(null);
  p.click('https://github.com/', { type: 'auxclick', button: 2 });
  p.click('https://github.com/', { type: 'auxclick', button: 1 });
  assert.deepEqual(p.events.map(e => [e.t, e.o]), [
    ['outbound', 'https://github.com/acme/repo?token=secret'],
    ['download', 'https://example.com/files/guide.PDF?v=2'],
    ['outbound', 'mailto:hi@example.com'],
    ['outbound', 'https://github.com/'],
  ]);
  assert.equal(p.events[0].u, 'https://example.com/docs');
  assert.equal(p.events[0].r, 'https://news.ycombinator.com/', 'credited to the visit\'s source');
});

const engaged = p => p.events.filter(e => e.t === 'engagement');

test('tracker: the engagement event carries the page view\'s Web Vitals', () => {
  const p = page('https://example.com/a', { vitals: true });
  assert.deepEqual(p.observed(), ['event', 'largest-contentful-paint', 'layout-shift']);
  p.perf('largest-contentful-paint', [{ startTime: 900 }, { startTime: 1834.6 }]);
  p.perf('event', [{ interactionId: 0, duration: 500 }, { interactionId: 7, duration: 120 }, { interactionId: 8, duration: 80 }]);
  // Two shifts in one burst, a smaller one later on its own, and one right after a tap, which doesn't count.
  p.perf('layout-shift', [{ startTime: 100, value: 0.05 }, { startTime: 500, value: 0.05 }, { startTime: 3000, value: 0.02 }, { startTime: 3200, value: 0.5, hadRecentInput: true }]);
  p.wait(2000); p.push('/b');
  assert.deepEqual([engaged(p)[0].lcp, engaged(p)[0].inp, engaged(p)[0].cls], [1834.6, 120, 100], 'CLS times 1000; the server rounds');
  p.perf('layout-shift', [{ startTime: 9000, value: 0.08 }, { startTime: 9500, value: 0.08 }]);
  p.wait(2000); p.leave();
  const next = engaged(p)[1];
  assert.deepEqual([next.lcp, next.inp, next.cls], [undefined, undefined, 160], 'a later view has no LCP, and its own INP and CLS');
  assert.ok(!('lcp' in next) && !('inp' in next), 'what wasn\'t measured is left out, not sent as null');
});

test('tracker: a page that never shifts sends a CLS of 0 where the browser watches for shifts', () => {
  const p = page('https://example.com/a', { vitals: true });
  p.wait(2000); p.push('/b');
  p.wait(2000); p.leave();
  assert.deepEqual(engaged(p).map(e => e.cls), [0, 0]);
});

test('tracker: no Web Vitals without engagement, and no LCP for a page that loaded out of sight', () => {
  assert.deepEqual(page('https://example.com/', { vitals: true, engagement: 'false' }).observed(), []);
  assert.deepEqual(page('https://example.com/', { vitals: true, hidden: true }).observed(), ['event', 'layout-shift']);
  assert.deepEqual(page('https://example.com/', { vitals: true, prerendering: true }).observed(), ['event', 'largest-contentful-paint', 'layout-shift'], 'a prerendered page counts from when it was opened');
  const old = page('https://example.com/');
  old.wait(2000); old.leave();
  assert.deepEqual(Object.keys(old.events[0]).sort(), ['e', 'h', 'l', 'r', 's', 't', 'to', 'u', 'v', 'x'], 'a browser without PerformanceObserver sends no Web Vitals');
});

test('tracker: a prerendered page\'s LCP counts from when it was opened', () => {
  const p = page('https://example.com/', { vitals: true, prerendering: true, activation: 1500 });
  p.perf('largest-contentful-paint', [{ startTime: 400 }]);
  p.open(); p.wait(2000); p.leave();
  assert.equal(engaged(p)[0].lcp, 0, 'drawn before it was opened: there at once');
  const q = page('https://example.com/', { vitals: true, prerendering: true, activation: 1500 });
  q.perf('largest-contentful-paint', [{ startTime: 2100 }]);
  q.open(); q.wait(2000); q.leave();
  assert.equal(engaged(q)[0].lcp, 600);
});

test('tracker: a tap the browser hasn\'t handed over yet still counts toward INP', () => {
  const p = page('https://example.com/', { vitals: true });
  p.perf('event', [{ interactionId: 1, duration: 120 }]);
  p.wait(2000);
  p.queue('event', [{ interactionId: 2, duration: 340 }]);
  p.hide();
  assert.equal(engaged(p)[0].inp, 340);
});

test('tracker: a burst of layout shifts doesn\'t carry into the next page of a single-page app', () => {
  const p = page('https://example.com/a', { vitals: true });
  p.perf('layout-shift', [{ startTime: 100, value: 0.05 }]);
  p.wait(2000); p.push('/b');
  p.perf('layout-shift', [{ startTime: 600, value: 0.05 }]);
  p.wait(2000); p.leave();
  assert.deepEqual(engaged(p).map(e => e.cls), [50, 50]);
});

test('tracker: a single-page app sends the page left behind and the next page view in one request', () => {
  const p = page('https://example.com/a');
  p.wait(2000);
  const before = p.requests.length;
  p.push('/b');
  assert.equal(p.requests.length, before + 1);
  const both = JSON.parse(p.requests.at(-1).body);
  assert.deepEqual(both.map(e => [e.t, e.u]), [['engagement', 'https://example.com/a'], [undefined, 'https://example.com/b']]);
  assert.equal(both[0].x, 1, 'the page left behind leaves "here now", and the next one comes in with it');
  p.wait(500); p.push('/c');
  assert.ok(!Array.isArray(JSON.parse(p.requests.at(-1).body)), 'a glance has nothing to send with it');
  p.wait(4000); p.hide(); p.show(); p.wait(500); p.push('/d');
  assert.deepEqual(JSON.parse(p.requests.at(-1).body).map(e => [e.t, e.e, e.x]), [['engagement', 4500, 1], [undefined, undefined, undefined]],
    'moving on says the page was left, even with little new since the tab was hidden');
});

test('tracker: a visit that just passed a Cloudflare challenge is a visit starting, not a page within one', () => {
  const p = page('https://example.com/a', { referrer: 'https://example.com/a?__cf_chl_tk=abc123' });
  assert.deepEqual([p.sent[0].r, p.sent[0].k], ['', 1]);
  assert.equal(page('https://example.com/b', { referrer: 'https://example.com/a?page=2' }).sent[0].k, 3, 'a link on the site still is');
});

test('tracker: pings carry the page view and its totals so far', () => {
  const p = page('https://example.com/a');
  p.wait(60e3); p.scroll(400);
  p.wait(2 * 60e3);
  assert.deepEqual([pings(p)[0].v, pings(p)[0].e, pings(p)[0].s], [p.sent[0].v, 3 * 60e3, 60]);
  const off = page('https://example.com/a', { engagement: 'false' });
  off.wait(3 * 60e3);
  assert.ok(!('e' in pings(off)[0]) && !('s' in pings(off)[0]));
});
