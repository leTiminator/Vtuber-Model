/**
 * The one way every browser suite and visual script boots the app.
 *
 * boot() starts Vite on a free port (strictPort, so a leaked server cannot
 * serve a suite stale code), launches Chromium on software GL, wires error
 * capture with one shared noise filter, installs the page-side helpers under
 * window.__t, and waits for the parts model to be ready.
 *
 * It also snapshots the marker settings the app detected at boot. store.reset()
 * restores generic defaults for those nine keys, which is not the model anyone
 * sees, so every check block goes through __t.resetStore(), which resets and
 * then puts the detected markers back.
 */
import net from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { PNG } from 'pngjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'test', 'out');

/** Console errors that are MediaPipe or Chromium chatter, not faults. */
export const NOISE = /favicon|404|^INFO:|XNNPACK delegate|GL Driver Message|OpenGL error checking/i;

/** The settings the cut reads. Re-applied after every reset until the cut is baked. */
export const MARKER_KEYS = ['warp.headX', 'warp.headY', 'warp.headR', 'warp.pivotX',
  'warp.pivotY', 'warp.waistY', 'warp.eyeAngle', 'warp.eyeL', 'warp.eyeR'];

/** Physics and framing held still, so a render is a function of the rig alone. */
export const FROZEN = {
  'warp.wind': 0, 'warp.clothWeight': 0, 'warp.tuftWeight': 0, 'warp.overshoot': 0,
  'body.breathAmount': 0, 'body.swayAmount': 0, 'body.hairPhysics': 0,
  'stage.zoom': 0.9, 'stage.offsetX': 0, 'stage.offsetY': 0,
};

/**
 * The canonical poses. Each is rendered on a fresh, reset renderer with FROZEN
 * plus its own settings, then the rig mutation held for `frames` renders at
 * 1/60 s. `drive` is a list of [frames, rigMutation] segments for poses that
 * need motion before the frame that is kept.
 */
