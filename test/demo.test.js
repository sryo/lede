import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as routes from '../public/routes.js';
import { demoFetch, demoEnv, memoryKV, withBase } from '../demo/runtime.js';
import { build, rewrite, clearable } from '../scripts/build-demo.mjs';

const ORIGIN = 'https://sryo.github.io';
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VIEWS = [null, { v: 'overview' }, { v: 'sources' }, { v: 'pages' }, { v: 'filter', f: { referrer: 'google.com' } },
  { v: 'filter', f: { referrer: '' } }, { v: 'filter', f: { channel: 'ai' } }, { v: 'filter', f: { path: '/docs/install' } }, { v: 'filter', f: { path: '/' } }];

// A fetch for everything the demo hands back to the network, which keeps what it was asked.
function network() {
  const calls = [];
  const realFetch = async (input, init) => { calls.push(String(input instanceof Request ? input.url : input)); return new Response('from the network'); };
  return { calls, fetch: demoFetch(realFetch, ORIGIN) };
}

test('the sample under a base path keeps every address under it', () => {
  const r = withBase('/lede/', routes);
  assert.equal(r.viewToUrl(null), '/lede/');
  assert.equal(r.viewToUrl({ v: 'sources' }), '/lede/sources');
  assert.equal(r.viewToUrl({ v: 'sources' }, { days: 7 }), '/lede/sources?days=7');
  assert.equal(r.viewToUrl({ v: 'filter', f: { path: '/docs/install' } }), '/lede/page/docs/install');
  assert.deepEqual(r.urlToView('/lede/sources/google.com', '').view, { v: 'filter', f: { referrer: 'google.com' } });
  assert.equal(r.urlToView('/lede/', '').view, null);
  assert.equal(r.urlToView('/lede', '').view, null);
  for (const v of VIEWS) {
    const u = new URL(r.viewToUrl(v, { days: 7 }), ORIGIN);
    assert.deepEqual(r.urlToView(u.pathname, u.search), { view: v, days: 7, site: null });
  }
});

test('a base of / changes nothing', () => {
  const r = withBase('/', routes);
  for (const v of VIEWS) {
    assert.equal(r.viewToUrl(v, { days: 7 }), routes.viewToUrl(v, { days: 7 }));
    const p = routes.viewToUrl(v);
    assert.deepEqual(r.urlToView(p, '?days=7'), routes.urlToView(p, '?days=7'));
  }
});

test('the in-memory store reads back what was put, as text or JSON', async () => {
  const kv = memoryKV({ a: '1' });
  assert.equal(await kv.get('a'), '1');
  assert.equal(await kv.get('none'), null);
  await kv.put('b', JSON.stringify({ x: 1 }));
  assert.deepEqual(await kv.get('b', 'json'), { x: 1 });
  await kv.delete('b');
  assert.equal(await kv.get('b'), null);
});

test('the API is answered from the sample, in the page', async () => {
  const { calls, fetch } = network();
  for (const init of [undefined, { cache: 'no-store' }]) {
    const r = await fetch('/api/sites', init);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.sites, ['example.com']);
    assert.equal(body.demo, true);
  }
  const s = await fetch('/api/summary?site=example.com&days=30&tz=0');
  assert.equal(s.status, 200);
  assert.ok((await s.json()).cur);
  const line = await fetch('/api/insight?site=example.com&days=30&tz=0');
  assert.equal(line.status, 200);
  assert.ok((await line.json()).text);
  const shot = await fetch('/api/shot?site=example.com&path=%2Fowls');
  assert.equal(shot.status, 200);
  assert.equal(calls.length, 0);
});

