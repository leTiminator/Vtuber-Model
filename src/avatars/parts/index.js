/**
 * The layered puppet: the artwork cut into parts, each moving on its own.
 *
 * The warp backend bent one continuous sheet, which could never tear a hole but
 * also meant nothing moved independently — the head and arms inherited the
 * scarf's motion because they shared its sheet. Here each part is its own
 * texture with its own transform, hung off a joint hierarchy so a child follows
 * its parent. The head cannot drift off the neck, because the neck carries it.
 *
 * Parts keep image-space coordinates, so at rest the stack reassembles exactly
 * as the artist drew it. Any drift there means a transform is wrong, which is
 * why the reassembly diff is the regression guard for this file.
 */
import { clamp, damp, lerp, makeSpring, spring } from '../../core/math.js';
import * as store from '../../core/store.js';
import { FRAGMENT_SHADER, VERTEX_SHADER } from './shader.js';
import { cutParts } from './cut.js';
import { ChainField, HeadInertia } from '../warp2d/cloth.js';
import { detectMarkers, readPixels, sampleLidColours } from '../warp2d/segment.js';
import { parseRect } from '../warp2d/index.js';

const UNIFORMS = [
  'u_model', 'u_aspect', 'u_warp', 'u_headCenter', 'u_cylR', 'u_yaw', 'u_pitch',
  'u_viewScale', 'u_viewOffset', 'u_tex', 'u_opacity',
  'u_eyesEnabled', 'u_eyeL', 'u_eyeR', 'u_eyeAngle', 'u_lidL', 'u_lidR',
  'u_blink', 'u_squint', 'u_glow', 'u_glowPulse',
];

const HEAD_GRID = 12; // the head bends, so it needs more than a quad

export class Parts2D {
  static id = 'parts2d';
  static label = 'My artwork (cut into parts)';

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'avatar-canvas';
    this.gl = null;
    this.image = null;
    this.parts = [];
    this.ready = false;
    this.clock = 0;
    this.onStatus = () => {};

    this.scarf = new ChainField({ nodes: 16, chain: 240, rest: 26, damping: 4.4, tipBias: 2.2 });
    this.inertia = new HeadInertia();
    this.springs = { yaw: makeSpring(), pitch: makeSpring(), roll: makeSpring() };
    this.glowPulse = 1;

    this.unsubscribe = store.subscribe((key) => {
      if (key.startsWith('warp.')) this.rebuild = true;
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
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      this.onStatus('This browser has no WebGL2, which this mode needs.');
      return;
    }
    this.gl = gl;

    const program = linkProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    if (!program) {
      this.onStatus('Could not compile the puppet shaders.');
      return;
    }
    this.program = program;
    gl.useProgram(program);
    this.loc = {};
    for (const name of UNIFORMS) this.loc[name] = gl.getUniformLocation(program, name);
    this.attr = {
      pos: gl.getAttribLocation(program, 'a_pos'),
      uv: gl.getAttribLocation(program, 'a_uv'),
    };

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    if (this.image) this.build();
  }

  setImage(image, placeMarkers = false) {
    this.image = image;
    this.aspect = image.naturalWidth / image.naturalHeight;

    if (placeMarkers) {
      const px = readPixels(image);
      const found = px && detectMarkers(px);
      if (found) {
        store.patch({
          'warp.headX': found.headX, 'warp.headY': found.headY, 'warp.headR': found.headR,
          'warp.pivotX': found.pivotX, 'warp.pivotY': found.pivotY, 'warp.waistY': found.waistY,
          'warp.eyeAngle': found.eyeAngle,
          'warp.eyeL': JSON.stringify(found.eyeL), 'warp.eyeR': JSON.stringify(found.eyeR),
        });
      }
    }
    this.scarf.reset();
    this.build();
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

  /** Cut the artwork and upload each piece as its own textured mesh. */
  build() {
    const gl = this.gl;
    if (!gl || !this.image) return;

    const m = this.markers();
    const { parts, width, height } = cutParts(this.image, m);
    this.imageSize = { width, height };

    for (const old of this.parts) {
      gl.deleteTexture(old.texture);
      gl.deleteVertexArray(old.vao);
    }

    const px = readPixels(this.image);
    this.lids = px ? sampleLidColours(px, m, m.eyeAngle) : null;

    this.parts = parts
      .sort((a, b) => a.z - b.z)
      .map((part) => this.upload(part, width, height, m));

    this.ready = this.parts.length > 0;
    this.rebuild = false;
  }

  upload(part, width, height, m) {
    const gl = this.gl;

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, part.canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // The head bends, so it gets a grid; everything else is a quad for now.
    const n = part.name === 'head' ? HEAD_GRID : 1;
    const pos = [];
    const uv = [];
    const idx = [];
    for (let row = 0; row <= n; row++) {
      for (let col = 0; col <= n; col++) {
        const s = col / n;
        const t = row / n;
        // Image space: where this pixel actually sits in the whole artwork.
        pos.push((part.x + s * part.w) / width, (part.y + t * part.h) / height);
        uv.push(s, t);
      }
    }
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const a = row * (n + 1) + col;
        idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
      }
    }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    bind(gl, this.attr.pos, new Float32Array(pos), 2);
    bind(gl, this.attr.uv, new Float32Array(uv), 2);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    // Eye sockets, converted from image UV into this part's texture space.
    const socket = (rect) => [
      (((rect[0] + rect[2]) / 2) * width - part.x) / part.w,
      (((rect[1] + rect[3]) / 2) * height - part.y) / part.h,
      (Math.abs(rect[2] - rect[0]) / 2) * width / part.w,
      (Math.abs(rect[3] - rect[1]) / 2) * height / part.h,
    ];

