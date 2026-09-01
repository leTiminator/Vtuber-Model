/**
 * Mesh-warp shaders.
 *
 * The vertex stage bends a grid laid over the artwork. Each vertex carries six
 * region weights plus two "how far along am I" parameters, packed into two
 * vec4s. Regions move independently, so the scarf can flow while the torso
 * holds still and the legs barely move.
 *
 * Head rotation is a cylindrical remap rather than a squash:
 *
 *     x' = R * sin(asin(x / R) + yaw)
 *
 * which compresses the side turning away and spreads the side turning toward
 * the camera — the thing that actually reads as a head turning. On top of that,
 * the face plate is treated as sitting in front of the skull, so it slides
 * across as you turn. That parallax sells the rotation more than the remap does.
 *
 * The fragment stage owns the eyes. Blinking and squinting re-sample the colour
 * from just outside the socket, painting a lid in whatever the surrounding face
 * colour happens to be — so it needs no closed-eye artwork and adapts to any
 * style. The lid is bowed rather than straight; a flat lid is the single thing
 * that most reads as cheap.
 */

export const CHAIN_SAMPLES = 16;

export const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_uv;
in vec4 a_w0;  // head, face, tufts, cloth
in vec4 a_w1;  // torso, lower, clothT, tuftT

uniform vec2 u_headCenter;
uniform vec2 u_pivot;
uniform float u_aspect;      // image width / height
uniform float u_cylR;        // cylinder radius for the head remap, in square UV
uniform float u_yaw;
uniform float u_pitch;
uniform float u_roll;
uniform float u_parallax;    // how far the face plate slides across the skull
uniform vec2 u_bodyOffset;
uniform float u_bodyRot;
uniform float u_breath;
uniform float u_lowerDamping;
uniform vec2 u_cloth[${CHAIN_SAMPLES}];
uniform vec2 u_tuft[${CHAIN_SAMPLES}];
uniform float u_clothWeight;
uniform float u_tuftWeight;
uniform vec2 u_viewScale;
uniform vec2 u_viewOffset;

out vec2 v_uv;

vec2 rotateAbout(vec2 p, vec2 centre, float angle) {
  vec2 r = (p - centre) * vec2(u_aspect, 1.0);
  float c = cos(angle);
  float s = sin(angle);
  r = vec2(r.x * c - r.y * s, r.x * s + r.y * c);
  return centre + r / vec2(u_aspect, 1.0);
}

/**
 * Rotate a point on a cylinder of radius R and read off its new position.
 *
 * The centreline term is subtracted, or the whole head translates by R*sin(a)
 * as well as rotating — which at a 25 degree turn slides it most of its own
 * width across the frame.
 */
float cylinder(float x, float R, float angle) {
  return R * (sin(asin(clamp(x / R, -0.999, 0.999)) + angle) - sin(angle));
}

vec2 sampleCloth(float t) {
  float f = clamp(t, 0.0, 1.0) * float(${CHAIN_SAMPLES} - 1);
  int i = int(floor(f));
  int j = min(i + 1, ${CHAIN_SAMPLES} - 1);
  return mix(u_cloth[i], u_cloth[j], fract(f));
}

vec2 sampleTuft(float t) {
  float f = clamp(t, 0.0, 1.0) * float(${CHAIN_SAMPLES} - 1);
  int i = int(floor(f));
  int j = min(i + 1, ${CHAIN_SAMPLES} - 1);
  return mix(u_tuft[i], u_tuft[j], fract(f));
}

/** Lean, twist and breathe, scaled by "amount" so the legs can move less. */
vec2 bodyTransform(vec2 p, float amount) {
  vec2 b = p;
  b.y += (b.y - u_pivot.y) * u_breath * amount;
  b = mix(p, rotateAbout(b, vec2(u_pivot.x, 1.25), u_bodyRot), amount);
  return b + u_bodyOffset * amount;
}

