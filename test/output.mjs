/**
 * The OBS page and the wire to it: settings cross and are not persisted, the
 * solved rig crosses and is held when the tracker goes quiet, a late window
 * gets the last of both, and an error on the OBS page reaches the tracker.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, makeCheck, ROOT } from './harness.mjs';

const SESSION = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/tracker-session.json'), 'utf8'));
const { check, finish } = makeCheck('output');
const { page: tracker, openPage, errors, close } = await boot({
  camera: true, viewport: { width: 500, height: 500 },
});
const OUTPUT_READY = () => window.__vtuberOutput?.avatar?.ready === true;

try {
  const { page: output } = await openPage('output', { width: 480, height: 480 }, false);
  await output.waitForFunction(OUTPUT_READY, null, { timeout: 60000 });

  const linked = await tracker.waitForFunction(
    () => document.getElementById('status')?.textContent?.includes('OBS'),
    null, { timeout: 15000 }).catch(() => null);
  check('the tracker page says the output window is listening', Boolean(linked),
    (await tracker.locator('#status').textContent()) ?? 'no status');
  check('the output page never loaded a camera or a tracking model, and solves no rig of its own',
    await output.evaluate(() => !('__vtuber' in window) && !('rig' in window.__vtuberOutput)
      && !performance.getEntriesByType('resource').some((r) => /\.task(\?|$)/.test(r.name))),
    'no .task fetched, no rig on the page');

  // --- settings -------------------------------------------------------------
  await tracker.evaluate(() => window.__vtuber.store.set('stage.zoom', 2.25));
  const crossed = await output.waitForFunction(
    () => Math.abs(window.__vtuberOutput.store.get('stage.zoom') - 2.25) < 1e-6,
    null, { timeout: 8000 }).catch(() => null);
  check('a setting changed on the tracker reaches the output', Boolean(crossed),
    `output zoom ${await output.evaluate(() => window.__vtuberOutput.store.get('stage.zoom'))}`);
  check('but the output does not write it down',
    await output.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        if ((localStorage.key(i) ?? '').startsWith('vtuber-model/settings')) return false;
      }
      return true;
    }), 'nothing under vtuber-model/settings');

  // --- the solved rig -------------------------------------------------------
  await tracker.evaluate(() => window.__vtuber.store.set('stage.zoom', 1));
  const sample = SESSION.samples.find((s) => s.face && Math.abs(s.face.head.yaw) > 0.25)
    ?? SESSION.samples.find((s) => s.face);
  check('the recording has a turned head to send', Boolean(sample), sample ? `yaw ${sample.face.head.yaw}` : 'none');
  await tracker.evaluate((face) => {
    const { tracker: t, store } = window.__vtuber;
    store.set('camera.neutral', JSON.stringify({ yaw: 0.12, pitch: 0.05, roll: 0, x: 0, y: 0, z: -45 }));
    t.frame = face;
    t.hasFace = true;
  }, { shapes: {}, head: sample.face.head, position: sample.face.position });
  await output.bringToFront();

  // Both pages settle on the same frame; the output is one message behind at most.
  let pair = { tracker: 0, output: 0 };
  for (let i = 0; i < 40; i++) {
    await tracker.waitForTimeout(150);
    pair = {
      tracker: await tracker.evaluate(() => window.__vtuber.rig.state.head.yaw),
      output: await output.evaluate(() => window.__vtuberOutput.seen().latest?.head?.yaw ?? 0),
    };
    if (Math.abs(pair.tracker) > 0.1 && Math.abs(pair.tracker - pair.output) < 1e-3) break;
  }
  check('the head the output draws is the head the tracker solved, to a thousandth',
    Math.abs(pair.tracker) > 0.1 && Math.abs(pair.tracker - pair.output) < 1e-3,
    `tracker ${pair.tracker.toFixed(4)}, output ${pair.output.toFixed(4)}`);
  const bytes = await tracker.evaluate(() => JSON.stringify({ t: 'state', seq: 1, at: 0, state: window.__vtuber.rig.state }).length);
  check('a state message is small', bytes < 2048, `${bytes} bytes`);
  check('the output page is drawing something',
    await output.evaluate(() => {
      const gl = window.__vtuberOutput.avatar.gl;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const d = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 24) n++;
      return n > 2000;
    }), 'opaque pixels on the output canvas');

  // --- the OBS page reporting back ------------------------------------------
  await output.evaluate(() => window.__vtuberOutput.link.send({ t: 'status', text: 'test: the stage cannot draw' }));
  const told = await tracker.waitForFunction(
    () => document.getElementById('status')?.textContent?.includes('the stage cannot draw'),
    null, { timeout: 5000 }).catch(() => null);
  check('an error on the OBS page reaches the tracker status line', Boolean(told),
    (await tracker.locator('#status').textContent()) ?? 'no status');
  await output.evaluate(() => window.__vtuberOutput.link.send({ t: 'status', text: '' }));

  // --- silence ----------------------------------------------------------------
  // Close the tracker's link, let anything already in flight land, then watch.
  await tracker.evaluate(() => window.__vtuber.link.close());
  await output.waitForTimeout(400);
  const held = await output.evaluate(() => window.__vtuberOutput.seen());
  await output.waitForTimeout(1500);
  const later = await output.evaluate(() => window.__vtuberOutput.seen());
  check('the output holds the last state when the tracker goes quiet',
    later.received === held.received && later.latest?.head?.yaw === held.latest?.head?.yaw,
    `${held.received} messages then ${later.received}; yaw ${held.latest?.head?.yaw?.toFixed(3)} then ${later.latest?.head?.yaw?.toFixed(3)}`);

  const { page: late } = await openPage('output', { width: 480, height: 480 }, false);
  await late.waitForFunction(OUTPUT_READY, null, { timeout: 60000 });
  const replayed = await late.waitForFunction(() => window.__vtuberOutput.seen().latest !== null, null, { timeout: 5000 })
    .then(() => late.evaluate(() => window.__vtuberOutput.seen().latest.head.yaw)).catch(() => null);
  check('a window opened after the tracker went quiet still gets the last state and settings',
    replayed !== null && Math.abs(replayed - held.latest.head.yaw) < 1e-9
      && await late.evaluate(() => Math.abs(window.__vtuberOutput.store.get('stage.zoom') - 1) < 1e-6),
    `late yaw ${replayed?.toFixed?.(3) ?? 'none'} against ${held.latest?.head?.yaw?.toFixed(3)}`);

  check('the output canvas is declared premultiplied, which is what its blend writes',
    await output.evaluate(() => window.__vtuberOutput.avatar.gl.getContextAttributes().premultipliedAlpha === true));
  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('test run completed', false, err.stack);
} finally {
  await close();
}
finish();