export const POSES = [
  { name: 'rest-headon', rig: {} },
  { name: 'rest-turned', rig: {}, settings: { 'parts.headOn': 0 } },
  { name: 'turn-left-mid', rig: { head: { yaw: -0.44 } } },
  { name: 'turn-right-mid', rig: { head: { yaw: 0.44 } } },
  { name: 'turn-left-limit', rig: { head: { yaw: -0.733 } } },
  { name: 'turn-right-limit', rig: { head: { yaw: 0.733 } } },
  { name: 'nod-up', rig: { head: { pitch: 0.38 } } },
  { name: 'nod-down', rig: { head: { pitch: -0.38 } } },
  { name: 'tilt', rig: { head: { roll: 0.34 } } },
  { name: 'blink-headon', rig: { eyes: { blinkL: 1, blinkR: 1 } } },
  { name: 'gaze-glow', rig: { eyes: { gazeX: 0.9, gazeY: -0.4, wideL: 0.6, wideR: 0.6 } } },
  { name: 'half-blink-turned',
    rig: { head: { yaw: -0.44 }, eyes: { blinkL: 0.5, blinkR: 0.5, squintL: 0.4, squintR: 0.4, gazeX: 0.8 } } },
  { name: 'arms-raised',
    rig: { arms: { left: { raise: 1.2, upper: 0.6, seen: 1, wrist: 1 },
      right: { raise: 0.4, upper: -0.3, seen: 1, wrist: 1 } },
    head: { x: 0.9 }, body: { leanX: 0.5, twist: 0.4 } } },
  { name: 'lean-faceflip', rig: { head: { yaw: -0.3 }, arms: { left: { raise: 1 } } },
    settings: { 'stage.faceFlip': true } },
  { name: 'scarf-settled', settings: { 'warp.clothWeight': 1, 'body.hairPhysics': 1 },
    drive: [[40, {}], [260, { head: { yaw: -0.5 } }]] },
  /* The one pose that goes through the compositor: a screenshot of the app's
   * own stage over white, so the alpha the canvas declares is what is
   * measured. Glow and auto-blink are off because the app's renderer cannot
   * be reset; the still model it settles to is the same every time. */
  { name: 'composited-on-white', screenshot: true,
    settings: { 'parts.headOn': 0, 'eyes.autoBlink': false, 'warp.eyeGlow': 0 } },
];

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Installed in every page before any script runs. */
export const PAGE_HELPERS = `
window.__t = {
  MARKERS: {},
  app() { return window.__vtuber ?? window.__vtuberOutput; },
  store() { return this.app().store; },
  merge(target, src) {
    for (const k of Object.keys(src || {})) {
      const v = src[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
        this.merge(target[k], v);
      } else {
        target[k] = v;
      }
    }
    return target;
  },
  rig(mut) { return this.merge(this.app().emptyRig(), mut); },
  // Pixels of a WebGL canvas, bottom-up as readPixels returns them.
  read(a) {
    const gl = a.gl;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const d = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
    return { d, w, h };
  },
  // The same, rows top-down as a PNG expects, as base64 so it crosses the
  // page boundary in one string rather than a million-element array.
  readTopDown(a) {
    const { d, w, h } = this.read(a);
    const out = new Uint8Array(d.length);
    for (let y = 0; y < h; y++) out.set(d.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    let bin = '';
    for (let i = 0; i < out.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
    }
    return { b64: btoa(bin), w, h };
  },
  // Hold a pose for a number of frames so springs and cloth settle.
  pose(a, emptyRig, mut, frames = 70) {
    const rig = this.merge(emptyRig(), mut);
    for (let f = 0; f < frames; f++) a.render(rig, 1 / 60);
    return rig;
  },
  stats({ d, w, h }) {
    let opaque = 0, partial = 0, sx = 0, sy = 0;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const alpha = d[i + 3];
      if (alpha <= 24) continue;
      opaque++;
      if (alpha < 236) partial++;
      const x = p % w;
      sx += x; sy += (p - x) / w;
    }
    return { opaque, partial, cx: opaque ? sx / opaque : 0, cy: opaque ? sy / opaque : 0 };
  },
  // Connected blobs of the silhouette, ignoring specks below minArea.
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
        const x = i % w, y = (i - x) / w;
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
  // Defaults, then the markers the app detected at boot, then anything extra.
  resetStore(extra) {
    const s = this.store();
    s.reset();
    s.patch(this.MARKERS);
    if (extra) s.patch(extra);
  },
  // A renderer of our own, in a detached div, so the app's animation loop
  // never advances it between evaluate calls.
  async makeAvatar(size = 480) {
    const { Parts2D } = await import('/src/avatars/parts/index.js');
    const src = this.app().avatars.parts2d;
    const a = new Parts2D();
    a.mount(document.createElement('div'));
    if (src.headOnImage) a.setHeadOnImage(src.headOnImage);
    a.setImage(src.image, false);
    a.resize(size, size, 1);
    return a;
  },
};
// The smoke suite reads whichever kind of canvas the backend made.
window.readCanvas = (c) => {
  const two = c.getContext('2d');
  if (two) return two.getImageData(0, 0, c.width, c.height);
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
  gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return { data };
};
`;

const READY = () => Boolean(window.__vtuber?.avatars?.parts2d?.ready
  || window.__vtuberOutput?.avatars?.parts2d?.ready);

/**
 * @param {object} [opts]
 * @param {'index'|'output'} [opts.page]
 * @param {{width:number,height:number}} [opts.viewport]
 * @param {boolean} [opts.camera]   fake webcam and microphone, with permission
 * @param {string[]} [opts.args]    extra Chromium flags
 * @param {boolean} [opts.waitReady]
 */
export async function boot({ page = 'index', viewport = { width: 480, height: 480 },
  camera = false, args = [], waitReady = true } = {}) {
  const port = Number(process.env.VTUBER_TEST_PORT) || await freePort();
  const server = await createServer({ server: { port, strictPort: true }, logLevel: 'error' });
  await server.listen();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || undefined,
    args: ['--enable-unsafe-swiftshader', '--no-proxy-server',
      ...(camera ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] : []),
      ...args],
  });
  const base = `http://127.0.0.1:${port}/`;
  const errors = [];

  const open = async (which, vp = viewport, cam = camera) => {
    const context = await browser.newContext({
      viewport: vp, permissions: cam ? ['camera', 'microphone'] : [],
    });
    const pg = await context.newPage();
    pg.on('pageerror', (e) => errors.push(`${which}: ${e}`));
    pg.on('console', (m) => {
      if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(`${which}: ${m.text()}`);
    });
    await pg.addInitScript(PAGE_HELPERS);
    await pg.goto(which === 'output' ? `${base}output.html` : base, { waitUntil: 'load' });
    if (waitReady) await pg.waitForFunction(READY, null, { timeout: 60000 });
    if (which === 'index' && waitReady) {
      const markers = await pg.evaluate((keys) => {
        const s = window.__vtuber.store;
        return Object.fromEntries(keys.filter((k) => s.get(k) !== undefined).map((k) => [k, s.get(k)]));
      }, MARKER_KEYS);
      await pg.evaluate((m) => { window.__t.MARKERS = m; }, markers);
    }
    return { page: pg, context };
  };

  const first = await open(page);
  return {
    page: first.page,
    context: first.context,
    errors,
    port,
    base,
    browser,
    server,
    /** A second page (its own context and storage) on the same server. */
    openPage: (which, vp, cam) => open(which, vp, cam),
    /** A separate browser with different launch flags, on the same server. */
    openBrowser: async (extraArgs = [], vp = viewport) => {
      const b = await chromium.launch({
        executablePath: process.env.CHROME_BIN || undefined,
        args: ['--enable-unsafe-swiftshader', '--no-proxy-server', ...extraArgs],
      });
      const ctx = await b.newContext({ viewport: vp });
      const pg = await ctx.newPage();
      await pg.addInitScript(PAGE_HELPERS);
      await pg.goto(base, { waitUntil: 'load' });
      return { page: pg, close: () => b.close() };
    },
    close: async () => {
      await browser.close();
      await server.close();
    },
  };
}

