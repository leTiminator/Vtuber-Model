/**
 * Rigs a single flat image with the tracking rig, by laying a deformation mesh
 * over it and bending each region separately.
 *
 * The point of this backend is that it needs no layer separation and no
 * redrawing: you hand it the artwork you already have, mark where the head and
 * eyes are, and it turns, nods, tilts, breathes, blinks, squints, and lets the
 * cloth and hair trail behind the motion.
 *
 * Regions rather than layers, deliberately. Separating a drawing into layers
 * lets parts move freely but leaves holes wherever one used to cover another,
 * and a hole reads far worse than limited range. Every vertex here belongs to
 * one continuous sheet, so nothing can ever tear open.
 */
import { clamp, damp, lerp, makeSpring, spring } from '../../core/math.js';
import * as store from '../../core/store.js';
import { computeFrame } from '../../core/framing.js';
import { CHAIN_SAMPLES, FRAGMENT_SHADER, VERTEX_SHADER } from './shader.js';
import { ChainField, HeadInertia } from './cloth.js';
import { buildMasks, detectMarkers, readPixels, sampleLidColours } from './segment.js';

const UNIFORMS = [
  'u_headCenter', 'u_pivot', 'u_aspect', 'u_cylR', 'u_yaw', 'u_pitch', 'u_roll',
  'u_parallax', 'u_bodyOffset', 'u_bodyRot', 'u_breath', 'u_lowerDamping',
  'u_cloth', 'u_tuft', 'u_clothWeight', 'u_tuftWeight',
  'u_viewScale', 'u_viewOffset',
  'u_tex', 'u_eyeL', 'u_eyeR', 'u_blink', 'u_squint', 'u_gaze',
  'u_eyesEnabled', 'u_glow', 'u_glowPulse', 'u_keyWhite',
  'u_eyeAngle', 'u_lidL', 'u_lidR',
];

/** Settings that change the mesh itself rather than just a frame's uniforms. */
const GEOMETRY_KEYS = new Set([
  'warp.headX', 'warp.headY', 'warp.headR', 'warp.pivotX', 'warp.pivotY',
  'warp.waistY', 'warp.eyeL', 'warp.eyeR', 'warp.eyeAngle', 'warp.mesh',
]);

export const parseRect = (value, fallback = [0.4, 0.27, 0.48, 0.33]) => {
  try {
    const r = JSON.parse(value);
    return Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) ? r : fallback;
  } catch {
    return fallback;
  }
};

export class Warp2D {
  static id = 'warp2d';
  static label = 'My artwork (rigged)';

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'avatar-canvas';
    this.gl = null;
    this.image = null;
    this.pixels = null;
    this.masks = null;
    this.clock = 0;
    this.ready = false;
    this.error = null;
    this.onStatus = () => {};

    this.cloth = new ChainField({ nodes: CHAIN_SAMPLES, chain: 240, rest: 26, damping: 4.4, tipBias: 2.2 });
    this.tuft = new ChainField({ nodes: CHAIN_SAMPLES, chain: 420, rest: 120, damping: 9.5, tipBias: 1.5 });
    this.inertia = new HeadInertia();
    this.springs = { yaw: makeSpring(), pitch: makeSpring(), roll: makeSpring() };
    this.glowPulse = 1;

