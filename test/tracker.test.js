import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Every test runs on the readable tracker and on public/t.js, the copy without comments that sites
// receive, so stripping it can't change what it does.
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
function page(href, { referrer = '', prerendering = false, hidden = false, ignore = false, engagement, height = 2000, marked = {}, now = Date.parse('2026-10-05T10:50:00Z'), noFetch = false } = {}) {
  const sent = [], events = [], beacons = [], requests = [], listeners = {}, docListeners = {}, storage = new Map(), timers = [];
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
    fetch: noFetch ? undefined : (url, init) => { requests.push(init); record(url, init.body); return Promise.resolve({ status: 204 }); },
    scrollY: 0, innerHeight: 800,
    localStorage: { getItem: k => (ignore && k === 'lede_ignore' ? '1' : null) },
    Date: { now: () => clock.now },
    Math,
    setTimeout: (fn, ms) => timers.push({ at: clock.now + ms, fn }),
    history: { pushState(_, __, url) { location = new URL(url, location); }, replaceState(_, __, url) { location = new URL(url, location); } },
    sessionStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    addEventListener: on(listeners),
    URL,
  };
  const record = (url, body) => { const b = { to: url, ...JSON.parse(body) }; (b.t ? events : sent).push(b); };
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
    show: () => { window.document.visibilityState = 'visible'; fire(docListeners, 'visibilitychange'); },
    hide: () => { window.document.visibilityState = 'hidden'; fire(docListeners, 'visibilitychange'); },
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
  const p = page('https://example.com/a');
  const started = Date.parse('2026-10-05T10:00:00Z');
  p.wait(20 * 60e3); p.push('/b');
  p.wait(29 * 60e3); p.push('/c');
  p.wait(31 * 60e3); p.push('/d');
  assert.deepEqual(p.sent.map(s => s.h), [started, started, started, started + 2 * 3600e3]);
});

test('tracker: sends with fetch keepalive, since tracker blockers drop sendBeacon pings', () => {
  const p = page('https://example.com/a');
  p.wait(2000);
  p.hide();
  assert.equal(p.sent.length, 1);
  assert.equal(p.events.length, 1);
  assert.deepEqual(p.beacons, []);
  assert.ok(p.requests.every(r => r.method === 'POST' && r.keepalive === true));
  const old = page('https://example.com/a', { noFetch: true });
  assert.equal(old.sent.length, 1);
  assert.equal(old.beacons.length, 1);
});

test('tracker: localStorage.lede_ignore leaves your own visits out', () => {
  assert.equal(page('https://example.com/', { ignore: true }).sent.length, 0);
});

test('tracker: one engagement event per page view, with the time it was read and how far down', () => {
  const p = page('https://example.com/docs');
  p.wait(4000); p.scroll(700); p.scroll(200);
  p.hide();
  p.show(); p.wait(5000); p.hide(); p.leave();
  assert.equal(p.events.length, 1);
  assert.deepEqual([p.events[0].t, p.events[0].u, p.events[0].e, p.events[0].s], ['engagement', 'https://example.com/docs', 4000, 75]);
  assert.equal(p.events[0].h, p.sent[0].h, 'the visit is the page view\'s');
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

test('tracker: flicking away and back doesn\'t ping again, and each ping names the page now showing', () => {
  const p = page('https://example.com/a');
  p.wait(60e3); p.hide(); p.wait(10e3); p.show();
  assert.equal(pings(p).length, 0, 'seen less than 3 minutes ago');
  p.push('/b');
  p.wait(3 * 60e3);
  assert.deepEqual(pings(p).map(e => e.u), ['https://example.com/b'], 'the clock starts again with each page view');
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

test('tracker: clicks on links to other sites and on files are sent, without the query', () => {
  const p = page('https://example.com/docs', { referrer: 'https://news.ycombinator.com/' });
  p.click('https://github.com/acme/repo?token=secret#readme');
  p.click('/files/guide.PDF?v=2');
  p.click('https://www.example.com/pricing');
  p.click('mailto:hi@example.com');
  p.click(null);
  p.click('https://github.com/', { type: 'auxclick', button: 2 });
  p.click('https://github.com/', { type: 'auxclick', button: 1 });
  assert.deepEqual(p.events.map(e => [e.t, e.o]), [
    ['outbound', 'https://github.com/acme/repo'],
    ['download', 'https://example.com/files/guide.PDF'],
    ['outbound', 'https://github.com/'],
  ]);
  assert.equal(p.events[0].u, 'https://example.com/docs');
  assert.equal(p.events[0].r, 'https://news.ycombinator.com/', 'credited to the visit\'s source');
});
