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
import { computeFrame } from '../../core/framing.js';
import { FRAGMENT_SHADER, VERTEX_SHADER } from './shader.js';
import { cutParts } from './cut.js';

/**
 * The parts that take the head's cylindrical bend. They have to share one
 * radius — see the note where it is computed.
 *
 * The eyes belong here for the plainest reason there is: they are painted on
 * the visor. Left out, they stayed pinned to where the artist drew them while
 * the shell turned out from under them, so by forty degrees one shard was
 * hanging off the chin and the other was in open space beside the glove. They
 * are not a separate object from the face; they are the face.
 */
const BENDS_WITH_HEAD = new Set(['head', 'tufts', 'wrap', 'tails', 'eyes', 'armLeft', 'armRight']);

/**
 * Where the head's turn stops being the head's, as multiples of the head's own
 * radius. Full inside the first, none beyond the second, smooth between.
 *
 * The hood and the hair are the head and take all of it. The scarf crosses the
 * face and then leaves for the shoulders, so it starts as head and stops being
 * head — which is a gradient, not a property of which piece it was cut into.
 */
const FOLLOW_FULL = 1.05;
const FOLLOW_NONE = 2.30;

/**
 * Parts that cast a contact shadow on what is behind them. The backmost part
 * has nothing to cast onto, and the eyes sit flush in the visor rather than
 * over it.
 */
const SHADOWS = new Set(['body', 'armLeft', 'armRight', 'tufts', 'head', 'wrap']);

/** Which way the light comes from, in texels of the casting part. */
const SHADOW_DIR = [-3.5, -3.5];
import { ChainField, HeadInertia } from '../warp2d/cloth.js';
import { detectMarkers, readPixels, sampleLidColours } from '../warp2d/segment.js';
import { parseRect } from '../warp2d/index.js';
import { extractSpine } from './spine.js';
import { depthAt, shellFrom } from './shell.js';

const UNIFORMS = [
  'u_model', 'u_modelFar', 'u_aspect', 'u_warp', 'u_headCenter', 'u_cylR', 'u_yaw', 'u_pitch',
  'u_viewScale', 'u_viewOffset', 'u_tex', 'u_opacity',
  'u_eyesEnabled', 'u_eyeL', 'u_eyeR', 'u_eyeAngle',
  'u_blink', 'u_squint', 'u_wide', 'u_gaze', 'u_glow', 'u_glowPulse', 'u_texel',
  'u_shadow', 'u_shadowOffset',
  'u_flipU',
  'u_shell', 'u_depth',
];

