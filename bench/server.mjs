// Serves one copy of Lede (a git ref exported by scripts/bench.mjs, or the working tree) the way
// Cloudflare would: the Worker for /api/* and /lede, the files in public/ for everything else.
// Bindings are the counting stand-ins in fakes.mjs. GET /__bench/counts reads the counters and
// POST /__bench/reset zeroes them; GET /__bench/site.html is a customer page carrying the tracker.
//   node bench/server.mjs --root <dir> [--demo]      prints {"port":N} once listening

import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { counters, benchEnv, fakeFetch } from './fakes.mjs';

const argv = process.argv.slice(2);
const root = resolve(argv[argv.indexOf('--root') + 1]);
const demo = argv.includes('--demo');

crypto.subtle.timingSafeEqual ??= (a, b) => Buffer.from(a).equals(Buffer.from(b));
const count = counters(), inner = fakeFetch(count);
// Queries made while answering /api/insight are the second line's sheet, which Lede builds at most once an
// hour, so they're counted apart from the ones every load makes.
const route = new AsyncLocalStorage();
globalThis.fetch = (url, init) => {
  if (route.getStore() === 'insight' && String(url).endsWith('/analytics_engine/sql')) count.sheet++;
  return inner(url, init);
};
const worker = (await import(pathToFileURL(join(root, 'src/index.js')).href)).default;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.woff2': 'font/woff2', '.css': 'text/css', '.json': 'application/json' };
const assets = {
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const file = path.endsWith('/') ? path + 'index.html' : path;
    // Like not_found_handling "single-page-application": a page address that isn't a file gets the
    // dashboard, even one that looks like a file (/sources/google.com).
    const page = (req.headers.get('Accept') || '').includes('text/html');
    for (const f of extname(file) && !page ? [file] : [file, '/index.html']) {
      try { return new Response(await readFile(join(root, 'public', f)), { headers: { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream' } }); } catch {}
    }
    return new Response('Not found', { status: 404 });
  },
};
const env = benchEnv(count, { demo, assets });

const SITE = `<!doctype html><html><head><meta charset="utf-8"><title>A customer page</title>
<script>window.__t0 = performance.now()</script><script src="/t.js"></script><script>window.__t1 = performance.now()</script>
</head><body><main style="height:4000px"><h1>A post</h1><p>Some words to read.</p><a id="out" href="https://example.org/">elsewhere</a></main></body></html>`;

const server = createServer(async (req, res) => {
  if (req.url === '/__bench/counts') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(count)); }
  if (req.url === '/__bench/reset') { for (const k in count) count[k] = 0; return res.end('{}'); }
  if (req.url.split('?')[0] === '/__bench/site.html') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(SITE); }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const url = `http://${req.headers.host}${req.url}`;
  if (req.url.startsWith('/api/')) count.api++;
  if (req.url.startsWith('/lede')) { count.beacons++; if (process.env.BENCH_LOG) console.error('beacon', req.headers.origin, req.headers['user-agent']?.slice(-30), Buffer.concat(chunks).toString().slice(0, 40)); }
  const request = new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
  const waits = [];
  try {
    const name = req.url.startsWith('/api/') ? req.url.slice(5).split(/[?/]/)[0] : null;
    const out = await route.run(name, () => worker.fetch(request, env, { waitUntil: p => waits.push(p), passThroughOnException() {} }));
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
    await Promise.allSettled(waits);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e?.stack || e));
  }
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
