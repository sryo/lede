// Lede's line. Add it to every page of a site:
//   <script defer src="https://YOUR-LEDE/t.js"></script>
// No cookies. The site a visit came from and its landing query are kept in sessionStorage so
// every page of the visit is credited to where the visitor came from.
// It also sends, once per page view, how long the page was read and how far down it was scrolled
// (add data-engagement="false" to the script tag to turn that off), clicks on links to other
// sites and on files to download, and every 3 minutes that a tab still showing is still there.
// To leave your own visits out, run localStorage.lede_ignore = 1 in the browser console on your site.
(function () {
  var script = document.currentScript;
  if (!script || navigator.webdriver || window._phantom || window.__nightmare || window.Cypress) return;
  try { if (localStorage.getItem('lede_ignore')) return; } catch (e) {}
  var endpoint = new URL('/lede', script.src).href;
  var KEY = 'lede_source', VISIT = 'lede_visit', HOUR = 3600e3, IDLE = 30 * 60e3, PING = 3 * 60e3, SETTLE = 5000;
  var FILE = /\.(pdf|csv|txt|rtf|docx?|xlsx?|pptx?|odt|ods|odp|epub|zip|rar|7z|gz|tgz|bz2|dmg|pkg|exe|msi|deb|rpm|apk|iso|mp3|wav|flac|m4a|mp4|mov|avi|mkv|webm|wmv)$/i;
  var engage = script.getAttribute('data-engagement') !== 'false';
  var last, view, seen = 0, beat = 0;

  var bare = function (host) { return host.replace(/^www\./, ''); };

  function source() {
    var ref = document.referrer, query = location.search, external = false;
    try { external = !!ref && bare(new URL(ref).hostname) !== bare(location.hostname); } catch (e) {}
    var tagged = /[?&](utm_|ref=|gclid=|gbraid=|wbraid=|msclkid=|ttclid=)/.test(query);
    var fresh = { r: external ? ref : '', l: tagged ? query : '' };
    try {
      if (external || tagged) { sessionStorage.setItem(KEY, JSON.stringify(fresh)); return fresh; }
      return JSON.parse(sessionStorage.getItem(KEY)) || fresh;
    } catch (e) {
      return fresh;
    }
  }

  // The hour this tab's visit started, so a visit that runs past the hour stays one visit.
  // Half an hour without a page starts a new one.
  function visitHour() {
    var now = Date.now(), visit = null;
    try { visit = JSON.parse(sessionStorage.getItem(VISIT)); } catch (e) {}
    if (!visit || !(now - visit.t < IDLE)) visit = { h: Math.floor(now / HOUR) * HOUR };
    visit.t = now;
    try { sessionStorage.setItem(VISIT, JSON.stringify(visit)); } catch (e) {}
    return visit.h;
  }

  // keepalive lets the request finish even as the page unloads, so a click on a link or closing
  // the tab never waits for it. Not sendBeacon: tracker blockers drop its "ping" requests to other
  // sites while sendBeacon still reports success, so those visits vanished without a trace.
  function post(data) {
    var body = JSON.stringify(data);
    if (window.fetch) fetch(endpoint, { method: 'POST', body: body, keepalive: true }).catch(function () {});
    else if (navigator.sendBeacon) navigator.sendBeacon(endpoint, body);
  }

  // Engaged time only runs while the tab is visible and its window has focus.
  function pause() { if (view && view.since) { view.ms += Date.now() - view.since; view.since = 0; } }
  function resume() {
    if (view && !view.since && !view.done && document.visibilityState === 'visible' && document.hasFocus()) view.since = Date.now();
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
  // Sent once per page view, when it ends: the tab is hidden or closed, or a single-page app moves on.
  // Less than a second is a glance, so the view stays open in case they come back to it.
  // A single-page app has usually drawn the next page by the time it changes the address, so moving
  // on doesn't measure: the next page's height would be taken for the one being left.
  function end(moving) {
    pause();
    if (!view || view.done || view.ms < 1000) return;
    if (!moving) scrolled();
    view.done = true;
    post({ t: 'engagement', u: view.u, r: view.r, l: view.l, h: view.h, e: view.ms, s: view.depth });
  }

  // "Here now" is anyone seen in the last 5 minutes, so someone reading one page for longer would
  // drop out of it. A tab that shows says it is still there every 3 minutes, from its last page view
  // or ping. A window in the background counts while its tab shows; a hidden tab doesn't.
  function ping() {
    seen = Date.now();
    post({ t: 'ping', u: view.u, r: view.r, l: view.l, h: view.h });
  }
  function keep() {
    var mine = ++beat;
    setTimeout(function () {
      if (mine !== beat) return;
      if (document.visibilityState === 'visible') ping();
      keep();
    }, PING);
  }

  // The hash is left out, so jumping to an anchor on the same page isn't another view.
  function send() {
    var page = location.pathname + location.search;
    if (page === last) return;
    last = page;
    if (engage) end(true);
    var src = source(), shown;
    shown = view = { u: location.href, r: src.r, l: src.l, h: visitHour(), ms: 0, since: 0, depth: 0, box: document.querySelector('[data-lede-page="' + location.pathname + '"]') };
    post({ u: view.u, r: view.r, l: view.l, h: view.h });
    seen = Date.now();
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

  // Back on a tab after a while: here again at once, not at the next ping.
  document.addEventListener('visibilitychange', function () {
    if (view && document.visibilityState === 'visible' && Date.now() - seen >= PING) { ping(); keep(); }
  });

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