test('goals and notes are kept until the page reloads', async () => {
  const { calls, fetch } = network();
  const put = await fetch('/api/goals?site=example.com', { method: 'PUT', body: JSON.stringify({ goals: ['/nests'] }) });
  assert.equal(put.status, 200);
  const got = await (await fetch('/api/goals?site=example.com&days=30&tz=0', { cache: 'no-store' })).json();
  assert.deepEqual(got.goals, ['/nests']);
  const note = await fetch('/api/notes?site=example.com', { method: 'PUT', body: JSON.stringify({ day: '2026-10-16', text: 'Posted on Hacker News' }) });
  assert.equal(note.status, 200);
  assert.ok((await note.json()).notes.some(n => n.day === '2026-10-16'));
  const gone = await fetch('/api/notes?site=example.com&day=2026-10-16', { method: 'DELETE' });
  assert.equal(gone.status, 200);
  assert.ok(!(await gone.json()).notes.some(n => n.day === '2026-10-16'));
  // Another page load starts from the sample again.
  const fresh = demoFetch(async () => new Response(''), ORIGIN);
  assert.deepEqual((await (await fresh('/api/goals?site=example.com')).json()).goals, []);
  assert.equal(calls.length, 0);
});

test('share links are refused with a message, and listing them finds none', async () => {
  const { calls, fetch } = network();
  for (const [method, path] of [['POST', '/api/shares'], ['DELETE', '/api/shares?token=x']]) {
    const r = await fetch(path, { method, body: method === 'POST' ? JSON.stringify({ site: 'example.com' }) : undefined });
    assert.equal(r.status, 403);
    assert.ok((await r.json()).error);
  }
  const list = await fetch('/api/shares');
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).shares, []);
  assert.equal(calls.length, 0);
});

test('everything but the API goes to the network, and the Worker never sees it', async () => {
  const env = demoEnv(), seen = [];
  const store = env.STORE, put = store.put;
  store.put = (k, v) => { seen.push(k); return put(k, v); };
  const calls = [];
  const fetch = demoFetch(async input => { calls.push(String(input)); return new Response('ok'); }, ORIGIN, env);
  for (const path of ['/story.js', '/lede', 'https://other.example/api/sites', '/s/abc']) {
    assert.equal(await (await fetch(path)).text(), 'ok');
  }
  assert.deepEqual(calls, ['/story.js', '/lede', 'https://other.example/api/sites', '/s/abc']);
  assert.deepEqual(seen, []);
});

