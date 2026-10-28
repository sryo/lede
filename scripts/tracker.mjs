// Writes public/t.js, the tracker sites load, from src/tracker.js, minified with esbuild, so the
// readable copy can say as much as it needs without sites paying for it.
//   npm run tracker
// The target is the oldest browsers Lede counts (OLDEST in src/bots.js), so esbuild never writes
// syntax a counted browser can't run.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

export const HEADER = '// Generated from src/tracker.js by `npm run tracker`. Edit that file, not this one.';
const TARGET = ['chrome90', 'firefox78', 'safari12'];

export function build(source) {
  return HEADER + '\n' + transformSync(source, { minify: true, target: TARGET, legalComments: 'none' }).code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = new URL('../src/tracker.js', import.meta.url), out = new URL('../public/t.js', import.meta.url);
  writeFileSync(out, build(readFileSync(src, 'utf8')));
  console.log('public/t.js written from src/tracker.js');
}
