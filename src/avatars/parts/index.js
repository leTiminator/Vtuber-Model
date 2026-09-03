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
import { cutParts } from './cut.js';

/**
 * The two eye shards, each its own part.
 *
 * They were one part with one quad until now, which meant the near eye and the
 * far eye could only ever move together — and on a three-quarter face they are
 * not the same size, not the same distance from the centre, and do not travel
 * the same way as the head comes round. Cut apart they can, and a wink stops
 * being a shape the renderer has no way to draw.
 */
const EYES = new Set(['eyeNear', 'eyeFar']);

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
const BENDS_WITH_HEAD = new Set(
  ['head', 'tufts', 'wrap', 'tails', 'eyeNear', 'eyeFar', 'armLeft', 'armRight']);

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

/**
 * What the mirrored view takes with it: the head cutout and what is drawn on
 * it. The hair is part of the head; the neck wrap is cloth that continues into
 * the scarf, and mirroring half a scarf would tear it off the shoulders.
 *
 * The raised fist goes too, and has to. It is drawn against the cheek, and the
 * drawing tucks the rest of that arm behind the hood and never draws it — so
 * once the head swaps sides there is nothing joining the glove to anything,
 * and it hangs in mid-air beside a face turned the other way. Mirrored, it
 * lands where the opposite three-quarter view puts it: on the far side of the
 * head, behind the scarf. The other arm reaches down across the body and stays
 * where it is.
 */
const FLIPS_WITH_HEAD = new Set(['head', 'tufts', 'eyeNear', 'eyeFar', 'armRight']);

/**
 * Whose weight decides where the mirror's axis falls.
 *
 * The head, the hair and the eyes — the thing a viewer watches. Reflecting a
 * group about its own centre of mass turns it without moving it, and that is
 * the whole reason the axis is measured rather than taken as the head's own
 * middle: measured wrong, the swap slides the face sideways mid-turn.
 *
 * The fist rides along but does not get a vote. It is a small piece far off to
 * one side, and letting it pull the axis moved the head sixteen pixels in the
 * single degree where the swap happens — a lurch on the part of the model
 * people are looking at, to keep a glove company.
 */
const FLIP_AXIS = new Set(['head', 'tufts', 'eyeNear', 'eyeFar']);

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
import { ChainField, HeadInertia } from '../warp2d/cloth.js';
import { detectMarkers, readPixels, sampleLidColours } from '../warp2d/segment.js';
import { parseRect } from '../warp2d/index.js';
import { extractSpine } from './spine.js';
import { depthAt, flipAxisOf, shellFrom } from './shell.js';

