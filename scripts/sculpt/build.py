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
H, W = mask.shape
STEP = int(os.environ.get('STEP', '1'))
FIG_H = 5.0
scale = FIG_H / H
print(f'{W}x{H}, peak half-thickness {height.max():.0f}px -> {height.max() * scale * ZSCALE:.2f} world')

img = bpy.data.images.load(ART)

gw, gh = W // STEP, H // STEP
ox, oz = -W * scale / 2, -H * scale / 2
verts, faces, uvs = [], [], []
index = {}
for gy in range(gh + 1):
    for gx in range(gw + 1):
        px, py = min(gx * STEP, W - 1), min(gy * STEP, H - 1)
        d = float(height[py, px]) * scale * ZSCALE
        u, v = px / W, 1.0 - py / H
        for side in (0, 1):
            index[(gx, gy, side)] = len(verts)
            verts.append((ox + px * scale, -d if side == 0 else d, oz + (H - py) * scale))
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

mat = bpy.data.materials.new('art')
mat.use_nodes = True
nt = mat.node_tree
nt.nodes.clear()
tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = img
emit = nt.nodes.new('ShaderNodeEmission')
trans = nt.nodes.new('ShaderNodeBsdfTransparent')
mix = nt.nodes.new('ShaderNodeMixShader')
out = nt.nodes.new('ShaderNodeOutputMaterial')
nt.links.new(tex.outputs['Color'], emit.inputs['Color'])
nt.links.new(tex.outputs['Alpha'], mix.inputs['Fac'])
nt.links.new(trans.outputs['BSDF'], mix.inputs[1])
nt.links.new(emit.outputs['Emission'], mix.inputs[2])
nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])
me.materials.append(mat)

world = bpy.data.worlds.new('w'); scene.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.10, 0.105, 0.12, 1)
scene.render.engine = 'CYCLES'
scene.cycles.samples = 8
scene.cycles.use_denoising = False
scene.render.resolution_x, scene.render.resolution_y = W // 2, H // 2
scene.view_settings.view_transform = 'Standard'

for name, deg in (('a00', 0), ('a20', 20), ('a40', 40), ('a90', 90)):
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
