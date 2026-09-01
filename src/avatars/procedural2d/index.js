/**
 * Canvas-2D backend for the built-in character. No art assets required — it
 * draws every part from code, so it works the moment the page loads and is
 * recoloured live from the character settings.
 */
import { Character } from './character.js';
import { readPalette } from './palette.js';
import * as store from '../../core/store.js';

const VIRTUAL = 1000;

export class Procedural2D {
  static id = 'procedural2d';
  static label = 'Built-in character';

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'avatar-canvas';
    this.ctx = this.canvas.getContext('2d');
    this.clock = 0;
    this.character = new Character();
    this.palette = readPalette();
    this.unsubscribe = store.subscribe((key) => {
      if (key.startsWith('char.')) this.palette = readPalette();
    });
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

  render(rig, dt) {
    const ctx = this.ctx;
    if (!ctx || !this.width) return;
    this.clock += dt;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Fit the 1000-unit character into the canvas, then apply user framing.
    const zoom = store.get('stage.zoom');
    const scale = (Math.min(this.width, this.height) / VIRTUAL) * this.dpr * zoom;
    const ox = (this.canvas.width - VIRTUAL * scale) / 2 + store.get('stage.offsetX') * this.dpr;
    const oy = (this.canvas.height - VIRTUAL * scale) / 2 + store.get('stage.offsetY') * this.dpr;

    ctx.setTransform(scale, 0, 0, scale, ox, oy);
    ctx.imageSmoothingEnabled = true;
    this.character.draw(ctx, rig, this.palette, dt, this.clock);
  }

  dispose() {
    this.unsubscribe?.();
    this.canvas.remove();
  }
}
