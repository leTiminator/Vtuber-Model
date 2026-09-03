/**
 * What the model does over time, driven by a real recorded session.
 *
 * Every other check in this repo looks at a still frame, or at a synthetic
 * sweep, and asks whether the pixels are where they should be. That cannot see
 * the faults people actually report — eyes sliding across the face while
 * somebody talks, a scarf that has stopped reading as cloth, a body arriving
 * late. Those are properties of motion, and a still has none.
 *
 * So this drives the whole pipeline — the real Rig, not a synthetic rig object
 * — with a recorded session, and reports how things MOVED. It also writes a
 * filmstrip, because a number is worth having and a picture is worth looking
 * at, and the failures here were repeatedly ones that a person could see in a
 * second and no assertion had ever been written for.
 *
 *   node scripts/visual/dynamics.mjs [out.png]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const SESSION = JSON.parse(readFileSync(
  new URL('../../test/fixtures/tracker-session.json', import.meta.url), 'utf8'));

const OUT = process.argv[2] ?? 'dynamics.png';
const CHROME = process.env.CHROME_BIN ?? '/opt/pw-browsers/chromium';

const server = await createServer({ server: { port: 5208 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--enable-unsafe-swiftshader', '--no-proxy-server'],
});
const page = await (await browser.newContext({ viewport: { width: 500, height: 500 } })).newPage();
page.on('pageerror', (e) => console.error('PAGEERROR', String(e)));

try {
  await page.goto('http://127.0.0.1:5208/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vtuber?.avatars?.parts2d?.ready === true,
    null, { timeout: 40000 });

  const result = await page.evaluate(async (session) => {
    const { avatars, store, rig } = window.__vtuber;
    const a = avatars.parts2d;
    store.reset();
    a.resize(360, 360, 1);

    const gl = a.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;

    // Where a group of parts sits this frame, as the middle of its silhouette.
    const spanOf = (names) => {
      const keep = a.parts;
      a.parts = keep.filter((p) => names.includes(p.name));
      a.render(rig.state, 1 / 30);
      const d = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
      a.parts = keep;
      let lo = w; let hi = -1; let loY = h; let hiY = -1;
      for (let k = 0, p = 0; k < d.length; k += 4, p++) {
        if (d[k + 3] <= 120) continue;
        const x = p % w;
        const y = (p - x) / w;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
        if (y < loY) loY = y;
        if (y > hiY) hiY = y;
      }
      return hi < 0 ? null : { cx: (lo + hi) / 2, cy: (loY + hiY) / 2, lo, hi };
    };

    const track = [];
    const shots = [];
    // Twelve evenly spaced frames across the session, for the filmstrip.
    const want = new Set();
    for (let i = 0; i < 12; i++) want.add(Math.floor(i * (session.samples.length - 1) / 11));

    let changes = 0;
    let wasSquare = null;
    let prevT = 0;

    for (let i = 0; i < session.samples.length; i++) {
      const s = session.samples[i];
      const dt = Math.min(Math.max(s.t - prevT, 1 / 120), 1 / 10);
      prevT = s.t;
      const frame = s.face
        ? { shapes: {}, head: s.face.head, position: s.face.position }
        : null;
      rig.update(frame, Boolean(s.face), dt);
      a.render(rig.state, dt);

      if (a.squareOn !== wasSquare) {
        if (wasSquare !== null) changes++;
        wasSquare = a.squareOn;
      }

      // Sampling every part every frame is far too slow; a regular stride is
      // plenty to see travel and lag at thirty hertz.
      if (i % 6 === 0) {
        const head = spanOf(['head']);
        const eyes = spanOf(['eyeNear', 'eyeFar']);
        const tails = spanOf(['tails']);
        const body = spanOf(['body']);
        if (head && eyes && tails && body) {
          track.push({
            t: +s.t.toFixed(2),
            headCx: +head.cx.toFixed(1),
            // The eyes measured ON the face, which is what "the eyes slide"
            // means — their offset from the head, not their screen position.
            eyeOnFace: +(eyes.cx - head.cx).toFixed(1),
            tailsCx: +tails.cx.toFixed(1),
            tailsCy: +tails.cy.toFixed(1),
            bodyCx: +body.cx.toFixed(1),
            square: a.squareOn,
          });
        }
      }

      if (want.has(i)) {
        /* Draw the whole model again before grabbing it.
         *
         * The measurements above filter the part list to weigh one piece at a
         * time and leave the canvas holding whichever they looked at last. A
         * capture taken straight afterwards is that fragment, not the model —
         * three frames of this strip came back as two grey blobs and looked
         * exactly like the character falling apart when tracking dropped.
         */
        a.render(rig.state, 1 / 240);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(a.canvas, 0, 0);
        shots.push({ t: +s.t.toFixed(1), url: c.toDataURL('image/png') });
      }
    }

    // Stitch the filmstrip: 4 across, 3 down.
    const cols = 4;
    const rows = Math.ceil(shots.length / cols);
    const strip = document.createElement('canvas');
    strip.width = w * cols;
    strip.height = h * rows;
    const ctx = strip.getContext('2d');
    ctx.fillStyle = '#101216';
    ctx.fillRect(0, 0, strip.width, strip.height);
    await Promise.all(shots.map((s, i) => new Promise((done) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, (i % cols) * w, Math.floor(i / cols) * h);
        ctx.fillStyle = '#9fb0c8';
        ctx.font = '16px monospace';
        ctx.fillText(`${s.t}s`, (i % cols) * w + 8, Math.floor(i / cols) * h + 22);
        done();
      };
      img.src = s.url;
    })));

    store.reset();
    return {
      strip: strip.toDataURL('image/png'),
      seconds: session.seconds,
      changes,
      track,
      headOnSolved: Boolean(a.headOn),
      spineNodes: a.spine?.nodes?.length ?? 0,
      spineSpan: +(a.spineSpan ?? 0).toFixed(4),
    };
  }, SESSION);

  writeFileSync(OUT, Buffer.from(result.strip.split(',')[1], 'base64'));

  const t = result.track;
  const spread = (k) => {
    const v = t.map((r) => r[k]);
    return Math.max(...v) - Math.min(...v);
  };
  // Lag: how many samples of shift best lines a part up with the head.
  const lagOf = (k) => {
    const centre = (v) => { const m = v.reduce((s, x) => s + x, 0) / v.length; return v.map((x) => x - m); };
    const A = centre(t.map((r) => r.headCx));
    const B = centre(t.map((r) => r[k]));
    let best = 0; let bestScore = -Infinity;
    for (let lag = 0; lag <= 12; lag++) {
      let s = 0;
      for (let i = lag; i < A.length; i++) s += A[i - lag] * B[i];
      if (s > bestScore) { bestScore = s; best = lag; }
    }
    return best;
  };
  const perSample = 6 / 30; // stride of 6 at 30 Hz

  console.log(`\nsession ${result.seconds}s, ${t.length} samples`);
  console.log(`head-on solved: ${result.headOnSolved}`);
  console.log(`spine: ${result.spineNodes} nodes, links ${(result.spineSpan * 630).toFixed(0)}px apart`);
  console.log('');
  console.log(`head-on changed hands ${result.changes} times`
    + ` (${(result.changes / (result.seconds / 60)).toFixed(1)}/min)`);
  console.log(`eyes travelled ${spread('eyeOnFace').toFixed(1)}px ACROSS THE FACE`);
  console.log(`scarf travelled ${spread('tailsCx').toFixed(1)}px across, ${spread('tailsCy').toFixed(1)}px down`);
  console.log(`body travelled ${spread('bodyCx').toFixed(1)}px, head ${spread('headCx').toFixed(1)}px`);
  console.log(`scarf lags head by ${(lagOf('tailsCx') * perSample * 1000).toFixed(0)}ms`);
  console.log(`body lags head by ${(lagOf('bodyCx') * perSample * 1000).toFixed(0)}ms`);
  console.log(`\nfilmstrip -> ${OUT}`);
} finally {
  await browser.close();
  await server.close();
}
