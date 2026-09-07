"""
Builds the ninja as a 3D figure in Blender, headless.

    python3 scripts/blender/ninja.py <out-dir>

Writes ninja.blend, ninja.glb and four renders. Units are head radii with the
floor at z=0. Proportions and colours are measured from
public/art/views/pose-front-arms-out.png: scanning down the centre of the face
gives hood 214-306, visor 310-356, scarf from 358, feet at 565, so the head is
164px against 209px of body below the chin, and the scarf starts at the chin
rather than over it.

The figure is built two ways on purpose. Cloth and flesh are soft, so the
torso and limbs are one skinned mesh grown off a stick skeleton. Armour is
crisp, so the helmet and boots stay as booleaned primitives, which a skin or a
remesh would round off.
"""
import math
import os
import sys

import bpy  # noqa: I001 — bmesh and mathutils only exist once bpy has loaded
import bmesh
from mathutils import Vector

OUT = sys.argv[-1] if len(sys.argv) > 1 and not sys.argv[-1].endswith('.py') else 'out'
os.makedirs(OUT, exist_ok=True)


def srgb(r, g, b):
    def lin(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin(r), lin(g), lin(b), 1.0)


HOOD = srgb(78, 79, 79)
VISOR = srgb(96, 108, 136)
SCARF = srgb(237, 38, 52)
TORSO = srgb(28, 33, 50)
SKIN = srgb(125, 103, 90)
GLOVE = srgb(196, 32, 36)
BOOT = srgb(15, 15, 24)
INK = srgb(10, 10, 12)

# --- layout ---------------------------------------------------------------------
# Head radius 1. The drawing's chin sits 164/373 of the way down the figure, so
# with the crown at 4.72 the chin lands at 2.64 and the feet at the floor.
HEAD_Z = 3.68
HEAD_SQUASH = 1.04
CHIN_Z = HEAD_Z - HEAD_SQUASH          # 2.64 — nothing of the scarf may go above this
SHOULDER_Z = 2.42
CHEST_Z = 2.15
HIP_Z = 1.58
KNEE_Z = 0.82
FOOT_Z = 0.16

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
col = scene.collection

# The key light the cel shading is quantised against: front, above, camera left.
LIGHT_DIR = Vector((-0.45, -0.72, 0.53)).normalized()


def toon(name, rgba, shade=0.62, rim=0.0):
    """Flat colour with a single hard shadow step.

    Cel art is not lit, it is painted: one colour and one darker colour with a
    crisp boundary. Cycles has no ShaderToRGB, so the step is taken from the
    surface normal against a fixed light direction and fed straight to an
    emission — which also means the look does not drift when the lamps move.
    """
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    dot = nt.nodes.new('ShaderNodeVectorMath')
    dot.operation = 'DOT_PRODUCT'
    dot.inputs[1].default_value = LIGHT_DIR
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'CONSTANT'
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (0, 0, 0, 1)
    ramp.color_ramp.elements[1].position = 0.42
    ramp.color_ramp.elements[1].color = (1, 1, 1, 1)
    mix = nt.nodes.new('ShaderNodeMixRGB')
    dark = tuple(c * shade for c in rgba[:3]) + (1,)
    mix.inputs['Color1'].default_value = dark
    mix.inputs['Color2'].default_value = rgba
    emit = nt.nodes.new('ShaderNodeEmission')
    emit.inputs['Strength'].default_value = 1.0
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(geo.outputs['Normal'], dot.inputs[0])
    nt.links.new(dot.outputs['Value'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], mix.inputs['Fac'])
    nt.links.new(mix.outputs['Color'], emit.inputs['Color'])
    nt.links.new(emit.outputs['Emission'], out.inputs['Surface'])
    if rim:
        emit.inputs['Strength'].default_value = 1.0 + rim
    return m


