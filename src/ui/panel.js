/**
 * Control panel. Every control binds to a key in the settings store by name,
 * so adding a knob means adding one line to the schema below — the store
 * handles persistence, and the rig and avatars pick changes up on the next
 * frame with no extra wiring.
 */
import * as store from '../core/store.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const pct = (v) => `${Math.round(v * 100)}%`;
const x = (v) => `${v.toFixed(2)}×`;
const hz = (v) => `${v.toFixed(2)} Hz`;
const deg = (v) => `${Math.round(v)}°`;

/** @param {object} ctx callbacks into the running app */
export function buildPanel(root, ctx) {
  const schema = [
    {
      title: 'Camera & tracking',
      open: true,
      controls: [
        { type: 'cameras' },
        { type: 'toggle', key: 'camera.mirror', label: 'Mirror me', hint: 'The model acts like your reflection. Leave on unless it feels backwards.' },
        { type: 'toggle', key: 'stage.showPreview', label: 'Show camera preview' },
        { type: 'slider', key: 'smooth.minCutoff', label: 'Steadiness', min: 0.3, max: 4, step: 0.05, format: hz,
          hint: 'Lower is calmer when you hold still, but adds a little lag.' },
        { type: 'slider', key: 'smooth.beta', label: 'Snappiness', min: 0, max: 0.3, step: 0.005, format: (v) => v.toFixed(3),
          hint: 'Higher keeps fast movement lag-free.' },
        { type: 'slider', key: 'smooth.expression', label: 'Face response', min: 0.5, max: 6, step: 0.1, format: hz },
      ],
    },
    {
      title: 'Head',
      controls: [
        { type: 'slider', key: 'head.yawGain', label: 'Turn', min: 0, max: 3, step: 0.05, format: x },
        { type: 'slider', key: 'head.pitchGain', label: 'Nod', min: 0, max: 3, step: 0.05, format: x },
        { type: 'slider', key: 'head.rollGain', label: 'Tilt', min: 0, max: 3, step: 0.05, format: x },
        { type: 'slider', key: 'head.positionGain', label: 'Lean / move', min: 0, max: 3, step: 0.05, format: x },
        { type: 'slider', key: 'head.limitDeg', label: 'Range limit', min: 10, max: 80, step: 1, format: deg },
      ],
    },
    {
      title: 'Eyes',
      controls: [
        { type: 'slider', key: 'eyes.blinkGain', label: 'Blink strength', min: 0.4, max: 3, step: 0.05, format: x },
        { type: 'slider', key: 'eyes.blinkThreshold', label: 'Blink threshold', min: 0.05, max: 0.85, step: 0.01, format: pct,
          hint: 'Raise it if the model looks sleepy; lower it if blinks get missed.' },
        { type: 'toggle', key: 'eyes.linkBlinks', label: 'Blink both eyes together', hint: 'Turn off to allow winks — needs good lighting.' },
        { type: 'toggle', key: 'eyes.autoBlink', label: 'Blink on its own when idle' },
        { type: 'slider', key: 'eyes.gazeGain', label: 'Eye darting', min: 0, max: 3, step: 0.05, format: x },
        { type: 'slider', key: 'eyes.browGain', label: 'Brow / eye slant', min: 0, max: 3, step: 0.05, format: x },
      ],
    },
    {
      title: 'Speech',
      controls: [
        { type: 'note', text: 'This design is masked, so speech drives the glowing vent under the visor rather than a mouth.' },
        { type: 'select', key: 'mouth.source', label: 'Driven by', options: [
          ['camera', 'Camera (your jaw)'],
          ['mic', 'Microphone (loudness)'],
          ['both', 'Whichever is stronger'],
        ] },
        { type: 'slider', key: 'mouth.openGain', label: 'Jaw sensitivity', min: 0.2, max: 4, step: 0.05, format: x },
        { type: 'slider', key: 'mouth.micGain', label: 'Mic sensitivity', min: 0.2, max: 5, step: 0.05, format: x },
        { type: 'slider', key: 'mouth.micGate', label: 'Mic noise gate', min: 0, max: 0.08, step: 0.001, format: (v) => v.toFixed(3),
          hint: 'Raise until background noise stops triggering it.' },
        { type: 'slider', key: 'mouth.smileGain', label: 'Smile pickup', min: 0, max: 3, step: 0.05, format: x },
      ],
    },
    {
      title: 'Body & scarf',
      controls: [
        { type: 'slider', key: 'body.followGain', label: 'Body follows head', min: 0, max: 2, step: 0.05, format: x },
        { type: 'slider', key: 'body.breathAmount', label: 'Breathing', min: 0, max: 2.5, step: 0.05, format: x },
        { type: 'slider', key: 'body.breathRate', label: 'Breath rate', min: 0.05, max: 0.8, step: 0.01, format: hz },
        { type: 'slider', key: 'body.swayAmount', label: 'Idle sway', min: 0, max: 2.5, step: 0.05, format: x },
        { type: 'slider', key: 'body.hairPhysics', label: 'Tuft lag', min: 0, max: 2.5, step: 0.05, format: x },
        { type: 'select', key: 'char.scarfLength', label: 'Scarf length', options: [
          ['short', 'Short'], ['medium', 'Medium'], ['long', 'Long'],
        ] },
        { type: 'slider', key: 'char.scarfFloat', label: 'Scarf lift', min: 0, max: 2.5, step: 0.05, format: x,
          hint: 'How hard the tails billow upward. Drop to 0 to let them hang.' },
      ],
    },
    {
      title: 'Look',
      controls: [
        { type: 'select', key: 'char.eyeStyle', label: 'Visor eyes', options: [
          ['slash', 'Angular slash'], ['round', 'Round'], ['band', 'Wide band'],
        ] },
        { type: 'select', key: 'char.accessory', label: 'Accessory', options: [
          ['none', 'None'], ['horns', 'Horns'], ['goggles', 'Goggles'], ['antenna', 'Antenna'],
        ] },
        { type: 'colors', label: 'Colours', keys: [
          ['char.suit', 'Helmet'],
          ['char.suitLight', 'Helmet light'],
          ['char.visor', 'Visor'],
          ['char.visorDark', 'Visor rim'],
          ['char.glow', 'Eye glow'],
          ['char.scarf', 'Scarf'],
          ['char.scarfShade', 'Scarf shade'],
          ['char.hair', 'Tufts'],
          ['char.accent', 'Straps'],
          ['char.lineArt', 'Outlines'],
        ] },
        { type: 'presets' },
      ],
    },
    {
      title: 'Output & OBS',
      controls: [
        { type: 'select', key: 'stage.background', label: 'Background', options: [
          ['transparent', 'Transparent (OBS browser source)'],
          ['chroma', 'Chroma key colour'],
          ['color', 'Solid colour'],
        ] },
        { type: 'color', key: 'stage.chroma', label: 'Chroma colour' },
        { type: 'color', key: 'stage.color', label: 'Solid colour' },
        { type: 'slider', key: 'stage.zoom', label: 'Zoom', min: 0.4, max: 2.5, step: 0.01, format: x },
        { type: 'slider', key: 'stage.offsetX', label: 'Nudge across', min: -400, max: 400, step: 1, format: (v) => `${v | 0} px` },
        { type: 'slider', key: 'stage.offsetY', label: 'Nudge up/down', min: -400, max: 400, step: 1, format: (v) => `${v | 0} px` },
        { type: 'obsHelp' },
      ],
    },
    {
      title: 'Your own artwork',
      controls: [
        { type: 'select', key: 'stage.avatar', label: 'Model', options: [
          ['procedural2d', 'Built-in ninja'],
          ['warp2d', 'My artwork (rigged)'],
          ['layered2d', 'My PNG layers'],
        ] },
        { type: 'artwork' },
        { type: 'slider', key: 'warp.turn', label: 'Head turn', min: 0, max: 2.5, step: 0.01, format: x },
        { type: 'slider', key: 'warp.nod', label: 'Head nod', min: 0, max: 2.5, step: 0.01, format: x },
        { type: 'slider', key: 'warp.wave', label: 'Cloth ripple', min: 0, max: 3, step: 0.01, format: x },
        { type: 'slider', key: 'warp.mesh', label: 'Mesh detail', min: 8, max: 56, step: 1, format: (v) => `${v | 0}` },
        { type: 'toggle', key: 'warp.eyesEnabled', label: 'Blink the marked eyes' },
        { type: 'slider', key: 'warp.keyWhite', label: 'Cut white background', min: 0, max: 1, step: 0.01, format: (v) => (v > 0 ? v.toFixed(2) : 'off') },
        { type: 'layersHeading' },
        { type: 'layers' },
      ],
    },
    {
      title: 'Hotkeys',
      controls: [{ type: 'hotkeys' }],
    },
  ];

  root.replaceChildren(...schema.map((group) => buildGroup(group, ctx)));
}

