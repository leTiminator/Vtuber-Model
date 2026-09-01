/**
 * The built-in character: a masked ninja. Charcoal helmet, a glowing visor,
 * and a long red scarf that flies on its own physics.
 *
 * Drawn procedurally with Canvas 2D, so it needs no art assets and recolours
 * live. Everything lives in a 1000x1000 virtual space the renderer scales.
 *
 * Pseudo-3D head turn: each feature is a point sitting at (offset, depth) on
 * the helmet, rotated rigidly about the head's axis —
 *
 *     x' = offset*cos(yaw) + depth*sin(yaw)
 *
 * so features shift and crowd together the way a real head does. The same
 * point's surface normal, cos(atan2(offset, depth) + yaw), says how side-on it
 * has become, which drives foreshortening and hides the far eye on a hard turn.
 *
 * There is no mouth on this design, so the eye glows carry every expression:
 * they narrow, slant, round out and flare. The speech channel drives a vent
 * glow along the bottom of the visor instead.
 */
import { clamp, lerp, TAU } from '../../core/math.js';
import { mix, shade, withAlpha } from './palette.js';
import { Ribbon } from './ribbon.js';

const HEAD = { cx: 500, cy: 368, rx: 176, ry: 194 };

// How far each feature sits in front of the helmet's rotation axis.
const DEPTH = { visor: 128, eye: 150, vent: 140, wrap: 96, tuft: -90 };

const EYE_X = 74;
const EYE_Y = -6;

const K = 0.5523; // circle-to-bezier handle constant

const rotX = (offset, depth, yaw) => offset * Math.cos(yaw) + depth * Math.sin(yaw);
const rotY = (offset, depth, pitch) => offset * Math.cos(pitch) + depth * Math.sin(pitch);
const facing = (offset, depth, angle) =>
  clamp(Math.cos(Math.atan2(offset, depth) + angle), 0, 1);

