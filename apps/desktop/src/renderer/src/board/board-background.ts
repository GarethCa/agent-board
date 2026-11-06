// How the board's desk is drawn behind everything: one choice for the app, picked in Settings › General › Appearance
// and heard by every window. Each is a CSS pattern (app.css, `[data-board-background]`), so panning and zooming only
// move a background position and size; none is an image.

import { useSyncExternalStore } from 'react';
import { storedValue } from '../stored-value';

/** The desk as the design draws it, then the others. */
export const BOARD_BACKGROUNDS = ['standard', 'fine-dots', 'large-dots', 'lines', 'isometric', 'vignette', 'plain'] as const;
export type BoardBackground = (typeof BOARD_BACKGROUNDS)[number];

export const DEFAULT_BOARD_BACKGROUND: BoardBackground = 'standard';

/** Each background's name and the line under it, as Settings shows them. */
export const BOARD_BACKGROUND_LABELS: Record<BoardBackground, { name: string; hint: string }> = {
  standard: { name: 'Standard', hint: 'Dots under Classic, plain under the Simplified design.' },
  'fine-dots': { name: 'Fine dots', hint: 'A closer grid of small dots, twice as close as the snap grid.' },
  'large-dots': { name: 'Large dots', hint: 'A wider grid of bigger dots, every other snap point.' },
  lines: { name: 'Lines', hint: 'A square grid of hairlines, one to each step of the snap grid.' },
  isometric: { name: 'Isometric', hint: 'Dots on a triangular grid. Tiles still snap to the square grid.' },
  vignette: { name: 'Vignette', hint: 'Plain, softly darker towards the edges, in light and dark.' },
  plain: { name: 'Plain', hint: 'Just the desk colour.' },
};

/** Backgrounds that sit still while the board pans and zooms; the rest are patterns that move with it. */
export const STILL_BACKGROUNDS: readonly BoardBackground[] = ['vignette', 'plain'];

/** Below this zoom a moving pattern's cells are too small to read and only cost paint, so it is left out. */
export const LEAST_PATTERN_ZOOM = 0.3;

const stored = storedValue('agent-board.board-background');

/** The stored background, or the default for none or one this version doesn't know. */
export function boardBackgroundOf(value: string | undefined): BoardBackground {
  return BOARD_BACKGROUNDS.find((each) => each === value) ?? DEFAULT_BOARD_BACKGROUND;
}

/** Picks the desk for every board, in every window. */
export function setBoardBackground(background: BoardBackground): void {
  stored.set(background);
}

/** The chosen desk, kept current as it is picked here or in another window. */
export function useBoardBackground(): BoardBackground {
  return useSyncExternalStore(stored.subscribe, () => boardBackgroundOf(stored.get()), () => DEFAULT_BOARD_BACKGROUND);
}
