/**
 * Golden images: what the model looks like in a fixed set of poses.
 *
 * Every pose is rendered on a renderer of its own, reset, with physics frozen,
 * and compared against the PNG committed under test/golden/. The tolerance is
 * one rule for every pose and is never tuned per pose: a pixel differs when
 * any channel differs by more than 16, and a pose fails when more than 0.1% of
 * its pixels differ (at 320x320, that is 102 pixels). Anything else is a change of look, which is made on
 * purpose with --update and committed with the reason and the diff sheet.
 *
 *   node test/golden.mjs                 compare
 *   node test/golden.mjs --update        rewrite every golden
 *   node test/golden.mjs --only nod-up   one pose (with or without --update)
 *
 * Failures write test/out/golden/<pose>-actual.png and <pose>-diff.png, plus
 * golden-sheet.png with every actual frame.
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { boot, makeCheck, FROZEN, POSES, ROOT, ensureOut, savePng, loadPng, fromPage, diffImages, contactSheet } from './harness.mjs';

const CHANNEL_TOL = 16;
const MAX_DIFFERING = 0.001;
const SIZE = 320;
const FRAMES = 120;

const args = process.argv.slice(2);
const update = args.includes('--update');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const poses = only ? POSES.filter((p) => p.name === only) : POSES;
if (!poses.length) {
  console.error(`no pose named ${only}; known: ${POSES.map((p) => p.name).join(', ')}`);
  process.exit(2);
}

const GOLDEN_DIR = join(ROOT, 'test', 'golden');
const { check, finish } = makeCheck('golden');
const { page, errors, close } = await boot({ viewport: { width: 640, height: 640 } });

try {
  const frames = [];
  for (const pose of poses) {
    const started = Date.now();
    const shot = await page.evaluate(async ({ pose, frozen, size, frames }) => {
      const t = window.__t;
      const a = window.__goldenAvatar ?? (window.__goldenAvatar = await t.makeAvatar(size));
      t.resetStore({ ...frozen, ...(pose.settings ?? {}) });
      a.reset();
      const emptyRig = t.app().emptyRig;
      const drive = pose.drive ?? [[frames, pose.rig ?? {}]];
      for (const [count, mut] of drive) t.pose(a, emptyRig, mut, count);
      return t.readTopDown(a);
    }, { pose, frozen: FROZEN, size: SIZE, frames: FRAMES });
    const actual = fromPage(shot);
    frames.push(actual);
    const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;

    const file = join(GOLDEN_DIR, `${pose.name}.png`);
    if (update || !existsSync(file)) {
      savePng(file, actual);
      check(`${pose.name} ${update ? 'updated' : 'captured (no golden existed)'}`, true, `${took} ${file}`);
      continue;
    }
    const golden = loadPng(file);
    const { differing, total, sizeMismatch, diff } = diffImages(golden, actual, { channelTol: CHANNEL_TOL });
    const ok = !sizeMismatch && differing <= total * MAX_DIFFERING;
    check(`${pose.name} matches its golden`, ok,
      sizeMismatch ? `size ${actual.w}x${actual.h} vs ${golden.w}x${golden.h}`
        : `${differing} of ${total} pixels differ (${(100 * differing / total).toFixed(3)}%), ${took}`);
    if (!ok) {
      const out = ensureOut('golden');
      savePng(join(out, `${pose.name}-actual.png`), actual);
      if (diff) savePng(join(out, `${pose.name}-diff.png`), diff);
    }
  }
  const sheet = contactSheet(frames, 4);
  if (sheet) savePng(join(ensureOut('golden'), 'golden-sheet.png'), sheet);
  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('golden run completed', false, err.stack);
} finally {
  await close();
}
finish();
