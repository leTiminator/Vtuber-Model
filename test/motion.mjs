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
  check('it boots with the bundled artwork already cut', boot.hasImage && boot.parts.length === 8,
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
    const eyes = a.parts.find((p) => p.name === 'eyes');
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
    };
    store.patch({
      'stage.zoom': 1, 'stage.offsetX': 0, 'stage.offsetY': 0,
      'warp.eyeGlow': 0, 'warp.wind': 0, 'body.breathAmount': 0, 'body.swayAmount': 0,
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
    });
    return { pct: (100 * wrong) / Math.max(solid, 1), solid, wrong };
  });
  check('the rendered rest pose matches the artwork', rest.pct < 4,
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
  check('the contact shadow actually darkens the character',
    shade.full.inside < shade.off.inside * 0.97,
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
    store.patch({ 'stage.zoom': 0.9, 'stage.offsetX': 0, 'stage.offsetY': 0,
      'warp.wind': 0, 'body.breathAmount': 0, 'body.swayAmount': 0 });
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

    const maskOf = (name, mut) => {
      a.parts = all.filter((p) => p.name === name);
      window.__t.pose(a, emptyRig, mut, 40);
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

    const LIMIT = 26;
    const POSES = [
      ['rest', {}],
      ['yaw +40', { head: { yaw: 0.70 } }],
      ['yaw -40', { head: { yaw: -0.70 } }],
      ['pitch -35', { head: { pitch: -0.60 } }],
      ['roll +30', { head: { roll: 0.52 } }],
      ['everything', { head: { yaw: -0.62, pitch: -0.45, roll: 0.40, x: -0.8, y: -0.5 } }],
    ];
    const out = [];
    for (const [label, mut] of POSES) {
      const wrap = maskOf('wrap', mut);
      const tails = maskOf('tails', mut);
      out.push({ label, gap: gap(wrap, tails, LIMIT) });
    }
    a.parts = all;
    return { out, LIMIT };
  });

  const worst = joined.out.reduce((a, b) => (b.gap > a.gap ? b : a));
  check('the scarf stays joined to itself in every pose',
    worst.gap <= 6,
    joined.out.map((o) => `${o.label} ${o.gap}px`).join(', '));

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
    const gl = a.gl;
    const centreY = () => {
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const d = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
      let n = 0, sy = 0;
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        if (d[i + 3] <= 40) continue;
        const x = p % w;
        n++; sy += h - 1 - ((p - x) / w);
      }
      return n ? sy / n : NaN;
    };
    const feed = (pitch, frames = 60) => {
      const f = { shapes: {}, head: { yaw: 0, pitch, roll: 0 }, position: { x: 0, y: 0, z: -45 } };
      for (let i = 0; i < frames; i++) { rig.update(f, true, 1 / 60); a.render(rig.state, 1 / 60); }
      return centreY();
    };
    const run = (invert) => {
      store.set('head.invertNod', invert);
      rig.clearCalibration();
      const rest = feed(0);
      const down = feed(-0.5) - rest;
      rig.clearCalibration();
      feed(0);
      const up = feed(0.5) - rest;
      return { down, up };
    };
    const plain = run(false);
    const inverted = run(true);
    store.set('head.invertNod', false);
    rig.clearCalibration();
    return { plain, inverted };
  });

  // Screen coordinates, so a positive number is further down the screen.
  check('looking down moves the model down, looking up moves it up',
    nod.plain.down > 1 && nod.plain.up < -1,
    `down ${nod.plain.down.toFixed(1)}px, up ${nod.plain.up.toFixed(1)}px`);

  check('and "Invert nod" reverses exactly that',
    nod.inverted.down < -1 && nod.inverted.up > 1,
    `down ${nod.inverted.down.toFixed(1)}px, up ${nod.inverted.up.toFixed(1)}px`);

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('test run completed', false, err.stack);
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${failures ? `${failures} failing` : 'all motion checks passed'}`);
process.exit(failures ? 1 : 0);