function stroke(ctx, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

/** Place a feature in head space, accounting for both head angles. */
function place(H, offX, offY, depth) {
  return {
    x: H.cx + H.shift + rotX(offX, depth, H.yaw),
    y: H.cy + H.lift + rotY(offY, depth, H.pitch),
    fx: facing(offX, depth, H.yaw),
    fy: facing(offY, depth, H.pitch),
  };
}

/**
 * Upper half of an egg as two quarter arcs with tangent-aligned handles.
 * Handles must not overshoot the apex — a cubic whose controls sit at the
 * target height sails well above it.
 */
function domeTop(ctx, x, y, rx, ry, l, r, waistY) {
  const leftX = x - rx * l;
  const rightX = x + rx * r;
  const rise = waistY - (y - ry);
  ctx.moveTo(leftX, waistY);
  ctx.bezierCurveTo(leftX, waistY - K * rise, x - K * rx * l, y - ry, x, y - ry);
  ctx.bezierCurveTo(x + K * rx * r, y - ry, rightX, waistY - K * rise, rightX, waistY);
}

const SCARF_LENGTH = { short: 0.55, medium: 0.8, long: 1.15 };

export class Character {
  constructor() {
    // Two tails of different lengths so they never move in lockstep.
    this.tails = [
      { ribbon: new Ribbon(18, 40, 0.949), side: -1, w0: 46, w1: 7, bias: -1.0, phase: 0, loft: 1.0 },
      { ribbon: new Ribbon(13, 34, 0.94), side: 1, w0: 32, w1: 5, bias: -0.66, phase: 2.4, loft: 0.42 },
    ];
    this.clock = 0;
  }

  draw(ctx, rig, pal, dt, clock) {
    this.clock = clock;
    const yaw = clamp(rig.head.yaw, -0.85, 0.85);
    const pitch = clamp(rig.head.pitch, -0.6, 0.6);

    ctx.save();

    const bodyX = rig.head.x * 44 + rig.body.leanX * 26;
    const bodyY = -rig.head.y * 38 + rig.body.bounce * 6;
    const zoom = 1 + rig.head.z * 0.06;
    ctx.translate(500 + bodyX, 540 + bodyY);
    ctx.scale(zoom, zoom);
    ctx.translate(-500, -540);

    const H = {
      cx: HEAD.cx, cy: HEAD.cy, rx: HEAD.rx, ry: HEAD.ry,
      yaw, pitch,
      shift: Math.sin(yaw) * 22 + rig.head.x * 12,
      lift: -Math.sin(pitch) * 18 - rig.head.y * 10,
      roll: rig.head.roll,
    };

    // Tails hang off the body, so they are stepped and drawn outside the
    // head's rotation group.
    this.stepTails(rig, pal, H, dt);
    this.drawTails(ctx, pal);

    ctx.save();
    const pivotX = HEAD.cx + Math.sin(yaw) * 14;
    const pivotY = HEAD.cy + HEAD.ry * 1.2;
    ctx.translate(pivotX, pivotY);
    ctx.rotate(H.roll);
    ctx.translate(-pivotX, -pivotY);

    drawTufts(ctx, H, pal, rig);
    ctx.restore();

    drawBody(ctx, rig, pal);

    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(H.roll);
    ctx.translate(-pivotX, -pivotY);

    drawHelmet(ctx, H, pal, rig);
    drawVisor(ctx, H, pal, rig);
    drawEyes(ctx, H, pal, rig, clock);
    drawVent(ctx, H, pal, rig);
    drawScarfWrap(ctx, H, pal, rig);
    drawAccessory(ctx, H, pal, rig, clock);
    drawEffects(ctx, H, pal, rig, clock);

    ctx.restore();
    ctx.restore();
  }

  stepTails(rig, pal, H, dt) {
    const lenScale = SCARF_LENGTH[pal.style.scarfLength] ?? 0.8;
    const float = pal.style.scarfFloat ?? 1;

    for (const tail of this.tails) {
      tail.ribbon.segment = 40 * lenScale * (tail.side < 0 ? 1 : 0.88);

      // Anchored at the shoulders, just behind the neck.
      const ax = 500 + tail.side * 76 + rig.body.leanX * 26 + rig.head.x * 18;
      const ay = 664 + rig.body.bounce * 5;

      const t = this.clock + tail.phase;
      // A steady updraught keeps the tails aloft the way the reference art
      // has them; turbulence and the head's turn add the drift.
      const billow = 44000 * float;
      const gust = -rig.head.yaw * 34000 - rig.body.leanX * 16000;
      const windX = tail.bias * billow * 0.62 + gust + Math.sin(t * 1.7) * 6000 + Math.sin(t * 0.53) * 4200;
      const windY = -billow * tail.loft + Math.sin(t * 2.3 + 1.2) * 4500 - Math.abs(rig.head.pitch) * 9000;

      tail.ribbon.step(ax, ay, windX, windY, dt);
    }
  }

  drawTails(ctx, pal) {
    for (const tail of this.tails) {
      const r = tail.ribbon;
      r.path(ctx, tail.w0, tail.w1);
      ctx.fillStyle = pal.scarf;
      ctx.fill();
      stroke(ctx, pal.line, 5);

      // Darker underside along one edge reads as the cloth folding over.
      ctx.save();
      r.path(ctx, tail.w0, tail.w1);
      ctx.clip();
      const pts = r.points;
      const mid = pts[Math.floor(pts.length / 2)];
      const grad = ctx.createLinearGradient(mid.x - 60, mid.y - 60, mid.x + 60, mid.y + 60);
      grad.addColorStop(0, withAlpha(pal.scarfShade, 0.85));
      grad.addColorStop(0.5, withAlpha(pal.scarfShade, 0));
      grad.addColorStop(1, withAlpha(pal.scarfShade, 0.7));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 1000, 1000);
      ctx.restore();
    }
  }
}

/* ---------------------------------------------------------------- helmet */

