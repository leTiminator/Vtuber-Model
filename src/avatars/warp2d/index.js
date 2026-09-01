/**
 * Drives a single flat image with the tracking rig, by laying a deformation
 * mesh over it and bending the mesh — the same idea Live2D is built on.
 *
 * The point of this backend is that it needs no layer separation and no
 * redrawing: you hand it the artwork you already have and mark where the head
 * and eyes are, and it turns, nods, tilts, breathes and blinks.
 */
import { clamp } from '../../core/math.js';
import * as store from '../../core/store.js';
import { FRAGMENT_SHADER, VERTEX_SHADER } from './shader.js';

const UNIFORMS = [
  'u_headCenter', 'u_pivot', 'u_yawScaleX', 'u_yawShift', 'u_pitchScaleY',
  'u_pitchShift', 'u_roll', 'u_bodyOffset', 'u_bodyRot', 'u_breath', 'u_time',
  'u_waveAmp', 'u_waveFreq', 'u_waveSpeed', 'u_aspect', 'u_viewScale',
  'u_viewOffset', 'u_tex', 'u_eyeL', 'u_eyeR', 'u_blinkL', 'u_blinkR',
  'u_gaze', 'u_eyesEnabled', 'u_keyWhite',
];

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
    this.clock = 0;
    this.ready = false;
    this.error = null;
    this.onStatus = () => {};

    this.unsubscribe = store.subscribe((key) => {
      if (key.startsWith('warp.')) this.meshDirty = true;
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
      head: gl.getAttribLocation(program, 'a_head'),
      loose: gl.getAttribLocation(program, 'a_loose'),
    };

    this.vao = gl.createVertexArray();
    this.buffers = {
      uv: gl.createBuffer(),
      head: gl.createBuffer(),
      loose: gl.createBuffer(),
      index: gl.createBuffer(),
    };

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    this.meshDirty = true;
    this.uploadTexture();
  }

  /**
   * Artwork can arrive before this backend has ever been mounted, so the
   * upload waits until there is a context to upload into.
   * @param {HTMLImageElement} image
   */
  setImage(image) {
    this.image = image;
    this.aspect = image.naturalWidth / image.naturalHeight;
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
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.ready = true;
    this.meshDirty = true;
  }

  /**
   * Rebuild the grid and its weights. Head weight falls off smoothly outside
   * the marked circle so the neck bends rather than shearing; loose weight
   * rises outside the body's core, which is what makes scarf tails ripple
   * without the torso wobbling.
   */
  buildMesh() {
    const gl = this.gl;
    if (!gl) return;

    const n = clamp(Math.round(store.get('warp.mesh')), 8, 64);
    const headX = store.get('warp.headX');
    const headY = store.get('warp.headY');
    const headR = Math.max(0.02, store.get('warp.headR'));
    const pivotX = store.get('warp.pivotX');
    const pivotY = store.get('warp.pivotY');
    const aspect = this.aspect ?? 1;

    const uv = [];
    const head = [];
    const loose = [];

    for (let row = 0; row <= n; row++) {
      for (let col = 0; col <= n; col++) {
        const u = col / n;
        const v = row / n;
        uv.push(u, v);

        const dx = (u - headX) * aspect;
        const dy = v - headY;
        const d = Math.hypot(dx, dy) / headR;
        head.push(1 - smoothstep(0.78, 1.45, d));

        // Distance outside an ellipse standing in for the torso.
        const bx = ((u - pivotX) * aspect) / (headR * 1.9);
        const by = (v - (pivotY + headR * 1.1)) / (headR * 2.6);
        const core = Math.hypot(bx, by);
        loose.push(smoothstep(1.0, 1.75, core) * (1 - smoothstep(0.78, 1.45, d)));
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
    bindFloatAttribute(gl, this.buffers.uv, this.attr.uv, new Float32Array(uv), 2);
    bindFloatAttribute(gl, this.buffers.head, this.attr.head, new Float32Array(head), 1);
    bindFloatAttribute(gl, this.buffers.loose, this.attr.loose, new Float32Array(loose), 1);
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
  }

  render(rig, dt) {
    const gl = this.gl;
    if (!gl || !this.width) return;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.ready) return;

    this.clock += dt;
    if (this.meshDirty) this.buildMesh();

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    const L = this.loc;
    const head = rig.head;

    // Fit the artwork into the canvas, then apply the user's framing.
    const zoom = store.get('stage.zoom');
    const imgAspect = this.aspect;
    const canvasAspect = this.canvas.width / this.canvas.height;
    let sx = zoom;
    let sy = zoom;
    if (imgAspect > canvasAspect) sy = (zoom * canvasAspect) / imgAspect;
    else sx = (zoom * imgAspect) / canvasAspect;
    const ox = (1 - sx) / 2 + (store.get('stage.offsetX') * (window.devicePixelRatio || 1)) / this.canvas.width;
    const oy = (1 - sy) / 2 + (store.get('stage.offsetY') * (window.devicePixelRatio || 1)) / this.canvas.height;

    gl.uniform2f(L.u_viewScale, sx, sy);
    gl.uniform2f(L.u_viewOffset, ox, oy);
    gl.uniform1f(L.u_aspect, imgAspect);

    gl.uniform2f(L.u_headCenter, store.get('warp.headX'), store.get('warp.headY'));
    gl.uniform2f(L.u_pivot, store.get('warp.pivotX'), store.get('warp.pivotY'));

    const turn = store.get('warp.turn');
    const nod = store.get('warp.nod');
    const sinYaw = Math.sin(head.yaw);
    const sinPitch = Math.sin(head.pitch);

    // Turning compresses the face horizontally and slides it; nodding does the
    // same vertically. Together they read as a head rotating in depth.
    gl.uniform1f(L.u_yawScaleX, 1 - Math.abs(sinYaw) * 0.3 * turn);
    gl.uniform1f(L.u_yawShift, sinYaw * 0.085 * turn);
    gl.uniform1f(L.u_pitchScaleY, 1 - Math.abs(sinPitch) * 0.2 * nod);
    gl.uniform1f(L.u_pitchShift, -sinPitch * 0.055 * nod);
    gl.uniform1f(L.u_roll, head.roll);

    gl.uniform2f(L.u_bodyOffset,
      head.x * 0.045 + rig.body.leanX * 0.02,
      -head.y * 0.04 + rig.body.bounce * 0.004);
    gl.uniform1f(L.u_bodyRot, rig.body.twist * 0.16);
    gl.uniform1f(L.u_breath, rig.body.breath * 0.012);

    const wave = store.get('warp.wave');
    gl.uniform1f(L.u_time, this.clock);
    gl.uniform1f(L.u_waveAmp, 0.006 * wave);
    gl.uniform1f(L.u_waveFreq, 12);
    gl.uniform1f(L.u_waveSpeed, 2.0);

    gl.uniform4fv(L.u_eyeL, parseRect(store.get('warp.eyeL')));
    gl.uniform4fv(L.u_eyeR, parseRect(store.get('warp.eyeR')));
    gl.uniform1f(L.u_blinkL, rig.eyes.blinkL);
    gl.uniform1f(L.u_blinkR, rig.eyes.blinkR);
    gl.uniform2f(L.u_gaze, rig.eyes.gazeX, -rig.eyes.gazeY);
    gl.uniform1f(L.u_eyesEnabled, store.get('warp.eyesEnabled') ? 1 : 0);
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

const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

function bindFloatAttribute(gl, buffer, location, data, size) {
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
