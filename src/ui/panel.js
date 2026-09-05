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
        { type: 'toggle', key: 'stage.faceFlip', label: 'Face the other way',
          hint: 'Turns the whole character round, so its resting pose looks the other way. '
            + 'The tracking turns with it, so this changes which way it faces and nothing '
            + 'about how it follows you.' },
        { type: 'select', key: 'camera.faceZoom', label: 'Face zoom', options: [
          ['auto', 'Follow my face (better tracking)'],
          ['off', 'Off — use the whole frame'],
        ], hint: 'Crops the camera to your face before the tracker sees it. '
          + 'Sitting back from the camera, this is the single biggest thing '
          + 'you can do for tracking quality.' },
        { type: 'toggle', key: 'stage.showPreview', label: 'Show camera preview' },
        { type: 'slider', key: 'smooth.minCutoff', label: 'Steadiness', min: 0.3, max: 4, step: 0.05, format: hz,
          hint: 'Lower is calmer when you hold still, but adds a little lag.' },
        { type: 'slider', key: 'smooth.beta', label: 'Snappiness', min: 0, max: 0.3, step: 0.005, format: (v) => v.toFixed(3),
          hint: 'Higher keeps fast movement lag-free.' },
        { type: 'slider', key: 'smooth.expression', label: 'Face response', min: 0.5, max: 6, step: 0.1, format: hz },
        { type: 'record' },
      ],
    },
    {
      title: 'Head',
      controls: [
        { type: 'slider', key: 'head.yawGain', label: 'Turn', min: 0, max: 3, step: 0.05, format: x },
        { type: 'slider', key: 'head.pitchGain', label: 'Nod', min: 0, max: 3, step: 0.05, format: x },
        { type: 'headStatus' },
        { type: 'toggle', key: 'head.flipNod', label: 'Flip nod',
          hint: 'Only if nodding still goes the wrong way.' },
        { type: 'slider', key: 'head.rollGain', label: 'Tilt', min: 0, max: 3, step: 0.05, format: x },
        { type: 'slider', key: 'head.positionGain', label: 'Lean / move', min: 0, max: 3, step: 0.05, format: x },
        { type: 'slider', key: 'head.limitDeg', label: 'Range limit', min: 10, max: 80, step: 1, format: deg },
        { type: 'slider', key: 'head.rollLimitDeg', label: 'Tilt limit', min: 5, max: 60, step: 1, format: deg,
          hint: 'How far the head may tilt. Past about 25° it turns inside its collar.' },
      ],
    },
    {
      title: 'Eyes',
      controls: [
        { type: 'slider', key: 'eyes.blinkGain', label: 'Blink strength', min: 0.4, max: 3, step: 0.05, format: x },
        { type: 'slider', key: 'eyes.blinkThreshold', label: 'Blink threshold', min: 0.05, max: 0.85, step: 0.01, format: pct,
          hint: 'Raise it if the model looks sleepy; lower it if blinks get missed.' },
        { type: 'slider', key: 'eyes.gazeLid', label: 'Ignore lid from gaze', min: 0, max: 1, step: 0.01, format: x,
          hint: 'Looking down pulls your eyelid down, which the tracker reads as a blink. '
            + 'Raise this if the model shuts its eyes while yours are open; lower it if blinks get missed.' },
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
      title: 'Arms',
      controls: [
        { type: 'note', text: 'Uses a second tracking model, so it only loads while the camera is on. Turn it off if the frame rate suffers.' },
        { type: 'toggle', key: 'arms.track', label: 'Track my arms',
          hint: 'Picks up raising your hands off the keyboard.' },
        { type: 'armStatus' },
        { type: 'slider', key: 'arms.gain', label: 'Arm travel', min: 0, max: 3, step: 0.05, format: x },
        { type: 'slider', key: 'arms.smooth', label: 'Arm steadiness', min: 0.2, max: 4, step: 0.05, format: x,
          hint: 'Higher is calmer. Arms move slowly, so they can take more smoothing than the face.' },
      ],
    },
    {
      title: 'Body & scarf',
      controls: [
        { type: 'slider', key: 'body.followGain', label: 'Body follows head', min: 0, max: 2, step: 0.05, format: x },
        { type: 'slider', key: 'body.shoulderGain', label: 'Body follows my shoulders', min: 0, max: 3, step: 0.05, format: x,
          hint: 'Where the pose model can see your shoulders, they set the body '
            + 'instead of the head — so the body can sit turned while you look '
            + 'back at the camera. Needs arm tracking on.' },
        { type: 'slider', key: 'body.breathAmount', label: 'Breathing', min: 0, max: 2.5, step: 0.05, format: x },
        { type: 'slider', key: 'body.breathRate', label: 'Breath rate', min: 0.05, max: 0.8, step: 0.01, format: hz },
        { type: 'slider', key: 'body.swayAmount', label: 'Idle sway', min: 0, max: 2.5, step: 0.05, format: x },
        { type: 'slider', key: 'body.hairPhysics', label: 'Tuft lag', min: 0, max: 2.5, step: 0.05, format: x },
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
        { type: 'framingHelp' },
        { type: 'fit' },
        { type: 'slider', key: 'stage.zoom', label: 'Size', min: 0.15, max: 6, step: 0.005, format: x },
        { type: 'slider', key: 'stage.offsetX', label: 'Across', min: -1.5, max: 1.5, step: 0.002, format: pct },
        { type: 'slider', key: 'stage.offsetY', label: 'Up / down', min: -1.5, max: 1.5, step: 0.002, format: pct },
        { type: 'toggle', key: 'stage.lockFraming', label: 'Lock framing',
          hint: 'Stops a stray scroll or drag moving the shot mid-stream.' },
        { type: 'obsHelp' },
      ],
    },
    {
      title: 'Model',
      controls: [
        { type: 'heading', label: 'Head' },
        { type: 'slider', key: 'warp.turn', label: 'Turn left/right', min: 0, max: 2.5, step: 0.01, format: x },
        { type: 'slider', key: 'warp.nod', label: 'Nod up/down', min: 0, max: 2.5, step: 0.01, format: x },
        { type: 'slider', key: 'parts.contactShadow', label: 'Layer depth', min: 0, max: 1, step: 0.01, format: x,
          hint: 'Shades where one layer sits over another, so the parts read as stacked rather than flat.' },
        { type: 'slider', key: 'parts.nodTurn', label: 'Head turn on nod', min: 0, max: 1.2, step: 0.01, format: x,
          hint: 'How far the head cutout rotates as you nod. It turns rather than bending, '
            + 'because the drawing only ever shows the face from one angle.' },
        { type: 'toggle', key: 'parts.headOn', label: 'Face the camera',
          hint: 'Shows the drawing of the head facing the camera while you look at it, and '
            + 'the drawn three-quarter view as you turn away.' },
        // Printed as real head degrees: the value is in avatar space, which is
        // the tracked angle already multiplied by head.yawGain.
        { type: 'slider', key: 'parts.headOnHold', label: '— hold it until', min: 0.05, max: 0.6, step: 0.005,
          format: (v) => `${Math.round(v * 57 / store.get('head.yawGain'))}°`,
          hint: 'How far you can turn before the face gives way to the drawn three-quarter '
            + 'one. It holds until then and changes once, rather than sliding the whole way, '
            + 'so talking does not walk the eyes across the visor.' },
        { type: 'slider', key: 'parts.headOnTime', label: '— changes after', min: 0.04, max: 0.6, step: 0.01, format: (v) => `${Math.round(v * 1000)}ms` },
        { type: 'slider', key: 'parts.headOnDwell', label: '— then holds for', min: 0, max: 3, step: 0.05, format: (v) => `${v.toFixed(1)}s`,
          hint: 'The least time a view is kept before it can hand over again. Without it, a '
            + 'head that sits near the threshold crosses it constantly and the eyes never settle.' },
        { type: 'slider', key: 'warp.overshoot', label: 'Overshoot', min: 0, max: 1, step: 0.01, format: x },

        { type: 'heading', label: 'Cloth & hair' },
        { type: 'slider', key: 'warp.clothWeight', label: 'Scarf travel', min: 0, max: 3, step: 0.01, format: x },
        { type: 'slider', key: 'warp.clothStiffness', label: 'Scarf stiffness', min: 0.1, max: 4, step: 0.01, format: x },
        { type: 'slider', key: 'parts.clothReach', label: '— loose ends swing', min: 0.6, max: 20, step: 0.1, format: x },
        { type: 'slider', key: 'warp.tuftWeight', label: 'Tuft travel', min: 0, max: 3, step: 0.01, format: x },
        { type: 'slider', key: 'warp.tuftStiffness', label: 'Tuft stiffness', min: 0.1, max: 4, step: 0.01, format: x },
        { type: 'slider', key: 'warp.wind', label: 'Idle drift', min: 0, max: 3, step: 0.01, format: x },

        { type: 'heading', label: 'Eyes' },
        { type: 'toggle', key: 'warp.eyesEnabled', label: 'Blink and squint' },
        { type: 'slider', key: 'warp.squint', label: 'Squint amount', min: 0, max: 2.5, step: 0.01, format: x },
        { type: 'slider', key: 'warp.eyeGlow', label: 'Glow', min: 0, max: 1.5, step: 0.01, format: x },
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
    if (control.key && store.get(control.key) === undefined) {
      // A stale control naming a setting that no longer exists should not take
      // the whole panel down with it.
      console.warn(`panel: skipping control for unknown setting ${control.key}`);
      continue;
    }
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
    input.dataset.key = spec.key;
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
    input.dataset.key = spec.key;
    const sync = () => { input.checked = Boolean(store.get(spec.key)); };
    input.addEventListener('change', () => store.set(spec.key, input.checked));
    store.subscribe((key) => key === spec.key && sync());
    sync();
    label.append(input, el('span', null, spec.label));
    field.append(label);
    if (spec.hint) field.append(el('div', 'field__hint', spec.hint));
    return field;
  },

  /**
   * Live read of what the pose model is actually seeing.
   *
   * Arms not moving has several possible causes that look identical from the
   * outside — the model not loaded, your shoulders out of frame, the angles
   * being read but scaled to nothing — and no way to tell them apart without
   * looking. This shows which one it is.
   */
  /* What the tracker says your head is doing, in words.
   *
   * "Up and down are reversed" has two completely different causes with
   * opposite fixes — the tracker reading the nod backwards for this camera, or
   * the model drawing it backwards — and from the outside they look identical.
   * This splits them: look down, read the line. If it says looking down, the
   * tracker is right and the drawing is wrong; if it says looking up, the
   * tracker is wrong and Invert nod is the fix. It lives in the panel rather
   * than on the stage because the panel is not what OBS captures.
   */
  headStatus(spec, ctx) {
    if (!ctx.headStatus) return null;
    const field = el('div', 'field');
    const line = el('div', 'field__hint');
    line.style.cssText = 'font-variant-numeric:tabular-nums;line-height:1.6;white-space:pre';
    field.append(line);

    const deg1 = (r) => `${r >= 0 ? '+' : ''}${((r * 180) / Math.PI).toFixed(0)}°`;
    const paint = () => {
      const h = ctx.headStatus();
      if (!h.camera) { line.textContent = 'Start the camera to see this.'; return; }
      if (!h.tracked) { line.textContent = 'No face found.'; return; }
      const nod = Math.abs(h.pitch) < 0.06 ? 'level' : h.pitch > 0 ? 'looking UP' : 'looking DOWN';
      const turn = Math.abs(h.yaw) < 0.06 ? 'straight on' : h.yaw > 0 ? 'turned RIGHT' : 'turned LEFT';
      line.textContent = [
        `nod   ${deg1(h.pitch)}  ${nod}`,
        `turn  ${deg1(h.yaw)}  ${turn}`,
        `tilt  ${deg1(h.roll)}`,
      ].join('\n');
    };
    paint();
    setInterval(paint, 150);
    return field;
  },

  armStatus(spec, ctx) {
    if (!ctx.armStatus) return null;
    const field = el('div', 'field');
    const line = el('div', 'field__hint');
    line.style.cssText = 'font-variant-numeric:tabular-nums;line-height:1.6';
    field.append(line);

    const paint = () => {
      const s = ctx.armStatus();
      const n = (v) => (v >= 0 ? ' ' : '') + v.toFixed(2);
      line.textContent = [
        `camera ${s.camera ? 'on' : 'off'} · model ${s.model} · pose ${s.pose}`,
        `shoulders ${s.shoulders} · updates ${s.rate}/s`,
        `left  raise ${n(s.left.raise)}  upper ${n(s.left.upper)}`,
        `right raise ${n(s.right.raise)}  upper ${n(s.right.upper)}`,
      ].join('\n');
      line.style.whiteSpace = 'pre';
    };
    paint();
    setInterval(paint, 250);
    return field;
  },

  /**
   * Record what the trackers see, for replaying in tests.
   *
   * The synthetic sweeps in the test suite are guesses about what a camera
   * produces. This captures what one actually did.
   */
  record(spec, ctx) {
    if (!ctx.recorder || !ctx.startRecording) return null;
    /* A minute, not twenty seconds.
     *
     * Twenty seconds is long enough to prove the recorder works and short
     * enough to miss what it is for. The faults that have actually reached the
     * screen came from the gap between a synthetic sweep and a person: holding
     * still badly, glancing away and back, the tracker dropping out for a
     * frame. Those live in the awkward middle of a session, and twenty seconds
     * is nearly all beginning and end.
     */
    const SECONDS = 60;
    const field = el('div', 'field');
    const button = el('button', 'btn', `Record ${SECONDS} seconds`);
    button.type = 'button';
    const hint = el('div', 'field__hint',
      'Saves the tracking numbers — blendshapes, head angles, body points — as a file. '
      + 'No video is recorded and no image data is saved, and nothing leaves this '
      + 'machine except the file you choose to keep.');
    field.append(button, hint);

    const paint = () => {
      const r = ctx.recorder;
      if (r.recording) {
        button.disabled = true;
        button.textContent = `Recording… ${(r.seconds - r.elapsed).toFixed(1)}s (${r.frames.length} frames)`;
      } else {
        button.disabled = false;
        button.textContent = `Record ${SECONDS} seconds`;
      }
    };

    button.addEventListener('click', () => {
      if (!ctx.startRecording(SECONDS)) {
        hint.textContent = 'Start the camera first — there is nothing to record yet.';
        return;
      }
      hint.textContent = 'Talk, and move the way you actually would on stream: turn '
        + 'right round and back, look up and down, tilt, blink, glance away, raise '
        + 'your hands, then sit still for a while. The dull and the awkward parts '
        + 'are the ones worth having — a tidy sweep is what the tests already guess.';
    });

    let saved = false;
    ctx.recorder.onTick = (r) => {
      paint();
      if (r.recording) { saved = false; return; }
      if (saved || !r.frames.length) return;
      saved = true;
      r.save();
      hint.textContent = `Saved ${r.frames.length} frames as tracker-session.json. `
        + 'Upload it to the repo under test/fixtures/, replacing what is there, and '
        + 'every check in the suite replays your session instead of a guess at one.';
    };
    setInterval(paint, 120);
    paint();
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


  note(spec) {
    return el('p', 'note', spec.text);
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

  heading(spec) {
    const node = el('h4', 'group__heading');
    node.textContent = spec.label;
    return node;
  },

  framingHelp() {
    const note = el('p', 'note');
    note.innerHTML =
      '<strong>Drag the character</strong> to move it and <strong>scroll</strong> to resize, ' +
      'right on the stage. Zoom follows your pointer, so you magnify what you are aiming at. ' +
      'The sliders below do the same thing if you want exact numbers.';
    return note;
  },

  fit(_spec, ctx) {
    const field = el('div', 'field');
    const row = el('div', 'btn-row');
    for (const [mode, label] of [['whole', 'Fit whole'], ['head', 'Head & shoulders'], ['reset', 'Reset']]) {
      const button = el('button', 'btn', label);
      button.type = 'button';
      button.addEventListener('click', () => {
        if (mode === 'reset') {
          store.patch({ 'stage.zoom': store.DEFAULTS['stage.zoom'], 'stage.offsetX': 0, 'stage.offsetY': 0 });
        } else {
          ctx.fitFraming?.(mode);
        }
      });
      row.append(button);
    }
    field.append(row);
    return field;
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
      ['C', 'Set neutral pose (3-second countdown)'],
      ['D', 'Show or hide the readout'],
      ['H', 'Hide the interface'],
      ['M', 'Flip mirroring'],
    ];
    for (const [key, label] of rows) {
      const row = el('div', 'keycap');
      row.append(el('kbd', null, key), el('span', null, label));
      wrap.append(row);
    }
    const box = el('div', 'field');
    box.append(wrap);
    return box;
  },
};