function helmetPath(ctx, H, inset = 0) {
  const { cx, cy, rx, ry, yaw, pitch, shift, lift } = H;
  const x = cx + shift;
  const y = cy + lift;
  const s = Math.sin(yaw);
  const l = 1 + Math.max(0, -s) * 0.08 - Math.max(0, s) * 0.16;
  const r = 1 + Math.max(0, s) * 0.08 - Math.max(0, -s) * 0.16;
  const RX = rx - inset;
  const RY = ry - inset;
  const jawY = y + RY * (0.98 + Math.sin(pitch) * 0.1);
  const waistY = y + RY * 0.02;

  ctx.beginPath();
  domeTop(ctx, x, y, RX, RY, l, r, waistY);
  // A helmet has no chin: the jaw stays round and full.
  ctx.bezierCurveTo(
    x + RX * r, waistY + (jawY - waistY) * 0.58,
    x + RX * 0.62 * r + s * 22, jawY,
    x + s * 22, jawY,
  );
  ctx.bezierCurveTo(
    x - RX * 0.62 * l + s * 22, jawY,
    x - RX * l, waistY + (jawY - waistY) * 0.58,
    x - RX * l, waistY,
  );
  ctx.closePath();
}

function drawHelmet(ctx, H, pal, rig) {
  const x = H.cx + H.shift;
  const y = H.cy + H.lift;

  helmetPath(ctx, H);
  ctx.fillStyle = pal.suit;
  ctx.fill();
  stroke(ctx, pal.line, 6);

  ctx.save();
  helmetPath(ctx, H);
  ctx.clip();

  // Top light: a broad sheen across the crown.
  const sheen = ctx.createLinearGradient(0, y - H.ry, 0, y + H.ry * 0.4);
  sheen.addColorStop(0, withAlpha(pal.suitLight, 0.85));
  sheen.addColorStop(0.55, withAlpha(pal.suitLight, 0.08));
  sheen.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(x - H.rx * 1.3, y - H.ry * 1.3, H.rx * 2.6, H.ry * 2.6);

  // Core shadow on whichever side has turned away from us.
  const away = Math.sin(H.yaw);
  const sx = x - Math.sign(away || 1) * H.rx * 1.05;
  const core = ctx.createLinearGradient(sx, 0, sx + Math.sign(away || 1) * H.rx * 1.1, 0);
  core.addColorStop(0, withAlpha(pal.suitShade, 0.9));
  core.addColorStop(1, withAlpha(pal.suitShade, 0));
  ctx.fillStyle = core;
  ctx.fillRect(x - H.rx * 1.3, y - H.ry * 1.3, H.rx * 2.6, H.ry * 2.6);

  // Hard specular blob, the thing that makes it read as a hard shell.
  const hl = place(H, -H.rx * 0.42, -H.ry * 0.6, 60);
  ctx.beginPath();
  ctx.ellipse(hl.x, hl.y, H.rx * 0.24, H.ry * 0.15, -0.5, 0, TAU);
  ctx.fillStyle = withAlpha(pal.suitLight, 0.55 * hl.fx);
  ctx.fill();
  ctx.restore();

  // Crown seam.
  const a = place(H, 0, -H.ry * 0.95, 40);
  const b = place(H, 0, H.ry * 0.1, DEPTH.visor);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.quadraticCurveTo((a.x + b.x) / 2, (a.y + b.y) / 2, b.x, b.y);
  stroke(ctx, withAlpha(pal.line, 0.32 * Math.cos(H.yaw)), 4);
}

