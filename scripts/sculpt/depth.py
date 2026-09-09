"""
Gives the drawing a depth, part by part, and writes the height field build.py
extrudes.

    python3 scripts/sculpt/depth.py [out-dir]

A drawing does not contain its own depth: infinitely many solids cast the same
outline, so nothing here derives it. What it does instead is say, once per part,
what kind of thing that part is, and let the shape follow from that:

    the head    an ellipsoid, sized from the skull and turned about its own
                centre, so the face sits proud by half a head rather than by
                half the figure
    cloth       a sheet of even thickness with a rounded edge, because a scarf
                is a ribbon and a ribbon is not a tube
    limbs       the union of the largest spheres that fit, which for an arm or
                a leg is a cylinder and is the one place the shape can be read
                off the outline honestly

Those three sentences are the whole model, and each is a claim about the
character that a person can look at and disagree with. The numbers below are
where to disagree.

The outline never comes from any of this. It comes from the drawing's own alpha,
so a sliver too thin to hold a sphere is still cut to the artist's edge.
"""
import os
import sys

import numpy as np
from scipy import ndimage
from skimage.morphology import medial_axis

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from png import read_png                                    # noqa: E402
from segment import NAMES, classify, head_of                # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ART = os.path.join(ROOT, 'public', 'art', 'views', 'pose-front-arms-out-full.png')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'scripts', 'sculpt', 'out')

# How deep the skull is against its own width. A head is about as deep as it is
# wide, so this is near 1; it is the single number that decides how far the face
# swings when the model turns.
SKULL_DEPTH = 0.95
# The hair spikes and hood flare are not part of the ball. Opening the head by a
# disc this size leaves the skull and drops them.
SKULL_OPEN = 26

# Half-thickness of the flat parts, in pixels of the drawing, and how far from
# the edge they reach it.
SHEET = {'scarf': 15.0, 'hair': 18.0}
SHEET_EDGE = 22.0

# What is left is carved as tubes, scaled. A limb is a real cylinder; a torso is
# flatter than the cylinder that fits inside its outline.
TUBE = {'suit': 0.80, 'skin': 0.90, 'hood': 0.70, 'visor': 0.80}

# Guards, not tuning. No part is carved deeper than half its own smaller extent,
# and joins between parts are rounded over rather than left as cliffs.
CAP = 0.5
SMOOTH = 7.0


def sphere_union(region, scale):
    """Union of the maximal spheres inside a region, as a half-thickness."""
    height = np.zeros(region.shape, dtype=np.float32)
    if not region.any():
        return height
    skel, dist = medial_axis(region, return_distance=True)
    ys, xs = np.nonzero(skel)
    rs = dist[ys, xs]
    H, W = region.shape

    # Greedy set cover: take the sphere that covers most of what is still
    # uncovered. Subsampling by position instead leaves thin features -- fingers,
    # hair spikes, the tips of the scarf -- outside every kept sphere.
    covered = np.zeros(region.shape, dtype=bool)
    target = region.sum() * 0.999
    for i in np.argsort(-rs):
        x, y, r = int(xs[i]), int(ys[i]), float(rs[i])
        if r < 1.0:
            continue
        y0, y1 = max(0, int(y - r) - 1), min(H, int(y + r) + 2)
        x0, x1 = max(0, int(x - r) - 1), min(W, int(x + r) + 2)
        yy, xx = np.ogrid[y0:y1, x0:x1]
        d2 = (xx - x) ** 2 + (yy - y) ** 2
        inside = d2 <= r * r
        if int((inside & ~covered[y0:y1, x0:x1]).sum()) < 12:
            continue
        covered[y0:y1, x0:x1] |= inside
        h = np.zeros_like(d2, dtype=np.float32)
        h[inside] = np.sqrt(r * r - d2[inside]) * scale
        np.maximum(height[y0:y1, x0:x1], h, out=height[y0:y1, x0:x1])
        if covered.sum() >= target:
            break
    return height


def sheet(region, thickness):
    """A slab of even thickness whose edge rolls over instead of ending square."""
    d = ndimage.distance_transform_edt(region)
    return (thickness * np.sin(np.minimum(d / SHEET_EDGE, 1.0) * (np.pi / 2))).astype(np.float32)


