/**
 * Overlay for marking up your artwork: where the head is, where it pivots at
 * the neck, and where the eyes sit. Four handles, dragged directly on the
 * picture — no coordinates to type.
 *
 * Everything is stored in UV space (0..1 across the image) so the markup
 * survives replacing the artwork with a different resolution.
 */
import { clamp } from '../../core/math.js';
import * as store from '../../core/store.js';
import { parseRect } from './index.js';

const MAX_W = 620;
const MAX_H = 620;

export class RigEditor {
  constructor() {
    this.root = null;
    this.image = null;
  }

  build() {
    if (this.root) return this.root;

    const root = document.createElement('div');
    root.id = 'rig-editor';
    root.hidden = true;
    root.innerHTML = `
      <div class="rig-editor__panel">
        <div class="rig-editor__frame">
          <img class="rig-editor__art" alt="Your artwork" />
          <div class="rig-handle rig-handle--head" data-role="head">
            <span class="rig-handle__grip" data-role="head-size"></span>
            <span class="rig-handle__tag">head</span>
          </div>
          <div class="rig-handle rig-handle--pivot" data-role="pivot">
            <span class="rig-handle__tag">neck</span>
          </div>
          <div class="rig-handle rig-handle--eye" data-role="eyeL">
            <span class="rig-handle__grip" data-role="eyeL-size"></span>
            <span class="rig-handle__tag">left eye</span>
          </div>
          <div class="rig-handle rig-handle--eye" data-role="eyeR">
            <span class="rig-handle__grip" data-role="eyeR-size"></span>
            <span class="rig-handle__tag">right eye</span>
          </div>
        </div>
        <div class="rig-editor__bar">
          <p>
            Drag <strong>head</strong> over the whole head and size it with the corner dot.
            Put <strong>neck</strong> where the head should pivot. Cover each eye with its box —
            blinking paints over that area, so include a little of the face around each eye.
          </p>
          <button class="btn btn--primary" data-role="done" type="button">Done</button>
        </div>
      </div>`;

    document.body.append(root);
    this.root = root;
    this.frame = root.querySelector('.rig-editor__frame');
    this.art = root.querySelector('.rig-editor__art');

    root.querySelector('[data-role="done"]').addEventListener('click', () => this.close());
    root.addEventListener('pointerdown', (event) => {
      if (event.target === root) this.close();
    });

    this.bindHandle('head', (uv) => {
      store.set('warp.headX', uv.x);
      store.set('warp.headY', uv.y);
    });
    this.bindHandle('head-size', (uv) => {
      const dx = (uv.x - store.get('warp.headX')) * this.aspect;
      const dy = uv.y - store.get('warp.headY');
      store.set('warp.headR', clamp(Math.hypot(dx, dy), 0.03, 0.9));
    });
    this.bindHandle('pivot', (uv) => {
      store.set('warp.pivotX', uv.x);
      store.set('warp.pivotY', uv.y);
    });
    for (const eye of ['eyeL', 'eyeR']) {
      const key = `warp.${eye}`;
      this.bindHandle(eye, (uv, start) => {
        const r = start.rect;
        const w = r[2] - r[0];
        const h = r[3] - r[1];
        const x = clamp(uv.x - w / 2, 0, 1 - w);
        const y = clamp(uv.y - h / 2, 0, 1 - h);
        store.set(key, JSON.stringify(round([x, y, x + w, y + h])));
      });
      this.bindHandle(`${eye}-size`, (uv) => {
        const r = parseRect(store.get(key));
        store.set(key, JSON.stringify(round([
          r[0], r[1],
          clamp(uv.x, r[0] + 0.01, 1),
          clamp(uv.y, r[1] + 0.01, 1),
        ])));
      });
    }

    return root;
  }

  bindHandle(role, onMove) {
    const el = this.root.querySelector(`[data-role="${role}"]`);
    el.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      el.setPointerCapture(event.pointerId);
      const start = { rect: parseRect(store.get(`warp.${role.replace('-size', '')}`)) };

      const move = (e) => {
        const box = this.frame.getBoundingClientRect();
        onMove({
          x: clamp((e.clientX - box.left) / box.width, 0, 1),
          y: clamp((e.clientY - box.top) / box.height, 0, 1),
        }, start);
        this.sync();
      };
      const up = () => {
        el.releasePointerCapture(event.pointerId);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  }

  open(image) {
    this.build();
    this.image = image;
    this.art.src = image.src;
    this.aspect = image.naturalWidth / image.naturalHeight;

    // Size the frame to the artwork exactly, so UV maps straight to the box.
    const scale = Math.min(MAX_W / image.naturalWidth, MAX_H / image.naturalHeight, 1);
    this.frame.style.width = `${image.naturalWidth * scale}px`;
    this.frame.style.height = `${image.naturalHeight * scale}px`;

    this.root.hidden = false;
    this.sync();
  }

  close() {
    if (this.root) this.root.hidden = true;
  }

  get isOpen() {
    return Boolean(this.root) && !this.root.hidden;
  }

  /** Push the stored geometry back onto the handles. */
  sync() {
    if (!this.root || !this.frame) return;
    const box = this.frame.getBoundingClientRect();
    const w = box.width || 1;
    const h = box.height || 1;

    const head = this.root.querySelector('[data-role="head"]');
    const r = store.get('warp.headR');
    // headR is measured in aspect-corrected UV, so it is a circle on screen.
    const px = r * (w / this.aspect) * this.aspect;
    head.style.width = `${px * 2}px`;
    head.style.height = `${px * 2 * (w / h) / this.aspect}px`;
    head.style.left = `${store.get('warp.headX') * w - px}px`;
    head.style.top = `${store.get('warp.headY') * h - (px * (w / h) / this.aspect)}px`;

    const pivot = this.root.querySelector('[data-role="pivot"]');
    pivot.style.left = `${store.get('warp.pivotX') * w}px`;
    pivot.style.top = `${store.get('warp.pivotY') * h}px`;

    for (const eye of ['eyeL', 'eyeR']) {
      const rect = parseRect(store.get(`warp.${eye}`));
      const el = this.root.querySelector(`[data-role="${eye}"]`);
      el.style.left = `${rect[0] * w}px`;
      el.style.top = `${rect[1] * h}px`;
      el.style.width = `${(rect[2] - rect[0]) * w}px`;
      el.style.height = `${(rect[3] - rect[1]) * h}px`;
    }
  }
}

const round = (r) => r.map((v) => Math.round(v * 1e4) / 1e4);
