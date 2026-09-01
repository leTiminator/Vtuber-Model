// Dev-only: drives real artwork through the rig and lays the result out as a
// contact sheet, plus a strip showing the scarf settling after a fast turn.
//
//   node scripts/visual/warp-demo.mjs out.png [path/to/art.png]
import { chromium } from 'playwright';
import { createServer } from 'vite';

const out = process.argv[2] ?? 'warp-demo.png';
const art = process.argv[3] ?? '/art/BA_Ninja_TPBG.png';

const server = await createServer({ server: { port: 5193 }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ permissions: ['camera'], viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:5193/', { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__vtuber), null, { timeout: 15000 });

const detected = await page.evaluate(async (src) => {
  const { avatars, store } = window.__vtuber;
  const { detectMarkers, readPixels } = await import('/src/avatars/warp2d/segment.js');

  const image = new Image();
  await new Promise((ok, no) => { image.onload = ok; image.onerror = no; image.src = src; });

  store.set('stage.avatar', 'warp2d');
  const found = detectMarkers(readPixels(image));
  avatars.warp2d.setImage(image, true);
  window.__art = image;
  return found;
}, art);

console.log('auto-detected markers:');
for (const [k, v] of Object.entries(detected ?? {})) console.log(`  ${k} = ${JSON.stringify(v)}`);

await page.evaluate(() => {
  const { avatars, store, emptyRig } = window.__vtuber;
  const image = window.__art;

  const poses = [
    ['rest', {}],
    ['turn left', { head: { yaw: -0.42 } }],
    ['turn right', { head: { yaw: 0.42 } }],
    ['look up', { head: { pitch: 0.38 } }],
    ['look down', { head: { pitch: -0.38 } }],
    ['tilt', { head: { roll: 0.35, yaw: 0.18 } }],
    ['blink', { eyes: { blinkL: 1, blinkR: 1 } }],
    ['squint', { eyes: { squintL: 1, squintR: 1 } }],
  ];

  const cellW = 230;
  const cellH = 260;
  const cols = poses.length + 1; // +1 for the control
  const strip = document.createElement('canvas');
  strip.width = cellW * cols;
  strip.height = cellH * 2 + 40;
  const ctx = strip.getContext('2d');
  ctx.fillStyle = '#f4f1ec';
  ctx.fillRect(0, 0, strip.width, strip.height);

  const avatar = avatars.warp2d;
  avatar.resize(cellW, cellH, 2);

  const label = (text, x, y) => {
    ctx.fillStyle = '#555';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, x, y);
  };

  // Control: the untouched source, drawn to the same box. Anything the rig is
  // doing to the art shows up as a difference from this cell.
  {
    const fit = Math.min(cellW / image.naturalWidth, cellH / image.naturalHeight);
    const dw = image.naturalWidth * fit;
    const dh = image.naturalHeight * fit;
    ctx.drawImage(image, (cellW - dw) / 2, (cellH - dh) / 2, dw, dh);
    label('SOURCE (control)', cellW / 2, cellH + 16);
  }

  // Row 1: static poses. Settle each one so the cloth is at rest.
  poses.forEach(([name, mut], idx) => {
    const i = idx + 1;
    const rig = emptyRig();
    Object.assign(rig.head, mut.head ?? {});
    Object.assign(rig.eyes, mut.eyes ?? {});
    rig.body.breath = 0.5;
    for (let f = 0; f < 90; f++) avatar.render(rig, 1 / 60);
    ctx.drawImage(avatar.canvas, i * cellW, 0, cellW, cellH);
    label(name, i * cellW + cellW / 2, cellH + 16);
  });

  // Row 2: whip the head left-to-right, then hold. Frames sampled after the
  // motion stops, so the scarf should be trailing and settling.
  const rig = emptyRig();
  rig.body.breath = 0.5;
  for (let f = 0; f < 60; f++) { rig.head.yaw = -0.45; avatar.render(rig, 1 / 60); }
  let frame = 0;
  const shots = [0, 4, 9, 16, 26, 40, 60, 90];
  const y0 = cellH + 30;
  shots.forEach((target, i) => {
    while (frame <= target) {
      rig.head.yaw = 0.45; // snapped across, then held
      avatar.render(rig, 1 / 60);
      frame++;
    }
    ctx.drawImage(avatar.canvas, i * cellW, y0, cellW, cellH);
    label(`+${Math.round((target / 60) * 1000)}ms`, i * cellW + cellW / 2, y0 + cellH + 16);
  });

  strip.id = 'strip';
  strip.style.cssText = 'position:fixed;inset:0;z-index:99;background:#fff';
  document.body.append(strip);
});

await page.locator('#strip').screenshot({ path: out });
await browser.close();
await server.close();
console.log(`wrote ${out}`);
