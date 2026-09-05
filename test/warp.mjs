/**
 * Tests the mesh-warp backend — the mode that rigs a single flat image.
 *
 * The fixture is generated here rather than committed: a small PNG with a
 * transparent background, a body, a head and two white eye patches, which is
 * enough to prove the warp moves the head, the lid paints over the eyes, and
 * the white key cuts a background out.
 *
 *   node test/warp.mjs
 */
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';
import { chromeBin } from '../scripts/chrome.mjs';
import { createServer } from 'vite';

let failures = 0;

function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

/* --------------------------------------------------------------- fixture */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Minimal RGBA PNG encoder — enough for a test fixture, no dependencies. */
function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const W = 400;
const H = 500;
const EYE = { l: [0.36, 0.26, 0.46, 0.32], r: [0.54, 0.26, 0.64, 0.32] };

function buildFixture({ opaqueBackground = false } = {}) {
  const px = Buffer.alloc(W * H * 4);
  const set = (x, y, r, g, b, a) => {
    const i = (y * W + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / H;
      if (opaqueBackground) set(x, y, 255, 255, 255, 255);

      // Body: a wide block in the lower half.
      if (v > 0.55 && Math.abs(u - 0.5) < 0.34) set(x, y, 60, 66, 78, 255);
      // Head: a circle in the upper half.
      if (Math.hypot((u - 0.5) * (W / H), v - 0.3) < 0.2) set(x, y, 90, 98, 112, 255);
      // Eyes: white patches on the head.
      for (const r of [EYE.l, EYE.r]) {
        if (u > r[0] && u < r[2] && v > r[1] && v < r[3]) set(x, y, 255, 255, 255, 255);
      }
    }
  }
  return encodePNG(W, H, px);
}

/** Does the detected box cover the middle of the real one? */
function overlaps(got, want) {
  const cx = (want[0] + want[2]) / 2;
  const cy = (want[1] + want[3]) / 2;
  return got[0] <= cx && got[2] >= cx && got[1] <= cy && got[3] >= cy;
}

const fmt = (r) => `[${r.map((n) => n.toFixed(2)).join(', ')}]`;

/**
 * A layout in the awkward shape of real character art: the head sits low and
 * off to one side, and flowing cloth above it is wider than the figure. A
 * detector that measures total opaque width per row picks the cloth; this is
 * the case that must not regress.
 */
const NINJA = {
  head: [0.68, 0.5, 0.16],
  eyeL: [0.625, 0.515, 0.675, 0.56],
  eyeR: [0.7, 0.515, 0.75, 0.56],
};

function buildNinjaFixture() {
  const px = Buffer.alloc(W * H * 4);
  const set = (x, y, r, g, b) => {
    const i = (y * W + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / H;

      // Ribbons: thin diagonal bands sweeping across the top-left, spanning
      // far wider than the character underneath them.
      for (const offset of [0.02, 0.16, 0.3]) {
        const band = v - (0.06 + offset + u * 0.22);
        if (u < 0.72 && v < 0.5 && Math.abs(band) < 0.028) set(x, y, 200, 40, 40);
      }

      // Body below and to the left of the head.
      if (v > 0.62 && Math.hypot((u - 0.54) / 0.2, (v - 0.82) / 0.2) < 1) set(x, y, 45, 48, 56);

      // Head.
      const [hx, hy, hr] = NINJA.head;
      if (Math.hypot((u - hx) * (W / H), v - hy) < hr) set(x, y, 58, 62, 70);
      // Visor on the lower front of the head.
      if (Math.hypot((u - hx + 0.03) / 0.11, (v - hy - 0.03) / 0.09) < 1) set(x, y, 130, 142, 165);
      // Eyes.
      for (const r of [NINJA.eyeL, NINJA.eyeR]) {
        if (u > r[0] && u < r[2] && v > r[1] && v < r[3]) set(x, y, 255, 255, 255);
      }
    }
  }
  return encodePNG(W, H, px);
}

/** One bright bar where two eyes have merged: the case real artwork produces. */
function buildMergedEyeFixture() {
  const px = Buffer.alloc(W * H * 4);
  const set = (x, y, r, g, b) => {
    const i = (y * W + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / H;
      if (v > 0.6 && Math.abs(u - 0.5) < 0.3) set(x, y, 50, 54, 62);
      if (Math.hypot((u - 0.5) * (W / H), v - 0.32) < 0.2) set(x, y, 70, 76, 88);
      // A single wide bright bar rather than two separate patches.
      if (u > 0.38 && u < 0.62 && v > 0.3 && v < 0.35) set(x, y, 255, 255, 255);
    }
  }
  return encodePNG(W, H, px);
}

