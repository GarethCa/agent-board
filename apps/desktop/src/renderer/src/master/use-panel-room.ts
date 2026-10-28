import { useLayoutEffect, useState, type RefObject } from 'react';
import { tokenNumber } from '../theme';

export interface PanelRoom {
  /** The board's width, 0 until measured. */
  board: number;
  /** What the rest of the bottom row takes beside the panel, in px. */
  taken: number;
}

/**
 * The board the panel is docked on and what its bottom row needs besides the panel: the zoom bar (which sits left of
 * it), the zones pill and the dock at their least, their gaps, and the Edge rules panel when it is open, which the
 * panel sits beside. Measured again when the board, the zoom bar or those panels change, so the width stays one the
 * bottom row fits beside.
 */
export function usePanelRoom(panel: RefObject<HTMLElement | null>): PanelRoom {
  const [room, setRoom] = useState<PanelRoom>({ board: 0, taken: 0 });
  useLayoutEffect(() => {
    const parent = panel.current?.parentElement;
    if (!parent) return;
    const inset = tokenNumber('--island-inset');
    const measure = () => {
      const zoom = parent.querySelector<HTMLElement>('.island-bottom-right')?.offsetWidth ?? 0;
      const edge = parent.querySelector<HTMLElement>('.edge-rules') === null ? 0 : inset + tokenNumber('--size-edge-rules');
      const taken = 3 * inset + edge + zoom + tokenNumber('--size-zones-min') + tokenNumber('--size-dock-min') + 2 * tokenNumber('--size-dock-gap');
      setRoom((was) => (was.board === parent.clientWidth && was.taken === taken ? was : { board: parent.clientWidth, taken }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    const zoom = parent.querySelector('.island-bottom-right');
    if (zoom) observer.observe(zoom);
    // Edge rules comes and goes with the selected edge.
    const changed = new MutationObserver(measure);
    changed.observe(parent, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      changed.disconnect();
    };
  }, [panel]);
  return room;
}
