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
import { boot } from './harness.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

const { page, errors, close } = await boot({ viewport: { width: 900, height: 900 } });

try {
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

    /* Every piece a part is made of, so a stranded scrap cannot hide.
     *
     * A part is allowed to be more than one region — the body shows either
     * side of the scarf, and the scarf's tails cross the neck circle more than
     * once — but every region has to be a lobe rather than a chip. Sixteen
     * hundred pixels of scarf got stranded a head-radius from the neck with
     * wrap on all sides, and swung off on the chain while the cloth it was
     * drawn against rode with the head. Nothing here noticed, because nothing
     * here had ever asked what a part was made of.
     */
    const regionsOf = (p) => {
      const d = p.canvas.getContext('2d', { willReadFrequently: true })
        .getImageData(0, 0, p.w, p.h).data;
      const on = new Uint8Array(p.w * p.h);
      for (let i = 0; i < on.length; i++) on[i] = d[i * 4 + 3] > 250 ? 1 : 0;
      const seen = new Uint8Array(on.length);
      const stack = [];
      const sizes = [];
      for (let s = 0; s < on.length; s++) {
        if (seen[s] || !on[s]) continue;
        let n = 0;
        seen[s] = 1;
        stack.push(s);
        while (stack.length) {
          const i = stack.pop();
          n++;
          const x = i % p.w;
          const y = (i - x) / p.w;
          const v = (j) => { if (!seen[j] && on[j]) { seen[j] = 1; stack.push(j); } };
          if (x > 0) v(i - 1); if (x < p.w - 1) v(i + 1);
          if (y > 0) v(i - p.w); if (y < p.h - 1) v(i + p.w);
        }
        // Below this a region is a rounding artefact of the margin's own fade,
        // not a piece of the drawing.
        if (n > 40) sizes.push(n);
      }
      sizes.sort((x, y) => y - x);
      return sizes;
    };
    const regions = Object.fromEntries(parts.map((p) => [p.name, regionsOf(p)]));

    const byName = Object.fromEntries(parts.map((p) => [p.name, p]));
    const box = (p) => p && ({
      // Where the part sits, as a fraction of the frame, ignoring the padding.
      cx: (p.x + p.inset + (p.w - 2 * p.inset) / 2) / width,
      cy: (p.y + p.inset + (p.h - 2 * p.inset) / 2) / height,
      hx: (p.w - 2 * p.inset) / 2 / width,
      hy: (p.h - 2 * p.inset) / 2 / height,
      px: p.pixels,
    });
    return {
      wrong, opaque, total: width * height, regions,
      names: parts.map((p) => p.name),
      head: box(byName.head), tufts: box(byName.tufts),
      eyeNear: box(byName.eyeNear), eyeFar: box(byName.eyeFar),
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
  for (const name of ['tails', 'wrap', 'head', 'eyeNear', 'eyeFar', 'tufts', 'body',
    'armLeft', 'armRight']) {
    check(`${name} was cut`, result.names.includes(name), result.names.join(', '));
  }

  const { head, eyeNear, eyeFar, tufts, armLeft, armRight, body } = result;
  check('the head is the helmet, not just the visor', head && head.px > 12000,
    `${head?.px}px`);
  /* Inside the head's own box, not within a fixed radius of its centre.
   *
   * A radius was fine while the eyes were one part, because the pair averages
   * out near the middle of the face. Split, the far shard of a three-quarter
   * view sits out by the edge of the hood — that is what makes it the far one
   * — and any radius loose enough to admit it would also admit a shard that
   * had escaped onto the shoulder. The head's own extent is the honest bound.
   */
  for (const [name, eye] of [['eyeNear', eyeNear], ['eyeFar', eyeFar]]) {
    check(`${name} sits inside the head`,
      eye && Math.abs(eye.cx - head.cx) < head.hx && Math.abs(eye.cy - head.cy) < head.hy,
      `${name} ${eye?.cx.toFixed(2)},${eye?.cy.toFixed(2)} `
        + `head ${head?.cx.toFixed(2)},${head?.cy.toFixed(2)} `
        + `±${head?.hx.toFixed(2)},${head?.hy.toFixed(2)}`);
  }

  /* The split is only worth having if it split the right thing: two shards,
   * apart from each other, with the near one the bigger. A cut that put both
   * shards in one part and left the other empty would still pass every check
   * above, because both centroids would land on the head.
   */
  check('the eyes were cut apart, not halved',
    eyeNear && eyeFar && Math.abs(eyeNear.cx - eyeFar.cx) > 0.02,
    `near ${eyeNear?.cx.toFixed(3)} far ${eyeFar?.cx.toFixed(3)}`);
  check('the near eye is the bigger of the two',
    eyeNear && eyeFar && eyeNear.px > eyeFar.px,
    `near ${eyeNear?.px}px far ${eyeFar?.px}px`);
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

  /* --- the alternate views arrive damaged, and have to be repaired --------
   *
   * Every uploaded view of this character came off a white background that was
   * keyed away, and its eyes are white, so they went with it: transparent
   * holes and thinned speckles where the shards belong. Nothing downstream can
   * see an eye that is not there, so the head-on face silently never loaded
   * and several rounds were spent arguing about a latch instead.
   *
   * Checked on the file itself rather than on the render, because this is a
   * fact about the drawing and the render has a dozen other reasons to change.
   */
  const repaired = await page.evaluate(async () => {
    const { repairKeyedHoles } = await import('/src/avatars/parts/repair.js');
    const { cutParts } = await import('/src/avatars/parts/cut.js');
    const { detectMarkers, readPixels } = await import('/src/avatars/parts/markers.js');
    const art = window.__vtuber.avatars.parts2d;
    const load = (src) => new Promise((done, fail) => {
      const img = new Image();
      img.onload = () => done(img);
      img.onerror = () => fail(new Error(`could not load ${src}`));
      img.src = src;
    });
    const view = await load('/art/views/head-front-open.png');

    // How much near-white the visor holds, before and after. The eyes are the
    // only near-white on this head, so this counts eye and nothing else.
    const whiteIn = (source) => {
      const c = document.createElement('canvas');
      c.width = 630; c.height = 630;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(source, 0, 0);
      const d = g.getImageData(380, 330, 160, 70).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 200 && d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) n++;
      }
      return n;
    };
    const before = whiteIn(view);
    const fixed = repairKeyedHoles(view);
    const after = whiteIn(fixed.canvas);

    /* The same drawing loops its scarf over itself around thirteen thousand
     * pixels of genuine background. Painting that in turns the scarf into a
     * solid red slab, so the repair has to leave it alone — and the only thing
     * telling it apart from an eye is that it is forty times the size of one.
     *
     * Asked of the picture rather than of the repair's own tally. Whether that
     * region reads as enclosed at all depends on whether the background can
     * squeeze along an anti-aliased seam where the ribbon crosses itself, and
     * it can — so the tally said nothing was skipped while the region was
     * plainly still empty. What matters is that it is still empty. */
    const opaqueIn = (source) => {
      const c = document.createElement('canvas');
      c.width = 630; c.height = 630;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(source, 0, 0);
      const d = g.getImageData(120, 160, 220, 100).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 200) n++;
      return n;
    };
    const loopBefore = opaqueIn(view);
    const loopAfter = opaqueIn(fixed.canvas);
    // Its own markers: the head sits somewhere else in that picture, so this
    // drawing's marker positions would seed the cut into its shoulder.
    const front = { ...art.markers(), ...detectMarkers(readPixels(fixed.canvas)) };
    const cut = cutParts(fixed.canvas, front, { minShard: 40 });
    return {
      before, after, filled: fixed.filled, holes: fixed.holes,
      loopBefore, loopAfter,
      eyes: cut.parts.filter((p) => p.name.startsWith('eye')).map((p) => p.name),
      sockets: cut.sockets?.length ?? 0,
      fills: (cut.sockets ?? []).map((b) => +b.fill.toFixed(2)),
    };
  });
  check('the keyed-out eyes come back into the head-on drawing',
    repaired.after > repaired.before * 2 && repaired.filled > 100,
    `${repaired.before}px of white eye before, ${repaired.after}px after `
      + `(${repaired.filled}px over ${repaired.holes} patches)`);
  check('a hole the drawing means to have is left alone',
    repaired.loopAfter <= repaired.loopBefore + 40 && repaired.loopBefore < 12000,
    `${repaired.loopBefore}px of paint in the box round the scarf's loop before, `
      + `${repaired.loopAfter}px after, of 22000`);
  check('and the repaired drawing cuts into two eyes',
    repaired.eyes.length === 2 && repaired.sockets === 2,
    `${repaired.eyes.join('+') || 'none'}, ${repaired.sockets} sockets`);
  /* The lid sweeps the socket, and the socket is the shard plus a fixed pad
   * for its ink ring — so on a small shard the pad is most of the box and a
   * half blink shuts the eye outright. The shader scales by this number; if it
   * ever comes back as one, that scaling has quietly stopped doing anything.
   */
  check('and each socket knows how much of it is shard',
    repaired.fills.length === 2 && repaired.fills.every((f) => f > 0.1 && f < 1),
    repaired.fills.join(', '));

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('test run completed', false, err.stack);
} finally {
  await close();
}

console.log(`\n${failures ? `${failures} failing` : 'all part checks passed'}`);
process.exit(failures ? 1 : 0);
