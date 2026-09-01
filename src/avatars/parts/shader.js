/**
 * Shaders for the layered puppet.
 *
 * Every part is drawn with the same program. Simple parts are a single quad
 * carrying a transform; the head is a small grid so the cylindrical turn can
 * bend it; the scarf is a strip whose vertices are rebuilt from its bone chain.
 *
 * Positions arrive in image space — 0..1 across the whole artwork, not across
 * the part — so a part sits where it was cut from until a transform moves it.
 * That is what lets the stack reassemble exactly at rest.
 */

export const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_pos;   // image space, 0..1 across the whole artwork
in vec2 a_uv;    // into this part's own texture

uniform mat3 u_model;      // this part's joint transform, in image space
uniform float u_aspect;    // image width / height

// Head turn. Applied before the joint transform, so it bends the art in place.
uniform float u_warp;      // 0 disables the whole block
uniform vec2 u_headCenter;
uniform float u_cylR;
uniform float u_yaw;
uniform float u_pitch;

uniform vec2 u_viewScale;
uniform vec2 u_viewOffset;

out vec2 v_uv;

/**
 * Rotate a point on a cylinder of radius R and read off its new position.
 * The centreline term is subtracted, or the head translates by R*sin(a) as well
 * as rotating — which at a 25 degree turn slides it most of its own width.
 */
float cylinder(float x, float R, float angle) {
  return R * (sin(asin(clamp(x / R, -0.999, 0.999)) + angle) - sin(angle));
}

void main() {
  vec2 p = a_pos;

  if (u_warp > 0.5) {
    vec2 local = (p - u_headCenter) * vec2(u_aspect, 1.0);
    local.x = cylinder(local.x, u_cylR, u_yaw);
    local.y = cylinder(local.y, u_cylR * 0.82, u_pitch);
    p = u_headCenter + local / vec2(u_aspect, 1.0);
  }

  p = (u_model * vec3(p, 1.0)).xy;

  v_uv = a_uv;
  vec2 ndc = (p * u_viewScale + u_viewOffset) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_tex;
uniform float u_opacity;

// Eye lids, applied only to the part that carries the eyes.
uniform float u_eyesEnabled;
uniform vec4 u_eyeL;      // centre.xy, half-size.xy, in this part's texture space
uniform vec4 u_eyeR;
uniform float u_eyeAngle;
uniform vec3 u_lidL;
uniform vec3 u_lidR;
uniform vec2 u_blink;
uniform vec2 u_squint;
uniform float u_glow;
uniform float u_glowPulse;

vec2 toEye(vec2 uv, vec4 e) {
  vec2 d = uv - e.xy;
  float c = cos(-u_eyeAngle);
  float s = sin(-u_eyeAngle);
  d = vec2(d.x * c - d.y * s, d.x * s + d.y * c);
  return d / max(e.zw, vec2(1e-5));
}

/**
 * A lid sweeping across the socket, painted in a flat colour taken from the
 * face around it. Both lids bow — further at the middle than the corners, the
 * way an eyelid actually closes — and overshoot so a shut eye leaves no sliver.
 */
vec4 lidded(vec2 uv, vec4 e, vec3 lid, float blink, float squint, vec4 base) {
  vec2 p = toEye(uv, e);
  if (abs(p.x) > 1.0 || abs(p.y) > 1.0) return base;
  float bow = 1.0 - p.x * p.x;
  float upper = -1.0 + blink * 2.0 * (1.0 + 0.28 * bow);
  float lower = 1.0 - squint * 1.1 * (1.0 + 0.28 * bow);
  if (p.y <= upper || p.y >= lower) return vec4(lid, base.a);
  return base;
}

void main() {
  vec4 c = texture(u_tex, v_uv);

  if (u_eyesEnabled > 0.5) {
    c = lidded(v_uv, u_eyeL, u_lidL, u_blink.x, u_squint.x, c);
    c = lidded(v_uv, u_eyeR, u_lidR, u_blink.y, u_squint.y, c);
    if (u_glow > 0.0) {
      float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb += vec3(0.55, 0.78, 1.0) * smoothstep(0.62, 0.95, lum) * c.a * u_glow * u_glowPulse;
    }
  }

  c.a *= u_opacity;
  fragColor = c;
}
`;
