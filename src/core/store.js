/**
 * Flat, observable settings store with localStorage persistence.
 *
 * Keys are dotted paths ("head.yawGain") so the UI can bind a control to a
 * setting by name alone. Everything the user can tune lives here, which also
 * makes export/import a one-liner.
 */
const KEY = 'vtuber-model/settings/v1';

export const DEFAULTS = {
  // --- capture ---------------------------------------------------------
  'camera.deviceId': '',
  'camera.mirror': true,

  // --- smoothing -------------------------------------------------------
  'smooth.minCutoff': 1.2, // Hz — lower is steadier, laggier
  'smooth.beta': 0.06, // speed coefficient — higher is snappier
  'smooth.expression': 2.4, // separate, faster cutoff for face shapes

  // --- head ------------------------------------------------------------
  'head.yawGain': 1.15,
  'head.pitchGain': 1.15,
  'head.rollGain': 1.25,
  'head.positionGain': 1.0,
  'head.limitDeg': 42,

  // --- eyes ------------------------------------------------------------
  'eyes.blinkGain': 1.35,
  'eyes.blinkThreshold': 0.42, // below this, the eye reads as fully open
  'eyes.linkBlinks': true, // wink support off by default; most rigs look better linked
  'eyes.gazeGain': 1.0,
  'eyes.autoBlink': true, // fire natural blinks when tracking is idle/lost
  'eyes.browGain': 1.3,

  // --- mouth -----------------------------------------------------------
  'mouth.openGain': 1.5,
  'mouth.smileGain': 1.4,
  'mouth.wideGain': 1.2,
  'mouth.source': 'camera', // camera | mic | both
  'mouth.micGain': 1.8,
  'mouth.micGate': 0.012, // RMS below this counts as silence

  // --- body / idle -----------------------------------------------------
  'body.followGain': 0.55, // how much the torso trails the head
  'body.breathAmount': 1.0,
  'body.breathRate': 0.22, // Hz
  'body.swayAmount': 1.0,
  'body.hairPhysics': 1.0,

  // --- stage -----------------------------------------------------------
  'stage.avatar': 'procedural2d', // procedural2d | layered2d
  'stage.background': 'transparent', // transparent | chroma | color
  'stage.chroma': '#00b140',
  'stage.color': '#101018',
  'stage.zoom': 0.86,
  'stage.offsetX': 0,
  'stage.offsetY': 0,
  'stage.showPreview': true,

  // --- character (procedural2d) ----------------------------------------
  // A masked ninja: charcoal helmet, glowing visor eyes, long red scarf.
  // There is no mouth, so every expression is carried by the eye shapes.
  'char.suit': '#3f444d',
  'char.suitLight': '#5c636f',
  'char.visor': '#7f8ca3',
  'char.visorDark': '#2c313a',
  'char.glow': '#f2f7ff',
  'char.scarf': '#c62b2b',
  'char.scarfShade': '#8b1a1a',
  'char.accent': '#7a6a55',
  'char.lineArt': '#15161c',
  'char.hair': '#4b515b',
  'char.eyeStyle': 'slash', // slash | round | band
  'char.scarfLength': 'long', // short | medium | long
  'char.scarfFloat': 1.0, // how much the tails billow upward
  'char.accessory': 'none', // none | horns | goggles | antenna
};

const listeners = new Set();
let state = { ...DEFAULTS };

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    // Only adopt keys we still know about, so old saves cannot resurrect
    // settings that no longer exist.
    for (const k of Object.keys(DEFAULTS)) {
      if (k in saved) state[k] = saved[k];
    }
  } catch {
    /* corrupt or unavailable storage — fall back to defaults */
  }
}
load();

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* private browsing / quota — settings just will not persist */
    }
  }, 250);
}

export const get = (key) => state[key];
export const snapshot = () => ({ ...state });

export function set(key, value) {
  if (!(key in DEFAULTS)) throw new Error(`unknown setting: ${key}`);
  if (state[key] === value) return;
  state[key] = value;
  scheduleSave();
  for (const fn of listeners) fn(key, value);
}

export function patch(values) {
  for (const [k, v] of Object.entries(values)) {
    if (k in DEFAULTS) set(k, v);
  }
}

export function reset() {
  patch(DEFAULTS);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function exportJSON() {
  return JSON.stringify({ app: 'vtuber-model', version: 1, settings: state }, null, 2);
}

export function importJSON(text) {
  const parsed = JSON.parse(text);
  const values = parsed?.settings ?? parsed;
  if (!values || typeof values !== 'object') throw new Error('not a settings file');
  patch(values);
}
