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

  // --- the cut itself, on drawings it was not made for ------------------------
  const odd = await page.evaluate(async () => {
    const { cutParts } = await import('/scripts/bake/cut.js');
    const make = (draw) => {
      const c = document.createElement('canvas');
      c.width = 240;
      c.height = 240;
      draw(c.getContext('2d'));
      return Object.assign(c, { naturalWidth: c.width, naturalHeight: c.height });
    };
    const markers = {
      headX: 0.5, headY: 0.3, headR: 0.2, pivotX: 0.5, pivotY: 0.52, waistY: 0.78,
      eyeL: [0.41, 0.27, 0.48, 0.32], eyeR: [0.52, 0.27, 0.59, 0.32], eyeAngle: 0,
    };
    const cases = {
      colourless: (g) => { g.fillStyle = '#6a6a70'; g.fillRect(60, 30, 120, 190); },
      allCloth: (g) => { g.fillStyle = '#d12029'; g.fillRect(40, 20, 160, 200); },
      empty: () => {},
      specks: (g) => { g.fillStyle = '#333'; for (let i = 0; i < 40; i++) g.fillRect(i * 5, i * 5, 2, 2); },
    };
    const out = {};
    for (const [name, draw] of Object.entries(cases)) {
      try {
        const { parts } = cutParts(make(draw), markers);
        out[name] = `${parts.length} parts: ${parts.map((p) => p.name).join('/') || 'none'}`;
      } catch (err) {
        out[name] = `THREW ${err.message}`;
      }
    }
    return out;
  });
  for (const [name, verdict] of Object.entries(odd)) {
    check(`unfamiliar artwork (${name}) cuts without throwing`, !verdict.startsWith('THREW'), verdict);
  }

  // --- the repair of a keyed-out drawing ----------------------------------------
  const repaired = await page.evaluate(async (markers) => {
    const { repairKeyedHoles } = await import('/scripts/bake/repair.js');
    const { cutParts } = await import('/scripts/bake/cut.js');
    const { detectMarkers, readPixels } = await import('/scripts/bake/markers.js');
    const load = (src) => new Promise((done, fail) => {
      const img = new Image();
      img.onload = () => done(img);
      img.onerror = () => fail(new Error(`could not load ${src}`));
      img.src = src;
    });
    const view = await load('/art/views/head-front-open.png');
    const countIn = (source, box, test) => {
      const c = document.createElement('canvas');
      c.width = 630; c.height = 630;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(source, 0, 0);
      const d = g.getImageData(...box).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (test(d, i)) n++;
      return n;
    };
    const white = (d, i) => d[i + 3] > 200 && d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200;
    const opaque = (d, i) => d[i + 3] > 200;
    const before = countIn(view, [380, 330, 160, 70], white);
    const fixed = repairKeyedHoles(view);
    const after = countIn(fixed.canvas, [380, 330, 160, 70], white);
    const loopBefore = countIn(view, [120, 160, 220, 100], opaque);
    const loopAfter = countIn(fixed.canvas, [120, 160, 220, 100], opaque);
    const front = { ...markers, ...detectMarkers(readPixels(fixed.canvas)) };
    const cut = cutParts(fixed.canvas, front, { minShard: 40 });
    return {
      before, after, filled: fixed.filled, holes: fixed.holes, loopBefore, loopAfter,
      eyes: cut.parts.filter((p) => p.name.startsWith('eye')).map((p) => p.name),
      sockets: cut.sockets?.length ?? 0,
      fills: (cut.sockets ?? []).map((b) => +b.fill.toFixed(2)),
    };
  }, manifest.markers);
  check('the keyed-out eyes come back into a head-on drawing',
    repaired.after > repaired.before * 2 && repaired.filled > 100,
    `${repaired.before}px of white eye before, ${repaired.after}px after (${repaired.filled}px over ${repaired.holes} patches)`);
  check('a hole the drawing means to have is left alone',
    repaired.loopAfter <= repaired.loopBefore + 40 && repaired.loopBefore < 12000,
    `${repaired.loopBefore}px of paint in the box round the scarf's loop before, ${repaired.loopAfter}px after, of 22000`);
  check('and the repaired drawing cuts into two eyes',
    repaired.eyes.length === 2 && repaired.sockets === 2,
    `${repaired.eyes.join('+') || 'none'}, ${repaired.sockets} sockets`);
  check('and each socket knows how much of it is shard',
    repaired.fills.length === 2 && repaired.fills.every((f) => f > 0.1 && f < 1), repaired.fills.join(', '));

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('browser checks completed', false, err.stack);
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
