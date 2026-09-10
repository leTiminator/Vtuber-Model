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
    the torso   an ellipsoid too, because the chest under the tunic is a body
                and not the cloth covering it
    cloth       a sheet of even thickness with a rounded edge, because a scarf
                is a ribbon and a ribbon is not a tube
    limbs       the union of the largest spheres that fit, which for an arm or
                a leg is a cylinder and is the one place the shape can be read
                off the outline honestly

The back is not the front. Both halves of the solid carry the same paint unless
something says otherwise, which puts the face on the back of the head; so the
back samples a flat colour per part instead, written out beside the height.

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
from png import read_png, write_png                         # noqa: E402
from segment import NAMES, body_of, classify, head_of       # noqa: E402

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

# How deep the chest is against its own width. A torso is much flatter than it is
# wide, front to back.
TORSO_DEPTH = 0.55
TORSO_OPEN = 48

# Half-thickness of the flat parts, in pixels of the drawing, and how far from
# the edge they reach it.
SHEET = {'scarf': 15.0, 'hair': 18.0}
SHEET_EDGE = 22.0

# What is left is carved as tubes, scaled. A limb is a real cylinder; a torso is
# flatter than the cylinder that fits inside its outline.
TUBE = {'suit': 0.80, 'skin': 0.90, 'hood': 0.70, 'visor': 0.80}

# The scarf trails. A ribbon streaming off a figure flying forward is behind it,
# not in its plane, and a drawing has to put it in the plane. This is how far back
# the furthest ribbon goes, and it is the one number here that is pure invention.
TRAIL = 300.0

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


def ball(shape, cx, cy, a, b, c):
    """Half-thickness of an ellipsoid, zero outside it."""
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
    t = 1.0 - ((xx - cx) / a) ** 2 - ((yy - cy) / b) ** 2
    return (c * np.sqrt(np.clip(t, 0.0, 1.0))).astype(np.float32)


def fit(region, open_radius, wide=False):
    """Centre and half-extents of a region's chunky core.

    The width comes from the median row unless asked for the full span, because a
    torso's bounding box is as wide as the arms reaching out of it.
    """
    rr = np.arange(-open_radius, open_radius + 1)
    disc = (rr[:, None] ** 2 + rr[None, :] ** 2) <= open_radius ** 2
    core = ndimage.binary_opening(region, structure=disc)
    if not core.any():
        core = region
    ys, xs = np.nonzero(core)
    cy, b = (ys.min() + ys.max()) / 2, (ys.max() - ys.min() + 1) / 2
    if wide:
        return (xs.min() + xs.max()) / 2, cy, (xs.max() - xs.min() + 1) / 2, b
    runs = [np.nonzero(core[y])[0] for y in range(ys.min(), ys.max() + 1)]
    widths = [r.max() - r.min() + 1 for r in runs if len(r)]
    mids = [(r.max() + r.min()) / 2 for r in runs if len(r)]
    return float(np.median(mids)), cy, float(np.median(widths)) / 2, b


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


def trail(lbl, mask, head, torso):
    """How far behind the body plane each pixel sits.

    Everything on the figure itself stays on the plane. The scarf leaves it, by
    how far its own pixels are from the body, so the ribbons sweep back instead of
    lying flat in the picture and vanishing edge-on.
    """
    centre = np.zeros(lbl.shape, dtype=np.float32)
    body = head | torso
    if not body.any():
        return centre
    ribbon = (lbl == 1 + NAMES.index('scarf')) & ~body
    if not ribbon.any():
        return centre
    away = ndimage.distance_transform_edt(~body)
    reach = np.percentile(away[ribbon], 98)
    centre[ribbon] = TRAIL * np.clip(away[ribbon] / max(reach, 1.0), 0, 1) ** 1.3
    w = mask.astype(np.float32)
    num = ndimage.gaussian_filter(centre * w, SMOOTH * 2)
    den = ndimage.gaussian_filter(w, SMOOTH * 2)
    return np.where(mask, num / np.maximum(den, 1e-6), 0).astype(np.float32)