def ellipsoid(region, depth_ratio, open_radius):
    """An ellipsoid on the region's chunky core, and a sheet over what sticks out."""
    rr = np.arange(-open_radius, open_radius + 1)
    disc = (rr[:, None] ** 2 + rr[None, :] ** 2) <= open_radius ** 2
    core = ndimage.binary_opening(region, structure=disc)
    if not core.any():
        core = region
    ys, xs = np.nonzero(core)
    cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
    a, b = (xs.max() - xs.min() + 1) / 2, (ys.max() - ys.min() + 1) / 2
    c = depth_ratio * a

    yy, xx = np.mgrid[0:region.shape[0], 0:region.shape[1]]
    t = 1.0 - ((xx - cx) / a) ** 2 - ((yy - cy) / b) ** 2
    ball = (c * np.sqrt(np.clip(t, 0.0, 1.0))).astype(np.float32)
    return np.where(region, np.maximum(ball, sheet(region, SHEET['hair'])), 0), (cx, cy, a, b, c)


def capped(height, region, name):
    """Hold a part to half its own smaller extent, so nothing is deeper than it is tall."""
    comp, n = ndimage.label(region, structure=np.ones((3, 3)))
    for i in range(1, n + 1):
        m = comp == i
        if m.sum() < 200:
            continue
        ys, xs = np.nonzero(m)
        limit = CAP * min(xs.max() - xs.min() + 1, ys.max() - ys.min() + 1)
        peak = float(height[m].max())
        if peak > limit:
            print(f'  cap: {name} component {i} held from {peak:.0f} to {limit:.0f} px')
            height[m] = np.minimum(height[m], limit)
    return height


def report(height, region, name):
    comp, n = ndimage.label(region, structure=np.ones((3, 3)))
    sizes = ndimage.sum(region, comp, range(1, n + 1))
    if not len(sizes):
        return
    m = comp == (1 + int(np.argmax(sizes)))
    ys, xs = np.nonzero(m)
    w, h = xs.max() - xs.min() + 1, ys.max() - ys.min() + 1
    peak = float(height[m].max())
    print(f'  {name:6} {int(region.sum()):7} px   biggest piece {w:4}x{h:<4}'
          f'  deepest {2 * peak:6.0f} px   depth/extent {2 * peak / min(w, h):.2f}')


def main():
    os.makedirs(OUT, exist_ok=True)
    img = read_png(ART)
    lbl, mask = classify(img)
    H, W = mask.shape
    print(f'drawing {W}x{H}, silhouette {int(mask.sum())} px')

    head = head_of(lbl)
    height = np.zeros(mask.shape, dtype=np.float32)
    head_h, (cx, cy, a, b, c) = ellipsoid(head, SKULL_DEPTH, SKULL_OPEN)
    height[head] = head_h[head]
    print(f'skull: centre ({cx:.0f},{cy:.0f}) {2 * a:.0f} wide {2 * b:.0f} tall '
          f'{2 * c:.0f} deep')

    print('parts')
    capped(height, head, 'head')
    report(height, head, 'head')
    for i, name in enumerate(NAMES, 1):
        region = (lbl == i) & ~head
        if not region.any():
            continue
        if name in SHEET:
            field = sheet(region, SHEET[name])
        else:
            field = sphere_union(region, TUBE[name])
        height[region] = field[region]
        capped(height, region, name)
        report(height, region, name)

    # Parts meet at a step -- a visor sunk into a hood, a sleeve against a
    # shoulder. Blurring the field and the mask together and dividing rounds the
    # steps over without dragging the rim toward zero; the outline is the
    # drawing's own alpha either way.
    w = mask.astype(np.float32)
    num = ndimage.gaussian_filter(height * w, SMOOTH)
    den = ndimage.gaussian_filter(w, SMOOTH)
    height = np.where(mask, num / np.maximum(den, 1e-6), 0).astype(np.float32)

    np.save(os.path.join(OUT, 'height.npy'), height)
    np.save(os.path.join(OUT, 'mask.npy'), mask)
    np.save(os.path.join(OUT, 'labels.npy'), lbl)
    face = height[head & (lbl == 1)]
    print(f'peak half-thickness {height.max():.0f} px; face sits '
          f'{face.mean():.0f} px proud, so it slides {face.mean() * np.sin(np.radians(20)):.0f} px at 20 degrees')


if __name__ == '__main__':
    main()
