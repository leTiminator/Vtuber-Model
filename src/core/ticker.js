/**
 * A steady tick from a Worker timer, which keeps its rate while the window is
 * hidden or covered and the page's own timers and animation frames slow to
 * about one a second.
 */
const SOURCE = 'let t; onmessage = (e) => { clearInterval(t); if (e.data > 0) t = setInterval(() => postMessage(0), e.data); };';

/** `fn` runs on the page's thread `hz` times a second with performance.now(); returns { stop }. */
export function startTicker(hz, fn) {
  let worker = null;
  try {
    const url = URL.createObjectURL(new Blob([SOURCE], { type: 'text/javascript' }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
  } catch {
    return { stop() {} }; // no Worker here: the animation frame loop is all there is
  }
  worker.onmessage = () => fn(performance.now());
  worker.postMessage(1000 / hz);
  return {
    stop() {
      worker.postMessage(0);
      worker.terminate();
    },
  };
}