def backing(img, lbl, head, torso):
    """A flat colour per piece, for the side of the solid that faces away.

    The head and the chest are painted as single masses, not per colour class:
    class by class, the visor keeps its own grey-blue and the eye shards keep
    their white, and the far side of the head comes out a face again. The back of
    a head is a hood.
    """
    out = np.zeros(lbl.shape + (3,), dtype=np.uint8)
    for i in range(1, len(NAMES) + 1):
        comp, n = ndimage.label((lbl == i) & ~head & ~torso, structure=np.ones((3, 3)))
        for k in range(1, n + 1):
            m = comp == k
            if m.sum() >= 40:
                out[m] = np.median(img[m][:, :3], axis=0).astype(np.uint8)
    idx = {n: i for i, n in enumerate(NAMES, 1)}
    for mass, source in ((head, idx['hood']), (torso, idx['scarf'])):
        if not mass.any():
            continue
        skin = mass & (lbl == source)
        out[mass] = np.median(img[skin if skin.sum() > 200 else mass][:, :3], axis=0).astype(np.uint8)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    img = read_png(ART)
    lbl, mask = classify(img)
    H, W = mask.shape
    print(f'drawing {W}x{H}, silhouette {int(mask.sum())} px')

    head = head_of(lbl)
    torso = body_of(lbl, mask, head, TORSO_OPEN)
    height = np.zeros(mask.shape, dtype=np.float32)

    cx, cy, a, b = fit(head, SKULL_OPEN, wide=True)
    c = SKULL_DEPTH * a
    height[head] = np.maximum(ball(mask.shape, cx, cy, a, b, c),
                              sheet(head, SHEET['hair']))[head]
    print(f'skull: centre ({cx:.0f},{cy:.0f}) {2 * a:.0f} wide {2 * b:.0f} tall {2 * c:.0f} deep')

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

    # The torso goes in last and only ever adds: the tunic over the chest gets a
    # body under it, while the ribbons streaming off it stay the sheets they are.
    if torso.any():
        tx, ty, ta, tb = fit(torso, TORSO_OPEN)
        tc = TORSO_DEPTH * ta
        print(f'torso: centre ({tx:.0f},{ty:.0f}) {2 * ta:.0f} wide {2 * tb:.0f} tall '
              f'{2 * tc:.0f} deep')
        np.maximum(height, np.where(mask, ball(mask.shape, tx, ty, ta, tb, tc), 0), out=height)
        report(height, torso, 'torso')

    # Parts meet at a step -- a visor sunk into a hood, a sleeve against a
    # shoulder. Blurring the field and the mask together and dividing rounds the
    # steps over without dragging the rim toward zero; the outline is the
    # drawing's own alpha either way.
    w = mask.astype(np.float32)
    num = ndimage.gaussian_filter(height * w, SMOOTH)
    den = ndimage.gaussian_filter(w, SMOOTH)
    height = np.where(mask, num / np.maximum(den, 1e-6), 0).astype(np.float32)

    centre = trail(lbl, mask, head, torso)
    np.save(os.path.join(OUT, 'height.npy'), height)
    np.save(os.path.join(OUT, 'centre.npy'), centre)
    np.save(os.path.join(OUT, 'mask.npy'), mask)
    np.save(os.path.join(OUT, 'labels.npy'), lbl)
    write_png(os.path.join(OUT, 'backing.png'), backing(img, lbl, head, torso))
    print(f'scarf trails up to {centre.max():.0f} px behind the body')
    face = height[head & (lbl == 1)]
    print(f'peak half-thickness {height.max():.0f} px; face sits '
          f'{face.mean():.0f} px proud, so it slides {face.mean() * np.sin(np.radians(20)):.0f} px at 20 degrees')


if __name__ == '__main__':
    main()
