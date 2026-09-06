/** The scarf's motion: a chain of rigid links, and the head inertia that drives it. */
import { clamp } from '../../core/math.js';

const FIXED_DT = 1 / 120;
// How much of a joint's excess fold is taken back in one step — see unfold().
const UNFOLD = 0.8;

/**
 * Tracks how hard the head is being thrown around, which is what drives the
 * cloth. Returns acceleration in UV units per second squared.
 */
export class HeadInertia {
  constructor() {
    this.px = 0;
    this.py = 0;
    this.vx = 0;
    this.vy = 0;
    this.ax = 0;
    this.ay = 0;
    this.speed = 0;
    this.seeded = false;
  }

  /** Forget the motion so far, and re-seed from wherever the head is next. */
  reset() {
    this.vx = 0; this.vy = 0;
    this.ax = 0; this.ay = 0;
    this.speed = 0;
    this.seeded = false;
  }

  update(x, y, dt) {
    if (dt <= 0) return this;
    // Without seeding, the first frame reads as a jump from the origin to the
    // head and reports an enormous acceleration, which detonates the cloth.
    if (!this.seeded) {
      this.px = x;
      this.py = y;
      this.seeded = true;
      return this;
    }
    const vx = (x - this.px) / dt;
    const vy = (y - this.py) / dt;
    // Smooth the derivative; raw frame-to-frame velocity is far too noisy to
    // differentiate a second time.
    const sx = this.vx * 0.7 + vx * 0.3;
    const sy = this.vy * 0.7 + vy * 0.3;
    this.ax = (sx - this.vx) / dt;
    this.ay = (sy - this.vy) / dt;
    this.vx = sx;
    this.vy = sy;
    this.px = x;
    this.py = y;
    this.speed = Math.hypot(sx, sy);
    return this;
  }
}

/** A chain of rigid links: it bends, and it does not stretch. */
export class LinkChain {
  /**
   * @param {object} opts
   * @param {number} opts.nodes    samples along the length, including the root
   * @param {number} opts.pinned   how many of those are placed rather than simulated
   * @param {number} opts.bend     spring at each joint, toward the drawn direction
   * @param {number} opts.rest     pull toward the drawn position, carried with the root
   * @param {number} opts.damping  velocity bleed, per second
   * @param {number} opts.tipBias  how much more the tip is driven than the root
   * @param {number} opts.carry    how many free links the root's own rotation reaches
   * @param {number} opts.friction how fast neighbours moving differently are evened out, per second
   * @param {number} opts.maxStep  how far a node may travel in one sub-step, in link lengths
   * @param {number} opts.limit    how far any node may leave the drawing, in UV, carried with the root
   * @param {number} opts.maxFold  how far a joint may fold past its drawn angle before it is eased back, radians
   */
  constructor({ nodes = 16, pinned = 2, bend = 160, rest = 14, damping = 3, tipBias = 3,
    carry = 3, friction = 12, maxStep = 0.3, limit = 0.17, maxFold = 0.6 } = {}) {
    this.nodes = nodes;
    this.pinned = Math.max(1, Math.min(pinned, nodes - 1));
    this.bend = bend;
    this.rest = rest;
    this.damping = damping;
    this.tipBias = tipBias;
    this.carry = carry;
    this.friction = friction;
    this.maxStep = maxStep;
    this.limit = limit;
    this.maxFold = maxFold;
    this.aspect = 1;
    this.twist = 0;

    // Where it was drawn, in square space: position, link length, direction,
    // and the angle each joint was drawn at relative to the one before.
    this.rx = new Float32Array(nodes);
    this.ry = new Float32Array(nodes);
    this.len = new Float32Array(nodes);
    this.dirx = new Float32Array(nodes);
    this.diry = new Float32Array(nodes);
    this.joint = new Float32Array(nodes);

    this.px = new Float32Array(nodes);
    this.py = new Float32Array(nodes);
    this.qx = new Float32Array(nodes);
    this.qy = new Float32Array(nodes);
    this.nx = new Float32Array(nodes); // scratch: wanted link directions
    this.ny = new Float32Array(nodes);
    this.ox = new Float32Array(nodes); // scratch: next positions
    this.oy = new Float32Array(nodes);
    this.out = new Float32Array(nodes * 2);
    this.accumulator = 0;
    this.clock = 0;
    this.hasRest = false;
  }

