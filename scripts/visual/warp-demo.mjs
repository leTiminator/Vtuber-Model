// Dev-only: proves the warp on real flat artwork. Renders the built-in
// character to a PNG, feeds that single image to the warp backend as if it
// were the user's own art, and lays the tracked poses out in a strip.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const out = process.argv[2] ?? 'warp-demo.png';
const server = await createServer({ server: { port: 5193 }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ permissions: ['camera'], viewport: { width: 1240, height: 420 } });
const page = await context.newPage();
await page.goto('http://127.0.0.1:5193/', { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__vtuber), null, { timeout: 15000 });

await page.evaluate(async () => {
  const [{ Character }, { readPalette }] = await Promise.all([
    import('/src/avatars/procedural2d/character.js'),
    import('/src/avatars/procedural2d/palette.js'),
  ]);
  const { avatars, store, emptyRig } = window.__vtuber;

  // 1. Flatten the built-in character into a single still image.
  const src = document.createElement('canvas');
  src.width = 560;
  src.height = 620;
  const sctx = src.getContext('2d');
  sctx.setTransform(0.56, 0, 0, 0.56, 0, -6);
  const character = new Character();
  const pal = readPalette();
  // Settle the scarf physics before flattening, so the still is not mid-swing.
  const still = emptyRig();
  for (let i = 0; i < 150; i++) character.draw(sctx, still, pal, 1 / 60, i / 60);
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, src.width, src.height);
  sctx.setTransform(0.56, 0, 0, 0.56, 0, -6);
  character.draw(sctx, still, pal, 1 / 60, 2.5);

  const flat = new Image();
  await new Promise((r) => { flat.onload = r; flat.src = src.toDataURL(); });

  // 2. Hand that still to the warp backend and mark up its rig.
  store.set('stage.avatar', 'warp2d');
  avatars.warp2d.setImage(flat);
  store.set('warp.headX', 0.5);
  store.set('warp.headY', 0.33);
  store.set('warp.headR', 0.23);
  store.set('warp.pivotX', 0.5);
  store.set('warp.pivotY', 0.56);
  store.set('warp.eyeL', JSON.stringify([0.355, 0.285, 0.47, 0.345]));
  store.set('warp.eyeR', JSON.stringify([0.53, 0.285, 0.645, 0.345]));
  store.set('warp.mesh', 40);

  // 3. Render each pose and lay them out in a strip.
  const poses = [
    ['rest', {}],
    ['turn left', { head: { yaw: -0.5 } }],
    ['turn right', { head: { yaw: 0.5 } }],
    ['look up', { head: { pitch: 0.42 } }],
    ['tilt', { head: { roll: 0.34, yaw: 0.2 } }],
    ['blink', { eyes: { blinkL: 1, blinkR: 1 } }],
  ];

  const cell = 200;
  const strip = document.createElement('canvas');
  strip.width = cell * poses.length;
  strip.height = 400;
  const out = strip.getContext('2d');
  out.fillStyle = '#f4f1ec';
  out.fillRect(0, 0, strip.width, strip.height);

  const avatar = avatars.warp2d;
  avatar.resize(cell, 360, 2);

  for (let i = 0; i < poses.length; i++) {
    const [label, mut] = poses[i];
    const rig = emptyRig();
    Object.assign(rig.head, mut.head ?? {});
    Object.assign(rig.eyes, mut.eyes ?? {});
    rig.body.breath = 0.5;
    avatar.render(rig, 0.016);
    out.drawImage(avatar.canvas, i * cell, 0, cell, 360);
    out.fillStyle = '#555';
    out.font = '13px system-ui, sans-serif';
    out.textAlign = 'center';
    out.fillText(label, i * cell + cell / 2, 384);
    out.strokeStyle = '#ddd';
    out.strokeRect(i * cell + 0.5, 0.5, cell - 1, 399);
  }

  strip.id = 'strip';
  strip.style.cssText = 'position:fixed;inset:0;z-index:99;background:#fff';
  document.body.append(strip);
});

await page.locator('#strip').screenshot({ path: out });
await browser.close();
await server.close();
console.log(`wrote ${out}`);
