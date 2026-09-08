"""
Turns the drawing into a solid by medial-axis sphere packing.

The medial axis of a shape, with the distance transform as a radius at every
skeleton point, is a set of circles whose union is exactly the shape. Promote
each circle to a sphere and the union is a 3D solid whose orthographic front
silhouette is exactly the drawing again — not approximately, by construction.

That also fixes what was wrong with inflating by sqrt(distance): a round region
becomes a real sphere, because a sphere of radius r contributes a half-thickness
of sqrt(r^2 - d^2) at distance d from its centre, which is a hemisphere rather
than an arbitrary bulge.

    python3 scripts/sculpt/medial.py            # writes the height field + report
"""
import os
import sys

import numpy as np
from skimage.morphology import medial_axis

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ART = os.path.join(ROOT, 'public', 'art', 'views', 'pose-front-arms-out-full.png')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'scripts', 'sculpt', 'out')
os.makedirs(OUT, exist_ok=True)


def read_png(path):
    """Minimal PNG reader: zlib inflate plus the five filter types."""
    import struct
    import zlib
    data = open(path, 'rb').read()
    pos, idat, w, h, depth, ctype = 8, b'', 0, 0, 8, 6
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, depth, ctype = struct.unpack('>IIBB', body[:10])
        elif typ == b'IDAT':
            idat += body
        pos += 12 + ln
    chan = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    raw = zlib.decompress(idat)
    stride = w * chan
    out = np.zeros((h, stride), dtype=np.uint8)
    prev = np.zeros(stride, dtype=np.int32)
    p = 0
    for y in range(h):
        ft = raw[p]; p += 1
        line = np.frombuffer(raw[p:p + stride], dtype=np.uint8).astype(np.int32); p += stride
        if ft == 1:
            for i in range(chan, stride):
                line[i] = (line[i] + line[i - chan]) & 255
        elif ft == 2:
            line = (line + prev) & 255
        elif ft == 3:
            for i in range(stride):
                a = line[i - chan] if i >= chan else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif ft == 4:
            for i in range(stride):
                a = line[i - chan] if i >= chan else 0
                c = prev[i - chan] if i >= chan else 0
                b = prev[i]
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[y] = line.astype(np.uint8)
        prev = line
    return out.reshape(h, w, chan)


img = read_png(ART)
H, W = img.shape[:2]
mask = img[:, :, 3] > 115
print(f'drawing {W}x{H}, silhouette {int(mask.sum())} px')

# The medial axis, with the distance transform on it: every skeleton pixel is
# the centre of a maximal circle that fits inside the shape.
skel, dist = medial_axis(mask, return_distance=True)
ys, xs = np.nonzero(skel)
rs = dist[ys, xs]
print(f'medial axis: {len(xs)} points, radius max {rs.max():.1f} px, mean {rs.mean():.1f}')

# Keep the spheres that matter, by greedy set cover: repeatedly take the
# candidate that covers the most of the silhouette still uncovered. Subsampling
# by position instead leaves thin features — fingers, hair spikes, the tips of
# the scarf — outside every kept circle, and those are exactly the details that
# make the outline the artist's.
order = np.argsort(-rs)
covered = np.zeros(mask.shape, dtype=bool)
kept = []
target = mask.sum() * 0.999
for i in order:
    x, y, r = int(xs[i]), int(ys[i]), float(rs[i])
    if r < 1.0:
        continue
    y0, y1 = max(0, int(y - r) - 1), min(H, int(y + r) + 2)
    x0, x1 = max(0, int(x - r) - 1), min(W, int(x + r) + 2)
    yy, xx = np.ogrid[y0:y1, x0:x1]
    disc = (xx - x) ** 2 + (yy - y) ** 2 <= r * r
    gain = int((disc & ~covered[y0:y1, x0:x1]).sum())
    if gain < 12:                       # nothing new worth a sphere
        continue
    covered[y0:y1, x0:x1] |= disc
    kept.append((x, y, r))
    if covered.sum() >= target:
        break
kept = np.array(kept, dtype=np.float32)
print(f'kept {len(kept)} spheres, covering {100 * covered.sum() / mask.sum():.2f}% of the silhouette')

# Half-thickness of the union of those spheres, at every pixel. A sphere of
# radius r reaches sqrt(r^2 - d^2) above the mid-plane at distance d.
height = np.zeros(mask.shape, dtype=np.float32)
cover = np.zeros(mask.shape, dtype=bool)
for x, y, r in kept:
    r = float(r)
    y0, y1 = max(0, int(y - r) - 1), min(H, int(y + r) + 2)
    x0, x1 = max(0, int(x - r) - 1), min(W, int(x + r) + 2)
    yy, xx = np.ogrid[y0:y1, x0:x1]
    d2 = (xx - x) ** 2 + (yy - y) ** 2
    inside = d2 <= r * r
    h = np.zeros_like(d2, dtype=np.float32)
    h[inside] = np.sqrt(r * r - d2[inside])
    np.maximum(height[y0:y1, x0:x1], h, out=height[y0:y1, x0:x1])
    cover[y0:y1, x0:x1] |= inside

# The claim of the method, checked rather than asserted: the union of the
# spheres is the drawing.
inter = int((cover & mask).sum())
union = int((cover | mask).sum())
print(f'sphere union vs drawing silhouette: {100 * inter / union:.2f}% IoU'
      f'  (missed {int((mask & ~cover).sum())} px, spilled {int((cover & ~mask).sum())} px)')

np.save(os.path.join(OUT, 'height.npy'), height)
# The outline comes from the drawing, never from the sphere union. The spheres
# decide how thick the model is; they do not get a vote on its silhouette, so a
# sliver too thin to hold a sphere is still cut to the artist's edge.
np.save(os.path.join(OUT, 'mask.npy'), mask)
print('peak half-thickness', float(height.max()), 'px')
