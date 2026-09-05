// Dev-only: moves the head three ways — a roll, a nod, a turn and back — and
// samples the scarf as it answers. The drawn pose is ghosted under every frame
// so what moved is legible: the ribbon should lag the head, swing once, and
// settle back onto its ghost, with the neck scarf never leaving the chin.
//
//   node scripts/visual/scarf.mjs out.png
import { chromium } from 'playwright';
import { chromeBin } from '../chrome.mjs';
import { createServer } from 'vite';

const out = process.argv[2] ?? 'scarf.png';
const server = await createServer({ server: { port: 5207 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: chromeBin(),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ permissions: ['camera'], viewport: { width: 2000, height: 820 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:5207/', { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__vtuber?.avatar?.ready), null, { timeout: 25000 });
await page.waitForFunction(() => window.__vtuber.avatars.parts2d.ready === true, null, { timeout: 25000 });

const lag = await page.evaluate(() => {
  const { avatars, store, emptyRig } = window.__vtuber;
  const a = avatars.parts2d;
  store.set('stage.zoom', 1);
  store.set('warp.wind', 0);

  const cw = 250, ch = 250, pad = 22;
  const shots = [0, 5, 11, 20, 32, 48, 70, 110];
  const rows = [
    ['roll 0.45', (f) => { const r = emptyRig(); r.head.roll = Math.min(1, f / 4) * 0.45; return r; }],
    ['nod down 0.6', (f) => { const r = emptyRig(); r.head.pitch = -Math.min(1, f / 4) * 0.6; return r; }],
    ['turn 0.6, then back', (f) => {
      const r = emptyRig();
      r.head.yaw = f < 30 ? Math.min(1, f / 4) * 0.6 : Math.max(0, 1 - (f - 30) / 4) * 0.6;
      return r;
    }],
  ];
  const sheet = document.createElement('canvas');
  sheet.width = cw * shots.length;
  sheet.height = (ch + pad) * rows.length;
  const c = sheet.getContext('2d');
  c.fillStyle = '#f4f1ec';
  c.fillRect(0, 0, sheet.width, sheet.height);
  a.resize(cw, ch, 1);
  // Flush the rebuild the warp.* setting scheduled.
  for (let f = 0; f < 2; f++) a.render(emptyRig(), 1 / 60);

  const grab = () => {
    const gl = a.gl;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const d = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(d.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').putImageData(img, 0, 0);
    return tmp;
  };

  const tip = a.scarf.nodes - 1;
  const peaks = [];
  rows.forEach(([label, rigAt], row) => {
    a.scarf.reset();
    a.inertia.reset();
    for (let f = 0; f < 60; f++) a.render(emptyRig(), 1 / 60);
    const ghost = grab();
    const restX = a.scarf.rx[tip], restY = a.scarf.ry[tip];
    let peak = 0;
    let f = 0;
    shots.forEach((shot, col) => {
      while (f <= shot) {
        a.render(rigAt(f), 1 / 60);
        peak = Math.max(peak, Math.hypot(a.scarf.px[tip] - restX, a.scarf.py[tip] - restY) * a.imageSize.width);
        f++;
      }
      c.save();
      c.globalAlpha = 0.35;
      c.filter = 'grayscale(1) brightness(1.4)';
      c.drawImage(ghost, col * cw, row * (ch + pad));
      c.restore();
      c.drawImage(grab(), col * cw, row * (ch + pad));
      c.fillStyle = '#555';
      c.font = '13px system-ui';
      c.fillText(`${label}  +${Math.round((shot / 60) * 1000)}ms`, col * cw + 8, row * (ch + pad) + ch + 16);
    });
    peaks.push(`${label}: tip ${peak.toFixed(0)}px from its ghost at most`);
  });

  sheet.id = 'sheet';
  sheet.style.cssText = 'position:fixed;inset:0;z-index:99;background:#fff';
  document.body.append(sheet);
  return peaks;
});

console.log(lag.join('\n'));
await page.locator('#sheet').screenshot({ path: out });
await browser.close();
await server.close();
console.log(`wrote ${out}`);