const SPINE_NODES = 16;
const CLOTH_GRID = 26; // the cloth bends along its whole length, so it needs rows

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

    // tipBias is what makes it read as a chain rather than a flag: the base is
    // pinned at the neck and each node further out carries more of the motion,
    // so the wave arrives late at the tip and keeps going after the head has
    // stopped. Damping is low enough to let it swing back once.
    this.scarf = new ChainField({ nodes: 16, chain: 240, rest: 26, damping: 2.2, tipBias: 4.2 });
    this.inertia = new HeadInertia();
    // Hair lag: a single damped spring per axis, driven by the head's own
    // acceleration. The spikes are short and stiff, so they want a much
    // faster, tighter response than the scarf — a chain here would read as
    // seaweed.
    this.tuft = { x: 0, y: 0, vx: 0, vy: 0 };
    this.springs = { yaw: makeSpring(), pitch: makeSpring(), roll: makeSpring() };
    this.glowPulse = 1;
    this.bones = new Float32Array(SPINE_NODES * 2);

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
      follow: gl.getAttribLocation(program, 'a_follow'),
      depth: gl.getAttribLocation(program, 'a_depth'),
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
    const { parts, width, height, sockets } = cutParts(this.image, m);
    this.imageSize = { width, height };

    /* Free what this renderer built, not whatever is currently being drawn.
     *
     * `parts` is a plain field, and a caller that swaps it to draw a subset —
     * the test suite does, to look at one piece at a time — would otherwise
     * have the rebuild free only that subset and orphan the rest, leaving the
     * caller holding freed textures it then puts back.
     */
    for (const old of this.owned ?? this.parts) {
      gl.deleteTexture(old.texture);
      gl.deleteVertexArray(old.vao);
    }

    const px = readPixels(this.image);
    this.lids = px ? sampleLidColours(px, m, m.eyeAngle) : null;

    const tails = parts.find((p) => p.name === 'tails');
    this.spine = tails ? findSpine(tails, this.image, width, height, m) : null;

    /* The head's real extent, measured from the piece that was cut, not from
     * the marker. The marker's radius comes from eye spacing, which on this
     * drawing is less than half the hood — every distance judged against it
     * would be wrong by the same factor.
     */
    const headPart = parts.find((p) => p.name === 'head');
    this.headSpan = headPart ? {
      cx: (headPart.x + headPart.inset + (headPart.w - 2 * headPart.inset) / 2) / width,
      cy: (headPart.y + headPart.inset + (headPart.h - 2 * headPart.inset) / 2) / height,
      r: Math.max(headPart.w - 2 * headPart.inset, headPart.h - 2 * headPart.inset) / 2 / height,
    } : { cx: m.headX, cy: m.headY, r: m.headR };

    /* The shell, before anything is uploaded, because every part reads its
     * depth from it. One field for the whole model, taken from the head's
     * outline — see shell.js for why it is not one dome per piece.
     */
    this.shell = headPart ? shellFrom(headPart, width, height) : null;

    this.parts = parts
      .sort((a, b) => a.z - b.z)
      .map((part) => this.upload(part, width, height, m, sockets));

    /* One cylinder radius for the whole head, not one per part.
     *
     * The bend maps x to R*(sin(asin(x/R) + yaw) - sin(yaw)), which depends on
     * R. Give the hood, the hair and the neck wrap their own radius — each
     * sized to its own reach — and they agree only at yaw 0. Past that they
     * rotate at different rates and slide apart: the wrap climbs over the
     * visor and the scarf tears away from the shoulders, worse the further you
     * turn. Radius is a property of the head being turned, not of the piece
     * being drawn.
     *
     * The largest keeps everything inside the cylinder, which is what the
     * per-part sizing was for — anything reaching beyond R gets clamped and
     * distorts.
     */
    let headCylR = 0;
    for (const part of this.parts) {
      if (BENDS_WITH_HEAD.has(part.name)) headCylR = Math.max(headCylR, part.cylR);
    }
    this.headCylR = headCylR || 1;

    this.owned = this.parts;
    this.ready = this.parts.length > 0;
    this.rebuild = false;
  }

  /**
   * How much of the head's turn a point takes.
   *
   * The shell is the head and takes all of it. Cloth starts as head where it
   * crosses the face and stops being head as it reaches the shoulders. Because
   * both sides of a cut ask this same question about the same point, they
   * agree at the seam no matter where the cut fell.
   */
  followAt(name, px, py) {
    if (name === 'head' || name === 'tufts' || name === 'eyes') return 1;
    if (name === 'body') return 0;
    const h = this.headSpan;
    const d = Math.hypot((px - h.cx) * this.aspect, py - h.cy) / Math.max(h.r, 1e-4);
    const t = clamp((d - FOLLOW_FULL) / (FOLLOW_NONE - FOLLOW_FULL), 0, 1);
    return 1 - t * t * (3 - 2 * t); // smoothstep, so there is no crease
  }

  upload(part, width, height, m, sockets) {
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

    // The head bends and the cloth bends along its whole length, so both need
    // a grid; everything else is a quad.
    const skinned = part.name === 'tails' && this.spine;
    /* Anything that bends needs rows to bend along.
     *
     * Only the head had them. The neck wrap and the hair took the same
     * cylindrical bend across a single quad — four corners, linearly
     * interpolated — which cannot follow a curve. Against the head's twelve
     * rows the two disagreed by more the further the head turned, and that
     * disagreement is at the seam where the scarf meets the hood.
     */
    const n = skinned ? CLOTH_GRID : BENDS_WITH_HEAD.has(part.name) ? HEAD_GRID : 1;
    const pos = [];
    const uv = [];
    const bindData = [];
    const followData = [];
    const depthData = [];
    const idx = [];
    for (let row = 0; row <= n; row++) {
      for (let col = 0; col <= n; col++) {
        const s = col / n;
        const t = row / n;
        // Image space: where this pixel actually sits in the whole artwork.
        const px = (part.x + s * part.w) / width;
        const py = (part.y + t * part.h) / height;
        pos.push(px, py);
        uv.push(s, t);
        followData.push(this.followAt(part.name, px, py));
        depthData.push(depthAt(this.shell, px, py));
        // Bind into the centreline's local frame at the nearest point.
        bindData.push(...(skinned ? bindToSpine(px, py, this.spine.nodes, this.aspect) : [0, 0, 0]));
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
    const posBuffer = bind(gl, this.attr.pos, new Float32Array(pos), 2,
      skinned ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    bind(gl, this.attr.uv, new Float32Array(uv), 2);
    bind(gl, this.attr.follow, new Float32Array(followData), 1);
    bind(gl, this.attr.depth, new Float32Array(depthData), 1);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    // The cylinder clamps anything beyond its radius, which silently distorts
    // a part that reaches further out than the head does. Size the radius to
    // whatever this part actually spans, never smaller than the head's own.
    let reachX = 0;
    let reachY = 0;
    // Measured from the same centre everything turns about, or the radius
    // describes a circle around a different point than the one being used.
    for (let k = 0; k < pos.length; k += 2) {
      reachX = Math.max(reachX, Math.abs((pos[k] - this.headSpan.cx) * this.aspect));
      reachY = Math.max(reachY, Math.abs(pos[k + 1] - this.headSpan.cy));
    }
    const cylR = Math.max(this.headSpan.r * 1.85, reachX / 0.98, reachY / 0.803);

    /* Eye sockets, in this part's texture space.
     *
     * Prefer the extent measured from the pixels that were actually cut out.
     * The marker rectangle is only a hint about where to look for the shard,
     * and anything the shard reaches past it stays uncovered at full blink —
     * a permanent sliver of open eye. Fall back to the marker when the cut
     * could not find two shards.
     */
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

    return {
      ...part,
      texture, vao, indexCount: idx.length, skinned, cylR,
      // Skinning happens on the CPU — see skinCloth. The bind stays here
      // because that is where it is now used.
      posBuffer,
      binds: skinned ? new Float32Array(bindData) : null,
      live: skinned ? new Float32Array(pos) : null,
      eyeL: sockets?.[0] ? fromBox(sockets[0]) : fromMarker(m.eyeL),
      eyeR: sockets?.[1] ? fromBox(sockets[1]) : fromMarker(m.eyeR),
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
    const frame = computeFrame(this.aspect, this.canvas.width, this.canvas.height,
      store.get('stage.zoom'), store.get('stage.offsetX'), store.get('stage.offsetY'));
    gl.uniform2f(L.u_viewScale, frame.sx, frame.sy);
    gl.uniform2f(L.u_viewOffset, frame.ox, frame.oy);
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
    const joints = this.solveJoints(rig, roll, pitch, m);

    // --- cloth -----------------------------------------------------------
    const proxyX = m.headX + Math.sin(yaw) * 0.09 + rig.head.x * 0.045;
    const proxyY = m.headY - Math.sin(pitch) * 0.06 - rig.head.y * 0.04 + roll * 0.02;
    this.inertia.update(proxyX, proxyY, dt);
    const stiff = clamp(store.get('warp.clothStiffness'), 0.1, 4);
    this.scarf.configure({ rest: 26 * stiff, damping: 4.4 * Math.sqrt(stiff) });
    // Scale note: the chain settles at force/rest, so with rest ~26 a tip that
    // should travel a few percent of the image wants forces below one. The
    // earlier gain produced ~5 and railed the chain against its own limit.
    // Scale note: the chain settles at force*weight/rest, and weight now
    // reaches 4.2 at the tip, so the per-node force has to come down to keep
    // the tip inside its limit instead of railing against it.
    /* "Scarf travel" drives the chain; it does not scale what comes out of it.
     *
     * The chain's two limits — how far a node may leave the drawn pose, and
     * how much neighbouring nodes may differ — are the whole reason the ribbon
     * stays a ribbon, because the art is skinned between those nodes. This
     * setting used to multiply the chain's output, which multiplied straight
     * past both: at the slider's top the tip could leave by half the width of
     * the artwork, and the scarf came off the neck and floated away on its own.
     * Idle wind is enough to drive that, so it happened sitting still with the
     * camera off — which is exactly how it was reported.
     *
     * Scaling the force instead lands in the same place while the chain is in
     * its linear range (it settles at force/rest either way, so 1x is
     * unchanged), and past that the limits hold, so the scarf can be made to
     * move a lot without being made to come apart.
     */
    const weight = clamp(store.get('warp.clothWeight'), 0, 3);
    const fx = clamp(-this.inertia.ax, -12, 12) * 0.70 * weight;
    const fy = clamp(-this.inertia.ay, -12, 12) * 0.70 * weight;
    const swing = this.scarf.step(fx, fy, 0.11 * store.get('warp.wind') * weight, dt);

    // Displace each bone by its own node in the chain. The chain's later nodes
    // move further, so the ribbon lags along its length and folds rather than
    // sliding as one piece — the whole reason for the skeleton.
    if (this.spine) {
      for (let i = 0; i < SPINE_NODES; i++) {
        this.bones[i * 2] = this.spine.nodes[i][0] + swing[i * 2];
        this.bones[i * 2 + 1] = this.spine.nodes[i][1] + swing[i * 2 + 1];
      }
      this.skinCloth();
    }

    /* Hair lag.
     *
     * The tufts took the head's bend and nothing else, so they were welded to
     * the shell — the one thing hair never is. They now trail the head's
     * acceleration and swing back after it stops, which is what sells a head
     * turn as having weight.
     */
    {
      const stiff = clamp(store.get('warp.tuftStiffness'), 0.1, 4);
      const k = 150 * stiff;
      const c = 13 * Math.sqrt(stiff);
      const drive = 1.2 * store.get('warp.tuftWeight') * store.get('body.hairPhysics');
      const t = this.tuft;
      // Fixed sub-steps, so a slow frame cannot overshoot into a spasm.
      let left = clamp(dt, 0, 0.1);
      while (left > 0) {
        const h = Math.min(left, 1 / 120);
        const ax = clamp(-this.inertia.ax, -12, 12) * drive - k * t.x - c * t.vx;
        const ay = clamp(-this.inertia.ay, -12, 12) * drive - k * t.y - c * t.vy;
        t.vx += ax * h;
        t.vy += ay * h;
        t.x = clamp(t.x + t.vx * h, -0.05, 0.05);
        t.y = clamp(t.y + t.vy * h, -0.05, 0.05);
        left -= h;
      }
    }

    const flare = clamp(this.inertia.speed * 1.6, 0, 1.4);
    this.glowPulse = damp(this.glowPulse, 0.82 + 0.18 * Math.sin(this.clock * 1.9) + flare, 9, dt);

    // How far into the mirrored view this yaw has taken us. Nothing happens
    // until the turn is committed enough that a flip reads as rotation rather
    // than as the face suddenly changing.
    const start = store.get('parts.mirrorStart');
    // A short ramp. Cross-fading hard-edged line art always ghosts, so the
    // dissolve wants to be over quickly — long enough not to pop, short enough
    // that the doubled image is a flicker rather than a pose you sit in.
    const mirror = clamp((Math.abs(yaw) - start) / 0.13, 0, 1)
      * store.get('parts.mirrorTurn')
      * (yaw < 0 ? 1 : 0); // the art already faces one way; only flip the other

    const shadowStrength = store.get('parts.contactShadow');

    /* Depth is measured against the head's own radius, so the shell is as
     * round as the head is wide however the artwork is scaled. Capped where
     * the surface would start folding over itself within the turn limit —
     * see the note on RISE in shell.js.
     */
    const shellAmount = clamp(store.get('parts.turnShell'), 0, 1);
    const foldSafe = 1 / (Math.max(this.shell?.rise ?? 1.8, 0.1)
      * Math.tan(clamp(store.get('head.limitDeg'), 5, 80) * Math.PI / 180));
    const shellDepth = Math.min(clamp(store.get('parts.shellDepth'), 0, 1), foldSafe)
      * this.headSpan.r;

    // --- draw, back to front ---------------------------------------------
    for (const part of this.parts) {
      gl.uniformMatrix3fv(L.u_model, false, joints[part.joint] ?? IDENTITY);
      gl.uniformMatrix3fv(L.u_modelFar, false,
        joints[part.farJoint ?? part.joint] ?? joints[part.joint] ?? IDENTITY);


      // Tufts and the neck wrap are attached to the shell, so they have to
      // take the same bend as it; only the head itself ever mirrors.
      // The eyes flip with the face — they are painted on the visor, so leaving
      // them put while it mirrors slides them off it. But they snap rather
      // than dissolve: a cross-fade of two bright shards on a dark visor reads
      // as the character briefly having two eyes, which is far worse than the
      // ghosting the hood gets away with at its own low contrast.
      const isHead = part.name === 'head';
      const snapsWithHead = part.name === 'eyes';
      const bends = BENDS_WITH_HEAD.has(part.name);
      gl.uniform1f(L.u_warp, bends ? 1 : 0);
      if (bends) {
        // The neck wrap is cloth lying over the shoulders, not part of the
        // shell. Turning it as hard as the hood drags it across the visor and
        // swings it clear of the shoulder, which uncovers the arm's painted
        // margin as a dark smear. Cloth follows a head turn; it does not
        // perform it.
        /* Turn about the middle of the head, not about the marker.
         *
         * The marker is placed from eye spacing, which on this drawing puts it
         * near the chin and calls the head barely half its real size — the
         * same reason headSpan exists at all, measured from the piece that was
         * actually cut. Rotating a head about a point forty per cent of a
         * radius below its centre does not read as a nod: the face swings
         * through an arc it should not have, the crown barely moves, and what
         * you see is the drawing being bent rather than the head turning.
         */
        gl.uniform2f(L.u_headCenter, this.headSpan.cx, this.headSpan.cy);
        gl.uniform1f(L.u_cylR, this.headCylR);
        gl.uniform1f(L.u_yaw, yaw);
        gl.uniform1f(L.u_pitch, pitch);
        gl.uniform1f(L.u_shell, this.shell ? shellAmount : 0);
        gl.uniform1f(L.u_depth, shellDepth);
      }

      const carriesEyes = part.name === 'eyes';
      gl.uniform1f(L.u_eyesEnabled, carriesEyes && store.get('warp.eyesEnabled') ? 1 : 0);
      if (carriesEyes) {
        gl.uniform4fv(L.u_eyeL, part.eyeL);
        gl.uniform4fv(L.u_eyeR, part.eyeR);
        gl.uniform1f(L.u_eyeAngle, m.eyeAngle);
        // No lid colour: the lid erases this layer and the visor behind shows
        // through, so there is nothing to match a sampled tone against.
        gl.uniform2f(L.u_blink, rig.eyes.blinkL, rig.eyes.blinkR);
        const sq = store.get('warp.squint');
        gl.uniform2f(L.u_squint, clamp(rig.eyes.squintL * sq, 0, 1), clamp(rig.eyes.squintR * sq, 0, 1));
        gl.uniform2f(L.u_wide, rig.eyes.wideL, rig.eyes.wideR);
        const gz = store.get('eyes.gazeGain');
        gl.uniform2f(L.u_gaze, clamp(rig.eyes.gazeX * gz, -1, 1), clamp(rig.eyes.gazeY * gz, -1, 1));
        gl.uniform1f(L.u_glow, store.get('warp.eyeGlow'));
        gl.uniform1f(L.u_glowPulse, this.glowPulse);
      }

      gl.uniform2f(L.u_texel, 1 / part.w, 1 / part.h);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, part.texture);
      gl.uniform1i(L.u_tex, 0);

      /* Contact shadow, laid down before the part itself.
       *
       * Parts are drawn back to front, so a shadow drawn just before a part
       * lands on everything behind it and on nothing in front — which is
       * exactly what a contact shadow is. Without it the layers read as paper
       * cutouts: nothing says the scarf is in front of the arm rather than
       * printed on it.
       *
       * Multiplying by the destination alpha keeps it off the empty
       * background; otherwise a transparent OBS source gets a black halo
       * around the whole character.
       */
      if (shadowStrength > 0 && SHADOWS.has(part.name)) {
        gl.blendFuncSeparate(gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
        gl.uniform1f(L.u_shadow, shadowStrength);
        gl.uniform2f(L.u_shadowOffset, SHADOW_DIR[0] / part.w, SHADOW_DIR[1] / part.h);
        gl.uniform1f(L.u_flipU, isHead && mirror > 0.5 ? 1 : 0);
        gl.uniform1f(L.u_opacity, 1);
        gl.drawElements(gl.TRIANGLES, part.indexCount, gl.UNSIGNED_SHORT, 0);
        gl.uniform1f(L.u_shadow, 0);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
      gl.bindVertexArray(part.vao);

      // Turning past a threshold cross-fades the head into its mirror image.
      // For a character drawn at three-quarters, the mirror IS the opposite
      // three-quarter view — far closer to the truth than warping toward a view
      // the drawing does not contain. Both copies are drawn during the blend,
      // because a straight swap pops.
      if (isHead && mirror > 0.001) {
        /* Cross-fade with the far copy underneath, at full opacity.
         *
         * Fading both copies is the obvious way and it is wrong: "over"
         * blending composites them to 1 - m + m² of alpha, which bottoms out
         * at 0.75 halfway through, so a quarter of the background showed
         * straight through the head. That is what made the flip look like the
         * helmet turning black — nothing to do with the turn itself.
         *
         * Painting the mirrored copy solid and dissolving the near one over it
         * keeps the total at 1 the whole way across.
         */
        gl.uniform1f(L.u_flipU, 1);
        gl.uniform1f(L.u_opacity, 1);
        gl.drawElements(gl.TRIANGLES, part.indexCount, gl.UNSIGNED_SHORT, 0);
        gl.uniform1f(L.u_flipU, 0);
        gl.uniform1f(L.u_opacity, 1 - mirror);
        gl.drawElements(gl.TRIANGLES, part.indexCount, gl.UNSIGNED_SHORT, 0);
      } else if (snapsWithHead) {
        gl.uniform1f(L.u_flipU, mirror > 0.5 ? 1 : 0);
        gl.uniform1f(L.u_opacity, 1);
        gl.drawElements(gl.TRIANGLES, part.indexCount, gl.UNSIGNED_SHORT, 0);
      } else {
        gl.uniform1f(L.u_flipU, 0);
        gl.uniform1f(L.u_opacity, 1);
        gl.drawElements(gl.TRIANGLES, part.indexCount, gl.UNSIGNED_SHORT, 0);
      }
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
  /* Move the cloth onto its bones, here rather than in the shader.
   *
   * The shader used to do this, reading each bone out of a uniform array with
   * an index it computed per vertex. That is legal and it works on a desktop
   * driver, and it is also one of the oldest ways to get wrong geometry out of
   * a mobile one: the reported symptom was the middle of the ribbon arriving
   * somewhere else entirely, with clean straight edges where it had been cut,
   * on a phone whose cut, bone array and buffer size all matched this machine
   * exactly. Nothing else in the model indexes an array per vertex, and
   * nothing else was breaking.
   *
   * Seven hundred vertices of the same arithmetic on the CPU is nothing, and
   * the maths here is the same function the bind was computed against, so the
   * rest pose is exact by construction rather than by two implementations
   * agreeing.
   */
  skinCloth() {
    for (const part of this.parts) {
      if (!part.skinned || !part.binds || !part.live) continue;
      const { binds, live } = part;
      const skew = this.aspect || 1;
      for (let v = 0, b = 0; v < live.length; v += 2, b += 3) {
        const f = spineFrame(this.boneNodes(), binds[b], skew);
        const ox = frameNormalX(f) * binds[b + 1] + f.tx * binds[b + 2];
        const oy = f.ny * binds[b + 1] + f.ty * binds[b + 2];
        live[v] = f.hx + ox / skew;
        live[v + 1] = f.hy + oy;
      }
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, part.posBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, live);
    }
  }

  /** The bone chain as spineFrame wants it, without rebuilding it per vertex. */
  boneNodes() {
    const nodes = this.boneList ?? (this.boneList = []);
    for (let i = 0; i < SPINE_NODES; i++) {
      const n = nodes[i] ?? (nodes[i] = [0, 0]);
      n[0] = this.bones[i * 2];
      n[1] = this.bones[i * 2 + 1];
    }
    nodes.length = SPINE_NODES;
    return nodes;
  }

  solveJoints(rig, roll, pitch, m) {
    const lean = rig.head.x * 0.045 + rig.body.leanX * 0.02;
    const rise = -rig.head.y * 0.04 + rig.body.bounce * 0.004;
    const breath = rig.body.breath * 0.012;

    const hips = compose(
      translate(IDENTITY, lean, rise),
      rotateAbout(rig.body.twist * 0.16, m.pivotX, 1.25, this.aspect),
      scaleAbout(1, 1 + breath, m.pivotX, m.pivotY),
    );
    /* A nod moves the head, not just the drawing on it.
     *
     * Roll has always read correctly because the whole head rotates about the
     * neck: it is a rigid motion, and the eye reads rigid motion instantly.
     * Pitch had nothing of the kind — only the surface warp, which at these
     * angles is mostly a symmetric vertical squash, the same shape whether the
     * chin goes up or down. A head that just gets shorter is not nodding, and
     * with no direction in it the strongest thing left to read is the squash,
     * which is why the nod was reported backwards no matter which way the
     * maths went.
     *
     * Nodding pivots at the neck, below the head, so the head swings: down
     * carries it down and slightly forward, up carries it up. That is the
     * cue, and it is worth far more than the surface detail on top of it.
     */
    const nod = clamp(-pitch, -1.2, 1.2) * 0.075 * store.get('warp.nod');
    const neck = compose(
      hips,
      translate(IDENTITY, 0, nod),
      rotateAbout(roll, m.pivotX, m.pivotY, this.aspect),
    );

    /* Arms hang off the hips rather than the neck: lifting a hand should not
     * inherit the head's tilt, and a shoulder that followed the head would
     * shear the sleeve every time you looked sideways.
     *
     * That holds for the shoulder. The raised fist in this drawing sits
     * against the cheek, and leaving it behind when the head turns strands it
     * in mid-air with nothing joining it to anything. So an arm is held at
     * both ends too, by the same rule as the cloth: the hand by the head where
     * it touches it, the shoulder by the body, and the sleeve between them.
     * The objection above is about the shoulder following the head, and under
     * a gradient the shoulder does not.
     *
     * Sides cross over, and they have to. After mirroring, `rig.arms.left` is
     * the character's own left arm — and a character facing you wears its left
     * on your right. Wiring left to left puts the wrong hand in the air.
     */
    const armAt = (name, side) => {
      const part = this.parts.find((p) => p.name === name);
      if (!part?.pivot) return hips;
      const a = rig.arms[side];
      // A hand going from keyboard to shoulder height is most of a right
      // angle. Passing that straight through would swing the drawn arm out of
      // the composition, so it is scaled to a readable fraction of itself.
      const swing = clamp(a.upper * 0.45 + a.raise * 0.10, -1.2, 1.2);
      const lift = clamp(a.raise, -0.8, 1.6) * 0.035;
      return compose(
        hips,
        translate(IDENTITY, 0, -lift),
        rotateAbout(swing, part.pivot[0], part.pivot[1], this.aspect),
      );
    };

    // The hair swings about the head rather than sliding across it: a tuft is
    // rooted in the hood, so its tip travels much further than its base.
    const lag = this.tuft;
    const tufts = compose(
      neck,
      rotateAbout(lag.x * 10.5, m.headX, m.headY, this.aspect),
      translate(IDENTITY, lag.x * 0.35, lag.y * 0.55),
    );

    return {
      root: IDENTITY, hips, torso: hips, neck, head: neck, eyes: neck, tufts,
      shoulderLeft: armAt('armLeft', 'right'),
      shoulderRight: armAt('armRight', 'left'),
    };
  }

  /**
   * What this GPU actually drew, measured here rather than on a test machine.
   *
   * Every check in the suite runs on a software renderer on a build server. A
   * phone has a different driver, a different shader compiler and a different
   * screen, and the faults that have actually reached the user were visible
   * there and nowhere else. There is no console on a phone either, so this
   * puts the answer on the screen: the artwork is a single connected shape, so
   * anything other than one piece is the model coming apart, whatever the
   * suite says.
   *
   * Read in bands and subsampled, so a 4-megapixel buffer costs a small mask
   * rather than sixteen megabytes.
   */
  selfCheck() {
    const gl = this.gl;
    if (!gl || !this.ready) return null;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const step = Math.max(1, Math.ceil(Math.max(w, h) / 420));
    const mw = Math.ceil(w / step);
    const mh = Math.ceil(h / step);
    const mask = new Uint8Array(mw * mh);

    const BAND = Math.max(step, 256 - (256 % step));
    const row = new Uint8Array(w * BAND * 4);
    for (let y0 = 0; y0 < h; y0 += BAND) {
      const rows = Math.min(BAND, h - y0);
      gl.readPixels(0, y0, w, rows, gl.RGBA, gl.UNSIGNED_BYTE, row);
      for (let y = 0; y < rows; y += step) {
        const my = ((y0 + y) / step) | 0;
        if (my >= mh) continue;
        for (let x = 0; x < w; x += step) {
          if (row[(y * w + x) * 4 + 3] > 24) mask[my * mw + ((x / step) | 0)] = 1;
        }
      }
    }

    const seen = new Uint8Array(mw * mh);
    const stack = [];
    const areas = [];
    for (let start = 0; start < mask.length; start++) {
      if (seen[start] || !mask[start]) continue;
      let area = 0;
      seen[start] = 1;
      stack.push(start);
      while (stack.length) {
        const i = stack.pop();
        area++;
        const x = i % mw;
        const y = (i - x) / mw;
        const go = (j) => { if (!seen[j] && mask[j]) { seen[j] = 1; stack.push(j); } };
        if (x > 0) go(i - 1);
        if (x < mw - 1) go(i + 1);
        if (y > 0) go(i - mw);
        if (y < mh - 1) go(i + mw);
      }
      areas.push(area);
    }
    areas.sort((a, b) => b - a);
    // A speck is rasterisation; a piece is the model. Scaled to the drawing so
    // the threshold means the same at any screen size.
    const floor = Math.max(6, Math.round((areas[0] ?? 0) * 0.002));
    const pieces = areas.filter((a) => a >= floor);
    return {
      pieces: pieces.length,
      strays: pieces.slice(1),
      buffer: `${w}x${h}`,
      dpr: (window.devicePixelRatio || 1).toFixed(2),
      drawn: this.parts.map((p) => `${p.name} ${Math.round((p.pixels ?? 0) / 1000)}k`).join(' '),
      skinning: 'cpu',
    };
  }

  /**
   * The artwork's own extent in UV, ignoring the dilated margins — those are
   * padding, and framing to them would leave a border of nothing.
   */
  contentBox() {
    if (!this.parts.length || !this.imageSize) return { x0: 0, y0: 0, x1: 1, y1: 1 };
    const { width, height } = this.imageSize;
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const part of this.parts) {
      const inset = part.inset ?? 0;
      x0 = Math.min(x0, (part.x + inset) / width);
      y0 = Math.min(y0, (part.y + inset) / height);
      x1 = Math.max(x1, (part.x + part.w - inset) / width);
      y1 = Math.max(y1, (part.y + part.h - inset) / height);
    }
    return { x0: clamp(x0, 0, 1), y0: clamp(y0, 0, 1), x1: clamp(x1, 0, 1), y1: clamp(y1, 0, 1) };
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

function bind(gl, location, data, size, usage) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, usage ?? gl.STATIC_DRAW);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
  return buffer;
}

/** The frame's normal x, kept named so the offset below reads as it is built. */
const frameNormalX = (f) => f.nx;

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


/* ------------------------------------------------------------------ cloth */

/**
 * Thin the cloth to its centreline and resample it into bones.
 *
 * Run on the real artwork's alpha, not the part's: the dilated margin is opaque
 * too, and including it would fatten the shape and bow the centreline outward.
 */
function findSpine(part, image, width, height, m) {
  const scale = 0.5; // thinning is iterative; half resolution is plenty
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
 * The frame of the centreline at a given distance along it: a point, and the
 * tangent and normal there.
 *
 * The single implementation, used both to compute the bind and to undo it, so
 * the rest pose is exact by construction. It used to have a twin in the vertex
 * shader that had to be kept in step by hand.
 */
function spineFrame(nodes, s, aspect) {
  const skew = aspect || 1;
  const f = clamp(s, 0, 1) * (nodes.length - 1);
  const i = Math.min(Math.floor(f), nodes.length - 1);
  const j = Math.min(i + 1, nodes.length - 1);
  const t = f - i;

  const lerp2 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const here = lerp2(nodes[i], nodes[j], t);
  const prev = lerp2(nodes[Math.max(i - 1, 0)], nodes[i], t);
  const next = lerp2(nodes[j], nodes[Math.min(j + 1, nodes.length - 1)], t);

  let tx = (next[0] - prev[0]) * skew + 1e-6;
  let ty = next[1] - prev[1];
  const len = Math.hypot(tx, ty) || 1e-9;
  tx /= len; ty /= len;
  return { hx: here[0], hy: here[1], tx, ty, nx: -ty, ny: tx };
}

/**
 * Bind a point into the spine's local frame: how far along, and its offset
 * split into the normal and tangent directions there.
 *
 * Keeping both components is what makes the bind exact. Storing only the
 * perpendicular distance discards everything along the spine, so the point
 * cannot be put back where it came from.
 */
function bindToSpine(px, py, nodes, aspect) {
  const skew = aspect || 1;
  // Nearest point on the polyline, in aspect-corrected space.
  let bestDist = Infinity;
  let bestS = 0;
  for (let i = 0; i < nodes.length - 1; i++) {
    const ax = nodes[i][0] * skew, ay = nodes[i][1];
    const bx = nodes[i + 1][0] * skew, by = nodes[i + 1][1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    const t = clamp(((px * skew - ax) * dx + (py - ay) * dy) / len2, 0, 1);
    const d = (px * skew - (ax + dx * t)) ** 2 + (py - (ay + dy * t)) ** 2;
    if (d < bestDist) { bestDist = d; bestS = (i + t) / (nodes.length - 1); }
  }

  const frame = spineFrame(nodes, bestS, skew);
  const ox = px * skew - frame.hx * skew;
  const oy = py - frame.hy;
  return [bestS, ox * frame.nx + oy * frame.ny, ox * frame.tx + oy * frame.ty];
}