MAT = {
    'hood': toon('hood', HOOD),
    'visor': toon('visor', VISOR, shade=0.72),
    'eye': toon('eye', (1, 1, 1, 1), shade=1.0, rim=1.6),
    'scarf': toon('scarf', SCARF, shade=0.58),
    'torso': toon('torso', TORSO, shade=0.66),
    'skin': toon('skin', SKIN),
    'glove': toon('glove', GLOVE, shade=0.6),
    'boot': toon('boot', BOOT, shade=0.7),
    'ink': toon('ink', INK, shade=0.8),
}


def finish(ob, name, mat, smooth=True, subsurf=0, bone=None):
    ob.name = name
    ob.data.name = name
    ob.data.materials.clear()
    ob.data.materials.append(MAT[mat])
    if smooth:
        for p in ob.data.polygons:
            p.use_smooth = True
    if subsurf:
        sm = ob.modifiers.new('sub', 'SUBSURF')
        sm.levels = sm.render_levels = subsurf
    ob['bone'] = bone or 'root'
    return ob


def sphere(name, mat, loc, scale=(1, 1, 1), rot=(0, 0, 0), seg=48, bone=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=seg // 2, location=tuple(loc))
    ob = bpy.context.object
    ob.scale = scale
    ob.rotation_euler = rot
    return finish(ob, name, mat, bone=bone)


def apply_all(ob):
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.ops.object.convert(target='MESH')
    return bpy.context.object


# --- head: a helmet, cut by one egg so rim and visor agree exactly ---------------
def egg(name, loc, scale, chin=0.35):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=48, location=loc)
    ob = bpy.context.object
    bm = bmesh.new(); bm.from_mesh(ob.data)
    for v in bm.verts:
        t = v.co.z
        v.co.x *= 1 - chin * max(0.0, -t) ** 1.5 + 0.08 * max(0.0, t)
    bm.to_mesh(ob.data); bm.free()
    ob.scale = scale
    ob.name = name
    return ob


cutter = egg('cutter', (0, -0.66, HEAD_Z - 0.24), (0.66, 0.70, 0.60))

bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=48, location=(0, 0, HEAD_Z))
hood = bpy.context.object
bm = bmesh.new(); bm.from_mesh(hood.data)
for v in bm.verts:                      # a squarer jaw than a ball
    if v.co.z < -0.55:
        f = 1 - 0.30 * ((-v.co.z - 0.55) / 0.45) ** 2
        v.co.x *= f; v.co.y *= f
bm.to_mesh(hood.data); bm.free()
hood.scale = (1.0, 0.98, HEAD_SQUASH)
for pl in hood.data.polygons:
    pl.use_smooth = True
sh = hood.modifiers.new('shell', 'SOLIDIFY'); sh.thickness = 0.075; sh.offset = -1.0; sh.use_rim = True
cut = hood.modifiers.new('opening', 'BOOLEAN'); cut.operation = 'DIFFERENCE'; cut.object = cutter; cut.solver = 'EXACT'
finish(apply_all(hood), 'hood', 'hood', bone='head')

bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=48, location=(0, 0, HEAD_Z))
visor = bpy.context.object
visor.scale = (0.965, 0.945, HEAD_SQUASH * 0.965)
for pl in visor.data.polygons:
    pl.use_smooth = True
kp = visor.modifiers.new('plate', 'BOOLEAN'); kp.operation = 'INTERSECT'; kp.object = cutter; kp.solver = 'EXACT'
finish(apply_all(visor), 'visor', 'visor', bone='head')
bpy.data.objects.remove(cutter)


def on_visor(az_deg, el_deg, r=1.0):
    az, el = math.radians(az_deg), math.radians(el_deg)
    return Vector((math.sin(az) * math.cos(el) * r,
                   -math.cos(az) * math.cos(el) * r,
                   HEAD_Z + math.sin(el) * r * HEAD_SQUASH))


