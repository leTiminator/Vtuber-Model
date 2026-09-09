"""
Extrudes the height field into a solid and renders a turnaround.

    python3 scripts/sculpt/build.py <out-dir> [z-scale]

depth.py writes a half-thickness at every pixel. The surface is that height
above the mid-plane and its mirror below, so the model is a closed solid whose
orthographic front silhouette is the drawing.

STEP thins the grid (1 is a vertex per drawing pixel), DECIMATE sets the export
ratio; the silhouette is measured on the renders, before the decimation runs.
"""
import math
import os
import sys

import bpy  # noqa: I001 — bmesh and mathutils only exist once bpy has loaded
import bmesh
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from png import read_png, write_png                          # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, 'scripts', 'sculpt', 'out')
ART = os.path.join(ROOT, 'public', 'art', 'views', 'pose-front-arms-out-full.png')
OUT = sys.argv[1]
ZSCALE = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

height = np.load(os.path.join(DATA, 'height.npy'))
mask = np.load(os.path.join(DATA, 'mask.npy'))
CENTRE = os.path.join(DATA, 'centre.npy')
centre = np.load(CENTRE) if os.path.exists(CENTRE) else np.zeros_like(height)
H, W = mask.shape
STEP = int(os.environ.get('STEP', '1'))
FIG_H = 5.0
scale = FIG_H / H
print(f'{W}x{H}, peak half-thickness {height.max():.0f}px -> {height.max() * scale * ZSCALE:.2f} world')

img = bpy.data.images.load(ART)
BACK = os.path.join(DATA, 'backing.png')
back_img = bpy.data.images.load(BACK) if os.path.exists(BACK) else None

gw, gh = W // STEP, H // STEP
ox, oz = -W * scale / 2, -H * scale / 2
verts, faces, uvs = [], [], []
index = {}
for gy in range(gh + 1):
    for gx in range(gw + 1):
        px, py = min(gx * STEP, W - 1), min(gy * STEP, H - 1)
        d = float(height[py, px]) * scale * ZSCALE
        m = float(centre[py, px]) * scale * ZSCALE
        u, v = px / W, 1.0 - py / H
        for side in (0, 1):
            index[(gx, gy, side)] = len(verts)
            verts.append((ox + px * scale, m - d if side == 0 else m + d, oz + (H - py) * scale))
            uvs.append((u, v))

for gy in range(gh):
    for gx in range(gw):
        ok = True
        for dx, dy in ((0, 0), (1, 0), (1, 1), (0, 1)):
            px, py = min((gx + dx) * STEP, W - 1), min((gy + dy) * STEP, H - 1)
            if not mask[py, px]:
                ok = False
                break
        if not ok:
            continue
        a = [index[(gx, gy, 0)], index[(gx + 1, gy, 0)], index[(gx + 1, gy + 1, 0)], index[(gx, gy + 1, 0)]]
        b = [index[(gx, gy, 1)], index[(gx + 1, gy, 1)], index[(gx + 1, gy + 1, 1)], index[(gx, gy + 1, 1)]]
        faces.append((a[0], a[3], a[2], a[1]))
        faces.append((b[0], b[1], b[2], b[3]))

me = bpy.data.meshes.new('ninja')
me.from_pydata(verts, [], faces)
me.update()
ob = bpy.data.objects.new('ninja', me)
scene.collection.objects.link(ob)
uv = me.uv_layers.new(name='UVMap')
for loop in me.loops:
    uv.data[loop.index].uv = uvs[loop.vertex_index]

bm = bmesh.new()
bm.from_mesh(me)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
rim = [e for e in bm.edges if len(e.link_faces) == 1]
bmesh.ops.holes_fill(bm, edges=rim, sides=4)
bm.to_mesh(me)
bm.free()
for p in me.polygons:
    p.use_smooth = True

