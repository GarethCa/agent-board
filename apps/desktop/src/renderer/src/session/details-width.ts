// The width of the session details strip, one preference for every session window, pop-out and expanded tile: dragged
// on the handle between the strip and the terminal, or stepped with the arrow keys; double-click resets it.

import { storedValue } from '../stored-value';

export const MIN_DETAILS_WIDTH = 200;
/** The strip's width until one is chosen; the same as `--size-details`. */
export const DEFAULT_DETAILS_WIDTH = 316;
/** What an arrow key adds or takes away. */
const DETAILS_KEY_STEP = 16;
/** The most of its window the strip takes. */
const MAX_FRACTION = 0.5;

const stored = storedValue('agent-board.details-width');

/** What the strip is after a drag or key: collapsed to its icon rail, or open at a width. */
export type DetailsSize = { collapsed: true } | { collapsed: false; width: number };

/** The widest the strip goes in a window this wide. */
export function maxDetailsWidth(windowWidth: number): number {
  return Math.max(MIN_DETAILS_WIDTH, Math.floor(windowWidth * MAX_FRACTION));
}

/** The width clamped to the limits, or the default if it isn't a number. */
export function clampDetailsWidth(width: number, windowWidth: number): number {
  if (!Number.isFinite(width)) return DEFAULT_DETAILS_WIDTH;
  return Math.min(maxDetailsWidth(windowWidth), Math.max(MIN_DETAILS_WIDTH, width));
}

/** Where a drag to this width leaves the strip: pulled below the minimum it snaps to the rail. */
export function detailsAfterDrag(width: number, windowWidth: number): DetailsSize {
  if (width < MIN_DETAILS_WIDTH) return { collapsed: true };
  return { collapsed: false, width: clampDetailsWidth(width, windowWidth) };
}

/** What an arrow key does to the strip, if the key is one: right widens (and opens the rail), left narrows. */
export function detailsAfterKey(key: string, width: number, collapsed: boolean, windowWidth: number): DetailsSize | undefined {
  if (key === 'ArrowRight') return collapsed ? { collapsed: false, width: MIN_DETAILS_WIDTH } : detailsAfterDrag(width + DETAILS_KEY_STEP, windowWidth);
  // A step stops at the minimum; the next one collapses.
  if (key === 'ArrowLeft' && !collapsed) return width <= MIN_DETAILS_WIDTH ? { collapsed: true } : { collapsed: false, width: Math.max(MIN_DETAILS_WIDTH, width - DETAILS_KEY_STEP) };
  return undefined;
}

/** The chosen width, or the default while none is. */
export function chosenDetailsWidth(): number {
  const width = Number(stored.get());
  return width >= MIN_DETAILS_WIDTH ? width : DEFAULT_DETAILS_WIDTH;
}

/** Sets the width (undefined resets it to the default) and tells every strip. */
export function setDetailsWidth(width: number | undefined): void {
  stored.set(width === undefined ? undefined : String(Math.max(MIN_DETAILS_WIDTH, Math.round(width))));
}

/** Hears every change of width, here or in another window of the app; returns how to stop. */
export const onDetailsWidth = stored.subscribe;