eyes = []
for sx in (-1, 1):
    at = on_visor(sx * 19, -17, r=0.975)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, location=at)
    e = bpy.context.object
    e.scale = (0.25, 0.05, 0.092)
    normal = (at - Vector((0, 0, HEAD_Z))).normalized()
    e.rotation_euler = normal.to_track_quat('Y', 'Z').to_euler()
    e.rotation_euler.rotate_axis('Y', sx * 0.32)
    eyes.append(e)
bpy.ops.object.select_all(action='DESELECT')
for e in eyes:
    e.select_set(True)
bpy.context.view_layer.objects.active = eyes[0]
bpy.ops.object.join()
eyes = bpy.context.object
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
finish(eyes, 'eyes', 'eye', bone='head')
eyes.shape_key_add(name='Basis')
blink = eyes.shape_key_add(name='blink')
wide = eyes.shape_key_add(name='wide')
cz = on_visor(0, -17).z
for i, v in enumerate(eyes.data.vertices):
    b = v.co.copy()
    blink.data[i].co = Vector((b.x, b.y, cz + (b.z - cz) * 0.06))
    wide.data[i].co = Vector((b.x, b.y, cz + (b.z - cz) * 1.9))

for k, (yaw_deg, el_deg, ln, r) in enumerate([
        (0, 62, 1.00, 0.17), (34, 58, 0.90, 0.15), (-34, 58, 0.88, 0.15),
        (66, 48, 0.74, 0.13), (-66, 48, 0.72, 0.13), (18, 76, 0.66, 0.12), (-20, 74, 0.64, 0.12)]):
    yaw, el = math.radians(yaw_deg), math.radians(el_deg)
    # On the back half of the crown, so it reads as hair escaping the hood.
    n = Vector((math.sin(yaw) * math.cos(el), math.cos(yaw) * math.cos(el) * 0.85, math.sin(el)))
    base = Vector((0, 0, HEAD_Z)) + Vector((n.x, n.y, n.z * HEAD_SQUASH)) * 0.94
    bpy.ops.mesh.primitive_cone_add(vertices=10, radius1=r, radius2=0.0, depth=ln, location=tuple(base))
    c = bpy.context.object
    tip = n.lerp(Vector((0, 0.55, 0.85)).normalized(), 0.45).normalized()
    c.rotation_euler = tip.to_track_quat('Z', 'Y').to_euler()
    c.location = base + tip * (ln * 0.35)
    finish(c, f'tuft{k}', 'ink', bone='head')

# --- body: one skinned mesh off a stick skeleton ---------------------------------
# The Skin modifier grows a connected surface along edges with a radius at each
# vertex, so the shoulder flows out of the chest instead of being a ball stuck
# on a barrel. Its known weakness is pinching where limbs branch, so the branch
# is kept shallow and a corrective smooth follows the subdivision.
JOINTS = {
    'hips':      ((0.00, 0.00, HIP_Z),              0.50),
    'chest':     ((0.00, -0.02, CHEST_Z),           0.63),
    'collar':    ((0.00, -0.02, SHOULDER_Z + 0.34), 0.44),
}
for side, sx in (('L', 1), ('R', -1)):
    JOINTS[f'shoulder.{side}'] = ((sx * 0.40, -0.02, SHOULDER_Z), 0.30)
    JOINTS[f'elbow.{side}'] = ((sx * 1.02, -0.22, SHOULDER_Z - 0.40), 0.20)
    JOINTS[f'wrist.{side}'] = ((sx * 1.55, -0.40, SHOULDER_Z - 0.82), 0.17)
    JOINTS[f'thigh.{side}'] = ((sx * 0.27, 0.00, HIP_Z - 0.22), 0.28)
    JOINTS[f'knee.{side}'] = ((sx * 0.35, -0.10, KNEE_Z), 0.25)
    JOINTS[f'ankle.{side}'] = ((sx * 0.40, 0.00, FOOT_Z + 0.10), 0.21)

