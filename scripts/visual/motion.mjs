// Dev-only: drives the model the way a person actually moves — fast head turns
// with real velocity — and lays the frames out in order.
//
// Settled single poses hide everything that goes wrong in transit: cloth that
// tears away from the body, a part that slides off its joint, a flip that
// exposes a margin. Those are the failures people actually see.
//
//   node scripts/visual/motion.mjs out.png
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'motion.png';
const server = await createServer({ server: { port: 5223 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-swiftshader', '--no-proxy-server'],
});
const page = await (await browser.newContext({ viewport: { width: 400, height: 400 } })).newPage();
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.goto('http://localhost:5223/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__vtuber?.avatars?.parts2d?.ready === true, null, { timeout: 40000 });

const dataURL = await page.evaluate(async () => {
  const { avatars, emptyRig, store } = window.__vtuber;
  const a = avatars.parts2d;
  store.patch({ 'stage.zoom': 1.3, 'stage.offsetX': 0, 'stage.offsetY': 0, 'stage.offsetX': 0, 'stage.offsetY': 0 });

  const cell = 400;
  const cellH = 400;
  const SHOTS = 8;
  const sheet = document.createElement('canvas');
  sheet.width = cell * SHOTS;
  sheet.height = cellH + 26;
  const c = sheet.getContext('2d');
  c.fillStyle = '#12141a';
  c.fillRect(0, 0, sheet.width, sheet.height);

  // A brisk look left, then right, then back — about what a person does when
  // they glance at a second monitor.
  const dt = 1 / 60;
  let t = 0;
  let shot = 0;
  const every = 11; // frames between captures
  for (let f = 0; f < SHOTS * every; f++) {
    t += dt;
    // A brisk look right, then left, then back — about what a person does
    // when they glance at a second monitor. Both directions matter: the head
    // flip only ever engages on one of them.
    const yaw = 0.68 * Math.sin(t * 2.6);
    const pitch = 0.20 * Math.sin(t * 2.1 + 1.0);
    const roll = 0.26 * Math.sin(t * 2.7 + 0.4);
    const rig = emptyRig();
    rig.head.yaw = yaw;
    rig.head.pitch = pitch;
    rig.head.roll = roll;
    rig.head.x = 0.30 * Math.sin(t * 2.6);
    a.render(rig, dt);
    if (f % every === 0 && shot < SHOTS) {
      c.drawImage(a.canvas, shot * cell, 0, cell, cellH);
      c.fillStyle = '#cfd6e4';
      c.font = '13px system-ui, sans-serif';
      c.fillText(`yaw ${(yaw * 57).toFixed(0)}°`, shot * cell + 10, cellH + 17);
      c.strokeStyle = 'rgba(255,255,255,0.14)';
      c.strokeRect(shot * cell + 0.5, 0.5, cell - 1, cellH - 1);
      shot++;
    }
  }
  return sheet.toDataURL('image/png');
});
writeFileSync(out, Buffer.from(dataURL.split(',')[1], 'base64'));
console.log(`wrote ${out}`);
await browser.close();
await server.close();
