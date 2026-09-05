/**
 * The text of the D readout and the build stamp: what the tracker sees, what
 * the rig makes of it, which face is showing, whether the arms are in frame,
 * and which settings differ from their defaults.
 */
import * as store from '../core/store.js';

/** Settings the app writes itself; not worth listing as "changed". */
const MACHINE_SET = /^camera\.(deviceId|neutral)$/;

export const deg = (rad) => `${rad >= 0 ? '+' : ''}${Math.round((rad * 180) / Math.PI)}°`;

/** The build id Vite stamps in, or "dev" under the dev server. */
export function buildId(short = false) {
  const build = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';
  return short ? build.slice(0, 7) : build;
}

/** "changed: key value, ... +N" or "all settings default". */
export function changedSettings({ shortKeys = false, limit = 6 } = {}) {
  const now = store.snapshot();
  const changed = Object.keys(store.DEFAULTS)
    .filter((k) => now[k] !== store.DEFAULTS[k] && !MACHINE_SET.test(k))
    .map((k) => `${shortKeys ? k.split('.').pop() : k} ${now[k]}`);
  if (!changed.length) return 'all settings default';
  const rest = changed.length > limit ? ` +${changed.length - limit}${shortKeys ? '' : ' more'}` : '';
  return `changed: ${changed.slice(0, limit).join(', ')}${rest}`;
}

export function stampText() {
  return `build ${buildId()} · ${changedSettings()}`;
}

/** Where forward is, and whether a neutral capture is counting down. */
export function neutralLine(rig) {
  const n = rig.neutral;
  const cal = rig.pendingCalibration;
  const wait = cal ? Math.max(0, cal.armAt - rig.clock) : 0;
  const capturing = !cal ? ''
    : wait > 0 ? ` · setting neutral in ${Math.ceil(wait)}… look where you stream`
      : ' · capturing — hold still';
  if (!n) {
    return (cal ? 'neutral: not set yet' : 'NEUTRAL NOT SET — press C sitting how you stream')
      + capturing;
  }
  const off = Math.abs(n.yaw) * 180 / Math.PI;
  const where = off > 8
    ? `forward is where you looked when you set the pose, ${Math.round(off)}° from the camera`
    : 'forward is the camera';
  return `${where} · neutral ${deg(n.yaw)} ${deg(n.pitch)} ${deg(n.roll)}`
    + (off > 8 && !cal ? ' — C resets it, 3-second countdown' : '') + capturing;
}

/** Raw angles beside driven ones, the face zoom, and what the pose model sees. */
export function liveLines({ tracker, pose, rig }) {
  if (!tracker.running) return [];
  const out = [];
  const head = tracker.frame?.head;
  if (head && tracker.hasFace) {
    const mirror = store.get('camera.mirror');
    const seen = mirror ? { yaw: -head.yaw, pitch: head.pitch, roll: -head.roll } : head;
    const s = rig.state.head;
    out.push(`seen yaw ${deg(seen.yaw)} pitch ${deg(seen.pitch)} roll ${deg(seen.roll)}`
      + `  →  driven ${deg(s.yaw)} ${deg(s.pitch)} ${deg(s.roll)}`);
  } else {
    out.push('no face in frame');
  }
  const a = rig.state.arms;
  const z = tracker.crop;
  out.push(z
    ? `face zoom ${(1 / Math.max(z.w, 1e-3)).toFixed(1)}× on the camera`
    : `face zoom off — whole frame${store.get('camera.faceZoom') === 'off' ? '' : ' (looking for a face)'}`);
  out.push(store.get('arms.track')
    ? `pose ${pose.enabled ? `${pose.rate.toFixed(0)}/s stride ${pose.stride}` : 'loading…'}`
      + ` · arms L ${a.left.seen.toFixed(2)} R ${a.right.seen.toFixed(2)}`
      + ` · wrists L ${a.left.wrist.toFixed(2)} R ${a.right.wrist.toFixed(2)}`
      + ` · lift L ${a.left.raise.toFixed(2)} R ${a.right.raise.toFixed(2)}`
      + `\nbody from shoulders ${rig.state.torso.seen.toFixed(2)}`
      + ` · turn ${rig.state.torso.turn.toFixed(2)}`
      + ` lean ${rig.state.torso.lean.toFixed(2)}`
    : 'arm tracking off');
  const j = pose.frame?.joints;
  if (store.get('arms.track') && pose.enabled && j?.shoulderL && j?.shoulderR) {
    const shoulderY = (j.shoulderL.y + j.shoulderR.y) / 2;
    const where = `shoulders at ${Math.round(shoulderY * 100)}% of the frame's height`;
    const gone = [];
    for (const [side, arm] of [['left', a.left], ['right', a.right]]) {
      if (arm.seen < 0.3) gone.push(`${side} elbow`);
      else if (arm.wrist < 0.3) gone.push(`${side} wrist`);
    }
    if (gone.length) {
      const joint = (g) => g.split(' ')[1];
      const what = gone.length === 2 && joint(gone[0]) === joint(gone[1])
        ? `both ${joint(gone[0])}s` : gone.join(' and ');
      const why = gone.some((g) => g.endsWith('elbow'))
        ? 'move the camera back or down' : 'lift is read off the elbow';
      out.push(`  ⚠ ${what} out of frame — ${why}; ${where}`);
    }
  }
  return out;
}

/**
 * The whole readout, or null when the renderer has nothing to report yet.
 * @returns {{text: string, torn: boolean} | null}
 */
export function readoutText({ avatar, rig, tracker, pose }) {
  const r = avatar.selfCheck();
  if (!r) return null;
  const torn = r.pieces !== 1;
  const text = [
    `${buildId()} · ${r.pieces} piece${r.pieces === 1 ? '' : 's'}` + (torn ? ` (stray ${r.strays.join(', ')})` : ''),
    `${r.buffer} buffer · dpr ${r.dpr} · skinning ${r.skinning}`,
    neutralLine(rig) + (rig.neutralWarning ? `\n  ⚠ ${rig.neutralWarning}` : ''),
    r.drawn,
    r.headOn ? `head-on: ${r.headOn}` : null,
    ...liveLines({ tracker, pose, rig }),
    changedSettings({ shortKeys: true }),
  ].filter(Boolean).join('\n');
  return { text, torn };
}
