/**
 * Phone layout, on a phone-shaped viewport over HTTPS.
 *
 * `npm run phone` serves the app to a handset on the same Wi-Fi, and the two
 * things that make it usable there are not visible on a desktop run: the panel
 * has to stop being a 330px side drawer that covers the whole screen, and the
 * way back to it has to survive being closed — a phone has no H key.
 *
 *   node test/mobile.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_BIN ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

// The same switch `npm run phone` flips: LAN host plus a self-signed
// certificate, because browsers refuse the camera on a plain-HTTP IP.
process.env.VTUBER_PHONE = '1';
const server = await createServer({ server: { port: 5190 }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--enable-unsafe-swiftshader',
    '--no-proxy-server',
  ],
});
const context = await browser.newContext({
  ignoreHTTPSErrors: true, // the self-signed certificate, same as the phone sees
  permissions: ['camera'],
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto('https://localhost:5190/', { waitUntil: 'load' });

  // Without a secure context the camera is simply unavailable, whatever else
  // works — this is the whole reason phone mode serves HTTPS.
  check('the page is a secure context, so the camera is allowed',
    await page.evaluate(() => window.isSecureContext && !!navigator.mediaDevices?.getUserMedia));

  const view = page.viewportSize();
  const panel = await page.locator('#panel').boundingBox();
  check('the panel is a bottom sheet, not a full-screen drawer',
    panel.width > view.width * 0.9 && panel.y > view.height * 0.25,
    `${Math.round(panel.width)}x${Math.round(panel.height)} at y=${Math.round(panel.y)}`);
  check('the model has room above the panel', panel.y > 180, `panel top ${Math.round(panel.y)}px`);

  await page.tap('#toggle-panel');
  await page.waitForTimeout(400);
  check('tapping the menu closes the panel',
    await page.evaluate(() => document.body.classList.contains('panel-hidden')));

  // The trap this guards: on a desktop the HUD is hidden along with the panel
  // and H brings it back. A phone has no H, so a hidden button is a dead end.
  const reachable = await page.evaluate(() => {
    const style = getComputedStyle(document.getElementById('hud'));
    return style.pointerEvents !== 'none' && Number(style.opacity) > 0.5;
  });
  check('the menu button survives closing the panel', reachable);

  await page.tap('#toggle-panel');
  await page.waitForTimeout(400);
  check('tapping it again brings the panel back',
    await page.evaluate(() => !document.body.classList.contains('panel-hidden')));

  // And the model actually draws at this size.
  const painted = await page.evaluate(() => {
    const c = document.querySelector('#avatar-host canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    const d = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, d);
    let n = 0;
    for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 8) n++;
    return n;
  });
  check('the model renders on a phone-sized canvas', painted > 200, `${painted} opaque samples`);

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('test run completed', false, err.message);
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${failures ? `${failures} failing` : 'all phone checks passed'}`);
process.exit(failures ? 1 : 0);