const UNIFORMS = [
  'u_model', 'u_modelFar', 'u_aspect', 'u_warp', 'u_headCenter', 'u_cylR', 'u_yaw', 'u_pitch',
  'u_viewScale', 'u_viewOffset', 'u_tex', 'u_opacity',
  'u_eyesEnabled', 'u_eyeL', 'u_eyeR', 'u_eyeAngle',
  'u_blink', 'u_squint', 'u_wide', 'u_gaze', 'u_glow', 'u_glowPulse', 'u_texel',
  'u_shadow', 'u_shadowOffset', 'u_margin', 'u_marginMax',
  'u_flip', 'u_flipAxis', 'u_place', 'u_flipSlide',
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
    // Which face is showing, and how far through changing hands it is. Latched
    // rather than derived from the angle every frame — see the note in render.
    this.squareOn = true;
    this.headOnPhase = 1;
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
      gl.deleteTexture(old.marginTex);
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
    // The axis a mirror pivots on: the weight of everything that mirrors.
    this.flipAxis = flipAxisOf(parts.filter((p) => FLIP_AXIS.has(p.name)), width)
      ?? this.headSpan.cx;

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

    this.headOn = this.solveHeadOn(this.parts);

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
    if (name === 'head' || name === 'tufts' || EYES.has(name)) return 1;
    if (name === 'body') return 0;
    const h = this.headSpan;
    const d = Math.hypot((px - h.cx) * this.aspect, py - h.cy) / Math.max(h.r, 1e-4);
    const t = clamp((d - FOLLOW_FULL) / (FOLLOW_NONE - FOLLOW_FULL), 0, 1);
    return 1 - t * t * (3 - 2 * t); // smoothstep, so there is no crease
  }

  upload(part, width, height, m, sockets) {
    const gl = this.gl;

    /* The distance field beside the colour, so the invented margin can be cut
     * back per draw. One byte a pixel, nearest-sampled — it is a measurement,
     * not a picture, and interpolating it across the boundary between two
     * parts would blur the very thing it is there to tell apart.
     */
    const marginTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, marginTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, part.w, part.h, 0, gl.RED,
      gl.UNSIGNED_BYTE, part.margin ?? new Uint8Array(part.w * part.h));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);

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
      texture, marginTex, vao, indexCount: idx.length, skinned, cylR,
      // Skinning happens on the CPU — see skinCloth. The bind stays here
      // because that is where it is now used.
      posBuffer,
      binds: skinned ? new Float32Array(bindData) : null,
      live: skinned ? new Float32Array(pos) : null,
      // Where the cloth was drawn, and how much of the head each point takes.
      // Both are needed on the CPU to taper the chain out at the neck — see
      // skinCloth.
      rest: skinned ? new Float32Array(pos) : null,
      follows: skinned ? new Float32Array(followData) : null,
      ...this.socketOf(part, sockets, width, height, fromBox, fromMarker, m),
    };
  }

  /**
   * Which socket belongs to a part, and where the other lid goes.
   *
   * Each eye is now its own part, so each carries one lid. Matching is by
   * position rather than by order: both the cut and the socket measurement
   * sort their shards biggest-first, but they sort at different stages — the
   * cut before its mask is filled, the sockets after — and two shards close in
   * size could come back swapped. Asking which socket lands inside this part's
   * own box cannot be wrong.
   *
   * The unused lid is parked far outside the quad, where `lidded` returns
   * early. Pointing it at the same socket instead would apply the sweep twice
   * and square its soft edge.
   */
  socketOf(part, sockets, width, height, fromBox, fromMarker, m) {
    const AWAY = [-9, -9, 1, 1];
    if (!EYES.has(part.name)) {
      return {
        eyeL: sockets?.[0] ? fromBox(sockets[0]) : fromMarker(m.eyeL),
        eyeR: sockets?.[1] ? fromBox(sockets[1]) : fromMarker(m.eyeR),
      };
    }
    const cx = part.x + part.w / 2;
    const cy = part.y + part.h / 2;
    let best = null;
    let bestD = Infinity;
    for (const b of sockets ?? []) {
      const d = Math.hypot(b.cx * width - cx, b.cy * height - cy);
      if (d < bestD) { bestD = d; best = b; }
    }
    const own = best ? fromBox(best)
      : fromMarker(part.name === 'eyeNear' ? m.eyeL : m.eyeR);
    // Kept in image space too: the head-on view is assembled from where these
    // two shards sit relative to each other and to the head.
    return { eyeL: own, eyeR: AWAY, socket: best ?? null };
  }

  /**
   * Where the eyes go when the head comes round to face the camera.
   *
   * Everything here is measured off the two shards the cut found and the head
   * cutout's own centre of mass. Nothing is a number typed in for this one
   * drawing, so a different character with two eye shards gets a head-on view
   * out of the same code.
   *
   * The rules, and why each one:
   *
   * - **Centred on the head.** What reads as facing you is the eyes sitting in
   *   the middle of the head, not their spacing. In the artwork the pair sits
   *   eleven per cent of a head-width off to one side; head-on it sits on the
   *   centre line.
   * - **The drawn spacing, kept.** Two points on a turned head separate as
   *   `2R sin(theta) cos(yaw)`, so head-on they should be about a fifth wider
   *   than drawn — but that is only true of a head-on hood, and the hood here
   *   stays the three-quarter cutout. Spread to the true head-on spacing on a
   *   foreshortened visor and the far eye climbs over the rim; rendered and
   *   looked at, that is exactly what it did.
   * - **The far eye is the near one, mirrored.** The far shard is thirteen
   *   pixels of sliver at the edge of the visor. Stretched five times to fill
   *   a socket it would be a smear. The near shard is a whole crescent that
   *   solves to seven degrees off square-on, so its mirror image is the far
   *   eye, in the artist's own line.
   */
  solveHeadOn(parts) {
    const near = parts.find((p) => p.name === 'eyeNear')?.socket;
    const far = parts.find((p) => p.name === 'eyeFar')?.socket;
    if (!near || !far || !this.headSpan) return null;
    const half = (far.cx - near.cx) / 2;
    return {
      // Where each eye ends up, straddling the head's own centre.
      nearX: this.headSpan.cx - half,
      farX: this.headSpan.cx + half,
      farY: near.cy,
      near, far,
      // What the far shard is, as a fraction of the near one, so the mirrored
      // copy can start out sitting exactly on it and grow into its place.
      startX: Math.max(far.hx / Math.max(near.hx, 1e-6), 1e-3),
      startY: Math.max(far.hy / Math.max(near.hy, 1e-6), 1e-3),
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
    /* Hysteresis, so a head held near the threshold does not flicker.
     *
     * A snap needs it and a fade did not: sitting at the angle where the swap
     * happens, the smallest wobble in the tracker would hand the drawing back
     * and forth several times a second. Once flipped it stays flipped until
     * the turn comes well back, which is also how a real turn behaves — you
     * do not un-turn by two degrees.
     */
    /* Signed, not absolute.
     *
     * This latched on how far the head had turned and then applied the mirror
     * only when it had turned the wrong way, which are two different questions.
     * Turning right past the threshold armed it, and swinging back through
     * centre then flipped the head at eleven degrees instead of seventeen —
     * an early flip in the middle of an ordinary look around the room. Only
     * one direction needs the mirror, so only that direction should arm it.
     */
    this.mirrored = this.mirrored ? yaw < -start * 0.55 : yaw < -start;
    const mirror = this.mirrored ? store.get('parts.flipTurn') : 0;

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
    const hold = store.get('parts.headOnHold');
    this.squareOn = this.squareOn ? Math.abs(yaw) < hold : Math.abs(yaw) < hold * 0.55;
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
    const headOnT = this.headOn
      ? smoothstep(this.headOnPhase) * clamp(store.get('parts.headOn'), 0, 1)
      : 0;
    /* The far shard leaves before its replacement is fully there.
     *
     * Two copies of hard-edged line art at half opacity read as two, which is
     * the fault the head's own cross-fade was replaced for. They get away with
     * it here because they overlap: the mirrored copy starts out sitting on
     * the sliver at the sliver's own size and grows out of it, so through the
     * hand-over there is one shape in one place, not two side by side.
     */
    const twinIn = smoothstep(clamp((headOnT - 0.10) / 0.45, 0, 1));
    const farOut = 1 - smoothstep(clamp((headOnT - 0.06) / 0.36, 0, 1));

    /* How far the swap moves the head, for everything left behind to follow.
     *
     * The mirror is about the group's balance point, so the group does not
     * move — but the head's own middle does, by twice its offset from that
     * axis. Anything holding on to the head has to go the same distance or the
     * seam opens, which is what the neck wrap was doing.
     */
    const flipSlide = this.mirrored && this.headSpan
      ? 2 * (this.flipAxis - this.headSpan.cx) : 0;

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
      /* What the mirror takes with it: the head and everything drawn on it.
       *
       * The eyes especially. They are a separate layer so a lid can erase
       * them, not because they are a separate object — leave them behind and
       * the face does not follow the head across.
       */
      const flips = FLIPS_WITH_HEAD.has(part.name) && mirror > 0.5;
      // Nothing bends any more; the head turns instead. Kept behind a setting
      // rather than deleted, so the two can still be compared.
      const bends = BENDS_WITH_HEAD.has(part.name) && store.get('parts.bendHead') > 0;
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

      /* The near eye slides onto the head's centre line as the face comes
       * round; every other part stays exactly where it was cut from.
       *
       * Named apart from the flip's own slide on purpose. They were both
       * called `slide`, one inside the loop and one outside it, and the inner
       * one quietly won: the eyes took their slide twice over and walked off
       * the side of the visor, and the flip's slide reached nothing at all —
       * so the fix it was written for was never running.
       */
      const eyeSlide = this.headOn && part.name === 'eyeNear'
        ? headOnT * (this.headOn.nearX - this.headOn.near.cx) : 0;
      gl.uniform4f(L.u_place, 1, eyeSlide, 1, 0);

      const carriesEyes = EYES.has(part.name);
      gl.uniform1f(L.u_eyesEnabled, carriesEyes && store.get('warp.eyesEnabled') ? 1 : 0);
      if (carriesEyes) {
        /* One part, one eye.
         *
         * The near shard takes the left channel and the far shard the right,
         * the same pairing the single eye layer used. Both lids are still
         * declared, because the shader has two; the second is parked outside
         * the quad by `socketOf` and its blink is zero, so it does nothing.
         */
        const far = part.name === 'eyeFar';
        gl.uniform4fv(L.u_eyeL, part.eyeL);
        gl.uniform4fv(L.u_eyeR, part.eyeR);
        gl.uniform1f(L.u_eyeAngle, m.eyeAngle);
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

      // The group's centre of mass, so a mirror turns it without moving it.
      gl.uniform1f(L.u_flipAxis, this.flipAxis);
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
      gl.uniform1f(L.u_marginMax,
        flips ? store.get('parts.flipMargin') : store.get('parts.margin'));

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
      if (shadowStrength > 0 && SHADOWS.has(part.name)) {
        gl.blendFuncSeparate(gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
        gl.uniform1f(L.u_shadow, shadowStrength);
        gl.uniform2f(L.u_shadowOffset, SHADOW_DIR[0] / part.w, SHADOW_DIR[1] / part.h);
        gl.uniform1f(L.u_flip, flips ? 1 : 0);
        gl.uniform1f(L.u_flipSlide, flips ? 0 : flipSlide);
        gl.uniform1f(L.u_opacity, 1);
        gl.drawElements(gl.TRIANGLES, part.indexCount, gl.UNSIGNED_SHORT, 0);
        gl.uniform1f(L.u_shadow, 0);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }

      /* Turning past a threshold swaps the head for its mirror image.
       *
       * For a character drawn at three-quarters, the mirror IS the opposite
       * three-quarter view — far closer to the truth than warping toward a
       * view the drawing does not contain.
       *
       * It swaps rather than cross-fades. The fade was an attempt to avoid a
       * pop and it bought a worse fault: two copies of hard-edged line art
       * laid over each other are legible as two, and halfway through the turn
       * the visor plainly had two outlines and two rims. Nothing about a fade
       * makes that read as one head. The eyes have snapped since they were
       * separated for exactly this reason, and now the head does too — which
       * is only viable because the cutout no longer bends, so the two copies
       * are the same shape and the swap has nothing to give itself away with
       * except the drawing changing hands.
       */
      gl.uniform1f(L.u_flip, flips ? 1 : 0);
      gl.uniform1f(L.u_flipSlide, flips ? 0 : flipSlide);
      gl.uniform1f(L.u_opacity, part.name === 'eyeFar' ? farOut : 1);
      gl.drawElements(gl.TRIANGLES, part.indexCount, gl.UNSIGNED_SHORT, 0);

      /* The far eye, built from the near one.
       *
       * Same buffers, same texture, drawn a second time through a mirrored
       * transform — so it costs one more draw call and not one more part, and
       * it cannot drift out of step with the eye it is a copy of.
       *
       * It starts life at the far shard's own position and size and grows into
       * the socket as the head comes round, which is what the far eye actually
       * does: it opens out of the rim rather than appearing beside it.
       */
      if (part.name === 'eyeNear' && this.headOn && twinIn > 0.001) {
        const g = this.headOn;
        const t = headOnT;
        const sx = lerp(g.startX, store.get('parts.headOnTwin'), t);
        const sy = lerp(g.startY, store.get('parts.headOnTwin'), t);
        const cx = lerp(g.far.cx, g.farX, t);
        const cy = lerp(g.far.cy, g.farY, t);
        // Mirror about the shard's own centre, then land that centre on cx.
        gl.uniform4f(L.u_place, -sx, cx + sx * g.near.cx, sy, cy - sy * g.near.cy);
        gl.uniform1f(L.u_opacity, twinIn);
        // Its lid is the near eye's socket in the near eye's texture, driven
        // by the far eye's blink. Mirrored, so the lid's slant mirrors too.
        gl.uniform2f(L.u_blink, rig.eyes.blinkR, 0);
        gl.uniform1f(L.u_eyeAngle, -m.eyeAngle);
        const sq = store.get('warp.squint');
        gl.uniform2f(L.u_squint, clamp(rig.eyes.squintR * sq, 0, 1), 0);
        gl.uniform2f(L.u_wide, rig.eyes.wideR, rig.eyes.wideR);
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
      const { binds, live, rest, follows } = part;
      const skew = this.aspect || 1;
      for (let v = 0, b = 0; v < live.length; v += 2, b += 3) {
        const f = spineFrame(this.boneNodes(), binds[b], skew);
        const ox = frameNormalX(f) * binds[b + 1] + f.tx * binds[b + 2];
        const oy = f.ny * binds[b + 1] + f.ty * binds[b + 2];
        /* The chain lets go at the neck.
         *
         * The scarf is one piece of cloth cut in two: what hugs the neck rides
         * with the head, the rest swings on the chain. Both halves take the
         * head's turn through the same weight, so the joints agree at the
         * seam — but only one of them was also being carried by the chain, and
         * it was being carried all the way up to the cut. So the two halves
         * sheared along that line every time the cloth moved, and what showed
         * was a hard straight edge across the scarf beside the neck with the
         * darker paint underneath laid bare. It is not a gap, which is why the
         * check for the halves coming apart never saw it.
         *
         * The same weight settles it. Where a point takes all of the head's
         * turn it takes none of the chain, which is exactly what the other
         * half of the seam does; where it has left the head it takes all of
         * the chain. In between it is a gradient rather than a cut, and cloth
         * wrapped round a neck does not flap at the neck anyway.
         */
        const loose = 1 - (follows ? follows[v >> 1] : 0);
        const sx = f.hx + ox / skew;
        const sy = f.hy + oy;
        live[v] = rest[v] + (sx - rest[v]) * loose;
        live[v + 1] = rest[v + 1] + (sy - rest[v + 1]) * loose;
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
    const neck = compose(
      hips,
      translate(IDENTITY, shift, nod),
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
