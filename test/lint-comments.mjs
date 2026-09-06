/**
 * Comments say what the code does now; history goes in commits and
 * docs/DECISIONS.md. This holds every source file to at most 25% comment
 * lines, so prose cannot quietly become the design record again.
 *
 *   node test/lint-comments.mjs          check, exit 1 on any file over
 *   node test/lint-comments.mjs --all    print every file, not just the failures
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DIRS = ['src', 'scripts', 'test'];
const LIMIT = 0.25;
const all = process.argv.includes('--all');

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(js|mjs)$/.test(name)) yield path;
  }
}

/** Comment lines and non-blank lines of one file. */
export function measure(text) {
  let inBlock = false;
  let comment = 0;
  let code = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    code++;
    if (inBlock) {
      comment++;
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('//')) { comment++; continue; }
    if (line.startsWith('/*')) {
      comment++;
      if (!line.includes('*/', 2)) inBlock = true;
    }
  }
  return { comment, code, ratio: code ? comment / code : 0 };
}

const rows = [];
for (const dir of DIRS) {
  for (const path of files(join(ROOT, dir))) {
    rows.push({ file: relative(ROOT, path), ...measure(readFileSync(path, 'utf8')) });
  }
}
rows.sort((a, b) => b.ratio - a.ratio);
let failed = 0;
for (const r of rows) {
  const over = r.ratio > LIMIT;
  if (over) failed++;
  if (over || all) {
    console.log(`${over ? ' FAIL ' : '  ok  '} ${(100 * r.ratio).toFixed(0).padStart(3)}%  ${String(r.comment).padStart(4)}/${String(r.code).padEnd(5)} ${r.file}`);
  }
}
console.log(failed ? `\n${failed} file${failed === 1 ? '' : 's'} over ${LIMIT * 100}% comment lines`
  : `\nall ${rows.length} files at or under ${LIMIT * 100}% comment lines`);
process.exit(failed ? 1 : 0);