void main() {
  vec2 p = a_uv;
  float wHead = max(a_w0.x, a_w0.y);
  float wFace = a_w0.y;

  // --- head: turn on a cylinder, then tilt about the neck ---------------
  vec2 hl = (p - u_headCenter) * vec2(u_aspect, 1.0);
  hl.x = cylinder(hl.x, u_cylR, u_yaw);
  hl.y = cylinder(hl.y, u_cylR * 0.82, u_pitch);
  vec2 headPos = u_headCenter + hl / vec2(u_aspect, 1.0);

  // The face sits in front of the skull's axis, so it travels further.
  headPos.x += wFace * u_parallax * sin(u_yaw) / u_aspect;
  headPos.y += wFace * u_parallax * 0.7 * sin(u_pitch);

  headPos = rotateAbout(headPos, u_pivot, u_roll);
  headPos += u_bodyOffset;

  // --- body -------------------------------------------------------------
  vec2 pos = mix(bodyTransform(p, 1.0), bodyTransform(p, u_lowerDamping), a_w1.y);
  pos = mix(pos, headPos, wHead);

  // --- cloth and tufts, displaced along their own length ----------------
  pos += sampleCloth(a_w1.z) * a_w0.w * u_clothWeight;
  pos += sampleTuft(a_w1.w) * a_w0.z * u_tuftWeight;

  v_uv = a_uv;
  vec2 ndc = (pos * u_viewScale + u_viewOffset) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_tex;
uniform vec4 u_eyeL;      // centre.xy, half-size.xy in UV
uniform vec4 u_eyeR;
uniform float u_eyeAngle; // eyes are rarely level in a drawing
uniform float u_aspect;
uniform vec3 u_lidL;      // flat colour the lid is painted in
uniform vec3 u_lidR;
uniform vec2 u_blink;     // left, right
uniform vec2 u_squint;
uniform vec2 u_gaze;
uniform float u_eyesEnabled;
uniform float u_glow;
uniform float u_glowPulse;
uniform float u_keyWhite;

/** UV to eye-local coordinates, -1..1 across the socket along its own axes. */
vec2 toEye(vec2 uv, vec4 e) {
  vec2 d = (uv - e.xy) * vec2(u_aspect, 1.0);
  float c = cos(-u_eyeAngle);
  float s = sin(-u_eyeAngle);
  d = vec2(d.x * c - d.y * s, d.x * s + d.y * c);
  return d / vec2(max(e.z * u_aspect, 1e-5), max(e.w, 1e-5));
}

/**
 * Colour inside an eye socket, with the lids applied.
 *
 * The lid is painted in a flat colour sampled from the face around the socket,
 * not by resampling a row of the texture. Resampling stretches whatever edge
 * happens to sit on the socket boundary into a hard band; on cel-shaded art a
 * flat fill is both simpler and what a closed eye actually looks like.
 *
 * Both lids bow, travelling further at the middle than at the corners the way a
 * real eyelid does. The bow overshoots so a fully shut eye leaves no sliver
 * open in the corners.
 */
vec4 eyeColour(vec2 uv, vec4 e, vec3 lid, float blink, float squint) {
  vec2 p = toEye(uv, e);
  float bow = 1.0 - p.x * p.x;

  float upper = -1.0 + blink * 2.0 * (1.0 + 0.28 * bow);
  float lower = 1.0 - squint * 1.1 * (1.0 + 0.28 * bow);
  if (p.y <= upper || p.y >= lower) return vec4(lid, 1.0);

  // Gaze slides the pupil, faded at the rim so there is no hard seam.
  float fade = (1.0 - smoothstep(0.7, 1.0, abs(p.x))) * (1.0 - smoothstep(0.7, 1.0, abs(p.y)));
  return texture(u_tex, uv - u_gaze * 0.018 * fade);
}

void main() {
  vec2 uv = v_uv;
  vec4 c;
  bool inEye = false;

  vec2 pl = toEye(uv, u_eyeL);
  vec2 pr = toEye(uv, u_eyeR);
  bool inL = u_eyesEnabled > 0.5 && abs(pl.x) <= 1.0 && abs(pl.y) <= 1.0;
  bool inR = u_eyesEnabled > 0.5 && abs(pr.x) <= 1.0 && abs(pr.y) <= 1.0;

  if (inL) {
    c = eyeColour(uv, u_eyeL, u_lidL, u_blink.x, u_squint.x);
    inEye = true;
  } else if (inR) {
    c = eyeColour(uv, u_eyeR, u_lidR, u_blink.y, u_squint.y);
    inEye = true;
  } else {
    c = texture(u_tex, uv);
  }

  // Glow rides on whatever is bright inside the socket, so it lights the eye
  // itself rather than the plate around it — no artwork knowledge needed.
  if (inEye && u_glow > 0.0) {
    float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    float bright = smoothstep(0.62, 0.95, lum) * c.a;
    c.rgb += vec3(0.55, 0.78, 1.0) * bright * u_glow * u_glowPulse;
  }

  if (u_keyWhite > 0.0) {
    float hi = max(c.r, max(c.g, c.b));
    float lo = min(c.r, min(c.g, c.b));
    if (hi > u_keyWhite && hi - lo < 0.09) c.a = 0.0;
  }

  fragColor = c;
}
`;
