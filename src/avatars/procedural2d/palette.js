import * as store from '../../core/store.js';

/** Mix two hex colours in sRGB. Good enough for shading tints. */
export function mix(a, b, t) {
  const pa = parseHex(a), pb = parseHex(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

export function withAlpha(hex, alpha) {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function shade(hex, amount) {
  return mix(hex, amount < 0 ? '#000000' : '#ffffff', Math.abs(amount));
}

function parseHex(hex) {
  if (typeof hex !== 'string') return [0, 0, 0];
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Snapshot every character colour, deriving the tones we shade with. */
export function readPalette() {
  const skin = store.get('char.skin');
  const hair = store.get('char.hair');
  const outfit = store.get('char.outfit');
  const line = store.get('char.lineArt');

  return {
    line,
    skin,
    skinShade: mix(skin, '#c98b7a', 0.34),
    skinDeep: mix(skin, '#a86a63', 0.5),
    blush: store.get('char.blush'),
    hair,
    hairShade: mix(hair, '#000000', 0.3),
    hairLight: store.get('char.hairLight'),
    hairLine: mix(hair, line, 0.55),
    eye: store.get('char.eye'),
    eyeDeep: mix(store.get('char.eye'), '#000018', 0.55),
    eyeBright: mix(store.get('char.eye'), '#ffffff', 0.45),
    outfit,
    outfitShade: mix(outfit, '#000000', 0.28),
    outfitAccent: store.get('char.outfitAccent'),
    style: {
      hair: store.get('char.hairStyle'),
      eye: store.get('char.eyeStyle'),
      accessory: store.get('char.accessory'),
    },
  };
}