BONES = [('hips', 'chest'), ('chest', 'collar')]
for side in ('L', 'R'):
    BONES += [('collar', f'shoulder.{side}'), (f'shoulder.{side}', f'elbow.{side}'),
              (f'elbow.{side}', f'wrist.{side}'), ('hips', f'thigh.{side}'),
              (f'thigh.{side}', f'knee.{side}'), (f'knee.{side}', f'ankle.{side}')]

order = list(JOINTS)
me = bpy.data.meshes.new('body')
me.from_pydata([JOINTS[k][0] for k in order], [(order.index(a), order.index(b)) for a, b in BONES], [])
me.update()
body = bpy.data.objects.new('body', me)
col.objects.link(body)
skin = body.modifiers.new('skin', 'SKIN')
skin.use_smooth_shade = True
body.data.skin_vertices[0].data[order.index('hips')].use_root = True
for i, k in enumerate(order):
    r = JOINTS[k][1]
    body.data.skin_vertices[0].data[i].radius = (r, r)
body.modifiers.new('sub', 'SUBSURF').levels = 2
body.modifiers['sub'].render_levels = 2
cs = body.modifiers.new('smooth', 'SMOOTH')   # relaxes the skin's branch pinching
cs.factor = 0.5
cs.iterations = 8
body = apply_all(body)
finish(body, 'body', 'torso', bone='spine')

# Bare forearms. The body is one surface, so the skin is a second material slot
# handed to the vertices lying near each elbow-to-wrist segment.
body.data.materials.append(MAT['skin'])
skin_slot = len(body.data.materials) - 1


def near_segment(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (p - (a + ab * t)).length, t


for poly in body.data.polygons:
    centre = Vector((0, 0, 0))
    for vi in poly.vertices:
        centre += body.data.vertices[vi].co
    centre /= len(poly.vertices)
    for side in ('L', 'R'):
        a = Vector(JOINTS[f'elbow.{side}'][0])
        b = Vector(JOINTS[f'wrist.{side}'][0])
        d, t = near_segment(centre, a, b)
        if d < 0.30 and -0.25 < t <= 1.2:
            poly.material_index = skin_slot
            break

for side, sx in (('L', 1), ('R', -1)):
    el = Vector(JOINTS[f'elbow.{side}'][0])
    wr = Vector(JOINTS[f'wrist.{side}'][0])
    d = (wr - el).normalized()
    sphere(f'fist.{side}', 'glove', wr + d * 0.16, scale=(0.30, 0.28, 0.28),
           rot=(0.35, 0, sx * 0.45), bone=f'forearm.{side}')
    bpy.ops.mesh.primitive_cylinder_add(vertices=28, radius=0.225, depth=0.17,
                                        location=tuple(el.lerp(wr, 0.88)))
    band = bpy.context.object
    band.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    bev = band.modifiers.new('b', 'BEVEL'); bev.width = 0.05; bev.segments = 3
    finish(apply_all(band), f'wrist.{side}', 'ink', bone=f'forearm.{side}')
    an = Vector(JOINTS[f'ankle.{side}'][0])
    sphere(f'boot.{side}', 'boot', (an.x, an.y - 0.14, FOOT_Z - 0.02),
           scale=(0.30, 0.44, 0.23), bone=f'shin.{side}')

# --- scarf: swept cloth, never above the chin ------------------------------------
def ribbon(name, points, width, bone='neck', thickness=0.075, taper=True):
    """A flat cloth strip along a smooth curve, optionally tapering to its tip."""
    cd = bpy.data.curves.new(name, 'CURVE')
    cd.dimensions = '3D'
    sp = cd.splines.new('BEZIER')
    sp.bezier_points.add(len(points) - 1)
    for bp, p in zip(sp.bezier_points, points):
        bp.co = Vector(p)
        bp.handle_left_type = bp.handle_right_type = 'AUTO'
    prof = bpy.data.curves.new(name + '_p', 'CURVE')
    prof.dimensions = '2D'
    ps = prof.splines.new('POLY'); ps.points.add(1)
    ps.points[0].co = (-width / 2, 0, 0, 1); ps.points[1].co = (width / 2, 0, 0, 1)
    prof_ob = bpy.data.objects.new(name + '_p', prof); col.objects.link(prof_ob)
    helpers = [prof_ob]
    cd.bevel_mode = 'OBJECT'; cd.bevel_object = prof_ob
    if taper:
        tp = bpy.data.curves.new(name + '_t', 'CURVE')
        tp.dimensions = '2D'
        ts = tp.splines.new('BEZIER'); ts.bezier_points.add(2)
        for bp, (x, y) in zip(ts.bezier_points, [(0, 1.0), (0.55, 0.88), (1.0, 0.08)]):
            bp.co = (x, y, 0); bp.handle_left_type = bp.handle_right_type = 'AUTO'
        tp_ob = bpy.data.objects.new(name + '_t', tp); col.objects.link(tp_ob)
        cd.taper_object = tp_ob
        helpers.append(tp_ob)
    for h in helpers:
        h.hide_render = h.hide_viewport = True
    cd.use_fill_caps = True; cd.resolution_u = 32; cd.twist_mode = 'MINIMUM'
    ob = bpy.data.objects.new(name, cd); col.objects.link(ob)
    ob = apply_all(ob)
    so = ob.modifiers.new('solid', 'SOLIDIFY'); so.thickness = thickness
    ob.modifiers.new('sub', 'SUBSURF').levels = 1
    ob = apply_all(ob)
    finish(ob, name, 'scarf', bone=bone)
    for h in helpers:
        bpy.data.objects.remove(h)
    return ob


bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=0.34, depth=0.75,
                                    location=(0, -0.01, CHIN_Z - 0.30))
