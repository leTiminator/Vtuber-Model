"""
Splits the drawing into the parts a modeller would carve separately.

Colour tells the parts apart: the visor is blue, the scarf red, the hood a
desaturated mid grey, the suit near-black. Every pixel ends up in exactly one
class, because a class boundary is where the depth is allowed to change and a
pixel with no class would be carved to nothing.

Two things have to be resolved before the classes tile the figure:

  The ink. Every drawn outline is near-black, so a plain darkness test puts the
  linework in the same class as the suit. Carving the outlines as their own
  region cuts a canyon along every line, and it also disconnects the hood from
  the visor, which are one head. Ink is darkness that is thin; the suit is
  darkness that is thick.

  The leftovers. Shading, anti-aliasing and the colours no rule claims come to
  a quarter of the figure once the ink joins them.

Both take the class of the nearest pixel that has one, in a single
distance-transform pass, so the classes meet edge to edge.
"""
import numpy as np
from scipy import ndimage

NAMES = ('visor', 'scarf', 'hood', 'skin', 'hair', 'suit')
INK_WIDTH = 7


def rules(img, sil=None):
    """The raw colour tests, before anything is filled in.

    These follow the paint, so they are what to measure when the question is
    where a part's colour has moved to. They leave gaps, so they are not what to
    carve from.
    """
    if sil is None:
        sil = img[:, :, 3] > 115
    r, g, b = (img[:, :, i].astype(np.int32) for i in range(3))
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    sat = mx - mn
    lum = (r * 299 + g * 587 + b * 114) // 1000

    dark = sil & (lum < 60)
    thickness = ndimage.distance_transform_edt(dark)
    ink = dark & (ndimage.grey_dilation(thickness, size=5) < INK_WIDTH)

    return {
        'visor': sil & (b > r + 16) & (b > 95) & (b < 205),
        'scarf': sil & (r > g + 40) & (r > b + 30) & (r > 70),
        'hood': sil & (sat < 24) & (mx > 60) & (mx < 130),
        'skin': sil & (r > 150) & (g > 110) & (b > 85) & (r > b + 25) & (sat > 20) & (sat < 95),
        'hair': sil & (sat < 40) & (mx >= 130),
        'suit': dark & ~ink,
    }, sil, ink


def classify(img, sil=None):
    """Return (labels, silhouette). Labels are 1..len(NAMES) inside the figure, 0 outside.

    A render has no alpha, so it passes its own silhouette in and is classified by
    the same rules as the drawing it was textured from.
    """
    raw, sil, ink = rules(img, sil)
    lbl = np.zeros(sil.shape, dtype=np.uint8)
    for i, name in enumerate(NAMES, 1):
        lbl[raw[name] & (lbl == 0)] = i
    lbl[ink] = 0

    _, (iy, ix) = ndimage.distance_transform_edt(lbl == 0, return_indices=True)
    return np.where(sil, lbl[iy, ix], 0).astype(np.uint8), sil


def head_of(lbl):
    """The head: whatever hood, hair and visor form one connected piece with the visor."""
    idx = {n: i for i, n in enumerate(NAMES, 1)}
    parts = np.isin(lbl, [idx['visor'], idx['hood'], idx['hair']])
    comp, n = ndimage.label(parts, structure=np.ones((3, 3)))
    visor = lbl == idx['visor']
    sizes = {i: int((comp == i).sum()) for i in set(comp[visor].ravel()) - {0}}
    if not sizes:
        return np.zeros(lbl.shape, dtype=bool)
    return comp == max(sizes, key=sizes.get)


def body_of(lbl, sil, head, open_radius=48):
    """The torso: the chunky piece under the head, once thin cloth is opened away.

    The chest in this drawing is the red tunic, which shares a colour class with
    the ribbons streaming off it. Thickness tells them apart -- the tunic is a
    wide mass under the chin, the ribbons are not.
    """
    hy, hx = np.nonzero(head)
    chin, cx = hy.max(), (hx.min() + hx.max()) / 2
    rr = np.arange(-open_radius, open_radius + 1)
    disc = (rr[:, None] ** 2 + rr[None, :] ** 2) <= open_radius ** 2
    core = ndimage.binary_opening(sil & ~head, structure=disc)
    comp, n = ndimage.label(core, structure=np.ones((3, 3)))
    below = np.zeros(lbl.shape, dtype=bool)
    below[chin:, int(cx) - 40:int(cx) + 40] = True
    ids = set(comp[core & below].ravel()) - {0}
    if not ids:
        return np.zeros(lbl.shape, dtype=bool)
    keep = max(ids, key=lambda i: int(((comp == i) & below).sum()))
    torso = (comp == keep).copy()
    torso[:chin, :] = False
    return torso