    return {
      ...part,
      texture, vao, indexCount: idx.length,
      eyeL: socket(m.eyeL),
      eyeR: socket(m.eyeR),
    };
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
    if (this.rebuild) this.build();

    dt = clamp(dt, 1 / 240, 1 / 15);
    this.clock += dt;

    const L = this.loc;
    const m = this.markers();
    gl.useProgram(this.program);

    // --- framing ---------------------------------------------------------
    const zoom = store.get('stage.zoom');
    const canvasAspect = this.canvas.width / this.canvas.height;
    let sx = zoom;
    let sy = zoom;
    if (this.aspect > canvasAspect) sy = (zoom * canvasAspect) / this.aspect;
    else sx = (zoom * this.aspect) / canvasAspect;
    gl.uniform2f(L.u_viewScale, sx, sy);
    gl.uniform2f(L.u_viewOffset,
      (1 - sx) / 2 + (store.get('stage.offsetX') * this.dpr) / this.canvas.width,
      (1 - sy) / 2 + (store.get('stage.offsetY') * this.dpr) / this.canvas.height);
    gl.uniform1f(L.u_aspect, this.aspect);

    // --- head angles, with overshoot -------------------------------------
    const overshoot = store.get('warp.overshoot');
    const yawTarget = rig.head.yaw * store.get('warp.turn');
    const pitchTarget = rig.head.pitch * store.get('warp.nod');
    spring(this.springs.yaw, yawTarget, 240, 17, dt);
    spring(this.springs.pitch, pitchTarget, 240, 17, dt);
    spring(this.springs.roll, rig.head.roll, 210, 16, dt);
    const yaw = lerp(yawTarget, this.springs.yaw.value, overshoot);
    const pitch = lerp(pitchTarget, this.springs.pitch.value, overshoot);
    const roll = lerp(rig.head.roll, this.springs.roll.value, overshoot);

    // --- joints ----------------------------------------------------------
    const joints = this.solveJoints(rig, roll, m);

    // --- cloth -----------------------------------------------------------
    const proxyX = m.headX + Math.sin(yaw) * 0.09 + rig.head.x * 0.045;
    const proxyY = m.headY - Math.sin(pitch) * 0.06 - rig.head.y * 0.04 + roll * 0.02;
    this.inertia.update(proxyX, proxyY, dt);
    const stiff = clamp(store.get('warp.clothStiffness'), 0.1, 4);
    this.scarf.configure({ rest: 26 * stiff, damping: 4.4 * Math.sqrt(stiff) });
    const fx = clamp(-this.inertia.ax, -25, 25) * 0.22;
    const fy = clamp(-this.inertia.ay, -25, 25) * 0.22;
    const swing = this.scarf.step(fx, fy, 0.11 * store.get('warp.wind'), dt);
    // Until the bone chain lands, the tails ride their chain's tip as a whole.
    const tailShift = [swing[30] * store.get('warp.clothWeight'), swing[31] * store.get('warp.clothWeight')];

    const flare = clamp(this.inertia.speed * 1.6, 0, 1.4);
    this.glowPulse = damp(this.glowPulse, 0.82 + 0.18 * Math.sin(this.clock * 1.9) + flare, 9, dt);

