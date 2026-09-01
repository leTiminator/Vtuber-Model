// Dev-only: whips the head across, then holds, sampling as the scarf settles.
// Frames must differ in SHAPE, not just position — that is the difference
// between cloth on bones and a layer being slid about.
//
//   node scripts/visual/scarf.mjs out.png
import { chromium } from 'playwright';
import { createServer } from 'vite';

const out = process.argv[2] ?? 'scarf.png';
const server = await createServer({ server: { port: 5207 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ permissions: ['camera'], viewport: { width: 1500, height: 500 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:5207/', { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__vtuber?.avatars?.parts2d?.image), null, { timeout: 25000 });
await page.evaluate(() => window.__vtuber.store.set('stage.avatar', 'parts2d'));
await page.waitForFunction(() => window.__vtuber.avatars.parts2d.ready === true, null, { timeout: 25000 });

const spread = await page.evaluate(() => {
  const { avatars, store, emptyRig } = window.__vtuber;
  const a = avatars.parts2d;
  store.set('stage.zoom', 1);
  store.set('warp.wind', 0);
  store.set('warp.clothWeight', 1.4);

  const cw = 250, ch = 270;
  const shots = [0, 5, 11, 20, 32, 48, 70, 110];
  const sheet = document.createElement('canvas');
  sheet.width = cw * shots.length;
  sheet.height = ch + 30;
  const c = sheet.getContext('2d');
  c.fillStyle = '#f4f1ec';
  c.fillRect(0, 0, sheet.width, sheet.height);

  a.resize(cw, ch, 2);
  const rig = emptyRig();

  // Settle facing one way, then snap across and hold.
  rig.head.yaw = -0.45;
  for (let f = 0; f < 180; f++) a.render(rig, 1 / 60);
  rig.head.yaw = 0.45;

  let frame = 0;
  // How far apart the bones drift from their rest line, as a shape measure.
  const rest = a.spine.nodes.map(([u, v]) => [u, v]);
  const bends = [];
  shots.forEach((target, i) => {
    while (frame <= target) { a.render(rig, 1 / 60); frame++; }
    c.drawImage(a.canvas, i * cw, 0, cw, ch);
    c.fillStyle = '#555';
    c.font = '13px system-ui';
    c.textAlign = 'center';
    c.fillText(`+${Math.round((target / 60) * 1000)}ms`, i * cw + cw / 2, ch + 18);
    let far = 0;
    for (let n = 0; n < 16; n++) {
      far = Math.max(far, Math.hypot(a.bones[n * 2] - rest[n][0], a.bones[n * 2 + 1] - rest[n][1]));
    }
    bends.push(+far.toFixed(4));
  });

  sheet.id = 'sheet';
  sheet.style.cssText = 'position:fixed;inset:0;z-index:99;background:#fff';
  document.body.append(sheet);
  return bends;
});

console.log('peak bone displacement per frame (image widths):', spread.join('  '));
await page.locator('#sheet').screenshot({ path: out });
await browser.close();
await server.close();
console.log(`wrote ${out}`);
