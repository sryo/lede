import { shapeLive, byVisitor } from './shape.js';

// "Here now", pushed to the dashboard as it changes instead of asked for every minute. One Durable Object
// per site keeps who was seen in the last 30 minutes, a row per page view (by visitor and view, as liveSql
// counts them), in its own SQLite, so it survives being put to sleep between events. It only hears of
// events while a dashboard is watching (see forward), so a site nobody is watching costs it nothing; a
// dashboard that starts watching hands it who Analytics Engine already has (seed).
// A plain class, not cloudflare:workers' DurableObject, so Node (the tests and the bench) can load the Worker.
const WINDOW = 1800;
const PUSH_MS = 1000;

export class Live {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS here (visitor TEXT, view INTEGER, path TEXT, referrer TEXT, country TEXT, first INTEGER, last INTEGER, out INTEGER, PRIMARY KEY (visitor, view))');
  }

  async fetch(req) {
    const { pathname } = new URL(req.url), now = Math.floor(Date.now() / 1000);
    if (pathname === '/event') {
      this.saw(await req.json(), now);
      this.soon();
      return Response.json({ watching: this.ctx.getWebSockets().length });
    }
    if (pathname === '/seed') {
      this.seed(await req.json());
      return new Response(null, { status: 204 });
    }
    if (pathname === '/watch' && req.headers.get('Upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify(this.snapshot(now)));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response(null, { status: 404 });
  }

  // One event from collect: a page view, a ping, or the page view left (its tab hidden or closed, or moved
  // on from), which leaves it out until it's seen again. Rows from the seed (view 0, a whole visitor) give way to the visitor's own page views.
  saw({ visitor, view = 0, path = '', referrer = '', country = '', left = 0 }, now) {
    if (typeof visitor !== 'string' || !visitor) return;
    if (view) this.sql.exec('DELETE FROM here WHERE visitor = ? AND view = 0', visitor);
    this.sql.exec(`INSERT INTO here VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (visitor, view) DO UPDATE SET
      path = CASE WHEN excluded.out = 1 THEN path ELSE excluded.path END, last = excluded.last, out = excluded.out`,
    visitor, view, path, referrer, country, now, now, left ? 1 : 0);
  }

  // liveSql's page views, for those this object hasn't heard of since.
  seed(rows) {
    for (const r of Array.isArray(rows) ? rows.slice(0, 1000) : []) {
      if (typeof r.visitor !== 'string') continue;
      this.sql.exec('INSERT OR IGNORE INTO here VALUES (?, ?, ?, ?, ?, ?, ?, ?)', r.visitor, Number(r.vw) || 0, String(r.path ?? ''),
        String(r.referrer ?? ''), String(r.country ?? ''), Number(r.first) || 0, Number(r.last) || 0, Number(r.hid) > Number(r.shown) ? 1 : 0);
    }
  }

  // What GET /api/live answers, from the same rows liveSql gives it.
  snapshot(now) {
    this.sql.exec('DELETE FROM here WHERE last < ?', now - WINDOW);
    return shapeLive(byVisitor(this.sql.exec('SELECT * FROM here').toArray()), now);
  }

  // At most once a second, to every dashboard watching.
  soon() {
    if (this.timer || !this.ctx.getWebSockets().length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const body = JSON.stringify(this.snapshot(Math.floor(Date.now() / 1000)));
      for (const ws of this.ctx.getWebSockets()) try { ws.send(body); } catch {}
    }, PUSH_MS);
  }

  webSocketMessage() {}
  webSocketClose(ws, code) { try { ws.close(code); } catch {} }
}

const stub = (env, site) => env.LIVE.get(env.LIVE.idFromName(site));

// Whether a dashboard is watching each site, as this Worker instance last heard from its Live object.
// Asking costs a Durable Object request, so an instance asks at most once a minute per site while nobody
// is, and carries on forwarding while someone is. A dashboard that starts watching is heard of within a
// minute everywhere; until then it has what the seed gave it.
const RECHECK = 60e3;
const watched = new Map();

// Hands a page view, a ping or a hidden tab to the site's Live object, without the beacon waiting for it.
export function forward(env, ctx, ev) {
  if (!env.LIVE || !ctx) return;
  if (!(ev.type === 'pageview' || ev.type === 'ping' || (ev.type === 'engagement' && ev.left))) return;
  const now = Date.now(), w = watched.get(ev.site);
  if (w && now < w.until && !w.n) return;
  if (!w || now >= w.until) watched.set(ev.site, { until: now + RECHECK, n: w?.n ?? 0 });
  const e = { visitor: ev.visitor, view: ev.view || 0, path: ev.path, referrer: ev.referrer, country: ev.country, left: ev.left || 0 };
  ctx.waitUntil(stub(env, ev.site).fetch('https://live/event', { method: 'POST', body: JSON.stringify(e) })
    .then(r => r.json()).then(({ watching }) => watched.set(ev.site, { until: now + RECHECK, n: watching || 0 }))
    .catch(() => {}));
}

// GET /api/live/ws: the dashboard's socket. rows: liveSql's answer, so the object starts from what
// Analytics Engine has.
export async function watch(env, site, rows) {
  const live = stub(env, site);
  await live.fetch('https://live/seed', { method: 'POST', body: JSON.stringify(rows) });
  watched.set(site, { until: Date.now() + RECHECK, n: 1 });
  return live.fetch('https://live/watch', { headers: { Upgrade: 'websocket' } });
}
