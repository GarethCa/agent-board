import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from 'react';
import {
  chosenDetailsWidth,
  DEFAULT_DETAILS_WIDTH,
  detailsAfterDrag,
  detailsAfterKey,
  maxDetailsWidth,
  MIN_DETAILS_WIDTH,
  onDetailsWidth,
  setDetailsWidth,
  type DetailsSize,
} from './details-width';

/** The strip's chosen width, live across every window of the app. */
export function useDetailsWidth(): number {
  return useSyncExternalStore(onDetailsWidth, chosenDetailsWidth, () => DEFAULT_DETAILS_WIDTH);
}

/** The icon rail's width, which `--size-rail` sets: the handle's value while the strip is collapsed. */
const RAIL_WIDTH = 54;

/**
 * The drag handle on the border between a session's details strip and its terminal: drag it to resize the
 * strip, below its minimum to collapse it to the icon rail, and out from the rail to open it again; arrow keys step it
 * and a double-click resets it. The width is one preference for every window, so the terminal beside it just refits
 * (throttled) when its element changes size. Placed in the body, right after the strip.
 */
export function DetailsHandle({ collapsed, onCollapsed }: { collapsed: boolean; onCollapsed(collapsed: boolean): void }) {
  const width = useDetailsWidth();
  const handle = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // How far the pointer is from the strip's edge where it took hold, so the edge follows it without a jump.
  const grab = useRef(0);
  // The body's width as it was laid out, which a board's zoom scales on screen: the limits are in its own pixels.
  const bodyWidth = () => handle.current?.parentElement?.offsetWidth ?? 0;
  const [max, setMax] = useState(() => maxDetailsWidth(0));
  useEffect(() => {
    const body = handle.current?.parentElement;
    if (!body) return;
    const observer = new ResizeObserver(() => setMax(maxDetailsWidth(body.offsetWidth)));
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  const apply = (size: DetailsSize) => {
    if (size.collapsed) {
      if (!collapsed) onCollapsed(true);
      return;
    }
    setDetailsWidth(size.width);
    if (collapsed) onCollapsed(false);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const body = event.currentTarget.parentElement;
    if (event.button !== 0 || !body) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const edge = event.currentTarget.previousElementSibling as HTMLElement | null;
    const box = body.getBoundingClientRect();
    grab.current = body.offsetWidth > 0 ? (event.clientX - box.left) / (box.width / body.offsetWidth) - (edge?.offsetWidth ?? 0) : 0;
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const body = event.currentTarget.parentElement;
    if (!dragging || !body) return;
    const box = body.getBoundingClientRect();
    const scale = body.offsetWidth > 0 ? box.width / body.offsetWidth : 1;
    apply(detailsAfterDrag((event.clientX - box.left) / scale - grab.current, body.offsetWidth));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const size = detailsAfterKey(event.key, width, collapsed, bodyWidth());
    if (!size) return;
    event.preventDefault();
    apply(size);
  };

  return (
    <div
      ref={handle}
      className="session-details-handle"
      data-testid="details-handle"
      data-dragging={dragging || undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize details"
      aria-valuemin={collapsed ? RAIL_WIDTH : MIN_DETAILS_WIDTH}
      aria-valuemax={max}
      aria-valuenow={collapsed ? RAIL_WIDTH : Math.min(width, max)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={() => {
        setDetailsWidth(undefined);
        if (collapsed) onCollapsed(false);
      }}
      onKeyDown={onKeyDown}
    />
  );
}
