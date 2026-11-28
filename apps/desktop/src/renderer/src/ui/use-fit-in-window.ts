import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type RefObject } from 'react';
import { fitInWindow, windowRoom } from './placement';

interface Offset {
  x: number;
  y: number;
}

const NONE: Offset = { x: 0, y: 0 };

/**
 * Keeps a card Radix places beside its button (a menu or popover) wholly inside the window and clear of the traffic
 * lights: from the moment it opens, as the window is resized, and as its button moves under it (the board panned or
 * zoomed). Radix places it; this moves it in from there by `translate`, which stacks on Radix's own placing, only as
 * far as it must. `handle` lets it be dragged too, by whatever it is spread on: a drag moves it from where Radix placed
 * it, and it is still kept inside wherever it is dragged.
 */
export function useFitInWindow(card: RefObject<HTMLElement | null>) {
  const [applied, setApplied] = useState<Offset>(NONE);
  const [dragging, setDragging] = useState(false);
  /** Where the user dragged it to, from where Radix placed it. */
  const wanted = useRef<Offset>(NONE);
  /** How far it is moved now: `wanted`, as near as fits. */
  const current = useRef<Offset>(NONE);
  const start = useRef<{ pointerX: number; pointerY: number; offset: Offset } | undefined>(undefined);

  const fit = useCallback(() => {
    const element = card.current;
    // Until Radix has placed it, its wrapper holds it out of sight, and there is nothing to fit yet.
    if (element === null || !placed(element)) return;
    const box = element.getBoundingClientRect();
    const placedX = box.left - current.current.x;
    const placedY = box.top - current.current.y;
    const at = fitInWindow({ x: placedX + wanted.current.x, y: placedY + wanted.current.y, width: box.width, height: box.height }, windowRoom());
    const next = { x: Math.round(at.x - placedX), y: Math.round(at.y - placedY) };
    if (next.x === current.current.x && next.y === current.current.y) return;
    current.current = next;
    setApplied(next);
  }, [card]);

  useEffect(() => {
    fit();
    window.addEventListener('resize', fit);
    // Radix moves the card by its wrapper's style as it places it and as its button moves; and the card's own size
    // changes as what it shows does.
    const element = card.current;
    const moved = new MutationObserver(fit);
    const resized = new ResizeObserver(fit);
    if (element !== null) {
      if (element.parentElement !== null) moved.observe(element.parentElement, { attributes: true, attributeFilter: ['style'] });
      resized.observe(element);
    }
    return () => {
      window.removeEventListener('resize', fit);
      moved.disconnect();
      resized.disconnect();
    };
  }, [fit, card]);

  const handle = {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      // From where it is now, which may already be moved in from an edge.
      wanted.current = current.current;
      start.current = { pointerX: event.clientX, pointerY: event.clientY, offset: current.current };
      setDragging(true);
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const from = start.current;
      if (from === undefined) return;
      event.stopPropagation();
      wanted.current = { x: from.offset.x + event.clientX - from.pointerX, y: from.offset.y + event.clientY - from.pointerY };
      fit();
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      if (start.current === undefined) return;
      start.current = undefined;
      // Kept where it ended up, so a later fit does not pull it toward where it was dragged past an edge.
      wanted.current = current.current;
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel() {
      start.current = undefined;
      wanted.current = current.current;
      setDragging(false);
    },
  };

  const style: CSSProperties | undefined = applied.x === 0 && applied.y === 0 ? undefined : { translate: `${applied.x}px ${applied.y}px` };
  return { handle, style, dragging };
}

/** Whether Radix has placed the card: until it has, its wrapper holds it above the window (`translate(0, -200%)`). */
function placed(card: HTMLElement): boolean {
  return !(card.parentElement?.style.transform ?? '').includes('-200%');
}
