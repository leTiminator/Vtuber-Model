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
import { createServer } from 'vite';

const CHROME = process.env.CHROME_BIN ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
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

/* ------------------------------------------------------------------ test */

const server = await createServer({ server: { port: 5191 }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  executablePath: CHROME,
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

/** Render one pose straight into the warp canvas and summarise the pixels. */
const shoot = (pose) => page.evaluate((p) => {
  const { avatars, emptyRig } = window.__vtuber;
  const rig = emptyRig();
  Object.assign(rig.head, p.head ?? {});
  Object.assign(rig.eyes, p.eyes ?? {});
  Object.assign(rig.body, p.body ?? {});

  const avatar = avatars.warp2d;
  avatar.render(rig, 0.016);

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
  await page.goto('http://127.0.0.1:5191/', { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__vtuber), null, { timeout: 15000 });

  await page.locator('summary', { hasText: 'Your own artwork' }).click();
  await page.setInputFiles('input[accept="image/png,image/jpeg,image/webp"]', {
    name: 'artwork.png',
    mimeType: 'image/png',
    buffer: buildFixture(),
  });

  await page.waitForFunction(() => window.__vtuber.avatars.warp2d.ready, null, { timeout: 10000 });
  check('loading an image switches to the warp model',
    await page.evaluate(() => window.__vtuber.store.get('stage.avatar')) === 'warp2d');

  check('the rig editor opens on load', await page.locator('#rig-editor').isVisible());
  check('it offers all four markers',
    await page.locator('#rig-editor .rig-handle').count() === 4,
    `${await page.locator('#rig-editor .rig-handle').count()} handles`);

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

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall warp checks passed');
process.exit(failures ? 1 : 0);
