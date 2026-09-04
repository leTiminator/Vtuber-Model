/**
 * The two faces, side by side, and the moment between them.
 *
 * The model carries two drawings of this head — the one the artist drew turned
 * away, and the one they drew looking at the camera — and swaps between them.
 * Everything about that swap is a question you answer by looking: whether the
 * two read as the same character, whether the repaired eyes come back clean,
 * and what the halfway frame does.
 *
 * That halfway frame is the point. It lasts a fifth of a second and never
 * appears in an evenly spaced filmstrip, so it is posed deliberately here. Two
 * faults were caught this way and by nothing else: the repaired shard came
 * back speckled with grey where the key had thinned it rather than removed it,
 * and a straight cross-fade put both copies at half opacity halfway through,
 * so the eyes went visibly see-through in the middle of every change of view.
 *
 *   node scripts/visual/faces.mjs [out.png]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { chromeBin } from '../chrome.mjs';
import { writeFileSync } from 'node:fs';

const OUT = process.argv[2] ?? 'faces.png';

const server = await createServer({ server: { port: 5222 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: chromeBin(),
  args: ['--enable-unsafe-swiftshader', '--no-proxy-server'],
});
const page = await (await browser.newContext({ viewport: { width: 700, height: 700 } })).newPage();
page.on('pageerror', (e) => console.error('PAGEERROR', String(e)));

try {
  await page.goto('http://127.0.0.1:5222/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vtuber?.avatars?.parts2d?.ready === true,
    null, { timeout: 60000 });

  const out = await page.evaluate(async () => {
    const { fitTo } = await import('/src/core/framing.js');
    const { avatars, store, emptyRig } = window.__vtuber;
    const a = avatars.parts2d;
    store.reset();
    // Everything that drifts on its own, off. The question here is which
    // drawing is on the visor, and cloth swinging past the jaw only makes two
    // frames harder to compare.
    store.patch({ 'warp.clothWeight': 0, 'warp.wind': 0, 'warp.overshoot': 0,
      'body.breathAmount': 0, 'body.swayAmount': 0, 'body.hairPhysics': 0,
      'warp.eyeGlow': 0 });
    a.resize(400, 340, 2);
    const gl = a.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;

    /* Framed on the head the renderer found, not on typed-in offsets. The
     * first cut of this used a guessed zoom and offset and framed the back of
     * the hood — three renders of the wrong thing before anyone noticed. */
    const span = a.headSpan;
    const box = {
      x0: span.cx - span.r * 1.5 / a.aspect, y0: span.cy - span.r * 1.5,
      x1: span.cx + span.r * 1.5 / a.aspect, y1: span.cy + span.r * 1.5,
    };
    const fit = fitTo(a.aspect, w, h, box, 0.98);
    store.patch({ 'stage.zoom': fit.zoom, 'stage.offsetX': fit.offX,
      'stage.offsetY': fit.offY });

    const pose = (yaw, phase, blink = 0) => {
      const rig = emptyRig();
      rig.head.yaw = yaw;
      rig.eyes.blinkL = blink;
      rig.eyes.blinkR = blink;
      for (let f = 0; f < 60; f++) a.render(rig, 1 / 60);
      // Set the hand-over where it is wanted and redraw without stepping, so
      // the phase stays put instead of running on to whichever end it was
      // heading for.
      if (phase !== undefined) { a.headOnPhase = phase; a.render(rig, 0); }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(a.canvas, 0, 0);
      return c;
    };

    const tiles = [
      { label: 'facing you — the frontal drawing', c: pose(0) },
      { label: 'turned away — the original drawing', c: pose(0.42) },
      { label: 'the frame before the swap', c: pose(0, 0.49) },
      { label: 'the frame after it', c: pose(0, 0.51) },
      { label: 'half a blink, facing you', c: pose(0, undefined, 0.5) },
    ];

    const strip = document.createElement('canvas');
    strip.width = w;
    strip.height = h * tiles.length;
    const ctx = strip.getContext('2d');
    ctx.fillStyle = '#101216';
    ctx.fillRect(0, 0, strip.width, strip.height);
    tiles.forEach((t, i) => {
      ctx.drawImage(t.c, 0, i * h);
      ctx.fillStyle = '#cfe0f8';
      ctx.font = '20px monospace';
      ctx.fillText(t.label, 12, i * h + 28);
    });
    store.reset();
    return strip.toDataURL('image/png');
  });

  writeFileSync(OUT, Buffer.from(out.split(',')[1], 'base64'));
  console.log(`faces -> ${OUT}`);
} finally {
  await browser.close();
  await server.close();
}
