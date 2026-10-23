// Items that grow to fit their text (shapes, agent notes): taller as text is written, never cut off.
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { OnResizeEnd } from '@xyflow/react';

const watchFocus = (notify: () => void) => {
  window.addEventListener('focus', notify);
  window.addEventListener('blur', notify);
  return () => {
    window.removeEventListener('focus', notify);
    window.removeEventListener('blur', notify);
  };
};

/**
 * Whether this window is the one in front. An item that needs to grow is looked at again when it becomes so: growth no
 * one asked for is saved by the window in front, once for all.
 */
export const useWindowFocused = () => useSyncExternalStore(watchFocus, () => document.hasFocus());

/**
 * Makes an item tall enough for its text, so what is written is never cut off. It only grows: an item the user made
 * taller keeps its height. `fits` measures the height its text needs, `height` tall, or 0 if it can't; `deps` are what
 * the text's wrapping depends on. Not while `paused`, as during a resize drag, which is the user's to size (its end
 * checks the fit).
 */
export function useGrowToFit(fits: (height: number) => number, height: number, paused: boolean, grow: (height: number) => void, deps: unknown[]) {
  useLayoutEffect(() => {
    if (paused) return;
    const needs = fits(height);
    // A pixel of slack: the two heights it is measured from are rounded.
    if (needs > height + 1) grow(needs);
  }, [height, paused, ...deps]);
}

/**
 * A resize of an item that fits its text, for its `NodeResizer`: `paused` while the drag goes, for `useGrowToFit`. Dragged
 * shorter than its text needs (`fits`, at a height), it keeps what the text needs; from the top edge, it is the bottom
 * that stays where it was, so the top moves up to make room. `save` is given the box it ends at; `top` is where its top
 * is saved now.
 */
export function useFitResize(fits: (height: number) => number, top: number, save: (box: { x: number; y: number; width: number; height: number }) => void) {
  // Whether a drag is going, and where the top was when it began (the board follows the drag as it goes). A ref, read
  // as it is drawn: the drag redraws the item at every step, so each of those draws sees it set and growing waits. It
  // must not draw anything itself as it clears: a draw then, at the dragged height and before the box the end saves has
  // come back, would grow the item from where it was before the drag. The saved box fits its text, so nothing is missed.
  const resizing = useRef(false);
  const topAtStart = useRef(0);
  const onResizeEnd: OnResizeEnd = (_event, { x, y, width, height }) => {
    resizing.current = false;
    const fitted = Math.max(height, fits(height));
    save({ x, y: Math.abs(y - topAtStart.current) < 0.5 ? y : y + height - fitted, width, height: fitted });
  };
  return {
    paused: resizing.current,
    onResizeStart: () => {
      resizing.current = true;
      topAtStart.current = top;
    },
    onResizeEnd,
  };
}
