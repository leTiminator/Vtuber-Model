/**
 * What the model does over time, driven by a real recorded session.
 *
 * Every other check in this repo looks at a still frame, or at a synthetic
 * sweep, and asks whether the pixels are where they should be. That cannot see
 * the faults people actually report — eyes sliding across the face while
 * somebody talks, a scarf that has stopped reading as cloth, a hip dragged
 * about by the cloth over it. Those are properties of motion, and a still has
 * none.
 *
 * So this drives the whole pipeline — the real Rig, not a synthetic rig object
 * — with a recorded session, and reports how things MOVED.
 *
 * It also renders the worst frame on purpose. The hand-over between the two
 * faces lasts a fifth of a second and is the moment everything about it can go
 * wrong; a filmstrip of evenly spaced frames will almost never contain one. So
 * the eyes are captured on every frame of a hand-over, magnified, and written
 * out as their own strip to be looked at.
 *
 *   node scripts/visual/dynamics.mjs [out.png]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { chromeBin } from '../chrome.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const SESSION = JSON.parse(readFileSync(
  new URL('../../test/fixtures/tracker-session.json', import.meta.url), 'utf8'));

const OUT = process.argv[2] ?? 'dynamics.png';
const EYES_OUT = OUT.replace(/(\.png)?$/, '-eyes.png');

const server = await createServer({ server: { port: 5208 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: chromeBin(),
  args: ['--enable-unsafe-swiftshader', '--no-proxy-server'],
});
const page = await (await browser.newContext({ viewport: { width: 500, height: 500 } })).newPage();
page.on('pageerror', (e) => console.error('PAGEERROR', String(e)));

try {
  await page.goto('http://127.0.0.1:5208/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vtuber?.avatars?.parts2d?.ready === true,
    null, { timeout: 60000 });

  const result = await page.evaluate(async (session) => {
    const { Rig } = await import('/src/tracking/rig.js');
    const { avatars, store } = window.__vtuber;
    // A rig per pass, built fresh. The passes below run the same minute two
    // and three times over to compare a setting against itself, and a rig
    // carries filters, springs and a neutral pose from one run into the next —
    // so the later passes were being fed a differently-warmed tracker and the
    // comparison was between two runs, not between two settings.
    let rig = new Rig();
    const a = avatars.parts2d;
    store.reset();
    a.resize(360, 360, 1);

    const gl = a.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);

    /* Where a group of parts sits this frame.
     *
     * Drawn with a zero step, so weighing the model does not also drive it.
     * Every draw used to advance the springs, the cloth and the hand-over by a
     * frame, and there are half a dozen of these per sample — so the harness
     * was running the model at seven times speed while asking whether it was
     * calm, and reporting the answer as if it were not.
     *
     * Two positions come back, because a fade and a move need different
     * questions asked of them. The silhouette's middle is where the shape is;
     * the alpha-weighted centre is where the eye reads it, which through a
     * cross-fade slides smoothly from one drawing to the other while a
     * threshold on alpha makes it jump the instant a fading copy crosses 50%.
     * That jump is a property of the ruler and not of the model, and it is
     * exactly the sort of thing that has been reported here as a fault before.
     *
     * `band` restricts the measurement to a slice of the canvas, which is how
     * the hip is asked about separately from the shoulders above it.
     */
    const spanOf = (names, band) => {
      const keep = a.parts;
      a.parts = keep.filter((p) => names.includes(p.name));
      a.render(rig.state, 0);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      a.parts = keep;
      let lo = w; let hi = -1; let loY = h; let hiY = -1;
      let sum = 0; let sx = 0; let sy = 0;
      const y0 = band ? Math.round(band[0] * h) : 0;
      const y1 = band ? Math.round(band[1] * h) : h;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < w; x++) {
          const alpha = buf[(y * w + x) * 4 + 3];
          if (alpha <= 8) continue;
          sum += alpha; sx += alpha * x; sy += alpha * y;
          if (alpha <= 120) continue;
          if (x < lo) lo = x;
          if (x > hi) hi = x;
          if (y < loY) loY = y;
          if (y > hiY) hiY = y;
        }
      }
      if (hi < 0) return null;
      return {
        cx: (lo + hi) / 2, cy: (loY + hiY) / 2, lo, hi,
        wx: sx / sum, wy: sy / sum,
      };
    };

    const EYE_PARTS = ['eyeNear', 'eyeFar', 'eyeNearOn', 'eyeFarOn'];
    // Both heads: only one is ever drawn, and asking for the wrong one gets a
    // blank canvas and a measurement of nothing.
    const HEAD_PARTS = ['head', 'headOn'];
    const grab = () => {
      // The measurements above filter the part list and leave the canvas
      // holding whichever piece they looked at last. Draw the model again
      // before capturing, or the strip is fragments.
      a.render(rig.state, 1 / 240);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(a.canvas, 0, 0);
      return c;
    };

    /* Where to crop for the eye strip: measured once, from the union of all
     * four shards with the model at rest, so the window holds every position
     * either pair can be in and the crops are comparable frame to frame. */
    rig.update(null, false, 1 / 30);
    a.render(rig.state, 1 / 30);
    const eyeBox = spanOf(EYE_PARTS) ?? { lo: 0, hi: w, cy: h / 2, wx: w / 2, wy: h / 2 };
    /* The eye crop follows the head, not the canvas.
     *
     * A window fixed to the canvas is useless here: the head moves 34 pixels
     * over the minute, so the first cut of this strip framed the crown of the
     * hood and caught the eyes only at the very bottom edge. Registered on the
     * head, every tile holds the head in the same place and the only thing
     * that can move between tiles is the eyes on it — which is the entire
     * question being asked. */
    const headRest = spanOf(HEAD_PARTS) ?? { wx: w / 2, wy: h / 2 };
    const EYE_OFF = [eyeBox.wx - headRest.wx, eyeBox.wy - headRest.wy];
    /* Which rows of the canvas the hip is on, measured rather than guessed.
     * Framing is a setting, so a fraction typed in here reports NaN the moment
     * the zoom changes — which is what it did on the first run of this. */
    const bodyBox = spanOf(['body']);
    const HIP = bodyBox
      ? [(bodyBox.cy + (bodyBox.cy - eyeBox.cy) * 0.15) / h, 1]
      : [0.6, 1];
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    /* How far the cloth has been moved from where it was drawn, in artwork
     * pixels, over the lower part of the scarf — the drape that lies across
     * the hip.
     *
     * Read off the cloth's own vertices rather than off the picture. A band of
     * the canvas holds whatever cloth happens to be in it, so when the drape
     * stopped swinging the arc above it simply swung further into the band and
     * the number went UP — reporting the fix as a regression. Vertices cannot
     * be confused about which piece of cloth they are.
     */
    const H = a.imageSize?.height ?? 630;
    const tails = a.parts.find((p) => p.name === 'tails');
    const hipRows = [];
    if (tails?.rest) {
      for (let v = 0; v < tails.rest.length; v += 2) {
        if (tails.rest[v + 1] > 0.70) hipRows.push(v);
      }
    }
    const drapeMoved = () => {
      if (!tails?.live || !hipRows.length) return null;
      let worst = 0;
      for (const v of hipRows) {
        const dx = (tails.live[v] - tails.rest[v]) * H;
        const dy = (tails.live[v + 1] - tails.rest[v + 1]) * H;
        worst = Math.max(worst, Math.hypot(dx, dy));
      }
      return +worst.toFixed(1);
    };
    const CROP = { w: Math.min(w, Math.round(eyeBox.hi - eyeBox.lo + 60)), h: 72 };
    const cropAt = (head) => ({
      sx: Math.round(clamp(head.wx + EYE_OFF[0] - CROP.w / 2, 0, w - CROP.w)),
      sy: Math.round(clamp(head.wy + EYE_OFF[1] - CROP.h / 2, 0, h - CROP.h)),
    });

    const want = new Set();
    for (let i = 0; i < 12; i++) want.add(Math.floor(i * (session.samples.length - 1) / 11));

    /* The same minute twice: once with the head-on face and once without.
     *
     * "The eyes travelled 62 pixels across the face" is not a fault on its
     * own. A face turning forty degrees moves its eyes across the visor, and
     * should. The only number that says anything about this feature is how
     * much it ADDS to that, so the run without it is the control and the
     * difference is the answer. Reporting the first figure alone is how a
     * measurement gets quoted as a fault it cannot distinguish.
     */
    const pass = (headOnAmount, capture) => {
    store.patch({ 'parts.headOn': headOnAmount });
    rig = new Rig();
    a.squareOn = true;
    a.headOnPhase = 1;
    a.yawHeld = undefined;
    a.squareSince = 0;
    a.scarf.reset();
    const track = [];
    const shots = [];
    const eyeShots = [];

    let changes = 0;
    let wasSquare = null;
    let prevT = 0;
    let prevEye = null;
    let worstEyeStep = 0;
    let worstEyeAt = 0;

    for (let i = 0; i < session.samples.length; i++) {
      const s = session.samples[i];
      const dt = Math.min(Math.max(s.t - prevT, 1 / 120), 1 / 10);
      prevT = s.t;
      const frame = s.face
        ? { shapes: {}, head: s.face.head, position: s.face.position }
        : null;
      rig.update(frame, Boolean(s.face), dt);
      a.render(rig.state, dt);

      /* Which face is on screen, not which one the latch has decided on.
       *
       * They are the same decision a fraction of a second apart, and reading
       * the latch here meant skipping the frame before the drawing actually
       * changed and then counting the change itself as nine pixels of eye
       * movement. The renderer says which face it drew.
       */
      const swapped = wasSquare !== null && a.faceOn !== wasSquare;
      if (swapped) changes++;
      wasSquare = a.faceOn;

      /* Mid-hand-over: every frame, not every sixth.
       *
       * The whole question about the eyes is what they do during the fifth of
       * a second when the face changes hands, and a stride of six samples that
       * fifth of a second almost entirely. So while the phase is between its
       * two ends, the eyes are measured on each frame and the crop is kept.
       */
      const handing = a.headOnPhase > 0.001 && a.headOnPhase < 0.999;
      if (handing || i % 6 === 0) {
        const head = spanOf(HEAD_PARTS);
        const eyes = spanOf(EYE_PARTS);
        if (head && eyes) {
          const onFace = eyes.wx - head.wx;
          /* The frame the face changes hands on is stepped over.
           *
           * The two faces are two drawings, and they swap rather than fade, so
           * that step is deliberate and its size is the difference between the
           * drawings. Counting it as the worst frame would report a designed
           * event as a drift, and the whole point of this harness is to tell
           * those two apart. It is counted on its own, above.
           */
          if (prevEye !== null && !swapped) {
            const step = Math.abs(onFace - prevEye);
            if (step > worstEyeStep) { worstEyeStep = step; worstEyeAt = s.t; }
          }
          prevEye = onFace;
        }
        if (capture && handing && eyeShots.length < 24 && head) {
          eyeShots.push({
            t: +s.t.toFixed(2), phase: +a.headOnPhase.toFixed(2),
            canvas: grab(), ...cropAt(head),
          });
        }
      } else {
        prevEye = null; // a gap in sampling is not a jump
      }

      if (i % 6 === 0) {
        const head = spanOf(HEAD_PARTS);
        const eyes = spanOf(EYE_PARTS);
        const tails = spanOf(['tails']);
        const drape = spanOf(['tails'], HIP);
        const body = spanOf(['body']);
        const hip = spanOf(['body'], HIP);
        if (head && eyes && tails && body) {
          track.push({
            t: +s.t.toFixed(2),
            headCx: +head.cx.toFixed(1),
            // The eyes measured ON the face, which is what "the eyes slide"
            // means — their offset from the head, not their screen position.
            eyeOnFace: +(eyes.wx - head.wx).toFixed(1),
            eyeBoxOnFace: +(eyes.cx - head.cx).toFixed(1),
            tailsCx: +tails.cx.toFixed(1),
            tailsCy: +tails.cy.toFixed(1),
            drapeCx: drape ? +drape.cx.toFixed(1) : null,
            drapeCy: drape ? +drape.cy.toFixed(1) : null,
            // How far the cloth over the hip has been pulled from where it
            // was drawn — the complaint, measured on the cloth itself.
            drapeMoved: drapeMoved(),
            hipCx: hip ? +hip.cx.toFixed(1) : null,
            hipLo: hip ? hip.lo : null,
            hipHi: hip ? hip.hi : null,
            bodyCx: +body.cx.toFixed(1),
            square: a.squareOn,
          });
        }
      }

      if (capture && want.has(i)) shots.push({ t: +s.t.toFixed(1), canvas: grab() });
    }
    return { track, shots, eyeShots, changes, worstEyeStep: +worstEyeStep.toFixed(2), worstEyeAt };
    };

    const live = pass(1, true);
    const control = pass(0, false);
    /* And once with the loose ends let go of, which is what the scarf did
     * before: everything off the chain carried rigidly from its far end. */
    store.patch({ 'parts.clothReach': 40 });
    const loose = pass(1, false);
    store.patch({ 'parts.clothReach': 2 });
    const { track, shots, eyeShots, changes, worstEyeStep, worstEyeAt } = live;

    const stitch = (frames, cols, cw, ch, label, scale = 1) => {
      const rows = Math.ceil(frames.length / cols);
      const strip = document.createElement('canvas');
      strip.width = cw * scale * cols;
      strip.height = ch * scale * rows;
      const ctx = strip.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#101216';
      ctx.fillRect(0, 0, strip.width, strip.height);
      frames.forEach((f, i) => {
        const dx = (i % cols) * cw * scale;
        const dy = Math.floor(i / cols) * ch * scale;
        ctx.drawImage(f.canvas, f.sx ?? 0, f.sy ?? 0, cw, ch,
          dx, dy, cw * scale, ch * scale);
        ctx.fillStyle = '#9fb0c8';
        ctx.font = '14px monospace';
        ctx.fillText(label(f), dx + 6, dy + 18);
        ctx.strokeStyle = '#2b3140';
        ctx.strokeRect(dx + 0.5, dy + 0.5, cw * scale - 1, ch * scale - 1);
      });
      return strip.toDataURL('image/png');
    };

    const strip = stitch(shots, 4, w, h, (f) => `${f.t}s`);
    const eyeStrip = eyeShots.length
      ? stitch(eyeShots, 4, CROP.w, CROP.h, (f) => `${f.phase}`, 3)
      : null;

    store.reset();
    return {
      strip,
      eyeStrip,
      eyeFrames: eyeShots.length,
      seconds: session.seconds,
      changes,
      track,
      worstEyeStep,
      worstEyeAt,
      controlTrack: control.track,
      controlWorst: control.worstEyeStep,
      looseTrack: loose.track,
      headOnLoaded: Boolean(a.headOn),
      headOnNote: a.headOnNote ?? '',
      spineNodes: a.spine?.nodes?.length ?? 0,
      spineSpan: +(a.spineSpan ?? 0).toFixed(4),
    };
  }, SESSION);

  writeFileSync(OUT, Buffer.from(result.strip.split(',')[1], 'base64'));
  if (result.eyeStrip) {
    writeFileSync(EYES_OUT, Buffer.from(result.eyeStrip.split(',')[1], 'base64'));
  }

  const t = result.track;
  const spreadOf = (rows, k) => {
    const v = rows.map((r) => r[k]).filter((x) => x !== null && x !== undefined);
    return v.length ? Math.max(...v) - Math.min(...v) : NaN;
  };
  const spread = (k) => {
    const v = t.map((r) => r[k]).filter((x) => x !== null);
    return v.length ? Math.max(...v) - Math.min(...v) : NaN;
  };
  // Lag: how many samples of shift best lines a part up with the head.
  const lagOf = (k) => {
    const centre = (v) => { const m = v.reduce((s, x) => s + x, 0) / v.length; return v.map((x) => x - m); };
    const A = centre(t.map((r) => r.headCx));
    const B = centre(t.map((r) => r[k] ?? 0));
    let best = 0; let bestScore = -Infinity;
    for (let lag = 0; lag <= 12; lag++) {
      let s = 0;
      for (let i = lag; i < A.length; i++) s += A[i - lag] * B[i];
      if (s > bestScore) { bestScore = s; best = lag; }
    }
    return best;
  };
  const perSample = 6 / 30;

  console.log(`\nsession ${result.seconds}s, ${t.length} samples`);
  console.log(`head-on drawing: ${result.headOnLoaded ? 'loaded' : 'NOT LOADED'} — ${result.headOnNote}`);
  console.log(`spine: ${result.spineNodes} nodes, links ${(result.spineSpan * 630).toFixed(0)}px apart`);
  console.log('');
  console.log(`head-on changed hands ${result.changes} times`
    + ` (${(result.changes / (result.seconds / 60)).toFixed(1)}/min)`);
  const eyesLive = spread('eyeOnFace');
  const eyesCtl = spreadOf(result.controlTrack, 'eyeOnFace');
  console.log(`eyes travelled ${eyesLive.toFixed(1)}px ACROSS THE FACE`
    + ` — ${eyesCtl.toFixed(1)}px of that is the head turning (feature off),`
    + ` so the swap adds ${(eyesLive - eyesCtl).toFixed(1)}px`);
  console.log(`worst single-frame eye move ${result.worstEyeStep}px (at ${result.worstEyeAt}s,`
    + ` over ${result.eyeFrames} hand-over frames);`
    + ` with the feature off, ${result.controlWorst}px`);
  console.log(`scarf travelled ${spread('tailsCx').toFixed(1)}px across, ${spread('tailsCy').toFixed(1)}px down`);
  console.log(`hip drape travelled ${spread('drapeCx').toFixed(1)}px across,`
    + ` ${spread('drapeCy').toFixed(1)}px down — but that is mostly the body carrying it`);
  const worstOf = (rows, k) => {
    const v = rows.map((r) => r[k]).filter((x) => x !== null && x !== undefined);
    return v.length ? Math.max(...v) : NaN;
  };
  console.log(`SCARF OVER THE HIP pulled ${worstOf(t, 'drapeMoved').toFixed(1)}px`
    + ` off where it was drawn (worst frame) — with the loose ends let go of,`
    + ` ${worstOf(result.looseTrack, 'drapeMoved').toFixed(1)}px`);
  console.log(`hip itself moved ${spread('hipCx').toFixed(1)}px`
    + ` (edges ${spread('hipLo').toFixed(1)}px / ${spread('hipHi').toFixed(1)}px)`);
  console.log(`body travelled ${spread('bodyCx').toFixed(1)}px, head ${spread('headCx').toFixed(1)}px`);
  console.log(`scarf lags head by ${(lagOf('tailsCx') * perSample * 1000).toFixed(0)}ms`);
  console.log(`body lags head by ${(lagOf('bodyCx') * perSample * 1000).toFixed(0)}ms`);
  console.log(`\nfilmstrip -> ${OUT}`);
  if (result.eyeStrip) console.log(`hand-over, eyes magnified -> ${EYES_OUT}`);
  else console.log('no hand-over happened in this session');
} finally {
  await browser.close();
  await server.close();
}
