/** The layered puppet: the artwork cut into parts, each moving on its own. */
import { clamp, damp, DEG, lerp, makeSpring, smoothstep, spring } from '../../core/math.js';
import * as store from '../../core/store.js';
import { computeFrame } from '../../core/framing.js';
import { FRAGMENT_SHADER, VERTEX_SHADER } from './shader.js';

/**
 * Where the head's turn stops being the head's, as multiples of the head's own
 * radius. Full inside the first, none beyond the second, smooth between.
 */
const FOLLOW_FULL = 1.05;
const FOLLOW_NONE = 2.30;

/** The rig as it reads for a character facing the other way. */
function facedRig(rig) {
  const { head, body, eyes, arms } = rig;
  return {
    ...rig,
    head: { ...head, yaw: -head.yaw, roll: -head.roll, x: -head.x },
    body: { ...body, leanX: -body.leanX, twist: -body.twist },
    eyes: {
      ...eyes,
      gazeX: -eyes.gazeX,
      blinkL: eyes.blinkR, blinkR: eyes.blinkL,
      squintL: eyes.squintR, squintR: eyes.squintL,
      wideL: eyes.wideR, wideR: eyes.wideL,
    },
    arms: { ...arms, left: arms.right, right: arms.left },
  };
}

/** Which way the light comes from, in texels of the casting part. */
const SHADOW_DIR = [-3.5, -3.5];
/** How far the head drops at a fully open mouth, as a fraction of the drawing's height. */
const TALK_BOB = 0.0065;
/** How much a fully open mouth lifts the visor glow above its idle pulse. */
const TALK_GLOW = 0.35;
import { HeadInertia, LinkChain } from './cloth.js';
import { loadModel } from './model.js';
import { FaceLatch } from './latch.js';

const UNIFORMS = [
  'u_model', 'u_modelFar', 'u_aspect', 'u_viewScale', 'u_viewOffset', 'u_viewRot', 'u_tex', 'u_opacity',
  'u_eyesEnabled', 'u_eyeL', 'u_eyeR', 'u_eyeAngle',
  'u_blink', 'u_squint', 'u_wide', 'u_gaze', 'u_glow', 'u_glowPulse', 'u_texel',
  'u_shadow', 'u_shadowOffset', 'u_margin', 'u_marginMax', 'u_lidFill', 'u_smear',
];

const SPINE_NODES = 16;
/** How much invented margin a part may draw, in pixels of its texture. */
const MARGIN_FULL = 32;
/* How much of a tilt leans from the neck. The rest turns the head about its
 * own centre, where it stays inside its collar: the neck pivot is a hundred
 * pixels below the head's centre, so tilting from it alone swings the head
 * sideways and lifts it clear of the collar. */
const ROLL_AT_NECK = 0.25;
/* What surprise does with the levers this character has: the visor slits open,
 * the glow flares, and the head pulls back a little. */
const SURPRISE_WIDE = 0.9;
const SURPRISE_GLOW = 0.6;
const SURPRISE_LIFT = 0.026;
/* How much bigger the glowing slits grow. u_wide only brightens the glow —
 * nothing in the shader opens the drawn shard — so the eyes are grown by
 * scaling their own parts about themselves. */
const SURPRISE_EYE = 0.42;
/* The head's follow-through. Stiff and close to critically damped: the old
 * pair took 133 ms to cover most of a step, which is more lag than the tracker
 * and the filter put together. */
const HEAD_SPRING = [620, 36];

/* How far a turn slides the head, and how far a nod raises it, as a fraction of
 * the stage. Pitch also rotates the cutout; yaw has only this, which is why it
 * is no longer the quarter of the nod's that it was. */
const TURN_SLIDE = 0.030;
const NOD_RISE = 0.055;
/* The shutter the smear is drawn with. Longer than a frame on purpose: a
 * physically honest 1/60 s smears a couple of pixels and cel art reads nothing
 * from it. Fixed, so the smear looks the same at any frame rate. */
const EXPOSURE = 1 / 15;
/* The most of the picture one frame may smear across. */
const MAX_SMEAR = 0.06;

/* The face changes hands on an angle, not on a speed, so a slow turn used to
 * swap with no motion for the smear to cover. This is the blur the changeover
 * gives itself, and how long it takes to fade. */
