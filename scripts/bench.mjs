#!/usr/bin/env node
// Measures Lede against a git ref (default: the ref in bench/baseline.json) so a change can show it
// keeps or improves what it costs. Three kinds of numbers:
//   bytes    what customer sites download (t.js) and what the dashboard loads, raw, gzip and brotli
//   counts   Analytics Engine queries, /api calls, writes and KV use per dashboard page and per visit,
//            the things Cloudflare's free limits count; exact, so any increase is a regression
//   timings  the Worker per visit and per stats answer (Node), and in headless Chrome Canary with the
//            CPU slowed 4x: what t.js adds to a page load, and how long the dashboard home takes to draw
// Timings run base and working tree in turn, rep after rep, so machine noise hits both alike; then
// scripts/compare.mjs judges the paired ratios.
//   node scripts/bench.mjs [--base <ref>] [--reps 15] [--out bench/runs/latest.json] [--chrome path]
//   node scripts/bench.mjs --run <ref>  another ref instead of the working tree, e.g. a branch to merge
//   node scripts/bench.mjs --aa        the working tree against itself, to measure noise
//   node scripts/bench.mjs --save-baseline     records the working tree in bench/baseline.json

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants as Z } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a]).toString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r3 = x => Math.round(x * 1000) / 1000;

export function parseArgs(argv) {
  const a = { reps: 15, base: undefined, run: null, out: null, chrome: null, aa: false, saveBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--reps') a.reps = +argv[++i];
    else if (k === '--base') a.base = argv[++i];
    else if (k === '--run') a.run = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--chrome') a.chrome = argv[++i];
    else if (k === '--aa') a.aa = true;
    else if (k === '--save-baseline') a.saveBaseline = true;
    else throw new Error('unknown arg ' + k);
  }
  if (!Number.isInteger(a.reps) || a.reps < 3) throw new Error('--reps must be an integer of at least 3');
  return a;
}

/* ---------- bytes ---------- */

const gz = b => gzipSync(b, { level: 9 }).length;
const br = b => brotliCompressSync(b, { params: { [Z.BROTLI_PARAM_QUALITY]: 11 } }).length;
// The tracker as sites receive it: dist/t.js when a build makes one, else public/t.js.
const trackerFile = root => ['dist/t.js', 'public/t.js'].map(f => join(root, f)).find(existsSync);

export function bytesOf(root) {
  const t = readFileSync(trackerFile(root));
  const out = { 't.js bytes': t.length, 't.js gzip': gz(t), 't.js brotli': br(t) };
  // Everything the dashboard can load: public/ without the tracker and the headers file.
  let raw = 0, g = 0, b = 0;
  for (const f of readdirSync(join(root, 'public'))) {
    if (f === 't.js' || f.startsWith('_')) continue;
    const buf = readFileSync(join(root, 'public', f));
    raw += buf.length;
    // Fonts are already compressed and Cloudflare sends them as they are.
    if (f.endsWith('.woff2')) { g += buf.length; b += buf.length; } else { g += gz(buf); b += br(buf); }
  }
  return { ...out, 'dashboard bytes': raw, 'dashboard gzip': g, 'dashboard brotli': b };
}

/* ---------- a copy of each version ---------- */

function exportRef(ref) {
  const dir = mkdtempSync(join(tmpdir(), 'lede-bench-'));
  execFileSync('sh', ['-c', `git -C "${ROOT}" archive "${ref}" | tar -x -C "${dir}"`]);
  return dir;
}

