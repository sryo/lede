// Writes the static sample published at sryo.github.io/lede: the dashboard from public/, with the
// Worker bundled for the browser (demo/main.js) answering its /api/* from the sample data. Nothing in public/
// changes, so the dashboard's bytes stay what the bench measures.
//   npm run demo [-- --base /lede/ --out demo-site]
// Without --out it goes to the system's temporary folder, so a local build never sits in the project going stale;
// the workflow names its own folder to publish.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as esbuild from 'esbuild';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const OUT = join(tmpdir(), 'lede-demo');
const PUBLIC = join(ROOT, 'public');
const ENTRY = join(ROOT, 'demo', 'main.js');
// Cloudflare's headers mean nothing to GitHub Pages, and the sample may be found by search. routes.js is inside
// the bundle, and the page names t.js only on the first-visit card, which the sample never shows.
const LEFT_OUT = ['_headers', 'robots.txt', 'routes.js', 't.js'];
// The Worker imports these from public/ too. The bundle asks for the page's own copies, so a visitor downloads
// each once and both sides run the same module.
const SHARED = ['story.js', 'hosts.js'];
// Where index.html points at its own files and modules; a second slash would be another host.
const OPENER = /(href="|src="|url\("|from ')\/(?!\/)/g;
// Attributes that name an address, in any quoting, for the forms OPENER leaves alone.
const ATTR = /\b(?:href|src|srcset|action|poster)=["']?\/(?!\/)/g;
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The page with every address of its own under base, importing the bundle in place of routes.js. Only OPENER's
// forms are rewritten, so it throws when the page names one of its files, or an address in an attribute, some
// other way (import '/x.js', url(/x), srcset=, href='/x'), and the build stops before publishing a broken sample.
export function rewrite(html, base, files = [], bundle = 'demo.js') {
  const out = html.replace(OPENER, `$1${base}`);
  const routes = `from '${base}routes.js'`;
  if (out.split(routes).length !== 2) throw new Error(`index.html must import from '/routes.js' exactly once; the sample swaps that import for its bundle.`);
  const page = out.replace(routes, `from '${base}${bundle}'`);
  if (base === '/') return page;
  const named = files.length ? [...page.matchAll(new RegExp(`(?<=["'\`(=\\s,])/(?:${files.map(escape).join('|')})(?![\\w.-])`, 'g'))] : [];
  const left = [...named, ...[...page.matchAll(ATTR)].filter(m => !page.startsWith(base, m.index + m[0].length - 1))];
  if (left.length) throw new Error(`index.html has addresses outside ${base}: ${left.map(m => page.slice(Math.max(0, m.index - 20), m.index + 30)).join(', ')}`);
  return page;
}

// out, resolved against the repo wherever the build runs, once it is safe to delete: empty, missing, or an
// earlier build. The repo, public/ and anything above or inside them are never cleared.
export function clearable(out) {
  const dir = resolve(ROOT, out);
  for (const keep of [ROOT, PUBLIC]) {
    if (keep === dir || keep.startsWith(dir + sep) || (keep === PUBLIC && dir.startsWith(keep + sep))) throw new Error(`The build won't clear ${dir}: it holds ${keep === ROOT ? 'the repo' : 'public/'}.`);
  }
  const has = existsSync(dir) ? readdirSync(dir) : [];
  if (has.length && !(has.includes('demo.js') && has.includes('404.html'))) throw new Error(`The build won't clear ${dir}: it isn't empty or an earlier build.`);
  return dir;
}

export async function build({ out = OUT, base = '/lede/' } = {}) {
  if (!base.startsWith('/') || !base.endsWith('/')) throw new Error(`The base starts and ends with a slash, like /lede/; got ${base}.`);
  const dir = clearable(out);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(PUBLIC, { withFileTypes: true })) if (f.isFile() && !LEFT_OUT.includes(f.name)) copyFileSync(join(PUBLIC, f.name), join(dir, f.name));
  const shared = { name: 'shared', setup(b) {
    b.onResolve({ filter: /\.js$/ }, a => {
      const f = SHARED.find(f => join(a.resolveDir, a.path) === join(PUBLIC, f));
      if (f) return { path: base + f, external: true };
    });
  } };
  await esbuild.build({ entryPoints: [ENTRY], outfile: join(dir, 'demo.js'), bundle: true, format: 'esm', platform: 'browser',
    minify: true, legalComments: 'none', define: { DEMO_BASE: JSON.stringify(base) }, plugins: [shared], logLevel: 'warning' });
  // Pages caches every file for a while with no hash in its name, so the page asks for this build's bundle by
  // its contents, and an old bundle is never run beside a new page.
  const v = createHash('sha256').update(readFileSync(join(dir, 'demo.js'))).digest('hex').slice(0, 8);
  const page = rewrite(readFileSync(join(PUBLIC, 'index.html'), 'utf8'), base, readdirSync(dir), `demo.js?v=${v}`);
  // Pages answers any missing address with 404.html, so a deep link or a reload opens the dashboard too.
  for (const f of ['index.html', '404.html']) writeFileSync(join(dir, f), page);
  return dir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { base: { type: 'string', default: '/lede/' }, out: { type: 'string', default: OUT } } });
  console.log(`${await build(values)}/ written for ${values.base}, from public/ and demo/main.js`);
}
