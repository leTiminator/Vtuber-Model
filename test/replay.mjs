/**
 * Replays a recorded tracker session through the rig and the renderer.
 *
 * Every other motion check here is a sweep written by hand, so each one
 * encodes an assumption about what a camera produces. This one has no
 * assumptions in it: it is what a camera actually produced.
 *
 * Skips, loudly, when no recording has been added yet.
 *
 *   node test/replay.mjs
 */
import { chromium } from 'playwright';
import { chromeBin } from '../scripts/chrome.mjs';
import { createServer } from 'vite';
import { readFileSync, existsSync } from 'node:fs';

const FIXTURE = new URL('./fixtures/tracker-session.json', import.meta.url);

if (!existsSync(FIXTURE)) {
  console.log('  --   no recording yet: test/fixtures/tracker-session.json is missing.');
  console.log('       Record one from the app: Camera & tracking -> Record 20 seconds.');
  console.log('\nnothing to replay');
  process.exit(0);
}

const session = JSON.parse(readFileSync(FIXTURE, 'utf8'));
let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

check('the recording has frames', Array.isArray(session.samples) && session.samples.length > 30,
  `${session.samples?.length ?? 0} frames over ${session.seconds ?? '?'}s`);
check('the recording saw a face', (session.withFace ?? 0) > session.samples.length * 0.5,
  `${session.withFace} of ${session.samples.length} frames`);

const server = await createServer({ server: { port: 5193 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: chromeBin(),
  args: ['--enable-unsafe-swiftshader', '--no-proxy-server'],
});
const page = await (await browser.newContext({ viewport: { width: 420, height: 420 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|^INFO:|XNNPACK|GL Driver|OpenGL error/i.test(m.text())) {
    errors.push(m.text());
  }
});

try {
  await page.goto('http://127.0.0.1:5193/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vtuber?.avatars?.parts2d?.ready === true,
    null, { timeout: 40000 });

  const result = await page.evaluate((rec) => {
    const { avatars, store } = window.__vtuber;
    const { Rig } = window.__vtuber;
    const a = avatars.parts2d;
    store.patch({ 'stage.zoom': 0.62, 'stage.offsetX': 0, 'stage.offsetY': 0 });

    const rig = window.__vtuber.rig;
    rig.clearCalibration();

    const read = () => {
      const gl = a.gl;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const d = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
      return { d, w, h };
    };
    const stats = ({ d, w }) => {
      let opaque = 0, partial = 0, sx = 0, sy = 0;
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        const alpha = d[i + 3];
        if (alpha <= 24) continue;
        opaque++;
        if (alpha < 236) partial++;
        const x = p % w;
        sx += x; sy += (p - x) / w;
      }
      return { opaque, partial, cx: sx / Math.max(opaque, 1), cy: sy / Math.max(opaque, 1) };
    };

    let prev = null;
    let worstPartial = 0, worstPartialAt = 0, maxJump = 0, maxJumpAt = 0;
    let shutFrames = 0;
    let tracked = 0;
    let minArea = Infinity, maxArea = 0;
    let finite = true;
    let prevT = rec.samples[0]?.t ?? 0;

    for (const s of rec.samples) {
      const dt = Math.max(1 / 240, Math.min(s.t - prevT, 1 / 15));
      prevT = s.t;
      // Rebuild the blendshape object from the shared key list.
      const frame = s.face ? {
        shapes: Object.fromEntries(rec.shapeKeys.map((k, i) => [k, s.face.shapes[i] ?? 0])),
        head: s.face.head,
        position: s.face.position,
        time: s.t * 1000,
      } : null;
      rig.update(frame, Boolean(s.face), dt);
      rig.updatePose(s.pose ? { joints: s.pose, time: s.t * 1000 } : null, Boolean(s.pose), dt);

      for (const group of Object.values(rig.state)) {
        if (group && typeof group === 'object') {
          for (const v of Object.values(group)) {
            if (typeof v === 'number' && !Number.isFinite(v)) finite = false;
          }
        }
      }

      if (s.face) {
        tracked++;
        if (Math.max(rig.state.eyes.blinkL, rig.state.eyes.blinkR) > 0.5) shutFrames++;
      }

      a.render(rig.state, dt);
      const st = stats(read());
      worstPartial = Math.max(worstPartial, st.partial / Math.max(st.opaque, 1));
      if (worstPartial === st.partial / Math.max(st.opaque, 1)) worstPartialAt = s.t;
      minArea = Math.min(minArea, st.opaque);
      maxArea = Math.max(maxArea, st.opaque);
      if (prev) {
        const jump = Math.hypot(st.cx - prev.cx, st.cy - prev.cy);
        if (jump > maxJump) { maxJump = jump; maxJumpAt = s.t; }
      }
      prev = st;
    }

    return { worstPartial, worstPartialAt, maxJump, maxJumpAt, minArea, maxArea, finite,
      shutFrames, tracked };
  }, session);

  check('every rig channel stays finite through the session', result.finite);
  check('nothing goes translucent', result.worstPartial < 0.20,
    `worst ${(result.worstPartial * 100).toFixed(1)}% at ${result.worstPartialAt.toFixed(1)}s`);
  check('the character never collapses', result.minArea > result.maxArea * 0.55,
    `${result.minArea} smallest of ${result.maxArea} largest`);
  /* The plain size of the largest step, deliberately.
   *
   * A cleverer metric was tried first — each step against the median of its
   * neighbours — on the reasoning that real motion arrives in runs while a
   * teleport stands alone. It does not discriminate here: the teleport drags
   * the model out and back over several frames, so its neighbours are large
   * too, and it scored 6.3x against the fixed model's 6.7x. It passed either
   * way, which makes it worse than useless.
   *
   * Absolute size does discriminate. Measured on this recording, by removing
   * one guard at a time: 19.2px with the speed cap gone, 6.7px with
   * everything in place. The threshold sits between. The pose hold is worth a
   * further 9.0px to 6.7px but is not what this check catches — it has its own
   * assertions in test/rig.mjs, which is the right place for it.
   */
  check('no pops', result.maxJump < 12,
    `largest step ${result.maxJump.toFixed(1)}px at ${result.maxJumpAt.toFixed(1)}s`);
  /* Eyes open, because they were open.
   *
   * Nobody sat through this recording blinking half the time. The lid follows
   * the gaze, and the tracker reports that as a blink — before it was
   * discounted this shut the model's eyes in 116 of the 247 tracked frames
   * here, forty-seven per cent, while its owner was looking at a screen with
   * their eyes wide open. A recording is the only thing that can catch this:
   * a synthetic sweep has whatever blink weights the sweep chose to put in it.
   */
  const shutPct = (100 * result.shutFrames) / Math.max(result.tracked, 1);
  check('the eyes stay open through a session where they were open',
    shutPct < 10,
    `shut in ${result.shutFrames} of ${result.tracked} tracked frames (${shutPct.toFixed(0)}%)`);

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('replay completed', false, err.stack);
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${failures ? `${failures} failing` : 'replay clean'}`);
process.exit(failures ? 1 : 0);
