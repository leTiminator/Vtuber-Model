/**
 * Properties any correct build of this model has, measured on renders.
 *
 * Nothing here is a number tuned to what the renderer happens to draw today;
 * the goldens carry the look. These are the things that would be wrong in
 * any renderer: the parts reassemble to the drawing, the character is one
 * piece, cel art has no translucent interior, turning a feature on changes
 * pixels and turning it off changes them back, a nod goes the way the owner
 * confirmed, a blink shuts the eye, the face latch does not flicker, and a
 * turn is continuous.
 *
 *   node test/invariants.mjs
 */
import { boot, makeCheck, FROZEN } from './harness.mjs';

const { check, finish } = makeCheck('invariant');
const started = Date.now();
const { page, errors, close } = await boot({ viewport: { width: 480, height: 480 } });

/** Page-side analysis shared by the blocks below. */
const ANALYSIS = `
window.__inv = {
  // Head circle in buffer pixels (bottom-up rows), from the renderer's own span.
  headCircle(a) {
    const { computeFrame } = window.__framing;
    const gl = a.gl;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const s = window.__t.store();
    const f = computeFrame(a.aspect, w, h, s.get('stage.zoom'), s.get('stage.offsetX'), s.get('stage.offsetY'));
    const hs = a.headSpan;
    const cx = (f.ox + hs.cx * f.sx) * w;
    const cyTop = (f.oy + hs.cy * f.sy) * h;
    return { cx, cy: h - 1 - cyTop, r: hs.r * f.sy * h };
  },
  inHead(circle, p, w, scale = 1) {
    const x = p % w, y = (p - x) / w;
    return Math.hypot(x - circle.cx, y - circle.cy) <= circle.r * scale;
  },
  // Pixels that differ past a channel tolerance, split by inside/outside the head.
  diff(A, B, circle, scale = 1.6) {
    let inside = 0, outside = 0;
    for (let p = 0; p < A.w * A.h; p++) {
      const i = p * 4;
      const bad = Math.abs(A.d[i] - B.d[i]) > 16 || Math.abs(A.d[i+1] - B.d[i+1]) > 16
        || Math.abs(A.d[i+2] - B.d[i+2]) > 16 || Math.abs(A.d[i+3] - B.d[i+3]) > 16;
      if (!bad) continue;
      if (this.inHead(circle, p, A.w, scale)) inside++; else outside++;
    }
    return { inside, outside };
  },
  // Near-white pixels: on this character, only the eye shards.
  bright(img, circle) {
    let n = 0, sx = 0, sy = 0;
    for (let p = 0; p < img.w * img.h; p++) {
      const i = p * 4;
      if (img.d[i+3] < 200 || img.d[i] < 215 || img.d[i+1] < 215 || img.d[i+2] < 215) continue;
      if (circle && !this.inHead(circle, p, img.w, 1.3)) continue;
      n++; sx += p % img.w; sy += (p - (p % img.w)) / img.w;
    }
    return { n, cx: n ? sx / n : 0, cy: n ? sy / n : 0 };
  },
  // Every pixel drawn in A is also drawn in B (A adds no coverage).
  coveredBy(A, B) {
    let stray = 0;
    for (let p = 0; p < A.w * A.h; p++) if (A.d[p*4+3] > 24 && B.d[p*4+3] <= 24) stray++;
    return stray;
  },
};
`;

