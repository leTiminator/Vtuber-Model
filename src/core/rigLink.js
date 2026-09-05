/**
 * The wire between the window you sit in front of and the one OBS opens.
 *
 * OBS composites a Browser Source with real transparency, which is the only
 * way into a scene that needs no keying and has no window — so nothing to crop
 * and no title bar in shot. What it cannot reliably do is open a webcam: its
 * embedded browser needs a launch flag for that and fails silently without
 * one, and even given the flag it would be running a face-tracking model
 * beside your encoder in an older Chromium.
 *
 * So it does not. Tracking stays in a real browser tab, which already has the
 * camera and a current runtime, and sends the numbers here. What OBS loads has
 * no camera in it at all. This is the same shape the browser-based tools in
 * this space use, and the same division the native ones make when they hand a
 * texture to OBS rather than asking OBS to animate anything.
 *
 * What crosses is what the session recorder already captures: blendshape
 * weights and head angles, about a kilobyte a frame. No video, and nothing
 * leaves the machine — the relay is the local dev server that is already
 * running.
 */

const PATH = '/__rig';

/** ws:// beside http://, wss:// beside https://. */
function endpoint() {
  const url = new URL(PATH, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * @param {object} opts
 * @param {'tracker'|'output'} opts.role
 * @param {(msg: object) => void} [opts.onFrame]
 * @param {(values: object) => void} [opts.onSettings]
 * @param {(state: {connected: boolean, outputs: number}) => void} [opts.onState]
 * @param {(msg: {text: string}) => void} [opts.onPeerStatus]  an error the other page reports
 */
export function openRigLink({ role, onFrame, onSettings, onState, onPeerStatus }) {
  let socket = null;
  let closed = false;
  /* Backs off, because the common case is that the other end is simply not
   * running yet — OBS opened before the tracker, or the tracker before OBS —
   * and hammering a refused connection several times a second for an hour is
   * a way to find out about a bug you do not have. */
  let wait = 500;
  let timer = 0;

  const link = {
    connected: false,
    outputs: 0,
    /** True when there is somebody to send to. Frames are wasted otherwise. */
    get wanted() { return link.connected && link.outputs > 0; },
    send(msg) {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(msg));
      return true;
    },
    close() {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    },
  };

  const announce = () => onState?.({ connected: link.connected, outputs: link.outputs });

  const connect = () => {
    if (closed) return;
    let sock;
    try {
      sock = new WebSocket(endpoint());
    } catch {
      // A blob: or file: origin has no host to build a URL against. There is
      // no relay in that case and there never will be, so stop trying.
      closed = true;
      return;
    }
    socket = sock;

    sock.onopen = () => {
      wait = 500;
      link.connected = true;
      sock.send(JSON.stringify({ t: 'hello', role }));
      announce();
    };

    sock.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return; // not ours
      }
      if (msg.t === 'peers') {
        link.outputs = msg.outputs ?? 0;
        announce();
      } else if (msg.t === 'settings') {
        onSettings?.(msg.values ?? {});
      } else if (msg.t === 'frame') {
        onFrame?.(msg);
      } else if (msg.t === 'status') {
        onPeerStatus?.(msg);
      }
    };

    const drop = () => {
      if (socket !== sock) return;
      link.connected = false;
      link.outputs = 0;
      announce();
      if (closed) return;
      timer = setTimeout(connect, wait);
      wait = Math.min(wait * 2, 5000);
    };
    sock.onclose = drop;
    sock.onerror = drop;
  };

  connect();
  return link;
}
