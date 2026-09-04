/**
 * The two windows, and the wire between them.
 *
 * OBS composites a Browser Source with real transparency, which is the only
 * way into a scene with no window to crop and no title bar in shot. What it
 * cannot reliably do is open a webcam. So the tracking stays in an ordinary
 * tab and the page OBS opens has no camera in it — see src/core/rigLink.js.
 *
 * Everything about that arrangement fails quietly. A relay that never
 * connects, settings that never cross, a page that snaps to neutral the moment
 * the link hiccups: none of them throws, and all of them are things you find
 * out about on stream. So this drives both pages at once and asks whether the
 * second one is actually following the first.
 *
 *   node test/output.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import { chromeBin } from '../scripts/chrome.mjs';

const SESSION = JSON.parse(readFileSync(
  new URL('fixtures/tracker-session.json', import.meta.url), 'utf8'));

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

const server = await createServer({ server: { port: 5191 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: chromeBin(),
  args: ['--enable-unsafe-swiftshader', '--no-proxy-server',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

/* Two contexts, not two tabs.
 *
 * OBS's browser is a different browser with its own storage, which is the
 * whole reason the output page is told its settings rather than reading them.
 * Sharing a context here would hand it the tracker's localStorage and the test
 * would pass on something that cannot happen in the real arrangement.
 */
const trackerCtx = await browser.newContext({
  permissions: ['camera'], viewport: { width: 500, height: 500 },
});
const outputCtx = await browser.newContext({ viewport: { width: 480, height: 480 } });
const errors = [];
const watch = (page, who) => page.on('pageerror', (e) => errors.push(`${who}: ${e}`));