try {
  await page.evaluate(async (analysis) => {
    window.__framing = await import('/src/core/framing.js');
    eval(analysis);
    window.__a = await window.__t.makeAvatar(320);
  }, ANALYSIS);

  /* --- the boot -------------------------------------------------------- */
  const bootState = await page.evaluate(() => {
    const { avatars, current } = window.__vtuber;
    const a = avatars.parts2d;
    return {
      mounted: current === a,
      names: a.parts.map((p) => p.name),
      spine: Boolean(a.spine),
      headOn: a.headOn,
      note: a.headOnNote,
    };
  });
  const HEAD_ON = ['headOn', 'tuftsOn', 'eyeNearOn', 'eyeFarOn'];
  check('a clean profile mounts the parts model', bootState.mounted);
  check('the model has both faces, a scarf skeleton and 13 parts',
    bootState.names.length === 13 && HEAD_ON.every((n) => bootState.names.includes(n)) && bootState.spine
      && bootState.headOn,
    `${bootState.names.length} parts; head-on ${bootState.note}`);

  /* --- at rest the render is the drawing -------------------------------- */
  const rest = await page.evaluate(async (frozen) => {
    const t = window.__t;
    const a = window.__a;
    const { computeFrame } = window.__framing;
    const art = await new Promise((done, fail) => {
      const img = new Image();
      img.onload = () => done(img);
      img.onerror = () => fail(new Error('artwork did not load'));
      img.src = '/art/BA_Ninja_TPBG.png';
    });
    t.resetStore({ ...frozen, 'stage.zoom': 1, 'parts.headOn': 0, 'warp.eyeGlow': 0, 'parts.contactShadow': 0 });
    a.reset();
    t.pose(a, t.app().emptyRig, {}, 60);
    const shot = t.read(a);
    const f = computeFrame(a.aspect, shot.w, shot.h, 1, 0, 0);
    const ref = document.createElement('canvas');
    ref.width = shot.w; ref.height = shot.h;
    const g = ref.getContext('2d');
    g.drawImage(art, f.ox * shot.w, f.oy * shot.h, f.sx * shot.w, f.sy * shot.h);
    const r = g.getImageData(0, 0, shot.w, shot.h).data;
    let solid = 0, wrong = 0;
    for (let i = 0; i < r.length; i += 4) {
      const p = i / 4, x = p % shot.w, y = (p - x) / shot.w;
      const q = ((shot.h - 1 - y) * shot.w + x) * 4;
      if (r[i + 3] < 200) continue;
      solid++;
      if (Math.abs(shot.d[q] - r[i]) + Math.abs(shot.d[q + 1] - r[i + 1]) + Math.abs(shot.d[q + 2] - r[i + 2]) > 110) wrong++;
    }
    return { solid, wrong, pct: (100 * wrong) / Math.max(solid, 1) };
  }, FROZEN);
  // The one tolerance carried over: it is about the pipeline reproducing the
  // drawing through joints and framing, not about how the model looks.
  check('the rendered rest pose is the artwork', rest.pct < 3.2,
    `${rest.wrong} of ${rest.solid} solid pixels differ (${rest.pct.toFixed(2)}%)`);

  /* --- one piece, no translucent interior, across poses and settings ----- */
  const pieces = await page.evaluate((frozen) => {
    const t = window.__t;
    const a = window.__a;
    const poses = [{}, { head: { yaw: -0.6 } }, { head: { yaw: 0.6 } }, { head: { pitch: 0.35 } },
      { head: { pitch: -0.35 } }, { head: { roll: 0.3, yaw: -0.3 } }];
    const out = [];
    for (const shadow of [0.34, 0]) {
      for (const [k, mut] of poses.entries()) {
        t.resetStore({ ...frozen, 'stage.zoom': 0.6, 'parts.contactShadow': shadow,
          'warp.clothWeight': 1, 'body.hairPhysics': 1 });
        a.reset();
        t.pose(a, t.app().emptyRig, mut, 30);
        const img = t.read(a);
        const st = t.stats(img);
        out.push({ pose: k, shadow, blobs: t.blobs(img, 30), opaque: st.opaque,
          partial: st.partial / Math.max(st.opaque, 1) });
      }
    }
    return out;
  }, FROZEN);
  const torn = pieces.filter((p) => p.blobs !== 1);
  check('the character renders as exactly one piece in every pose and setting',
    torn.length === 0 && pieces.every((p) => p.opaque > 2000),
    torn.map((p) => `pose ${p.pose} shadow ${p.shadow}: ${p.blobs} pieces`).join('; ') || `${pieces.length} renders`);
  const worstPartial = Math.max(...pieces.map((p) => p.partial));
  check('cel art stays opaque: only edges are partially transparent', worstPartial < 0.2,
    `worst ${(worstPartial * 100).toFixed(1)}% of drawn pixels partial`);

  /* --- differentials: on versus off ------------------------------------- */
  const diffs = await page.evaluate((frozen) => {
    const t = window.__t;
    const inv = window.__inv;
    const a = window.__a;
    const shot = (settings, mut = {}, frames = 30) => {
      t.resetStore({ ...frozen, ...settings });
      a.reset();
      t.pose(a, t.app().emptyRig, mut, frames);
      return t.read(a);
    };
    // Measured at the framing the shots use, not whatever the last block left.
    t.resetStore(frozen);
    const circle = inv.headCircle(a);

    const glowOn = shot({ 'warp.eyeGlow': 0.7 });
    const glowOff = shot({ 'warp.eyeGlow': 0 });
    const glow = inv.diff(glowOn, glowOff, circle);

    const shadeOn = shot({ 'parts.contactShadow': 0.34 });
    const shadeOff = shot({ 'parts.contactShadow': 0 });
    const shade = { ...inv.diff(shadeOn, shadeOff, circle, 99), stray: inv.coveredBy(shadeOn, shadeOff) };

    // The head-on drawing swaps the head, its hair and its eyes; its hair
    // reaches past the hood, so the bound is the renderer's own idea of where
    // the head's influence ends, 2.3 radii (FOLLOW_NONE in parts/index.js).
    const faceOn = shot({ 'parts.headOn': 1 });
    const faceOff = shot({ 'parts.headOn': 0 });
    const face = inv.diff(faceOn, faceOff, circle, 2.3);

    const eyes = (settings, mut) => inv.bright(shot(settings, mut), inv.headCircle(a));
    const open = eyes({ 'warp.eyeGlow': 0 });
    const shut = eyes({ 'warp.eyeGlow': 0 }, { eyes: { blinkL: 1, blinkR: 1 } });
    const half = eyes({ 'warp.eyeGlow': 0 }, { eyes: { blinkL: 0.5, blinkR: 0.5 } });

    const up = eyes({ 'warp.eyeGlow': 0 }, { head: { pitch: 0.38 } });
    const down = eyes({ 'warp.eyeGlow': 0 }, { head: { pitch: -0.38 } });
    return { glow, shade, face, open, shut, half, up, down, circle };
  }, FROZEN);
  check('the eye glow lights pixels, and only on the head',
    diffs.glow.inside > 50 && diffs.glow.outside === 0,
    `${diffs.glow.inside} inside, ${diffs.glow.outside} outside the head`);
  check('the contact shadow darkens the character and never the background',
    diffs.shade.inside > 100 && diffs.shade.stray === 0,
    `${diffs.shade.inside} pixels shaded, ${diffs.shade.stray} on the background`);
  check('the head-on face is a different drawing of the head, and nothing below it changes',
    diffs.face.inside > 200 && diffs.face.outside === 0,
    `${diffs.face.inside} within 2.3 head radii, ${diffs.face.outside} beyond`);
  check('the eyes are lit when open and unlit when shut', diffs.open.n > 100 && diffs.shut.n === 0,
    `${diffs.open.n} bright pixels open, ${diffs.shut.n} shut`);
  check('a half blink lands between the two', diffs.half.n > 0 && diffs.half.n < diffs.open.n * 0.9,
    `${diffs.half.n} bright pixels at half`);
  // Rows are bottom-up in the buffer, so "higher on screen" is a larger cy.
  // (head.flipNod acts in the rig, before the renderer; test/rig.mjs covers it.)
  check('looking up lifts the face and looking down lowers it', diffs.up.cy > diffs.down.cy + 4,
    `eyes at ${diffs.up.cy.toFixed(1)} up, ${diffs.down.cy.toFixed(1)} down`);

  /* --- the face latch does not flicker ----------------------------------- */
  const latch = await page.evaluate((frozen) => {
    const t = window.__t;
    const a = window.__a;
    const emptyRig = t.app().emptyRig;
    const run = (yawAt, frames) => {
      t.resetStore(frozen);
      a.reset();
      let changes = 0;
      let last = a.faceOn;
      for (let f = 0; f < frames; f++) {
        const rig = emptyRig();
        rig.head.yaw = yawAt(f / 60);
        a.render(rig, 1 / 60);
        if (a.faceOn !== last) { changes++; last = a.faceOn; }
      }
      return { changes, faceOn: a.faceOn };
    };
    // Talking: eight degrees either side of centre, for four seconds.
    const chat = run((s) => 0.14 * Math.sin(s * 5), 240);
    // A real turn: a ramp to twenty-five degrees over two seconds, then held.
    const turn = run((s) => Math.min(s / 2, 1) * 0.436, 240);
    return { chat, turn };
  }, FROZEN);
  check('ordinary talking never changes the face', latch.chat.changes === 0 && latch.chat.faceOn,
    `${latch.chat.changes} changes`);
  check('a real turn changes it once', latch.turn.changes === 1 && !latch.turn.faceOn,
    `${latch.turn.changes} changes, head-on ${latch.turn.faceOn}`);

  /* --- a turn is continuous, all the way to the limit -------------------- */
  const creep = await page.evaluate((frozen) => {
    const t = window.__t;
    const a = window.__a;
    const emptyRig = t.app().emptyRig;
    const out = {};
    for (const sign of [-1, 1]) {
      t.resetStore({ ...frozen, 'stage.zoom': 0.6, 'parts.headOn': 0 });
      a.reset();
      const steps = [];
      let prev = null;
      for (let deg = 0; deg <= 42; deg += 2) {
        const rig = emptyRig();
        rig.head.yaw = sign * deg * Math.PI / 180;
        for (let f = 0; f < 8; f++) a.render(rig, 1 / 60);
        const st = t.stats(t.read(a));
        if (prev) steps.push(Math.hypot(st.cx - prev.cx, st.cy - prev.cy));
        prev = st;
      }
      const sorted = [...steps].sort((x, y) => x - y);
      out[sign < 0 ? 'left' : 'right'] = { max: Math.max(...steps), median: sorted[sorted.length >> 1] };
    }
    return out;
  }, FROZEN);
  for (const side of ['left', 'right']) {
    const c = creep[side];
    check(`turning ${side} to the limit moves the head smoothly, with no jump`,
      c.max <= c.median * 4 + 1,
      `largest step ${c.max.toFixed(1)}px against a median of ${c.median.toFixed(1)}px per 2 degrees`);
  }

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('invariants run completed', false, err.stack);
} finally {
  await close();
}
console.log(`(${((Date.now() - started) / 1000).toFixed(0)}s)`);
finish();