/** Spiky tufts escaping the back of the helmet. */
function drawTufts(ctx, H, pal, rig) {
  const specs = [
    [-0.82, -0.46, -1.78, -0.62, 0.2],
    [-0.66, -0.7, -1.52, -1.06, 0.18],
    [-0.24, -0.88, -0.62, -1.46, 0.15],
    [0.24, -0.88, 0.66, -1.44, 0.15],
    [0.66, -0.7, 1.54, -1.02, 0.18],
    [0.82, -0.46, 1.8, -0.58, 0.2],
  ];
  const sway = rig.body.hairX * 0.34;
  const bob = rig.body.hairY * 0.22;

  for (const [bx, by, tx, ty, w] of specs) {
    const base = place(H, H.rx * bx, H.ry * by, DEPTH.tuft);
    const tip = place(H, H.rx * (tx + sway), H.ry * (ty + bob), DEPTH.tuft);
    const nx = -(tip.y - base.y);
    const ny = tip.x - base.x;
    const len = Math.hypot(nx, ny) || 1;
    const hw = H.rx * w;

    ctx.beginPath();
    ctx.moveTo(base.x + (nx / len) * hw, base.y + (ny / len) * hw);
    ctx.quadraticCurveTo(
      (base.x + tip.x) / 2 + (nx / len) * hw * 0.6,
      (base.y + tip.y) / 2 + (ny / len) * hw * 0.6,
      tip.x, tip.y,
    );
    ctx.quadraticCurveTo(
      (base.x + tip.x) / 2 - (nx / len) * hw * 0.6,
      (base.y + tip.y) / 2 - (ny / len) * hw * 0.6,
      base.x - (nx / len) * hw, base.y - (ny / len) * hw,
    );
    ctx.closePath();
    ctx.fillStyle = pal.hair;
    ctx.fill();
    stroke(ctx, pal.line, 4.5);
  }
}

/* ----------------------------------------------------------------- visor */

function visorBounds(H) {
  const left = place(H, -H.rx * 0.82, 0, DEPTH.visor);
  const right = place(H, H.rx * 0.82, 0, DEPTH.visor);
  const top = place(H, 0, -H.ry * 0.5, DEPTH.visor);
  const bottom = place(H, 0, H.ry * 0.52, DEPTH.visor);
  return { left, right, top, bottom, cx: (left.x + right.x) / 2, cy: (top.y + bottom.y) / 2 };
}

function visorPath(ctx, H, pad = 0) {
  const v = visorBounds(H);
  const lx = v.left.x - pad;
  const rx = v.right.x + pad;
  const ty = v.top.y - pad;
  const by = v.bottom.y + pad;
  const w = (rx - lx) / 2;

  // Wide rounded top, narrowing to a soft point at the bottom — a faceplate.
  ctx.beginPath();
  ctx.moveTo(lx, ty + (by - ty) * 0.3);
  ctx.bezierCurveTo(lx, ty + (by - ty) * 0.06, lx + w * 0.45, ty, v.cx, ty);
  ctx.bezierCurveTo(rx - w * 0.45, ty, rx, ty + (by - ty) * 0.06, rx, ty + (by - ty) * 0.3);
  ctx.bezierCurveTo(rx, ty + (by - ty) * 0.72, rx - w * 0.5, by, v.cx, by);
  ctx.bezierCurveTo(lx + w * 0.5, by, lx, ty + (by - ty) * 0.72, lx, ty + (by - ty) * 0.3);
  ctx.closePath();
}

function drawVisor(ctx, H, pal, rig) {
  const v = visorBounds(H);

  visorPath(ctx, H, 5);
  ctx.fillStyle = pal.visorDark;
  ctx.fill();

  visorPath(ctx, H);
  const grad = ctx.createLinearGradient(0, v.top.y, 0, v.bottom.y);
  grad.addColorStop(0, pal.visorLight);
  grad.addColorStop(0.45, pal.visor);
  grad.addColorStop(1, mix(pal.visor, pal.visorDark, 0.75));
  ctx.fillStyle = grad;
  ctx.fill();
  stroke(ctx, pal.line, 5);

  // Glass reflection sweeping across the upper plate.
  ctx.save();
  visorPath(ctx, H);
  ctx.clip();
  ctx.beginPath();
  ctx.moveTo(v.left.x, v.top.y + (v.bottom.y - v.top.y) * 0.42);
  ctx.lineTo(v.right.x, v.top.y + (v.bottom.y - v.top.y) * 0.16);
  ctx.lineTo(v.right.x, v.top.y - 20);
  ctx.lineTo(v.left.x, v.top.y - 20);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.13)';
  ctx.fill();
  ctx.restore();
}

