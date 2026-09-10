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
        { type: 'slider', key: 'smooth.minCutoff', label: 'Steadiness', min: 0.3, max: 6, step: 0.05, format: hz,
          hint: 'Lower is calmer when you hold still, but adds lag. Measured against a '
            + 'recording: the default 3.5 covers a turn in 100ms and leaves a tenth of a '
            + 'degree of tremor; 2.5 takes 133ms; above 5 the head gets no faster and only '
            + 'shakes more.' },
        { type: 'slider', key: 'smooth.beta', label: 'Snappiness', min: 0, max: 0.5, step: 0.005, format: (v) => v.toFixed(3),
          hint: 'How much the steadiness above is relaxed while you are actually moving. '
            + 'Higher keeps a fast turn lag-free without shaking a still head.' },
        { type: 'slider', key: 'smooth.expression', label: 'Face response', min: 0.5, max: 6, step: 0.1, format: hz },
        { type: 'guide' },
        { type: 'record' },
      ],
    },
    {
      title: 'Size & position',
      open: true,
      controls: [
        { type: 'framingHelp' },
        { type: 'fit' },
        { type: 'slider', key: 'stage.zoom', label: 'Size', min: 0.15, max: 6, step: 0.005, format: x },
        { type: 'slider', key: 'stage.rotate', label: 'Rotate', min: -180, max: 180, step: 1, format: deg,
          hint: 'Turns the character in the window. The OBS page turns with it.' },
        { type: 'slider', key: 'stage.offsetX', label: 'Across', min: -1.5, max: 1.5, step: 0.002, format: pct },
        { type: 'slider', key: 'stage.offsetY', label: 'Up / down', min: -1.5, max: 1.5, step: 0.002, format: pct },
        { type: 'toggle', key: 'stage.lockFraming', label: 'Lock framing',
          hint: 'Stops a stray scroll or drag moving the shot mid-stream.' },
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
        { type: 'slider', key: 'head.response', label: 'Small movements', min: 0.35, max: 1, step: 0.01, format: x,
          hint: 'Lower makes a small turn show more without moving the extreme. A 5° turn slides the drawing 1.7px at 1, and 3.5px at 0.65 — the same as a 5° nod.' },
        { type: 'slider', key: 'head.gazeLead', label: '— light follows the turn', min: 0, max: 1.5, step: 0.05, format: x,
          hint: 'A turn has no rotation to show, only a slide, so it moves the light inside the visor as well.' },
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
      title: 'Expressions',
      controls: [
        { type: 'note', text: 'The face has a visor and no mouth, so an expression shows in the '
          + 'shape of the slits, the glow, and how the head moves.' },
        { type: 'slider', key: 'face.surpriseGain', label: 'Surprise', min: 0, max: 2.5, step: 0.05, format: x,
          hint: 'Open your mouth wide and the eyes open wide, the glow flares and the head pulls '
            + 'back. It follows whatever Speech is Driven by, so with the microphone it fires on a '
            + 'loud open-mouthed reaction. 0 turns it off.' },
      ],
    },
    {
      title: 'Speech',
      controls: [
        { type: 'note', text: 'The mouth is under the scarf, so speech lifts the visor glow and bobs the head instead.' },
        { type: 'microphones' },
        { type: 'micMeter' },
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
        { type: 'note', text: 'Off by default: it loads a second tracking model that shares the '
          + 'graphics card with the face, so the face is tracked less often while it runs, and it '
          + 'can only say anything while your elbows are inside the frame. Left off, the arms drift '
          + 'gently on their own.' },
        { type: 'toggle', key: 'arms.track', label: 'Track my arms',
          hint: 'Picks up raising your hands off the keyboard. Costs face-tracking frames.' },
        { type: 'slider', key: 'arms.float', label: 'Arm drift', min: 0, max: 2, step: 0.05, format: x,
          hint: 'How much an arm nobody can see moves on its own. 0 holds them still.' },
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
            + 'so talking does not walk the eyes across the visor. Narrowing it costs no extra '
            + 'changes of face: measured on the recordings, 13° spends 38% of the time frontal '
            + 'and 8° spends 20%, both swapping about 30 times a minute.' },
        { type: 'slider', key: 'parts.headOnTime', label: '— changes after', min: 0.04, max: 0.6, step: 0.01, format: (v) => `${Math.round(v * 1000)}ms` },
        { type: 'slider', key: 'parts.headOnReturn', label: '— comes back after', min: 0.1, max: 1.5, step: 0.05, format: (v) => `${v.toFixed(2)}s`,
          hint: 'How long you must sit square before the face comes back. Turning away is '
            + 'immediate; coming back waits, so a head hovering near the threshold does not flicker.' },
        { type: 'slider', key: 'warp.overshoot', label: 'Overshoot', min: 0, max: 1, step: 0.01, format: x,
          hint: 'How much of the head\'s move is follow-through rather than going straight there. '
            + 'All of it is lag: measured, 1.00 takes 100ms to cover most of a step and the default '
            + '0.30 takes about 45ms, against one frame at 0.' },
        { type: 'slider', key: 'parts.motionBlur', label: 'Motion blur', min: 0, max: 1.5, step: 0.05, format: x,
          hint: 'Smears the head along the way it is moving, and only while it moves. '
            + 'It also covers the moment the face changes over on a turn. 0 turns it off.' },

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

  /** Live read of what the pose model is actually seeing. */
  /* What the tracker says your head is doing, in words. */
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

  /** The guided calibration: five prompts on the stage, then the result and an Undo. */
  guide(_spec, ctx) {
    if (!ctx.startGuide) return null;
    const field = el('div', 'field');
    const button = el('button', 'btn', 'Guided calibration (G)');
    button.type = 'button';
    button.addEventListener('click', () => ctx.startGuide());
    const hint = el('div', 'field__hint',
      'Six prompts on the stage: sit as you stream and look where you usually look, turn left, '
      + 'right, up and down as far as you would, then open your mouth wide. Sets where forward '
      + 'is, how far a turn goes, and how wide your mouth reads. C sets forward alone.');
    const result = el('div', 'field__hint');
    const undo = el('button', 'btn', 'Undo calibration');
    undo.type = 'button';
    undo.hidden = true;
    undo.addEventListener('click', () => ctx.undoGuide?.());
    const paint = () => {
      const text = ctx.guideReport?.() ?? '';
      if (result.textContent !== text) result.textContent = text;
      undo.hidden = !ctx.canUndoGuide?.();
    };
    paint();
    setInterval(paint, 250);
    field.append(button, hint, result, undo);
    return field;
  },

  /** Record what the trackers see, for replaying in tests. */
  record(spec, ctx) {
    if (!ctx.recorder || !ctx.startRecording) return null;
    const SECONDS = 60;
    const field = el('div', 'field');
    const button = el('button', 'btn', `Record ${SECONDS} seconds`);
    button.type = 'button';
    const hint = el('div', 'field__hint',
      'Saves the tracking numbers: blendshapes, head angles, body points. No video, '
      + 'no image data. Running locally it lands in the project; on the published '
      + 'site it downloads.');
    const actions = el('div', 'field__actions');
    actions.hidden = true;
    const mk = (label) => { const b = el('button', 'btn', label); b.type = 'button'; return b; };
    const calibrateBtn = mk('Calibrate from this recording');
    const undoBtn = mk('Undo calibration');
    const shareBtn = mk('Send to the developer');
    const uploadBtn = mk('Open GitHub upload page');
    actions.append(calibrateBtn, undoBtn, shareBtn, uploadBtn);
    field.append(button, hint, actions);

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
      actions.hidden = true;
      hint.textContent = 'Talk, and move the way you actually would on stream: turn '
        + 'right round and back, look up and down, tilt, blink, glance away, raise '
        + 'your hands, then sit still for a while. The dull and the awkward parts '
        + 'are the ones worth having.';
    });

    let json = null;
    let saved = null; // where the dev server put it, or null for a download
    let before = null; // settings as they were before a calibration
    let done = true;
    ctx.recorder.onTick = async (r) => {
      paint();
      if (r.recording) { done = false; return; }
      if (done || !r.frames.length) return;
      done = true;
      json = r.toJSON(ctx.recordingExtra?.() ?? {});
      try {
        saved = await ctx.saveRecording(json);
        hint.textContent = `Saved ${r.frames.length} frames to ${saved.path}.`;
      } catch (err) {
        saved = null;
        r.download(json);
        hint.textContent = `Saved ${r.frames.length} frames as tracker-session.json in your downloads `
          + `(${err.message}). The upload page takes it from there.`;
      }
      shareBtn.hidden = !saved;
      undoBtn.hidden = true;
      actions.hidden = false;
    };

    calibrateBtn.addEventListener('click', () => {
      if (!json) return;
      const { patch, report } = ctx.calibrateFrom(JSON.parse(json));
      if (!patch) { hint.textContent = report.join(' '); return; }
      before = store.snapshot();
      const changes = Object.keys(patch)
        .filter((k) => k !== 'camera.neutral' && before[k] !== patch[k])
        .map((k) => `${k.split('.').pop()} ${before[k]} → ${patch[k]}`);
      store.patch(patch);
      hint.textContent = `${report.join(' ')}${changes.length ? ` Changed: ${changes.join(', ')}.` : ''}`;
      undoBtn.hidden = false;
    });
    undoBtn.addEventListener('click', () => {
      if (!before) return;
      store.patch(before);
      before = null;
      undoBtn.hidden = true;
      hint.textContent = 'Calibration undone; settings are back to what they were.';
    });
    shareBtn.addEventListener('click', async () => {
      if (!saved) return;
      shareBtn.disabled = true;
      hint.textContent = 'Pushing to GitHub…';
      try {
        const r = await ctx.shareRecording(saved.name);
        hint.textContent = `On GitHub: ${r.file} on the ${r.branch} branch (${r.commit}). The developer can pick it up from there.`;
      } catch (err) {
        hint.textContent = `${err.message} The upload page works from any machine: it wants the file at ${saved.path}.`;
      } finally {
        shareBtn.disabled = false;
      }
    });
    uploadBtn.addEventListener('click', () => window.open(ctx.uploadUrl, '_blank', 'noopener'));
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

  microphones(_spec, ctx) {
    if (!ctx.listMics) return null;
    const field = el('div', 'field');
    const select = el('select');
    const refresh = async () => {
      const mics = await ctx.listMics();
      select.replaceChildren();
      const auto = el('option', null, 'Default microphone');
      auto.value = '';
      select.append(auto);
      mics.forEach((m, i) => {
        const option = el('option', null, m.label || `Microphone ${i + 1}`);
        option.value = m.deviceId;
        select.append(option);
      });
      select.value = store.get('mouth.deviceId');
    };
    select.addEventListener('change', () => ctx.selectMic(select.value));
    ctx.onMicsChanged?.(refresh);
    refresh();
    field.append(labelledRow('Microphone'), select);
    return field;
  },

  /** What the microphone hears, against the gate it has to clear to count. */
  micMeter(_spec, ctx) {
    if (!ctx.micStatus) return null;
    const field = el('div', 'field');
    const bar = el('div', 'meter');
    const fill = el('div', 'meter__fill');
    const gate = el('div', 'meter__gate');
    bar.append(fill, gate);
    const hint = el('div', 'field__hint');
    const paint = () => {
      const s = ctx.micStatus();
      // The meter's full width is the loudness the mouth counts as wide open.
      const span = 0.16;
      fill.style.width = `${Math.min(100, (s.level / span) * 100).toFixed(1)}%`;
      gate.style.left = `${Math.min(100, (s.gate / span) * 100).toFixed(1)}%`;
      fill.classList.toggle('meter__fill--live', s.level > s.gate);
      hint.textContent = s.source === 'camera'
        ? 'Set Driven by to Microphone or Whichever is stronger to use it.'
        : s.on
          ? `Hearing ${(s.level * 100).toFixed(0)}%, gate ${(s.gate * 100).toFixed(0)}% — speech ${(s.open * 100).toFixed(0)}% open.`
          : 'Microphone not running.';
    };
    paint();
    setInterval(paint, 100);
    field.append(labelledRow('Level'), bar, hint);
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
      '<strong>Drag the character</strong> to move it and <strong>scroll</strong> over it to ' +
      'shrink or grow it, right on the stage. Zoom follows your pointer, so you magnify what ' +
      'you are aiming at. The sliders below do the same with exact numbers. The OBS page follows.';
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
          store.patch({ 'stage.zoom': store.DEFAULTS['stage.zoom'], 'stage.offsetX': 0, 'stage.offsetY': 0,
            'stage.rotate': 0 });
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
      ['G', 'Guided calibration: neutral pose and range'],
      ['Esc', 'Cancel the guided calibration'],
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