/** A check/finish pair with the failure counter every suite keeps. */
export function makeCheck(label) {
  let failures = 0;
  let total = 0;
  const check = (name, ok, detail = '') => {
    total++;
    if (!ok) failures++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const finish = () => {
    console.log(`\n${failures ? `${failures} of ${total} ${label} checks failing` : `all ${total} ${label} checks passed`}`);
    process.exit(failures ? 1 : 0);
  };
  return { check, finish, failed: () => failures };
}

/* ------------------------------------------------------------------ PNGs */

export function ensureOut(sub = '') {
  const dir = join(OUT, sub);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** @param {{d: ArrayLike<number>, w: number, h: number}} img rows top-down */
export function savePng(path, { d, w, h }) {
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(Uint8Array.from(d));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG.sync.write(png));
}

/** The image __t.readTopDown() returns, decoded. */
export function fromPage({ b64, w, h }) {
  const buf = Buffer.from(b64, 'base64');
  return { d: new Uint8Array(buf.buffer, buf.byteOffset, buf.length), w, h };
}

export function loadPng(path) {
  return decodePng(readFileSync(path));
}

export function decodePng(buffer) {
  const png = PNG.sync.read(buffer);
  return { d: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length), w: png.width, h: png.height };
}

/**
 * Compare two images of the same size. A pixel differs when any channel
 * differs by more than channelTol. The diff image shows the reference faded
 * with differing pixels in red.
 */
export function diffImages(a, b, { channelTol = 16 } = {}) {
  if (a.w !== b.w || a.h !== b.h) {
    return { differing: a.w * a.h, total: a.w * a.h, sizeMismatch: true, diff: null };
  }
  const n = a.w * a.h;
  const out = new Uint8Array(n * 4);
  let differing = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const bad = Math.abs(a.d[i] - b.d[i]) > channelTol || Math.abs(a.d[i + 1] - b.d[i + 1]) > channelTol
      || Math.abs(a.d[i + 2] - b.d[i + 2]) > channelTol || Math.abs(a.d[i + 3] - b.d[i + 3]) > channelTol;
    if (bad) {
      differing++;
      out[i] = 255; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 255;
    } else {
      const lum = (0.2126 * a.d[i] + 0.7152 * a.d[i + 1] + 0.0722 * a.d[i + 2]) * (a.d[i + 3] / 255);
      out[i] = out[i + 1] = out[i + 2] = 160 + lum * 0.35;
      out[i + 3] = 255;
    }
  }
  return { differing, total: n, sizeMismatch: false, diff: { d: out, w: a.w, h: a.h } };
}

/** Frames of one size laid out in a grid, left to right, top to bottom. */
export function contactSheet(frames, cols = 4) {
  if (!frames.length) return null;
  const { w, h } = frames[0];
  const rows = Math.ceil(frames.length / cols);
  const W = w * cols;
  const H = h * rows;
  const d = new Uint8Array(W * H * 4);
  frames.forEach((f, k) => {
    const ox = (k % cols) * w;
    const oy = Math.floor(k / cols) * h;
    for (let y = 0; y < h; y++) {
      const src = y * w * 4;
      const dst = ((oy + y) * W + ox) * 4;
      for (let i = 0; i < w * 4; i++) d[dst + i] = f.d[src + i];
    }
  });
  return { d, w: W, h: H };
}