function buildGroup(group, ctx) {
  const details = el('details', 'group');
  details.open = Boolean(group.open);
  details.append(el('summary', null, group.title));
  const body = el('div', 'group__body');
  for (const control of group.controls) {
    const node = BUILDERS[control.type]?.(control, ctx);
    if (node) body.append(node);
  }
  details.append(body);
  return details;
}

function labelledRow(label, valueNode) {
  const row = el('div', 'field__row');
  row.append(el('span', 'field__label', label));
  if (valueNode) row.append(valueNode);
  return row;
}

const BUILDERS = {
  slider(spec) {
    const field = el('div', 'field');
    const value = el('span', 'field__value');
    const input = el('input');
    input.type = 'range';
    input.min = spec.min;
    input.max = spec.max;
    input.step = spec.step;

    const format = spec.format ?? ((v) => String(v));
    const sync = () => {
      const v = store.get(spec.key);
      input.value = v;
      value.textContent = format(v);
    };
    input.addEventListener('input', () => store.set(spec.key, Number(input.value)));
    store.subscribe((key) => key === spec.key && sync());
    sync();

    field.append(labelledRow(spec.label, value), input);
    if (spec.hint) field.append(el('div', 'field__hint', spec.hint));
    return field;
  },

  toggle(spec) {
    const field = el('div', 'field');
    const label = el('label', 'check');
    const input = el('input');
    input.type = 'checkbox';
    const sync = () => { input.checked = Boolean(store.get(spec.key)); };
    input.addEventListener('change', () => store.set(spec.key, input.checked));
    store.subscribe((key) => key === spec.key && sync());
    sync();
    label.append(input, el('span', null, spec.label));
    field.append(label);
    if (spec.hint) field.append(el('div', 'field__hint', spec.hint));
    return field;
  },

  select(spec) {
    const field = el('div', 'field');
    const select = el('select');
    for (const [value, text] of spec.options) {
      const option = el('option', null, text);
      option.value = value;
      select.append(option);
    }
    const sync = () => { select.value = store.get(spec.key); };
    select.addEventListener('change', () => store.set(spec.key, select.value));
    store.subscribe((key) => key === spec.key && sync());
    sync();
    field.append(labelledRow(spec.label), select);
    if (spec.hint) field.append(el('div', 'field__hint', spec.hint));
    return field;
  },

  color(spec) {
    const field = el('div', 'field');
    const input = el('input');
    input.type = 'color';
    const sync = () => { input.value = store.get(spec.key); };
    input.addEventListener('input', () => store.set(spec.key, input.value));
    store.subscribe((key) => key === spec.key && sync());
    sync();
    field.append(labelledRow(spec.label), input);
    return field;
  },

  colors(spec) {
    const field = el('div', 'field');
    field.append(labelledRow(spec.label));
    const grid = el('div', 'swatches');
    for (const [key, label] of spec.keys) {
      grid.append(BUILDERS.color({ key, label }));
    }
    field.append(grid);
    return field;
  },

  note(spec) {
    return el('p', 'note', spec.text);
  },

  presets(_spec, ctx) {
    const field = el('div', 'field');
    field.append(labelledRow('Colour presets'));
    const row = el('div', 'panel__actions');
    row.style.padding = '0';
    row.style.borderBottom = 'none';
    for (const [name, values] of Object.entries(PRESETS)) {
      const button = el('button', 'btn', name);
      button.type = 'button';
      button.addEventListener('click', () => store.patch(values));
      row.append(button);
    }
    field.append(row);
    return field;
  },

  cameras(_spec, ctx) {
    const field = el('div', 'field');
    const select = el('select');
    const refresh = async () => {
      const cameras = await ctx.listCameras();
      select.replaceChildren();
      const auto = el('option', null, 'Default camera');
      auto.value = '';
      select.append(auto);
      cameras.forEach((cam, i) => {
        const option = el('option', null, cam.label || `Camera ${i + 1}`);
        option.value = cam.deviceId;
        select.append(option);
      });
      select.value = store.get('camera.deviceId');
    };
    select.addEventListener('change', () => ctx.selectCamera(select.value));
    ctx.onCamerasChanged(refresh);
    refresh();
    field.append(labelledRow('Camera'), select);
    return field;
  },

  layers(_spec, ctx) {
    const field = el('div', 'field');
    const input = el('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,application/json';
    input.webkitdirectory = true;
    input.style.display = 'none';

    const button = el('button', 'btn', 'Choose a folder of PNGs…');
    button.type = 'button';
    button.addEventListener('click', () => input.click());

    const status = el('p', 'note', 'Name your files body.png, head.png, eyes-open.png, eyes-closed.png, mouth-a.png … and pick the folder.');
    input.addEventListener('change', async () => {
      try {
        const count = await ctx.loadLayers([...input.files]);
        status.className = 'note';
        status.textContent = `Loaded ${count} layer${count === 1 ? '' : 's'}.`;
        store.set('stage.avatar', 'layered2d');
      } catch (err) {
        status.className = 'note note--error';
        status.textContent = err.message;
      }
    });

    field.append(button, input, status);
    return field;
  },

  artwork(_spec, ctx) {
    const field = el('div', 'field');

    const input = el('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.style.display = 'none';

    const load = el('button', 'btn btn--primary', 'Load my artwork…');
    load.type = 'button';
    load.addEventListener('click', () => input.click());

    const markup = el('button', 'btn', 'Mark up the rig');
    markup.type = 'button';
    markup.addEventListener('click', () => {
      if (!ctx.openRigEditor()) {
        status.className = 'note note--error';
        status.textContent = 'Load an image first.';
      }
    });

    const status = el('p', 'note',
      'One flat PNG is enough — no layers needed. Load it, then drag the head, ' +
      'neck and eye markers onto your art. It turns, nods, tilts, breathes and blinks from there.');

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const { saved, found } = await ctx.loadArtwork(file);
        status.className = 'note';
        const placed = !found.head
          ? 'Drag the head, neck and eye markers onto your art.'
          : found.eyes
            ? 'Found the head and both eyes — check the markers and adjust anything that looks off.'
            : 'Found the head; the eye boxes are a guess, so drag them over the real eyes.';
        status.textContent = saved
          ? placed
          : `${placed} (Too large to remember, so you will need to re-pick it next time.)`;
      } catch (err) {
        status.className = 'note note--error';
        status.textContent = err.message;
      }
      input.value = '';
    });

    field.append(load, markup, input, status);
    return field;
  },

  layersHeading() {
    const note = el('p', 'note note--divider');
    note.textContent = 'Already have your art cut into separate layers? Load them instead:';
    return note;
  },

  obsHelp() {
    const note = el('p', 'note');
    note.innerHTML =
      'In OBS add a <strong>Browser</strong> source pointing at this page\'s address, ' +
      'size it 1920×1080, and tick <strong>Shutdown source when not visible</strong> off. ' +
      'With the background set to Transparent it composites straight over your scene.';
    return note;
  },

  hotkeys() {
    const wrap = el('div', 'keycaps');
    const rows = [
      ['1', 'Blush'],
      ['2', 'Angry'],
      ['3', 'Sparkle'],
      ['4', 'Nervous'],
      ['5', 'Shocked'],
      ['C', 'Set neutral pose'],
      ['H', 'Hide the interface'],
      ['M', 'Flip mirroring'],
    ];
    for (const [key, label] of rows) {
      const row = el('div', 'keycap');
      row.append(el('kbd', null, key), el('span', null, label));
      wrap.append(row);
    }
    const note = el('p', 'note', 'Hold 1–5 while streaming to trigger a reaction.');
    const box = el('div', 'field');
    box.append(wrap, note);
    return box;
  },
};

