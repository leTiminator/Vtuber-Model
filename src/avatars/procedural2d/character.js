/**
 * The built-in character, drawn procedurally with Canvas 2D so it works with
 * no art assets at all. Everything lives in a 1000x1000 virtual space that the
 * renderer scales to the output canvas.
 *
 * Pseudo-3D head turn: each facial feature is treated as a point sitting at
 * (offset, depth) on the head, and rotated rigidly about the head's axis —
 *
 *     x' = offset*cos(yaw) + depth*sin(yaw)
 *
 * so features shift and crowd together exactly the way a real face does. The
 * same point's surface normal, cos(atan2(offset, depth) + yaw), says how
 * side-on it now is, which drives foreshortening and hides the far ear.
 */
import { clamp, lerp, TAU } from '../../core/math.js';
import { mix, shade, withAlpha } from './palette.js';

const HEAD = { cx: 500, cy: 376, rx: 184, ry: 210 };

// Depths are "how far this sits in front of the head's rotation axis".
const DEPTH = { eye: 104, brow: 112, nose: 150, mouth: 122, cheek: 96, ear: -46 };

/** Rigid rotation of a feature point about the head axis. */
const rotX = (offset, depth, yaw) => offset * Math.cos(yaw) + depth * Math.sin(yaw);
const rotY = (offset, depth, pitch) => offset * Math.cos(pitch) + depth * Math.sin(pitch);
/** 1 when the feature faces us square-on, 0 at the silhouette edge. */
const facing = (offset, depth, angle) =>
  clamp(Math.cos(Math.atan2(offset, Math.max(depth, 1)) + angle), 0, 1);

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

export function drawCharacter(ctx, rig, pal, clock) {
  const yaw = clamp(rig.head.yaw, -0.85, 0.85);
  const pitch = clamp(rig.head.pitch, -0.6, 0.6);

  ctx.save();

  const bodyX = rig.head.x * 46 + rig.body.leanX * 26;
  const bodyY = -rig.head.y * 40 + rig.body.bounce * 6;
  const zoom = 1 + rig.head.z * 0.06;
  ctx.translate(500 + bodyX, 540 + bodyY);
  ctx.scale(zoom, zoom);
  ctx.translate(-500, -540);

  drawBody(ctx, rig, pal);

  // Head group, rotated about the base of the neck so a tilt swings the whole
  // head rather than spinning it in place.
  ctx.save();
  const pivotX = HEAD.cx + Math.sin(yaw) * 14;
  const pivotY = HEAD.cy + HEAD.ry * 1.15;
  ctx.translate(pivotX, pivotY);
  ctx.rotate(rig.head.roll);
  ctx.translate(-pivotX, -pivotY);

  const H = {
    cx: HEAD.cx,
    cy: HEAD.cy,
    rx: HEAD.rx,
    ry: HEAD.ry,
    yaw,
    pitch,
    shift: Math.sin(yaw) * 20 + rig.head.x * 12,
    lift: -Math.sin(pitch) * 16 - rig.head.y * 10,
  };

  drawBackHair(ctx, H, pal, rig);
  drawEars(ctx, H, pal);
  drawFace(ctx, H, pal, rig);
  drawBlush(ctx, H, pal, rig);
  drawBrows(ctx, H, pal, rig);
  drawEyes(ctx, H, pal, rig, clock);
  drawNose(ctx, H, pal);
  drawMouth(ctx, H, pal, rig);
  drawFrontHair(ctx, H, pal, rig);
  drawAccessory(ctx, H, pal, rig);
  drawEffects(ctx, H, pal, rig, clock);

  ctx.restore();
  ctx.restore();
}

/* ------------------------------------------------------------------ body */

