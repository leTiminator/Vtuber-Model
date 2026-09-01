// Dev-only: screenshots the character preview page so the drawing code can be
// reviewed as an image. Usage: node scripts/visual/shoot.mjs [out.png] [query]
import { chromium } from 'playwright';
import { createServer } from 'vite';

const out = process.argv[2] ?? 'preview.png';
const query = process.argv[3] ?? '';

const server = await createServer({ server: { port: 5199 }, logLevel: 'warn' });
await server.listen();

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1240, height: 1300 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://127.0.0.1:5199/scripts/visual/preview.html${query}`, { waitUntil: 'networkidle' });
await page.waitForSelector('body[data-ready="1"]', { timeout: 15000 });
await page.screenshot({ path: out, fullPage: true });

await browser.close();
await server.close();
if (errors.length) {
  console.error('page errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`wrote ${out}`);