neck = bpy.context.object
bv = neck.modifiers.new('b', 'BEVEL'); bv.width = 0.06; bv.segments = 3
finish(apply_all(neck), 'neck', 'torso', bone='neck')

# The collar: cloth bundled round the neck, its top edge held below the chin —
# the chin is the bottom of the face, and covering it was the fault this rebuild
# exists to fix. A flared open cone showed its own hollow, so this is a closed
# bundle instead.
# Sized from the drawing: at the chest the red spans 90px against a 142px head,
# so the bundle is 0.63 head radii to a side, not the 0.86 it was.
COLLAR_Z = CHIN_Z - 0.28
bpy.ops.mesh.primitive_torus_add(location=(0, -0.03, COLLAR_Z), major_radius=0.40,
                                 minor_radius=0.215, major_segments=56, minor_segments=20)
collar = bpy.context.object
collar.rotation_euler = (math.radians(-7), 0, 0)
collar.scale = (1.02, 0.96, 0.92)
finish(apply_all(collar), 'scarf_wrap', 'scarf', bone='neck')

# A second turn below it, and a bib hanging down the chest — the scarf reaches
# well past the collarbone in the drawing, but hugging the body, not flaring.
bpy.ops.mesh.primitive_torus_add(location=(0.04, -0.02, COLLAR_Z - 0.30), major_radius=0.44,
                                 minor_radius=0.185, major_segments=56, minor_segments=18)
turn = bpy.context.object
turn.rotation_euler = (math.radians(9), math.radians(-6), 0)
turn.scale = (1.0, 0.92, 0.78)
finish(apply_all(turn), 'scarf_bib', 'scarf', bone='neck')

bpy.ops.mesh.primitive_uv_sphere_add(segments=40, ring_count=20,
                                     location=(0.02, -0.30, COLLAR_Z - 0.62))
bib = bpy.context.object
bib.scale = (0.34, 0.20, 0.30)
bib.rotation_euler = (math.radians(12), 0, 0)
finish(apply_all(bib), 'scarf_front', 'scarf', bone='spine')

