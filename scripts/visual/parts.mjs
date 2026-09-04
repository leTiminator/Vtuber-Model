// Dev-only: cuts the artwork into parts and lays them out separated, so every
// cut edge and every dilated margin can be inspected.
//
//   node scripts/visual/parts.mjs out.png
import { chromium } from 'playwright';
import { chromeBin } from '../chrome.mjs';
import { createServer } from 'vite';

const out = process.argv[2] ?? 'parts.png';
const server = await createServer({ server: { port: 5201 }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  executablePath: chromeBin(),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ permissions: ['camera'], viewport: { width: 1500, height: 1100 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:5201/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__vtuber?.avatars?.parts2d?.ready === true, null, { timeout: 20000 });

const report = await page.evaluate(async () => {
  const { avatars } = window.__vtuber;
  const { cutParts } = await import('/src/avatars/parts/cut.js');
  const image = avatars.parts2d.image;

  const m = avatars.parts2d.markers();
  const { parts, width, height } = cutParts(image, m);

  const cols = 5;
  const cell = 280;
  const rows = Math.ceil(parts.length / cols);
  const sheet = document.createElement('canvas');
  sheet.width = cols * cell;
  sheet.height = rows * cell + 30;
  const c = sheet.getContext('2d');
  // Checkerboard, so transparency and dilated margins are both visible.
  for (let y = 0; y < sheet.height; y += 16) {
    for (let x = 0; x < sheet.width; x += 16) {
      c.fillStyle = ((x / 16 + y / 16) % 2) ? '#20242c' : '#171a20';
      c.fillRect(x, y, 16, 16);
    }
  }

  const scale = (cell - 30) / Math.max(width, height);
  parts.forEach((p, i) => {
    const cx = (i % cols) * cell;
    const cy = Math.floor(i / cols) * cell;
    // Draw each part where it sits in the original frame, scaled to the cell.
    c.drawImage(p.canvas, cx + 15 + p.x * scale, cy + 15 + p.y * scale, p.w * scale, p.h * scale);
    c.fillStyle = '#cfd6e4';
    c.font = '13px system-ui, sans-serif';
    c.textAlign = 'left';
    c.fillText(`${p.name}  ${p.pixels}px`, cx + 10, cy + cell - 6);
    c.strokeStyle = 'rgba(255,255,255,0.12)';
    c.strokeRect(cx + 0.5, cy + 0.5, cell - 1, cell - 1);
  });

  sheet.id = 'sheet';
  sheet.style.cssText = 'position:fixed;inset:0;z-index:99';
  document.body.append(sheet);

  return parts.map((p) => ({ name: p.name, px: p.pixels, box: `${p.w}x${p.h}` }));
});

console.table(report);
await page.locator('#sheet').screenshot({ path: out });
await browser.close();
await server.close();
console.log(`wrote ${out}`);
