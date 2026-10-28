// Writes public/t.js, the tracker sites load, from src/tracker.js without its comment lines and
// blank lines, so the readable copy can say as much as it needs without sites paying for it.
//   npm run tracker
// The rule is line by line and deliberately simple: a line is dropped only when it is empty or
// starts with //. Anything after code on the same line stays, so text inside a string or a regex
// is never touched. A string that runs over lines (a template literal or a line ending in \) is
// refused, since one of its lines could look like a comment or be blank.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HEADER = '// Generated from src/tracker.js by `npm run tracker`. Edit that file, not this one.';

export function strip(source) {
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    if (line.includes('`') || line.endsWith('\\')) throw new Error(`src/tracker.js line ${i + 1}: a string that runs over lines can't be stripped line by line`);
  });
  return [HEADER, ...lines.filter(l => l.trim() && !l.trim().startsWith('//'))].join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = new URL('../src/tracker.js', import.meta.url), out = new URL('../public/t.js', import.meta.url);
  writeFileSync(out, strip(readFileSync(src, 'utf8')));
  console.log('public/t.js written from src/tracker.js');
}