const SWAP_SMEAR = 0.026;
const SWAP_FADE = 0.11;
/* How hard the head's inertia and the idle wind drive the chain, in the
 * chain's own units. Both were re-found by measurement when the chain became
 * rigid links: it settles at drive/bend rather than drive/rest, so the old
 * gains moved the tip a pixel or two and the ribbon read as painted on.
 */
const CLOTH_DRIVE = 1.0;
const CLOTH_WIND = 0.5;

export class Parts2D {
  static id = 'parts2d';
  static label = 'My artwork (cut into parts)';

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'avatar-canvas';
    this.gl = null;
    this.model = null;
    this.parts = [];
    this.ready = false;
    this.clock = 0;
    this.onStatus = () => {};

    /* Rigid links, rooted on the shoulder — see LinkChain. */
    this.scarf = new LinkChain({ nodes: SPINE_NODES, pinned: 2, bend: 160, rest: 14,
      damping: 3.0, tipBias: 3.2, carry: 3 });
    this.inertia = new HeadInertia();
    // What the scarf feels — the head's whole mass, roll included. Its own
    // tracker rather than the hair's; see the cloth step in render.
    this.clothInertia = new HeadInertia();
    // Hair lag: a single damped spring per axis, driven by the head's own
    // acceleration. The spikes are short and stiff, so they want a much
    // faster, tighter response than the scarf — a chain here would read as
    // seaweed.
    this.tuft = { x: 0, y: 0, vx: 0, vy: 0 };
    this.springs = { yaw: makeSpring(), pitch: makeSpring(), roll: makeSpring() };
    this.glowPulse = 1;
    // Which face is showing, and how far through changing hands it is. Latched
    // rather than derived from the angle every frame — see the note in render.
    this.latch = new FaceLatch();
    this.turnedSide = 1;
    this.headOnPhase = 1;
    this.gazeLead = 0;
    this.swapPulse = 0;
    this.bones = new Float32Array(SPINE_NODES * 2);

  }

  mount(container) {
    container.appendChild(this.canvas);
    if (!this.gl) this.initGL();
  }

  /**
   * Forget all motion: springs, cloth, hair, glow, the face latch and the
   * clock. The next render starts from the drawn pose, so two renders of the
   * same rig after a reset are the same picture.
   */
  reset() {
    this.clock = 0;
    this.springs = { yaw: makeSpring(), pitch: makeSpring(), roll: makeSpring() };
    this.tuft = { x: 0, y: 0, vx: 0, vy: 0 };
    this.glowPulse = 1;
    this.latch.reset();
    this.turnedSide = 1;
    this.headOnPhase = 1;
    this.gazeLead = 0;
    this.swapPulse = 0;
    this.faceOn = true;
    this.lastHead = null;
    this.scarf.reset();
    this.inertia.reset();
    this.clothInertia.reset();
  }

  initGL() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
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
    };

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    if (this.model) this.setModel(this.model);
  }

  /** Fetch the baked model under `base` (a URL ending in a slash) and show it. */
  async load(base) {
    this.setModel(await loadModel(base));
  }

  /**
   * Take a decoded model (see model.js) and build every part's textures and
   * geometry from it. Before mount() there is no context; the upload then
   * happens when there is one.
   */
  setModel(model) {
    this.model = model;
    this.imageSize = { width: model.width, height: model.height };
    this.aspect = model.width / model.height;
    this.headSpan = model.headSpan;
    this.spine = model.spine ? { nodes: model.spine.nodes } : null;
    this.spineSpan = model.spine?.span ?? 0;
    this.headOnNote = model.headOn?.note ?? 'no drawing';
    /* The frontal drawing's lids lie flat; the three-quarter drawing's sweep
     * at 32°. The sockets were measured in each drawing's own frame, so each
     * has to be read back in it. */
    this.headOnEyeAngle = model.headOn?.markers?.eyeAngle ?? null;
    this.scarf.reset();
    this.scarf.hasRest = false;
    if (this.spine?.nodes?.length > 1) this.scarf.setRest(this.spine.nodes, this.aspect);

    const gl = this.gl;
    if (!gl) return;
    for (const old of this.owned ?? []) {
      gl.deleteTexture(old.texture);
      gl.deleteTexture(old.marginTex);
      gl.deleteVertexArray(old.vao);
    }
    this.parts = model.parts.map((part) => this.upload(part));
    this.owned = this.parts;
    this.headOn = this.parts.some((p) => p.name === 'headOn');
    this.ready = this.parts.length > 0;
  }

  /** A part scaled about its own middle, in the artwork's own square space. */
  eyeScale(part, k) {
    const { width, height } = this.imageSize;
    let cx = (part.x + part.w / 2) / width;
    let cy = (part.y + part.h / 2) / height;
    if (part.place) {
      cx = (cx - part.place.fromX) * part.place.k + part.place.toX;
      cy = (cy - part.place.fromY) * part.place.k + part.place.toY;
    }
    return scaleAbout(k, k, cx, cy);
  }

  /** How much of the neck's motion a vertex at (px, py) takes: 1 on the head, 0 on the body. */
  followAt(part, px, py) {
    if (part.flags.follow === 'full') return 1;
    if (part.flags.follow === 'none') return 0;
    const h = this.headSpan;
    const d = Math.hypot((px - h.cx) * this.aspect, py - h.cy) / Math.max(h.r, 1e-4);
    const t = clamp((d - FOLLOW_FULL) / (FOLLOW_NONE - FOLLOW_FULL), 0, 1);
    return 1 - t * t * (3 - 2 * t); // smoothstep, so there is no crease
  }

  /** One part: its two textures and its grid, from the manifest entry and its decoded PNGs. */
  upload(part) {
    const gl = this.gl;
    const { width, height } = this.imageSize;

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

    // One byte per texel says how invented the paint there is; the shader
    // reads the red channel.
    const marginTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, marginTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, part.marginImage);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, part.image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // The grid: a quad for a rigid part, rows for the arms and the cloth.
    // Cloth vertices bind to the nearest point of the spine and carry a flag
    // saying whether they sit on the piece the chain runs through.
    const skinned = part.flags.skinned && Boolean(this.spine);
    const n = part.grid;
    const pos = [];
    const uv = [];
    const bindData = [];
    const followData = [];
    const onChainData = [];
    const idx = [];
    for (let row = 0; row <= n; row++) {
      for (let col = 0; col <= n; col++) {
        const s = col / n;
        const t = row / n;
        let px = (part.x + s * part.w) / width;
        let py = (part.y + t * part.h) / height;
        if (part.place) {
          const q = part.place;
          px = (px - q.fromX) * q.k + q.toX;
          py = (py - q.fromY) * q.k + q.toY;
        }
        pos.push(px, py);
        uv.push(s, t);
        followData.push(this.followAt(part, px, py));
        bindData.push(...(skinned ? bindToSpine(px, py, this.spine.nodes, this.aspect) : [0, 0, 0]));
        onChainData.push(part.onChain ? (part.onChain[row * (n + 1) + col] === '1' ? 1 : 0) : 1);
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
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    return {
      ...part,
      texture, marginTex, vao, indexCount: idx.length, skinned,
      // Skinning happens on the CPU (see skinCloth), so the cloth keeps its
      // rest positions, its bind coordinates and a live copy it uploads.
      posBuffer,
      binds: skinned ? new Float32Array(bindData) : null,
      live: skinned ? new Float32Array(pos) : null,
      rest: skinned ? new Float32Array(pos) : null,
      onChain: skinned ? new Float32Array(onChainData) : null,
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

    /* A zero step draws what is already there without advancing anything. */
    dt = dt > 0 ? clamp(dt, 1 / 240, 1 / 15) : 0;
    this.clock += dt;

    const L = this.loc;
    const m = this.model.markers;
    gl.useProgram(this.program);

    /* Facing the other way: the picture through a mirror, the tracking too. */
    const faced = store.get('stage.faceFlip');
    if (faced) rig = facedRig(rig);

    // --- framing ---------------------------------------------------------
    const frame = computeFrame(this.aspect, this.canvas.width, this.canvas.height,
      store.get('stage.zoom'), store.get('stage.offsetX'), store.get('stage.offsetY'));
    // Mirrored inside the same box, so turning the character round does not
    // also move it: what was at the left edge of the frame ends up at the
    // right edge of the same frame.
    gl.uniform2f(L.u_viewScale, faced ? -frame.sx : frame.sx, frame.sy);
    gl.uniform2f(L.u_viewOffset, faced ? frame.ox + frame.sx : frame.ox, frame.oy);
    gl.uniform1f(L.u_aspect, this.aspect);
    // Turning the picture in the window. The canvas's shape goes in and comes
    // straight back out, so the character turns in a circle; facing the other
    // way mirrors the picture, so the angle mirrors with it and the slider
    // still turns the character the way it says.
    const spin = store.get('stage.rotate') * DEG * (faced ? -1 : 1);
    const ca = (this.canvas.width || 1) / (this.canvas.height || 1);
    const cs = Math.cos(spin);
    const sn = Math.sin(spin);
    gl.uniformMatrix2fv(L.u_viewRot, false, new Float32Array([cs, sn * ca, -sn / ca, cs]));

    // --- head angles, with overshoot -------------------------------------
    const overshoot = store.get('warp.overshoot');
    const yawTarget = rig.head.yaw * store.get('warp.turn');
    const pitchTarget = rig.head.pitch * store.get('warp.nod');
    spring(this.springs.yaw, yawTarget, HEAD_SPRING[0], HEAD_SPRING[1], dt);
    spring(this.springs.pitch, pitchTarget, HEAD_SPRING[0], HEAD_SPRING[1], dt);
    spring(this.springs.roll, rig.head.roll, HEAD_SPRING[0] * 0.88, HEAD_SPRING[1] * 0.94, dt);
    const yaw = lerp(yawTarget, this.springs.yaw.value, overshoot);
    const pitch = lerp(pitchTarget, this.springs.pitch.value, overshoot);
    const roll = lerp(rig.head.roll, this.springs.roll.value, overshoot);

    /* What the drawing shows, which is not the angle the head is at: small
     * movements get more than their share of the travel. The latch above still
     * sees the real angle, so the changeover stays where the slider says. */
    const limit = Math.max(store.get('head.limitDeg') * DEG, 1e-3);
    const gamma = store.get('head.response');
    const yawShown = respond(yaw, limit, gamma);
    const pitchShown = respond(pitch, limit, gamma);
    this.gazeLead = clamp(yawShown / limit, -1, 1) * store.get('head.gazeLead');

    // --- joints ----------------------------------------------------------
    const joints = this.solveJoints(rig, roll, pitchShown, yawShown, m);

    /* How far the head travelled this frame, for the smear. Taken from the
     * joint that carries it, so a turn, a nod and a lean all count. */
    const hx = joints.neck[0] * this.headSpan.cx + joints.neck[3] * this.headSpan.cy + joints.neck[6];
    const hy = joints.neck[1] * this.headSpan.cx + joints.neck[4] * this.headSpan.cy + joints.neck[7];
    let smearX = 0;
    let smearY = 0;
    const blurAmount = store.get('parts.motionBlur');
    if (this.lastHead && dt > 0 && blurAmount > 0) {
      // A turn slides the cutout only a few pixels, but the head it stands for
      // is really turning: the surface of a head of this radius travels at its
      // angular speed times that radius, and that is what a turn should smear.
      const spin = ((yaw - this.lastHead[2]) / dt) * this.headSpan.r;
      smearX = (((hx - this.lastHead[0]) / dt) + spin) * EXPOSURE * blurAmount;
      smearY = ((hy - this.lastHead[1]) / dt) * EXPOSURE * blurAmount;
      if (this.swapPulse > 0) smearX += this.turnedSide * SWAP_SMEAR * this.swapPulse;
      const travel = Math.hypot(smearX * this.aspect, smearY);
      if (travel > MAX_SMEAR) {
        smearX *= MAX_SMEAR / travel;
        smearY *= MAX_SMEAR / travel;
      }
    }
    this.swapPulse = Math.max(0, this.swapPulse - dt / SWAP_FADE);
    this.lastHead = [hx, hy, yaw];

    // --- cloth -----------------------------------------------------------
    const proxyX = m.headX + Math.sin(yaw) * 0.09 + rig.head.x * 0.045;
    const proxyY = m.headY - Math.sin(pitch) * 0.06 - rig.head.y * 0.04 + roll * 0.02;
    // Reset together: the checks reset the hair's tracker between poses, and a
    // stale scarf tracker would read the new pose as one enormous jerk.
    if (!this.inertia.seeded) this.clothInertia.reset();
    this.inertia.update(proxyX, proxyY, dt);
    /* Where the head's weight is, so the cloth feels it move. */
    this.clothInertia.update(proxyX + roll * (m.pivotY - this.headSpan.cy), proxyY, dt);
    const stiff = clamp(store.get('warp.clothStiffness'), 0.1, 4);
    const weight = clamp(store.get('warp.clothWeight'), 0, 3);
    /* Stiffness is the joint spring: how hard each link is pulled back toward
     * the direction it was drawn at. The links themselves never give.
     */
    const calm = 1 - clamp(weight, 0, 1);
    this.scarf.configure({
      bend: 160 * stiff * (1 + 3 * calm),
      rest: 14 * stiff * (1 + 3 * calm),
      damping: 3.0 * Math.sqrt(stiff) * (1 + 9 * calm),
    });
    // Scale note: the chain settles at force/rest, so with rest ~26 a tip that
    // should travel a few percent of the image wants forces below one. The
    // earlier gain produced ~5 and railed the chain against its own limit.
    // Scale note: the chain settles at force*weight/rest, and weight now
    // reaches 4.2 at the tip, so the per-node force has to come down to keep
    // the tip inside its limit instead of railing against it.
    /* "Scarf travel" drives the chain; it does not scale what comes out of it. */
    const fx = clamp(-this.clothInertia.ax, -12, 12) * CLOTH_DRIVE * weight;
    const fy = clamp(-this.clothInertia.ay, -12, 12) * CLOTH_DRIVE * weight;
    /* Rooted on the shoulder, which does not move with the head. The ribbon
     * leaves from behind the shoulder in this drawing, so its first links sit
     * where they were drawn and everything the head does reaches the ribbon
     * as the inertia above — a swing that starts at the root and arrives at
     * the tip one joint later, which is the movement that was asked for.
     */
    const swing = this.scarf.step(fx, fy, CLOTH_WIND * store.get('warp.wind') * weight, dt);

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

    /* Hair lag. */
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

    // The mouth is under the scarf, so speech shows as the visor glow lifting
    // (and, in solveJoints, a small drop of the head).
    const talk = clamp(rig.mouth?.open ?? 0, 0, 1);
    const flare = clamp(this.inertia.speed * 1.6, 0, 1.4);
    this.glowPulse = damp(this.glowPulse,
      0.82 + 0.18 * Math.sin(this.clock * 1.9) + flare + TALK_GLOW * talk
      + SURPRISE_GLOW * (rig.expression?.surprise ?? 0), 9, dt);

    /* Which face: it leaves quickly on a real turn and comes back once the
     * head has sat square (latch.js). A ramp of a fixed length, eased at both
     * ends, then carries the change — not a decay.
     *
     * On the angle the rig asked for, not the one the spring has reached, so
     * the swap does not wait out the follow-through on top of its own timing. */
    const squareOn = this.latch.update(yawTarget, dt,
      store.get('parts.headOnHold'), store.get('parts.headOnReturn'));
    /* A sweep across centre is quicker than the ramp, so the head-on face
     * arrives finished rather than starting to arrive. */
    if (this.latch.crossed) this.headOnPhase = 1;
    const step = dt / clamp(store.get('parts.headOnTime'), 0.02, 2);
    this.headOnPhase = clamp(this.headOnPhase + (squareOn ? step : -step), 0, 1);
    // A saved value from when this was a slider reads as on above a half.
    const headOnT = this.headOn && Number(store.get('parts.headOn')) >= 0.5
      ? smoothstep(this.headOnPhase) : 0;
    if (this.faceOn !== (headOnT >= 0.5)) this.swapPulse = 1;
    /* The face changes hands rather than fading, for the same reason the
     * mirror does: two copies of hard-edged line art laid over each other are
     * legible as two, and these are two different drawings of a hood, not one
     * drawing with the eyes moved. Halfway through a fade there were plainly
     * two visor rims and two chins.
     */
    /* Which face is showing, kept where anything can read it. */
    this.faceOn = headOnT >= 0.5;
    const faceOn = this.faceOn;

    /* The turned face has two sides: the drawing looks to the right, and a
     * turn to the left shows its mirror image. The side changes only while
     * the head-on face is actually covering it — on the latch, the face is
     * still the turned one for the first half of the ramp, and changing sides
     * there mirrors the head, hair and both eyes in full view. */
    if (squareOn && faceOn) this.turnedSide = yawTarget < 0 ? -1 : 1;

    const shadowStrength = store.get('parts.contactShadow');
    const mirror = mirrorAbout(this.headSpan.cx);
    const startled = clamp(rig.expression?.surprise ?? 0, 0, 1);

    const order = this.parts;

    // --- draw, back to front ---------------------------------------------
    for (const part of order) {
      /* Which of the two faces this part belongs to. */
      const face = part.flags.face;
      if (face === 'headOn' ? !faceOn : face === 'turned' && faceOn) continue;
      /* A mirrored part is reflected about the head's centre line before its
       * joint moves it, so it turns, slides and swings with everything else. */
      const mirrored = face === 'turned' && this.turnedSide < 0;
      const near = joints[part.joint] ?? IDENTITY;
      const far = joints[part.farJoint ?? part.joint] ?? near;
      /* Surprise grows the eyes about themselves, before whatever moves them. */
      const pop = part.flags.eyes && startled > 0
        ? this.eyeScale(part, 1 + SURPRISE_EYE * startled) : null;
      const placed = (m) => {
        if (mirrored && pop) return compose(m, mirror, pop);
        if (mirrored) return compose(m, mirror);
        return pop ? compose(m, pop) : m;
      };
      gl.uniformMatrix3fv(L.u_model, false, placed(near));
      gl.uniformMatrix3fv(L.u_modelFar, false, placed(far));
      const flipX = mirrored ? -1 : 1;

      /* Only the head smears, and only along the way it went. A placed part is
       * scaled onto the head, so its own texture covers less ground. */
      if (face && (smearX || smearY)) {
        const k = part.place ? part.place.k : 1;
        gl.uniform2f(L.u_smear,
          (smearX / k) * (this.imageSize.width / part.w) * flipX,
          (smearY / k) * (this.imageSize.height / part.h));
      } else {
        gl.uniform2f(L.u_smear, 0, 0);
      }

      const carriesEyes = part.flags.eyes;
      gl.uniform1f(L.u_eyesEnabled, carriesEyes && store.get('warp.eyesEnabled') ? 1 : 0);
      if (carriesEyes) {
        /* One part, one eye: the right one when the far eye is not mirrored. */
        const right = part.flags.far !== mirrored;
        gl.uniform4fv(L.u_eyeL, part.eyeL);
        gl.uniform4fv(L.u_eyeR, part.eyeR);
        gl.uniform1f(L.u_eyeAngle, part.flags.face === 'headOn' && this.headOnEyeAngle != null
          ? this.headOnEyeAngle : m.eyeAngle);
        gl.uniform1f(L.u_lidFill, part.lidFill ?? 1);
        // No lid colour: the lid erases this layer and the visor behind shows
        // through, so there is nothing to match a sampled tone against.
        gl.uniform2f(L.u_blink, right ? rig.eyes.blinkR : rig.eyes.blinkL, 0);
        const sq = store.get('warp.squint');
        const squint = clamp((right ? rig.eyes.squintR : rig.eyes.squintL) * sq, 0, 1);
        gl.uniform2f(L.u_squint, squint, 0);
        const wide = clamp((right ? rig.eyes.wideR : rig.eyes.wideL)
          + SURPRISE_WIDE * (rig.expression?.surprise ?? 0), 0, 1);
        gl.uniform2f(L.u_wide, wide, wide);
        // The gain is the rig's; applying it again here would square the slider.
        // The turn's lead rides along: a yaw slides the head without rotating
        // it, so the light in the visor is what a small turn has to show.
        gl.uniform2f(L.u_gaze, clamp((rig.eyes.gazeX + this.gazeLead) * flipX, -1, 1),
          clamp(rig.eyes.gazeY, -1, 1));
        gl.uniform1f(L.u_glow, store.get('warp.eyeGlow'));
        gl.uniform1f(L.u_glowPulse, this.glowPulse);
      }

      gl.uniform2f(L.u_texel, 1 / part.w, 1 / part.h);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, part.texture);
      gl.uniform1i(L.u_tex, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, part.marginTex);
      gl.uniform1i(L.u_margin, 1);
      gl.activeTexture(gl.TEXTURE0);
      /* How much of the invented margin this part gets to draw. */
      gl.uniform1f(L.u_marginMax, part.skinned ? store.get('parts.clothMargin') : MARGIN_FULL);

      /* This part's geometry, bound before anything is drawn with it. */
      gl.bindVertexArray(part.vao);

      /* Contact shadow, laid down before the part itself. */
      if (shadowStrength > 0 && part.flags.shadow) {
        gl.blendFuncSeparate(gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
        gl.uniform1f(L.u_shadow, shadowStrength);
        gl.uniform2f(L.u_shadowOffset, SHADOW_DIR[0] * flipX / part.w, SHADOW_DIR[1] / part.h);
        gl.uniform1f(L.u_opacity, 1);
        gl.drawElements(gl.TRIANGLES, part.indexCount, gl.UNSIGNED_SHORT, 0);
        gl.uniform1f(L.u_shadow, 0);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }

      gl.uniform1f(L.u_opacity, 1);
      gl.drawElements(gl.TRIANGLES, part.indexCount, gl.UNSIGNED_SHORT, 0);

    }
    gl.bindVertexArray(null);
  }

  /** One transform per joint, each built on its parent's. */
  /* Move the cloth onto its bones, here rather than in the shader. */
  skinCloth() {
    for (const part of this.parts) {
      if (!part.skinned || !part.binds || !part.live) continue;
      const { binds, live, rest, onChain } = part;
      const skew = this.aspect || 1;
      // The chain's own link length, so the reach below is measured in what
      // the chain is made of rather than in a number typed in for this
      // drawing. Guarded, because a chain of one node has no span.
      const span = Math.max(this.spineSpan || 0, 1e-4);
      // How far past the ends of the chain cloth still follows it, in links.
      const far = Math.max(clamp(store.get('parts.clothReach'), 0.6, 60), 0.6);
      const nodes = this.boneNodes();
      for (let v = 0, b = 0; v < live.length; v += 2, b += 3) {
        const f = spineFrame(nodes, binds[b], skew);
        const ox = frameNormalX(f) * binds[b + 1] + f.tx * binds[b + 2];
        const oy = f.ny * binds[b + 1] + f.ty * binds[b + 2];
        /* Only cloth the chain runs through is carried by it. */
        const own = onChain ? onChain[v >> 1] : 1;
        /* Cloth the chain does not run through is not swung by it. */
        const over = Math.hypot(binds[b + 1], binds[b + 2]) / span;
        const reach = 1 - smoothstep(clamp((over - far * 0.5) / Math.max(far * 1.5, 0.05), 0, 1));
        const carry = own * reach;
        const sx = f.hx + ox / skew;
        const sy = f.hy + oy;
        live[v] = rest[v] + (sx - rest[v]) * carry;
        live[v + 1] = rest[v + 1] + (sy - rest[v + 1]) * carry;
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

  solveJoints(rig, roll, pitch, yaw, m) {
    const lean = rig.head.x * 0.045 + rig.body.leanX * 0.02;
    const rise = -rig.head.y * 0.04 + rig.body.bounce * 0.004;
    const breath = rig.body.breath * 0.012;

    const hips = compose(
      translate(IDENTITY, lean, rise),
      rotateAbout(rig.body.twist * 0.16, m.pivotX, 1.25, this.aspect),
      scaleAbout(1, 1 + breath, m.pivotX, m.pivotY),
    );
    /* Nodding turns the head cutout, rather than bending the drawing on it. */
    const nod = clamp(-pitch, -1.2, 1.2) * NOD_RISE * store.get('warp.nod');
    const tilt = clamp(-pitch, -1.2, 1.2) * store.get('parts.nodTurn');
    /* Turning left and right slides the head instead of bending it. The
     * drawn views carry most of the turn now, so the slide is parallax rather
     * than the whole effect, and a smaller one keeps the head in its collar. */
    const shift = clamp(yaw, -1.2, 1.2) * TURN_SLIDE * store.get('warp.turn');
    const bob = TALK_BOB * clamp(rig.mouth?.open ?? 0, 0, 1)
      - SURPRISE_LIFT * clamp(rig.expression?.surprise ?? 0, 0, 1);
    const neck = compose(
      hips,
      translate(IDENTITY, shift, nod + bob),
      rotateAbout(roll * ROLL_AT_NECK, m.pivotX, m.pivotY, this.aspect),
      rotateAbout(tilt + roll * (1 - ROLL_AT_NECK), this.headSpan.cx, this.headSpan.cy, this.aspect),
    );

    /* Arms hang off the hips rather than the neck: lifting a hand should not
     * inherit the head's tilt, and a shoulder that followed the head would
     * shear the sleeve every time you looked sideways.
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

  /** What this GPU actually drew, measured here rather than on a test machine. */
  selfCheck() {
    const gl = this.gl;
    if (!gl || !this.ready) return null;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const step = Math.max(1, Math.ceil(Math.max(w, h) / 420));
    const mw = Math.ceil(w / step);
    const mh = Math.ceil(h / step);
    const BAND = Math.max(step, 256 - (256 % step));
    // One set of buffers per buffer size, not a fresh megabyte per call.
    const sc = this.scratch ??= {};
    if (sc.w !== w || sc.h !== h || sc.step !== step) {
      sc.w = w; sc.h = h; sc.step = step;
      sc.mask = new Uint8Array(mw * mh);
      sc.seen = new Uint8Array(mw * mh);
      sc.row = new Uint8Array(w * BAND * 4);
    }
    const mask = sc.mask.fill(0);
    const row = sc.row;
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

    const seen = sc.seen.fill(0);
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
      /* Whether the head-on face is loaded, and which face is showing. */
      headOn: this.headOn
        ? `${this.faceOn ? 'head-on' : 'turned away'} (${this.headOnNote})`
        : `OFF — ${this.headOnNote ?? 'no drawing'}`,
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
      // A piece borrowed from another drawing is registered onto this one at
      // draw time, so its stored rectangle is a position in a picture that is
      // not being framed. It lands inside the head it replaces either way.
      if (part.place) continue;
      const inset = part.inset ?? 0;
      x0 = Math.min(x0, (part.x + inset) / width);
      y0 = Math.min(y0, (part.y + inset) / height);
      x1 = Math.max(x1, (part.x + part.w - inset) / width);
      y1 = Math.max(y1, (part.y + part.h - inset) / height);
    }
    return { x0: clamp(x0, 0, 1), y0: clamp(y0, 0, 1), x1: clamp(x1, 0, 1), y1: clamp(y1, 0, 1) };
  }

  dispose() {
    this.canvas.remove();
  }
}

/* ------------------------------------------------------------- transforms */
// Column-major 3x3, matching WebGL's uniformMatrix3fv layout.

/* Spends more of the head's travel near the middle, leaving the extreme exactly
 * where it was: at gamma 1 this is a straight line, and below 1 a fifth of the
 * range covers rather more than a fifth of the distance. */
function respond(a, limit, gamma) {
  if (!(gamma < 1) || !(limit > 0)) return a;
  const t = Math.min(Math.abs(a) / limit, 1);
  return Math.sign(a) * (t ** gamma) * limit;
}

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

/** Reflect about the vertical line through cx. */
function mirrorAbout(cx) {
  return new Float32Array([-1, 0, 0, 0, 1, 0, 2 * cx, 0, 1]);
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
 * The frame of the centreline at a given distance along it: a point, and the
 * tangent and normal there.
 */
/* Written into and handed back rather than built fresh: this runs once per
 * cloth vertex per frame, and both callers are done with it before the next. */
const FRAME = { hx: 0, hy: 0, tx: 0, ty: 0, nx: 0, ny: 0 };

function spineFrame(nodes, s, aspect) {
  const skew = aspect || 1;
  const last = nodes.length - 1;
  const f = clamp(s, 0, 1) * last;
  const i = Math.min(Math.floor(f), last);
  const j = Math.min(i + 1, last);
  const t = f - i;

  const a = nodes[i], b = nodes[j];
  const p = nodes[Math.max(i - 1, 0)], q = nodes[Math.min(j + 1, last)];
  const prevX = p[0] + (a[0] - p[0]) * t;
  const prevY = p[1] + (a[1] - p[1]) * t;
  const nextX = b[0] + (q[0] - b[0]) * t;
  const nextY = b[1] + (q[1] - b[1]) * t;

  let tx = (nextX - prevX) * skew + 1e-6;
  let ty = nextY - prevY;
  const len = Math.hypot(tx, ty) || 1e-9;
  tx /= len; ty /= len;
  FRAME.hx = a[0] + (b[0] - a[0]) * t;
  FRAME.hy = a[1] + (b[1] - a[1]) * t;
  FRAME.tx = tx; FRAME.ty = ty; FRAME.nx = -ty; FRAME.ny = tx;
  return FRAME;
}

/**
 * Bind a point into the spine's local frame: how far along, and its offset
 * split into the normal and tangent directions there.
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
