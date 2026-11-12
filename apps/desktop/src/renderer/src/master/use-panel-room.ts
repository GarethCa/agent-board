import { useLayoutEffect, useState, type RefObject } from 'react';
import { tokenNumber } from '../theme';

export interface PanelRoom {
  /** The board's width, 0 until measured. */
  board: number;
  /** What the Edge rules panel and its margin take, in px, and an inset. */
  taken: number;
  /** How far above the board's bottom inset the zoom bar's top is, or the minimap's when it shows, plus a gap: where the panel's bottom goes. */
  lift: number;
  /** The board's height, 0 until measured. */
  height: number;
}

/**
 * The board the panel is docked on, where its bottom goes when it covers the board (the snap position a gap above the zoom bar and the minimap, whatever size they are, which it overlays by default) and what Edge rules takes when it is
 * open, which sits left of the panel: its width and its margin. Measured again when the board or the Edge rules panel changes. The board is measured whole, the room the
 * panel pushes it in by included, so what the panel does to it never feeds back into it.
 */
export function usePanelRoom(panel: RefObject<HTMLElement | null>): PanelRoom {
  const [room, setRoom] = useState<PanelRoom>({ board: 0, taken: 0, lift: 0, height: 0 });
  useLayoutEffect(() => {
    const parent = panel.current?.parentElement;
    if (!parent) return;
    const inset = tokenNumber('--island-inset');
    const measure = () => {
      const edge = parent.querySelector<HTMLElement>('.edge-rules') === null ? 0 : inset + tokenNumber('--size-edge-rules');
      const taken = inset + edge;
      const top = Math.min(...[...parent.querySelectorAll<HTMLElement>('.island-bottom-right, .board-minimap')].map((thing) => thing.getBoundingClientRect().top));
      const lift = Number.isFinite(top) ? Math.round(parent.getBoundingClientRect().bottom - top + tokenNumber('--size-dock-gap') - inset) : 0;
      setRoom((was) => (was.board === parent.clientWidth && was.taken === taken && was.lift === lift && was.height === parent.clientHeight ? was : { board: parent.clientWidth, taken, lift, height: parent.clientHeight }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    // The zoom bar and the minimap are watched as they come and go (the minimap's switch, the usage pill), so the lift follows their real size.
    const watched = new Set<Element>();
    const watch = () => {
      const present = new Set(parent.querySelectorAll('.island-bottom-right, .board-minimap'));
      // What the minimap's switch removed is let go.
      for (const thing of watched) {
        if (present.has(thing)) continue;
        observer.unobserve(thing);
        watched.delete(thing);
      }
      for (const thing of present) {
        if (watched.has(thing)) continue;
        watched.add(thing);
        observer.observe(thing);
      }
      measure();
    };
    watch();
    // Edge rules comes and goes with the selected edge.
    const changed = new MutationObserver(watch);
    changed.observe(parent, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      changed.disconnect();
    };
  }, [panel]);
  return room;
}
