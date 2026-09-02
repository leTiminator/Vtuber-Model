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

// The stage canvas may be 2D or WebGL depending on the backend; read either.
const READ_CANVAS = `window.readCanvas = (c) => {
  const two = c.getContext('2d');
  if (two) return two.getImageData(0, 0, c.width, c.height);
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
  gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return { data };
};`;
await page.addInitScript(READ_CANVAS);

try {
  await page.goto('http://127.0.0.1:5188/', { waitUntil: 'load' });

  check('page loads with a stage and a panel',
    await page.locator('#stage').isVisible() && await page.locator('#panel').isVisible());

  // Naming the groups beats counting them: a control that silently dropped out
  // because its setting was renamed shows up as a missing section, not a number.
  const wanted = ['Camera & tracking', 'Head', 'Eyes', 'Speech', 'Arms',
    'Body & scarf', 'Output & OBS', 'Your own artwork', 'Hotkeys'];
  const groups = await page.locator('#panel-body .group > summary').allTextContents();
  check('control panel builds every group',
    wanted.every((title) => groups.includes(title)) && groups.length === wanted.length,
    groups.join(', '));

  check('avatar canvas is mounted', await page.locator('#avatar-host canvas').count() === 1);

  // The way a real tracker session gets into the test suite. Silently losing
  // this control would leave replay.mjs permanently skipping with nothing to
  // say why.
  // Which build is on screen, readable from a photograph.
  const stamp = await page.locator('#build-stamp').textContent();
  check('the page says which build it is', /^build \S+/.test(stamp ?? ''), stamp ?? 'missing');

  check('the session recorder is offered',
    await page.locator('button', { hasText: 'Record 20 seconds' }).count() === 1);

  // The HUD lives inside the stage, so its buttons compete with the drag-to-pan
  // handler. Capturing the pointer there once swallowed the click outright.
  await page.click('#toggle-panel');
  const hidden = await page.evaluate(() => document.body.classList.contains('panel-hidden'));
  // On a desktop the HUD goes with the panel, for a clean capture; H brings
  // both back. (A phone keeps the button instead — checked in test/mobile.mjs.)
  await page.keyboard.press('h');
  const shown = await page.evaluate(() => !document.body.classList.contains('panel-hidden'));
  check('the panel button is not swallowed by drag-to-pan', hidden && shown,
    `hid ${hidden}, restored ${shown}`);

  // The idle avatar should already be drawing (breathing, scarf, auto-blink).
  const idlePixels = await page.evaluate(() => {
    const c = document.querySelector('#avatar-host canvas');
    const { data } = readCanvas(c);
    let painted = 0;
    for (let i = 3; i < data.length; i += 4 * 97) if (data[i] > 8) painted++;
    return painted;
  });
  check('idle avatar renders pixels', idlePixels > 200, `${idlePixels} sampled opaque pixels`);

  // Scarf physics must actually move between frames.
  const moved = await page.evaluate(async () => {
    const c = document.querySelector('#avatar-host canvas');
    const grab = () => readCanvas(c).data;
    const before = grab().slice();
    await new Promise((r) => setTimeout(r, 700));
    const after = grab();
    let diff = 0;
    for (let i = 0; i < after.length; i += 4 * 53) if (Math.abs(after[i] - before[i]) > 6) diff++;
    return diff;
  });
  check('avatar animates while idle', moved > 20, `${moved} changed samples`);

  // The setup readout has to be on screen before the camera, because that is
  // the only moment anyone can read it.
  const readoutBefore = await page.locator('#selfcheck').isVisible();
  check('the setup readout is on screen with the camera off', readoutBefore);

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

  /* Nothing of ours in the outgoing picture.
   *
   * Whatever is on this canvas is what OBS captures, so a debugging overlay
   * left on screen once the camera is live is burned into the stream. It is
   * only useful before going live anyway.
   */
  await page.waitForFunction(() => document.getElementById('selfcheck')?.hidden === true,
    null, { timeout: 5000 }).catch(() => {});
  check('and gone once the camera is live',
    (await page.locator('#selfcheck').isVisible()) === false);

  // A pose the rigged artwork honours: closing the eyes must move pixels.
  const blinkDelta = await page.evaluate(async () => {
    const { emptyRig } = window.__vtuber;
    // Whatever the app actually mounted, rather than a backend that may not
    // even have a GL context because it was never shown.
    const avatar = window.__vtuber.current;
    const shot = (blink) => {
      const rig = emptyRig();
      rig.eyes.blinkL = blink;
      rig.eyes.blinkR = blink;
      avatar.render(rig, 1 / 60);
      const gl = avatar.gl;
      const buf = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf;
    };
    const open = shot(0).slice();
    const shut = shot(1);
    let diff = 0;
    for (let i = 0; i < shut.length; i += 4 * 31) if (Math.abs(shut[i] - open[i]) > 10) diff++;
    return diff;
  });
  check('closing the eyes changes the render', blinkDelta > 5, `${blinkDelta} changed samples`);

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