function drawBody(ctx, rig, pal) {
  const lean = rig.body.leanX * 30;
  const twist = rig.body.twist * 0.3;
  const breath = rig.body.breath;
  const halfW = 286 + breath * 6;
  const neckTop = 566;

  ctx.save();
  ctx.translate(500, 980);
  ctx.rotate(twist);
  ctx.translate(-500 + lean, -980);

  ctx.beginPath();
  ctx.moveTo(500 - 46, neckTop);
  ctx.lineTo(500 - 54, 682);
  ctx.lineTo(500 + 54, 682);
  ctx.lineTo(500 + 46, neckTop);
  ctx.closePath();
  ctx.fillStyle = pal.skin;
  ctx.fill();
  stroke(ctx, pal.line, 5);

  // Shadow the jaw casts down the throat.
  ctx.save();
  ctx.beginPath();
  ctx.rect(500 - 60, neckTop - 4, 120, 70);
  ctx.clip();
  ctx.beginPath();
  ctx.ellipse(500, neckTop - 26, 92, 62, 0, 0, TAU);
  ctx.fillStyle = pal.skinShade;
  ctx.fill();
  ctx.restore();

  // Torso.
  ctx.beginPath();
  ctx.moveTo(500 - 56, 664);
  ctx.bezierCurveTo(500 - 150, 686, 500 - halfW, 760, 500 - halfW - 20, 1010);
  ctx.lineTo(500 + halfW + 20, 1010);
  ctx.bezierCurveTo(500 + halfW, 760, 500 + 150, 686, 500 + 56, 664);
  ctx.closePath();
  ctx.fillStyle = pal.outfit;
  ctx.fill();
  stroke(ctx, pal.line, 5);

  // Shoulder shading on the leading side.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(500 - 56, 664);
  ctx.bezierCurveTo(500 - 150, 686, 500 - halfW, 760, 500 - halfW - 20, 1010);
  ctx.lineTo(500 + halfW + 20, 1010);
  ctx.bezierCurveTo(500 + halfW, 760, 500 + 150, 686, 500 + 56, 664);
  ctx.closePath();
  ctx.clip();
  ctx.beginPath();
  ctx.ellipse(500 - halfW * 0.86, 900, halfW * 0.5, 260, 0.2, 0, TAU);
  ctx.fillStyle = withAlpha(pal.outfitShade, 0.6);
  ctx.fill();
  ctx.restore();

  // Collar.
  ctx.beginPath();
  ctx.moveTo(500 - 104, 676);
  ctx.bezierCurveTo(500 - 70, 790, 500 + 70, 790, 500 + 104, 676);
  ctx.bezierCurveTo(500 + 84, 664, 500 + 66, 660, 500 + 56, 662);
  ctx.bezierCurveTo(500 + 40, 730, 500 - 40, 730, 500 - 56, 662);
  ctx.bezierCurveTo(500 - 66, 660, 500 - 84, 664, 500 - 104, 676);
  ctx.closePath();
  ctx.fillStyle = pal.outfitAccent;
  ctx.fill();
  stroke(ctx, pal.line, 4.5);

  ctx.restore();
}

/* ------------------------------------------------------------------ face */

/** Circle-to-bezier constant: handle length for a quarter arc of radius r. */
const K = 0.5523;

/**
 * Upper half of an egg, as two quarter arcs with tangent-aligned handles.
 * Handles must not overshoot the apex — a cubic whose control points sit at
 * the target height sails well above it, which is what turns a scalp into a
 * balloon poking out through the hair.
 */
function domeTop(ctx, x, y, rx, ry, l, r, waistY) {
  const leftX = x - rx * l;
  const rightX = x + rx * r;
  const rise = waistY - (y - ry);
  ctx.moveTo(leftX, waistY);
  ctx.bezierCurveTo(leftX, waistY - K * rise, x - K * rx * l, y - ry, x, y - ry);
  ctx.bezierCurveTo(x + K * rx * r, y - ry, rightX, waistY - K * rise, rightX, waistY);
}

function facePath(ctx, H) {
  const { cx, cy, rx, ry, yaw, pitch, shift, lift } = H;
  const x = cx + shift;
  const y = cy + lift;
  // The cheek swinging toward us bulges; the one turning away flattens.
  const s = Math.sin(yaw);
  const l = 1 + Math.max(0, -s) * 0.1 - Math.max(0, s) * 0.2;
  const r = 1 + Math.max(0, s) * 0.1 - Math.max(0, -s) * 0.2;
  // Looking up shows more jaw, looking down more cranium.
  const chinY = y + ry * (1.0 + Math.sin(pitch) * 0.12);
  const waistY = y - ry * 0.06;

  ctx.beginPath();
  domeTop(ctx, x, y, rx, ry, l, r, waistY);
  // Jaw: short horizontal handles at the chin keep the taper pointed.
  ctx.bezierCurveTo(
    x + rx * r, waistY + (chinY - waistY) * 0.52,
    x + rx * 0.44 * r + s * 26, chinY,
    x + s * 26, chinY,
  );
  ctx.bezierCurveTo(
    x - rx * 0.44 * l + s * 26, chinY,
    x - rx * l, waistY + (chinY - waistY) * 0.52,
    x - rx * l, waistY,
  );
  ctx.closePath();
}

