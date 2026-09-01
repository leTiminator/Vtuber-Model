/**
 * Mesh-warp shaders.
 *
 * The vertex stage bends a grid laid over the artwork. Each vertex carries two
 * weights: how much it belongs to the head (so it turns, nods and tilts) and
 * how loose it is (so scarves and hair ripple). Everything happens in UV space
 * (0..1 across the image) and is mapped to clip space at the very end.
 *
 * The fragment stage handles the eyes. Blinking a flat drawing is done by
 * re-sampling: inside an eye rectangle, anything above the lid line takes its
 * colour from just above the socket, so the lid is painted in whatever the
 * surrounding face colour happens to be. That works on any artwork without
 * knowing anything about it.
 */

export const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_uv;
in float a_head;   // 1 inside the head, falling smoothly to 0 outside
in float a_loose;  // 1 on free-hanging cloth, 0 on the body

uniform vec2 u_headCenter;
uniform vec2 u_pivot;      // neck: what the head rotates about
uniform float u_yawScaleX;
uniform float u_yawShift;
uniform float u_pitchScaleY;
uniform float u_pitchShift;
uniform float u_roll;
uniform vec2 u_bodyOffset;
uniform float u_bodyRot;
uniform float u_breath;
uniform float u_time;
uniform float u_waveAmp;
uniform float u_waveFreq;
uniform float u_waveSpeed;
uniform float u_aspect;    // image width / height, so rotations stay circular
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

void main() {
  vec2 p = a_uv;

  // --- body: breathes about the neck, leans about a pivot below the frame
  vec2 body = p;
  body.y += (body.y - u_pivot.y) * u_breath;
  body = rotateAbout(body, vec2(u_pivot.x, 1.25), u_bodyRot);
  body += u_bodyOffset;

  // --- head: squash and shift to fake the turn, then tilt about the neck
  vec2 h = p - u_headCenter;
  h.x *= u_yawScaleX;
  h.y *= u_pitchScaleY;
  vec2 head = u_headCenter + h + vec2(u_yawShift, u_pitchShift);
  head = rotateAbout(head, u_pivot, u_roll);
  head += u_bodyOffset;

  vec2 pos = mix(body, head, a_head);

  // --- loose cloth: a wave travelling down the artwork
  float phase = u_time * u_waveSpeed + p.y * u_waveFreq;
  pos += vec2(sin(phase), cos(phase * 0.8) * 0.45) * u_waveAmp * a_loose;

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
uniform vec4 u_eyeL;      // x0, y0, x1, y1 in UV space
uniform vec4 u_eyeR;
uniform float u_blinkL;
uniform float u_blinkR;
uniform vec2 u_gaze;
uniform float u_eyesEnabled;
uniform float u_keyWhite; // 0 = off, otherwise the luminance threshold

bool inside(vec2 uv, vec4 r) {
  return uv.x >= r.x && uv.x <= r.z && uv.y >= r.y && uv.y <= r.w;
}

vec4 eyeColour(vec2 uv, vec4 r, float blink) {
  float lid = r.y + blink * (r.w - r.y);
  if (uv.y <= lid) {
    // Borrow the colour from just above the socket to paint the lid.
    return texture(u_tex, vec2(uv.x, max(r.y - 0.006, 0.0)));
  }
  // Slide the pupil with gaze, faded at the edges so there is no hard seam.
  float fx = smoothstep(r.x, r.x + 0.012, uv.x) * (1.0 - smoothstep(r.z - 0.012, r.z, uv.x));
  float fy = smoothstep(r.y, r.y + 0.012, uv.y) * (1.0 - smoothstep(r.w - 0.012, r.w, uv.y));
  return texture(u_tex, uv - u_gaze * 0.018 * fx * fy);
}

void main() {
  vec2 uv = v_uv;
  vec4 c;

  if (u_eyesEnabled > 0.5 && inside(uv, u_eyeL)) {
    c = eyeColour(uv, u_eyeL, u_blinkL);
  } else if (u_eyesEnabled > 0.5 && inside(uv, u_eyeR)) {
    c = eyeColour(uv, u_eyeR, u_blinkR);
  } else {
    c = texture(u_tex, uv);
  }

  // Optional white-background key, for artwork saved without transparency.
  if (u_keyWhite > 0.0) {
    float hi = max(c.r, max(c.g, c.b));
    float lo = min(c.r, min(c.g, c.b));
    if (hi > u_keyWhite && hi - lo < 0.09) c.a = 0.0;
  }

  fragColor = c;
}
`;