/* ------------------------------------------------------------------ eyes */

/** Eye glow outline in canonical space: +x is outward, origin at the centre. */
function eyeShape(ctx, w, h, style) {
  ctx.beginPath();
  if (style === 'round') {
    ctx.ellipse(0, 0, w * 0.78, h * 0.9, 0, 0, TAU);
  } else if (style === 'band') {
    ctx.moveTo(-w, -h * 0.5);
    ctx.lineTo(w, -h * 0.62);
    ctx.lineTo(w, h * 0.62);
    ctx.lineTo(-w, h * 0.5);
    ctx.closePath();
  } else {
    // Angular slash: broad at the outer end, tapering to a point inboard.
    ctx.moveTo(w, -h * 0.98);
    ctx.lineTo(-w * 0.86, -h * 0.2);
    ctx.lineTo(-w * 1.06, h * 0.26);
    ctx.lineTo(w * 0.88, h * 0.62);
    ctx.closePath();
  }
}

function drawEyes(ctx, H, pal, rig, clock) {
  const style = pal.style.eye;

  for (const side of [-1, 1]) {
    const p = place(H, side * EYE_X, EYE_Y, DEPTH.eye);
    if (p.fx < 0.12) continue;

    const blink = side < 0 ? rig.eyes.blinkL : rig.eyes.blinkR;
    const squint = side < 0 ? rig.eyes.squintL : rig.eyes.squintR;
    const wide = side < 0 ? rig.eyes.wideL : rig.eyes.wideR;
    const brow = side < 0 ? rig.eyes.browL : rig.eyes.browR;

    const open = clamp((1 - blink) * (1 - squint * 0.55) * (1 + wide * 0.3), 0, 1.4);
    // With no mouth, speech shows as the glow breathing a little.
    const talk = rig.mouth.open * 0.12 + rig.mouth.smile * 0.08;

    const w = 52 * lerp(0.3, 1, p.fx);
    const h = 30 * (open + talk) * (1 + rig.expression.shock * 0.5);

    // Brows slant the glow; anger drives the inner tip down hard.
    const slant = -brow * 0.22 - rig.expression.anger * 0.34 + rig.eyes.browInner * 0.16;

    ctx.save();
    ctx.globalAlpha = clamp((p.fx - 0.1) * 4, 0, 1);
    ctx.translate(p.x, p.y);
    ctx.scale(side, 1);
    ctx.translate(
      clamp(rig.eyes.gazeX, -1, 1) * side * 14,
      clamp(-rig.eyes.gazeY, -1, 1) * 9,
    );
    ctx.rotate(slant);

    if (h < 2.5) {
      // Fully shut: a bright hairline, which reads far better than nothing.
      ctx.beginPath();
      ctx.moveTo(-w * 0.9, 0);
      ctx.lineTo(w * 0.95, -h * 0.1 - 2);
      stroke(ctx, withAlpha(pal.glow, 0.85), 4);
      ctx.restore();
      continue;
    }

    const hot = rig.expression.anger > 0.3 ? mix(pal.glow, '#ff5a4a', rig.expression.anger * 0.7) : pal.glow;

    // Bloom underneath, so the glow looks emissive rather than painted on.
    ctx.save();
    ctx.globalAlpha *= 0.5 + rig.expression.sparkle * 0.4;
    const bloom = ctx.createRadialGradient(0, 0, 1, 0, 0, w * 1.9);
    bloom.addColorStop(0, withAlpha(hot, 0.55));
    bloom.addColorStop(1, withAlpha(hot, 0));
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.ellipse(0, 0, w * 1.9, h * 2.6, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    eyeShape(ctx, w, h, style);
    ctx.fillStyle = hot;
    ctx.fill();

    // Hot core.
    ctx.save();
    eyeShape(ctx, w, h, style);
    ctx.clip();
    ctx.beginPath();
    ctx.ellipse(w * 0.22, -h * 0.12, w * 0.5, h * 0.5, 0, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();
    ctx.restore();

    ctx.restore();
  }
}

/** Speech vent along the bottom of the visor — the mouth channel's outlet. */
function drawVent(ctx, H, pal, rig) {
  const p = place(H, 0, H.ry * 0.36, DEPTH.vent);
  if (p.fx < 0.2) return;
  const open = clamp(rig.mouth.open, 0, 1);
  const w = 40 * lerp(0.35, 1, p.fx);

  ctx.save();
  ctx.globalAlpha = clamp((p.fx - 0.15) * 3, 0, 1);
  for (let i = 0; i < 3; i++) {
    const t = i / 2;
    const bar = 2.5 + open * 7 * (1 - Math.abs(t - 0.5));
    const y = p.y + (i - 1) * 9;
    ctx.beginPath();
    ctx.moveTo(p.x - w * (1 - Math.abs(t - 0.5) * 0.5), y);
    ctx.lineTo(p.x + w * (1 - Math.abs(t - 0.5) * 0.5), y);
    stroke(ctx, withAlpha(pal.glow, 0.25 + open * 0.6), bar);
  }
  ctx.restore();
}

/* ----------------------------------------------------------------- scarf */

function drawScarfWrap(ctx, H, pal, rig) {
  const { rx, ry } = H;
  const x = H.cx + H.shift;
  const y = H.cy + H.lift;
  const s = Math.sin(H.yaw);
  const topY = y + ry * (0.5 + Math.sin(H.pitch) * 0.16);
  const botY = y + ry * 1.52;

  // Band across the lower helmet, hiding where a jaw would be.
  ctx.beginPath();
  ctx.moveTo(x - rx * 1.04 + s * 14, topY - ry * 0.16);
  ctx.bezierCurveTo(
    x - rx * 0.5 + s * 20, topY + ry * 0.12,
    x + rx * 0.5 + s * 20, topY + ry * 0.12,
    x + rx * 1.04 + s * 14, topY - ry * 0.16,
  );
  ctx.bezierCurveTo(
    x + rx * 1.0 + s * 10, botY - ry * 0.5,
    x + rx * 0.6 + s * 24, botY - ry * 0.08,
    x + s * 24, botY,
  );
  ctx.bezierCurveTo(
    x - rx * 0.6 + s * 24, botY - ry * 0.08,
    x - rx * 1.0 + s * 10, botY - ry * 0.5,
    x - rx * 1.04 + s * 14, topY - ry * 0.16,
  );
  ctx.closePath();
  ctx.fillStyle = pal.scarf;
  ctx.fill();
  stroke(ctx, pal.line, 6);

  ctx.save();
  ctx.clip();
  // Shade the underside of the wrap.
  const grad = ctx.createLinearGradient(0, topY, 0, botY);
  grad.addColorStop(0, withAlpha(pal.scarfLight, 0.5));
  grad.addColorStop(0.45, 'rgba(0,0,0,0)');
  grad.addColorStop(1, withAlpha(pal.scarfShade, 0.85));
  ctx.fillStyle = grad;
  ctx.fillRect(x - rx * 1.4, topY - 40, rx * 2.8, botY - topY + 80);

  // Fold creases, splayed from the knot at one side.
  const knotX = x + rx * 0.52 + s * 24;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(knotX, topY + ry * 0.08);
    ctx.quadraticCurveTo(
      x - rx * 0.2 + i * rx * 0.3, topY + ry * (0.4 + i * 0.12),
      x - rx * 1.0, topY + ry * (0.34 + i * 0.3),
    );
    stroke(ctx, withAlpha(pal.scarfShade, 0.7), 4);
  }
  ctx.restore();

  // Knot.
  ctx.beginPath();
  ctx.ellipse(knotX, topY + ry * 0.16, rx * 0.2, ry * 0.15, -0.3, 0, TAU);
  ctx.fillStyle = pal.scarf;
  ctx.fill();
  stroke(ctx, pal.line, 5);
}

/* ------------------------------------------------------------------ body */

function drawBody(ctx, rig, pal) {
  const lean = rig.body.leanX * 30;
  const twist = rig.body.twist * 0.3;
  const halfW = 292 + rig.body.breath * 6;

  ctx.save();
  ctx.translate(500, 980);
  ctx.rotate(twist);
  ctx.translate(-500 + lean, -980);

  // Neck.
  ctx.beginPath();
  ctx.moveTo(500 - 52, 560);
  ctx.lineTo(500 - 58, 682);
  ctx.lineTo(500 + 58, 682);
  ctx.lineTo(500 + 52, 560);
  ctx.closePath();
  ctx.fillStyle = pal.suitShade;
  ctx.fill();
  stroke(ctx, pal.line, 5);

  // Torso.
  ctx.beginPath();
  ctx.moveTo(500 - 60, 632);
  ctx.bezierCurveTo(500 - 152, 672, 500 - halfW, 754, 500 - halfW - 22, 1010);
  ctx.lineTo(500 + halfW + 22, 1010);
  ctx.bezierCurveTo(500 + halfW, 754, 500 + 152, 672, 500 + 60, 632);
  ctx.closePath();
  ctx.fillStyle = pal.suit;
  ctx.fill();
  stroke(ctx, pal.line, 6);

  ctx.save();
  ctx.clip();
  // Shoulder core shadow.
  ctx.beginPath();
  ctx.ellipse(500 - halfW * 0.9, 900, halfW * 0.46, 250, 0.18, 0, TAU);
  ctx.fillStyle = withAlpha(pal.suitShade, 0.75);
  ctx.fill();

  // Leather harness straps over each shoulder.
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(500 + side * 96, 700);
    ctx.quadraticCurveTo(500 + side * 210, 760, 500 + side * 250, 1010);
    stroke(ctx, pal.accent, 34);
    stroke(ctx, withAlpha(pal.accentShade, 0.5), 10);
  }

  // Scarf sweeping across the chest.
  ctx.beginPath();
  ctx.moveTo(500 - 150, 700);
  ctx.bezierCurveTo(500 - 60, 800, 500 + 90, 830, 500 + 210, 1010);
  ctx.lineTo(500 + 90, 1010);
  ctx.bezierCurveTo(500 + 30, 850, 500 - 80, 800, 500 - 190, 742);
  ctx.closePath();
  ctx.fillStyle = pal.scarf;
  ctx.fill();
  stroke(ctx, pal.line, 5);
  ctx.restore();

  ctx.restore();
}

