"""
Builds the ninja in 3D by tracing the drawing rather than modelling it.

    python3 scripts/blender/trace.py <out-dir>

It traces public/art/views/pose-front-arms-out-full.png — the owner's original
upload at 1373x1145, not the 630 copy, whose eyes were keyed out with the white
background on the way in. The silhouette of that image becomes the model's silhouette exactly — a grid keeps the quads whose
pixels are opaque and drops the rest — and a distance transform of the same
mask gives it thickness, so the outline stays crisp at the edge and the figure
bulges through the torso. The drawing is then the texture, so every ink line
and every painted shadow is the artist's rather than something invented.

Earlier versions built the character out of spheres and cylinders and tried to
paint them back into looking like the drawing. That inverts the problem: the
drawing already holds the silhouette, the line weights and the shading.
"""
import os
import sys

import bpy  # noqa: I001 — bmesh and mathutils only exist once bpy has loaded
import bmesh
import numpy as np
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ART = os.path.join(ROOT, 'public', 'art', 'views', 'pose-front-arms-out-full.png')
OUT = sys.argv[-1]
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)

STEP = 4          # pixels per grid quad: 1373x1145 -> about 343x286
HEIGHT = 5.0      # world height of the figure
DEPTH = 0.62      # world depth at the thickest point of the body
BACK = 0.55       # the back is shallower than the front


def load_mask(path):
    """Opacity of every pixel, as a float array, plus the image itself."""
    img = bpy.data.images.load(path)
    w, h = img.size
    # Blender hands pixels back bottom row first; flip so index 0 is the top,
    # which is how the rest of this reads the image.
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1]
    return img, px[:, :, 3] > 0.45, w, h


img, mask, W, H = load_mask(ART)
print(f'source {W}x{H}, silhouette {int(mask.sum())} px')

# Chamfer distance transform: how far each pixel is from the nearest edge.
INF = 1e9
dist = np.where(mask, INF, 0.0).astype(np.float32)
for _ in range(2):
    for y in range(1, H):
        row, prev = dist[y], dist[y - 1]
        np.minimum(row[1:], prev[:-1] + 1.414, out=row[1:])
        np.minimum(row, prev + 1.0, out=row)
        np.minimum(row[:-1], prev[1:] + 1.414, out=row[:-1])
        np.minimum(row[1:], row[:-1] + 1.0, out=row[1:])
    dist = dist[::-1, ::-1].copy()          # second pass over the reversed image
peak = float(dist[mask].max())
print(f'distance to edge: peak {peak:.1f} px, mean {float(dist[mask].mean()):.1f} px')

# Thickness from that field. sqrt keeps the edge sharp and the middle full:
# zero at the silhouette so the outline stays crisp, most through the torso,
# least through the arms.
relief = np.sqrt(np.clip(dist, 0, None) / peak)

gw, gh = W // STEP, H // STEP
scale = HEIGHT / H
ox, oz = -W * scale / 2, -H * scale / 2


def sample(gx, gy):
    x = min(W - 1, gx * STEP)
    y = min(H - 1, gy * STEP)
    return mask[y, x], float(relief[y, x])


verts, faces, uvs, front_of = [], [], [], []
index = {}
for gy in range(gh + 1):
    for gx in range(gw + 1):
        px, py = min(gx * STEP, W - 1), min(gy * STEP, H - 1)
        r = float(relief[py, px])
        u, v = px / W, 1.0 - py / H
        for side in (0, 1):                 # front shell, then back shell
            index[(gx, gy, side)] = len(verts)
            depth = (DEPTH * r) if side == 0 else (-BACK * r)
            verts.append((ox + px * scale, -depth, oz + (H - py) * scale))
            uvs.append((u, v))
            front_of.append(side == 0)

for gy in range(gh):
    for gx in range(gw):
        if not all(sample(gx + dx, gy + dy)[0] for dx, dy in ((0, 0), (1, 0), (1, 1), (0, 1))):
            continue
        a = [index[(gx, gy, 0)], index[(gx + 1, gy, 0)], index[(gx + 1, gy + 1, 0)], index[(gx, gy + 1, 0)]]
        b = [index[(gx, gy, 1)], index[(gx + 1, gy, 1)], index[(gx + 1, gy + 1, 1)], index[(gx, gy + 1, 1)]]
        faces.append((a[0], a[3], a[2], a[1]))       # front, facing -Y
        faces.append((b[0], b[1], b[2], b[3]))       # back

me = bpy.data.meshes.new('ninja')
me.from_pydata(verts, [], faces)
me.update()
ob = bpy.data.objects.new('ninja', me)
bpy.context.scene.collection.objects.link(ob)

uv = me.uv_layers.new(name='UVMap')
for loop in me.loops:
    uv.data[loop.index].uv = uvs[loop.vertex_index]

# Weld the two shells along the silhouette so the model is a closed solid and
# the rim reads as an edge rather than two loose sheets.
bm = bmesh.new()
bm.from_mesh(me)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
boundary = [e for e in bm.edges if len(e.link_faces) == 1]
bmesh.ops.holes_fill(bm, edges=boundary, sides=4)
bm.to_mesh(me)
bm.free()
for p in me.polygons:
    p.use_smooth = True
sub = ob.modifiers.new('sub', 'SUBSURF')
sub.levels = sub.render_levels = 1

# The drawing is the surface. Emission, so the artist's own shading is what
# shows rather than being lit a second time.
mat = bpy.data.materials.new('art')
mat.use_nodes = True
nt = mat.node_tree
nt.nodes.clear()
tex = nt.nodes.new('ShaderNodeTexImage')
tex.image = img
tex.interpolation = 'Closest' if STEP <= 2 else 'Linear'
emit = nt.nodes.new('ShaderNodeEmission')
out = nt.nodes.new('ShaderNodeOutputMaterial')
trans = nt.nodes.new('ShaderNodeBsdfTransparent')
mix = nt.nodes.new('ShaderNodeMixShader')
nt.links.new(tex.outputs['Color'], emit.inputs['Color'])
nt.links.new(tex.outputs['Alpha'], mix.inputs['Fac'])
nt.links.new(trans.outputs['BSDF'], mix.inputs[1])
nt.links.new(emit.outputs['Emission'], mix.inputs[2])
nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])
me.materials.append(mat)

scene = bpy.context.scene
world = bpy.data.worlds.new('w')
scene.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.10, 0.105, 0.12, 1)

scene.render.engine = 'CYCLES'
scene.cycles.samples = 8
scene.cycles.use_denoising = False
scene.render.resolution_x, scene.render.resolution_y = 700, 780
scene.view_settings.view_transform = 'Standard'

import math
for name, deg in (('a00', 0), ('a20', 20), ('a40', 40), ('a90', 90)):
    cd = bpy.data.cameras.new(name)
    cd.lens = 75
    cam = bpy.data.objects.new(name, cd)
    scene.collection.objects.link(cam)
    t = math.radians(deg)
    d = 13.0
    cam.location = (math.sin(t) * d, -math.cos(t) * d, 0.2)
    cam.rotation_euler = (Vector((0, 0, 0.0)) - Vector(cam.location)).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam
    scene.render.filepath = os.path.join(OUT, f'{name}.png')
    bpy.ops.render.render(write_still=True)
    print('rendered', deg, 'deg')

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'ninja.blend'))
print('verts:', len(me.vertices), 'faces:', len(me.polygons))
