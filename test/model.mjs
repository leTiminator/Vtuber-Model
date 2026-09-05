/**
 * The baked model in public/model/ninja/: the manifest describes the ninja
 * the way the cut found it, the part PNGs put the drawing back together, and
 * a fresh bake reproduces every byte that is committed.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { boot, makeCheck, ROOT } from './harness.mjs';

const DIR = join(ROOT, 'public/model/ninja');
const { check, finish } = makeCheck('model');

const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
const { width, height } = manifest;
const byName = Object.fromEntries(manifest.parts.map((p) => [p.name, p]));
/** Centre and half-size of the drawn art inside a part, as fractions of the image. */
const box = (p) => p && {
  cx: (p.x + p.inset + (p.w - 2 * p.inset) / 2) / width,
  cy: (p.y + p.inset + (p.h - 2 * p.inset) / 2) / height,
  hx: (p.w - 2 * p.inset) / 2 / width,
  hy: (p.h - 2 * p.inset) / 2 / height,
};

// --- what the manifest says ---------------------------------------------
const TURNED = ['tails', 'body', 'armLeft', 'armRight', 'tufts', 'wrap', 'head', 'eyeNear', 'eyeFar'];
const HEAD_ON = ['headOn', 'tuftsOn', 'eyeNearOn', 'eyeFarOn'];
check('the manifest has the nine parts of the drawing and the four of the head-on face',
  manifest.parts.length === 13 && [...TURNED, ...HEAD_ON].every((n) => byName[n]),
  manifest.parts.map((p) => p.name).join(', '));
check('parts are listed back to front',
  manifest.parts.every((p, i) => i === 0 || p.z >= manifest.parts[i - 1].z));

const { head, tufts, eyeNear, eyeFar, armLeft, armRight, body, wrap, tails } = byName;
const hb = box(head);
check('the head is the helmet, not just the visor', head?.pixels > 12000, `${head?.pixels}px`);
for (const name of ['eyeNear', 'eyeFar']) {
  const eb = box(byName[name]);
  check(`${name} sits inside the head`,
    eb && Math.abs(eb.cx - hb.cx) < hb.hx && Math.abs(eb.cy - hb.cy) < hb.hy,
    `${name} ${eb?.cx.toFixed(2)},${eb?.cy.toFixed(2)} head ${hb.cx.toFixed(2)},${hb.cy.toFixed(2)} ±${hb.hx.toFixed(2)},${hb.hy.toFixed(2)}`);
}
check('the eyes were cut apart, not halved',
  Math.abs(box(eyeNear).cx - box(eyeFar).cx) > 0.02,
  `near ${box(eyeNear).cx.toFixed(3)} far ${box(eyeFar).cx.toFixed(3)}`);
check('the near eye is the bigger of the two', eyeNear.pixels > eyeFar.pixels,
  `near ${eyeNear.pixels}px far ${eyeFar.pixels}px`);
check('the tufts sit above and behind the head',
  box(tufts).cy < hb.cy && box(tufts).cx < hb.cx,
  `tufts ${box(tufts).cx.toFixed(2)},${box(tufts).cy.toFixed(2)}`);
check('the tufts are hair, not half the helmet', tufts.pixels < head.pixels * 0.6,
  `tufts ${tufts.pixels}px vs head ${head.pixels}px`);
check('the arms are on opposite sides of the figure',
  box(armLeft).cx < box(armRight).cx - 0.2,
  `left ${box(armLeft).cx.toFixed(2)} right ${box(armRight).cx.toFixed(2)}`);
check('the body is below the head', box(body).cy > hb.cy, `body cy ${box(body).cy.toFixed(2)}`);
check('the neck wrap is drawn over the scarf tails and under the head',
  tails.z < wrap.z && wrap.z < head.z, `tails ${tails.z} wrap ${wrap.z} head ${head.z}`);
check('the arms carry a pivot and hang between neck and shoulder',
  [armLeft, armRight].every((a) => a.pivot?.length === 2 && a.joint === 'neck' && /^shoulder/.test(a.farJoint)));
check('the head-on pieces are placed over the turned head at about the same size',
  HEAD_ON.every((n) => byName[n].place && byName[n].place.k > 0.8 && byName[n].place.k < 1.6),
  `k ${byName.headOn.place?.k.toFixed(3)}, ${manifest.headOn.note}`);
