/**
 * Run every suite and report all of them, rather than stopping at the first
 * failure the way an && chain does.
 *
 *   node test/run-all.mjs            every suite
 *   node test/run-all.mjs rig smoke  just those
 */
import { spawnSync } from 'node:child_process';

export const SUITES = ['rig', 'cloth', 'replay', 'model', 'invariants', 'golden', 'smoke', 'output'];

const wanted = process.argv.slice(2);
const list = wanted.length ? wanted : SUITES;
const rows = [];
for (const suite of list) {
  console.log(`\n=== ${suite} ===`);
  const started = Date.now();
  const run = spawnSync(process.execPath, [`test/${suite}.mjs`], { stdio: 'inherit' });
  rows.push({ suite, ok: run.status === 0, seconds: (Date.now() - started) / 1000 });
}
console.log('\n' + rows.map((r) =>
  `${r.ok ? 'PASS' : 'FAIL'}  ${r.suite.padEnd(12)} ${r.seconds.toFixed(1)}s`).join('\n'));
const total = rows.reduce((s, r) => s + r.seconds, 0);
console.log(`${rows.filter((r) => r.ok).length}/${rows.length} suites passed in ${total.toFixed(0)}s`);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