function drawFace(ctx, H, pal, rig) {
  facePath(ctx, H);
  ctx.fillStyle = pal.skin;
  ctx.fill();
  stroke(ctx, pal.line, 5.5);

  // Soft ambient occlusion where the fringe sits against the forehead. Kept
  // faint and gradient-edged: a hard wedge here reads as a second hairline.
  ctx.save();
  facePath(ctx, H);
  ctx.clip();
  const x = H.cx + H.shift;
  const y = H.cy + H.lift;
  const g = ctx.createLinearGradient(0, y - H.ry, 0, y - H.ry * 0.12);
  g.addColorStop(0, withAlpha(mix(pal.skinShade, pal.hair, 0.25), 0.34));
  g.addColorStop(1, withAlpha(mix(pal.skinShade, pal.hair, 0.25), 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - H.rx * 1.2, y - H.ry * 1.2, H.rx * 2.4, H.ry * 1.1);

  // Cheek tone tucked under each side lock.
  for (const side of [-1, 1]) {
    const cg = ctx.createLinearGradient(x + side * H.rx, 0, x + side * H.rx * 0.5, 0);
    cg.addColorStop(0, withAlpha(pal.skinShade, 0.5));
    cg.addColorStop(1, withAlpha(pal.skinShade, 0));
    ctx.fillStyle = cg;
    ctx.fillRect(x + (side < 0 ? -H.rx * 1.1 : H.rx * 0.5), y - H.ry * 0.3, H.rx * 0.6, H.ry * 1.2);
  }
  ctx.restore();
}

function drawEars(ctx, H, pal) {
  for (const side of [-1, 1]) {
    const p = place(H, side * H.rx * 0.95, H.ry * 0.06, DEPTH.ear);
    // The ear on the side turning away slides behind the head.
    const vis = clamp(p.fx * 2.2 - 0.35, 0, 1);
    if (vis < 0.04) continue;
    ctx.save();
    ctx.globalAlpha = vis;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, H.rx * 0.14, H.ry * 0.2, side * -0.18, 0, TAU);
    ctx.fillStyle = pal.skin;
    ctx.fill();
    stroke(ctx, pal.line, 4.5);
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ eyes */

const EYE_X = 88;
const EYE_Y = 52;
const BROW_Y = EYE_Y - 96;

function eyeGeometry(H, side) {
  const p = place(H, side * EYE_X, EYE_Y, DEPTH.eye);
  return { ...p, squash: lerp(0.34, 1, p.fx) };
}

function drawEyes(ctx, H, pal, rig, clock) {
  const aspect = { round: 1.0, sharp: 0.84, soft: 1.14 }[pal.style.eye] ?? 1;

  for (const side of [-1, 1]) {
    const g = eyeGeometry(H, side);
    if (g.fx < 0.12) continue;

    const blink = side < 0 ? rig.eyes.blinkL : rig.eyes.blinkR;
    const squint = side < 0 ? rig.eyes.squintL : rig.eyes.squintR;
    const wide = side < 0 ? rig.eyes.wideL : rig.eyes.wideR;
    const open = clamp((1 - blink) * (1 - squint * 0.42) * (1 + wide * 0.22), 0, 1.2);

    const w = 74 * g.squash;
    const h = 60 * aspect;

    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.globalAlpha = clamp((g.fx - 0.1) * 4, 0, 1);

    if (open < 0.08) {
      drawClosedEye(ctx, pal, w, side, rig);
      ctx.restore();
      continue;
    }

    const hh = h * open;

    ctx.save();
    eyeAperture(ctx, w, hh, side, pal.style.eye);
    ctx.clip();

    ctx.fillStyle = '#fdfbff';
    ctx.fillRect(-w * 1.2, -h * 1.6, w * 2.4, h * 3.4);

    const grad = ctx.createLinearGradient(0, -hh, 0, hh * 0.5);
    grad.addColorStop(0, withAlpha(pal.eyeDeep, 0.42));
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(-w * 1.2, -h * 1.6, w * 2.4, h * 3.4);

    const ir = Math.min(w * 0.56, h * 0.8);
    const gx = clamp(rig.eyes.gazeX, -1, 1) * Math.max(0, w - ir) * 0.9;
    const gy = clamp(-rig.eyes.gazeY, -1, 1) * Math.max(0, hh - ir * 0.7) * 0.9;
    drawIris(ctx, pal, gx, gy, ir, rig);
    ctx.restore();

    // Anime eyes are drawn with a heavy upper lash and only a hint of a lower
    // lid — a full outline reads as spectacles.
    drawLash(ctx, pal, w, hh, side);
    ctx.beginPath();
    ctx.moveTo(-w * 0.86, hh * 0.72);
    ctx.quadraticCurveTo(0, hh * 1.06, w * 0.86, hh * 0.72);
    stroke(ctx, withAlpha(pal.line, 0.45), 3.5);

    ctx.restore();
  }
}

function eyeAperture(ctx, w, h, side, style) {
  ctx.beginPath();
  if (style === 'sharp') {
    const tip = side < 0 ? -1 : 1;
    ctx.moveTo(-w, -h * 0.08 - tip * h * 0.12);
    ctx.bezierCurveTo(-w * 0.55, -h * 1.42, w * 0.55, -h * 1.42, w, -h * 0.08 + tip * h * 0.12);
    ctx.bezierCurveTo(w * 0.5, h * 1.12, -w * 0.5, h * 1.12, -w, -h * 0.08 - tip * h * 0.12);
  } else if (style === 'soft') {
    ctx.moveTo(-w, 0);
    ctx.bezierCurveTo(-w * 0.58, -h * 1.5, w * 0.58, -h * 1.5, w, 0);
    ctx.bezierCurveTo(w * 0.58, h * 1.4, -w * 0.58, h * 1.4, -w, 0);
  } else {
    ctx.moveTo(-w, -h * 0.06);
    ctx.bezierCurveTo(-w * 0.6, -h * 1.46, w * 0.6, -h * 1.46, w, -h * 0.06);
    ctx.bezierCurveTo(w * 0.6, h * 1.34, -w * 0.6, h * 1.34, -w, -h * 0.06);
  }
  ctx.closePath();
}

function drawIris(ctx, pal, gx, gy, r, rig) {
  ctx.save();
  ctx.translate(gx, gy);

  const grad = ctx.createRadialGradient(0, -r * 0.25, r * 0.08, 0, 0, r);
  grad.addColorStop(0, pal.eyeBright);
  grad.addColorStop(0.5, pal.eye);
  grad.addColorStop(1, pal.eyeDeep);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fillStyle = grad;
  ctx.fill();

  // Bounce light along the lower rim — what makes anime eyes read as glossy.
  ctx.beginPath();
  ctx.arc(0, r * 0.2, r * 0.74, 0.2, Math.PI - 0.2);
  ctx.fillStyle = withAlpha(pal.eyeBright, 0.6);
  ctx.fill();

  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.34, r * 0.42, 0, 0, TAU);
  ctx.fillStyle = mix(pal.eyeDeep, '#000000', 0.6);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  stroke(ctx, withAlpha(pal.eyeDeep, 0.75), 3);

  ctx.beginPath();
  ctx.ellipse(-r * 0.36, -r * 0.42, r * 0.3, r * 0.24, -0.4, 0, TAU);
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(r * 0.38, r * 0.36, r * 0.15, 0, TAU);
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.fill();

  if (rig.expression.sparkle > 0.02) {
    ctx.globalAlpha = rig.expression.sparkle;
    drawStar(ctx, 0, -r * 0.08, r * 0.6, 'rgba(255,255,255,0.92)');
  }
  ctx.restore();
}

function drawLash(ctx, pal, w, h, side) {
  ctx.beginPath();
  ctx.moveTo(-w * 0.99, -h * 0.02);
  ctx.bezierCurveTo(-w * 0.6, -h * 1.62, w * 0.6, -h * 1.62, w * 0.99, -h * 0.02);
  stroke(ctx, pal.line, 9);

  const tip = side < 0 ? -w : w;
  ctx.beginPath();
  ctx.moveTo(tip * 0.94, -h * 0.14);
  ctx.quadraticCurveTo(tip * 1.2, -h * 0.9, tip * 1.34, -h * 0.62);
  stroke(ctx, pal.line, 7);
}

function drawClosedEye(ctx, pal, w, side, rig) {
  const happy = rig.mouth.smile > 0.45 || rig.expression.sparkle > 0.3;
  ctx.beginPath();
  if (happy) {
    ctx.moveTo(-w * 0.92, w * 0.18);
    ctx.quadraticCurveTo(0, -w * 0.46, w * 0.92, w * 0.18);
  } else {
    ctx.moveTo(-w * 0.94, -w * 0.06);
    ctx.quadraticCurveTo(0, w * 0.3, w * 0.94, -w * 0.06);
  }
  stroke(ctx, pal.line, 8);

  const tip = side < 0 ? -w : w;
  ctx.beginPath();
  ctx.moveTo(tip * 0.92, happy ? w * 0.16 : -w * 0.06);
  ctx.quadraticCurveTo(tip * 1.18, -w * 0.32, tip * 1.32, -w * 0.2);
  stroke(ctx, pal.line, 6);
}

/* ----------------------------------------------------------------- brows */

function drawBrows(ctx, H, pal, rig) {
  for (const side of [-1, 1]) {
    const lift = (side < 0 ? rig.eyes.browL : rig.eyes.browR) * 24 + rig.eyes.browInner * 8;
    const p = place(H, side * (EYE_X + 2), BROW_Y - lift, DEPTH.brow);
    if (p.fx < 0.12) continue;

    const w = 58 * lerp(0.34, 1, p.fx);
    const innerDrop = rig.expression.anger * 22 - rig.eyes.browInner * 12;

    ctx.save();
    ctx.globalAlpha = clamp((p.fx - 0.1) * 4, 0, 1);
    ctx.beginPath();
    ctx.moveTo(p.x - side * w, p.y + innerDrop);
    ctx.quadraticCurveTo(p.x, p.y - 16 - lift * 0.2, p.x + side * w, p.y + 10);
    stroke(ctx, mix(pal.hair, pal.line, 0.4), 11);
    ctx.restore();
  }
}

/* ------------------------------------------------------------ nose/mouth */

function drawNose(ctx, H, pal) {
  const p = place(H, 0, 96, DEPTH.nose);
  const dir = H.yaw >= 0 ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(p.x - dir * 3, p.y - 9);
  ctx.quadraticCurveTo(p.x + dir * 9, p.y + 2, p.x - dir * 2, p.y + 7);
  stroke(ctx, withAlpha(pal.skinDeep, 0.8), 5);
}

function drawMouth(ctx, H, pal, rig) {
  const m = rig.mouth;
  const p = place(H, m.shift * 12, 146, DEPTH.mouth);
  const f = clamp(Math.cos(H.yaw), 0.45, 1);

  const open = clamp(m.open, 0, 1);
  const smile = clamp(m.smile - m.frown, -1, 1);
  const w = Math.max(14, (42 + smile * 20 + m.wide * 22 - m.pucker * 24) * f);
  const h = open * 46 + m.pucker * 8;

  ctx.save();
  ctx.translate(p.x, p.y);

  if (h < 4) {
    ctx.beginPath();
    ctx.moveTo(-w, -smile * 6);
    ctx.quadraticCurveTo(0, smile * 22 + 7, w, -smile * 6);
    stroke(ctx, pal.line, 6);
    ctx.restore();
    return;
  }

  const mw = m.pucker > 0.4 ? w * 0.6 : w;
  const shape = () => {
    ctx.beginPath();
    ctx.moveTo(-mw, 0);
    ctx.quadraticCurveTo(0, -h * 0.46 + smile * 10, mw, 0);
    ctx.quadraticCurveTo(0, h, -mw, 0);
    ctx.closePath();
  };

  shape();
  ctx.fillStyle = mix(pal.line, '#7d2f42', 0.5);
  ctx.fill();

  ctx.save();
  shape();
  ctx.clip();
  ctx.beginPath();
  ctx.ellipse(0, h * (0.66 - m.tongue * 0.55), mw * 0.74, h * 0.54, 0, 0, TAU);
  ctx.fillStyle = '#e2708a';
  ctx.fill();
  if (open > 0.24) {
    ctx.beginPath();
    ctx.moveTo(-mw, -h * 0.04);
    ctx.quadraticCurveTo(0, -h * 0.48 + smile * 10, mw, -h * 0.04);
    ctx.lineTo(mw, -h * 0.34);
    ctx.lineTo(-mw, -h * 0.34);
    ctx.closePath();
    ctx.fillStyle = '#fffafd';
    ctx.fill();
  }
  ctx.restore();

  shape();
  stroke(ctx, pal.line, 5.5);
  ctx.restore();
}

function drawBlush(ctx, H, pal, rig) {
  const amount = clamp(rig.expression.blush + rig.cheeks.puff * 0.5 + rig.mouth.smile * 0.16, 0, 1);
  if (amount < 0.02) return;
  for (const side of [-1, 1]) {
    const p = place(H, side * 120, 104, DEPTH.cheek);
    if (p.fx < 0.12) continue;
    const rw = 44 * lerp(0.4, 1, p.fx);
    ctx.save();
    ctx.globalAlpha = amount * 0.55 * p.fx;
    const g = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, rw);
    g.addColorStop(0, withAlpha(pal.blush, 0.95));
    g.addColorStop(1, withAlpha(pal.blush, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, rw, 24, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ hair */

const HAIR_LENGTH = { short: 0.34, medium: 0.9, long: 1.7, twintails: 0.8 };

function drawBackHair(ctx, H, pal, rig) {
  const { cx, cy, rx, ry, shift, lift } = H;
  const x = cx + shift * 0.7;
  const y = cy + lift * 0.7;
  const sway = rig.body.hairX * 44;
  const len = HAIR_LENGTH[pal.style.hair] ?? 0.9;

  ctx.beginPath();
  domeTop(ctx, x, y, rx * 1.05, ry * 1.08, 1, 1, y - ry * 0.24);
  ctx.bezierCurveTo(
    x + rx * 1.2 + sway, y + ry * (0.44 + len * 0.9),
    x + rx * 0.8 + sway * 1.4, y + ry * (0.92 + len * 1.15),
    x + sway * 1.7, y + ry * (0.98 + len * 1.3),
  );
  ctx.bezierCurveTo(
    x - rx * 0.8 + sway * 1.4, y + ry * (0.92 + len * 1.15),
    x - rx * 1.2 + sway, y + ry * (0.44 + len * 0.9),
    x - rx * 1.05, y - ry * 0.24,
  );
  ctx.closePath();
  ctx.fillStyle = pal.hairShade;
  ctx.fill();
  stroke(ctx, pal.hairLine, 5);

  if (pal.style.hair === 'twintails') drawTwintails(ctx, H, pal, rig);
}

function drawTwintails(ctx, H, pal, rig) {
  const { cx, cy, rx, ry, shift, lift } = H;
  const swayX = rig.body.hairX * 66;
  const swayY = rig.body.hairY * 38;
  for (const side of [-1, 1]) {
    const bx = cx + shift * 0.7 + side * rx * 1.0;
    const by = cy + lift * 0.7 - ry * 0.46;
    ctx.beginPath();
    ctx.moveTo(bx, by - 26);
    ctx.bezierCurveTo(
      bx + side * 128 + swayX, by + 64 + swayY,
      bx + side * 136 + swayX * 1.5, by + 244 + swayY,
      bx + side * 60 + swayX * 1.9, by + 402 + swayY * 1.4,
    );
    ctx.bezierCurveTo(
      bx + side * 8 + swayX * 1.4, by + 254 + swayY,
      bx - side * 36 + swayX, by + 112 + swayY,
      bx - side * 26, by - 20,
    );
    ctx.closePath();
    ctx.fillStyle = pal.hair;
    ctx.fill();
    stroke(ctx, pal.hairLine, 5);

    ctx.beginPath();
    ctx.ellipse(bx + side * 14, by + 8, 26, 15, side * 0.4, 0, TAU);
    ctx.fillStyle = pal.outfitAccent;
    ctx.fill();
    stroke(ctx, pal.line, 4);
  }
}

/**
 * Cap plus fringe, in one path. The cap's handles overshoot to ry*1.5 so the
 * curve actually clears the top of the skull, then the fringe descends in
 * three pointed locks with deep notches so plenty of forehead stays visible.
 */
/**
 * One tapering strand: a broad base up on the crown sweeping to a point.
 * Bases overlap generously so neighbouring locks read as layered hair rather
 * than leaving wedge-shaped gaps down to the scalp.
 */
function lock(ctx, x, y, rx, ry, a, b, tip, bowOut, bowIn) {
  const ax = x + rx * a[0], ay = y + ry * a[1];
  const bx = x + rx * b[0], by = y + ry * b[1];
  const tx = x + rx * tip[0], ty = y + ry * tip[1];
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.quadraticCurveTo(
    (ax + tx) / 2 + rx * bowOut[0], (ay + ty) / 2 + ry * bowOut[1], tx, ty,
  );
  ctx.quadraticCurveTo(
    (bx + tx) / 2 + rx * bowIn[0], (by + ty) / 2 + ry * bowIn[1], bx, by,
  );
  ctx.closePath();
}

// base A, base B, tip, outer bow, inner bow — all in head-relative units.
const FRINGE = [
  [[1.08, -0.24], [0.28, -0.86], [0.9, 0.02], [0.1, -0.14], [-0.06, 0.06]],
  [[0.72, -0.68], [-0.12, -0.92], [0.46, -0.08], [0.08, -0.1], [-0.06, 0.04]],
  [[0.22, -0.9], [-0.58, -0.76], [0.02, -0.14], [0.06, -0.1], [-0.08, 0.02]],
  [[-0.26, -0.86], [-0.94, -0.46], [-0.5, -0.08], [-0.06, -0.1], [0.08, 0.04]],
  [[-0.7, -0.66], [-1.08, -0.22], [-0.9, 0.02], [-0.1, -0.14], [0.06, 0.06]],
];

function drawFrontHair(ctx, H, pal, rig) {
  const { cx, cy, rx, ry, shift, lift } = H;
  // The cap is rigidly attached to the skull, so it takes the head's full
  // offset; only the hanging locks below get to lag behind.
  const x = cx + shift;
  const y = cy + lift;
  const sway = rig.body.hairX * 22;
  const part = Math.sin(H.yaw) * 0.09;
  const waistY = y - ry * 0.02;
  const len = HAIR_LENGTH[pal.style.hair] ?? 0.9;

  // Cap over the cranium, closing along a hairline arc rather than straight
  // across — the locks below are what actually shape the fringe.
  ctx.beginPath();
  domeTop(ctx, x, y, rx * 1.06, ry * 1.09, 1, 1, waistY);
  ctx.bezierCurveTo(x + rx * 0.94, y - ry * 0.46, x + rx * 0.52, y - ry * 0.66, x, y - ry * 0.64);
  ctx.bezierCurveTo(x - rx * 0.52, y - ry * 0.66, x - rx * 0.94, y - ry * 0.46, x - rx * 1.06, waistY);
  ctx.closePath();
  ctx.fillStyle = pal.hair;
  ctx.fill();
  stroke(ctx, pal.hairLine, 5);

  // Side locks first, so the fringe overlaps them at the temples.
  for (const side of [-1, 1]) {
    const bx = x + side * rx * 1.0;
    const tipX = bx - side * 10 + sway * 1.8;
    const tipY = y + ry * (0.5 + len * 0.6);
    ctx.beginPath();
    ctx.moveTo(bx + side * 6, y - ry * 0.56);
    ctx.bezierCurveTo(
      bx + side * 22 + sway, y + ry * 0.14,
      bx + side * 14 + sway * 1.5, y + ry * (0.3 + len * 0.4),
      tipX, tipY,
    );
    ctx.bezierCurveTo(
      bx - side * 24 + sway * 1.2, y + ry * (0.22 + len * 0.3),
      bx - side * 40 + sway * 0.5, y - ry * 0.02,
      bx - side * 30, y - ry * 0.5,
    );
    ctx.closePath();
    ctx.fillStyle = pal.hair;
    ctx.fill();
    stroke(ctx, pal.hairLine, 4.5);

    ctx.save();
    ctx.clip();
    ctx.beginPath();
    ctx.ellipse(bx - side * 46, y + ry * 0.3, rx * 0.3, ry * 0.9, 0, 0, TAU);
    ctx.fillStyle = withAlpha(pal.hairShade, 0.55);
    ctx.fill();
    ctx.restore();
  }

  // Fringe, outer locks first so each successive one overlaps the last. Each
  // lock's base sits up on the crown for coverage, but only the part below the
  // hairline is drawn — otherwise their outlines web across the scalp.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x - rx * 1.5, y - ry * 0.6);
  ctx.bezierCurveTo(x - rx * 0.6, y - ry * 0.74, x + rx * 0.6, y - ry * 0.74, x + rx * 1.5, y - ry * 0.6);
  ctx.lineTo(x + rx * 1.5, y + ry * 2);
  ctx.lineTo(x - rx * 1.5, y + ry * 2);
  ctx.closePath();
  ctx.clip();

  for (let i = 0; i < FRINGE.length; i++) {
    const [a, b, tip, bowOut, bowIn] = FRINGE[i];
    const drift = sway / rx;
    lock(
      ctx, x, y, rx, ry,
      [a[0] + part, a[1]],
      [b[0] + part, b[1]],
      [tip[0] + part * 1.6 + drift, tip[1]],
      bowOut, bowIn,
    );
    ctx.fillStyle = i % 2 === 0 ? pal.hair : mix(pal.hair, pal.hairLight, 0.13);
    ctx.fill();
    stroke(ctx, pal.hairLine, 4.5);
  }
  ctx.restore();

  // Glossy highlight band following the curve of the crown.
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(x - rx * 0.76, y - ry * 0.62);
  ctx.bezierCurveTo(x - rx * 0.52, y - ry * 0.94, x + rx * 0.5, y - ry * 0.94, x + rx * 0.76, y - ry * 0.6);
  ctx.bezierCurveTo(x + rx * 0.48, y - ry * 0.8, x - rx * 0.5, y - ry * 0.8, x - rx * 0.76, y - ry * 0.62);
  ctx.closePath();
  ctx.fillStyle = pal.hairLight;
  ctx.fill();
  ctx.restore();
}

/* ------------------------------------------------------- accessories/fx */

function drawAccessory(ctx, H, pal, rig) {
  const { cx, cy, rx, ry, shift, lift } = H;
  const x = cx + shift * 0.88;
  const y = cy + lift * 0.88;
  const acc = pal.style.accessory;

  if (acc === 'headphones') {
    ctx.beginPath();
    ctx.moveTo(x - rx * 1.06, y - ry * 0.3);
    ctx.bezierCurveTo(x - rx * 1.2, y - ry * 1.72, x + rx * 1.2, y - ry * 1.72, x + rx * 1.06, y - ry * 0.3);
    stroke(ctx, pal.outfitAccent, 20);
    stroke(ctx, withAlpha(pal.line, 0.3), 4);
    for (const side of [-1, 1]) {
      const p = place(H, side * rx * 0.98, ry * 0.06, DEPTH.ear);
      if (p.fx < 0.06) continue;
      ctx.save();
      ctx.globalAlpha = clamp(p.fx * 2.4, 0, 1);
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 34 * lerp(0.4, 1, p.fx), 46, 0, 0, TAU);
      ctx.fillStyle = pal.outfitAccent;
      ctx.fill();
      stroke(ctx, pal.line, 5);
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 20 * lerp(0.4, 1, p.fx), 28, 0, 0, TAU);
      ctx.fillStyle = shade(pal.outfitAccent, -0.32);
      ctx.fill();
      ctx.restore();
    }
  } else if (acc === 'glasses') {
    const l = eyeGeometry(H, -1);
    const r = eyeGeometry(H, 1);
    for (const g of [l, r]) {
      if (g.fx < 0.12) continue;
      ctx.save();
      ctx.globalAlpha = clamp((g.fx - 0.1) * 4, 0, 1);
      ctx.beginPath();
      ctx.roundRect(g.x - 64 * g.squash, g.y - 50, 128 * g.squash, 100, 24);
      ctx.fillStyle = 'rgba(214,238,255,0.15)';
      ctx.fill();
      stroke(ctx, pal.line, 6);
      ctx.restore();
    }
    if (l.fx > 0.12 && r.fx > 0.12) {
      ctx.beginPath();
      ctx.moveTo(l.x + 64 * l.squash, l.y - 6);
      ctx.quadraticCurveTo((l.x + r.x) / 2, l.y - 18, r.x - 64 * r.squash, r.y - 6);
      stroke(ctx, pal.line, 6);
    }
  } else if (acc === 'bow') {
    const bx = x + rx * 0.58;
    const by = y - ry * 0.92;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.bezierCurveTo(bx + side * 72, by - 48, bx + side * 80, by + 42, bx, by + 6);
      ctx.closePath();
      ctx.fillStyle = pal.outfitAccent;
      ctx.fill();
      stroke(ctx, pal.line, 4.5);
    }
    ctx.beginPath();
    ctx.arc(bx, by + 2, 14, 0, TAU);
    ctx.fillStyle = shade(pal.outfitAccent, -0.22);
    ctx.fill();
    stroke(ctx, pal.line, 4);
  }
}

function drawEffects(ctx, H, pal, rig, clock) {
  const x = H.cx + H.shift;
  const y = H.cy + H.lift;
  const { rx, ry } = H;

  if (rig.expression.anger > 0.02) {
    ctx.save();
    ctx.globalAlpha = rig.expression.anger;
    const ax = x + rx * 0.66, ay = y - ry * 0.72, s = 26;
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
    const sx = x - rx * 0.8, sy = y - ry * 0.58 + drop * 64;
    ctx.beginPath();
    ctx.moveTo(sx, sy - 22);
    ctx.bezierCurveTo(sx + 16, sy - 2, sx + 14, sy + 18, sx, sy + 18);
    ctx.bezierCurveTo(sx - 14, sy + 18, sx - 16, sy - 2, sx, sy - 22);
    ctx.closePath();
    ctx.fillStyle = 'rgba(150,205,255,0.9)';
    ctx.fill();
    stroke(ctx, 'rgba(90,150,210,0.9)', 3);
    ctx.restore();
  }

  if (rig.expression.shock > 0.02) {
    ctx.save();
    ctx.globalAlpha = rig.expression.shock * 0.85;
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i - 2) * 0.36;
      const r0 = ry * 1.3, r1 = r0 + 40 + Math.sin(clock * 9 + i) * 8;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0 * 0.9);
      ctx.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1 * 0.9);
      stroke(ctx, pal.outfitAccent, 7);
    }
    ctx.restore();
  }
}

function drawStar(ctx, x, y, r, color) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * 0.36;
    const px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}
