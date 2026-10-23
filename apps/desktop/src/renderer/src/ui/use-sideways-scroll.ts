import { useEffect, type RefObject } from 'react';

/**
 * Makes a row of pills scroll sideways: a mouse wheel's vertical turn scrolls it (a trackpad's and shift-wheel's
 * sideways ones already do), and `data-more` on the track's parent says which edges have more past them (`start`,
 * `end`, `both` or `none`), for the fades. It is looked at again when the track or any of its pills changes size, or
 * pills come or go.
 * `active` is false while the track is not drawn.
 */
export function useSidewaysScroll(track: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const element = track.current;
    const host = element?.parentElement;
    if (!element || !host) return;
    const mark = () => {
      const [before, after] = [element.scrollLeft > 1, element.scrollLeft + element.clientWidth < element.scrollWidth - 1];
      host.dataset.more = before && after ? 'both' : before ? 'start' : after ? 'end' : 'none';
    };
    const wheel = (event: WheelEvent) => {
      if (event.deltaX !== 0 || event.deltaY === 0 || element.scrollWidth <= element.clientWidth) return;
      event.preventDefault();
      element.scrollLeft += event.deltaY;
    };
    mark();
    element.addEventListener('scroll', mark, { passive: true });
    element.addEventListener('wheel', wheel, { passive: false });
    // The track's own size, and each pill's: a rename can push the pills past an edge without resizing the track.
    const resized = new ResizeObserver(mark);
    const watched = new Set<Element>();
    const watch = () => {
      for (const child of watched) {
        if (child.isConnected) continue;
        watched.delete(child);
        resized.unobserve(child);
      }
      for (const child of element.children) {
        if (watched.has(child)) continue;
        watched.add(child);
        resized.observe(child);
      }
      mark();
    };
    resized.observe(element);
    const changed = new MutationObserver(watch);
    changed.observe(element, { childList: true });
    watch();
    return () => {
      element.removeEventListener('scroll', mark);
      element.removeEventListener('wheel', wheel);
      resized.disconnect();
      changed.disconnect();
    };
  }, [track, active]);
}
