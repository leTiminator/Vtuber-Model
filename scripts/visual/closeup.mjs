// Dev-only: framed on the head, where blink, squint and the turn actually get
// judged. Idle drift is switched off so the rig is isolated from the wind.
//
//   node scripts/visual/closeup.mjs out.png [art.png]
import { chromium } from 'playwright';
import { createServer } from 'vite';

const out = process.argv[2] ?? 'closeup.png';
const art = process.argv[3] ?? '/art/BA_Ninja_TPBG.png';

const server = await createServer({ server: { port: 5197 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ permissions: ['camera'], viewport: { width: 1700, height: 700 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:5197/', { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__vtuber), null, { timeout: 15000 });

await page.evaluate(async (src) => {
  const { avatars, store, emptyRig } = window.__vtuber;
  const image = new Image();
  await new Promise((ok, no) => { image.onload = ok; image.onerror = no; image.src = src; });
  store.set('stage.avatar', 'warp2d');
  avatars.warp2d.setImage(image, true);
  store.set('warp.wind', 0);
  store.set('stage.zoom', 2.3);
  store.set('stage.offsetX', -150);
  store.set('stage.offsetY', -110);

  const poses = [
    ['rest', {}],
    ['turn left', { head: { yaw: -0.44 } }],
    ['turn right', { head: { yaw: 0.44 } }],
    ['look up', { head: { pitch: 0.38 } }],
    ['tilt', { head: { roll: 0.35 } }],
    ['half blink', { eyes: { blinkL: 0.55, blinkR: 0.55 } }],
    ['blink', { eyes: { blinkL: 1, blinkR: 1 } }],
    ['squint', { eyes: { squintL: 1, squintR: 1 } }],
  ];

  const cw = 300, ch = 380;
  const strip = document.createElement('canvas');
  strip.width = cw * poses.length;
  strip.height = ch + 30;
  const c = strip.getContext('2d');
  c.fillStyle = '#f4f1ec';
  c.fillRect(0, 0, strip.width, strip.height);

  const a = avatars.warp2d;
  a.resize(cw, ch, 2);
  poses.forEach(([name, mut], i) => {
    const rig = emptyRig();
    Object.assign(rig.head, mut.head ?? {});
    Object.assign(rig.eyes, mut.eyes ?? {});
    for (let f = 0; f < 140; f++) a.render(rig, 1 / 60);
    c.drawImage(a.canvas, i * cw, 0, cw, ch);
    c.fillStyle = '#555';
    c.font = '14px system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText(name, i * cw + cw / 2, ch + 18);
  });

  strip.id = 'strip';
  strip.style.cssText = 'position:fixed;inset:0;z-index:99;background:#fff';
  document.body.append(strip);
}, art);

await page.locator('#strip').screenshot({ path: out });
await browser.close();
await server.close();
console.log(`wrote ${out}`);
