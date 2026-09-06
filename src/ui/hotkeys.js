/** Keyboard shortcuts: C neutral pose, D readout, H interface, M mirror. */
export function installHotkeys({ onCalibrate, onToggleUI, onToggleMirror, onToggleReadout }) {
  const isTyping = (target) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));

  const down = (event) => {
    if (event.repeat || isTyping(event.target)) return;
    // Ctrl+D is a bookmark and Cmd+H hides the window; leave them to the browser.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    switch (event.code) {
      case 'KeyC': onCalibrate(); break;
      case 'KeyH': onToggleUI(); break;
      case 'KeyM': onToggleMirror(); break;
      case 'KeyD': onToggleReadout?.(); break;
      default: return;
    }
    event.preventDefault();
  };

  window.addEventListener('keydown', down);
  return () => window.removeEventListener('keydown', down);
}
