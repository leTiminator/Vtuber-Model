/**
 * PNGTuber-style backend: your own artwork, cut into layers, driven by the
 * same rig as everything else.
 *
 * Drop a folder of PNGs on the stage (or pick one with the button). Layers are
 * recognised by filename, so the minimum viable model is `body.png` and
 * `head.png`. Everything else is optional and simply will not animate if it is
 * missing:
 *
 *   body.png                      torso; leans and breathes
 *   head.png                      head; turns, nods, tilts
 *   hair-back.png hair-front.png  swing behind/in front with lag
 *   eyes-open.png eyes-closed.png swapped on blink
 *   eyes-half.png                 optional mid-blink frame
 *   brows.png                     rides the brow channel
 *   mouth-rest.png                fallback mouth
 *   mouth-a.png … mouth-o.png     viseme set, picked from the rig
 *   blush.png                     fades in with the blush expression
 *
 * A `manifest.json` in the same folder can override anchors and draw order.
 */
import { clamp, lerp } from '../../core/math.js';
import * as store from '../../core/store.js';

const VIRTUAL = 1000;

/** filename stem -> role. Order here is the default draw order, back to front. */
const ROLES = [
  ['hair-back', 'hairBack'],
  ['body', 'body'],
  ['head', 'head'],
  ['brows', 'brows'],
  ['eyes-closed', 'eyesClosed'],
  ['eyes-half', 'eyesHalf'],
  ['eyes-open', 'eyesOpen'],
  ['blush', 'blush'],
  ['mouth-rest', 'mouthRest'],
  ['mouth-a', 'mouthA'],
  ['mouth-e', 'mouthE'],
  ['mouth-i', 'mouthI'],
  ['mouth-o', 'mouthO'],
  ['mouth-u', 'mouthU'],
  ['mouth-smile', 'mouthSmile'],
  ['hair-front', 'hairFront'],
];

const VISEME_ROLE = {
  A: 'mouthA', E: 'mouthE', I: 'mouthI', O: 'mouthO', U: 'mouthU',
  smile: 'mouthSmile', rest: 'mouthRest',
};

export class Layered2D {
  static id = 'layered2d';
  static label = 'Your PNG layers';

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'avatar-canvas';
    this.ctx = this.canvas.getContext('2d');
    this.layers = new Map(); // role -> { image, anchor:[x,y], offset:[x,y] }
    this.manifest = null;
    this.loaded = false;
    this.onStatus = () => {};
  }

  mount(container) {
    container.appendChild(this.canvas);
  }

  resize(width, height, dpr = window.devicePixelRatio || 1) {
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
  }

  /** @param {File[]} files PNGs (and optionally manifest.json) from a folder. */
  async loadFiles(files) {
    const images = new Map();
    let manifest = null;

    for (const file of files) {
      const name = file.name.toLowerCase();
      if (name === 'manifest.json') {
        try {
          manifest = JSON.parse(await file.text());
        } catch (err) {
          throw new Error(`manifest.json is not valid JSON: ${err.message}`);
        }
        continue;
      }
      if (!/\.(png|webp|gif|jpe?g)$/.test(name)) continue;
      const stem = name.replace(/\.[^.]+$/, '');
      images.set(stem, await loadImage(URL.createObjectURL(file)));
    }

    if (!images.size) throw new Error('No image files found in that folder.');

    this.layers.clear();
    this.manifest = manifest;

    const order = manifest?.layers?.length
      ? manifest.layers.map((l) => [l.src.replace(/\.[^.]+$/, '').toLowerCase(), l.role ?? roleFor(l.src)])
      : ROLES;

    for (const [stem, role] of order) {
      const image = images.get(stem);
      if (!image || !role) continue;
      const spec = manifest?.layers?.find((l) => l.src.replace(/\.[^.]+$/, '').toLowerCase() === stem);
      this.layers.set(role, {
        image,
        anchor: spec?.anchor ?? [image.width / 2, image.height / 2],
        offset: spec?.offset ?? [0, 0],
      });
    }

    this.size = manifest?.size ?? [
      Math.max(...[...this.layers.values()].map((l) => l.image.width)),
      Math.max(...[...this.layers.values()].map((l) => l.image.height)),
    ];
    this.loaded = this.layers.size > 0;
    this.onStatus(`Loaded ${this.layers.size} layer${this.layers.size === 1 ? '' : 's'}.`);
    return this.layers.size;
  }

  render(rig, dt) {
    const ctx = this.ctx;
    if (!ctx || !this.width) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.loaded) return;

    const [sw, sh] = this.size;
    const zoom = store.get('stage.zoom');
    const fit = Math.min(this.width / sw, this.height / sh) * this.dpr * zoom;
    const ox = (this.canvas.width - sw * fit) / 2 + store.get('stage.offsetX') * this.dpr;
    const oy = (this.canvas.height - sh * fit) / 2 + store.get('stage.offsetY') * this.dpr;
    ctx.setTransform(fit, 0, 0, fit, ox, oy);

    const head = rig.head;
    const bodyT = {
      x: head.x * (sw * 0.05) + rig.body.leanX * (sw * 0.03),
      y: -head.y * (sh * 0.04) + rig.body.bounce * (sh * 0.006),
      rot: rig.body.twist * 0.3,
      scale: 1 + rig.body.breath * 0.006,
    };
    const headT = {
      x: bodyT.x + Math.sin(head.yaw) * (sw * 0.05) + head.x * (sw * 0.02),
      y: bodyT.y - Math.sin(head.pitch) * (sh * 0.035) - head.y * (sh * 0.012),
      rot: head.roll,
      scale: 1 + head.z * 0.05,
    };
    const hairBack = { ...headT, x: headT.x - rig.body.hairX * (sw * 0.04), rot: headT.rot * 0.8 };
    const hairFront = { ...headT, x: headT.x + rig.body.hairX * (sw * 0.03) };

    const draw = (role, transform, alpha = 1) => {
      const layer = this.layers.get(role);
      if (!layer || alpha <= 0.01) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      const [ax, ay] = layer.anchor;
      ctx.translate(ax + transform.x + layer.offset[0], ay + transform.y + layer.offset[1]);
      ctx.rotate(transform.rot);
      ctx.scale(transform.scale, transform.scale);
      ctx.drawImage(layer.image, -ax, -ay);
      ctx.restore();
    };

    draw('hairBack', hairBack);
    draw('body', bodyT);
    draw('head', headT);

    const blink = Math.max(rig.eyes.blinkL, rig.eyes.blinkR);
    if (this.layers.has('eyesHalf') && blink > 0.35 && blink < 0.75) {
      draw('eyesHalf', headT);
    } else if (blink > 0.55) {
      draw('eyesClosed', headT);
    } else {
      draw('eyesOpen', headT);
    }

    draw('brows', { ...headT, y: headT.y - rig.eyes.browL * (sh * 0.012) });
    draw('blush', headT, clamp(rig.expression.blush + rig.mouth.smile * 0.3, 0, 1));

    const role = VISEME_ROLE[rig.viseme] ?? 'mouthRest';
    if (!draw(role, headT) && !this.layers.has(role)) draw('mouthRest', headT);

    draw('hairFront', hairFront);
  }

  dispose() {
    this.canvas.remove();
  }
}

function roleFor(src) {
  const stem = src.replace(/\.[^.]+$/, '').toLowerCase();
  return ROLES.find(([s]) => s === stem)?.[1] ?? null;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not decode ${url}`));
    img.src = url;
  });
}
