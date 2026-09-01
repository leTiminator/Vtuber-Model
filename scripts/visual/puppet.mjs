// Dev-only: drives the layered puppet through a pose sheet, with the untouched
// source as a control. Holes at part boundaries are what to look for — that is
// what the dilated margins exist to prevent.
//
//   node scripts/visual/puppet.mjs out.png
import { chromium } from 'playwright';
import { createServer } from 'vite';

const out = process.argv[2] ?? 'puppet.png';
const server = await createServer({ server: { port: 5205 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ permissions: ['camera'], viewport: { width: 1500, height: 800 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:5205/', { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__vtuber?.avatars?.parts2d?.image), null, { timeout: 25000 });
await page.evaluate(() => window.__vtuber.store.set('stage.avatar', 'parts2d'));
await page.waitForFunction(() => window.__vtuber.avatars.parts2d.ready === true, null, { timeout: 25000 });

await page.evaluate(() => {
  const { avatars, store, emptyRig } = window.__vtuber;
  const a = avatars.parts2d;
  store.set('stage.zoom', 1);
  store.set('warp.wind', 0);

  const poses = [
    ['rest', {}],
    ['turn left', { head: { yaw: -0.42 } }],
    ['turn right', { head: { yaw: 0.42 } }],
    ['look up', { head: { pitch: 0.38 } }],
    ['tilt', { head: { roll: 0.34 } }],
    ['lean', { head: { x: 0.9 } }],
    ['blink', { eyes: { blinkL: 1, blinkR: 1 } }],
    ['squint', { eyes: { squintL: 1, squintR: 1 } }],
  ];

  const cw = 230, ch = 250;
  const sheet = document.createElement('canvas');
  sheet.width = cw * (poses.length + 1);
  sheet.height = ch + 30;
  const c = sheet.getContext('2d');
  c.fillStyle = '#f4f1ec';
  c.fillRect(0, 0, sheet.width, sheet.height);
  const label = (t, x) => { c.fillStyle = '#555'; c.font = '13px system-ui'; c.textAlign = 'center'; c.fillText(t, x, ch + 18); };

  const img = a.image;
  const fit = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
  c.drawImage(img, (cw - img.naturalWidth * fit) / 2, (ch - img.naturalHeight * fit) / 2,
    img.naturalWidth * fit, img.naturalHeight * fit);
  label('SOURCE (control)', cw / 2);

  a.resize(cw, ch, 2);
  poses.forEach(([name, mut], i) => {
    const rig = emptyRig();
    Object.assign(rig.head, mut.head ?? {});
    Object.assign(rig.eyes, mut.eyes ?? {});
    rig.body.breath = 0.5;
    for (let f = 0; f < 120; f++) a.render(rig, 1 / 60);
    c.drawImage(a.canvas, (i + 1) * cw, 0, cw, ch);
    label(name, (i + 1) * cw + cw / 2);
  });

  sheet.id = 'sheet';
  sheet.style.cssText = 'position:fixed;inset:0;z-index:99;background:#fff';
  document.body.append(sheet);
});

await page.locator('#sheet').screenshot({ path: out });
await browser.close();
await server.close();
console.log(`wrote ${out}`);
