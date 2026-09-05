/**
 * Shaders for the layered puppet.
 *
 * Every part is drawn with the same program. Rigid parts are a single quad
 * carrying a transform; the arms are a grid so they can blend between two
 * joints; the scarf is a strip whose vertices are rebuilt from its bone chain.
 *
 * Positions arrive in image space — 0..1 across the whole artwork, not across
 * the part — so a part sits where it was cut from until a transform moves it.
 * That is what lets the stack reassemble exactly at rest.
 */

export const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_pos;     // image space, 0..1 across the whole artwork
in vec2 a_uv;      // into this part's own texture
in float a_follow; // how much of the near joint this vertex takes, 0..1

uniform mat3 u_model;    // the joint this part's near end hangs off
uniform mat3 u_modelFar; // the joint its far end hangs off; equal to u_model for most parts
uniform float u_aspect;  // image width / height

uniform vec2 u_viewScale;
uniform vec2 u_viewOffset;

out vec2 v_uv;

void main() {
  // Cloth arrives already on its bones (see skinCloth); every other part is
  // placed by its joints. Blend the transformed points, not the matrices: two
  // rotations averaged element-wise are not a rotation, and the error shows
  // as a squash.
  vec2 near = (u_model * vec3(a_pos, 1.0)).xy;
  vec2 far = (u_modelFar * vec3(a_pos, 1.0)).xy;
  vec2 p = mix(far, near, a_follow);

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
uniform float u_shadow;  // >0: draw this part as a contact shadow instead
uniform vec2 u_shadowOffset;

// Eye lids, applied only to the part that carries the eyes.
uniform float u_eyesEnabled;
uniform vec4 u_eyeL;      // centre.xy, half-size.xy, in this part's texture space
uniform vec4 u_eyeR;
uniform float u_eyeAngle;
uniform vec2 u_blink;
/* How much of the eye socket the drawn shard actually is — see lidded(). */
uniform float u_lidFill;
uniform vec2 u_squint;
uniform vec2 u_wide;
uniform vec2 u_gaze;      // where the eyes are looking, -1..1
uniform float u_glow;
uniform float u_glowPulse;
uniform vec2 u_texel;     // one texel of this part, for the glow's blur

/* How much invented margin to draw, in pixels of this part's texture.
 *
 * Every part is grown outward past its own art so that when the part covering
 * it moves, something is revealed rather than a hole. That paint is a guess,
 * and it is only ever right while it stays under its neighbour. The head's
 * mirror swap takes it forty pixels clear of everything behind it, and what
 * had been hidden shows up as a dark haze off the hood and the raised fist —
 * a guess about a seam, drawn against the empty background.
 *
 * u_margin says how far from real art each pixel is, so the guess can be cut
 * back to the few pixels that are still doing their job.
 */
uniform sampler2D u_margin;
uniform float u_marginMax;

float marginCut(vec2 uv) {
  float d = texture(u_margin, uv).r * 255.0;
  // The fade starts at the limit and runs outward, never inward. Centring it
  // on the limit put half the band below zero, so at a limit of zero the
  // drawing itself came out at half alpha — the whole character went
  // translucent the first time a check asked for the art without its padding.
  return 1.0 - smoothstep(u_marginMax, u_marginMax + 2.0, d);
}

vec2 toEye(vec2 uv, vec4 e) {
  vec2 d = uv - e.xy;
  float c = cos(-u_eyeAngle);
  float s = sin(-u_eyeAngle);
  d = vec2(d.x * c - d.y * s, d.x * s + d.y * c);
  return d / max(e.zw, vec2(1e-5));
}

/**
 * A lid sweeping across the socket.
 *
 * It erases the eye layer rather than painting over it. Painting needs a
 * colour, and one flat colour cannot match a visor that is a gradient — it
 * shows as a patch with visible edges, and it leaves the shard's own ink
 * outline sitting there like a ghost, because the outline belongs to this
 * layer too and a rectangle laid over the socket never quite covers it.
 *
 * Erasing has neither problem. The head layer underneath carries the visor,
 * relaxed into the hole where the eye was cut out, so what shows through is
 * the real surface with its real gradient, and the outline goes when the
 * layer holding it goes.
 *
 * Both lids bow — further at the middle than the corners, the way an eyelid
 * actually closes — and overshoot so a shut eye leaves no sliver. The edge is
 * softened over a pixel or so, because a hard cut across a shape this small
 * crawls as the head moves.
 */
vec4 lidded(vec2 uv, vec4 e, float blink, float squint, vec4 base) {
  vec2 p = toEye(uv, e);
  if (abs(p.x) > 1.2 || abs(p.y) > 1.2) return base;
  float bow = 1.0 - clamp(p.x * p.x, 0.0, 1.0);
  // Overshoot the far edge of the socket at full blink.
  //
  // Sweeping to exactly 1.0 puts the lid's soft edge astride the boundary, so
  // the corners of the slit — where the bow is flat and there is no extra
  // travel — end up half covered and stay lit. The socket is measured to fit
  // the slit, so anything past it costs nothing.
  /* The lid starts at the top of the shard, not the top of the socket.
   *
   * The socket is the shard plus a fixed pad for the ink ring around it, so
   * how much of it is shard depends on how big the shard is: two thirds for
   * the turned-away eyes this was tuned on, under a half for the head-on ones.
   * Sweeping the socket therefore shut the smaller pair three times as fast,
   * and a half blink left nothing of them lit at all.
   *
   * Scaled by that fraction, a blink covers the same share of either shard.
   * Reduces to the original expression exactly at the fraction it was tuned
   * at, and the plain sweep is kept as a floor so a very small shard still has
   * its ring cleared at full blink.
   */
  float g = 1.0 + 0.28 * bow;
  float fill = clamp(u_lidFill, 0.05, 1.0);
  // Where the lid is, in the shard's own terms. Reduces to the original
  // expression exactly at the fraction that expression was tuned at.
  float scaled = fill * (blink * 3.409 * g - 1.515);
  /* And the socket's, brought in only at the very end of the sweep.
   *
   * A shard smaller than the pad around it needs a slower lid, which is the
   * whole point of scaling — so taking whichever of the two is further along
   * hands the middle of the range straight back to the socket's sweep and
   * changes nothing at all. Measured: a half blink still shut the head-on eyes
   * outright. The socket's reach is only wanted where it is wanted, which is
   * at a full blink, clearing the ink ring the shard's own sweep stops inside.
   */
  float plain = -1.0 + blink * 2.25 * g;
  float upper = max(scaled, mix(-4.0, plain, smoothstep(0.75, 1.0, blink)));
  float lower = 1.0 - squint * 1.1 * g;

  // 1 where the lid covers, 0 where the eye is still open.
  float soft = 0.045;
  float covered = max(
    1.0 - smoothstep(upper - soft, upper + soft, p.y),
    smoothstep(lower - soft, lower + soft, p.y));
  return vec4(base.rgb, base.a * (1.0 - covered));
}

/**
 * Coverage at a point, and nothing outside the part's own texture.
 *
 * The blur and the shadow's offset both sample past the edge of the quad,
 * where CLAMP_TO_EDGE repeats the border texel outward. Where that border is
 * opaque — the dilated margin usually is — the repeat smears into a hard
 * rectangle the width of the part, which is exactly what appeared as a dark
 * slab beside the scarf.
 */
float alphaAt(vec2 uv) {
  vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture(u_tex, uv).a * marginCut(uv) * inside.x * inside.y;
}

/**
 * How much of the slit survives the lids at this point, sampled from the
 * texture rather than from geometry so the glow follows the shard's real
 * shape. Used to build the halo.
 */
float slitAt(vec2 uv) {
  float a = alphaAt(uv);
  float lum = dot(texture(u_tex, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
  // Only the bright core glows; the ink outline around it does not.
  float core = a * smoothstep(0.55, 0.80, lum);
  vec4 lit = lidded(uv, u_eyeL, u_blink.x, u_squint.x, vec4(1.0, 1.0, 1.0, core));
  lit = lidded(uv, u_eyeR, u_blink.y, u_squint.y, lit);
  return lit.a;
}

/**
 * A soft halo around the slit, blurred out far enough to spill onto the visor.
 *
 * The old glow only tinted pixels that were already bright, so it lived
 * entirely inside the shard and read as a slightly bluer white rather than as
 * light. Light leaves the thing emitting it. Two rings of taps at different
 * radii is enough of a blur for a feature this small, and it closes when the
 * lid does because it is sampled through the same lids.
 */
float halo(vec2 uv) {
  float sum = 0.0;
  float weight = 0.0;
  for (int ring = 1; ring <= 3; ring++) {
    float r = float(ring) * 5.0;
    float w = 1.0 / float(ring * ring);
    for (int k = 0; k < 8; k++) {
      float a = float(k) * 0.7853981634; // 2pi/8
      vec2 off = vec2(cos(a), sin(a)) * r * u_texel;
      sum += slitAt(uv + off) * w;
      weight += w;
    }
  }
  return sum / weight;
}

/**
 * This part's own coverage, blurred, for the shadow it casts.
 *
 * Kept tight on purpose. A contact shadow is the dark line where two surfaces
 * meet; spread it out and it stops reading as contact and starts dimming
 * whatever is nearby — here it reached the glowing slit and took the light
 * out of it.
 */
float softAlpha(vec2 uv) {
  float sum = alphaAt(uv) * 1.6;
  float weight = 1.6;
  for (int ring = 1; ring <= 2; ring++) {
    float r = float(ring) * 2.2;
    float w = 1.0 / float(ring);
    for (int k = 0; k < 8; k++) {
      float ang = float(k) * 0.7853981634;
      sum += alphaAt(uv + vec2(cos(ang), sin(ang)) * r * u_texel) * w;
      weight += w;
    }
  }
  return sum / weight;
}

void main() {
  vec2 uv = v_uv;

  /* Contact shadow pass.
   *
   * Layers sliding over one another with no shading read as paper cutouts —
   * there is nothing to say the scarf is in front of the arm rather than
   * printed on it. This lays a soft dark shape just behind each part before
   * the part itself is drawn, so whatever is underneath is shaded by it.
   *
   * The blend is set up to multiply by the destination's alpha, so the shadow
   * only appears where something has already been drawn. Without that it would
   * halo into empty space — which on a transparent OBS source is a black
   * outline around the whole character.
   */
  if (u_shadow > 0.0) {
    float a = softAlpha(uv - u_shadowOffset);
    fragColor = vec4(0.0, 0.0, 0.0, a * u_shadow * u_opacity);
    return;
  }

  vec4 c = texture(u_tex, uv);
  c.a *= marginCut(uv);

  if (u_eyesEnabled > 0.5) {
    c = lidded(v_uv, u_eyeL, u_blink.x, u_squint.x, c);
    c = lidded(v_uv, u_eyeR, u_blink.y, u_squint.y, c);

    if (u_glow > 0.0) {
      float pulse = u_glow * u_glowPulse;

      // Along the slit, brighter toward whatever the eyes are turned to. A
      // masked face has no pupil to move, so gaze reads as the light shifting
      // inside the visor — which also cannot tear, the way sliding the shard
      // itself would.
      vec2 e = toEye(v_uv, u_eyeL);
      float lookX = clamp(0.5 + 0.6 * (e.x * u_gaze.x + e.y * u_gaze.y), 0.0, 1.0);
      float bias = mix(0.40, 1.55, lookX);

      // Wide eyes burn hotter, squinting banks the fire down.
      float open = 1.0 + 0.45 * max(u_wide.x, u_wide.y)
                       - 0.30 * max(u_squint.x, u_squint.y);

      // Inside the slit: lift toward white-hot.
      float core = smoothstep(0.55, 0.92, dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)));
      c.rgb += vec3(0.42, 0.66, 1.0) * core * c.a * pulse * bias * open * 1.4;

      // Outside it: the halo spilling onto the visor behind.
      float spill = halo(uv) * (1.0 - c.a);
      vec3 lightColour = vec3(0.62, 0.80, 1.0);
      float lit = spill * pulse * bias * open * 2.1;
      c.rgb = mix(c.rgb, lightColour, clamp(lit / max(lit + c.a, 1e-4), 0.0, 1.0));
      c.a = clamp(c.a + lit, 0.0, 1.0);
    }
  }

  c.a *= u_opacity;
  fragColor = c;
}
`;
