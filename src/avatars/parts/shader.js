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
in float a_follow; // how much of the head's turn this vertex takes, 0..1
in float a_depth;  // how far this vertex stands off the drawing, 0..1

uniform mat3 u_model;      // the joint this part's head end hangs off
/* The joint its far end hangs off, blended in by the same follow weight.
 *
 * The torso was cut into the scarf piece, and that piece hangs off the neck —
 * so tilting the head swung the whole trunk and left a boot standing on its
 * own. A part is not attached at one point: the scarf is held by the neck
 * where it crosses the face and by the hips where it reaches the waist, and
 * which of those a vertex answers to is a question about where it sits, not
 * about which piece the cut put it in. Same weight as the turn, so a point
 * cannot take the head's rotation without taking the head's joint.
 *
 * Equal to u_model for parts held at one joint, which is most of them.
 */
uniform mat3 u_modelFar;
uniform float u_aspect;    // image width / height

// Head turn. Applied before the joint transform, so it bends the art in place.
/* Mirroring, about the head's axis rather than about each part's own.
 *
 * This used to flip the texture coordinate inside whichever part was being
 * drawn, which mirrors that part about the middle of its own box. For the head
 * that is very nearly the head's axis, so it looked right. For the eyes it is
 * not: their box is a small patch off to one side of the face, so flipping
 * inside it left the eye exactly where it was while the face it belongs to
 * moved across. The face did not follow the head.
 *
 * Reflecting the drawing itself about one shared axis is what a mirror does,
 * and it puts every part where its mirror image belongs whatever shape its
 * own box happens to be. Applied before the joints, so a mirrored head still
 * tilts and nods the way its owner does rather than the opposite way.
 */
uniform float u_flip;      // 1 mirrors this part about u_flipAxis
uniform float u_flipAxis;  // in image space, 0..1 across the artwork

/* Where this drawing of the part goes, before anything else moves it.
 *
 * Scale and offset per axis — (1, 0, 1, 0) leaves the part exactly where it
 * was cut from, which is what every part but the eyes uses.
 *
 * The eyes need it because the artwork is one three-quarter view and the pose
 * missing from it is the one people sit in: looking straight at the camera.
 * There is no head-on drawing to switch to, but there is a head-on face
 * hiding inside this one — the near eye is drawn almost square-on already,
 * so sliding the pair onto the head's centre and standing a mirrored copy of
 * that eye opposite it builds the missing view out of the artist's own ink.
 * Nothing is invented, nothing is stretched, and the line weight and colour
 * match because they are the same pixels.
 *
 * A negative x scale is what makes that copy a mirror image.
 */
uniform vec4 u_place;      // x scale, x offset, y scale, y offset

uniform float u_warp;      // 0 disables the whole block
uniform vec2 u_headCenter;
uniform float u_cylR;
uniform float u_yaw;
uniform float u_pitch;
uniform float u_shell;  // 0 bends on the old cylinder, 1 turns the shell
uniform float u_depth;  // how deep the shell is, in the same units as x

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
  /* Cloth arrives already on its bones.
   *
   * This used to look each bone up out of a uniform array with a per-vertex
   * index. It is done on the CPU now — see skinCloth — because that indexing
   * is a known way to get wrong geometry out of a mobile driver, and the
   * scarf was the only part breaking on a phone that matched this machine in
   * every other respect.
   */
  vec2 p = vec2(a_pos.x * u_place.x + u_place.y, a_pos.y * u_place.z + u_place.w);
  if (u_flip > 0.5) p.x = 2.0 * u_flipAxis - p.x;

  /* The head's turn, taken per vertex rather than per part.
   *
   * A cut cannot express a gradient. The scarf is one continuous surface that
   * should follow the head fully where it crosses the face and barely at all
   * where it hangs off the shoulder — but it is cut in two, and giving each
   * piece a single follow factor makes them disagree at the seam. The bend
   * maps a point differently for different angles, so at a 42-degree turn the
   * same point on that seam landed tens of pixels apart in the two parts and
   * the scarf came away from the head.
   *
   * Both sides of the seam compute this from the same function of where the
   * vertex sits, so they cannot disagree there however the parts are cut.
   */
  if (u_warp > 0.5 && a_follow > 0.001) {
    vec2 local = (p - u_headCenter) * vec2(u_aspect, 1.0);
    float yaw = u_yaw * a_follow;
    float pitch = u_pitch * a_follow;

    // The old mapping: a fixed-radius arc, kept so the two can be compared and
    // so the turn can be dialled back to it if the shell reads badly.
    vec2 arc = vec2(cylinder(local.x, u_cylR, yaw),
                    cylinder(local.y, u_cylR * 0.82, pitch));

    /* The shell: an actual rotation of a surface that has depth.
     *
     * Rotating about the vertical axis and then the horizontal one, in that
     * order, is a head turning and then nodding — which is the order a neck
     * does it in, and the reason yaw and pitch stop fighting each other. A
     * vertex at the outline stands at zero depth, so it foreshortens instead
     * of sliding, and the silhouette turns with the surface.
     */
    float z = a_depth * u_depth;
    float cy = cos(yaw), sy = sin(yaw);
    float cp = cos(pitch), sp = sin(pitch);
    vec3 P = vec3(local, z);
    P = vec3(P.x * cy + P.z * sy, P.y, P.z * cy - P.x * sy);
    P = vec3(P.x, P.y * cp - P.z * sp, P.y * sp + P.z * cp);

    p = u_headCenter + mix(arc, P.xy, u_shell) / vec2(u_aspect, 1.0);
  }

  // Blend the transformed points, not the matrices: two rotations averaged
  // element-wise are not a rotation, and the error shows as a squash.
  vec2 near = (u_model * vec3(p, 1.0)).xy;
  vec2 far = (u_modelFar * vec3(p, 1.0)).xy;
  p = mix(far, near, a_follow);

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
  return 1.0 - smoothstep(u_marginMax - 1.5, u_marginMax + 1.5, d);
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
  float upper = -1.0 + blink * 2.25 * (1.0 + 0.28 * bow);
  float lower = 1.0 - squint * 1.1 * (1.0 + 0.28 * bow);

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
