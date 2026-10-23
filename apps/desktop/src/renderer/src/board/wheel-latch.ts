// A scroll gesture belongs to the surface it started on. React Flow checks `nowheel` on every wheel event's target, so a
// two-finger pan (and its momentum) that started on the bare board stopped dead when the pointer, or the board moving under
// it, reached a terminal or a note. The latch fixes the owner at the gesture's first event and holds it until the stream
// goes quiet. The decisions are pure, so the rules are unit-tested.
//
// The cost of timing alone: Chromium reports no wheel phase, so a new scroll that starts over a surface while the board's
// momentum is still running (less than the quiet gap after its last event) joins the board's gesture and pans the board
// until the user pauses.

/** How long without a wheel event ends a gesture; long enough to span the gaps in a trackpad's momentum. */
export const GESTURE_QUIET_MS = 150;

/** The surface (a terminal, a note) a gesture started on, or `null` for the bare board. */
export type Surface = object | null;

/** The surface that owns a gesture, fixed at its first event. */
export interface WheelLatch {
  owner(event: { time: number; surface: Surface }): Surface;
}

/** Stands for a surface that has been collected mid-gesture: nothing under the pointer is it, so its events are dropped. */
const GONE = {};

export function createWheelLatch(quietMs = GESTURE_QUIET_MS): WheelLatch {
  // Weakly, so a tile collapsed or a terminal closed does not stay in memory until the next scroll.
  let held: WeakRef<object> | null = null;
  let last = -Infinity;
  return {
    owner({ time, surface }) {
      if (time - last > quietMs) held = surface === null ? null : new WeakRef(surface);
      last = time;
      return held === null ? null : (held.deref() ?? GONE);
    },
  };
}

/** What to do with a wheel event: leave it to the page, move it to the board's pan layer, or swallow it. */
export type WheelRoute = 'pass' | 'redispatch' | 'drop';

/**
 * Routes one wheel event. `zoom` is a pinch or the zoom key (the command key on macOS, Control elsewhere): React Flow
 * and the terminal's font size read it themselves, so it is left alone. `owner` is the gesture's surface and `surface`
 * the one under the pointer now. A board-owned event over a surface goes to the pan layer, so it pans and the surface
 * does not scroll; a surface-owned event anywhere but that surface is dropped, so it neither pans nor scrolls another.
 * Surfaces nest (an expanded tile's body holds its terminal): the innermost is the surface, so a scroll that crosses
 * between them is dropped too, until the stream goes quiet.
 */
export function routeWheel({ zoom, owner, surface }: { zoom: boolean; owner: Surface; surface: Surface }): WheelRoute {
  if (zoom) return 'pass';
  if (owner === null) return surface === null ? 'pass' : 'redispatch';
  return surface === owner ? 'pass' : 'drop';
}

/** The `nowheel` element a target is inside, if any. */
const surfaceOf = (target: Element): Surface => target.closest('.nowheel');

/**
 * Routes the wheel events inside `root`, which holds React Flow's `.react-flow__renderer`: where the latch's routing says
 * redispatch, the event is stopped and sent again with the renderer, which has no `nowheel`, as its target. Returns the
 * function that removes the listener.
 */
export function installWheelLatch(root: HTMLElement, zoomKey: 'Meta' | 'Control', now: () => number = () => performance.now()): () => void {
  const latch = createWheelLatch();
  let redispatching = false;
  const onWheel = (event: WheelEvent) => {
    const renderer = root.querySelector('.react-flow__renderer');
    if (redispatching || renderer === null || !(event.target instanceof Element) || !renderer.contains(event.target)) return;
    const zoom = event.ctrlKey || (zoomKey === 'Meta' && event.metaKey);
    const surface = surfaceOf(event.target);
    // A zoom is no part of a scroll gesture: it neither starts one nor extends one.
    const route = routeWheel({ zoom, owner: zoom ? null : latch.owner({ time: now(), surface }), surface });
    if (route === 'pass') return;
    event.preventDefault();
    event.stopPropagation();
    if (route === 'redispatch') {
      redispatching = true;
      try {
        renderer.dispatchEvent(new WheelEvent('wheel', event));
      } finally {
        redispatching = false;
      }
    }
  };
  root.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => root.removeEventListener('wheel', onWheel, { capture: true });
}
