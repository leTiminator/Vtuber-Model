/**
 * Bakes the character into public/model/ninja/: one PNG and one margin PNG
 * per part, and a manifest describing how they fit together.
 *
 *   node scripts/bake-model.mjs          write anything that changed
 *   node scripts/bake-model.mjs --check  exit 1 if a fresh bake differs from
 *                                        what is committed, or if the browser
 *                                        decodes a committed PNG to different
 *                                        bytes than the bake produced
 *
 * The cut needs a canvas, so it runs in headless Chromium on the dev server,
 * the same way the test suites do. PNG bytes are compared decoded, never as
 * files: the deflate stream may differ between zlib builds while the pixels
 * do not, and an identical image is never rewritten.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { boot, ROOT } from '../test/harness.mjs';

const OUT = resolve(ROOT, 'public/model/ninja');
const ARTWORK = 'art/BA_Ninja_TPBG.png';
const HEAD_ON = 'art/views/pose-front-arms-out.png';
const CHECK = process.argv.includes('--check');

/** Numbers to six decimals, keys sorted, so the manifest diffs by meaning. */
function canon(value) {
  if (typeof value === 'number') {
    const n = Number(value.toFixed(6));
    return n === 0 ? 0 : n;
  }
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canon(value[k])]));
  }
  return value;
}

function encodeRgba(w, h, rgba) {
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return PNG.sync.write(png, { colorType: 6, deflateLevel: 9 });
}

function encodeGrey(w, h, bytes) {
  const png = new PNG({ width: w, height: h, colorType: 0, inputColorType: 0, inputHasAlpha: false });
  png.data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return PNG.sync.write(png, { colorType: 0, inputColorType: 0, inputHasAlpha: false, deflateLevel: 9 });
}

/** Decoded pixels of a committed PNG, or null when there is none. */
function decoded(file) {
  if (!existsSync(file)) return null;
  return PNG.sync.read(readFileSync(file));
}

function sameRgba(png, w, h, rgba) {
  if (!png || png.width !== w || png.height !== h) return false;
  return Buffer.compare(png.data, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)) === 0;
}

function sameGrey(png, w, h, bytes) {
  if (!png || png.width !== w || png.height !== h) return false;
  for (let i = 0; i < bytes.length; i++) if (png.data[i * 4] !== bytes[i]) return false;
  return true;
}

const { page, browser, close } = await boot({ waitReady: false });
let failed = 0;
const fail = (msg) => { failed++; console.log(` FAIL  ${msg}`); };
const ok = (msg) => console.log(`  ok   ${msg}`);

