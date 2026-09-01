import * as store from '../../core/store.js';

/** Mix two colours in sRGB. Good enough for shading tints. */
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

export const shade = (hex, amount) =>
  mix(hex, amount < 0 ? '#000000' : '#ffffff', Math.abs(amount));

function parseHex(hex) {
  if (typeof hex !== 'string') return [0, 0, 0];
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Snapshot every character colour, deriving the tones we shade with. */
export function readPalette() {
  const suit = store.get('char.suit');
  const scarf = store.get('char.scarf');
  const visor = store.get('char.visor');

  return {
    line: store.get('char.lineArt'),
    suit,
    suitLight: store.get('char.suitLight'),
    suitShade: mix(suit, '#000000', 0.34),
    visor,
    visorLight: mix(visor, '#ffffff', 0.3),
    visorDark: store.get('char.visorDark'),
    glow: store.get('char.glow'),
    scarf,
    scarfShade: store.get('char.scarfShade'),
    scarfLight: mix(scarf, '#ffffff', 0.24),
    accent: store.get('char.accent'),
    accentShade: mix(store.get('char.accent'), '#000000', 0.3),
    hair: store.get('char.hair'),
    hairShade: mix(store.get('char.hair'), '#000000', 0.32),
    style: {
      eye: store.get('char.eyeStyle'),
      scarfLength: store.get('char.scarfLength'),
      scarfFloat: store.get('char.scarfFloat'),
      accessory: store.get('char.accessory'),
    },
  };
}
