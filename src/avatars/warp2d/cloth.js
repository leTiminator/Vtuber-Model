/**
 * Secondary motion for cloth and hair, solved as a displacement field rather
 * than as geometry.
 *
 * The artwork already shows the scarf where the artist drew it, so what is
 * needed is not "where does the scarf hang" but "how far is each point along it
 * from where it was drawn". Simulating displacement directly means the rest
 * state is exactly the original drawing — no gravity sag to cancel out, and
 * nothing to line up against the art.
 *
 * Each node is pulled two ways: toward the node before it, which propagates
 * motion outward as a travelling wave, and back toward zero, which returns it
 * to the drawn pose. Driving force is the inertia of the head it is attached to,
 * plus a little wind so a motionless streamer still has a moving scarf.
 */
import { clamp } from '../../core/math.js';

const FIXED_DT = 1 / 120;

export class ChainField {
  /**
   * @param {object} opts
   * @param {number} opts.nodes    samples along the length, including the anchor
   * @param {number} opts.chain    coupling to the previous node — wave speed
   * @param {number} opts.rest     pull back toward the drawn pose
   * @param {number} opts.damping  velocity bleed
   * @param {number} opts.tipBias  how much more the tip moves than the base
   */
  constructor({ nodes = 16, chain = 260, rest = 34, damping = 5.2, tipBias = 1.8 } = {}) {
    this.nodes = nodes;
    this.chain = chain;
    this.rest = rest;
    this.damping = damping;
    this.tipBias = tipBias;

    this.dx = new Float32Array(nodes);
    this.dy = new Float32Array(nodes);
    this.vx = new Float32Array(nodes);
    this.vy = new Float32Array(nodes);
    this.out = new Float32Array(nodes * 2);
    this.accumulator = 0;
    this.clock = 0;
  }

  configure({ chain, rest, damping }) {
    if (Number.isFinite(chain)) this.chain = chain;
    if (Number.isFinite(rest)) this.rest = rest;
    if (Number.isFinite(damping)) this.damping = damping;
  }

  /**
   * @param {number} fx,fy  driving force this frame, in UV units per second^2
   * @param {number} wind   wind amplitude
   * @param {number} dt     seconds since the last frame
   */
  step(fx, fy, wind, dt) {
    this.clock += dt;
    // Fixed sub-steps so behaviour is identical at any frame rate, and a long
    // frame after a tab switch cannot blow the chain up.
    this.accumulator = Math.min(this.accumulator + dt, 0.25);
    while (this.accumulator >= FIXED_DT) {
      this.integrate(fx, fy, wind, FIXED_DT);
      this.accumulator -= FIXED_DT;
    }
    for (let i = 0; i < this.nodes; i++) {
      this.out[i * 2] = this.dx[i];
      this.out[i * 2 + 1] = this.dy[i];
    }
    return this.out;
  }

  integrate(fx, fy, wind, h) {
    const n = this.nodes;
    const { dx, dy, vx, vy } = this;

    // The anchor never moves relative to what it is bolted to.
    dx[0] = 0; dy[0] = 0; vx[0] = 0; vy[0] = 0;

    // Read positions from the previous state, so every node sees the same
    // configuration. Updating in place makes the coupling asymmetric, which is
    // exactly the failure this replaced.
    const px = this.px ?? (this.px = new Float32Array(n));
    const py = this.py ?? (this.py = new Float32Array(n));
    px.set(dx);
    py.set(dy);

    for (let i = 1; i < n; i++) {
      const t = i / (n - 1);
      const weight = 1 + (this.tipBias - 1) * t * t;

      // Two-frequency wind, so idle motion never looks like a metronome.
      const phase = this.clock * 1.7 + t * 4.2;
      const windX = (Math.sin(phase) + 0.45 * Math.sin(phase * 2.3 + 1.1)) * wind;
      const windY = Math.cos(phase * 0.8 + 0.5) * wind * 0.45;

      // Pulled toward BOTH neighbours, not just the previous one.
      //
      // A one-way follower chain looks like cloth but is not: each node chases
      // the one before it, and because each stage is underdamped it overshoots
      // by half again. Over fifteen nodes that compounds into runaway. Coupling
      // both ways is a real spring chain — conservative, so it carries a wave
      // down the length instead of amplifying it.
      const upX = px[i - 1] - px[i];
      const upY = py[i - 1] - py[i];
      const downX = (i < n - 1 ? px[i + 1] : px[i]) - px[i];
      const downY = (i < n - 1 ? py[i + 1] : py[i]) - py[i];

      const ax = (upX + downX) * this.chain - px[i] * this.rest
        - vx[i] * this.damping + (fx + windX) * weight;
      const ay = (upY + downY) * this.chain - py[i] * this.rest
        - vy[i] * this.damping + (fy + windY) * weight;

      vx[i] += ax * h;
      vy[i] += ay * h;
      dx[i] += vx[i] * h;
      dy[i] += vy[i] * h;
    }

    // Cap the displacement, and cancel the velocity pushing into the cap.
    //
    // Clamping position alone is a trap: the position pins at the boundary but
    // the velocity survives, so every step shoves it back out and the chain
    // sits railed instead of relaxing.
    /* Two limits, and the second matters more.
     *
     * How far the whole chain may travel is a backstop against divergence.
     * How far NEIGHBOURING nodes may differ is what keeps it cloth: the art is
     * skinned to this chain, so a gap between adjacent nodes stretches the
     * ribbon between them. Let that grow and the scarf pulls thin like taffy
     * and tears off the neck — which is what real tracking did to it, because
     * real head motion is jerky where a synthetic sweep is smooth, so the
     * driving forces spike far higher than anything it was tuned against.
     *
     * A chain bends. It does not stretch.
     */
    const LIMIT = 0.17;
    const MAX_BEND = 0.011;
    for (let i = 1; i < n; i++) {
      if (dx[i] > LIMIT) { dx[i] = LIMIT; if (vx[i] > 0) vx[i] = 0; }
      else if (dx[i] < -LIMIT) { dx[i] = -LIMIT; if (vx[i] < 0) vx[i] = 0; }
      if (dy[i] > LIMIT) { dy[i] = LIMIT; if (vy[i] > 0) vy[i] = 0; }
      else if (dy[i] < -LIMIT) { dy[i] = -LIMIT; if (vy[i] < 0) vy[i] = 0; }
    }

    // Walk outward pulling each node back toward the one before it, so the
    // constraint propagates from the anchor rather than fighting itself. Two
    // passes is enough at these speeds and stays cheap.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < n; i++) {
        const gx = dx[i] - dx[i - 1];
        if (gx > MAX_BEND) { dx[i] = dx[i - 1] + MAX_BEND; if (vx[i] > 0) vx[i] = 0; }
        else if (gx < -MAX_BEND) { dx[i] = dx[i - 1] - MAX_BEND; if (vx[i] < 0) vx[i] = 0; }
        const gy = dy[i] - dy[i - 1];
        if (gy > MAX_BEND) { dy[i] = dy[i - 1] + MAX_BEND; if (vy[i] > 0) vy[i] = 0; }
        else if (gy < -MAX_BEND) { dy[i] = dy[i - 1] - MAX_BEND; if (vy[i] < 0) vy[i] = 0; }
      }
    }
  }

  reset() {
    this.dx.fill(0); this.dy.fill(0);
    this.vx.fill(0); this.vy.fill(0);
    this.accumulator = 0;
  }
}

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