try {
  const baked = await page.evaluate(async ({ artwork, headOn }) => {
    const { bakeModel } = await import('/scripts/bake/bake.js');
    const { manifest, textures } = await bakeModel({ artwork: `/${artwork}`, headOn: `/${headOn}` });
    const b64 = (bytes) => {
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return btoa(s);
    };
    return {
      manifest,
      textures: textures.map((t) => ({
        name: t.name, w: t.w, h: t.h,
        rgba: b64(new Uint8Array(t.rgba.buffer, t.rgba.byteOffset, t.rgba.byteLength)),
        margin: b64(t.margin),
      })),
    };
  }, { artwork: ARTWORK, headOn: HEAD_ON });

  const textures = baked.textures.map((t) => ({
    ...t, rgba: Buffer.from(t.rgba, 'base64'), margin: Buffer.from(t.margin, 'base64'),
  }));
  const manifest = canon({
    ...baked.manifest,
    source: {
      ...baked.manifest.source,
      artwork: ARTWORK,
      headOn: HEAD_ON,
      bakedWith: {
        chromium: browser.version(),
        playwright: JSON.parse(readFileSync(resolve(ROOT, 'node_modules/playwright/package.json'), 'utf8')).version,
      },
    },
  });
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestFile = join(OUT, 'manifest.json');

  if (CHECK) {
    const committed = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : null;
    const strip = (m) => m && { ...m, source: { ...m.source, bakedWith: undefined } };
    const a = JSON.stringify(canon(strip(committed)));
    const b = JSON.stringify(canon(strip(manifest)));
    if (a === b) ok('manifest.json matches a fresh bake');
    else fail(`manifest.json differs from a fresh bake${committed ? `: ${firstDiff(committed, manifest)}` : ' (missing)'}`);

    for (const t of textures) {
      if (sameRgba(decoded(join(OUT, `${t.name}.png`)), t.w, t.h, t.rgba)) ok(`${t.name}.png decodes to the baked pixels`);
      else fail(`${t.name}.png differs from a fresh bake`);
      if (sameGrey(decoded(join(OUT, `${t.name}.margin.png`)), t.w, t.h, t.margin)) ok(`${t.name}.margin.png decodes to the baked margin`);
      else fail(`${t.name}.margin.png differs from a fresh bake`);
    }

    // The browser's own decode of every committed PNG, read back off a texture.
    const trips = await page.evaluate(async (names) => {
      const { roundTrip } = await import('/scripts/bake/bake.js');
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return { error: 'no WebGL2' };
      const out = {};
      for (const name of names) {
        const bytes = await roundTrip(`/model/ninja/${name}.png`, gl);
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        out[name] = btoa(s);
      }
      return out;
    }, textures.map((t) => t.name));
    if (trips.error) fail(trips.error);
    for (const t of textures) {
      const got = trips[t.name] ? Buffer.from(trips[t.name], 'base64') : null;
      if (got && Buffer.compare(got, t.rgba) === 0) ok(`${t.name}.png reaches the GPU byte for byte`);
      else fail(`${t.name}.png: the browser decodes it to different bytes (${got ? countDiff(got, t.rgba) : 'no data'})`);
    }
  } else {
    mkdirSync(OUT, { recursive: true });
    let written = 0;
    const keep = new Set(['manifest.json']);
    for (const t of textures) {
      const rgbaFile = join(OUT, `${t.name}.png`);
      const greyFile = join(OUT, `${t.name}.margin.png`);
      keep.add(`${t.name}.png`).add(`${t.name}.margin.png`);
      if (!sameRgba(decoded(rgbaFile), t.w, t.h, t.rgba)) { writeFileSync(rgbaFile, encodeRgba(t.w, t.h, t.rgba)); written++; }
      if (!sameGrey(decoded(greyFile), t.w, t.h, t.margin)) { writeFileSync(greyFile, encodeGrey(t.w, t.h, t.margin)); written++; }
    }
    if (!existsSync(manifestFile) || readFileSync(manifestFile, 'utf8') !== text) { writeFileSync(manifestFile, text); written++; }
    for (const f of readdirSync(OUT)) if (!keep.has(f)) { unlinkSync(join(OUT, f)); console.log(`  removed stale ${f}`); }
    console.log(`baked ${textures.length} parts into ${OUT}: ${written} file${written === 1 ? '' : 's'} written`);
    console.log(`  ${manifest.headOn.note}; spine ${manifest.spine ? `${manifest.spine.nodes.length} nodes` : 'none'}; `
      + `${manifest.sockets.length} sockets`);
  }
} catch (err) {
  fail(`bake did not complete: ${err.stack}`);
} finally {
  await close();
}

function firstDiff(a, b, path = '') {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) return `${path || '/'}: ${JSON.stringify(a)?.slice(0, 40)} vs ${JSON.stringify(b)?.slice(0, 40)}`;
  if (a && typeof a === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], `${path}/${k}`);
      if (d) return d;
    }
    return '';
  }
  return a === b ? '' : `${path}: ${a} vs ${b}`;
}

function countDiff(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return `${n} of ${a.length} bytes differ`;
}

if (CHECK) console.log(failed ? `\nbake check: ${failed} problem(s)` : '\nbake check clean');
process.exit(failed ? 1 : 0);
