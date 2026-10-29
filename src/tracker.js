// Lede's line. Add it to every page of a site:
//   <script defer src="https://YOUR-LEDE/t.js"></script>
// No cookies. The site a visit came from and its landing page's tags are kept in sessionStorage so
// every page of the visit is credited to where the visitor came from.
// It also sends, as each page view ends and each time its tab is hidden, how long the page was read, how
// far down it was scrolled and the page's Web Vitals (add data-engagement="false" to the script tag to turn
// that off), clicks on links to other sites and on files to download, and every 3 minutes that a tab still
// showing is still there.
// To leave your own visits out, run localStorage.lede_ignore = 1 in the browser console on your site.
(function () {
  var script = document.currentScript;
  if (!script || navigator.webdriver || window._phantom || window.__nightmare || window.Cypress) return;
  try { if (localStorage.getItem('lede_ignore')) return; } catch (e) {}
  var endpoint = new URL('/lede', script.src).href;
  var KEY = 'lede_source', VISIT = 'lede_visit', MINUTE = 60e3, HOUR = 3600e3, IDLE = 30 * 60e3, PING = 3 * 60e3, SETTLE = 5000;
  var FILE = /\.(pdf|csv|txt|rtf|docx?|xlsx?|pptx?|od[tsp]|epub|zip|rar|7z|gz|tgz|bz2|dmg|pkg|exe|msi|deb|rpm|apk|iso|mp[34]|wav|flac|m4a|mov|avi|mkv|webm|wmv)$/i;
  var engage = script.getAttribute('data-engagement') !== 'false';
  var last, view, record, inside, gone, seen = 0, beat = 0, input = 0;

  var bare = function (host) { return host.replace(/^www\./, ''); };

  // Where the visit came from: the referring site (protocol and host; the rest of its address isn't
  // needed) and the landing page's tags. A link within the site that carries tags doesn't change it.
  function source() {
    var from = '', saved = null, ref;
    inside = false;
    // A page behind a Cloudflare challenge loads again once the challenge is passed, with the challenge's
    // own address (its __cf_chl_ token) as the referrer: that's a visit starting, not a page within one.
    try {
      ref = new URL(document.referrer);
      var same = bare(ref.hostname) === bare(location.hostname);
      inside = same && !/[?&]__cf_/.test(ref.search);
      if (!same) from = ref.protocol + '//' + ref.host;
    } catch (e) {}
    // The parts of the landing page's query that say where the visit came from; the rest stays on the page.
    var tags = (location.search.match(/[?&](utm_\w+|ref|source|[gd]clid|[gw]braid|msclkid|t[tw]clid|li_fat_id)=[^&]*/g) || []).join('');
    var fresh = { r: from, l: tags };
    try {
      saved = JSON.parse(sessionStorage.getItem(KEY));
      if (from || (tags && !(inside && saved))) sessionStorage.setItem(KEY, JSON.stringify(saved = fresh));
    } catch (e) {}
    return saved || fresh;
  }

  // The visit this tab is on: when it started (h), when it was last seen (t) and its page views (n).
  // Half an hour without a page or a ping starts a new one. A tab's first visit starts on the hour, so a
  // tab opened beside it during that hour joins it, and a visit that runs past the hour stays one visit.
  // A later visit in the same tab starts on the minute, so it isn't taken for the one before.
  // A new tab opened from a link on the site carries on the visit of the tab it came from, so its views
  // count as later ones (n starts at 2) and the visit isn't counted again, nor as a bounce.
  // The page keeps its own copy, for when sessionStorage can't be used.
  function visit(views) {
    var now = Date.now(), v = record;
    try { v = JSON.parse(sessionStorage.getItem(VISIT)) || v; } catch (e) {}
    if (!v || !(now - v.t < IDLE)) v = { h: now - now % (v ? MINUTE : HOUR), n: v || !inside ? 0 : 2 };
    v.t = now;
    v.n = (v.n || 0) + views;
    record = v;
    try { sessionStorage.setItem(VISIT, JSON.stringify(v)); } catch (e) {}
    return v;
  }

  // keepalive lets the request finish even as the page unloads, so a click on a link or closing
  // the tab never waits for it. Not sendBeacon: tracker blockers drop its "ping" requests to other
  // sites while sendBeacon still reports success, so those visits would vanish without a trace. Every
  // browser Lede counts has fetch (see OLDEST in src/bots.js). data can be several events, sent as one
  // request.
  function post(data) {
    fetch(endpoint, { method: 'POST', body: JSON.stringify(data), keepalive: true }).catch(function () {});
  }

  // Web Vitals, sent with each page view's engagement event. LCP: how long the largest thing on the page
  // took to draw; only the first view has one, and only when the page loaded in sight. INP: the slowest
  // response to a tap, click or key (which is what INP is until a page has had 50). CLS: the worst burst
  // of the layout moving on its own (shifts less than a second apart, over at most 5 seconds). Each is
  // left out until the browser has measured it, except CLS, which is 0 until the layout moves wherever
  // the browser watches for it, so a page that never shifts says so. CLS goes times 1000, and the
  // server rounds them all.
  // A prerendered page's LCP counts from when it was opened (activationStart), as Google counts it; a
  // page opened in a background tab has none. The browser hands entries over a little later, so the
  // ones still waiting (often the tap that left the page) are taken (flush) before each send.
  var vitals = {}, flush = [], paint, shifts, burst = 0, burstStart = 0, lastShift = 0;
  function watch(type, fn) {
    try {
      var o = new PerformanceObserver(function (list) { list.getEntries().forEach(fn); });
      o.observe({ type: type, buffered: true, durationThreshold: 16 });
      flush.push(function () { o.takeRecords().forEach(fn); });
      return true;
    } catch (e) {}
  }
  if (engage) {
    if (document.prerendering || document.visibilityState === 'visible') watch('largest-contentful-paint', function (e) { paint = e.startTime; });
    watch('event', function (e) { if (e.interactionId && !(e.duration <= vitals.inp)) vitals.inp = e.duration; });
    shifts = watch('layout-shift', function (e) {
      if (e.hadRecentInput) return;
      if (e.startTime - lastShift < 1000 && e.startTime - burstStart < 5000) burst += e.value;
      else { burst = e.value; burstStart = e.startTime; }
      lastShift = e.startTime;
      if (!(burst * 1e3 <= vitals.cls)) vitals.cls = burst * 1e3;
    });
    if (shifts) vitals.cls = 0;
  }

  // Engaged time only runs while the tab is visible and its window has focus.
  function pause() { if (view && view.since) { view.ms += Date.now() - view.since; view.since = 0; } }
  function resume() {
    if (view && !view.since && document.visibilityState === 'visible' && document.hasFocus()) view.since = Date.now();
  }
  // How far down the page the bottom of the window has been, in percent. It's measured on scroll, a
  // second after the view starts and when the tab is hidden or closed, not at the very start, so a
  // page that grows as it loads isn't counted as read to the end.
  // An endless page holds several pages in one document, so it can mark each with its path
  // (data-lede-page="/chapter-2"); a view with a marked element is measured within it, and the
  // pages added above and below don't count toward its height.
  function scrolled() {
    var box = view && (view.box ? view.box.getBoundingClientRect() : { top: -scrollY, height: document.documentElement.scrollHeight });
    if (box && box.height) view.depth = Math.max(view.depth, Math.min(100, Math.round((innerHeight - box.top) / box.height * 100)));
  }
  // The page view's totals so far, sent each time its tab is hidden or closed and once more when a
  // single-page app moves on, so time read after coming back to a tab counts too. Each carries the view's
  // start (v), and the server keeps each view's largest. Less than a second is a glance, so nothing goes
  // until then; after the first, hiding the tab sends only with 3 seconds more, a deeper scroll or a new Web
  // Vital, so flicking between tabs sends nothing. Each says the page view was left (x), hidden, closed or
  // moved on from, so it leaves "here now" at once. Moving on always returns the event, to go with the next
  // page view in the same request.
  // A single-page app has usually drawn the next page by the time it changes the address, so moving
  // on doesn't measure: the next page's height would be taken for the one being left.
  function end(moving) {
    pause();
    if (!view || view.ms < 1000) return;
    if (!moving) scrolled();
    flush.forEach(function (f) { f(); });
    if (paint != null) {
      var nav = performance.getEntriesByType('navigation')[0];
      vitals.lcp = Math.max(0, paint - (nav && nav.activationStart || 0));
    }
    var said = JSON.stringify(vitals);
    if (!moving && view.sent && view.ms - view.sent < 3000 && view.depth <= view.deep && said === view.said) return;
    view.sent = view.ms;
    view.deep = view.depth;
    view.said = said;
    var e = Object.assign({ t: 'engagement', u: view.u, r: view.r, l: view.l, h: view.h, v: view.v, e: view.ms, s: view.depth, x: 1 }, vitals);
    if (moving) return e;
    gone = 1;
    post(e);
  }

  // "Here now" is anyone seen in the last 5 minutes, so someone reading one page for longer would
  // drop out of it. A tab that shows says it is still there every 3 minutes, from its last page view
  // or ping, and that keeps its visit going. A window in the background counts while its tab shows; a
  // hidden tab doesn't. Half an hour without a page view, a scroll, a click, a key or showing the tab
  // is someone who has walked away, so the pings stop until they're back, and then come at once. A tab
  // whose hiding was sent (gone) pings as soon as it shows again, so the reader is back in "here now".
  // A ping carries the view's totals so far, so a tab the phone closes without hiding it first, which
  // sends nothing more, still leaves how long it was read.
  function ping() {
    seen = Date.now();
    gone = 0;
    var p = { t: 'ping', u: view.u, r: view.r, l: view.l, h: visit(0).h, v: view.v };
    if (engage) { pause(); resume(); p.e = view.ms; p.s = view.depth; }
    post(p);
  }
  function keep() {
    var mine = ++beat;
    setTimeout(function () {
      if (mine !== beat) return;
      if (document.visibilityState === 'visible' && Date.now() - input < IDLE) ping();
      keep();
    }, PING);
  }
  function active() {
    input = Date.now();
    if (view && document.visibilityState === 'visible' && (gone || input - seen >= PING)) { ping(); keep(); }
  }
  // visibilitychange reaches the window from the document, so showing the tab counts as input.
  'scroll pointerdown pointermove keydown visibilitychange'.split(' ').forEach(function (type) { addEventListener(type, active, true); });

  // The hash is left out, so jumping to an anchor on the same page isn't another view. The page view
  // left behind sends its last totals in the same request as the next one.
  function send() {
    var page = location.pathname + location.search;
    if (page === last) return;
    last = page;
    var left = engage && end(true);
    if (view) { vitals = shifts ? { cls: 0 } : {}; paint = null; burst = burstStart = lastShift = 0; }
    var src = source(), v = visit(1), now = Date.now(), shown;
    shown = view = { u: location.href, r: src.r, l: src.l, h: v.h, v: now, ms: 0, since: 0, depth: 0, box: document.querySelector('[data-lede-page="' + location.pathname + '"]') };
    var hit = { u: view.u, r: view.r, l: view.l, h: view.h, v: now, k: Math.min(v.n, 3) };
    post(left ? [left, hit] : hit);
    seen = input = now;
    gone = 0;
    keep();
    if (engage) { resume(); setTimeout(function () { if (view === shown) scrolled(); }, 1000); }
  }

  // A link to another site, or to a file on any site. The query is left out, since links often carry
  // a token or an email address in it. A middle click opens the link in a new tab, so it counts too.
  function clicked(e) {
    if (!view || (e.type === 'auxclick' && e.button !== 1)) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]'), to;
    if (!a) return;
    try { to = new URL(a.href, location.href); } catch (err) { return; }
    if (to.protocol !== 'https:' && to.protocol !== 'http:') return;
    var type = FILE.test(to.pathname) ? 'download' : bare(to.hostname) !== bare(location.hostname) ? 'outbound' : '';
    if (type) post({ t: type, u: location.href, r: view.r, l: view.l, h: view.h, o: to.origin + to.pathname });
  }
  document.addEventListener('click', clicked);
  document.addEventListener('auxclick', clicked);

  if (engage) {
    addEventListener('scroll', scrolled, { passive: true });
    addEventListener('focus', resume);
    addEventListener('blur', pause);
    addEventListener('pagehide', function () { end(); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') end(); else resume(); });
  }

  var push = history.pushState;
  history.pushState = function () {
    var result = push.apply(this, arguments);
    send();
    return result;
  };
  // A page that replaces its address with another page's is showing that page now, as an endless page
  // does when it scrolls into the next one. It counts once the address has stayed there for 5 seconds,
  // so scrolling back and forth across the border between two pages isn't a view each time. One that
  // only changes the query or the hash is tidying the address in place, as when it drops utm tags after
  // landing, so that stays the same page view.
  var replace = history.replaceState, settling;
  history.replaceState = function () {
    var result = replace.apply(this, arguments);
    if (view) {
      if (location.pathname === last.split('?')[0]) last = location.pathname + location.search;
      else {
        var mine = settling = {};
        setTimeout(function () { if (settling === mine) send(); }, SETTLE);
      }
    }
    return result;
  };
  addEventListener('popstate', send);
  // Back and forward can restore a page from the browser's cache without running scripts again.
  addEventListener('pageshow', function (e) { if (e.persisted) { last = null; send(); } });

  // A page the browser prerenders in case it's clicked, or opens in a background tab, counts once
  // someone actually looks at it.
  function whenSeen() {
    if (document.visibilityState !== 'hidden') return send();
    document.addEventListener('visibilitychange', function seen() {
      if (document.visibilityState === 'hidden') return;
      document.removeEventListener('visibilitychange', seen);
      send();
    });
  }
  if (document.prerendering) {
    document.addEventListener('prerenderingchange', whenSeen, { once: true });
  } else {
    whenSeen();
  }
})();
