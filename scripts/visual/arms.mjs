// Dev-only: sweeps the arm channels and lays the poses out side by side, so the
// shoulder pivots and the swing direction can be checked by eye.
//
//   node scripts/visual/arms.mjs out.png
import { chromium } from 'playwright';
import { chromeBin } from '../chrome.mjs';
import { createServer } from 'vite';
import { writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'arms.png';
const server = await createServer({ server: { port: 5202 }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  executablePath: chromeBin(),
  args: ['--enable-unsafe-swiftshader'],
});
const page = await (await browser.newContext({ viewport: { width: 460, height: 460 } })).newPage();
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:5202/', { waitUntil: 'load' });

const dataURL = await page.evaluate(async () => {
  const { store, avatars, emptyRig } = window.__vtuber;
  store.set('stage.avatar', 'parts2d');
  const avatar = avatars.parts2d;
  store.patch({ 'stage.zoom': 1.15, 'stage.offsetX': 0, 'stage.offsetY': 0 });
  await new Promise((r) => setTimeout(r, 400));

  const POSES = [
    ['rest', {}],
    ['left up', { right: { upper: 1.4, raise: 1.2 } }],
    ['right up', { left: { upper: -1.4, raise: 1.2 } }],
    ['both up', { left: { upper: -1.4, raise: 1.2 }, right: { upper: 1.4, raise: 1.2 } }],
    ['both down', { left: { upper: 0.7, raise: -0.5 }, right: { upper: -0.7, raise: -0.5 } }],
  ];

  const cell = 460;
  const sheet = document.createElement('canvas');
  sheet.width = cell * POSES.length;
  sheet.height = cell + 24;
  const c = sheet.getContext('2d');
  c.fillStyle = '#12141a';
  c.fillRect(0, 0, sheet.width, sheet.height);

  for (let i = 0; i < POSES.length; i++) {
    const [label, arms] = POSES[i];
    const rig = emptyRig();
    for (const side of ['left', 'right']) Object.assign(rig.arms[side], arms[side] ?? {});
    // Settle: springs and the chain need a few frames to reach the pose.
    for (let f = 0; f < 90; f++) avatar.render(rig, 1 / 60);
    c.drawImage(avatar.canvas, i * cell, 0, cell, cell);
    c.fillStyle = '#cfd6e4';
    c.font = '13px system-ui, sans-serif';
    c.fillText(label, i * cell + 10, cell + 16);
    c.strokeStyle = 'rgba(255,255,255,0.12)';
    c.strokeRect(i * cell + 0.5, 0.5, cell - 1, cell - 1);
  }
  return sheet.toDataURL('image/png');
});

writeFileSync(out, Buffer.from(dataURL.split(',')[1], 'base64'));
console.log(`wrote ${out}`);
await browser.close();
await server.close();