  /**
   * Where the ribbon was drawn: its nodes as [x, y] in image UV, and the image's
   * aspect so distances are measured in a space where circles are round.
   */
  setRest(nodes, aspect = 1) {
    const n = Math.min(this.nodes, nodes.length);
    this.aspect = aspect || 1;
    for (let i = 0; i < n; i++) {
      this.rx[i] = nodes[i][0] * this.aspect;
      this.ry[i] = nodes[i][1];
    }
    for (let i = 1; i < n; i++) {
      const dx = this.rx[i] - this.rx[i - 1];
      const dy = this.ry[i] - this.ry[i - 1];
      const d = Math.hypot(dx, dy) || 1e-6;
      this.len[i] = d;
      this.dirx[i] = dx / d;
      this.diry[i] = dy / d;
    }
    for (let i = 2; i < n; i++) {
      this.joint[i] = wrapAngle(Math.atan2(this.diry[i], this.dirx[i])
        - Math.atan2(this.diry[i - 1], this.dirx[i - 1]));
    }
    this.hasRest = n >= 2;
    this.reset();
  }

  configure({ bend, rest, damping }) {
    // Verlet at 120 steps a second is unconditionally fine well past these.
    if (Number.isFinite(bend)) this.bend = clamp(bend, 0, 4000);
    if (Number.isFinite(rest)) this.rest = clamp(rest, 0, 4000);
    if (Number.isFinite(damping)) this.damping = clamp(damping, 0, 60);
  }

  /**
   * @param {number} fx,fy  driving force this frame, in UV units per second^2
   * @param {number} wind   wind amplitude, in the same units
   * @param {number} dt     seconds since the last frame
   * @param {Float32Array|null} pin  column-major 3x3 in image UV that places the
   *   pinned nodes — what the root of the ribbon is tied to. Null leaves them
   *   where they were drawn.
   * @returns {Float32Array} displacement of every node from where it was drawn, UV
   */
  step(fx, fy, wind, dt, pin = null) {
    if (!this.hasRest) return this.out;
    this.clock += dt;
    this.place(pin);
    // Fixed sub-steps so behaviour is identical at any frame rate, and a long
    // frame after a tab switch cannot blow the chain up.
    this.accumulator = Math.min(this.accumulator + dt, 0.25);
    while (this.accumulator >= FIXED_DT) {
      this.integrate(fx * this.aspect, fy, wind, FIXED_DT);
      this.accumulator -= FIXED_DT;
    }
    // With no time to integrate, the root may still have moved: the links
    // follow it rigidly rather than tearing, so a zero-length step draws a
    // chain that is still a chain.
    this.tighten();
    for (let i = 0; i < this.nodes; i++) {
      this.out[i * 2] = (this.px[i] - this.rx[i]) / this.aspect;
      this.out[i * 2 + 1] = this.py[i] - this.ry[i];
    }
    return this.out;
  }

  /** The pinned nodes go where the cloth they grow out of puts them. */
  place(pin) {
    const a = this.aspect;
    for (let i = 0; i < this.pinned; i++) {
      let X = this.rx[i];
      let Y = this.ry[i];
      if (pin) {
        const x = X / a;
        X = (pin[0] * x + pin[3] * Y + pin[6]) * a;
        Y = pin[1] * x + pin[4] * Y + pin[7];
      }
      this.px[i] = X; this.py[i] = Y;
      this.qx[i] = X; this.qy[i] = Y;
    }
    // How far the root has turned, read off the transform in square space,
    // which is what the links downstream inherit a share of.
    this.twist = pin ? Math.atan2(pin[1] * a, pin[0]) : 0;
  }