const sums = dir => readdirSync(dir).sort().map(f => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')]);

const sha = buf => createHash('sha256').update(buf).digest('hex');

test('the build puts every address under the base, and the page and the bundle share one story', async t => {
  const before = sums(PUBLIC);
  const out = mkdtempSync(join(tmpdir(), 'lede-demo-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  await build({ out, base: '/lede/' });
  assert.deepEqual(sums(PUBLIC), before, 'public/ is left as it was');
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  for (const m of html.matchAll(/(?:href="|src="|url\("|from ')\/(?!\/)(.{0,5})/g)) assert.equal(m[1], 'lede/', m[0]);
  assert.ok(html.includes(`from '/lede/demo.js?v=${sha(readFileSync(join(out, 'demo.js'))).slice(0, 8)}'`), 'the page asks for this build of the bundle');
  assert.ok(!/from '[^']*routes\.js'/.test(html));
  assert.ok(readFileSync(join(out, '404.html')).equals(readFileSync(join(out, 'index.html'))));
  // Names are compared exactly, as Pages does, and not through a file system that may ignore case.
  const files = readdirSync(out);
  for (const f of ['_headers', 'robots.txt', 'routes.js', 't.js']) assert.ok(!files.includes(f), f);
  for (const [, name] of html.matchAll(/\/lede\/([\w.-]+)/g)) assert.ok(files.includes(name), name);
  const bundle = readFileSync(join(out, 'demo.js'), 'utf8');
  for (const f of ['story.js', 'hosts.js']) assert.match(bundle, new RegExp(`from\\s*"/lede/${f.replace('.', '\\.')}"`), f);
  assert.ok(!bundle.includes('function readStory'), 'story.js is loaded once, not bundled again');
});

test('the bundle runs on its own, as the page loads it', async t => {
  const out = mkdtempSync(join(tmpdir(), 'lede-demo-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  // With the folder itself as the base, the bundle's imports of story.js and hosts.js find the built copies.
  const base = out + '/';
  await build({ out, base });
  const saved = { fetch: globalThis.fetch, window: Object.getOwnPropertyDescriptor(globalThis, 'window'), location: Object.getOwnPropertyDescriptor(globalThis, 'location') };
  try {
    globalThis.window = globalThis;
    globalThis.location = new URL('https://sryo.github.io/lede/');
    const mod = await import(pathToFileURL(join(out, 'demo.js')).href);
    assert.equal(mod.viewToUrl({ v: 'sources' }), base + 'sources');
    assert.equal(mod.urlToView(base + 'sources', '').view.v, 'sources');
    const body = await (await globalThis.fetch('/api/sites')).json();
    assert.equal(body.demo, true);
    const line = await globalThis.fetch('/api/insight?site=example.com&days=30&tz=0');
    assert.ok((await line.json()).text);
  } finally {
    globalThis.fetch = saved.fetch;
    for (const k of ['window', 'location']) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k];
    }
  }
});

test('the build clears only an empty folder or an earlier build, inside the repo or out of it', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'lede-demo-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  for (const out of [ROOT, PUBLIC, dirname(ROOT), join(ROOT, 'src'), '.', 'public']) assert.throws(() => clearable(out), /won't clear/, out);
  const kept = join(tmp, 'kept');
  mkdirSync(kept);
  writeFileSync(join(kept, 'notes.txt'), 'mine');
  await assert.rejects(build({ out: kept }), /won't clear/);
  assert.equal(readFileSync(join(kept, 'notes.txt'), 'utf8'), 'mine');
  assert.equal(clearable('demo-site'), join(ROOT, 'demo-site'), 'a relative folder is the repo\'s, wherever the build runs');
  assert.equal(clearable(join(tmp, 'new')), join(tmp, 'new'));
  await build({ out: join(tmp, 'new') });
  assert.equal(clearable(join(tmp, 'new')), join(tmp, 'new'), 'an earlier build is cleared again');
});

test('the build stops unless the page imports from /routes.js exactly once', () => {
  assert.throws(() => rewrite('<script type="module">import { x } from \'/story.js\';</script>', '/lede/'), /routes\.js/);
  assert.throws(() => rewrite("import a from '/routes.js'; import b from '/routes.js';", '/lede/'), /routes\.js/);
  const html = rewrite('<link href="/icon.svg"><a href="//cdn.example/x"></a><script>fetch(\'/api/sites\')</script>import { v } from \'/routes.js\';', '/lede/');
  assert.ok(html.includes('href="/lede/icon.svg"'));
  assert.ok(html.includes('href="//cdn.example/x"'));
  assert.ok(html.includes("fetch('/api/sites')"));
  assert.ok(html.includes("from '/lede/demo.js'"));
});

test('the build stops when the page points at its own files in a way it does not rewrite', () => {
  const routes = "import { v } from '/routes.js';";
  for (const stray of ["import '/story.js';", "import('/story.js')", 'url(/icon.svg)', "url('/icon.svg')", 'srcset="/icon.svg 1x, /icon.svg 2x"',
    "href='/sources'", 'action="/"']) {
    assert.throws(() => rewrite(stray + routes, '/lede/', ['story.js', 'icon.svg']), /outside \/lede\//, stray);
  }
  // The path / in the page's code, a tag's closing /> and the tracker line for the Worker's own origin are not its files.
  rewrite("f.path==='/'; '<path d=\"M0\"/>'; `${location.origin}/t.js`; public/story.js" + routes, '/lede/', ['story.js']);
});

test('the sample’s last half hour is about as busy as its hours say a usual one is', async () => {
  const { demoStore } = await import('../src/demo.js');
  const { parseQuery } = await import('../src/api.js');
  const { onlinePace } = await import('../public/story.js');
  const q = parseQuery(new URL('https://x/api/hourly?site=example.com&days=30&tz=0'), ['example.com']);
  const P = onlinePace(await demoStore.live(q), await demoStore.hourly(q), Date.now() / 1000);
  if (P) assert.ok(P.ratio > .6 && P.ratio < 1.75, `ratio ${P.ratio.toFixed(2)}`);
});