/* ------------------------------------------------------- accessories/fx */

function drawAccessory(ctx, H, pal, rig, clock) {
  const { rx, ry } = H;
  const acc = pal.style.accessory;
  if (acc === 'none') return;

  if (acc === 'horns') {
    for (const side of [-1, 1]) {
      const base = place(H, side * rx * 0.66, -ry * 0.72, 20);
      const tip = place(H, side * rx * 1.24, -ry * 1.5, -10);
      if (base.fx < 0.05) continue;
      ctx.beginPath();
      ctx.moveTo(base.x - side * rx * 0.16, base.y);
      ctx.quadraticCurveTo(base.x + side * rx * 0.2, base.y - ry * 0.5, tip.x, tip.y);
      ctx.quadraticCurveTo(base.x + side * rx * 0.3, base.y - ry * 0.16, base.x + side * rx * 0.14, base.y);
      ctx.closePath();
      ctx.fillStyle = pal.accent;
      ctx.fill();
      stroke(ctx, pal.line, 5);
    }
  } else if (acc === 'antenna') {
    const base = place(H, rx * 0.5, -ry * 0.82, 30);
    const sway = Math.sin(clock * 2.2) * 14 + rig.body.hairX * 40;
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.quadraticCurveTo(base.x + 20 + sway * 0.5, base.y - ry * 0.6, base.x + sway, base.y - ry * 1.1);
    stroke(ctx, pal.line, 6);
    ctx.beginPath();
    ctx.arc(base.x + sway, base.y - ry * 1.1, 13, 0, TAU);
    ctx.fillStyle = pal.scarf;
    ctx.fill();
    stroke(ctx, pal.line, 4);
  } else if (acc === 'goggles') {
    const l = place(H, -rx * 0.56, -ry * 0.74, 90);
    const r = place(H, rx * 0.56, -ry * 0.74, 90);
    ctx.beginPath();
    ctx.moveTo(l.x - rx * 0.4, l.y + 6);
    ctx.quadraticCurveTo((l.x + r.x) / 2, l.y - ry * 0.16, r.x + rx * 0.4, r.y + 6);
    stroke(ctx, pal.accent, 22);
    stroke(ctx, withAlpha(pal.line, 0.4), 5);
    for (const g of [l, r]) {
      if (g.fx < 0.12) continue;
      ctx.beginPath();
      ctx.ellipse(g.x, g.y, rx * 0.24 * lerp(0.35, 1, g.fx), ry * 0.2, 0, 0, TAU);
      ctx.fillStyle = withAlpha(pal.visorLight, 0.6);
      ctx.fill();
      stroke(ctx, pal.line, 5);
    }
  }
}

