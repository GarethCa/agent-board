// The platform's command key: ⌘ on macOS, Ctrl elsewhere, for the app's own shortcuts and how they are written.

const mac = navigator.platform.startsWith('Mac');

/** Whether the platform's command key is held in `event`. */
export function commandKey(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>): boolean {
  return mac ? event.metaKey : event.ctrlKey;
}

/** Whether `event` asks to undo (⌘Z) or redo (⇧⌘Z, or ⌘Y): the board's history keys, wherever they are pressed. */
export function historyStep(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'key'>): 'undo' | 'redo' | undefined {
  if (event.altKey || !commandKey(event)) return undefined;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  return key === 'y' && !event.shiftKey ? 'redo' : undefined;
}

/** Whether the focus is in a dialog or a menu, whose keys are their own. */
export function inOverlay(): boolean {
  return document.activeElement?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') != null;
}

/** A shortcut with the command key as the platform writes it: `⌘K`, or `Ctrl+K`. */
export function withCommand(key: string): string {
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}

/** The key that turns the wheel into a zoom on the board, as React Flow names it: the command key. */
export const ZOOM_KEY = mac ? 'Meta' : 'Control';

type ShortcutEvent = Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'code'>;

/**
 * The key of a session window's own shortcut (its terminal tabs, ⌘[ ⌘]), by `code` (`KeyT`, `Digit1`, `BracketLeft`),
 * with `Shift+` before it when Shift is held too; or undefined. On macOS it is pressed with ⌘. Elsewhere Ctrl and its
 * keys are the terminal's (Ctrl+D ends input, Ctrl+T transposes, Ctrl+[ is Esc), so it is pressed with Ctrl+Shift.
 */
export function windowShortcut(event: ShortcutEvent, isMac = mac): string | undefined {
  if (event.altKey) return undefined;
  if (isMac) return event.metaKey && !event.ctrlKey ? `${event.shiftKey ? 'Shift+' : ''}${event.code}` : undefined;
  return event.ctrlKey && event.shiftKey && !event.metaKey ? event.code : undefined;
}

/** A session window's shortcut as the platform writes it: `⌘T`, or `Ctrl+Shift+T`. */
export function withWindowShortcut(key: string, isMac = mac): string {
  return isMac ? `⌘${key}` : `Ctrl+Shift+${key}`;
}

type Arrow = 'left' | 'right' | 'up' | 'down';

const ARROWS: Partial<Record<string, Arrow>> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

/**
 * Which way a session window's focus moves between its panes: ⌘⌥ and an arrow on macOS; elsewhere
 * Ctrl+Shift+Alt and an arrow, as Ctrl+arrow and Ctrl+Shift+arrow move and select by word in a terminal. Undefined for
 * any other key.
 */
export function paneFocusShortcut(event: ShortcutEvent, isMac = mac): Arrow | undefined {
  const direction = ARROWS[event.code];
  if (direction === undefined || !event.altKey) return undefined;
  const held = isMac ? event.metaKey && !event.ctrlKey && !event.shiftKey : event.ctrlKey && event.shiftKey && !event.metaKey;
  return held ? direction : undefined;
}

/** The pane focus shortcut as the platform writes it: `⌘⌥←`, or `Ctrl+Shift+Alt+←`. */
export function withPaneFocusShortcut(arrow: string, isMac = mac): string {
  return isMac ? `⌘⌥${arrow}` : `Ctrl+Shift+Alt+${arrow}`;
}
