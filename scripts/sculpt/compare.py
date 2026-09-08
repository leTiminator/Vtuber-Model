"""
Compares a rendered turnaround against the drawing it was sculpted from.

    python3 scripts/sculpt/compare.py <render-dir> [overlay.png]

Two numbers, because the model has two ways to be wrong.

Silhouette agreement is whether the front view still is the drawing: the
rendered outline against the artwork's alpha, as intersection over union, each
normalised by its own bounding box so framing cannot flatter it.

Face drift is whether it survives being turned. The visor's centre is measured
against the hood's, as a percentage of figure height, at every angle. A real
head carries its face around with it and the number stays put; a picture
painted on a bulge lets the face slide across the skull, which is what the
distance-transform relief did.
"""
import os
import sys
import struct
import zlib

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ART = os.path.join(ROOT, 'public', 'art', 'views', 'pose-front-arms-out-full.png')
RENDERS = sys.argv[1]
OVERLAY = sys.argv[2] if len(sys.argv) > 2 else None


def read_png(path):
    data = open(path, 'rb').read()
    pos, idat, w, h, ctype = 8, b'', 0, 0, 6
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, _, ctype = struct.unpack('>IIBB', body[:10])
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


def write_png(path, rgb):
    h, w, _ = rgb.shape
    raw = b''.join(b'\x00' + rgb[y].tobytes() for y in range(h))
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    hdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', hdr)
                           + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))


BG = np.array([89, 91, 97])


def silhouette(img, is_render):
    if is_render:
        return np.abs(img[:, :, :3].astype(np.int32) - BG).sum(axis=2) > 18
    return img[:, :, 3] > 115


def bbox(m):
    ys, xs = np.nonzero(m)
    return xs.min(), ys.min(), xs.max(), ys.max()


def normalise(m, n=520):
    x0, y0, x1, y1 = bbox(m)
    gy = (y0 + np.round(np.linspace(0, 1, n) * (y1 - y0))).astype(int)
    gx = (x0 + np.round(np.linspace(0, 1, n) * (x1 - x0))).astype(int)
    return m[np.ix_(gy, gx)]


def landmarks(img, sil):
    """Hood and visor centroids, and the figure height, in pixels."""
    r, g, b = (img[:, :, i].astype(np.int32) for i in range(3))
    mx, mn = np.maximum(np.maximum(r, g), b), np.minimum(np.minimum(r, g), b)
    visor = sil & (b > r + 16) & (b > 95) & (b < 205)
    hood = sil & ((mx - mn) < 24) & (mx > 60) & (mx < 130)
    x0, y0, x1, y1 = bbox(sil)
    out = {'H': y1 - y0 + 1}
    for name, m in (('visor', visor), ('hood', hood)):
        ys, xs = np.nonzero(m)
        out[name] = (xs.mean(), ys.mean()) if len(xs) else None
    return out


art = read_png(ART)
art_sil = silhouette(art, False)

print('silhouette against the drawing')
front = os.path.join(RENDERS, 'a00.png')
rimg = read_png(front)
rsil = silhouette(rimg, True)
a, b = normalise(rsil), normalise(art_sil)
iou = (a & b).sum() / (a | b).sum()
print(f'  {100 * iou:.2f}% IoU   (missing {int((b & ~a).sum())} px, extra {int((a & ~b).sum())} px of {a.size})')

if OVERLAY:
    ov = np.full(a.shape + (3,), 20, dtype=np.uint8)
    ov[a & b] = (70, 70, 70)
    ov[b & ~a] = (60, 230, 90)
    ov[a & ~b] = (255, 60, 200)
    write_png(OVERLAY, ov)
    print(f'  overlay written to {OVERLAY} (grey agree, green drawing only, pink model only)')

print('face drift as the model turns — visor centre against hood centre, % of figure height')
base = None
for name in sorted(os.listdir(RENDERS)):
    if not name.startswith('a') or not name.endswith('.png'):
        continue
    img = read_png(os.path.join(RENDERS, name))
    sil = silhouette(img, True)
    lm = landmarks(img, sil)
    if not lm['visor'] or not lm['hood']:
        print(f'  {name}: no face visible')
        continue
    dx = (lm['visor'][0] - lm['hood'][0]) / lm['H'] * 100
    dy = (lm['visor'][1] - lm['hood'][1]) / lm['H'] * 100
    if base is None:
        base = (dx, dy)
    print(f'  {name}: across {dx:+.2f}%  down {dy:+.2f}%   drift from front {abs(dx - base[0]):.2f}%')