function startServer(root, demo) {
  const proc = spawn(process.execPath, [join(ROOT, 'bench/server.mjs'), '--root', root, ...(demo ? ['--demo'] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((res, rej) => {
    proc.stdout.once('data', d => res({ proc, base: `http://127.0.0.1:${JSON.parse(d).port}` }));
    proc.once('exit', c => rej(new Error('bench server exited ' + c)));
  });
}
const getJSON = async url => (await fetch(url)).json();

function workerTimes(root) {
  return JSON.parse(execFileSync(process.execPath, [join(ROOT, 'bench/worker.mjs'), '--root', root, '--iters', '150']).toString());
}

/* ---------- Chrome over a pipe (no dependencies) ---------- */

const CHROMES = [process.env.CHROME,
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

function launch(chromePath) {
  const profile = mkdtempSync(join(tmpdir(), 'lede-chrome-'));
  const proc = spawn(chromePath, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--window-size=1280,900', `--user-agent=${UA}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let id = 0, buf = '';
  const pending = new Map(), listeners = new Set();
  proc.stdio[4].on('data', chunk => {
    buf += chunk.toString('utf8');
    for (let i; (i = buf.indexOf('\0')) !== -1;) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const msg = { id: ++id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    pending.set(msg.id, { res, rej });
    proc.stdio[3].write(JSON.stringify(msg) + '\0');
  });
  const close = () => { proc.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {} };
  return { send, listeners, close };
}

// A fresh tab looking like a person's browser: a normal user agent (Lede drops headless ones as bots;
// set for the whole browser too, since requests sent as a page unloads skip the tab's override),
// no webdriver flag (t.js stands down for it), a fixed timezone, focus, and the CPU slowed 4x so main-thread
// costs are big enough to compare.
const PAGE_INIT = `
Object.defineProperty(navigator, 'webdriver', { get: () => false });
window.__long = [];
try { new PerformanceObserver(l => { for (const e of l.getEntries()) __long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
// The home page counts as drawn once its four tiles have their charts.
(function poll() {
  const ok = document.querySelector('.t-days svg rect') && document.querySelector('.t-flow svg path')
    && document.querySelector('.t-pages .blk, .t-pages button') && document.querySelector('.t-stay .sqrow');
  if (ok) window.__drawn = performance.now(); else requestAnimationFrame(poll);
})();`;

async function openTab(chrome, { throttle = 4 } = {}) {
  const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => chrome.send(m, p, sessionId);
  await s('Page.enable');
  await s('Emulation.setUserAgentOverride', { userAgent: UA, acceptLanguage: 'en-US' });
  await s('Emulation.setTimezoneOverride', { timezoneId: 'America/Argentina/Buenos_Aires' });
  await s('Emulation.setCPUThrottlingRate', { rate: throttle });
  // Reading time only runs while the window has focus.
  await s('Emulation.setFocusEmulationEnabled', { enabled: true });
  await s('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_INIT });
  const evaluate = async expr => (await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  const go = url => s('Page.navigate', { url });
  return { s, evaluate, go, close: () => chrome.send('Target.closeTarget', { targetId }) };
}

async function until(fn, ms = 20000, step = 25) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) { const v = await fn(); if (v != null && v !== false) return v; }
  throw new Error('timed out');
}

// Waits for the dashboard to ask for stats, then to stop: no new /api call for a second.
async function settle(server) {
  await until(async () => (await getJSON(server.base + '/__bench/counts')).api > 0 || null, 15000, 50);
  let last = -1, still = 0;
  while (still < 1000) {
    const { api } = await getJSON(server.base + '/__bench/counts');
    if (api === last) still += 100; else { still = 0; last = api; }
    await sleep(100);
  }
}

const VIEWS = ['/', '/overview', '/sources', '/pages', '/bounce', '/sources/google.com', '/page/blog'];

// Counts are exact, so they come from one pass on a fresh server per view (nothing cached).
async function countsOf(root, chrome) {
  const out = {};
  for (const view of VIEWS) {
    const server = await startServer(root, false);
    const tab = await openTab(chrome, { throttle: 1 });
    try {
      await tab.go(server.base + view);
      await settle(server);
      const c = await getJSON(server.base + '/__bench/counts');
      out[`queries: ${view}`] = c.sql;
      out[`api calls: ${view}`] = c.api;
      if (view === '/') {
        // The same page again a moment later, as someone reloading it does.
        await getJSON(server.base + '/__bench/reset');
        await tab.go(server.base + view);
        await settle(server);
        out['queries: / reloaded'] = (await getJSON(server.base + '/__bench/counts')).sql;
      }
    } finally { await tab.close(); server.proc.kill(); }
  }
  // One visit: open a page, scroll to the end, leave. The first visit a Worker sees also sets up the
  // month's salt, so the second one is counted.
  const server = await startServer(root, false);
  const tab = await openTab(chrome, { throttle: 1 });
  try {
    for (const first of [true, false]) {
      await getJSON(server.base + '/__bench/reset');
      await tab.go(server.base + '/__bench/site.html');
      await until(() => tab.evaluate('document.readyState === "complete"'));
      await sleep(1200);
      await tab.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await sleep(1200);
      await tab.go('about:blank');
      await sleep(1500);
    }
    const c = await getJSON(server.base + '/__bench/counts');
    out['visit: requests'] = c.beacons;
    out['visit: writes'] = c.writes;
    out['visit: kv reads'] = c.kvReads;
    out['visit: kv writes'] = c.kvWrites;
  } finally { await tab.close(); server.proc.kill(); }
  return out;
}

async function browserTimes(server, chrome) {
  const tab = await openTab(chrome);
  try {
    // A few milliseconds each, so the median of five loads.
    const runs = [];
    for (let i = 0; i < 5; i++) {
      await tab.go(server.base + '/__bench/site.html?' + i);
      runs.push(await until(() => tab.evaluate('window.__t1 != null && window.__t1 - window.__t0')));
    }
    const tjs = runs.sort((a, b) => a - b)[2];
    await tab.go(server.base + '/');
    const drawn = await until(() => tab.evaluate('window.__drawn'));
    await sleep(300);
    const blocking = await tab.evaluate(`__long.filter(([s]) => s < ${drawn}).reduce((a, [, d]) => a + Math.max(0, d - 50), 0)`);
    return { 'browser: t.js run': tjs, 'browser: home drawn': drawn, 'browser: home blocking': blocking };
  } finally { await tab.close(); }
}

/* ---------- the run ---------- */

export async function run(opts) {
  const chromePath = opts.chrome || CHROMES.find(p => existsSync(p));
  if (!chromePath) throw new Error('no Chrome found; pass --chrome or set CHROME');
  let rev = 'unknown', dirty = false;
  try { rev = git('rev-parse', '--short', 'HEAD').trim(); dirty = git('status', '--porcelain', '--', 'src', 'public', 'dist').trim() !== ''; } catch {}
  const runSide = opts.run ? { rev: git('rev-parse', '--short', opts.run).trim(), root: exportRef(opts.run) } : { rev: rev + (dirty ? '+dirty' : ''), root: ROOT };
  const baseRef = opts.saveBaseline ? null : opts.aa ? null : opts.base || JSON.parse(readFileSync(join(ROOT, 'bench/baseline.json'), 'utf8')).rev;
  const baseSide = opts.saveBaseline ? null : opts.aa ? { ...runSide } : { rev: git('rev-parse', '--short', baseRef).trim(), root: exportRef(baseRef) };
  const sides = baseSide ? [baseSide, runSide] : [runSide];

  const chrome = launch(chromePath);
  const servers = [];
  try {
    const version = await chrome.send('Browser.getVersion');
    for (const side of sides) {
      side.bytes = bytesOf(side.root);
      side.counts = await countsOf(side.root, chrome);
      servers.push(await startServer(side.root, true));
    }
    // Warm both up once before measuring.
    for (let i = 0; i < sides.length; i++) await browserTimes(servers[i], chrome);
    const times = sides.map(() => ({}));
    for (let rep = 0; rep < opts.reps; rep++) {
      // Alternate which goes first, so neither always gets the warmer machine.
      const order = rep % 2 ? [...sides.keys()].reverse() : [...sides.keys()];
      for (const i of order) {
        const t = { ...workerTimes(sides[i].root), ...(await browserTimes(servers[i], chrome)) };
        for (const [k, v] of Object.entries(t)) (times[i][k] ||= []).push(r3(v));
      }
      process.stderr.write(`rep ${rep + 1}/${opts.reps}\r`);
    }
    process.stderr.write('\n');
    const strip = ({ root, ...rest }, t) => ({ ...rest, times: t });
    return {
      date: new Date().toISOString(), browser: version.product, reps: opts.reps,
      ...(baseSide ? { base: strip(baseSide, times[0]), run: strip(runSide, times[1]) } : { run: strip(runSide, times[0]) }),
    };
  } finally {
    for (const s of servers) s.proc.kill();
    chrome.close();
    for (const side of new Set([baseSide?.root, runSide.root])) if (side && side !== ROOT) rmSync(side, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  const out = await run(opts);
  const file = opts.saveBaseline ? join(ROOT, 'bench/baseline.json') : resolve(ROOT, opts.out || (opts.aa ? 'bench/runs/aa.json' : 'bench/runs/latest.json'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`${out.browser}, ${out.reps} reps → ${file}`);
  if (out.base) console.log(`judge with: node scripts/compare.mjs ${file}`);
}
