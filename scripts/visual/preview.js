// Dev-only: renders the built-in character at a grid of fixed poses so the
// drawing code can be eyeballed without a webcam. Not part of the app bundle.
import { Character } from '../../src/avatars/procedural2d/character.js';
import { readPalette } from '../../src/avatars/procedural2d/palette.js';
import { emptyRig } from '../../src/tracking/rig.js';
import * as store from '../../src/core/store.js';

const poses = [
  ['neutral', {}],
  ['turn left', { head: { yaw: -0.45 } }],
  ['turn right', { head: { yaw: 0.45 } }],
  ['look up', { head: { pitch: 0.35 } }],
  ['look down', { head: { pitch: -0.35 } }],
  ['tilt', { head: { roll: 0.35, yaw: 0.2 } }],
  ['blink', { eyes: { blinkL: 1, blinkR: 1 } }],
  ['talking', { mouth: { open: 0.75 }, eyes: { browL: 0.3, browR: 0.3 } }],
  ['smile', { mouth: { smile: 0.9, open: 0.3 }, expression: { blush: 0.5 } }],
  ['happy closed', { mouth: { smile: 0.9 }, eyes: { blinkL: 1, blinkR: 1 }, expression: { sparkle: 0.6 } }],
  ['angry', { expression: { anger: 1 }, mouth: { frown: 0.7 } }],
  ['shock', { expression: { shock: 1, sweat: 1 }, eyes: { wideL: 1, wideR: 1 }, mouth: { open: 0.5 } }],
  ['gaze', { eyes: { gazeX: 0.9, gazeY: 0.5 } }],
  ['three-quarter', { head: { yaw: 0.32, pitch: -0.12, roll: -0.1 }, mouth: { open: 0.4 } }],
  ['extreme turn', { head: { yaw: 0.75 } }],
  ['pucker', { mouth: { pucker: 0.9, open: 0.3 } }],
];

function merge(base, over) {
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object') merge(base[k], v);
    else base[k] = v;
  }
  return base;
}

const params = new URLSearchParams(location.search);
for (const [k, v] of params) {
  if (k.startsWith('char.')) store.set(k, v);
}

const grid = document.getElementById('grid');
const pal = readPalette();

for (const [name, over] of poses) {
  const fig = document.createElement('figure');
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 600;
  const ctx = canvas.getContext('2d');
  const rig = merge(emptyRig(), over);
  rig.body.breath = 0.5;
  ctx.setTransform(0.6, 0, 0, 0.6, 0, 0);
  // Let the scarf physics settle, then draw the final frame.
  const character = new Character();
  for (let i = 0; i < 150; i++) character.draw(ctx, rig, pal, 1 / 60, i / 60);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(0.6, 0, 0, 0.6, 0, 0);
  character.draw(ctx, rig, pal, 1 / 60, 2.5);
  const cap = document.createElement('figcaption');
  cap.textContent = name;
  fig.append(canvas, cap);
  grid.append(fig);
}
document.body.dataset.ready = '1';
