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
  check('the eye sockets were measured, not guessed from the marker',
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
    store.patch({ 'stage.zoom': 1.15, 'stage.offsetX': 0, 'stage.offsetY': 0 });

    const base = window.__t.stats(window.__t.read(a));
    const baseBlobs = window.__t.blobs(window.__t.read(a), 60);

    const out = { base, baseBlobs, worstPartial: 0, worstPartialAt: 0,
      worstArea: 1, worstAreaAt: 0, maxBlobs: baseBlobs, maxBlobsAt: 0,
      maxJump: 0, maxJumpAt: 0 };

    let prev = null;
    // Past the rig's own clamp, so the extremes really are exercised.
    for (let deg = -46; deg <= 46; deg += 2) {
      const yaw = (deg * Math.PI) / 180;
      window.__t.pose(a, emptyRig, {
        head: { yaw, pitch: 0.18 * Math.sin(deg / 9), roll: 0.22 * Math.sin(deg / 13) },
      }, 26);
      const shot = window.__t.read(a);
      const s = window.__t.stats(shot);

      const partial = s.partial / Math.max(s.opaque, 1);
      if (partial > out.worstPartial) { out.worstPartial = partial; out.worstPartialAt = deg; }

      const area = s.opaque / Math.max(base.opaque, 1);
      if (area < out.worstArea) { out.worstArea = area; out.worstAreaAt = deg; }

      const blobs = window.__t.blobs(shot, 60);
      if (blobs > out.maxBlobs) { out.maxBlobs = blobs; out.maxBlobsAt = deg; }

      if (prev) {
        const jump = Math.hypot(s.cx - prev.cx, s.cy - prev.cy);
        if (jump > out.maxJump) { out.maxJump = jump; out.maxJumpAt = deg; }
      }
      prev = s;
    }
    return out;
  });

  // The cross-fade bug: two half-faded copies composite to 0.75 alpha, so the
  // background showed through the helmet. It is invisible to an opaque-pixel
  // count and obvious in the proportion that are part-transparent.
  check('nothing goes translucent through the range of motion',
    sweep.worstPartial < 0.30,
    `worst ${(sweep.worstPartial * 100).toFixed(1)}% part-transparent at ${sweep.worstPartialAt}°` +
    ` (rest ${((sweep.base.partial / sweep.base.opaque) * 100).toFixed(1)}%)`);

  check('the character does not shrink or vanish at the extremes',
    sweep.worstArea > 0.72, `smallest ${(sweep.worstArea * 100).toFixed(0)}% of rest at ${sweep.worstAreaAt}°`);

  // Cloth tearing loose from the body shows up as pieces that were not there
  // at rest.
  check('the character does not come apart into extra pieces',
    sweep.maxBlobs <= sweep.baseBlobs + 2,
    `${sweep.maxBlobs} pieces at ${sweep.maxBlobsAt}°, ${sweep.baseBlobs} at rest`);

  check('the pose moves smoothly, with no pops',
    sweep.maxJump < 14, `largest step ${sweep.maxJump.toFixed(1)}px at ${sweep.maxJumpAt}°`);

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
      // Within the eye's own region. The visor carries a painted specular
      // highlight on its rim that is not an eye and must not blink, so
      // counting near-white across the whole frame flags the artwork.
      shutLit: nearWhite(shut, region),
      highlightLit: nearWhite(shut, all),
      halfLit: nearWhite(half, region),
      glowChanged: glowDiff.length,
      spill,
      glowShutChanged: diff(shut, shutGlowOff).length,
      gazeChanged: diff(gazeL, gazeR).length,
    };
  });

  check('closing the eye changes a meaningful area', looks.regionPx > 150, `${looks.regionPx}px`);
  check('the eye is lit when open', looks.openLit > 120, `${looks.openLit}px`);
  // The lid was sized to the marker box, which left the end of the slit lit
  // however far the blink went.
  check('a shut eye leaves no lit sliver', looks.shutLit === 0,
    `${looks.shutLit}px still lit (open ${looks.openLit})`);
  // And the lid must not eat the visor's painted rim highlight along with it.
  check('shutting the eye leaves the visor highlight alone', looks.highlightLit > 40,
    `${looks.highlightLit}px of highlight survive`);
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

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('test run completed', false, err.stack);
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${failures ? `${failures} failing` : 'all motion checks passed'}`);
process.exit(failures ? 1 : 0);