# The two tails, streaming up and back off the collar. They are meant to fly
# above the head; the check below is that they pass behind it, not across it.
ribbon('scarf_tail_a', [
    (0.50, 0.40, COLLAR_Z + 0.10), (1.25, 1.05, CHIN_Z + 0.45), (1.55, 1.30, CHIN_Z + 1.55),
    (0.70, 1.20, CHIN_Z + 2.35), (-0.90, 0.95, CHIN_Z + 2.05), (-2.30, 1.10, CHIN_Z + 1.20),
    (-3.10, 0.95, CHIN_Z + 0.50),
], 0.72)
ribbon('scarf_tail_b', [
    (-0.50, 0.42, COLLAR_Z - 0.05), (-1.25, 1.00, CHIN_Z - 0.10), (-2.20, 1.10, CHIN_Z + 0.25),
    (-3.20, 0.85, CHIN_Z + 0.00), (-3.90, 0.70, CHIN_Z - 0.50),
], 0.50)

bpy.ops.mesh.primitive_torus_add(location=(0, -0.02, HIP_Z + 0.14), major_radius=0.52,
                                 minor_radius=0.085, major_segments=48, minor_segments=12)
sash = bpy.context.object
sash.scale = (1.06, 0.95, 0.8)
finish(apply_all(sash), 'sash', 'scarf', bone='spine')

# --- the checks this rebuild exists for -------------------------------------------
# Two separate properties, because the scarf does two different jobs. The part
# around the neck must stay below the chin — the chin is the bottom of the face,
# and the previous build covered it. The tails are supposed to fly above the
# head, but they must pass behind it, never across the face.
def extent(name):
    ob = bpy.data.objects[name]
    vs = [ob.matrix_world @ v.co for v in ob.data.vertices]
    return vs


fails = []
for name in ('scarf_wrap', 'scarf_bib', 'scarf_front', 'sash'):
    top = max(v.z for v in extent(name))
    if top > CHIN_Z:
        fails.append(f'{name} reaches z={top:.3f}, over the chin at {CHIN_Z:.3f}')
    else:
        print(f'  ok  {name} tops out at {top:.3f}, chin {CHIN_Z:.3f}')

FACE_Y = -0.45           # anything nearer the camera than this, beside the head, is on the face
for name in ('scarf_tail_a', 'scarf_tail_b'):
    over = [v for v in extent(name) if v.z > CHIN_Z and v.y < FACE_Y and abs(v.x) < 1.25]
    if over:
        fails.append(f'{name} crosses the face: {len(over)} vertices in front of it')
    else:
        print(f'  ok  {name} stays behind the head')

if fails:
    raise SystemExit('FAIL: ' + '; '.join(fails))

# --- rig -------------------------------------------------------------------------
arm_data = bpy.data.armatures.new('ninja_rig')
rig = bpy.data.objects.new('ninja_rig', arm_data)
col.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='EDIT')
eb = arm_data.edit_bones


def bone(name, head, tail, parent=None, connect=False):
    b = eb.new(name)
    b.head, b.tail = Vector(head), Vector(tail)
    if parent:
        b.parent = eb[parent]
        b.use_connect = connect
    return b


bone('root', (0, 0, 0), (0, 0, 0.3))
bone('hips', (0, 0, HIP_Z - 0.2), (0, 0, HIP_Z + 0.2), 'root')
bone('spine', (0, 0, HIP_Z + 0.2), (0, 0, CHEST_Z + 0.3), 'hips', True)
bone('neck', (0, 0, CHEST_Z + 0.3), (0, 0, CHIN_Z - 0.05), 'spine', True)
bone('head', (0, 0, CHIN_Z - 0.05), (0, 0, HEAD_Z + 1.0), 'neck', True)
for side, sx in (('L', 1), ('R', -1)):
    j = lambda k: JOINTS[f'{k}.{side}'][0]
    bone(f'shoulder.{side}', (0, 0, SHOULDER_Z + 0.12), j('shoulder'), 'spine')
    bone(f'upper_arm.{side}', j('shoulder'), j('elbow'), f'shoulder.{side}', True)
    bone(f'forearm.{side}', j('elbow'), j('wrist'), f'upper_arm.{side}', True)
    bone(f'thigh.{side}', j('thigh'), j('knee'), 'hips')
    bone(f'shin.{side}', j('knee'), j('ankle'), f'thigh.{side}', True)
