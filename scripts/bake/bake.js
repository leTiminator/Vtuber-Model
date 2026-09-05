/**
 * Cuts the character into parts and describes every one of them, in the
 * browser, for scripts/bake-model.mjs to write out as public/model/ninja/.
 *
 * The runtime renders what this produces and never cuts. Everything here is
 * deterministic in its inputs: the two drawings, the marker detector and the
 * cut, with no clock, randomness or settings read.
 */
import { cutParts } from '/src/avatars/parts/cut.js';
import { repairKeyedHoles } from '/src/avatars/parts/repair.js';
import { detectMarkers, readPixels } from '/src/avatars/parts/markers.js';
import { extractSpine } from '/src/avatars/parts/spine.js';

const SPINE_NODES = 16;
/** Rows in the cloth strip: it bends along its whole length. */
const CLOTH_GRID = 26;
/** Rows in each arm: its follow weight varies between glove and shoulder. */
const ARM_GRID = 12;
const MIN_SHARD = 40;

const EYES = new Set(['eyeNear', 'eyeFar', 'eyeNearOn', 'eyeFarOn']);
const FAR_EYES = new Set(['eyeFar', 'eyeFarOn']);
const TURNED_FACE = new Set(['head', 'tufts', 'eyeNear', 'eyeFar']);
const HEADON_FACE = new Set(['headOn', 'tuftsOn', 'eyeNearOn', 'eyeFarOn']);
const HEADON_OF = { head: 'headOn', tufts: 'tuftsOn', eyeNear: 'eyeNearOn', eyeFar: 'eyeFarOn' };
const SHADOWS = new Set(['body', 'armLeft', 'armRight', 'tufts', 'head', 'wrap', 'tuftsOn', 'headOn']);
const ARMS = new Set(['armLeft', 'armRight']);
const STILL = new Set(['body', 'wrap', 'tails']);

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not decode ${src}`));
    img.src = src;
  });
}

/**
 * @returns {Promise<{manifest: object, textures: {name: string, w: number, h: number,
 *   rgba: Uint8ClampedArray, margin: Uint8Array}[]}>}
 */
export async function bakeModel({ artwork, headOn, minShard = MIN_SHARD }) {
  const image = await loadImage(artwork);
  const headOnImage = headOn ? await loadImage(headOn) : null;

  const found = detectMarkers(readPixels(image));
  if (!found) throw new Error('no markers found in the artwork');
  const markers = { ...found, headR: Math.max(0.02, found.headR) };

  const { parts, width, height, sockets } = cutParts(image, markers);
  const aspect = width / height;

  const tails = parts.find((p) => p.name === 'tails');
  const spine = tails ? findSpine(tails, image, width, height, markers) : null;
  let spineSpan = 0;
  if (spine?.nodes?.length > 1) {
    const ns = spine.nodes;
    let total = 0;
    for (let i = 1; i < ns.length; i++) {
      total += Math.hypot(ns[i][0] - ns[i - 1][0], ns[i][1] - ns[i - 1][1]);
    }
    spineSpan = total / (ns.length - 1);
  }

  const headPart = parts.find((p) => p.name === 'head');
  const headSpan = headPart ? spanOf(headPart, width, height)
    : { cx: markers.headX, cy: markers.headY, r: markers.headR };

  const records = parts.map((part) => describe(part, { width, height, aspect, markers, sockets, spine }));
  const textures = parts.map((part) => textureOf(part));

  const front = headOnImage
    ? headOnFace(headOnImage, { width, height, aspect, markers, headSpan, minShard })
    : { note: 'no drawing', parts: [], sockets: [], markers: null, filled: 0, scale: 1 };
  for (const part of front.parts) {
    records.push(describe(part, {
      width, height, aspect, markers: front.markers, sockets: front.sockets, spine: null,
    }));
    textures.push(textureOf(part));
  }
  records.sort((a, b) => a.z - b.z);

  const manifest = {
    version: 1,
    source: { artwork, headOn: headOn ?? null, minShard },
    width,
    height,
    markers,
    headSpan,
    spine: spine ? { nodes: spine.nodes, span: spineSpan, pixels: spine.pixels } : null,
    sockets,
    headOn: {
      note: front.note,
      pieces: front.parts.length,
      filled: front.filled,
      scale: front.scale,
      markers: front.markers,
      sockets: front.sockets,
    },
    parts: records,
  };
  return { manifest, textures };
}

function spanOf(part, width, height) {
  return {
    cx: (part.x + part.inset + (part.w - 2 * part.inset) / 2) / width,
    cy: (part.y + part.inset + (part.h - 2 * part.inset) / 2) / height,
    r: Math.max(part.w - 2 * part.inset, part.h - 2 * part.inset) / 2 / height,
  };
}

/** Everything the renderer needs to place and draw one part, without its pixels. */
function describe(part, { width, height, markers, sockets, spine }) {
  const skinned = part.name === 'tails' && Boolean(spine);
  const grid = skinned ? CLOTH_GRID : ARMS.has(part.name) ? ARM_GRID : 1;
  const face = TURNED_FACE.has(part.name) ? 'turned' : HEADON_FACE.has(part.name) ? 'headOn' : null;
  return {
    name: part.name,
    z: part.z,
    joint: part.joint,
    farJoint: part.farJoint ?? null,
    pivot: part.pivot ?? null,
    x: part.x,
    y: part.y,
    w: part.w,
    h: part.h,
    inset: part.inset,
    pixels: part.pixels,
    place: part.place ?? null,
    png: `${part.name}.png`,
    marginPng: `${part.name}.margin.png`,
    grid,
    onChain: skinned ? chainMask(part, spine, width, height, grid) : null,
    flags: {
      eyes: EYES.has(part.name),
      far: FAR_EYES.has(part.name),
      face,
      shadow: SHADOWS.has(part.name),
      skinned,
      follow: face ? 'full' : STILL.has(part.name) ? 'none' : 'radial',
    },
    ...socketOf(part, sockets, width, height, markers),
  };
}

function textureOf(part) {
  const ctx = part.canvas.getContext('2d', { willReadFrequently: true });
  return {
    name: part.name,
    w: part.w,
    h: part.h,
    rgba: ctx.getImageData(0, 0, part.w, part.h).data,
    margin: part.margin ?? new Uint8Array(part.w * part.h),
  };
}

/** Where the eyes are in this part's texture, as centre and half-size in 0..1. */
function socketOf(part, sockets, width, height, m) {
  const fromBox = (b) => [
    (b.cx * width - part.x) / part.w,
    (b.cy * height - part.y) / part.h,
    (b.hx * width) / part.w,
    (b.hy * height) / part.h,
  ];
  const fromMarker = (rect) => [
    (((rect[0] + rect[2]) / 2) * width - part.x) / part.w,
    (((rect[1] + rect[3]) / 2) * height - part.y) / part.h,
    (Math.abs(rect[2] - rect[0]) / 2) * width / part.w,
    (Math.abs(rect[3] - rect[1]) / 2) * height / part.h,
  ];
  const AWAY = [-9, -9, 1, 1];
  if (!EYES.has(part.name)) {
    return {
      eyeL: sockets?.[0] ? fromBox(sockets[0]) : fromMarker(m.eyeL),
      eyeR: sockets?.[1] ? fromBox(sockets[1]) : fromMarker(m.eyeR),
      lidFill: sockets?.[0]?.fill ?? 1,
    };
  }
  // An eye part carries its own socket and pushes the other one off-texture.
  const cx = part.x + part.w / 2;
  const cy = part.y + part.h / 2;
  let best = null;
  let bestD = Infinity;
  for (const b of sockets ?? []) {
    const d = Math.hypot(b.cx * width - cx, b.cy * height - cy);
    if (d < bestD) { bestD = d; best = b; }
  }
  const own = best ? fromBox(best) : fromMarker(FAR_EYES.has(part.name) ? m.eyeR : m.eyeL);
  return { eyeL: own, eyeR: AWAY, lidFill: best?.fill ?? 1 };
}

/**
 * The head-on drawing, repaired and cut, with its four pieces renamed and
 * placed over the turned head.
 */
function headOnFace(headOnImage, { width, height, markers, headSpan, minShard }) {
  const none = (note) => ({ note, parts: [], sockets: [], markers: null, filled: 0, scale: 1 });
  const fixed = repairKeyedHoles(headOnImage);
  if (fixed.width !== width || fixed.height !== height) {
    return none(`drawn ${fixed.width}x${fixed.height}, not ${width}x${height}`);
  }
  const found = detectMarkers(readPixels(fixed.canvas));
  if (!found) return none('could not find a face in it');
  const m = { ...markers, ...found };
  const cut = cutParts(fixed.canvas, m, { minShard });
  const head = cut.parts.find((p) => p.name === 'head');
  const eyes = cut.parts.filter((p) => EYES.has(p.name));
  if (!head || eyes.length < 2) {
    return none(`cut into ${cut.parts.map((p) => p.name).join('+') || 'nothing'}`);
  }
  const span = spanOf(head, width, height);
  const place = {
    fromX: span.cx, fromY: span.cy,
    toX: headSpan.cx, toY: headSpan.cy,
    k: headSpan.r / Math.max(span.r, 1e-6),
  };
  const parts = [];
  for (const part of cut.parts) {
    const name = HEADON_OF[part.name];
    if (!name) continue;
    parts.push({ ...part, name, z: part.z + 0.5, place });
  }
  return {
    note: `${parts.length} pieces, ${fixed.filled}px repaired, scaled ${place.k.toFixed(2)}x`,
    parts, sockets: cut.sockets, markers: m, filled: fixed.filled, scale: place.k,
  };
}

/** The scarf's centreline as a chain of bones, from a thinned mask of it. */
function findSpine(part, image, width, height, m) {
  const scale = 0.5;
  const mw = Math.round(width * scale);
  const mh = Math.round(height * scale);

  const partCanvas = document.createElement('canvas');
  partCanvas.width = mw;
  partCanvas.height = mh;
  const pc = partCanvas.getContext('2d', { willReadFrequently: true });
  pc.drawImage(part.canvas, part.x * scale, part.y * scale, part.w * scale, part.h * scale);
  const pd = pc.getImageData(0, 0, mw, mh).data;

  const artCanvas = document.createElement('canvas');
  artCanvas.width = mw;
  artCanvas.height = mh;
  const ac = artCanvas.getContext('2d', { willReadFrequently: true });
  ac.drawImage(image, 0, 0, mw, mh);
  const ad = ac.getImageData(0, 0, mw, mh).data;

  const mask = new Uint8Array(mw * mh);
  for (let i = 0; i < mw * mh; i++) {
    if (pd[i * 4 + 3] > 120 && ad[i * 4 + 3] > 40) mask[i] = 1;
  }
  return extractSpine(mask, mw, mh, { x: m.pivotX * mw, y: m.pivotY * mh }, SPINE_NODES);
}

/**
 * Which vertices of the cloth grid sit on the piece of cloth the chain runs
 * through, as a string of 0 and 1 per vertex, row by row.
 */
function chainMask(part, spine, width, height, n) {
  const ribbon = ribbonMask(part, spine, width, height);
  let out = '';
  for (let row = 0; row <= n; row++) {
    for (let col = 0; col <= n; col++) {
      const s = col / n;
      const t = row / n;
      const i = Math.min(part.h - 1, Math.round(t * (part.h - 1))) * part.w
        + Math.min(part.w - 1, Math.round(s * (part.w - 1)));
      out += ribbon[i] ? '1' : '0';
    }
  }
  return out;
}

/** One byte per texel of the cloth part: 1 on the piece the spine runs through. */
function ribbonMask(part, spine, width, height) {
  const { w, h } = part;
  const n = w * h;
  const d = part.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const label = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const real = (i) => d[i * 4 + 3] > 40 && !(part.margin && part.margin[i] > 0);

  let pieces = 0;
  for (let seed = 0; seed < n; seed++) {
    if (!real(seed) || label[seed] >= 0) continue;
    const id = pieces++;
    let head = 0;
    let tail = 0;
    label[seed] = id;
    queue[tail++] = seed;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (label[j] >= 0 || !real(j)) continue;
          label[j] = id;
          queue[tail++] = j;
        }
      }
    }
  }
  const out = new Uint8Array(n);
  if (!pieces || !spine?.nodes?.length) return out.fill(1);

  // Grow every piece's label outward so the margin and the gaps get an owner.
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) if (label[i] >= 0) queue[tail++] = i;
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0 && label[i - 1] < 0) { label[i - 1] = label[i]; queue[tail++] = i - 1; }
    if (x < w - 1 && label[i + 1] < 0) { label[i + 1] = label[i]; queue[tail++] = i + 1; }
    if (y > 0 && label[i - w] < 0) { label[i - w] = label[i]; queue[tail++] = i - w; }
    if (y < h - 1 && label[i + w] < 0) { label[i + w] = label[i]; queue[tail++] = i + w; }
  }

  // The piece most spine nodes land on is the ribbon.
  const votes = new Int32Array(pieces);
  for (const [sx, sy] of spine.nodes) {
    const x = Math.min(w - 1, Math.max(0, Math.round(sx * width - part.x)));
    const y = Math.min(h - 1, Math.max(0, Math.round(sy * height - part.y)));
    votes[label[y * w + x]]++;
  }
  let own = 0;
  for (let i = 1; i < pieces; i++) if (votes[i] > votes[own]) own = i;
  for (let i = 0; i < n; i++) out[i] = label[i] === own ? 1 : 0;
  return out;
}

/**
 * Decode a PNG the way the runtime does and read the texture back, so a bake
 * can prove the bytes it wrote are the bytes the renderer will sample.
 */
export async function roundTrip(url, gl) {
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const out = new Uint8Array(bitmap.width * bitmap.height * 4);
  gl.readPixels(0, 0, bitmap.width, bitmap.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(tex);
  bitmap.close();
  return out;
}
