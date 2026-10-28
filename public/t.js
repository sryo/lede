// Generated from src/tracker.js by `npm run tracker`. Edit that file, not this one.
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
  function visitHour() {
    var now = Date.now(), visit = null;
    try { visit = JSON.parse(sessionStorage.getItem(VISIT)); } catch (e) {}
    if (!visit || !(now - visit.t < IDLE)) visit = { h: Math.floor(now / HOUR) * HOUR };
    visit.t = now;
    try { sessionStorage.setItem(VISIT, JSON.stringify(visit)); } catch (e) {}
    return visit.h;
  }
  function post(data) {
    var body = JSON.stringify(data);
    if (window.fetch) fetch(endpoint, { method: 'POST', body: body, keepalive: true }).catch(function () {});
    else if (navigator.sendBeacon) navigator.sendBeacon(endpoint, body);
  }
  function pause() { if (view && view.since) { view.ms += Date.now() - view.since; view.since = 0; } }
  function resume() {
    if (view && !view.since && !view.done && document.visibilityState === 'visible' && document.hasFocus()) view.since = Date.now();
  }
  function scrolled() {
    var box = view && (view.box ? view.box.getBoundingClientRect() : { top: -scrollY, height: document.documentElement.scrollHeight });
    if (box && box.height) view.depth = Math.max(view.depth, Math.min(100, Math.round((innerHeight - box.top) / box.height * 100)));
  }
  function end(moving) {
    pause();
    if (!view || view.done || view.ms < 1000) return;
    if (!moving) scrolled();
    view.done = true;
    post({ t: 'engagement', u: view.u, r: view.r, l: view.l, h: view.h, e: view.ms, s: view.depth });
  }
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
  document.addEventListener('visibilitychange', function () {
    if (view && document.visibilityState === 'visible' && Date.now() - seen >= PING) { ping(); keep(); }
  });
  var push = history.pushState;
  history.pushState = function () {
    var result = push.apply(this, arguments);
    send();
    return result;
  };
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
  addEventListener('pageshow', function (e) { if (e.persisted) { last = null; send(); } });
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