bpy.ops.object.mode_set(mode='OBJECT')

# The one skinned body is weighted automatically so it bends; every crisp piece
# rides one bone, which is what a rigid cutout wants.
for ob in list(col.objects):
    if ob.type != 'MESH' or 'bone' not in ob:
        continue
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if ob.name == 'body':
        ob.select_set(True); rig.select_set(True)
        bpy.context.view_layer.objects.active = rig
        bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    else:
        vg = ob.vertex_groups.new(name=ob['bone'])
        vg.add(list(range(len(ob.data.vertices))), 1.0, 'REPLACE')
        ob.modifiers.new('rig', 'ARMATURE').object = rig
        ob.parent = rig

# --- stage ------------------------------------------------------------------------
world = bpy.data.worlds.new('world')
scene.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.10, 0.105, 0.12, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0


def camera(name, yaw_deg, dist=10.5, height=2.4, lens=70):
    cd = bpy.data.cameras.new(name)
    cd.lens = lens
    cam = bpy.data.objects.new(name, cd)
    col.objects.link(cam)
    yaw = math.radians(yaw_deg)
    cam.location = (math.sin(yaw) * dist, -math.cos(yaw) * dist, height + 0.5)
    cam.rotation_euler = (Vector((0, 0, height)) - Vector(cam.location)).to_track_quat('-Z', 'Y').to_euler()
    return cam


cams = {'front': camera('cam_front', 0), 'threequarter': camera('cam_tq', 35),
        'side': camera('cam_side', 90), 'back': camera('cam_back', 145)}

scene.render.engine = 'CYCLES'
scene.cycles.samples = 16          # emission shaders: no light to converge
scene.cycles.use_denoising = False
scene.cycles.device = 'CPU'
scene.render.resolution_x = 640
scene.render.resolution_y = 800
scene.render.film_transparent = False
scene.view_settings.view_transform = 'Standard'

# Ink lines. Freestyle draws the drawing's heavy outline; if this build of the
# module has no Freestyle, say so rather than silently shipping a soft edge.
ink_mode = 'none'
if hasattr(scene.render, 'use_freestyle'):
    scene.render.use_freestyle = True
    scene.render.line_thickness_mode = 'ABSOLUTE'
    scene.render.line_thickness = 2.2
    vl = scene.view_layers[0]
    vl.use_freestyle = True
    fs = vl.freestyle_settings
    ls = fs.linesets[0] if fs.linesets else fs.linesets.new('ink')
    ls.select_silhouette = True
    ls.select_border = True
    ls.select_crease = True
    ls.select_edge_mark = False
    if ls.linestyle is None:                  # the module build makes the set but not the style
        ls.linestyle = bpy.data.linestyles.new('ink')
    ls.linestyle.color = (0, 0, 0)
    ls.linestyle.thickness = 2.2
    ink_mode = 'freestyle'
print('ink:', ink_mode)

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'ninja.blend'))
for name, cam in cams.items():
    scene.camera = cam
    scene.render.filepath = os.path.join(OUT, f'{name}.png')
    bpy.ops.render.render(write_still=True)

bpy.ops.object.select_all(action='DESELECT')
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'ninja.glb'), export_format='GLB',
                          export_apply=True, export_yup=True)
meshes = [o for o in col.objects if o.type == 'MESH']
print('meshes:', len(meshes), '| bones:', len(arm_data.bones),
      '| shape keys:', [k.name for k in eyes.data.shape_keys.key_blocks])