const PRESETS = {
  Crimson: {
    'char.suit': '#3f444d', 'char.suitLight': '#5c636f', 'char.visor': '#7f8ca3',
    'char.visorDark': '#2c313a', 'char.glow': '#f2f7ff', 'char.scarf': '#c62b2b',
    'char.scarfShade': '#8b1a1a', 'char.hair': '#4b515b', 'char.accent': '#7a6a55',
  },
  Toxic: {
    'char.suit': '#2f3630', 'char.suitLight': '#4a5548', 'char.visor': '#6f8a72',
    'char.visorDark': '#232a24', 'char.glow': '#ccff8f', 'char.scarf': '#7bc043',
    'char.scarfShade': '#3f7024', 'char.hair': '#3c463c', 'char.accent': '#5f6b4a',
  },
  Cobalt: {
    'char.suit': '#2d3442', 'char.suitLight': '#495571', 'char.visor': '#6f86ad',
    'char.visorDark': '#222836', 'char.glow': '#9fe8ff', 'char.scarf': '#2f6fd0',
    'char.scarfShade': '#1c4382', 'char.hair': '#394152', 'char.accent': '#4e5b73',
  },
  Bone: {
    'char.suit': '#d9d3c6', 'char.suitLight': '#f2efe6', 'char.visor': '#9a9488',
    'char.visorDark': '#3a382f', 'char.glow': '#ff8a5c', 'char.scarf': '#2c2c2c',
    'char.scarfShade': '#141414', 'char.hair': '#8d8474', 'char.accent': '#a5947a',
  },
};