    this.unsubscribe = store.subscribe((key) => {
      if (GEOMETRY_KEYS.has(key)) this.meshDirty = true;
    });
  }

  mount(container) {
    container.appendChild(this.canvas);
    if (!this.gl) this.initGL();
  }

  initGL() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: true,
      preserveDrawingBuffer: true, // so tests and thumbnails can read pixels
    });
    if (!gl) {
      this.error = 'This browser has no WebGL2, which this mode needs.';
      this.onStatus(this.error);
      return;
    }
    this.gl = gl;

    const program = linkProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    if (!program) {
      this.error = 'Could not compile the warp shaders.';
      this.onStatus(this.error);
      return;
    }
    this.program = program;
    gl.useProgram(program);

    this.loc = {};
    for (const name of UNIFORMS) this.loc[name] = gl.getUniformLocation(program, name);
    this.attr = {
      uv: gl.getAttribLocation(program, 'a_uv'),
      w0: gl.getAttribLocation(program, 'a_w0'),
      w1: gl.getAttribLocation(program, 'a_w1'),
    };

    this.vao = gl.createVertexArray();
    this.buffers = {
      uv: gl.createBuffer(),
      w0: gl.createBuffer(),
      w1: gl.createBuffer(),
      index: gl.createBuffer(),
    };

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    this.meshDirty = true;
    this.uploadTexture();
  }

  /**
   * Artwork can arrive before this backend has ever been mounted, so the upload
   * waits until there is a context to upload into.
   * @param {HTMLImageElement} image
   * @param {boolean} placeMarkers  re-run detection (skip when restoring a save)
   */
  setImage(image, placeMarkers = false) {
    this.image = image;
    this.aspect = image.naturalWidth / image.naturalHeight;
    this.pixels = readPixels(image);
    this.masks = null;
    this.lids = null;

    if (placeMarkers && this.pixels) {
      const found = detectMarkers(this.pixels);
      if (found) {
        store.patch({
          'warp.headX': found.headX,
          'warp.headY': found.headY,
          'warp.headR': found.headR,
          'warp.pivotX': found.pivotX,
          'warp.pivotY': found.pivotY,
          'warp.waistY': found.waistY,
          'warp.eyeAngle': found.eyeAngle,
          'warp.eyeL': JSON.stringify(found.eyeL),
          'warp.eyeR': JSON.stringify(found.eyeR),
        });
        this.markerConfidence = found.confidentEyes;
      }
    }

    this.cloth.reset();
    this.tuft.reset();
    this.meshDirty = true;
    this.uploadTexture();
  }

  uploadTexture() {
    const gl = this.gl;
    const image = this.image;
    if (!gl || !image) return;

    if (this.texture) gl.deleteTexture(this.texture);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    // CLAMP_TO_EDGE matters: the lid trick samples just outside an eye socket.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Turning the head compresses one side of the face, so the texture gets
    // minified there; without mipmaps that edge crawls and aliases.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) {
      const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
      gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
    }

    this.ready = true;
    this.meshDirty = true;
  }

  markers() {
    return {
      headX: store.get('warp.headX'),
      headY: store.get('warp.headY'),
      headR: Math.max(0.02, store.get('warp.headR')),
      pivotX: store.get('warp.pivotX'),
      pivotY: store.get('warp.pivotY'),
      waistY: store.get('warp.waistY'),
      eyeAngle: store.get('warp.eyeAngle'),
      eyeL: parseRect(store.get('warp.eyeL')),
      eyeR: parseRect(store.get('warp.eyeR')),
    };
  }

  /** Rebuild the grid and sample every region weight onto its vertices. */
  buildMesh() {
    const gl = this.gl;
    if (!gl) return;

    const n = clamp(Math.round(store.get('warp.mesh')), 8, 64);
    const m = this.markers();
    if (this.pixels && !this.masks) {
      this.masks = buildMasks(this.pixels, m);
      this.lids = sampleLidColours(this.pixels, m, m.eyeAngle);
    }
    const masks = this.masks;

    const uv = [];
    const w0 = [];
    const w1 = [];

    for (let row = 0; row <= n; row++) {
      for (let col = 0; col <= n; col++) {
        const u = col / n;
        const v = row / n;
        uv.push(u, v);

        if (masks) {
          w0.push(
            sample(masks.head, masks.w, masks.h, u, v),
            sample(masks.face, masks.w, masks.h, u, v),
            sample(masks.tufts, masks.w, masks.h, u, v),
            sample(masks.cloth, masks.w, masks.h, u, v),
          );
          w1.push(
            sample(masks.torso, masks.w, masks.h, u, v),
            sample(masks.lower, masks.w, masks.h, u, v),
            sample(masks.clothT, masks.w, masks.h, u, v),
            sample(masks.tuftT, masks.w, masks.h, u, v),
          );
        } else {
          // No pixels to analyse — fall back to a plain head circle so the
          // backend still does something sensible.
          const d = Math.hypot((u - m.headX) * (this.aspect ?? 1), v - m.headY) / m.headR;
          const head = 1 - smoothstep(0.95, 2.0, d);
          w0.push(head, head, 0, 0);
          w1.push(1 - head, v > m.waistY ? 1 : 0, 0, 0);
        }
      }
    }

    const indices = [];
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const a = row * (n + 1) + col;
        const b = a + 1;
        const c = a + (n + 1);
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    this.indexCount = indices.length;

    gl.bindVertexArray(this.vao);
    bindAttribute(gl, this.buffers.uv, this.attr.uv, new Float32Array(uv), 2);
    bindAttribute(gl, this.buffers.w0, this.attr.w0, new Float32Array(w0), 4);
    bindAttribute(gl, this.buffers.w1, this.attr.w1, new Float32Array(w1), 4);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    this.meshDirty = false;
  }

  resize(width, height, dpr = window.devicePixelRatio || 1) {
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
  }

  render(rig, dt) {
    const gl = this.gl;
    if (!gl || !this.width) return;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.ready) return;

    dt = clamp(dt, 1 / 240, 1 / 15);
    this.clock += dt;
    if (this.meshDirty) this.buildMesh();

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    const L = this.loc;
    const m = this.markers();
    const head = rig.head;

    // --- framing ---------------------------------------------------------
    const frame = computeFrame(this.aspect, this.canvas.width, this.canvas.height,
      store.get('stage.zoom'), store.get('stage.offsetX'), store.get('stage.offsetY'));
    gl.uniform2f(L.u_viewScale, frame.sx, frame.sy);
    gl.uniform2f(L.u_viewOffset, frame.ox, frame.oy);
    gl.uniform1f(L.u_aspect, this.aspect);
    gl.uniform2f(L.u_headCenter, m.headX, m.headY);
    gl.uniform2f(L.u_pivot, m.pivotX, m.pivotY);
    // A cylinder wider than the head, or features crowd together far too fast.
    gl.uniform1f(L.u_cylR, m.headR * 1.85);

    // --- head angles, with overshoot -------------------------------------
    const overshoot = store.get('warp.overshoot');
    const yawTarget = head.yaw * store.get('warp.turn');
    const pitchTarget = head.pitch * store.get('warp.nod');
    const rollTarget = head.roll;

    // Under-damped on purpose: the head should settle, not stop dead.
    spring(this.springs.yaw, yawTarget, 240, 17, dt);
    spring(this.springs.pitch, pitchTarget, 240, 17, dt);
    spring(this.springs.roll, rollTarget, 210, 16, dt);

    const yaw = lerp(yawTarget, this.springs.yaw.value, overshoot);
    const pitch = lerp(pitchTarget, this.springs.pitch.value, overshoot);
    const roll = lerp(rollTarget, this.springs.roll.value, overshoot);

    gl.uniform1f(L.u_yaw, yaw);
    gl.uniform1f(L.u_pitch, pitch);
    gl.uniform1f(L.u_roll, roll);
    gl.uniform1f(L.u_parallax, 0.032 * store.get('warp.parallax'));

    // --- body -------------------------------------------------------------
    gl.uniform2f(L.u_bodyOffset,
      head.x * 0.045 + rig.body.leanX * 0.02,
      -head.y * 0.04 + rig.body.bounce * 0.004);
    gl.uniform1f(L.u_bodyRot, rig.body.twist * 0.16);
    gl.uniform1f(L.u_breath, rig.body.breath * 0.012);
    gl.uniform1f(L.u_lowerDamping, clamp(store.get('warp.lowerDamping'), 0, 1));

    // --- cloth and tufts --------------------------------------------------
    // Track a point on the front of the head; its acceleration is what throws
    // the scarf around.
    const proxyX = m.headX + Math.sin(yaw) * 0.09 + head.x * 0.045;
    const proxyY = m.headY - Math.sin(pitch) * 0.06 - head.y * 0.04 + roll * 0.02;
    this.inertia.update(proxyX, proxyY, dt);

    const clothStiff = clamp(store.get('warp.clothStiffness'), 0.1, 4);
    const tuftStiff = clamp(store.get('warp.tuftStiffness'), 0.1, 4);
    this.cloth.configure({ rest: 26 * clothStiff, damping: 4.4 * Math.sqrt(clothStiff) });
    this.tuft.configure({ rest: 120 * tuftStiff, damping: 9.5 * Math.sqrt(tuftStiff) });

    // Scale note: the chain solves in UV, and its steady state is force/rest.
    // A scarf tip should travel a few percent of the image, so with rest ~26 the
    // forces want to be order 1 — not order 60, which is a tear.
    const wind = 0.11 * store.get('warp.wind');
    // Inertia opposes the motion, hence the negation.
    // Scale note: the chain settles at force/rest, so with rest ~26 a tip that
    // should travel a few percent of the image wants forces below one. The
    // earlier gain produced ~5 and railed the chain against its own limit.
    const fx = clamp(-this.inertia.ax, -12, 12) * 0.16;
    const fy = clamp(-this.inertia.ay, -12, 12) * 0.16;

    gl.uniform2fv(L.u_cloth, this.cloth.step(fx, fy, wind, dt));
    gl.uniform2fv(L.u_tuft, this.tuft.step(fx * 0.7, fy * 0.7, wind * 0.4, dt));
    gl.uniform1f(L.u_clothWeight, store.get('warp.clothWeight'));
    gl.uniform1f(L.u_tuftWeight, store.get('warp.tuftWeight'));

    // --- eyes -------------------------------------------------------------
    // The shader wants centre + half-size, and re-rotates by the eye angle.
    gl.uniform4f(L.u_eyeL,
      (m.eyeL[0] + m.eyeL[2]) / 2, (m.eyeL[1] + m.eyeL[3]) / 2,
      Math.abs(m.eyeL[2] - m.eyeL[0]) / 2, Math.abs(m.eyeL[3] - m.eyeL[1]) / 2);
    gl.uniform4f(L.u_eyeR,
      (m.eyeR[0] + m.eyeR[2]) / 2, (m.eyeR[1] + m.eyeR[3]) / 2,
      Math.abs(m.eyeR[2] - m.eyeR[0]) / 2, Math.abs(m.eyeR[3] - m.eyeR[1]) / 2);
    gl.uniform1f(L.u_eyeAngle, m.eyeAngle);
    const lids = this.lids ?? { left: [0.35, 0.38, 0.45], right: [0.35, 0.38, 0.45] };
    gl.uniform3fv(L.u_lidL, lids.left);
    gl.uniform3fv(L.u_lidR, lids.right);
    gl.uniform2f(L.u_blink, rig.eyes.blinkL, rig.eyes.blinkR);
    const squintGain = store.get('warp.squint');
    gl.uniform2f(L.u_squint,
      clamp(rig.eyes.squintL * squintGain, 0, 1),
      clamp(rig.eyes.squintR * squintGain, 0, 1));
    gl.uniform2f(L.u_gaze, rig.eyes.gazeX, -rig.eyes.gazeY);
    gl.uniform1f(L.u_eyesEnabled, store.get('warp.eyesEnabled') ? 1 : 0);

    // Slow idle breath on the glow, flaring when the head moves sharply.
    const flare = clamp(this.inertia.speed * 1.6, 0, 1.4);
    const idle = 0.82 + 0.18 * Math.sin(this.clock * 1.9);
    this.glowPulse = damp(this.glowPulse, idle + flare, 9, dt);
    gl.uniform1f(L.u_glow, store.get('warp.eyeGlow'));
    gl.uniform1f(L.u_glowPulse, this.glowPulse);

    gl.uniform1f(L.u_keyWhite, store.get('warp.keyWhite'));

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(L.u_tex, 0);

    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  dispose() {
    this.unsubscribe?.();
    this.canvas.remove();
  }
}

/** Bilinear sample of a mask laid out as a w x h Float32Array. */
function sample(mask, w, h, u, v) {
  if (!mask) return 0;
  const x = clamp(u * (w - 1), 0, w - 1);
  const y = clamp(v * (h - 1), 0, h - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = mask[y0 * w + x0] * (1 - fx) + mask[y0 * w + x1] * fx;
  const b = mask[y1 * w + x0] * (1 - fx) + mask[y1 * w + x1] * fx;
  return a * (1 - fy) + b * fy;
}

const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

function bindAttribute(gl, buffer, location, data, size) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
}

function linkProgram(gl, vertexSource, fragmentSource) {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader));
      return null;
    }
    return shader;
  };

  const vs = compile(gl.VERTEX_SHADER, vertexSource);
  const fs = compile(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vs || !fs) return null;

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(program));
    return null;
  }
  return program;
}
