// A session window's own keys for its panes and tabs, read from a key press. Pure, so both platforms are tested.
import type { SplitDirection } from '@agent-board/daemon/pane-layout';
import { paneFocusShortcut, windowShortcut } from '../keys';
import { keyText, pressed } from '../keys/registry';
import type { Direction } from './pane-geometry';

export type WindowPaneKey =
  | { kind: 'newTab' }
  | { kind: 'close' }
  | { kind: 'split'; direction: SplitDirection }
  | { kind: 'tab'; digit: number }
  | { kind: 'focus'; direction: Direction };

type KeyPress = Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'code'>;

const mac = navigator.platform.startsWith('Mac');

/**
 * What a key press asks of the window's panes: ⌘T a new tab in the focused pane, ⌘W close its tab, ⌘D split it beside
 * (⇧⌘D below), ⌘1–9 pick its tabs, ⌘⌥ and an arrow move to the pane that way. Off macOS the same with Ctrl+Shift, and
 * Ctrl+Shift+Alt+D below and Ctrl+Shift+Alt and an arrow, as Shift is already the chord's. Undefined for any other key.
 */
export function windowPaneKey(event: KeyPress, isMac = mac): WindowPaneKey | undefined {
  const direction = paneFocusShortcut(event, isMac);
  if (direction !== undefined) return { kind: 'focus', direction };
  const on = { isMac };
  if (pressed('window.splitBelow', event, on)) return { kind: 'split', direction: 'vertical' };
  if (pressed('window.newTab', event, on)) return { kind: 'newTab' };
  if (pressed('window.closeTab', event, on)) return { kind: 'close' };
  if (pressed('window.splitBeside', event, on)) return { kind: 'split', direction: 'horizontal' };
  const key = windowShortcut(event, isMac);
  const digit = key === undefined ? undefined : /^Digit([1-9])$/.exec(key)?.[1];
  return digit === undefined ? undefined : { kind: 'tab', digit: Number(digit) };
}

/** Whether a key press runs the agent's gate: ⌘⇧G on macOS, Ctrl+Shift+G elsewhere, where Ctrl+Shift is the window's chord. */
export function isRunGateKey(event: KeyPress, isMac = mac): boolean {
  return pressed('window.runGate', event, { isMac });
}

/** Run gate's shortcut as the platform writes it. */
export const runGateShortcut = (isMac = mac): string => keyText('window.runGate', isMac);

/** What the window says when the close key meets a tab that can't be closed: the tile's own, which is its agent or its shell's only tab. */
export const ownTabNotice = (owner: 'agent' | 'shell'): string => (owner === 'agent' ? "An agent's own tab can't be closed." : "A shell's only tab can't be closed.");
