// How the Simplified design draws each agent's status, one choice for the app: picked in Settings › General › Design,
// and heard by every window.

import { useSyncExternalStore } from 'react';
import { storedValue } from '../stored-value';

/** A glyph beside the status's word, or the orange character acting it out, the word still beside it. */
export const STATUS_LOOKS = ['icons', 'characters'] as const;
export type StatusLook = (typeof STATUS_LOOKS)[number];

const DEFAULT_STATUS_LOOK: StatusLook = 'icons';

/** Each look's name, as Settings shows it. */
export const STATUS_LOOK_LABELS: Record<StatusLook, string> = { icons: 'Icons and words', characters: 'Characters' };

const stored = storedValue('agent-board.status-look');

/** The stored look, or the default for none or one this version doesn't know. */
export function statusLookOf(value: string | undefined): StatusLook {
  return STATUS_LOOKS.find((look) => look === value) ?? DEFAULT_STATUS_LOOK;
}

/** Picks the look for every status mark, in every window. */
export function setStatusLook(look: StatusLook): void {
  stored.set(look);
}

/** The chosen look, kept current as it is picked here or in another window. */
export function useStatusLook(): StatusLook {
  return useSyncExternalStore(stored.subscribe, () => statusLookOf(stored.get()), () => DEFAULT_STATUS_LOOK);
}