check('the scarf has a spine of sixteen bones', manifest.spine?.nodes.length === 16 && manifest.spine.span > 0,
  `${manifest.spine?.nodes.length} nodes, ${(manifest.spine?.span * width).toFixed(0)}px apart`);
check('the scarf grid knows which of its vertices ride the chain',
  tails.flags.skinned && tails.onChain?.length === (tails.grid + 1) ** 2 && /1/.test(tails.onChain),
  `${tails.onChain?.length} vertices, ${(tails.onChain?.match(/1/g) ?? []).length} on the chain`);
check('both eye sockets were found, each mostly shard',
  manifest.sockets.length === 2 && manifest.sockets.every((s) => s.fill > 0.1 && s.fill < 1),
  manifest.sockets.map((s) => s.fill.toFixed(2)).join(', '));
check('the head span is the head part, not the marker guess',
  Math.abs(manifest.headSpan.cx - hb.cx) < 1e-4 && Math.abs(manifest.headSpan.cy - hb.cy) < 1e-4);

for (const p of manifest.parts) {
  const rgba = existsSync(join(DIR, p.png)) && PNG.sync.read(readFileSync(join(DIR, p.png)));
  const grey = existsSync(join(DIR, p.marginPng)) && PNG.sync.read(readFileSync(join(DIR, p.marginPng)));
  check(`${p.name}: both PNGs exist at ${p.w}x${p.h}`,
    rgba && grey && rgba.width === p.w && rgba.height === p.h && grey.width === p.w && grey.height === p.h,
    `${rgba ? `${rgba.width}x${rgba.height}` : 'no png'}, margin ${grey ? `${grey.width}x${grey.height}` : 'none'}`);
}

// --- the PNGs put the drawing back together ---------------------------------
const { page, errors, close } = await boot({ waitReady: false });
try {
  const result = await page.evaluate(async ({ parts, width, height }) => {
    const load = (src) => new Promise((done, fail) => {
      const img = new Image();
      img.onload = () => done(img);
      img.onerror = () => fail(new Error(`could not load ${src}`));
      img.src = src;
    });
    const art = await load('/art/BA_Ninja_TPBG.png');
    const stack = document.createElement('canvas');
    stack.width = width;
    stack.height = height;
    const s = stack.getContext('2d');
    for (const p of parts) {
      if (p.place) continue; // the head-on face is drawn over the head, not in the artwork
      s.drawImage(await load(`/model/ninja/${p.png}`), p.x, p.y);
    }
    const original = document.createElement('canvas');
    original.width = width;
    original.height = height;
    original.getContext('2d').drawImage(art, 0, 0);
    const a = s.getImageData(0, 0, width, height).data;
    const b = original.getContext('2d').getImageData(0, 0, width, height).data;
    let opaque = 0;
    let wrong = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (b[i + 3] > 40) opaque++;
      const near = Math.abs(a[i] - b[i]) < 12 && Math.abs(a[i + 1] - b[i + 1]) < 12
        && Math.abs(a[i + 2] - b[i + 2]) < 12 && Math.abs(a[i + 3] - b[i + 3]) < 40;
      if (!near) wrong++;
    }
    return { wrong, opaque };
  }, { parts: manifest.parts, width, height });
  const pct = (100 * result.wrong) / result.opaque;
  check('the committed parts reassemble into the artwork', pct < 0.5,
    `${result.wrong} wrong of ${result.opaque} opaque (${pct.toFixed(3)}%)`);
  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('reassembly completed', false, err.stack);
} finally {
  await close();
}

// --- a fresh bake reproduces what is committed --------------------------------
const bake = spawnSync(process.execPath, [join(ROOT, 'scripts/bake-model.mjs'), '--check'],
  { encoding: 'utf8', cwd: ROOT, timeout: 240000 });
const problems = (bake.stdout ?? '').split('\n').filter((l) => l.startsWith(' FAIL'));
check('a fresh bake reproduces the committed model byte for byte', bake.status === 0,
  bake.status === 0 ? (bake.stdout.match(/^\s+ok\s+.*$/gm) ?? []).length + ' files agree'
    : `${problems.slice(0, 4).join(' | ')}${bake.stderr ? ` | ${bake.stderr.slice(0, 300)}` : ''}`);

finish();
