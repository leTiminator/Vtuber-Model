/**
 * Verlet chain used for the scarf tails.
 *
 * Position-based rather than force-based: integrate freely, then hard-enforce
 * the segment lengths a few times per frame. That stays stable no matter how
 * violently the anchor moves, which matters here — the anchor is bolted to a
 * head that can whip around faster than any spring would tolerate.
 */
const FIXED_DT = 1 / 120;

export class Ribbon {
  /**
   * @param {number} count    number of chain points (including the anchor)
   * @param {number} segment  rest length between points, in virtual units
   * @param {number} drag     per-step velocity retention, 0..1
   */
  constructor(count, segment, drag = 0.94) {
    this.segment = segment;
    this.drag = drag;
    this.points = Array.from({ length: count }, () => ({ x: 0, y: 0, px: 0, py: 0 }));
    this.seeded = false;
    this.accumulator = 0;
  }

  /** Drop the whole chain at the anchor so it does not fly in from origin. */
  seed(ax, ay, dirX, dirY) {
    this.points.forEach((p, i) => {
      p.x = p.px = ax + dirX * this.segment * i;
      p.y = p.py = ay + dirY * this.segment * i;
    });
    this.seeded = true;
  }

  /**
   * @param {number} ax,ay      anchor position this frame
   * @param {number} windX,windY steady force (billow + head-driven gust)
   * @param {number} dt          seconds since last frame
   */
  step(ax, ay, windX, windY, dt) {
    if (!this.seeded) this.seed(ax, ay, windX ? Math.sign(windX) : 0, -1);

    // Fixed sub-steps keep the chain's behaviour identical at any frame rate.
    this.accumulator = Math.min(this.accumulator + dt, 0.1);
    while (this.accumulator >= FIXED_DT) {
      this.integrate(ax, ay, windX, windY, FIXED_DT);
      this.accumulator -= FIXED_DT;
    }
  }

  integrate(ax, ay, windX, windY, h) {
    const pts = this.points;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      // Points further out are a little lighter, so the tail whips — but only
      // a little, or a steady wind curls the tip back on itself.
      const weight = 0.72 + (i / pts.length) * 0.42;
      const vx = (p.x - p.px) * this.drag;
      const vy = (p.y - p.py) * this.drag;
      p.px = p.x;
      p.py = p.y;
      p.x += vx + windX * weight * h * h;
      p.y += vy + windY * weight * h * h;
    }

    pts[0].x = ax;
    pts[0].y = ay;

    for (let iter = 0; iter < 4; iter++) {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 1e-4;
        const correction = (dist - this.segment) / dist;
        // Only the outer point moves; the inner one is already satisfied.
        b.x -= dx * correction;
        b.y -= dy * correction;
      }
    }
  }

  /**
   * Trace the chain as a tapering ribbon and leave it as the current path.
   * @param {number} w0 half-width at the anchor
   * @param {number} w1 half-width at the tip
   */
  path(ctx, w0, w1) {
    const pts = this.points;
    const n = pts.length;
    const left = [];
    const right = [];

    for (let i = 0; i < n; i++) {
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(n - 1, i + 1)];
      let dx = next.x - prev.x;
      let dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      // Stay broad most of the way, then fall off fast, so the tail ends in a
      // point instead of a stub.
      const t = i / (n - 1);
      const w = w0 + (w1 - w0) * Math.pow(t, 2.4);
      left.push([pts[i].x - dy * w, pts[i].y + dx * w]);
      right.push([pts[i].x + dy * w, pts[i].y - dx * w]);
    }

    ctx.beginPath();
    smoothPolyline(ctx, left, true);
    ctx.lineTo(right[n - 1][0], right[n - 1][1]);
    smoothPolyline(ctx, right.reverse(), false);
    ctx.closePath();
  }

  get tip() {
    return this.points[this.points.length - 1];
  }
}

/**
 * Midpoint-quadratic smoothing: each chain point becomes a control point and
 * the curve passes through the midpoints between them, so the outline reads as
 * cloth rather than a polyline.
 */
function smoothPolyline(ctx, pts, startNewSubpath) {
  if (startNewSubpath) ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
}