def flat_material(name, colour_image):
    """Paint straight from an image, cut out by the drawing's own alpha."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = colour_image
    cut = nt.nodes.new('ShaderNodeTexImage'); cut.image = img
    emit = nt.nodes.new('ShaderNodeEmission')
    trans = nt.nodes.new('ShaderNodeBsdfTransparent')
    mix = nt.nodes.new('ShaderNodeMixShader')
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(tex.outputs['Color'], emit.inputs['Color'])
    nt.links.new(cut.outputs['Alpha'], mix.inputs['Fac'])
    nt.links.new(trans.outputs['BSDF'], mix.inputs[1])
    nt.links.new(emit.outputs['Emission'], mix.inputs[2])
    nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])
    return mat


me.materials.append(flat_material('art', img))
if back_img is not None:
    me.materials.append(flat_material('back', back_img))
    # Which side a face is on, measured against the mid-surface rather than zero,
    # because a trailing ribbon sits well behind the plane and is still its front.
    # The front half carries the drawing, the far half a flat colour, so the back
    # of the head is a hood and not a second face.
    uvd = me.uv_layers['UVMap'].data
    for poly in me.polygons:
        y = sum(me.vertices[v].co.y for v in poly.vertices) / len(poly.vertices)
        us = [uvd[i].uv for i in poly.loop_indices]
        px = min(int(sum(p[0] for p in us) / len(us) * W), W - 1)
        py = min(int((1.0 - sum(p[1] for p in us) / len(us)) * H), H - 1)
        poly.material_index = 1 if y > float(centre[py, px]) * scale * ZSCALE + 1e-6 else 0

world = bpy.data.worlds.new('w'); scene.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.10, 0.105, 0.12, 1)
scene.render.engine = 'CYCLES'
scene.cycles.samples = 8
scene.cycles.use_denoising = False
scene.render.resolution_x, scene.render.resolution_y = W // 2, H // 2
scene.view_settings.view_transform = 'Standard'

ANGLES = [int(a) for a in os.environ.get('ANGLES', '0,45,90,135,180,225,270,315').split(',')]
for deg in ANGLES:
    name = f'a{deg:03d}'
    cd = bpy.data.cameras.new(name)
    cd.type = 'ORTHO'
    cd.ortho_scale = FIG_H * (W / H) * 1.04
    cam = bpy.data.objects.new(name, cd)
    scene.collection.objects.link(cam)
    t = math.radians(deg)
    cam.location = (math.sin(t) * 13.0, -math.cos(t) * 13.0, 0.0)
    cam.rotation_euler = (Vector((0, 0, 0)) - Vector(cam.location)).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam
    scene.render.filepath = os.path.join(OUT, f'{name}.png')
    bpy.ops.render.render(write_still=True)

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'ninja.blend'))
full = len(me.vertices)

# One sheet of the whole turnaround, in the order rendered, so a fault that only
# shows at one angle is seen beside the angles it does not show at.
tiles = [read_png(os.path.join(OUT, f'a{d:03d}.png'))[:, :, :3] for d in ANGLES]
cols = 4 if len(tiles) > 3 else len(tiles)
rows = (len(tiles) + cols - 1) // cols
th, tw, _ = tiles[0].shape
pad = 10
sheet = np.full((rows * th + (rows + 1) * pad, cols * tw + (cols + 1) * pad, 3), 24, np.uint8)
for k, t in enumerate(tiles):
    r, c = divmod(k, cols)
    y, x = pad + r * (th + pad), pad + c * (tw + pad)
    sheet[y:y + th, x:x + tw] = t
write_png(os.path.join(OUT, 'turnaround.png'), sheet)
print('turnaround:', ' '.join(f'{d}deg' for d in ANGLES))

# A one-pixel grid is two million vertices, which is right for proving the
# silhouette and wrong for anything that has to load it. Decimate a copy for
# export; the silhouette is measured on the render above, before this runs.
dec = ob.modifiers.new('dec', 'DECIMATE')
dec.ratio = float(os.environ.get('DECIMATE', '0.06'))
bpy.context.view_layer.objects.active = ob
bpy.ops.object.select_all(action='DESELECT')
ob.select_set(True)
bpy.ops.object.modifier_apply(modifier='dec')
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'ninja.glb'), export_format='GLB',
                          export_apply=True, export_yup=True)
print('verts:', full, '-> exported', len(me.vertices), 'faces:', len(me.polygons))
