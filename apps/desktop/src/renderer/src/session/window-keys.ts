// A session window's own keys for its panes and tabs, read from a key press. Pure, so both platforms are tested.
import type { SplitDirection } from '@agent-board/daemon/pane-layout';
import { paneFocusShortcut, windowShortcut } from '../keys';
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
  if (!isMac && event.code === 'KeyD' && event.ctrlKey && event.shiftKey && event.altKey && !event.metaKey) return { kind: 'split', direction: 'vertical' };
  const key = windowShortcut(event, isMac);
  if (key === 'KeyT') return { kind: 'newTab' };
  if (key === 'KeyW') return { kind: 'close' };
  if (key === 'KeyD') return { kind: 'split', direction: 'horizontal' };
  if (key === 'Shift+KeyD') return { kind: 'split', direction: 'vertical' };
  const digit = key === undefined ? undefined : /^Digit([1-9])$/.exec(key)?.[1];
  return digit === undefined ? undefined : { kind: 'tab', digit: Number(digit) };
}

/** Whether a key press runs the agent's gate: ⌘⇧G on macOS, Ctrl+Shift+G elsewhere, where Ctrl+Shift is the window's chord. */
export function isRunGateKey(event: KeyPress, isMac = mac): boolean {
  return windowShortcut(event, isMac) === (isMac ? 'Shift+KeyG' : 'KeyG');
}

/** Run gate's shortcut as the platform writes it. */
export const runGateShortcut = (isMac = mac): string => (isMac ? '⌘⇧G' : 'Ctrl+Shift+G');
