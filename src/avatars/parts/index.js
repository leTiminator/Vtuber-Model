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
import { clamp, damp, lerp, makeSpring, smoothstep, spring } from '../../core/math.js';
import * as store from '../../core/store.js';
import { computeFrame } from '../../core/framing.js';
import { FRAGMENT_SHADER, VERTEX_SHADER } from './shader.js';

/**
 * Where the head's turn stops being the head's, as multiples of the head's own
 * radius. Full inside the first, none beyond the second, smooth between.
 *
 * The hood and the hair are the head and take all of it. This gradient is left
 * for the arms, which are held at the head by a glove and at the body by a
 * shoulder. The cloth used to take it too, and does not any more — see
 * followAt for why.
 */
const FOLLOW_FULL = 1.05;
const FOLLOW_NONE = 2.30;

/**
 * The rig as it reads for a character facing the other way.
 *
 * Mirroring the picture is half the job. Do only that and the motion comes out
 * backwards — turn your head right and the avatar turns left, raise your left
 * hand and the wrong arm goes up — because every horizontal quantity in the
 * rig is stated in the old character's frame. Read through the same mirror,
 * they land the right way round: signs flip on anything sideways, and the
 * paired channels swap sides, exactly as the tracker's own mirroring already
 * does when it decides whether you get a reflection or a copy.
 *
 * Left alone otherwise. Nodding, blinking, breathing and the scarf have no
 * side to them and must not be touched.
 */
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

const UNIFORMS = [
  'u_model', 'u_modelFar', 'u_aspect', 'u_viewScale', 'u_viewOffset', 'u_tex', 'u_opacity',
  'u_eyesEnabled', 'u_eyeL', 'u_eyeR', 'u_eyeAngle',
  'u_blink', 'u_squint', 'u_wide', 'u_gaze', 'u_glow', 'u_glowPulse', 'u_texel',
  'u_shadow', 'u_shadowOffset', 'u_margin', 'u_marginMax', 'u_lidFill',
];