function drawEffects(ctx, H, pal, rig, clock) {
  const x = H.cx + H.shift;
  const y = H.cy + H.lift;
  const { rx, ry } = H;

  if (rig.expression.anger > 0.02) {
    ctx.save();
    ctx.globalAlpha = rig.expression.anger;
    const ax = x + rx * 0.62, ay = y - ry * 0.7, s = 26;
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax + dx * s, ay + dy * s);
      ctx.lineTo(ax + dx * s * 0.55 + dy * s * 0.5, ay + dy * s * 0.55 + dx * s * 0.5);
      ctx.closePath();
      ctx.fillStyle = '#e8465c';
      ctx.fill();
    }
    ctx.restore();
  }

  if (rig.expression.sweat > 0.02) {
    ctx.save();
    ctx.globalAlpha = rig.expression.sweat;
    const drop = (clock * 0.6) % 1;
    const sx = x - rx * 0.82, sy = y - ry * 0.5 + drop * 64;
    ctx.beginPath();
    ctx.moveTo(sx, sy - 22);
    ctx.bezierCurveTo(sx + 16, sy - 2, sx + 14, sy + 18, sx, sy + 18);
    ctx.bezierCurveTo(sx - 14, sy + 18, sx - 16, sy - 2, sx, sy - 22);
    ctx.closePath();
    ctx.fillStyle = 'rgba(150,205,255,0.92)';
    ctx.fill();
    stroke(ctx, 'rgba(90,150,210,0.9)', 3);
    ctx.restore();
  }

  if (rig.expression.shock > 0.02) {
    ctx.save();
    ctx.globalAlpha = rig.expression.shock * 0.85;
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i - 2) * 0.36;
      const r0 = ry * 1.24, r1 = r0 + 40 + Math.sin(clock * 9 + i) * 8;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0 * 0.9);
      ctx.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1 * 0.9);
      stroke(ctx, pal.scarf, 7);
    }
    ctx.restore();
  }

  if (rig.expression.blush > 0.02) {
    // No skin to blush, so it lands as a warm flush on the faceplate.
    ctx.save();
    ctx.globalAlpha = rig.expression.blush * 0.5;
    for (const side of [-1, 1]) {
      const p = place(H, side * rx * 0.6, ry * 0.16, DEPTH.visor);
      if (p.fx < 0.15) continue;
      const g = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, rx * 0.26);
      g.addColorStop(0, 'rgba(255,120,130,0.95)');
      g.addColorStop(1, 'rgba(255,120,130,0)');
      ctx.fillStyle = g;
      ctx.fillRect(p.x - rx * 0.3, p.y - ry * 0.2, rx * 0.6, ry * 0.4);
    }
    ctx.restore();
  }
}
