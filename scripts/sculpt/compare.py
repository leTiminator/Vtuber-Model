"""
Compares a rendered turnaround against the drawing it was sculpted from.

    python3 scripts/sculpt/compare.py <render-dir> [overlay.png]

Three measurements, because a model can be wrong in three ways and the first of
them was the only one being watched.

Silhouette agreement is whether the front view still is the drawing: the
rendered outline against the artwork's alpha, as intersection over union, each
normalised by its own bounding box so framing cannot flatter it.

Interior agreement is whether it is the drawing *inside* the outline. A part
carved far too deep leaves the outline untouched and moves everything within it,
so a check that sees only the edge reports green on exactly the fault being
reported. Each part is found by colour in the render and in the drawing, and
compared on its own.

Slide is how far each part's paint travels across the figure when the model
turns, which is the fault being reported: a face on a bulge swims across the
skull instead of turning with it. The cameras are orthographic and orbit the
origin, so paint at horizontal offset x and depth y lands at x*cos(t) +
y*sin(t); comparing two views gives both the slide and the depth implied by it.

That implied depth is smaller than the height field's, and legitimately so. The
solid is symmetric about its mid-plane and both faces carry the same texture, so
near the outline a turn brings the far side's copy of a part into view moving the
other way. What this measures is the motion of the paint actually on screen,
which is what the eye is judging.
"""
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from png import read_png, write_png                         # noqa: E402
from segment import NAMES, classify, rules                  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ART = os.path.join(ROOT, 'public', 'art', 'views', 'pose-front-arms-out-full.png')
DATA = os.path.join(ROOT, 'scripts', 'sculpt', 'out')
RENDERS = sys.argv[1]
OVERLAY = sys.argv[2] if len(sys.argv) > 2 else None

BG = np.array([89, 91, 97])
ANGLES = sorted(int(m.group(1)) for m in
                (re.fullmatch(r'a(\d+)\.png', n) for n in os.listdir(RENDERS)) if m)
FRONT = f'a{min(ANGLES):03d}.png' if ANGLES else 'a000.png'
# build.py frames the figure with a 4% margin at half the drawing's resolution.
DRAWING_PX = 2.08


def silhouette(img, is_render):
    if is_render:
        return np.abs(img[:, :, :3].astype(np.int32) - BG).sum(axis=2) > 18
    return img[:, :, 3] > 115


def bbox(m):
    ys, xs = np.nonzero(m)
    return xs.min(), ys.min(), xs.max(), ys.max()


def normalise(a, box, n=520):
    """Resample onto a common grid so two images of different size compare."""
    x0, y0, x1, y1 = box
    gy = (y0 + np.round(np.linspace(0, 1, n) * (y1 - y0))).astype(int)
    gx = (x0 + np.round(np.linspace(0, 1, n) * (x1 - x0))).astype(int)
    return a[np.ix_(gy, gx)]


def centroid(m):
    ys, xs = np.nonzero(m)
    return (xs.mean(), ys.mean()) if len(xs) else None


art = read_png(ART)
art_sil = silhouette(art, False)

print('silhouette against the drawing')
rimg = read_png(os.path.join(RENDERS, FRONT))
rsil = silhouette(rimg, True)
a, b = normalise(rsil, bbox(rsil)), normalise(art_sil, bbox(art_sil))
print(f'  {100 * (a & b).sum() / (a | b).sum():.2f}% IoU   '
      f'(missing {int((b & ~a).sum())} px, extra {int((a & ~b).sum())} px of {a.size})')

if OVERLAY:
    ov = np.full(a.shape + (3,), 20, dtype=np.uint8)
    ov[a & b] = (70, 70, 70)
    ov[b & ~a] = (60, 230, 90)
    ov[a & ~b] = (255, 60, 200)
    write_png(OVERLAY, ov)
    print(f'  overlay written to {OVERLAY} (grey agree, green drawing only, pink model only)')

print('interior against the drawing, part by part')
art_lbl, _ = classify(art)
ren_lbl, _ = classify(rimg, sil=rsil)
al = normalise(art_lbl, bbox(art_sil))
rl = normalise(ren_lbl, bbox(rsil))
for i, name in enumerate(NAMES, 1):
    am, rm = al == i, rl == i
    if am.sum() < 200:
        continue
    iou = (am & rm).sum() / max((am | rm).sum(), 1)
    ca, cr = centroid(am), centroid(rm)
    off = np.hypot(cr[0] - ca[0], cr[1] - ca[1]) if ca and cr else float('nan')
    print(f'  {name:6} {100 * iou:6.2f}% IoU   centre off by {off:5.1f} px of 520')

print('how far each part slides when the model turns')


def part_centres(deg):
    """Where each part's paint is, from the raw colour tests: the fill in classify()
    follows the silhouette rather than the texture, and would hide the very motion
    this measures."""
    path = os.path.join(RENDERS, f'a{deg:03d}.png')
    if not os.path.exists(path):
        return None
    img = read_png(path)
    raw, _, _ = rules(img, sil=silhouette(img, True))
    return {i: centroid(raw[n]) for i, n in enumerate(NAMES, 1)}, img.shape[1]


# Only while the front of the figure is still facing the camera: past about 60
# degrees the paint being tracked is leaving the screen, and past 90 it is gone.
front = part_centres(min(ANGLES) if ANGLES else 0)
for deg in [d for d in ANGLES if 0 < d < 75]:
    got = part_centres(deg)
    if front is None or got is None:
        continue
    t = np.radians(deg)
    print(f'  at {deg} degrees')
    for i, name in enumerate(NAMES, 1):
        c0, ct = front[0][i], got[0][i]
        if c0 is None or ct is None:
            continue
        x = (c0[0] - front[1] / 2) * DRAWING_PX
        sx = (ct[0] - got[1] / 2) * DRAWING_PX
        y = (sx - x * np.cos(t)) / np.sin(t)
        print(f'    {name:6} slides {abs(y) * np.sin(t):5.0f} px, as paint {abs(y):5.0f} px proud would')

height_path = os.path.join(DATA, 'height.npy')
label_path = os.path.join(DATA, 'labels.npy')
if os.path.exists(height_path) and os.path.exists(label_path):
    height, labels = np.load(height_path), np.load(label_path)
    # Whatever depth.py wrote last, which is only these renders' own field when
    # nothing has been re-carved since.
    print(f'  for comparison, the height field now in {os.path.relpath(DATA, ROOT)}')
    for i, name in enumerate(NAMES, 1):
        m = labels == i
        if m.sum() < 200:
            continue
        print(f'    {name:6} {height[m].mean():5.0f} px proud on average, {height[m].max():5.0f} px at the deepest')