const SPINE_NODES = 16;
/** How much invented margin a part may draw, in pixels of its texture. */
const MARGIN_FULL = 32;
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

    /* Rigid links, rooted on the shoulder — see LinkChain.
     *
     * tipBias is what makes it read as a chain rather than a flag: the root is
     * held and each link further out carries more of the drive, so the wave
     * arrives late at the tip and keeps going after the head has stopped.
     * Damping is low enough to let it swing back once.
     */
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
    this.squareOn = true;
    this.headOnPhase = 1;
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
    this.squareOn = true;
    this.headOnPhase = 1;
    this.squareSince = 0;
    this.yawHeld = undefined;
    this.faceOn = true;
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

    /* A zero step draws what is already there without advancing anything.
     *
     * Measuring a frame means drawing it several times — once per group of
     * parts being weighed — and every one of those draws used to push the
     * springs, the cloth, the glow and the latch forward by a frame. So the
     * harness that decides whether the model is calm was itself shaking it,
     * and every number this repo has quoted about hand-overs was measured
     * through that. Each integrator below already no-ops at zero; the clamp
     * was the only thing insisting on a minimum.
     */
    dt = dt > 0 ? clamp(dt, 1 / 240, 1 / 15) : 0;
    this.clock += dt;

    const L = this.loc;
    const m = this.model.markers;
    gl.useProgram(this.program);

    /* Facing the other way: the picture through a mirror, the tracking too.
     *
     * Done here rather than per part, because it is the whole character that
     * turns round — parts, joints, cloth, shadows and all — and anything left
     * out of it would be the one piece still facing the old way.
     */
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
    const joints = this.solveJoints(rig, roll, pitch, yaw, m);

    // --- cloth -----------------------------------------------------------
    const proxyX = m.headX + Math.sin(yaw) * 0.09 + rig.head.x * 0.045;
    const proxyY = m.headY - Math.sin(pitch) * 0.06 - rig.head.y * 0.04 + roll * 0.02;
    // Reset together: the checks reset the hair's tracker between poses, and a
    // stale scarf tracker would read the new pose as one enormous jerk.
    if (!this.inertia.seeded) this.clothInertia.reset();
    this.inertia.update(proxyX, proxyY, dt);
    /* Where the head's weight is, so the cloth feels it move.
     *
     * A roll turns the head about the chin, and the middle of the head is a
     * hundred pixels above the chin — so a roll of half a radian carries the
     * head's mass fifty pixels sideways. The proxy above has no term for
     * that, so rolling the head, the one movement that most obviously ought
     * to swing a scarf, drove the chain with nothing at all.
     *
     * The scarf's own tracker, not added to the hair's. The tuft spring was
     * tuned against the turn alone, and with the roll folded in it took three
     * times the drive: at the panel's extremes it railed against its clamp and
     * the hair left the hood, measured as the character in two pieces.
     */
    this.clothInertia.update(proxyX + roll * (m.pivotY - this.headSpan.cy), proxyY, dt);
    const stiff = clamp(store.get('warp.clothStiffness'), 0.1, 4);
    const weight = clamp(store.get('warp.clothWeight'), 0, 3);
    /* Stiffness is the joint spring: how hard each link is pulled back toward
     * the direction it was drawn at. The links themselves never give.
     *
     * "Scarf travel" turned down is a scarf that follows and does not swing.
     * The root is tied to the neck scarf whatever the travel is set to, so at
     * zero the chain still has to go where the neck goes — it just has to get
     * there without a swing to show for it. Stiffer and heavily damped as the
     * travel comes down, so it arrives in a tenth of a second and stops;
     * unchanged from one upward, where the drive is what the slider scales.
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

    // The mouth is under the scarf, so speech shows as the visor glow lifting
    // (and, in solveJoints, a small drop of the head).
    const talk = clamp(rig.mouth?.open ?? 0, 0, 1);
    const flare = clamp(this.inertia.speed * 1.6, 0, 1.4);
    this.glowPulse = damp(this.glowPulse,
      0.82 + 0.18 * Math.sin(this.clock * 1.9) + flare + TALK_GLOW * talk, 9, dt);

    /* How far round to the camera the head has come.
     *
     * Off the size of the turn rather than its direction, so it is the same
     * coming back from either side, and clear of the flip: the drawn view is
     * fully restored before the mirror ever swaps it, or the two would fight
     * over the same few degrees.
     */
    /* Which face, latched — then how fast it changes hands, separately.
     *
     * Hysteresis, for the same reason the flip has it: sitting near the
     * threshold, the smallest wobble in the tracker would hand the face back
     * and forth several times a second. Once it has committed to the drawn
     * view it stays there until the turn comes well back, which is also how a
     * real turn behaves.
     *
     * The handover is then a time rather than a distance, so how fast you turn
     * your head changes when it happens and never how abrupt it looks.
     */
    /* Wider, and it cannot change its mind in a hurry.
     *
     * Measured on a real minute of tracking, the old band changed hands
     * thirty-three times — every other second — and each change drags the eyes
     * bodily across the visor. That is what "the eyes slide on the face" was.
     * Widening alone does not fix it: any threshold has a neighbourhood, and a
     * head that lives near one will cross it all day.
     *
     * So there is also a floor on how soon it may change again. A view that
     * has just been taken up is kept for a moment whatever the angle does,
     * which is the difference between a decision and a flicker.
     */
    const hold = store.get('parts.headOnHold');
    const dwell = store.get('parts.headOnDwell');
    /* Decided on where the head has been, not where it is this instant.
     *
     * A threshold read off the live angle is crossed whenever the head wobbles
     * near it, and a head at a desk wobbles constantly: measured on a real
     * minute, thirty-three changes of view, each one dragging the eyes across
     * the visor. Widening the band moved that to nineteen. It cannot fix it,
     * because the band always has a neighbourhood and this head lives in one.
     *
     * Averaged over about a second, the wobble disappears and a real turn
     * still arrives promptly, because a real turn is sustained and a wobble is
     * not. That is the actual difference between the two, so that is what the
     * test should be on.
     */
    this.yawHeld = damp(this.yawHeld ?? Math.abs(yaw), Math.abs(yaw), 1.6, dt);
    this.squareSince = (this.squareSince ?? 0) + dt;
    const want = this.squareOn ? this.yawHeld < hold : this.yawHeld < hold * 0.5;
    if (want !== this.squareOn && this.squareSince >= dwell) {
      this.squareOn = want;
      this.squareSince = 0;
    }
    /* A ramp of a fixed length, eased at both ends — not a decay.
     *
     * An exponential decay spends most of itself immediately: at a fifth of a
     * second it moves nearly a third of the way in the very first frame, which
     * for eyes crossing a visor is fourteen pixels between one frame and the
     * next and reads as the jump this was meant to remove. Measured, nineteen.
     *
     * Walking a phase at a constant speed and easing it puts the fastest part
     * in the middle and nothing at either end, so the handover starts and
     * finishes invisibly and its worst frame is a third of what the decay's
     * first frame was.
     */
    const step = dt / clamp(store.get('parts.headOnTime'), 0.02, 2);
    this.headOnPhase = clamp(this.headOnPhase + (this.squareOn ? step : -step), 0, 1);
    // A saved value from when this was a slider reads as on above a half.
    const headOnT = this.headOn && Number(store.get('parts.headOn')) >= 0.5
      ? smoothstep(this.headOnPhase) : 0;
    /* The face changes hands rather than fading, for the same reason the
     * mirror does: two copies of hard-edged line art laid over each other are
     * legible as two, and these are two different drawings of a hood, not one
     * drawing with the eyes moved. Halfway through a fade there were plainly
     * two visor rims and two chins.
     *
     * What makes a swap bearable is that it is rare and decided rather than
     * triggered. The latch above averages about a second of angle and will not
     * change its mind again for `headOnDwell` — measured on a real minute of
     * tracking, three times, against thirty-three before it existed.
     */
    /* Which face is showing, kept where anything can read it.
     *
     * Not the same thing as the latch. The latch decides, and the face changes
     * a fraction of a second later when the ramp crosses its middle — so a
     * check watching the latch skips the wrong frame, and reports the change
     * of drawing as a jump in whatever it was measuring. That is exactly what
     * the motion harness did: nine pixels of "eye movement" that was the two
     * faces being different, counted because the latch had already moved on.
     */
    this.faceOn = headOnT >= 0.5;
    const faceOn = this.faceOn;

    const shadowStrength = store.get('parts.contactShadow');

    const order = this.parts;

    // --- draw, back to front ---------------------------------------------
    for (const part of order) {
      gl.uniformMatrix3fv(L.u_model, false, joints[part.joint] ?? IDENTITY);
      gl.uniformMatrix3fv(L.u_modelFar, false,
        joints[part.farJoint ?? part.joint] ?? joints[part.joint] ?? IDENTITY);

      /* Which of the two faces this part belongs to.
       *
       * Nothing is moved. Whichever head is showing is drawn where it was
       * registered, and the other is not drawn at all. What used to be here
       * slid the near shard along the visor toward the head's centre and grew
       * a mirrored copy of it into the far eye — and sliding the eyes across
       * the face was, precisely, the thing being reported.
       */
      const face = part.flags.face;
      if (face === 'headOn' ? !faceOn : face === 'turned' && faceOn) continue;

      const carriesEyes = part.flags.eyes;
      gl.uniform1f(L.u_eyesEnabled, carriesEyes && store.get('warp.eyesEnabled') ? 1 : 0);
      if (carriesEyes) {
        /* One part, one eye.
         *
         * The near shard takes the left channel and the far shard the right,
         * the same pairing the single eye layer used. Both lids are still
         * declared, because the shader has two; the second is parked outside
         * the quad by the bake and its blink is zero, so it does nothing.
         */
        const far = part.flags.far;
        gl.uniform4fv(L.u_eyeL, part.eyeL);
        gl.uniform4fv(L.u_eyeR, part.eyeR);
        gl.uniform1f(L.u_eyeAngle, m.eyeAngle);
        gl.uniform1f(L.u_lidFill, part.lidFill ?? 1);
        // No lid colour: the lid erases this layer and the visor behind shows
        // through, so there is nothing to match a sampled tone against.
        gl.uniform2f(L.u_blink, far ? rig.eyes.blinkR : rig.eyes.blinkL, 0);
        const sq = store.get('warp.squint');
        const squint = clamp((far ? rig.eyes.squintR : rig.eyes.squintL) * sq, 0, 1);
        gl.uniform2f(L.u_squint, squint, 0);
        const wide = far ? rig.eyes.wideR : rig.eyes.wideL;
        gl.uniform2f(L.u_wide, wide, wide);
        const gz = store.get('eyes.gazeGain');
        gl.uniform2f(L.u_gaze, clamp(rig.eyes.gazeX * gz, -1, 1), clamp(rig.eyes.gazeY * gz, -1, 1));
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
      /* How much of the invented margin this part gets to draw.
       *
       * All of it where the parts sit as they were cut and move a little
       * against each other, which is the case it was built for. Almost none of
       * it for a part that has just swapped for its mirror image: that takes
       * it clear across everything behind it, so nothing the margin was
       * painted to hide is where it was, and every pixel of the guess lands
       * somewhere wrong — which is the dark haze that came off the hood and
       * the hair the moment the head turned.
       *
       * Only the parts that moved. The raised fist stays where it was, and its
       * margin is the sleeve: the drawing tucks the arm behind the hood and
       * never draws it, so the margin is the only thing joining the glove to
       * the character. Cut that and the flip leaves a fist floating in space —
       * which is precisely what it did, the first time this was tried on
       * everything at once.
       */
      gl.uniform1f(L.u_marginMax, part.skinned ? store.get('parts.clothMargin') : MARGIN_FULL);

      /* This part's geometry, bound before anything is drawn with it.
       *
       * The shadow pass below used to run before this line, so it drew with
       * whatever the previous part had left bound — its shape, in its place,
       * wearing this part's texture — and for the first part of the frame
       * with nothing bound at all. Every layer's contact shadow was the wrong
       * shadow, which is why the depth it was added for never quite read.
       */
      gl.bindVertexArray(part.vao);

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
      if (shadowStrength > 0 && part.flags.shadow) {
        gl.blendFuncSeparate(gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
        gl.uniform1f(L.u_shadow, shadowStrength);
        gl.uniform2f(L.u_shadowOffset, SHADOW_DIR[0] / part.w, SHADOW_DIR[1] / part.h);
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
      const { binds, live, rest, onChain } = part;
      const skew = this.aspect || 1;
      // The chain's own link length, so the reach below is measured in what
      // the chain is made of rather than in a number typed in for this
      // drawing. Guarded, because a chain of one node has no span.
      const span = Math.max(this.spineSpan || 0, 1e-4);
      // How far past the ends of the chain cloth still follows it, in links.
      const far = Math.max(clamp(store.get('parts.clothReach'), 0.6, 60), 0.6);
      for (let v = 0, b = 0; v < live.length; v += 2, b += 3) {
        const f = spineFrame(this.boneNodes(), binds[b], skew);
        const ox = frameNormalX(f) * binds[b + 1] + f.tx * binds[b + 2];
        const oy = f.ny * binds[b + 1] + f.ty * binds[b + 2];
        /* Only cloth the chain runs through is carried by it.
         *
         * The scarf label holds two pieces of cloth on this drawing: the ribbon,
         * which the chain was laid along, and the sash at the waist with its
         * drape over the hip, which is joined to nothing the chain touches.
         * Binding by distance alone tied the top of that sash to the root of
         * the chain — a link away, so nearly fully carried — while its hem hung
         * three links out and was not. That did nothing while the root stood
         * still. Now the root moves with the neck scarf, and a sash carried at
         * the top and held at the hem is sheared between the two. So a vertex
         * is carried only if the painted cloth nearest it is the ribbon's own,
         * decided by connectivity, and the sash stays with the body.
         */
        const own = onChain ? onChain[v >> 1] : 1;
        /* Cloth the chain does not run through is not swung by it.
         *
         * Only one piece of the scarf gets bones — the run with the most
         * skeleton in it, which on this drawing is the great sweeping arc.
         * Everything else binds to whichever end of that chain is nearest and
         * is carried rigidly, pivoting about a point a long way off, so a
         * small motion at the tip arrives at the hip as a large one. That is
         * the hip being dragged about by the scarf over it.
         *
         * The bind already says which is which. It holds the offset from the
         * chain split into the two directions of the frame there, and how far
         * a point is from the chain is the size of that offset — measured on
         * this artwork, the arc's own cloth sits about one link out, while the
         * cloth that moves most over the hip sits five links out and swings
         * about a frame it is nowhere near.
         *
         * The overshoot past the ends alone is not enough, and the first
         * version of this used only that. It catches cloth hanging off a tip
         * and misses cloth held out sideways from the middle — which on this
         * drawing is the whole of the drape, and every vertex of it came back
         * unchanged.
         *
         * Held whole out to half of `parts.clothReach` and let go of by twice
         * it, which is a calm tail rather than a still one — it keeps the
         * head's own turn through `follow` either way.
         */
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
    /* Nodding turns the head cutout, rather than bending the drawing on it.
     *
     * Everything before this tried to synthesise a view the artwork does not
     * contain — a cylinder, then a rounded shell — and both spent their effort
     * on a face that cannot be shown from another angle because it was only
     * ever drawn from one. What they produced instead was distortion, and a
     * nod whose direction nobody could read.
     *
     * The head is a cutout. A cutout can be turned, and turning is a motion
     * the eye reads instantly and unambiguously — it is why roll always looked
     * right when nothing else did. So a nod rotates it about its own centre,
     * one way for up and the other for down, and nothing is bent at all.
     *
     * The cloth and the arms stay attached without the bend, because what
     * holds them on is the joint blend — each vertex weighted between the neck
     * and the body by where it sits — and that never had anything to do with
     * warping.
     */
    const nod = clamp(-pitch, -1.2, 1.2) * 0.055 * store.get('warp.nod');
    const tilt = clamp(-pitch, -1.2, 1.2) * store.get('parts.nodTurn');
    /* Turning left and right slides the head instead of bending it.
     *
     * With nothing bent there is nothing left to answer a turn, and a head
     * that ignores you turning is worse than one that answers imperfectly.
     * Sliding it is the honest version of what the bend was faking: the
     * drawing has one view of the face, and moving that view across the
     * shoulders reads as a turn without pretending to show a side of it that
     * was never drawn.
     */
    const shift = clamp(yaw, -1.2, 1.2) * 0.05 * store.get('warp.turn');
    const bob = TALK_BOB * clamp(rig.mouth?.open ?? 0, 0, 1);
    const neck = compose(
      hips,
      translate(IDENTITY, shift, nod + bob),
      rotateAbout(roll, m.pivotX, m.pivotY, this.aspect),
      rotateAbout(tilt, this.headSpan.cx, this.headSpan.cy, this.aspect),
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
      /* Whether the head-on face is loaded, and which face is showing.
       *
       * It used to disable itself in silence if the cut came up short, so
       * "the drawing never loaded" and "the latch is changing its mind" looked
       * exactly alike from outside — to me as much as to anyone testing it.
       * Rounds went by arguing about the second when it was the first.
       */
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
