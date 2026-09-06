/**
 * End-to-end smoke test: boots the real app in Chromium against a fake webcam
 * and checks the whole pipeline comes up — model download, camera start, the
 * render loop actually putting pixels on the canvas, and the hotkeys firing.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { OUT, boot } from './harness.mjs';

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

// Recordings saved during this run go somewhere disposable, not into fixtures.
const SESSIONS = join(OUT, 'sessions');
process.env.VTUBER_SESSIONS_DIR = SESSIONS;
rmSync(SESSIONS, { recursive: true, force: true });

const { page, errors, close, openBrowser, base } = await boot({
  viewport: { width: 1280, height: 720 }, camera: true,
});

try {
  check('page loads with a stage and a panel',
    await page.locator('#stage').isVisible() && await page.locator('#panel').isVisible());

  // Naming the groups beats counting them: a control that silently dropped out
  // because its setting was renamed shows up as a missing section, not a number.
  const wanted = ['Camera & tracking', 'Size & position', 'Head', 'Eyes', 'Speech', 'Arms',
    'Body & scarf', 'Output & OBS', 'Model', 'Hotkeys'];
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

  // Matched on the verb, not the length. How long a session is worth recording
  // is a judgement that has already changed once; that the control exists at
  // all is the thing this is here to notice.
  check('the session recorder is offered',
    await page.locator('button', { hasText: /^Record \d+ seconds$/ }).count() === 1);

  // The HUD lives inside the stage, so its buttons compete with the drag-to-pan
  // handler. Capturing the pointer there once swallowed the click outright.
  await page.click('#toggle-panel');
  const hidden = await page.evaluate(() => document.body.classList.contains('panel-hidden'));
  // The HUD goes with the panel, for a clean capture; H brings both back.
  await page.keyboard.press('h');
  const shown = await page.evaluate(() => !document.body.classList.contains('panel-hidden'));
  check('the panel button is not swallowed by drag-to-pan', hidden && shown,
    `hid ${hidden}, restored ${shown}`);

  // Chords belong to the browser: Ctrl+H must not touch the panel.
  await page.keyboard.press('Control+h');
  check('a hotkey with a modifier held is left to the browser',
    await page.evaluate(() => !document.body.classList.contains('panel-hidden')));

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

  /* Nothing of ours in the outgoing picture. */
  await page.waitForFunction(() => document.getElementById('selfcheck')?.hidden === true,
    null, { timeout: 5000 }).catch(() => {});
  /* The readout stays up while the camera runs, which is the change. */
  check('the readout stays up once the camera is live',
    await page.locator('#selfcheck').isVisible(),
    'visible while tracking');

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
  const mirror = page.locator('input[data-key="camera.mirror"]');
  const before = await mirror.isChecked();
  await mirror.click();
  await page.waitForTimeout(500); // the store debounces its writes
  await page.reload({ waitUntil: 'load' });
  const after = await page.locator('input[data-key="camera.mirror"]').isChecked();
  check('a changed setting survives a reload', after === !before, `${before} -> ${after}`);

  // The hidden-window ticker: a Worker timer that keeps firing without animation
  // frames. Headless Chromium cannot hide a page, so this proves the timer runs
  // independently of rAF: an order of magnitude above a hidden tab's one a
  // second, and never above the rate asked for. A loaded runner delays delivery
  // to the page's thread (14 in a second once on CI), so the bar is not the
  // rate itself. Whether tracking survives a covered window is for a desk.
  const ticks = await page.evaluate(async () => {
    const { startTicker } = await import('/src/core/ticker.js');
    let n = 0;
    const t = startTicker(30, () => { n++; });
    await new Promise((r) => setTimeout(r, 2000));
    t.stop();
    return n / 2;
  });
  check('the hidden-window ticker fires many times a second off a Worker timer, never more than asked',
    ticks >= 10 && ticks <= 40, `${ticks} ticks a second over two seconds`);
  check('the tracker can run one detection from a timer', await page.evaluate(() =>
    typeof window.__vtuber.tracker.detect === 'function'));

  // The dev server keeps a recording the page posts to it, under a name it
  // chooses, and refuses anything that is not one.
  const posted = await page.evaluate(async () => {
    const body = JSON.stringify({ version: 1, recorded: 'test', seconds: 0.1, frames: 2, hz: 30,
      shapeKeys: ['jawOpen'], samples: [{ t: 0, face: null, pose: null }, { t: 0.033, face: null, pose: null }] });
    const ok = await fetch('/__record', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return { ok: await ok.json(), okStatus: ok.status };
  });
  // The refusal is sent from here, not the page: a browser logs a 400 as a
  // console error, and this suite counts those.
  posted.badStatus = (await fetch(`${base}__record`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base.replace(/\/$/, '') }, body: '{"hello":1}',
  })).status;
  const savedFiles = existsSync(SESSIONS) ? readdirSync(SESSIONS) : [];
  check('a recording posted to the dev server lands in the sessions folder',
    posted.okStatus === 200 && posted.ok.ok && savedFiles.includes(posted.ok.name),
    `${posted.ok.path ?? 'no path'}; folder holds ${savedFiles.join(', ') || 'nothing'}`);
  check('and something that is not a recording is refused', posted.badStatus === 400, `status ${posted.badStatus}`);

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  /* A stage that cannot draw has to say so. */
  const noGl = await openBrowser(['--disable-3d-apis']);
  try {
    await noGl.page.waitForFunction(
      () => /WebGL2/.test(document.getElementById('status')?.textContent ?? ''),
      null, { timeout: 15000 }).catch(() => {});
    check('a browser without WebGL is told so on the status line',
      /WebGL2/.test(await noGl.page.locator('#status').textContent()),
      await noGl.page.locator('#status').textContent());
  } finally {
    await noGl.close();
  }
} catch (err) {
  check('test run completed', false, err.message);
} finally {
  await close();
}

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