/* ------------------------------------------------------------------ test */

const server = await createServer({ server: { port: 5190, strictPort: true }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  executablePath: chromeBin(),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ permissions: ['camera'], viewport: { width: 1000, height: 800 } });
const page = await context.newPage();

const errors = [];
const NOISE = /favicon|404|^INFO:|XNNPACK|GL Driver Message|OpenGL error checking/i;
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text());
});

/**
 * Render a pose into the warp canvas and summarise the pixels.
 * `frames` runs the sim on, which is how the time-dependent behaviour
 * (cloth lag, overshoot) becomes observable.
 */
const shoot = (pose) => page.evaluate((p) => {
  const { avatars, emptyRig, store } = window.__vtuber;
  for (const [k, v] of Object.entries(p.settings ?? {})) store.set(k, v);

  const rig = emptyRig();
  Object.assign(rig.head, p.head ?? {});
  Object.assign(rig.eyes, p.eyes ?? {});
  Object.assign(rig.body, p.body ?? {});

  const avatar = avatars.warp2d;
  for (let f = 0; f < (p.frames ?? 1); f++) avatar.render(rig, 1 / 60);

  const gl = avatar.gl;
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

  let opaque = 0;
  let white = 0;
  let signature = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i + 3] > 20) {
      opaque++;
      signature = (signature + buf[i] * 3 + buf[i + 1] * 5 + buf[i + 2] * 7 + (i % 977)) >>> 0;
      if (buf[i] > 230 && buf[i + 1] > 230 && buf[i + 2] > 230) white++;
    }
  }
  return { opaque, white, signature };
}, pose);

