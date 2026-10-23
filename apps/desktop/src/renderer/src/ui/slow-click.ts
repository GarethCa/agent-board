import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';
import type { Renaming } from './EditableName';

// Finder-style rename: a click on the name of a tile that was already selected, then a pause, starts the rename. Pure (the
// timer is the only effect), so the rules are unit-tested with fake timers.

/** How long a still click on a selected tile's name waits for a second click before it starts the rename. */
export const SLOW_CLICK_MS = 600;
/** How far the pointer may move between press and release for it to count as a click, not the start of a drag. */
export const SLOW_CLICK_SLOP_PX = 4;

interface Point {
  x: number;
  y: number;
}

export interface SlowClick {
  /** A press on the name. Only one that finds the tile already selected can lead to a rename; any press ends a pending one. */
  down(at: Point, wasSelected: boolean): void;
  /** The click that follows the press: starts the wait, unless the pointer moved (a drag) in between. */
  click(at: Point): void;
  /** Forgets a press or a wait under way (the tile was deselected, or went). */
  cancel(): void;
}

/** Calls `cancel` on the next press or key anywhere, and returns how to stop listening: what a wait under way listens with. */
export type Watch = (cancel: () => void) => () => void;

/** Any press or key in the window, not only on the name, ends the wait (as in Finder): Enter, a button or a double-click straddling the title. */
const watchDocument: Watch = (cancel) => {
  const events = ['pointerdown', 'keydown', 'dblclick', 'wheel'] as const;
  for (const type of events) document.addEventListener(type, cancel, true);
  return () => {
    for (const type of events) document.removeEventListener(type, cancel, true);
  };
};

/** The rules of the slow click: `start` runs once `delayMs` has passed after a still click on an already-selected name. */
export function createSlowClick(start: () => void, delayMs = SLOW_CLICK_MS, watch?: Watch): SlowClick {
  let pressed: Point | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unwatch: (() => void) | undefined;
  const cancel = () => {
    pressed = undefined;
    clearTimeout(timer);
    timer = undefined;
    unwatch?.();
    unwatch = undefined;
  };
  return {
    down(at, wasSelected) {
      // A second press inside the wait is a double-click, which opens the tile.
      cancel();
      if (wasSelected) pressed = at;
    },
    click(at) {
      const from = pressed;
      pressed = undefined;
      if (from === undefined || Math.hypot(at.x - from.x, at.y - from.y) > SLOW_CLICK_SLOP_PX) return;
      timer = setTimeout(() => {
        cancel();
        start();
      }, delayMs);
      unwatch = watch?.(cancel);
    },
    cancel,
  };
}

/** The handlers a name takes to rename on a slow click. */
export interface NameClicks {
  onPointerDownCapture(event: PointerEvent): void;
  onClick(event: MouseEvent): void;
  /** Fires after the second click of a pair, which has already waited again: it ends that wait, and the tile opens. */
  onDoubleClick(): void;
}

/** The handlers of a name for `rules`; `read` says whether the tile is selected as the press lands, before that press can select it. */
export function nameClicks(rules: SlowClick, read: () => boolean): NameClicks {
  return {
    onPointerDownCapture: (event) =>
      rules.down({ x: event.clientX, y: event.clientY }, read() && event.button === 0 && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey),
    onClick: (event) => rules.click({ x: event.clientX, y: event.clientY }),
    onDoubleClick: () => rules.cancel(),
  };
}

/**
 * Renaming by a click on the name of a tile that is `selected` (the only thing selected) and a pause, as in Finder. `selected`
 * is read as the press lands, before that press can select the tile.
 */
export function useSlowClickRename(renaming: Renaming, selected: boolean): NameClicks {
  const latest = useRef({ renaming, selected });
  latest.current = { renaming, selected };
  const rules = useRef<SlowClick | undefined>(undefined);
  rules.current ??= createSlowClick(
    () => {
      if (!latest.current.renaming.editing) latest.current.renaming.start();
    },
    SLOW_CLICK_MS,
    watchDocument,
  );
  useEffect(() => {
    if (!selected) rules.current!.cancel();
  }, [selected]);
  useEffect(() => () => rules.current!.cancel(), []);
  return nameClicks(rules.current, () => latest.current.selected);
}