try {
  const tracker = await trackerCtx.newPage();
  watch(tracker, 'tracker');
  await tracker.goto('http://127.0.0.1:5191/', { waitUntil: 'load' });
  await tracker.waitForFunction(
    () => window.__vtuber?.avatars?.parts2d?.ready === true, null, { timeout: 60000 });

  const output = await outputCtx.newPage();
  watch(output, 'output');
  await output.goto('http://127.0.0.1:5191/output.html', { waitUntil: 'load' });
  await output.waitForFunction(
    () => window.__vtuberOutput?.avatars?.parts2d?.ready === true, null, { timeout: 60000 });

  // --- the wire is up ------------------------------------------------------
  const linked = await tracker.waitForFunction(
    () => window.__vtuber?.store && document.getElementById('status')?.textContent?.includes('OBS'),
    null, { timeout: 15000 }).catch(() => null);
  check('the tracker page says the output window is listening',
    Boolean(linked),
    (await tracker.locator('#status').textContent()) ?? 'no status');

  check('and the output page never loaded a camera or a tracking model',
    await output.evaluate(() => !('__vtuber' in window)
      && !performance.getEntriesByType('resource').some((r) => /\.task(\?|$)/.test(r.name))),
    'no .task fetched');

  // --- a setting crosses ---------------------------------------------------
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
    }),
    'nothing under vtuber-model/settings');

  await tracker.evaluate(() => window.__vtuber.store.set('stage.zoom', 1));

  // --- the pose crosses ----------------------------------------------------
  /* A frame from the real recording, pushed over the link, and then read back
   * off the OTHER page's rig.
   *
   * Two numbers from two pages is the only thing that says the wire carries
   * what it is supposed to. A relay that connects and forwards nothing looks
   * identical from either side on its own — the tracker sees a peer, the
   * output sees a socket, and the model never moves.
   *
   * The fake camera shows a rolling test pattern rather than a face, so the
   * frame is handed to the link directly instead of waiting for one that will
   * never come.
   */
  const sample = SESSION.samples.find((s) => s.face
    && Math.abs(s.face.head.yaw) > 0.25) ?? SESSION.samples.find((s) => s.face);
  check('the recording has a turned head to send', Boolean(sample),
    sample ? `yaw ${sample.face.head.yaw}` : 'none');

  /* Put the pose where the camera would have, and let the page send it.
   *
   * Injecting a frame into the link directly does not work, and finding out
   * why is worth the note: the tracker page sends `tracker.frame` on every
   * animation frame, so an injected one is overwritten within milliseconds by
   * the real stream — which, on a fake camera showing a test pattern, says
   * there is no face. Thirty-three frames arrived and every one of them was
   * empty. Written the other way round it exercises the path that actually
   * ships, from the tracker's own state outward.
   */
  await tracker.evaluate((face) => {
    const { tracker: t } = window.__vtuber;
    t.frame = face;
    t.hasFace = true;
  }, { shapes: {}, head: sample.face.head, position: sample.face.position });
  await output.bringToFront();

  // The rig smooths on wall time, so give it some.
  await output.waitForTimeout(4000);
  const outYaw = await output.evaluate(() => window.__vtuberOutput.rig.state.head.yaw);
  check('a pose sent from the tracker turns the head on the output page',
    Math.abs(outYaw) > 0.1, `output yaw ${outYaw.toFixed(3)}`);

  /* And turns it the same way this page would.
   *
   * Both ends run the rig, so both apply the mirror, the gains and the neutral
   * pose — but only if they are reading the same settings, which is the whole
   * point of sending them. Get that wrong and the model still moves, just
   * backwards or half as far, and "it works" from either side alone. Measured
   * against a rig on the tracker page fed the same frame for the same time.
   */
  const want = await tracker.evaluate(async (face) => {
    const { Rig } = await import('/src/tracking/rig.js');
    const rig = new Rig();
    // Well past settling, which the rig reaches in well under a second.
    for (let f = 0; f < 300; f++) rig.update(face, true, 1 / 60);
    return rig.state.head.yaw;
  }, { shapes: {}, head: sample.face.head, position: sample.face.position });
  check('and turns it the way this page would, not backwards or half as far',
    Math.sign(outYaw) === Math.sign(want) && Math.abs(outYaw - want) < 0.05,
    `output ${outYaw.toFixed(3)} against ${want.toFixed(3)} for the same frame`);

  check('and the output page is drawing something',
    await output.evaluate(() => {
      const a = window.__vtuberOutput.avatars.parts2d;
      const gl = a.gl;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const d = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 24) n++;
      return n > 2000;
    }), 'opaque pixels on the output canvas');

  // --- and it holds when the wire goes quiet -------------------------------
  /* Falling back to neutral would put a lurch on stream every time the link
   * hiccupped — a tab minimised for a moment, the server restarted. The last
   * pose is the right thing to keep showing.
   */
  const before = outYaw;
  await output.waitForTimeout(2500);
  const after = await output.evaluate(() => window.__vtuberOutput.rig.state.head.yaw);
  check('and holds that pose when nothing more arrives',
    Math.abs(after - before) < 0.02 && Math.abs(after) > 0.1,
    `yaw ${before.toFixed(3)} then ${after.toFixed(3)} two and a half seconds later,`
      + ' on one frame sent once');

  /* --- how dark the soft edges are ----------------------------------------
   *
   * This is the fault transparent capture actually has, and it stays invisible
   * until the model goes on a light scene: colour that has been multiplied by
   * its own alpha, handed over as though it had not, composites every soft
   * edge toward black. It is why the native tools ship something called
   * AlphaDilate.
   *
   * Measured, this model's rim comes out at about two thirds the brightness of
   * the paint beside it at four fifths alpha — darker than premultiplication
   * alone would explain, because this character is drawn with a heavy black
   * outline and its outermost pixels are that ink. So this cannot separate the
   * two, and does not pretend to: it is a floor, to catch the edges going
   * properly black. The blend does write premultiplied colour into a canvas
   * declared straight, and putting that right means changing the blend, the
   * shader and the shadow pass across three backends — a change of its own,
   * not a footnote to this one.
   */
  const fringe = await output.evaluate(() => {
    const gl = window.__vtuberOutput.avatars.parts2d.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const d = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
    const luma = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    let rim = 0; let rimLuma = 0; let rimAlpha = 0; let solid = 0; let solidLuma = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        const a = d[i + 3];
        if (a >= 250) continue;
        if (a < 40) continue;
        // Only rim next to real paint, so a lone speck cannot skew it.
        let near = -1;
        for (const j of [i - 4, i + 4, i - w * 4, i + w * 4]) {
          if (d[j + 3] >= 250) { near = j; break; }
        }
        if (near < 0) continue;
        rim++; rimLuma += luma(i); rimAlpha += a;
        solid++; solidLuma += luma(near);
      }
    }
    return rim > 200
      ? { rim, ratio: (rimLuma / rim) / Math.max(solidLuma / solid, 1e-6), alpha: (rimAlpha / rim) / 255 }
      : { rim, ratio: null, alpha: null };
  });
  check('the soft edges have not gone black',
    fringe.ratio !== null && fringe.ratio > 0.55,
    fringe.ratio === null ? `only ${fringe.rim} rim pixels to judge by`
      : `rim is ${(fringe.ratio * 100).toFixed(0)}% as bright as the paint beside it `
        + `at ${(fringe.alpha * 100).toFixed(0)}% alpha`);

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('test run completed', false, err.stack);
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${failures ? `${failures} failing` : 'all output checks passed'}`);
process.exit(failures ? 1 : 0);