try {
  await page.goto('http://127.0.0.1:5190/', { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__vtuber), null, { timeout: 15000 });

  await page.locator('summary', { hasText: 'Your own artwork' }).click();
  await page.setInputFiles('input[accept="image/png,image/jpeg,image/webp"]', {
    name: 'artwork.png',
    mimeType: 'image/png',
    buffer: buildFixture(),
  });

  check('loading an image switches to the parts model',
    await page.evaluate(() => window.__vtuber.store.get('stage.avatar')) === 'parts2d');

  // The rest of this file is about the whole-image warp, which is still on
  // offer for artwork the parts rules do not suit — so select it explicitly
  // rather than relying on it being the default, which it no longer is.
  await page.evaluate(() => window.__vtuber.store.set('stage.avatar', 'warp2d'));
  await page.waitForFunction(() => window.__vtuber.avatars.warp2d.ready, null, { timeout: 15000 });

  check('the rig editor opens on load', await page.locator('#rig-editor').isVisible());
  const handles = await page.locator('#rig-editor .rig-handle').count();
  check('it offers head, neck, waist and both eyes', handles === 5, `${handles} handles`);

  // The markers should have been placed automatically from the image itself.
  const guessed = await page.evaluate(() => {
    const s = window.__vtuber.store;
    return {
      headX: s.get('warp.headX'),
      headY: s.get('warp.headY'),
      headR: s.get('warp.headR'),
      pivotY: s.get('warp.pivotY'),
      eyeL: JSON.parse(s.get('warp.eyeL')),
      eyeR: JSON.parse(s.get('warp.eyeR')),
    };
  });

  check('auto markup centres the head horizontally',
    Math.abs(guessed.headX - 0.5) < 0.06, `headX ${guessed.headX}`);
  check('auto markup puts the head in the upper half',
    guessed.headY > 0.15 && guessed.headY < 0.45, `headY ${guessed.headY}`);
  check('auto markup sizes the head sensibly',
    guessed.headR > 0.1 && guessed.headR < 0.35, `headR ${guessed.headR}`);
  check('auto markup finds the neck between head and body',
    guessed.pivotY > 0.4 && guessed.pivotY < 0.65, `pivotY ${guessed.pivotY}`);
  check('auto markup finds the left eye',
    overlaps(guessed.eyeL, EYE.l), `got ${fmt(guessed.eyeL)} want ~${fmt(EYE.l)}`);
  check('auto markup finds the right eye',
    overlaps(guessed.eyeR, EYE.r), `got ${fmt(guessed.eyeR)} want ~${fmt(EYE.r)}`);
  check('auto markup keeps the eyes in the right order',
    guessed.eyeL[0] < guessed.eyeR[0], 'left box is left of right box');

  await page.locator('#rig-editor [data-role="done"]').click();
  check('the editor closes on Done', !(await page.locator('#rig-editor').isVisible()));

  const neutral = await shoot({});
  check('the artwork renders', neutral.opaque > 5000, `${neutral.opaque} opaque px`);
  check('the eyes are visible at rest', neutral.white > 200, `${neutral.white} white px`);

  const turned = await shoot({ head: { yaw: 0.5 } });
  check('turning the head changes the render',
    turned.signature !== neutral.signature, 'pixels moved');

  const nodded = await shoot({ head: { pitch: 0.4 } });
  check('nodding changes the render', nodded.signature !== neutral.signature);

  const tilted = await shoot({ head: { roll: 0.35 } });
  check('tilting changes the render', tilted.signature !== neutral.signature);

  const blinked = await shoot({ eyes: { blinkL: 1, blinkR: 1 } });
  check('blinking paints over the eyes',
    blinked.white < neutral.white * 0.4,
    `${neutral.white} -> ${blinked.white} white px`);

  const halfBlink = await shoot({ eyes: { blinkL: 0.5, blinkR: 0.5 } });
  check('a half blink lands between open and closed',
    halfBlink.white < neutral.white && halfBlink.white > blinked.white,
    `${blinked.white} < ${halfBlink.white} < ${neutral.white}`);

  const winked = await shoot({ eyes: { blinkL: 1, blinkR: 0 } });
  check('each eye blinks independently',
    winked.white > blinked.white && winked.white < neutral.white,
    `${winked.white} white px`);

  const squinted = await shoot({ eyes: { squintL: 1, squintR: 1 } });
  check('squinting narrows the eyes without closing them',
    squinted.white < neutral.white * 0.85 && squinted.white > blinked.white,
    `${blinked.white} < ${squinted.white} < ${neutral.white}`);

  // --- motion over time -------------------------------------------------
  // Isolate the rig from idle drift so these compare like for like.
  const still = { 'warp.wind': 0 };

  const settled = await shoot({ settings: still, frames: 240 });
  const whipped = await shoot({ settings: still, head: { yaw: 0.5 }, frames: 2 });
  const returned = await shoot({ settings: still, frames: 3 });
  check('cloth keeps moving after the head stops',
    returned.signature !== settled.signature,
    'still swinging one frame after the pose returned to rest');

  const resettled = await shoot({ settings: still, frames: 400 });
  check('cloth comes back to rest',
    Math.abs(resettled.opaque - settled.opaque) < settled.opaque * 0.02,
    `${settled.opaque} -> ${resettled.opaque} opaque px`);

  // Overshoot: with the spring off the head is at its target immediately, so
  // an early frame and a late frame match. With it on, they must not. Cloth is
  // switched off here or its own settling would answer the question instead.
  // Cloth and the glow pulse are both time-varying by design, so both are
  // switched off here; otherwise they answer the question instead of the head.
  const rigid = { ...still, 'warp.clothWeight': 0, 'warp.tuftWeight': 0, 'warp.eyeGlow': 0 };
  const springOff = { ...rigid, 'warp.overshoot': 0 };
  await shoot({ settings: springOff, frames: 240 });
  const offEarly = await shoot({ settings: springOff, head: { yaw: 0.4 }, frames: 1 });
  const offLate = await shoot({ settings: springOff, head: { yaw: 0.4 }, frames: 90 });
  check('with overshoot off the head snaps straight to its target',
    offEarly.signature === offLate.signature);

  const springOn = { ...rigid, 'warp.overshoot': 1 };
  await shoot({ settings: springOn, frames: 240 });
  const onEarly = await shoot({ settings: springOn, head: { yaw: 0.4 }, frames: 1 });
  const onLate = await shoot({ settings: springOn, head: { yaw: 0.4 }, frames: 90 });
  check('with overshoot on the head settles over time',
    onEarly.signature !== onLate.signature);

  // Waist-down damping: more of the image should move when the lower body is
  // allowed to follow than when it is pinned.
  const shifted = { head: { x: 1 }, frames: 30, settings: still };
  const pinned = await shoot({ ...shifted, settings: { ...still, 'warp.lowerDamping': 0 } });
  const free = await shoot({ ...shifted, settings: { ...still, 'warp.lowerDamping': 1 } });
  check('waist-down damping changes how much of the body follows',
    pinned.signature !== free.signature,
    'pinned and free legs render differently');
  await shoot({ settings: {
    'warp.lowerDamping': 0.15, 'warp.wind': 1, 'warp.overshoot': 1,
    'warp.clothWeight': 1, 'warp.tuftWeight': 1, 'warp.eyeGlow': 0.35,
  } });

  // A white background should vanish when the key is switched on.
  await page.setInputFiles('input[accept="image/png,image/jpeg,image/webp"]', {
    name: 'opaque.png',
    mimeType: 'image/png',
    buffer: buildFixture({ opaqueBackground: true }),
  });
  await page.locator('#rig-editor [data-role="done"]').click();

  const keyed = await page.evaluate(() => window.__vtuber.store.get('warp.keyWhite'));
  const withBackground = await shoot({});
  await page.evaluate(() => window.__vtuber.store.set('warp.keyWhite', 0.9));
  const cutOut = await shoot({});
  check('the white key removes an opaque background',
    cutOut.opaque < withBackground.opaque * 0.8,
    `${withBackground.opaque} -> ${cutOut.opaque} opaque px, key was ${keyed}`);

  // --- the awkward-composition case ------------------------------------
  // The white-key check above left the key switched on, which would cut the
  // white eyes out of the next fixture.
  await page.evaluate(() => window.__vtuber.store.set('warp.keyWhite', 0));
  await page.setInputFiles('input[accept="image/png,image/jpeg,image/webp"]', {
    name: 'ninja.png',
    mimeType: 'image/png',
    buffer: buildNinjaFixture(),
  });
  await page.locator('#rig-editor [data-role="done"]').click();

  const ninja = await page.evaluate(() => {
    const s = window.__vtuber.store;
    return {
      headX: s.get('warp.headX'),
      headY: s.get('warp.headY'),
      headR: s.get('warp.headR'),
      eyeL: JSON.parse(s.get('warp.eyeL')),
      eyeR: JSON.parse(s.get('warp.eyeR')),
    };
  });

  check('cloth wider than the figure does not steal the head',
    ninja.headY > 0.38, `headY ${ninja.headY} (ribbons occupy the top 50%)`);
  check('the head is found off-centre',
    Math.abs(ninja.headX - 0.68) < 0.1, `headX ${ninja.headX} want ~0.68`);
  check('the eyes are found on the visor',
    overlaps(ninja.eyeL, NINJA.eyeL) && overlaps(ninja.eyeR, NINJA.eyeR),
    `${fmt(ninja.eyeL)} ${fmt(ninja.eyeR)}`);
  check('the head is sized from the eye spacing',
    ninja.headR > 0.06 && ninja.headR < 0.3, `headR ${ninja.headR}`);

  const ninjaNeutral = await shoot({});
  const ninjaBlink = await shoot({ eyes: { blinkL: 1, blinkR: 1 } });
  check('blink works on the awkward layout',
    ninjaBlink.white < ninjaNeutral.white * 0.4,
    `${ninjaNeutral.white} -> ${ninjaBlink.white} white px`);

  // --- eyes that merge into one blob ------------------------------------
  await page.setInputFiles('input[accept="image/png,image/jpeg,image/webp"]', {
    name: 'merged.png',
    mimeType: 'image/png',
    buffer: buildMergedEyeFixture(),
  });
  await page.locator('#rig-editor [data-role="done"]').click();

  const merged = await page.evaluate(() => {
    const s = window.__vtuber.store;
    return { l: JSON.parse(s.get('warp.eyeL')), r: JSON.parse(s.get('warp.eyeR')) };
  });
  const centre = (r) => (r[0] + r[2]) / 2;
  check('a single merged bright blob splits into two eyes',
    centre(merged.r) > centre(merged.l) + 0.02,
    `centres ${centre(merged.l).toFixed(3)} and ${centre(merged.r).toFixed(3)}`);

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall warp checks passed');
process.exit(failures ? 1 : 0);
