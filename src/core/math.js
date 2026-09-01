export const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/** Frame-rate independent exponential approach. `rate` is roughly "per second". */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

/** Map v from [inLo,inHi] onto [outLo,outHi], clamped to the output range. */
export function remap(v, inLo, inHi, outLo = 0, outHi = 1) {
  if (inHi === inLo) return outLo;
  return clamp((v - inLo) / (inHi - inLo), 0, 1) * (outHi - outLo) + outLo;
}

/** Smooth 0..1 ramp with zero derivative at both ends. */
export const smoothstep = (t) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/**
 * Critically-damped-ish spring, integrated semi-implicitly. Used for hair and
 * accessory follow-through; `state` is mutated in place.
 */
export function spring(state, target, stiffness, damping, dt) {
  // Sub-step so a long frame (tab regains focus, GC pause) cannot blow up.
  const steps = Math.min(4, Math.max(1, Math.ceil(dt / 0.016)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const accel = (target - state.value) * stiffness - state.velocity * damping;
    state.velocity += accel * h;
    state.value += state.velocity * h;
  }
  return state.value;
}

export const makeSpring = (value = 0) => ({ value, velocity: 0 });

/**
 * Pull yaw/pitch/roll (radians) out of MediaPipe's 4x4 facial transformation
 * matrix, which arrives column-major. Returns intrinsic Y-X-Z Euler angles,
 * the convention that reads naturally as "turn / nod / tilt".
 */
export function eulerFromMatrix(m) {
  const m00 = m[0], m01 = m[4], m02 = m[8];
  const m10 = m[1], m11 = m[5], m12 = m[9];
  const m20 = m[2], m21 = m[6], m22 = m[10];

  const pitch = Math.asin(clamp(-m12, -1, 1));
  let yaw, roll;
  if (Math.abs(m12) < 0.9999) {
    yaw = Math.atan2(m02, m22);
    roll = Math.atan2(m10, m11);
  } else {
    // Gimbal lock: roll and yaw are degenerate, fold everything into yaw.
    yaw = Math.atan2(-m20, m00);
    roll = 0;
  }
  return { yaw, pitch, roll };
}

/** Translation column of the same matrix, in centimetres from the camera. */
export const translationFromMatrix = (m) => ({ x: m[12], y: m[13], z: m[14] });
