// Whether an agent's pop-up fills a wide screen or stops at the cap's width, centred (popup-size.ts): one choice for the
// app, picked in Settings › General › Appearance or with the pop-up header's fill button, and heard by every window.
// Off unless turned on.

import { useSyncExternalStore } from 'react';
import { storedValue } from '../stored-value';

/** Where the choice is kept: 'on' to fill the screen, nothing to stop at the cap. */
const POPUP_FILL_KEY = 'agent-board.popup-fill';

const stored = storedValue(POPUP_FILL_KEY);

/** Fills the screen only when the stored value turns it on. */
export function popupFillOf(value: string | undefined): boolean {
  return value === 'on';
}

/** Makes every pop-up fill a wide screen, or stop at the cap. */
export function setPopupFill(on: boolean): void {
  stored.set(on ? 'on' : undefined);
}

/** Whether a pop-up fills a wide screen, kept current as it is picked here or in another window. */
export function usePopupFill(): boolean {
  return useSyncExternalStore(stored.subscribe, () => popupFillOf(stored.get()), () => false);
}