    // --- draw, back to front ---------------------------------------------
    for (const part of this.parts) {
      const model = joints[part.joint] ?? IDENTITY;
      const shifted = part.name === 'tails'
        ? translate(model, tailShift[0], tailShift[1])
        : model;
      gl.uniformMatrix3fv(L.u_model, false, shifted);

      const isHead = part.name === 'head';
      gl.uniform1f(L.u_warp, isHead ? 1 : 0);
      if (isHead) {
        gl.uniform2f(L.u_headCenter, m.headX, m.headY);
        gl.uniform1f(L.u_cylR, m.headR * 1.85);
        gl.uniform1f(L.u_yaw, yaw);
        gl.uniform1f(L.u_pitch, pitch);
      }

      const carriesEyes = part.name === 'eyes';
      gl.uniform1f(L.u_eyesEnabled, carriesEyes && store.get('warp.eyesEnabled') ? 1 : 0);
      if (carriesEyes) {
        gl.uniform4fv(L.u_eyeL, part.eyeL);
        gl.uniform4fv(L.u_eyeR, part.eyeR);
        gl.uniform1f(L.u_eyeAngle, m.eyeAngle);
        const lids = this.lids ?? { left: [0.35, 0.38, 0.45], right: [0.35, 0.38, 0.45] };
        gl.uniform3fv(L.u_lidL, lids.left);
        gl.uniform3fv(L.u_lidR, lids.right);
        gl.uniform2f(L.u_blink, rig.eyes.blinkL, rig.eyes.blinkR);
        const sq = store.get('warp.squint');
        gl.uniform2f(L.u_squint, clamp(rig.eyes.squintL * sq, 0, 1), clamp(rig.eyes.squintR * sq, 0, 1));
        gl.uniform1f(L.u_glow, store.get('warp.eyeGlow'));
        gl.uniform1f(L.u_glowPulse, this.glowPulse);
      }

      gl.uniform1f(L.u_opacity, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, part.texture);
      gl.uniform1i(L.u_tex, 0);

      gl.bindVertexArray(part.vao);
      gl.drawElements(gl.TRIANGLES, part.indexCount, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
  }

  /**
   * One transform per joint, each built on its parent's.
   *
   * Building children from parents is what stops the head sliding off the neck
   * when the body leans — the failure that makes a cheap layered rig look
   * broken.
   */
  solveJoints(rig, roll, m) {
    const lean = rig.head.x * 0.045 + rig.body.leanX * 0.02;
    const rise = -rig.head.y * 0.04 + rig.body.bounce * 0.004;
    const breath = rig.body.breath * 0.012;

    const hips = compose(
      translate(IDENTITY, lean, rise),
      rotateAbout(rig.body.twist * 0.16, m.pivotX, 1.25, this.aspect),
      scaleAbout(1, 1 + breath, m.pivotX, m.pivotY),
    );
    const neck = compose(hips, rotateAbout(roll, m.pivotX, m.pivotY, this.aspect));

    return { root: IDENTITY, hips, torso: hips, neck, head: neck, eyes: neck };
  }

  dispose() {
    this.unsubscribe?.();
    this.canvas.remove();
  }
}

/* ------------------------------------------------------------- transforms */
// Column-major 3x3, matching WebGL's uniformMatrix3fv layout.

const IDENTITY = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

function multiply(a, b) {
  const o = new Float32Array(9);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      o[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2];
    }
  }
  return o;
}

const compose = (...ms) => ms.reduce(multiply);

function translate(m, tx, ty) {
  return multiply(m, new Float32Array([1, 0, 0, 0, 1, 0, tx, ty, 1]));
}

/** Rotate about a point, correcting for a non-square image so it stays circular. */
function rotateAbout(angle, cx, cy, aspect) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const a = aspect || 1;
  // Work in square space: scale x by aspect, rotate, scale back.
  const m = new Float32Array([
    c, s / a, 0,
    -s * a, c, 0,
    cx - c * cx + s * a * cy, cy - (s / a) * cx - c * cy, 1,
  ]);
  return m;
}

function scaleAbout(sx, sy, cx, cy) {
  return new Float32Array([sx, 0, 0, 0, sy, 0, cx - sx * cx, cy - sy * cy, 1]);
}

/* ------------------------------------------------------------------ setup */

function bind(gl, location, data, size) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
}

function linkProgram(gl, vertexSource, fragmentSource) {
  const compile = (type, source) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
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