  integrate(FX, FY, wind, h) {
    const n = this.nodes;
    const p = this.pinned;
    const { px, py, qx, qy, ox, oy, rx, ry, len, dirx, diry } = this;
    // The drawn pose travels with the root, so a head held to one side holds
    // the whole ribbon there rather than leaving its tail behind.
    const dax = px[0] - rx[0];
    const day = py[0] - ry[0];
    const keep = Math.max(0, 1 - this.damping * h);

    // The direction each link was drawn at, turned by however much of the
    // root's rotation reaches that far out.
    const { nx: wantx, ny: wanty } = this;
    for (let i = p; i < n; i++) {
      const g = clamp(1 - (i - p + 1) / (this.carry + 1), 0, 1);
      const tw = this.twist * g;
      const c = Math.cos(tw);
      const s = Math.sin(tw);
      wantx[i] = dirx[i] * c - diry[i] * s;
      wanty[i] = dirx[i] * s + diry[i] * c;
    }
    for (let i = 1; i < p; i++) { wantx[i] = dirx[i]; wanty[i] = diry[i]; }

    /* Every node reads the positions from before this step, so the coupling
     * is symmetric, and every joint pulls BOTH its nodes.
     */
    for (let i = p; i < n; i++) {
      const t = i / (n - 1);
      const weight = 1 + (this.tipBias - 1) * t * t;

      // Where the joint above wants this node, and where the joint below does.
      let jx = (px[i - 1] + wantx[i] * len[i]) - px[i];
      let jy = (py[i - 1] + wanty[i] * len[i]) - py[i];
      if (i < n - 1) {
        jx += (px[i + 1] - wantx[i + 1] * len[i + 1]) - px[i];
        jy += (py[i + 1] - wanty[i + 1] * len[i + 1]) - py[i];
      }

      // Two-frequency wind, so idle motion never looks like a metronome.
      const phase = this.clock * 1.7 + t * 4.2;
      const windX = (Math.sin(phase) + 0.45 * Math.sin(phase * 2.3 + 1.1)) * wind;
      const windY = Math.cos(phase * 0.8 + 0.5) * wind * 0.45;

      const ax = this.bend * jx + this.rest * (rx[i] + dax - px[i]) + (FX + windX) * weight;
      const ay = this.bend * jy + this.rest * (ry[i] + day - py[i]) + (FY + windY) * weight;
      // This step's travel, before it is spent against the neighbours.
      ox[i] = (px[i] - qx[i]) * keep + ax * h * h;
      oy[i] = (py[i] - qy[i]) * keep + ay * h * h;
    }

    /* Friction between neighbours, and a ceiling on how far any node may go in one step. */
    const rub = clamp(this.friction * h, 0, 1) * 0.5;
    for (let i = p + 1; i < n; i++) {
      const dvx = (ox[i] - ox[i - 1]) * rub;
      const dvy = (oy[i] - oy[i - 1]) * rub;
      ox[i] -= dvx; oy[i] -= dvy;
      ox[i - 1] += dvx; oy[i - 1] += dvy;
    }
    for (let i = p; i < n; i++) {
      const most = len[i] * this.maxStep;
      const went = Math.hypot(ox[i], oy[i]);
      if (went > most) { ox[i] *= most / went; oy[i] *= most / went; }
      qx[i] = px[i]; qy[i] = py[i];
      px[i] += ox[i]; py[i] += oy[i];
      /* And a ceiling on how far any node may leave the drawing. */
      const ex = px[i] - (rx[i] + dax);
      const ey = py[i] - (ry[i] + day);
      const far = Math.hypot(ex, ey);
      if (far > this.limit) {
        const k = 1 - this.limit / far;
        px[i] -= ex * k; py[i] -= ey * k;
      }
    }
    this.unfold();
    this.tighten();
  }

  /** Ease any joint folded too far past its drawn angle back toward it. */
  unfold() {
    const n = this.nodes;
    const p = this.pinned;
    const { px, py, qx, qy, len, joint } = this;
    for (let i = Math.max(p, 2); i < n; i++) {
      const parent = Math.atan2(py[i - 1] - py[i - 2], px[i - 1] - px[i - 2]);
      const here = Math.atan2(py[i] - py[i - 1], px[i] - px[i - 1]);
      const fold = wrapAngle(here - parent - joint[i]);
      if (Math.abs(fold) <= this.maxFold) continue;
      const ang = here - (fold - Math.sign(fold) * this.maxFold) * UNFOLD;
      const nx = px[i - 1] + Math.cos(ang) * len[i];
      const ny = py[i - 1] + Math.sin(ang) * len[i];
      // Carried on the previous position too, so the move changes where the
      // node is and not how fast it is going: a correction the integrator
      // read as velocity doubled the swing after a yank.
      qx[i] += nx - px[i]; qy[i] += ny - py[i];
      px[i] = nx; py[i] = ny;
    }
  }

  /** Put every link back to its drawn length, root outward. */
  tighten() {
    const n = this.nodes;
    const p = this.pinned;
    const { px, py, len } = this;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = p; i < n; i++) {
        const dx = px[i] - px[i - 1];
        const dy = py[i] - py[i - 1];
        const k = len[i] / (Math.hypot(dx, dy) || 1e-9);
        px[i] = px[i - 1] + dx * k;
        py[i] = py[i - 1] + dy * k;
      }
    }
  }

  reset() {
    this.px.set(this.rx); this.py.set(this.ry);
    this.qx.set(this.rx); this.qy.set(this.ry);
    this.accumulator = 0;
    this.twist = 0;
  }
}

/** Into (-PI, PI]. */
function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}
