// Times the Worker in Node on one copy of Lede: handling a visit, and answering each stats route with
// the fixed rows from fakes.mjs. Free Workers get 10 ms of CPU per request, so these are what count
// against it (V8 in Node is close enough to workerd for comparing two versions, not for the absolute).
// "big site:" times the routes whose answers grow with a site, with every list as long as its LIMIT.
//   node bench/worker.mjs --root <dir> [--iters 200]   prints {op: median ms per call}

import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { counters, benchEnv, fakeFetch } from './fakes.mjs';

const argv = process.argv.slice(2);
const root = resolve(argv[argv.indexOf('--root') + 1]);
const iters = argv.includes('--iters') ? +argv[argv.indexOf('--iters') + 1] : 200;

crypto.subtle.timingSafeEqual ??= (a, b) => Buffer.from(a).equals(Buffer.from(b));
const count = counters(), profile = { big: false };
globalThis.fetch = fakeFetch(count, profile);
const worker = (await import(pathToFileURL(join(root, 'src/index.js')).href)).default;
const env = benchEnv(count, { assets: { fetch: async () => new Response('') } });
const ctx = { waitUntil() {}, passThroughOnException() {} };

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const beacon = i => new Request('https://lede.test/lede', {
  method: 'POST',
  headers: { Origin: 'https://example.com', 'User-Agent': UA, 'CF-Connecting-IP': `203.0.113.${i % 250}` },
  body: JSON.stringify({ t: 'pageview', u: `https://example.com/blog?i=${i}`, r: 'https://news.ycombinator.com/', h: 0 }),
});
// The query string changes every call, so the Worker's own short cache never answers for it.
const ROUTES = ['summary', 'series', 'flows', 'hourly', 'firsts', 'live', 'engagement', 'links',
  'breakdown&dim=path', 'breakdown&dim=referrer', 'conversions&goal=%2Fpricing'];
const stats = (name, i) => {
  const [route, extra] = name.split('&');
  return new Request(`https://lede.test/api/${route}?site=example.com&days=30&tz=180&n=${i}${extra ? '&' + name.slice(route.length + 1) : ''}`);
};

const median = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
async function time(make) {
  for (let i = 0; i < 20; i++) await (await worker.fetch(make(-i - 1), env, ctx)).arrayBuffer();
  const ms = [];
  for (let i = 0; i < iters; i++) {
    const req = make(i), t = performance.now();
    const res = await worker.fetch(req, env, ctx);
    await res.arrayBuffer();
    ms.push(performance.now() - t);
    if (res.status >= 400) throw new Error(`${req.url} answered ${res.status}`);
  }
  return median(ms);
}

const out = { 'worker: visit': await time(beacon) };
const label = r => r.replace('&dim=', ' ').replace('&goal=%2F', ' /');
for (const r of ROUTES) out[`worker: ${label(r)}`] = await time(i => stats(r, i));
profile.big = true;
for (const r of ['flows', 'engagement', 'links', 'breakdown&dim=path', 'breakdown&dim=referrer']) out[`big site: ${label(r)}`] = await time(i => stats(r, i));
console.log(JSON.stringify(out));
