/**
 * Passes tracking from the window with the camera to the window OBS opens.
 *
 * A Vite plugin rather than a second server, because there is already a server
 * running and asking somebody to keep two terminals open to stream is a way to
 * have them keep one. It attaches to the same port, so the OBS side is the same
 * address with a different page on it.
 *
 * Deliberately almost nothing: it forwards the tracker's messages to whoever
 * is listening and tells the tracker how many that is, so it can stop sending
 * when nobody is.
 *
 * It keeps the last settings message and the last rig state. Without them an
 * output that connects second — which is every time OBS is opened after the
 * tracker — would sit on stock defaults in the rest pose until the tracker
 * happened to send again, and the shot you framed would not be the shot going
 * out.
 */
import { WebSocketServer } from 'ws';

const PATH = '/__rig';

export function rigRelay() {
  return {
    name: 'vtuber-rig-relay',
    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true });
      const outputs = new Set();
      const trackers = new Set();
      let lastSettings = null;
      let lastState = null;

      const tellTrackers = () => {
        const msg = JSON.stringify({ t: 'peers', outputs: outputs.size });
        for (const sock of trackers) if (sock.readyState === 1) sock.send(msg);
      };

      wss.on('connection', (sock) => {
        sock.on('message', (data) => {
          let msg;
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return;
          }

          if (msg.t === 'hello') {
            if (msg.role === 'output') {
              outputs.add(sock);
              // Catch it up, or it renders the defaults until something changes.
              if (lastSettings) sock.send(lastSettings);
              if (lastState) sock.send(lastState);
            } else {
              trackers.add(sock);
            }
            tellTrackers();
            return;
          }

          // An output has one thing to say: that it could not draw. The page
          // OBS captures may show nothing but the model, so the message goes
          // back to the tracker's status line.
          if (outputs.has(sock) && msg.t === 'status') {
            const out = data.toString();
            for (const peer of trackers) if (peer.readyState === 1) peer.send(out);
            return;
          }
          // Otherwise only the tracker has anything to say, and only outputs listen.
          if (!trackers.has(sock)) return;
          if (msg.t === 'settings') lastSettings = data.toString();
          if (msg.t === 'state') lastState = data.toString();
          const out = data.toString();
          for (const peer of outputs) if (peer.readyState === 1) peer.send(out);
        });

        sock.on('close', () => {
          outputs.delete(sock);
          trackers.delete(sock);
          tellTrackers();
        });
        sock.on('error', () => sock.close());
      });

      server.httpServer?.on('upgrade', (req, socket, head) => {
        // Vite's own HMR socket is on this port too; take only our path.
        const { pathname } = new URL(req.url ?? '/', 'http://localhost');
        if (pathname !== PATH) return;
        wss.handleUpgrade(req, socket, head, (sock) => wss.emit('connection', sock, req));
      });
    },
  };
}
