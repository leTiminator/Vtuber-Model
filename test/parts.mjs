/**
 * The cut has to be lossless.
 *
 * Every part keeps image-space coordinates, so stacking them back-to-front at
 * their stored positions must reproduce the original artwork pixel for pixel.
 * That is a strong guard: it catches a part that grew into its neighbour, a
 * dilated margin that leaked into open space, and any pixel dropped on the
 * floor — all of which are invisible in a single rendered frame and obvious
 * here.
 *
 * It does not check that each part is the *right* part. The parts sheet
 * (`npm run parts`) is for that, and a cut that reassembles perfectly can
 * still put the helmet in the hair layer, which is exactly what once happened.
 * So the shape of each part is asserted separately below.
 *
 *   node test/parts.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_BIN ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

const server = await createServer({ server: { port: 5189 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--enable-unsafe-swiftshader'],
});
const page = await (await browser.newContext({ viewport: { width: 900, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto('http://127.0.0.1:5189/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vtuber?.avatars?.parts2d?.ready === true,
    null, { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const { cutParts } = await import('/src/avatars/parts/cut.js');
    const art = window.__vtuber.avatars.parts2d;
    const image = art.image;
    const { parts, width, height } = cutParts(image, art.markers());

    // Stack the parts back-to-front at their stored positions.
    const stack = document.createElement('canvas');
    stack.width = width;
    stack.height = height;
    const s = stack.getContext('2d');
    for (const p of [...parts].sort((a, b) => a.z - b.z)) s.drawImage(p.canvas, p.x, p.y);

    const original = document.createElement('canvas');
    original.width = width;
    original.height = height;
    original.getContext('2d').drawImage(image, 0, 0);

    const a = s.getImageData(0, 0, width, height).data;
    const b = original.getContext('2d').getImageData(0, 0, width, height).data;

    let opaque = 0;
    let wrong = 0;
    for (let i = 0; i < a.length; i += 4) {
      const solid = b[i + 3] > 40;
      if (solid) opaque++;
      // A pixel is wrong if it differs in colour where the art is solid, or if
      // a dilated margin painted somewhere the art is transparent.
      const near = Math.abs(a[i] - b[i]) < 12 && Math.abs(a[i + 1] - b[i + 1]) < 12 &&
                   Math.abs(a[i + 2] - b[i + 2]) < 12 && Math.abs(a[i + 3] - b[i + 3]) < 40;
      if (!near) wrong++;
    }

    const byName = Object.fromEntries(parts.map((p) => [p.name, p]));
    const box = (p) => p && ({
      // Where the part sits, as a fraction of the frame, ignoring the padding.
      cx: (p.x + p.inset + (p.w - 2 * p.inset) / 2) / width,
      cy: (p.y + p.inset + (p.h - 2 * p.inset) / 2) / height,
      px: p.pixels,
    });
    return {
      wrong, opaque, total: width * height,
      names: parts.map((p) => p.name),
      head: box(byName.head), eyes: box(byName.eyes), tufts: box(byName.tufts),
      armLeft: box(byName.armLeft), armRight: box(byName.armRight),
      body: box(byName.body), tails: box(byName.tails), wrap: box(byName.wrap),
    };
  });

  const pct = (100 * result.wrong) / result.opaque;
  check('the parts reassemble into the original artwork', pct < 0.5,
    `${result.wrong} wrong of ${result.opaque} opaque (${pct.toFixed(3)}%)`);

  /* --- and each part is actually the part it claims to be ------------------
   * Positions are asserted loosely, as fractions of the frame: enough to catch
   * a part swapping identity with another — the failure the diff above cannot
   * see — without pinning the cut to exact pixels.
   */
  for (const name of ['tails', 'wrap', 'head', 'eyes', 'tufts', 'body', 'armLeft', 'armRight']) {
    check(`${name} was cut`, result.names.includes(name), result.names.join(', '));
  }

  const { head, eyes, tufts, armLeft, armRight, body } = result;
  check('the head is the helmet, not just the visor', head && head.px > 12000,
    `${head?.px}px`);
  check('the eyes sit inside the head',
    eyes && Math.hypot(eyes.cx - head.cx, eyes.cy - head.cy) < 0.12,
    `eyes ${eyes?.cx.toFixed(2)},${eyes?.cy.toFixed(2)} head ${head?.cx.toFixed(2)},${head?.cy.toFixed(2)}`);
  check('the tufts sit above and behind the head',
    tufts && tufts.cy < head.cy && tufts.cx < head.cx,
    `tufts ${tufts?.cx.toFixed(2)},${tufts?.cy.toFixed(2)}`);
  check('the tufts are hair, not half the helmet', tufts && tufts.px < head.px * 0.6,
    `tufts ${tufts?.px}px vs head ${head?.px}px`);
  check('the arms are on opposite sides of the figure',
    armLeft && armRight && armLeft.cx < armRight.cx - 0.2,
    `left ${armLeft?.cx.toFixed(2)} right ${armRight?.cx.toFixed(2)}`);
  check('the body is below the head', body && body.cy > head.cy, `body cy ${body?.cy.toFixed(2)}`);

  /* --- artwork the rules were never written for ----------------------------
   * The cut is tuned to one drawing on purpose. But "tuned for" must not mean
   * "throws on anything else": every rule here can come up empty — no scarf
   * colour, so no head boundary; no loose cloth, so no gloves and no arms — and
   * the degenerate path has to fall out as a plain figure, not an exception.
   */
  const odd = await page.evaluate(async () => {
    const { cutParts } = await import('/src/avatars/parts/cut.js');
    const make = (draw) => {
      const c = document.createElement('canvas');
      c.width = 240;
      c.height = 240;
      draw(c.getContext('2d'));
      return Object.assign(c, { naturalWidth: c.width, naturalHeight: c.height });
    };
    const markers = {
      headX: 0.5, headY: 0.3, headR: 0.2, pivotX: 0.5, pivotY: 0.52, waistY: 0.78,
      eyeL: [0.41, 0.27, 0.48, 0.32], eyeR: [0.52, 0.27, 0.59, 0.32], eyeAngle: 0,
    };
    const cases = {
      // One flat grey figure: no saturated colour anywhere, so no scarf.
      colourless: (g) => { g.fillStyle = '#6a6a70'; g.fillRect(60, 30, 120, 190); },
      // Entirely one saturated colour: everything looks like cloth.
      allCloth: (g) => { g.fillStyle = '#d12029'; g.fillRect(40, 20, 160, 200); },
      // Nothing but transparency.
      empty: () => {},
      // Scattered specks, all below every minimum.
      specks: (g) => { g.fillStyle = '#333'; for (let i = 0; i < 40; i++) g.fillRect(i * 5, i * 5, 2, 2); },
    };
    const out = {};
    for (const [name, draw] of Object.entries(cases)) {
      try {
        const { parts } = cutParts(make(draw), markers);
        out[name] = `${parts.length} parts: ${parts.map((p) => p.name).join('/') || 'none'}`;
      } catch (err) {
        out[name] = `THREW ${err.message}`;
      }
    }
    return out;
  });

  for (const [name, result] of Object.entries(odd)) {
    check(`unfamiliar artwork (${name}) cuts without throwing`,
      !result.startsWith('THREW'), result);
  }

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('test run completed', false, err.stack);
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${failures ? `${failures} failing` : 'all part checks passed'}`);
process.exit(failures ? 1 : 0);
