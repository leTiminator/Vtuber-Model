/**
 * Keyboard shortcuts. Expressions are hold-to-activate (1-5), so a reaction
 * lasts exactly as long as you hold the key and releases naturally.
 */
const EXPRESSIONS = {
  Digit1: 'blush',
  Digit2: 'anger',
  Digit3: 'sparkle',
  Digit4: 'sweat',
  Digit5: 'shock',
};

export function installHotkeys({ rig, onCalibrate, onToggleUI, onToggleMirror, onToggleReadout }) {
  const held = new Set();

  const isTyping = (target) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));

  const down = (event) => {
    if (event.repeat || isTyping(event.target)) return;
    // Ctrl+D is a bookmark and Cmd+H hides the window; leave them to the browser.
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const expression = EXPRESSIONS[event.code];
    if (expression) {
      held.add(event.code);
      rig.setOverride(expression, 1);
      event.preventDefault();
      return;
    }

    switch (event.code) {
      case 'KeyC': onCalibrate(); break;
      case 'KeyH': onToggleUI(); break;
      case 'KeyM': onToggleMirror(); break;
      case 'KeyD': onToggleReadout?.(); break;
      default: return;
    }
    event.preventDefault();
  };

  const up = (event) => {
    const expression = EXPRESSIONS[event.code];
    if (!expression) return;
    held.delete(event.code);
    rig.setOverride(expression, 0);
  };

  // Losing focus mid-hold would otherwise leave an expression stuck on.
  const clear = () => {
    for (const code of held) rig.setOverride(EXPRESSIONS[code], 0);
    held.clear();
  };

  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', clear);

  return () => {
    window.removeEventListener('keydown', down);
    window.removeEventListener('keyup', up);
    window.removeEventListener('blur', clear);
    clear();
  };
}
