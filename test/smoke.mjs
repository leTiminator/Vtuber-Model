/**
 * End-to-end smoke test: boots the real app in Chromium against a fake webcam
 * and checks the whole pipeline comes up — model download, camera start, the
 * render loop actually putting pixels on the canvas, and the hotkeys firing.
 *
 * The fake device shows a rolling test pattern rather than a face, so this
 * proves the pipeline runs; it cannot prove the tracking is accurate.
 *
 *   node test/smoke.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_BIN ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

const server = await createServer({ server: { port: 5188 }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--enable-unsafe-swiftshader',
  ],
});
const context = await browser.newContext({
  permissions: ['camera', 'microphone'],
  viewport: { width: 1280, height: 720 },
});
const page = await context.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// MediaPipe logs its own INFO/GL notices on stderr, which the CDP console
// reports as errors. Only genuinely unexpected output should fail the run.
const NOISE = /favicon|404|^INFO:|XNNPACK delegate|GL Driver Message|OpenGL error checking/i;
page.on('console', (m) => {
  if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text());
});

try {
  await page.goto('http://127.0.0.1:5188/', { waitUntil: 'load' });

  check('page loads with a stage and a panel',
    await page.locator('#stage').isVisible() && await page.locator('#panel').isVisible());

  const groups = await page.locator('#panel-body .group').count();
  check('control panel builds every group', groups === 9, `${groups} groups`);

  check('avatar canvas is mounted', await page.locator('#avatar-host canvas').count() === 1);

  // The idle avatar should already be drawing (breathing, scarf, auto-blink).
  const idlePixels = await page.evaluate(() => {
    const c = document.querySelector('#avatar-host canvas');
    const ctx = c.getContext('2d');
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let painted = 0;
    for (let i = 3; i < data.length; i += 4 * 97) if (data[i] > 8) painted++;
    return painted;
  });
  check('idle avatar renders pixels', idlePixels > 200, `${idlePixels} sampled opaque pixels`);

  // Scarf physics must actually move between frames.
  const moved = await page.evaluate(async () => {
    const c = document.querySelector('#avatar-host canvas');
    const grab = () => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const before = grab().slice();
    await new Promise((r) => setTimeout(r, 700));
    const after = grab();
    let diff = 0;
    for (let i = 0; i < after.length; i += 4 * 53) if (Math.abs(after[i] - before[i]) > 6) diff++;
    return diff;
  });
  check('avatar animates while idle', moved > 20, `${moved} changed samples`);

  await page.click('#start');

  await page.waitForFunction(
    () => document.getElementById('status')?.dataset.kind === 'live' ||
          document.getElementById('status')?.dataset.kind === 'lost',
    null, { timeout: 60000 },
  );
  const statusKind = await page.locator('#status').getAttribute('data-kind');
  check('camera starts and the tracker runs', statusKind === 'live' || statusKind === 'lost',
    `status="${await page.locator('#status').textContent()}"`);

  // Headless software GL is very slow, so the number itself proves nothing —
  // only that the counter is wired up. Frames really flowing is already proven
  // by the tracker reaching a live/lost status above.
  const fps = await page.locator('#fps').textContent();
  check('frame-rate counter is wired up', /^\d+ fps$/.test(fps ?? ''), fps ?? 'none');

  // Hotkeys: holding "2" should visibly change the render (anger).
  const angerDelta = await page.evaluate(async () => {
    const c = document.querySelector('#avatar-host canvas');
    const grab = () => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const before = grab().slice();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2' }));
    await new Promise((r) => setTimeout(r, 500));
    const after = grab();
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Digit2' }));
    let diff = 0;
    for (let i = 0; i < after.length; i += 4 * 31) if (Math.abs(after[i] - before[i]) > 10) diff++;
    return diff;
  });
  check('expression hotkey changes the render', angerDelta > 5, `${angerDelta} changed samples`);

  // Settings must survive a reload: flip a real control, come back, check it
  // stuck. Reading localStorage alone would not prove the store reloads it.
  const mirror = page.locator('.check input').first();
  const before = await mirror.isChecked();
  await mirror.click();
  await page.waitForTimeout(500); // the store debounces its writes
  await page.reload({ waitUntil: 'load' });
  const after = await page.locator('.check input').first().isChecked();
  check('a changed setting survives a reload', after === !before, `${before} -> ${after}`);

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('test run completed', false, err.message);
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
