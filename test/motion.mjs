/**
 * What the model actually does, rather than what it is made of.
 *
 * Every bug that reached the user in this project passed the existing suites.
 * Those suites check structure (does it parse, does it draw something),
 * a single settled pose, and aggregates (the parts sum back to the artwork).
 * The bugs were none of those things: the wrong backend mounted, parts slid
 * apart only past 25 degrees, the head went translucent halfway through a
 * cross-fade, a lid left a sliver, a fallback fired silently.
 *
 * So this file asserts behaviour, motion and appearance:
 *
 *   - the default boot, because "can do X" is not "does X"
 *   - invariants across the whole range of motion, not one settled pose
 *   - the rendered rest pose against the artwork itself
 *   - features by what you would see, not by whether the code ran
 *   - that the good path was taken, because a silent fallback is how a fix
 *     quietly stops working
 *
 *   node test/motion.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_BIN ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

const server = await createServer({ server: { port: 5192 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--enable-unsafe-swiftshader', '--no-proxy-server'],
});
const context = await browser.newContext({ viewport: { width: 420, height: 420 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|^INFO:|XNNPACK|GL Driver|OpenGL error/i.test(m.text())) {
    errors.push(m.text());
  }
});

// Shared helpers, installed once in the page.
const HELPERS = `
window.__t = {
  // Pixels of the avatar canvas, as flat RGBA.
  read(a) {
    const gl = a.gl;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const d = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
    return { d, w, h };
  },
  // Settle a pose: springs and the chain need frames to reach it.
  pose(a, emptyRig, mut, frames = 70) {
    const rig = emptyRig();
    for (const k of Object.keys(mut || {})) Object.assign(rig[k], mut[k]);
    for (let f = 0; f < frames; f++) a.render(rig, 1 / 60);
    return rig;
  },
  stats({ d, w, h }) {
    let opaque = 0, partial = 0, sx = 0, sy = 0;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const alpha = d[i + 3];
      if (alpha <= 24) continue;
      opaque++;
      // Cel art is opaque or absent. A band of half-transparent pixels means
      // something is being blended that should not be — which is exactly how
      // the head went see-through mid-flip.
      if (alpha < 236) partial++;
      const x = p % w;
      sx += x; sy += (p - x) / w;
    }
    return { opaque, partial, cx: opaque ? sx / opaque : 0, cy: opaque ? sy / opaque : 0 };
  },
  // Connected blobs of the silhouette, ignoring specks. The character coming
  // apart shows up here as pieces appearing that were not there at rest.
  blobs({ d, w, h }, minArea) {
    const seen = new Uint8Array(w * h);
    const stack = [];
    let count = 0;
    for (let s = 0; s < w * h; s++) {
      if (seen[s] || d[s * 4 + 3] <= 24) continue;
      let area = 0;
      seen[s] = 1; stack.push(s);
      while (stack.length) {
        const i = stack.pop();
        area++;
        const x = i % w, y = (i - (i % w)) / w;
        const go = (j) => { if (!seen[j] && d[j * 4 + 3] > 24) { seen[j] = 1; stack.push(j); } };
        if (x > 0) go(i - 1);
        if (x < w - 1) go(i + 1);
        if (y > 0) go(i - w);
        if (y < h - 1) go(i + w);
      }
      if (area >= minArea) count++;
    }
    return count;
  },
};
`;
await page.addInitScript(HELPERS);

try {
  await page.goto('http://127.0.0.1:5192/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vtuber?.avatars?.parts2d?.ready === true,
    null, { timeout: 40000 });

  /* --- the default boot ---------------------------------------------------
   * The parts model existed and worked for a long stretch while the app still
   * mounted the whole-image warp, so nobody ever saw it. Capability is not
   * behaviour: assert what a clean profile actually gets.
   */
  const boot = await page.evaluate(() => {
    const { store, current, avatars } = window.__vtuber;
    const a = avatars.parts2d;
    return {
      setting: store.get('stage.avatar'),
      mounted: current === avatars.parts2d ? 'parts2d'
        : current === avatars.warp2d ? 'warp2d' : 'other',
      parts: a.parts.map((p) => p.name),
      hasImage: Boolean(a.image),
      spine: Boolean(a.spine),
      glow: store.get('warp.eyeGlow'),
    };
  });
  check('a clean profile mounts the parts model', boot.mounted === 'parts2d' &&
    boot.setting === 'parts2d', `setting ${boot.setting}, mounted ${boot.mounted}`);
  check('it boots with the bundled artwork already cut', boot.hasImage && boot.parts.length === 9,
    boot.parts.join(', '));

  /* --- the good path was taken -------------------------------------------
   * Each of these has a fallback that produces something plausible-looking.
   * A fallback firing on the artwork the rules were written for means a rule
   * stopped matching, and nothing else would say so.
   */
  const paths = await page.evaluate(async () => {
    const { cutParts } = await import('/src/avatars/parts/cut.js');
    const a = window.__vtuber.avatars.parts2d;
    const t = performance.now();
    const { sockets, parts } = cutParts(a.image, a.markers());
    const ms = performance.now() - t;
    const eyes = a.parts.find((p) => p.name === 'eyeNear');
    const marker = a.markers();
    return {
      ms: Math.round(ms),
      sockets: sockets?.length ?? 0,
      // A socket that matches the marker box means socketsFor returned nothing
      // and upload fell back to it.
      fellBack: !sockets?.length,
      armPivots: parts.filter((p) => p.name.startsWith('arm') && p.pivot).length,
      eyeHalfWidth: eyes?.eyeL?.[2] ?? 0,
      angle: marker.eyeAngle,
    };
  });
  check('both eyes were found, and measured rather than guessed',
    !paths.fellBack && paths.sockets === 2, `${paths.sockets} sockets`);
  check('the scarf skeleton was extracted', boot.spine);
  check('both arms got a shoulder pivot', paths.armPivots === 2, `${paths.armPivots}`);
  // Headless software GL is slow, so this is a ceiling against a tenfold
  // regression, not a tight budget.
  check('cutting the artwork stays within budget', paths.ms < 4000, `${paths.ms}ms`);

  /* --- the rendered rest pose is the artwork -----------------------------
   * Stronger than the parts summing back together: this goes through the
   * whole renderer — joints, warp, framing — and compares the result against
   * the drawing itself. Anything that shifts, scales or tints at rest moves
   * this number.
   */
  const rest = await page.evaluate(async () => {
    const { computeFrame } = await import('/src/core/framing.js');
    const { avatars, emptyRig, store } = window.__vtuber;
    const a = avatars.parts2d;
    // Compare the pipeline, not the embellishments: the glow lifts the eye
    // above the drawing on purpose, and idle drift means no frame is at rest.
    const saved = {
      glow: store.get('warp.eyeGlow'), wind: store.get('warp.wind'),
      breath: store.get('body.breathAmount'), sway: store.get('body.swayAmount'),
      headOn: store.get('parts.headOn'),
    };
    /* And with the head-on face off.
     *
     * At rest the model now deliberately does not match the drawing: the eyes
     * are moved onto the middle of the head, because rest is where somebody
     * sits looking at their camera. That is the feature, not a regression, and
     * leaving it on here would spend this check's whole budget on it and leave
     * nothing to catch an actual drift.
     */
    store.patch({
      'stage.zoom': 1, 'stage.offsetX': 0, 'stage.offsetY': 0,
      'warp.eyeGlow': 0, 'warp.wind': 0, 'body.breathAmount': 0, 'body.swayAmount': 0,
      'parts.headOn': 0,
    });
    window.__t.pose(a, emptyRig, {}, 120);
    const shot = window.__t.read(a);

    // The same mapping the vertex shader uses, in 2D.
    const f = computeFrame(a.aspect, shot.w, shot.h, 1, 0, 0);
    const ref = document.createElement('canvas');
    ref.width = shot.w; ref.height = shot.h;
    const g = ref.getContext('2d');
    g.drawImage(a.image, f.ox * shot.w, f.oy * shot.h, f.sx * shot.w, f.sy * shot.h);
    const r = g.getImageData(0, 0, shot.w, shot.h).data;

    let solid = 0, wrong = 0;
    for (let i = 0; i < r.length; i += 4) {
      // WebGL reads bottom-up; flip the row when indexing the reference.
      const p = i / 4;
      const x = p % shot.w;
      const y = (p - x) / shot.w;
      const q = ((shot.h - 1 - y) * shot.w + x) * 4;
      if (r[i + 3] < 200) continue;
      solid++;
      const dr = Math.abs(shot.d[q] - r[i]);
      const dg = Math.abs(shot.d[q + 1] - r[i + 1]);
      const db = Math.abs(shot.d[q + 2] - r[i + 2]);
      if (dr + dg + db > 110) wrong++;
    }
    store.patch({
      'warp.eyeGlow': saved.glow, 'warp.wind': saved.wind,
      'body.breathAmount': saved.breath, 'body.swayAmount': saved.sway,
      'parts.headOn': saved.headOn,
    });
    return { pct: (100 * wrong) / Math.max(solid, 1), solid, wrong };
  });
  check('the rendered rest pose matches the artwork', rest.pct < 3.2,
    `${rest.wrong} of ${rest.solid} differ (${rest.pct.toFixed(2)}%)`);

  /* --- invariants across the whole range of motion -----------------------
   * Not one settled pose. Sweeping the full range is what surfaces the faults
   * that only exist in transit or at the extremes — parts rotating at
   * different rates, a cross-fade going translucent, cloth tearing loose.
   */
  const sweep = await page.evaluate(async () => {
    const { avatars, emptyRig, store } = window.__vtuber;
    const a = avatars.parts2d;
    // Zoomed out far enough that nothing leaves the frame at the extremes.
    // Cropping confounds every measurement here: a ribbon swinging past the
    // edge splits the silhouette into "extra pieces" and drags the centroid,
    // neither of which is the model doing anything wrong.
    // Physics frozen. This sweep is about the pose transforms holding together;
    // cloth and idle drift legitimately lag behind a pose change, and with only
    // a few settle frames per sample that lag reads as the model jumping. The
    // chain's own behaviour is measured separately, where it is the subject.
    const held = ['warp.clothWeight', 'warp.wind', 'warp.overshoot', 'body.breathAmount',
      'body.swayAmount', 'body.hairPhysics'];
    const before = Object.fromEntries(held.map((k) => [k, store.get(k)]));
    for (const k of held) store.set(k, 0);
    store.patch({ 'stage.zoom': 0.62, 'stage.offsetX': 0, 'stage.offsetY': 0 });

    // Render before measuring: read() returns the last frame drawn, which
    // would otherwise still be the previous block's framing entirely.
    window.__t.pose(a, emptyRig, {}, 40);
    const baseShot = window.__t.read(a);
    const base = window.__t.stats(baseShot);
    const baseBlobs = window.__t.blobs(baseShot, 60);

    const out = { base, baseBlobs, worstPartial: 0, worstPartialAt: '',
      worstArea: 1, worstAreaAt: '', maxBlobs: baseBlobs, maxBlobsAt: '',
      maxJump: 0, maxJumpAt: '' };

    // Every axis, not just yaw. Yaw got all the attention because that is
    // where the visible faults were, and an axis nobody sweeps is where the
    // next one waits.
    const AXES = [
      ['yaw', (v) => ({ yaw: v })],
      ['pitch', (v) => ({ pitch: v * 0.75 })],
      ['roll', (v) => ({ roll: v * 0.9 })],
      ['lean', (v) => ({ x: v * 3, y: v * 1.4 })],
      // Everything at once, within what tracking can actually produce.
      ['all', (v) => ({ yaw: v, pitch: v * 0.4, roll: -v * 0.5, x: v * 1.1 })],
    ];

    let prev = null;
    // Past the rig's own clamp, so the extremes really are exercised.
    for (const [axis, make] of AXES) {
    for (let deg = -46; deg <= 46; deg += 4) {
      const v = (deg * Math.PI) / 180;
      window.__t.pose(a, emptyRig, { head: make(v) }, 24);
      const shot = window.__t.read(a);
      const s = window.__t.stats(shot);

      const partial = s.partial / Math.max(s.opaque, 1);
      if (partial > out.worstPartial) { out.worstPartial = partial; out.worstPartialAt = `${axis} ${deg}`; }

      const area = s.opaque / Math.max(base.opaque, 1);
      if (area < out.worstArea) { out.worstArea = area; out.worstAreaAt = `${axis} ${deg}`; }

      const blobs = window.__t.blobs(shot, 60);
      if (blobs > out.maxBlobs) { out.maxBlobs = blobs; out.maxBlobsAt = `${axis} ${deg}`; }

      // Only within an axis: the jump between the end of one sweep and the
      // start of the next is a cut, not a pop.
      if (prev && deg > -46) {
        const jump = Math.hypot(s.cx - prev.cx, s.cy - prev.cy);
        if (jump > out.maxJump) { out.maxJump = jump; out.maxJumpAt = `${axis} ${deg}`; }
      }
      prev = s;
    }
    prev = null;
    }
    for (const k of held) store.set(k, before[k]);
    return out;
  });

  // The cross-fade bug: two half-faded copies composite to 0.75 alpha, so the
  // background showed through the helmet. It is invisible to an opaque-pixel
  // count and obvious in the proportion that are part-transparent.
  check('nothing goes translucent through the range of motion',
    sweep.worstPartial < 0.16,
    `worst ${(sweep.worstPartial * 100).toFixed(1)}% part-transparent at ${sweep.worstPartialAt}` +
    ` (rest ${((sweep.base.partial / sweep.base.opaque) * 100).toFixed(1)}%)`);

  check('the character does not shrink or vanish at the extremes',
    sweep.worstArea > 0.84, `smallest ${(sweep.worstArea * 100).toFixed(0)}% of rest at ${sweep.worstAreaAt}`);

  /* Cloth tearing loose from the body shows up as pieces that were not there
   * at rest.
   *
   * No slack. This allowed two extra pieces and duly passed while the model
   * was rendering three: at a turn the raised fist was stranded in mid-air and
   * an eye shard was out in the open beside it, and at a tilt a boot was left
   * standing on its own. The artwork is a single connected shape, so anything
   * above one piece is the model coming apart, and a tolerance here only ever
   * buys silence about it.
   */
  check('the character does not come apart into extra pieces',
    sweep.maxBlobs <= sweep.baseBlobs && sweep.baseBlobs === 1,
    `${sweep.maxBlobs} pieces at ${sweep.maxBlobsAt}, ${sweep.baseBlobs} at rest`);

  check('the pose moves smoothly, with no pops',
    sweep.maxJump < 8, `largest step ${sweep.maxJump.toFixed(1)}px at ${sweep.maxJumpAt}`);

  /* --- features by what you would see ------------------------------------
   * Measured by differencing renders rather than by hunting for a colour that
   * ought to mean "lit". A threshold on blueness counts the whole visor and
   * drowns the effect being tested; the difference between two renders is the
   * effect being tested.
   */
  const looks = await page.evaluate(async () => {
    const { avatars, emptyRig, store } = window.__vtuber;
    const a = avatars.parts2d;
    store.patch({ 'stage.zoom': 1.6, 'stage.offsetX': -0.18, 'stage.offsetY': 0.02,
      'warp.wind': 0, 'body.breathAmount': 0, 'body.swayAmount': 0 });

    const shot = (mut, over) => {
      const undo = {};
      for (const k of Object.keys(over || {})) { undo[k] = store.get(k); store.set(k, over[k]); }
      window.__t.pose(a, emptyRig, mut, 80);
      const px = window.__t.read(a);
      for (const k of Object.keys(undo)) store.set(k, undo[k]);
      return px;
    };
    // Pixels that differ between two renders, and where they are.
    const diff = (A, B) => {
      const idx = [];
      for (let i = 0; i < A.d.length; i += 4) {
        const dr = Math.abs(A.d[i] - B.d[i]) + Math.abs(A.d[i + 1] - B.d[i + 1]) +
                   Math.abs(A.d[i + 2] - B.d[i + 2]) + Math.abs(A.d[i + 3] - B.d[i + 3]);
        if (dr > 26) idx.push(i / 4);
      }
      return idx;
    };
    const nearWhite = (px, within) => {
      let n = 0;
      for (const p of within) {
        const i = p * 4;
        if (px.d[i + 3] > 200 && px.d[i] > 216 && px.d[i + 1] > 216 && px.d[i + 2] > 216) n++;
      }
      return n;
    };

    const open = shot({});
    const shut = shot({ eyes: { blinkL: 1, blinkR: 1 } });
    const half = shot({ eyes: { blinkL: 0.5, blinkR: 0.5 } });

    // Wherever shutting the eye changes the picture IS the eye. Self
    // calibrating, so no marker or hand-picked rectangle to drift out of date.
    const region = diff(open, shut);
    const all = [];
    for (let p = 0; p < open.d.length / 4; p++) all.push(p);

    const glowOff = shot({}, { 'warp.eyeGlow': 0 });
    const glowDiff = diff(open, glowOff);
    // The shard itself, so spill can be told apart from a brighter shard.
    const shardSet = new Set();
    for (const p of region) shardSet.add(p);
    const spill = glowDiff.filter((p) => !shardSet.has(p)).length;

    const shutGlowOff = shot({ eyes: { blinkL: 1, blinkR: 1 } }, { 'warp.eyeGlow': 0 });

    const gazeL = shot({ eyes: { gazeX: -1 } });
    const gazeR = shot({ eyes: { gazeX: 1 } });

    return {
      regionPx: region.length,
      openLit: nearWhite(open, region),
      // Across the whole frame. Nothing on this model is near-white except
      // the eyes, so a shut face should have none of it anywhere.
      shutLit: nearWhite(shut, all),
      halfLit: nearWhite(half, region),
      glowChanged: glowDiff.length,
      spill,
      glowShutChanged: diff(shut, shutGlowOff).length,
      gazeChanged: diff(gazeL, gazeR).length,
    };
  });

  check('closing the eye changes a meaningful area', looks.regionPx > 150, `${looks.regionPx}px`);
  check('the eye is lit when open', looks.openLit > 120, `${looks.openLit}px`);
  /* Nothing lit anywhere, not just in the big slit.
   *
   * This assertion used to be the other way round. The far eye of a 3/4 view
   * is small and half hidden behind the hood, and I took it for a highlight on
   * the visor rim — then wrote a check requiring it to stay lit through a
   * blink, which locked the bug in and would have failed the fix. It is an
   * eye, it blinks, and the only near-white left on a shut face is none.
   */
  check('a shut face leaves nothing lit anywhere', looks.shutLit === 0,
    `${looks.shutLit}px still lit (open ${looks.openLit})`);
  check('a half blink lands between open and shut',
    looks.halfLit > 0 && looks.halfLit < looks.openLit * 0.9,
    `${looks.halfLit} vs open ${looks.openLit}`);
  check('the glow does something at all', looks.glowChanged > 200, `${looks.glowChanged}px`);
  // The old glow only tinted pixels that were already bright, so it never left
  // the shard and could not read as light.
  check('the glow spills past the slit onto the visor', looks.spill > 120,
    `${looks.spill}px changed outside the slit`);
  check('the glow goes out with the eye', looks.glowShutChanged < looks.glowChanged * 0.25,
    `${looks.glowShutChanged}px vs ${looks.glowChanged}px open`);
  check('gaze changes where the light falls', looks.gazeChanged > 100, `${looks.gazeChanged}px`);

  /* --- the contact shadow stays on the character -------------------------
   * It is drawn multiplied by the destination's alpha so it can only darken
   * what has already been drawn. If that ever breaks, a transparent OBS source
   * grows a black halo around the whole character — which looks fine on the
   * dark preview here and catastrophic on stream.
   */
  const shade = await page.evaluate(async () => {
    const { avatars, emptyRig, store } = window.__vtuber;
    const a = avatars.parts2d;
    const saved = store.get('parts.contactShadow');
    const sample = (level) => {
      store.set('parts.contactShadow', level);
      window.__t.pose(a, emptyRig, {}, 40);
      const { d } = window.__t.read(a);
      let outside = 0, inside = 0;
      for (let i = 0; i < d.length; i += 4) {
        // Colour written where nothing is drawn: the halo.
        if (d[i + 3] < 8 && (d[i] > 8 || d[i + 1] > 8 || d[i + 2] > 8)) outside++;
        if (d[i + 3] > 200) inside += d[i] + d[i + 1] + d[i + 2];
      }
      return { outside, inside };
    };
    const off = sample(0);
    const full = sample(1);
    store.set('parts.contactShadow', saved);
    return { off, full };
  });
  check('the contact shadow never touches the transparent background',
    shade.full.outside <= shade.off.outside,
    `${shade.full.outside} stray px at full strength, ${shade.off.outside} with it off`);
  /* Three per cent was the old bar, and it was measuring a fault.
   *
   * The shadow used to be drawn with the wrong part's geometry, which spread
   * it across whole layers and took a quarter of the figure's brightness with
   * it. Drawn with its own, it is what it says it is: a dark line where two
   * surfaces meet, worth about one per cent of the total. The bar is here to
   * catch the shadow doing nothing at all, so that is where it belongs.
   */
  check('the contact shadow actually darkens the character',
    shade.full.inside < shade.off.inside * 0.996,
    `brightness ${Math.round(shade.full.inside / 1e6)}M vs ${Math.round(shade.off.inside / 1e6)}M`);

  /* --- the scarf's two halves must stay joined ---------------------------
   * The scarf is one piece of cloth cut into two parts, so wherever they touch
   * at rest they have to keep touching however the head moves. Nothing else
   * here catches them coming apart: the silhouette area barely changes, the
   * piece count barely changes, and the centroid barely moves — but a gap
   * opening at the neck is the single most obvious fault on screen.
   *
   * Measured by rendering each part alone and asking whether one still lies
   * within a few pixels of the other.
   */
  const joined = await page.evaluate(async () => {
    const { avatars, emptyRig, store } = window.__vtuber;
    const a = avatars.parts2d;
    /* Measured on the drawing, not on the padding around it.
     *
     * Every part is cut with twenty-eight pixels of invented paint so the
     * piece in front has something to move off, and both halves of the scarf
     * carry it. This check asked how far apart they were and counted that
     * paint, so fifty-six pixels of real tear read as none — and it duly
     * reported the scarf perfectly joined, at every pose, for as long as it
     * has existed, while the seam was plainly visible on screen.
     */
    store.patch({ 'stage.zoom': 0.9, 'stage.offsetX': 0, 'stage.offsetY': 0,
      'body.breathAmount': 0, 'body.swayAmount': 0, 'parts.margin': 0 });
    /* Flush the rebuild before taking hold of the part list.
     *
     * Changing any warp setting marks the model for rebuild, and the next
     * render acts on it: the parts are re-cut and the old textures freed. A
     * reference taken before that render is left pointing at freed objects —
     * and because this block puts its reference back when it finishes, the
     * renderer kept drawing them for every check that came after. That is why
     * the one-piece check below reported the model in three pieces while the
     * running app was demonstrably in one.
     */
    window.__t.pose(a, emptyRig, {}, 1);
    const all = a.parts;

    const maskOf = (name, mut, settle) => {
      a.parts = all.filter((p) => p.name === name);
      window.__t.pose(a, emptyRig, mut, settle);
      const { d, w, h } = window.__t.read(a);
      const m = new Uint8Array(w * h);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) if (d[i + 3] > 40) m[p] = 1;
      return { m, w, h };
    };
    // Nearest distance from any pixel of A to the set B, in pixels, by
    // expanding B a ring at a time until it meets A.
    const gap = (A, B, limit) => {
      const { w, h } = A;
      let cur = B.m;
      for (let r = 0; r <= limit; r++) {
        for (let i = 0; i < w * h; i++) if (cur[i] && A.m[i]) return r;
        const next = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
          if (!cur[i]) continue;
          const x = i % w;
          const y = (i - x) / w;
          next[i] = 1;
          if (x > 0) next[i - 1] = 1;
          if (x < w - 1) next[i + 1] = 1;
          if (y > 0) next[i - w] = 1;
          if (y < h - 1) next[i + w] = 1;
        }
        cur = next;
      }
      return limit + 1;
    };

    /* Swept, not sampled, and with the cloth running.
     *
     * Six held poses with the scarf's own physics frozen is not a range of
     * motion — it is six stills, and it is the physics that pulls the two
     * halves apart in the first place. This walks a continuous tour through
     * every axis at once, leaving the chain to respond as it does in use, and
     * asks the question at every step of it.
     */
    const LIMIT = 14;
    const tour = [];
    for (let k = 0; k <= 24; k++) {
      const t = (k / 24) * Math.PI * 2;
      tour.push({
        head: {
          yaw: 0.70 * Math.sin(t),
          pitch: 0.55 * Math.sin(t * 2 + 0.7),
          roll: 0.45 * Math.sin(t * 3 + 1.9),
          x: 0.8 * Math.sin(t * 2), y: 0.5 * Math.cos(t),
        },
      });
    }
    const out = [];
    for (let k = 0; k < tour.length; k++) {
      // Short settles, so the chain carries its state from one step to the
      // next the way it does when somebody is actually moving.
      const wrap = maskOf('wrap', tour[k], 6);
      const tails = maskOf('tails', tour[k], 6);
      const g = gap(wrap, tails, LIMIT);
      out.push({ label: `step ${k}`, gap: g,
        yaw: +tour[k].head.yaw.toFixed(2), pitch: +tour[k].head.pitch.toFixed(2) });
    }
    a.parts = all;
    store.reset();
    return { out, LIMIT };
  });

  const worst = joined.out.reduce((a, b) => (b.gap > a.gap ? b : a));
  check('the scarf stays joined to itself through the whole range of motion',
    worst.gap <= 6,
    `worst ${worst.gap}px at yaw ${worst.yaw}, pitch ${worst.pitch} `
      + `over ${joined.out.length} steps`);

  /* --- the character is one piece, at every setting the panel can reach -----
   *
   * The artwork is a single connected shape — one blob of opaque pixels, which
   * this asserts against the file rather than assuming. So the model is only
   * ever right if what it renders is a single blob too.
   *
   * This is the check that was missing. Everything above runs at the default
   * settings, and the fault the user hit needed three sliders away from their
   * defaults at once: a slack scarf, full travel, full drift. Then idle wind
   * alone — no camera, no motion, sitting still — pulled the ribbon off the
   * neck and left it floating. No single setting did it, so a one-at-a-time
   * sweep would have missed it as well; the combination is the point.
   *
   * Sampled repeatedly through the run, because coming apart is something the
   * cloth does on its way somewhere, not only where it settles.
   */
  const sourceBlobs = await page.evaluate(async () => {
    const img = window.__vtuber.avatars.parts2d.image;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return window.__t.blobs({ d, w: c.width, h: c.height }, 60);
  });
  check('the artwork itself is a single connected shape', sourceBlobs === 1,
    `${sourceBlobs} blobs`);

  const intact = await page.evaluate(async () => {
    const { avatars, emptyRig, store } = window.__vtuber;
    const a = avatars.parts2d;
    // A phone's worth of pixels: the size it is actually looked at.
    a.resize(412, 900, 1);

    const CASES = [
      ['defaults', {}],
      ['slack scarf, full travel and drift',
        { 'warp.clothStiffness': 0.1, 'warp.clothWeight': 3, 'warp.wind': 3 }],
      ['every cloth control at its maximum',
        { 'warp.clothStiffness': 0.1, 'warp.clothWeight': 3, 'warp.wind': 3,
          'warp.tuftStiffness': 0.1, 'warp.tuftWeight': 3, 'body.hairPhysics': 2.5,
          'body.breathAmount': 2.5, 'body.swayAmount': 2.5, 'body.followGain': 2,
          'warp.lowerDamping': 1 }],
      ['every cloth control at its minimum',
        { 'warp.clothStiffness': 4, 'warp.clothWeight': 0, 'warp.wind': 0,
          'warp.tuftStiffness': 4, 'warp.tuftWeight': 0, 'body.hairPhysics': 0,
          'body.breathAmount': 0, 'body.swayAmount': 0, 'body.followGain': 0 }],
    ];
    // At rest with the camera off, and thrown about, because the chain is
    // driven by head inertia and idle wind both.
    const POSES = [
      ['at rest', null],
      ['turning', (rig, f) => { rig.head.yaw = Math.sin(f / 14) * 0.7; rig.head.roll = Math.sin(f / 9) * 0.4; }],
    ];

    const out = [];
    for (const [label, patch] of CASES) {
      for (const [poseName, drive] of POSES) {
        store.reset();
        store.patch(patch);
        a.scarf.reset();
        a.inertia.reset();
        const rig = emptyRig();
        let worst = 1;
        let where = '';
        for (let f = 0; f < 240; f++) {
          if (drive) drive(rig, f);
          a.render(rig, 1 / 60);
          if (f % 20 !== 19) continue;
          const n = window.__t.blobs(window.__t.read(a), 60);
          if (n > worst) { worst = n; where = ` at frame ${f}`; }
        }
        out.push({ label: `${label}, ${poseName}`, worst, where });
      }
    }
    store.reset();
    a.scarf.reset();
    a.inertia.reset();
    return out;
  });

  const torn = intact.filter((o) => o.worst !== 1);
  check('the character renders as one piece at every setting',
    torn.length === 0,
    torn.length
      ? torn.map((o) => `${o.label}: ${o.worst} pieces${o.where}`).join('; ')
      : intact.map((o) => o.label).join('; '));

  /* --- which way a nod goes ----------------------------------------------
   *
   * Nothing here ever asserted this, and it was reported backwards more than
   * once while every other check stayed green. The convention is fixed from
   * the recorded session: its tracking drops out at negative pitch, which is
   * the hat brim cutting the face off when its wearer looks down, and the
   * gaze weights agree — the further pitch rises the further the eyes roll
   * down to stay on the screen. So negative pitch is looking down, and looking
   * down has to move the model down.
   *
   * Driven through the real rig rather than a hand-built pose, because the
   * sign passes through calibration, the gain and the invert on its way.
   */
  const nod = await page.evaluate(async () => {
    const { avatars, store, rig, emptyRig } = window.__vtuber;
    const a = avatars.parts2d;
    store.reset();
    store.patch({ 'warp.clothWeight': 0, 'warp.wind': 0, 'warp.overshoot': 0,
      'body.breathAmount': 0, 'body.swayAmount': 0, 'body.hairPhysics': 0, 'stage.zoom': 1.2 });
    a.resize(300, 300, 2);
    for (let f = 0; f < 3; f++) a.render(rig.state, 1 / 60);
    const gl = a.gl;
    /* The head alone, not the whole figure.
     *
     * This is the mistake that let a backwards nod through three rounds of
     * "fixed". The scarf is most of the silhouette and barely moves when the
     * head nods, so on the figure a full nod is about four pixels — noise —
     * while on the head it is thirty. A check that measures the wrong thing
     * passes for the wrong reason, and this one did.
     */
    const all = a.parts;
    const centreY = () => {
      a.parts = all.filter((p) => ['head', 'eyeNear', 'eyeFar', 'tufts'].includes(p.name));
      a.render(rig.state, 1 / 60);
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const d = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
      let n = 0, sy = 0;
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        if (d[i + 3] <= 40) continue;
        const x = p % w;
        n++; sy += h - 1 - ((p - x) / w);
      }
      a.parts = all;
      return n ? sy / n : NaN;
    };
    const feed = (pitch, frames = 60) => {
      const f = { shapes: {}, head: { yaw: 0, pitch, roll: 0 }, position: { x: 0, y: 0, z: -45 } };
      for (let i = 0; i < frames; i++) { rig.update(f, true, 1 / 60); a.render(rig.state, 1 / 60); }
      return centreY();
    };
    const run = (invert) => {
      store.set('head.flipNod', invert);
      rig.clearCalibration();
      const rest = feed(0);
      // Named for the tracker's numbers, not for which way a head is going —
      // the semantics are asserted below, once, where they can be justified.
      const neg = feed(-0.5) - rest;
      rig.clearCalibration();
      feed(0);
      const pos = feed(0.5) - rest;
      return { neg, pos };
    };
    const plain = run(false);
    const inverted = run(true);
    store.set('head.flipNod', false);
    rig.clearCalibration();
    return { plain, inverted };
  });

  // Screen coordinates, so a positive number is further down the screen.
  /* Named for the mechanism, not for which way a head is going.
   *
   * An earlier version of this asserted "looking down moves the model down",
   * which reads like ground truth and is not: it encodes my reading of the
   * tracker's sign, and that reading was contradicted by the person watching
   * the model. What is genuinely testable is that a nod moves the model along
   * the screen at all, and that the switch reverses it — the semantics belong
   * to whoever can see both their own head and the screen.
   */
  /* The direction, not merely that there is one.
   *
   * Asserting only "it moves, and oppositely for opposite nods" passes just as
   * happily with the sign reversed — which is the state this shipped in three
   * times. The direction below is not derived from the tracker's documented
   * convention, which I read the wrong way round; it is fixed from two
   * photographs of the running app on a real camera, one looking up and one
   * looking down, and it is the direction the person in front of that camera
   * confirmed. If it ever needs changing, it needs changing the same way.
   */
  check('a nod visibly moves the head, and the right way',
    nod.plain.neg < -12 && nod.plain.pos > 12,
    `tracker pitch -0.5 moves the head ${nod.plain.neg.toFixed(1)}px, +0.5 moves it ${nod.plain.pos.toFixed(1)}px`);

  check('and "Flip nod" reverses exactly that',
    nod.inverted.neg > 12 && nod.inverted.pos < -12,
    `flipped: ${nod.inverted.neg.toFixed(1)}px, ${nod.inverted.pos.toFixed(1)}px`);

  /* --- the face goes with the head ---------------------------------------
   *
   * The eyes are their own layer so a lid can erase them, not because they are
   * a separate object from the face. When the head swaps for its mirror image
   * they have to swap with it, and for a while they did not: the mirror was
   * done by flipping each part's texture inside its own box, which for the
   * head is nearly its own axis and for the eyes is a small patch off to one
   * side — so the eye stayed exactly where it was while the face moved across
   * it. Obvious in a second to anyone watching the model, and invisible to
   * every check here, because none of them asked where the eye had got to.
   */
  const face = await page.evaluate(async () => {
    const { avatars, store, emptyRig } = window.__vtuber;
    const a = avatars.parts2d;
    store.reset();
    store.patch({ 'warp.clothWeight': 0, 'warp.wind': 0, 'warp.overshoot': 0,
      'body.breathAmount': 0, 'body.swayAmount': 0, 'body.hairPhysics': 0,
      'stage.zoom': 1.9, 'stage.offsetX': -0.10, 'stage.offsetY': 0.22 });
    a.resize(300, 300, 2);
    // Flush the rebuild before holding the part list — see the note above.
    for (let f = 0; f < 3; f++) a.render(emptyRig(), 1 / 60);
    const all = a.parts;
    const gl = a.gl;
    const draw = (names, yaw) => {
      a.parts = all.filter((p) => names.includes(p.name));
      const rig = emptyRig();
      rig.head.yaw = yaw;
      for (let f = 0; f < 40; f++) a.render(rig, 1 / 60);
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const d = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
      a.parts = all;
      return d;
    };
    const w = gl.drawingBufferWidth;
    const centroid = (d) => {
      let n = 0, sx = 0;
      for (let k = 0, p = 0; k < d.length; k += 4, p++) {
        if (d[k + 3] <= 40) continue;
        n++; sx += p % w;
      }
      return { n, cx: n ? sx / n : NaN };
    };
    const out = [];
    for (const [label, yaw] of [['facing as drawn', 0.70], ['mirrored', -0.70]]) {
      const head = centroid(draw(['head'], yaw));
      const eyes = centroid(draw(['eyeNear', 'eyeFar'], yaw));
      // Where the eye sits across the head, as a signed offset from its middle.
      out.push({ label, eye: eyes.n, offset: eyes.cx - head.cx });
    }
    store.reset();
    return out;
  });

  /* Sitting on the head is not enough — the head is big, and an eye left
   * behind still lands somewhere on it. What has to be true is that the eye
   * crosses to the other side of the head's middle when the head does.
   */
  const drawn = face.find((f) => f.label === 'facing as drawn');
  const flipped = face.find((f) => f.label === 'mirrored');
  check('the eyes cross the head with it when it flips',
    drawn.eye > 500 && flipped.eye > 500
      && Math.abs(drawn.offset) > 6
      && Math.sign(flipped.offset) === -Math.sign(drawn.offset),
    `eye sits ${drawn.offset.toFixed(0)}px from the middle of the head as drawn, `
      + `${flipped.offset.toFixed(0)}px mirrored`);



  /* --- a part casts its own shadow, not the one before it -----------------
   *
   * The shadow pass ran before the part's geometry was bound, so it drew with
   * whatever the previous part had left there — every layer wearing the shape
   * of the layer behind it, and the first part of each frame casting nothing
   * at all. Neither check above notices: a shadow of the wrong shape still
   * darkens the character and still stays off the background, which is all
   * either of them asks.
   *
   * Two parts is what makes it visible, and they have to be still ones. The
   * hair sits behind the head, so the head's shadow belongs in the sliver of
   * hair its outline reaches over — not across the whole tuft, which is what
   * the hair's own silhouette would darken if the shadow were still being
   * drawn with it. Measured both ways: ten per cent of the hair with the bind
   * in the right place, sixty-seven per cent with it back where it was.
   *
   * Not the scarf, whichever way round. It is skinned to a chain that is still
   * settling a fraction of a pixel between two shots, and a fraction of a
   * pixel across hard ink lines reads as a change everywhere there is a line —
   * which swamped the real patch and dragged its centre right off the head.
   */
  const ownShadow = await page.evaluate(async () => {
    const { avatars, store, emptyRig } = window.__vtuber;
    const a = avatars.parts2d;
    store.reset();
    store.patch({ 'warp.clothWeight': 0, 'warp.wind': 0, 'warp.overshoot': 0,
      'body.breathAmount': 0, 'body.swayAmount': 0, 'body.hairPhysics': 0,
      'stage.zoom': 1 });
    a.resize(320, 320, 2);
    for (let f = 0; f < 40; f++) a.render(emptyRig(), 1 / 60);
    const all = a.parts;
    const gl = a.gl;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const shot = (names, shadow) => {
      store.set('parts.contactShadow', shadow);
      a.parts = all.filter((p) => names.includes(p.name));
      for (let f = 0; f < 6; f++) a.render(emptyRig(), 1 / 60);
      const d = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
      a.parts = all;
      return d;
    };
    const off = shot(['tufts', 'head'], 0);
    const on = shot(['tufts', 'head'], 1);
    let dark = 0;
    for (let k = 0; k < off.length; k += 4) {
      const drop = (off[k] - on[k]) + (off[k + 1] - on[k + 1]) + (off[k + 2] - on[k + 2]);
      if (off[k + 3] > 200 && drop > 24) dark++;
    }
    let hair = 0;
    const alone = shot(['tufts'], 0);
    for (let k = 0; k < alone.length; k += 4) if (alone[k + 3] > 200) hair++;
    store.reset();
    return { dark, hair };
  });
  check('a part casts its own shadow, not the one before it',
    ownShadow.dark < ownShadow.hair * 0.30 && ownShadow.dark > 100,
    `${ownShadow.dark} of the hair's ${ownShadow.hair}px darkened `
      + `(${(100 * ownShadow.dark / ownShadow.hair).toFixed(0)}%)`);
  /* --- the head-on view, assembled out of the three-quarter one -----------
   *
   * The artwork is one three-quarter drawing, and the pose it does not contain
   * is the one anybody streaming actually sits in: square to the camera. Left
   * alone, the avatar looked off to one side the whole time somebody was
   * looking straight at it.
   *
   * The fix moves the eyes onto the middle of the head and replaces the far
   * shard with a mirrored copy of the near one, so what has to be true is that
   * the pair sits square when the head faces you, off to one side when it does
   * not, and reaches right across the visor rather than being one eye and a
   * sliver. Each of those is checked against the same code with the feature
   * switched off, in the same run, because a centred face proves nothing
   * unless an off-centre one is what you get without it.
   *
   * Measured on where the eye ink reaches, not on where its average falls.
   * The average is useless here and quietly so: the far shard is a tenth of
   * the near one, so the drawn pair's mean already sits within a pixel of the
   * head's middle, and the first version of this check duly reported the eyes
   * barely moving while the render plainly showed them crossing the visor.
   * What the head-on view changes is the distribution — where the ink starts
   * and stops — so that is what is read.
   */
  const headOn = await page.evaluate(async () => {
    const { computeFrame } = await import('/src/core/framing.js');
    const { avatars, store, emptyRig } = window.__vtuber;
    const a = avatars.parts2d;
    store.reset();
    store.patch({ 'warp.clothWeight': 0, 'warp.wind': 0, 'warp.overshoot': 0,
      'body.breathAmount': 0, 'body.swayAmount': 0, 'body.hairPhysics': 0,
      'warp.eyeGlow': 0, 'stage.zoom': 1.9, 'stage.offsetX': -0.10,
      'stage.offsetY': 0.22 });
    a.resize(300, 300, 2);
    for (let f = 0; f < 3; f++) a.render(emptyRig(), 1 / 60);
    const all = a.parts;
    const gl = a.gl;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;

    const shot = (yaw, blink, names, settle = 40) => {
      a.parts = all.filter((p) => names.includes(p.name));
      const rig = emptyRig();
      rig.head.yaw = yaw;
      rig.eyes.blinkL = blink;
      rig.eyes.blinkR = blink;
      for (let f = 0; f < settle; f++) a.render(rig, 1 / 60);
      const d = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
      a.parts = all;
      return d;
    };
    const EYES = ['eyeNear', 'eyeFar'];

    /* Where the head is, to measure the eyes against.
     *
     * Turning slides the whole head across the shoulders, so the eyes move
     * across the screen whether or not they have moved on the face — and the
     * first version of the check below read that as the eyes drifting and
     * failed on the model doing exactly what it should. What matters, and what
     * was reported, is the eyes moving relative to the face they are drawn on.
     *
     * Taken from the number the renderer turns, not from the pixels. Reading
     * the head's box back off the screen means reading it clipped whenever the
     * framing crops the head — which this check's framing does — so the
     * reference under-reported the head's own travel by half a pixel a degree
     * and left eight pixels of phantom drift across the talking range. This is
     * the one line of solveJoints that moves the head sideways at rest, and it
     * cannot clip.
     */
    const headMid = (yaw) =>
      Math.max(-1.2, Math.min(1.2, yaw)) * 0.05 * store.get('warp.turn') * frame.sx * w;

    /* The eyes, isolated by shutting them.
     *
     * Counting opaque pixels measures the wrong thing: every part is cut with
     * a wide margin of invented paint so the pieces in front have something to
     * move off, and on something this small the margin is several times the
     * art — an eye of sixteen hundred pixels arriving inside a patch of twelve
     * thousand. A lid erases the eye and leaves the margin, so the same frame
     * drawn shut is the packaging on its own and the difference is the eye.
     *
     * It also weights a half-faded copy by exactly how faded it is rather than
     * by whether it has crossed a threshold, and one of these eyes spends the
     * whole transition fading in.
     */
    const spread = (yaw, settle = 40) => {
      const open = shot(yaw, 0, EYES, settle);
      const shut = shot(yaw, 1, EYES, settle);
      const col = new Float64Array(w);
      let total = 0;
      for (let k = 0, p = 0; k < open.length; k += 4, p++) {
        const v = (Math.abs(open[k] - shut[k]) + Math.abs(open[k + 1] - shut[k + 1])
          + Math.abs(open[k + 2] - shut[k + 2])) / 3;
        col[p % w] += v;
        total += v;
      }
      const at = (f) => { let acc = 0;
        for (let x = 0; x < w; x++) { acc += col[x]; if (acc >= total * f) return x; }
        return w; };
      const lo = at(0.05);
      const hi = at(0.95);
      return { lo, hi, mid: (lo + hi) / 2, width: hi - lo, ink: Math.round(total / 255) };
    };

    /* The head's middle, taken from the cut rather than off the screen.
     *
     * Reading it back from pixels means reading the head part's padding too,
     * and that padding is grown only where another part sits in front — so it
     * is not symmetric, and a middle measured from it is not the head's. The
     * renderer already holds the head's centre of mass; running it through the
     * same framing the shader uses puts it on the screen exactly.
     */
    const frame = computeFrame(a.aspect, w, h, store.get('stage.zoom'),
      store.get('stage.offsetX'), store.get('stage.offsetY'));
    const headMiddle = (a.headSpan.cx * frame.sx + frame.ox) * w;

    const facing = spread(0);
    const turned = spread(0.70);
    store.patch({ 'parts.headOn': 0 });
    const without = spread(0);
    store.patch({ 'parts.headOn': 1 });

    /* Nothing may lurch as the face comes round.
     *
     * The eyes travel across the visor and a copy of one of them fades in on
     * the way, which is exactly the kind of thing that reads fine in stills
     * and jumps in motion. Crept a degree at a time on the near eye's leading
     * edge, which is what the slide moves and which stays a continuous
     * quantity through the fade. Inside the band where this happens and clear
     * of the flip, which is a snap on purpose.
     */
    /* Turned, rather than posed.
     *
     * Which face is showing is a latched decision and the handover is a
     * duration, so a row of still poses a degree apart says nothing about how
     * it looks: the change is meant to be sharp in angle and smooth in time,
     * and posing measures only the first half of that. Reading it that way
     * reported a forty-pixel jump for a handover that takes a fifth of a
     * second — true of the poses, false of the model.
     *
     * So this turns the head the way a head turns, frame by frame at sixty a
     * second, and asks how far the eyes move on the face between one frame and
     * the next. That is the thing an eye can see.
     */
    /* Two renders a step, so a step is two frames of the model's own time.
     *
     * The handover is a duration, so how much of it lands between two samples
     * depends on how much time those samples are apart — and a step that
     * quietly advanced the model three frames while being reported as one
     * inflated the worst frame threefold. Reported per frame at sixty, which
     * is the rate an eye is actually watching at.
     */
    const FRAMES_PER_STEP = 2;
    const turn = (fromDeg, toDeg, degPerSec) => {
      const dtStep = FRAMES_PER_STEP / 60;
      const steps = Math.max(1,
        Math.ceil(Math.abs(toDeg - fromDeg) / Math.max(degPerSec * dtStep, 1e-6)));
      let worstStep = 0;
      let lo = Infinity;
      let hi = -Infinity;
      let prev = null;
      for (let f = 0; f <= steps; f++) {
        const yaw = (fromDeg + (toDeg - fromDeg) * (f / steps)) * Math.PI / 180;
        const edge = spread(yaw, 1).lo - headMid(yaw);
        if (prev != null) worstStep = Math.max(worstStep, Math.abs(edge - prev));
        lo = Math.min(lo, edge);
        hi = Math.max(hi, edge);
        prev = edge;
      }
      return { worstStep: worstStep / FRAMES_PER_STEP, span: hi - lo };
    };

    // A committed turn, at a speed a person turns at: seventy-five degrees a
    // second is nought to twenty-five in a third of one.
    const swing = turn(0, 25, 75);
    /* And an ordinary talking head, wandering inside its own range.
     *
     * Brought back to centre first, and started from there. Which face is
     * showing is latched, so a sweep that begins outside the band inherits
     * whatever the last one left behind and then changes face halfway through
     * — which is the latch working, not the eyes drifting, and reading it as
     * drift is a mistake about the test rather than about the model.
     */
    turn(25, 0, 75);
    turn(0, 0, 75);
    const chatter = turn(0, 8, 40);
    const back = turn(8, -8, 40);
    const worst = swing.worstStep;
    const worstAt = 0;
    const chatLo = 0;
    const chatHi = Math.max(chatter.span, back.span);
    store.reset();
    return { facing, turned, without, worst, worstAt, headMiddle,
      chat: chatHi - chatLo };
  });

  const offCentre = (s) => s.mid - headOn.headMiddle;
  check('the eyes sit square on the head when it faces the camera',
    Math.abs(offCentre(headOn.facing)) < 12 && Math.abs(offCentre(headOn.without)) > 20,
    `${offCentre(headOn.facing).toFixed(0)}px off the middle of the head, `
      + `${offCentre(headOn.without).toFixed(0)}px with it switched off`);
  check('and go back off to one side as the head turns away',
    Math.abs(offCentre(headOn.turned)) > 20,
    `${offCentre(headOn.turned).toFixed(0)}px at 40 degrees`);
  /* The far eye has to be an eye, not the sliver the drawing gives it.
   * Facing the camera the pair reaches right across the visor; turned away it
   * is one shard and a rim, and covers less than half the ground.
   */
  check('facing the camera the eyes reach across the whole visor',
    headOn.facing.width > headOn.turned.width * 1.6,
    `${headOn.facing.width}px across facing, ${headOn.turned.width}px turned`);
  check('the eyes change over without a jump when the head turns',
    headOn.worst < 10,
    `worst ${headOn.worst.toFixed(1)}px in a frame of a 25° turn`);
  /* And do not move at all while somebody is talking.
   *
   * Nobody holds their head still. Speaking is a constant ten or fifteen
   * degrees either side of centre, and the first version of the head-on face
   * faded out across that whole range — so the eyes slid back and forth over
   * the visor the entire time somebody spoke, which is exactly what it looked
   * like: eyes coming off the face. The fade also finished where the flip
   * begins, putting a drift and a snap back to back.
   *
   * Measured over the band an ordinary talking head lives in, not the band
   * where the handover is allowed to happen.
   */
  check('and hold still through the range an ordinary head keeps to',
    headOn.chat < 4,
    `${headOn.chat.toFixed(1)}px of movement on the face across ±8°`);
  /* --- the flip turns the head without moving it -------------------------
   *
   * A swap changes which way the head faces. It must not also change where the
   * head is, and reflecting about the middle of a bounding box does exactly
   * that: a head is not symmetric inside its own box, so the reflection slides
   * its weight sideways. Measured before this was pinned down, the head
   * travelled forty-seven pixels in the single degree where the swap happens —
   * a lurch, in the middle of a turn, on the part of the model people look at.
   *
   * Crept through one degree at a time, because that is the only way to see a
   * jump that happens between two adjacent frames.
   */
  const lurch = await page.evaluate(async () => {
    const { avatars, store, emptyRig } = window.__vtuber;
    const a = avatars.parts2d;
    store.reset();
    /* With the margin left alone, because this is about the transform.
     *
     * A flipped part drops the invented paint around its edge, which is right
     * — the paint was only ever correct while it sat hidden under a neighbour
     * — but it changes the drawn area in the same frame as the swap, and this
     * check reads the drawn area. Measured together the two came to twelve
     * pixels and it was impossible to say which had moved; held apart, the
     * head turns out not to move at all. The haze is checked on its own, just
     * below.
     */
    store.patch({ 'warp.wind': 0, 'warp.clothWeight': 0, 'body.breathAmount': 0,
      'body.swayAmount': 0, 'warp.overshoot': 0, 'body.hairPhysics': 0,
      'stage.zoom': 1.5, 'parts.flipMargin': 32 });
    a.resize(320, 320, 2);
    for (let f = 0; f < 3; f++) a.render(emptyRig(), 1 / 60);
    const all = a.parts;
    a.parts = all.filter((p) => ['head', 'eyeNear', 'eyeFar', 'tufts'].includes(p.name));
    const gl = a.gl;
    const centre = () => {
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const d = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
      let n = 0, sx = 0, sy = 0;
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        if (d[i + 3] <= 40) continue;
        const x = p % w;
        n++; sx += x; sy += h - 1 - ((p - x) / w);
      }
      return n ? { cx: sx / n, cy: sy / n } : null;
    };
    let prev = null, worst = 0, worstAt = 0, flipped = false, flipAt = null;
    for (let deg = -8; deg >= -30; deg -= 1) {
      const rig = emptyRig();
      rig.head.yaw = (deg * Math.PI) / 180;
      for (let f = 0; f < 30; f++) a.render(rig, 1 / 60);
      const c = centre();
      if (a.mirrored !== flipped) { flipped = a.mirrored; flipAt = deg; }
      if (prev && c) {
        const j = Math.hypot(c.cx - prev.cx, c.cy - prev.cy);
        if (j > worst) { worst = j; worstAt = deg; }
      }
      prev = c;
    }
    a.parts = all;
    store.reset();
    return { worst, worstAt, flipAt };
  });

  check('the head flips without jumping across the screen',
    lurch.flipAt !== null && lurch.worst < 4,
    `worst ${lurch.worst.toFixed(1)}px in one degree at ${lurch.worstAt}°`
      + (lurch.flipAt === null ? ' — the flip never fired' : `, flip at ${lurch.flipAt}°`));

  /* --- and drops the paint it can no longer justify -----------------------
   *
   * Every part is grown outward with invented paint so the piece in front has
   * something to move off. It is only ever right while it stays hidden, and
   * the swap carries the head clear across everything behind it — which is
   * what put a dark haze off the hood and the hair the moment the head
   * turned, drawn against the empty background.
   *
   * Two things have to hold, and they pull against each other. Flipped, the
   * paint has to actually go: three per cent of the figure's area is what
   * comes off. At rest it has to be untouched, because that is the pose the
   * whole reassembly guard is built on and the margin is doing its job there.
   */
  const haze = await page.evaluate(async () => {
    const { avatars, store, emptyRig } = window.__vtuber;
    const a = avatars.parts2d;
    store.reset();
    /* The glow off, or there is nothing to compare.
     *
     * It breathes off the clock, which never stops, so its halo spills onto
     * the visor at a slightly different strength every frame — and the halo's
     * outer edge sits right on the alpha this counts from. Four hundred pixels
     * of a quarter-million moved between two reads that were meant to be
     * identical, which read as the trim doing something when the uniform
     * driving it was provably the same in both.
     */
    store.patch({ 'warp.wind': 0, 'warp.clothWeight': 0, 'body.breathAmount': 0,
      'body.swayAmount': 0, 'warp.overshoot': 0, 'body.hairPhysics': 0,
      'warp.eyeGlow': 0, 'stage.zoom': 1.5 });
    a.resize(320, 320, 2);
    for (let f = 0; f < 3; f++) a.render(emptyRig(), 1 / 60);
    const gl = a.gl;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    /* Both reads start from the same cloth, or neither means anything.
     *
     * The chain carries its state across, and with the drive at zero it is
     * still unwinding from whatever the last check left it in — so the second
     * read of a pair had forty more frames of settling than the first, and the
     * scarf's edge sat a pixel or two further over. Four hundred pixels of a
     * quarter-million, which is nothing to look at and everything to a check
     * asking for two numbers to be equal. Turning the eye glow off first was a
     * guess at the same symptom and did not move it.
     */
    const area = (deg, margin) => {
      store.set('parts.flipMargin', margin);
      a.scarf.reset();
      a.inertia.reset();
      const rig = emptyRig();
      rig.head.yaw = (deg * Math.PI) / 180;
      for (let f = 0; f < 60; f++) a.render(rig, 1 / 60);
      const d = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40) n++;
      return n;
    };
    /* Rest first, and twice over, because the chain remembers.
     *
     * Reading the two rest frames after a flipped one had the scarf still
     * unwinding between them, and a few pixels of drift on a quarter-million
     * looked like the margin doing something when nothing had flipped and the
     * uniform was provably identical. Measured before anything moves, and with
     * a settle either side, the two agree exactly.
     */
    const restCut = area(0, 3);
    const restKept = area(0, 32);
    const flipCut = area(-30, 3);
    const flipKept = area(-30, 32);
    store.reset();
    return { flipCut, flipKept, restCut, restKept };
  });
  check('flipping the head drops the paint that was hiding under it',
    haze.flipKept - haze.flipCut > haze.flipCut * 0.015,
    `${haze.flipKept - haze.flipCut}px of haze off a ${haze.flipCut}px figure `
      + `(${(100 * (haze.flipKept - haze.flipCut) / haze.flipCut).toFixed(1)}%)`);
  /* Within a pixel, which is the floor this can be measured to.
   *
   * With the cloth reset either side and the uniform provably identical, the
   * two frames come back one pixel apart — a single edge pixel landing either
   * side of the alpha this counts from. The thing the check is for is the trim
   * firing when nothing has flipped, and that is not subtle: flipped, it takes
   * seven and a half thousand pixels off.
   */
  check('and changes nothing at all when nothing has flipped',
    Math.abs(haze.restCut - haze.restKept) <= 2,
    `${haze.restCut}px trimmed vs ${haze.restKept}px kept`);

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('test run completed', false, err.stack);
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${failures ? `${failures} failing` : 'all motion checks passed'}`);
process.exit(failures ? 1 : 0);
