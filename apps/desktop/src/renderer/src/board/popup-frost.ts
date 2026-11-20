// Whether the board behind an agent's pop-up is frosted (blurred as well as dimmed) or only dimmed: one choice for the
// app, picked in Settings › General › Appearance and heard by every window. On unless turned off.

import { useSyncExternalStore } from 'react';
import { storedValue } from '../stored-value';

/** Where the choice is kept: 'off' for plain dimming, nothing for the frost. */
const POPUP_FROST_KEY = 'agent-board.popup-frost';

const stored = storedValue(POPUP_FROST_KEY);

/** Frosted, unless the stored value turns it off. */
export function popupFrostOf(value: string | undefined): boolean {
  return value !== 'off';
}

/** Frosts the board behind every pop-up, or only dims it. */
export function setPopupFrost(on: boolean): void {
  stored.set(on ? undefined : 'off');
}

/** Whether the board behind a pop-up is frosted, kept current as it is picked here or in another window. */
export function usePopupFrost(): boolean {
  return useSyncExternalStore(stored.subscribe, () => popupFrostOf(stored.get()), () => true);
}
