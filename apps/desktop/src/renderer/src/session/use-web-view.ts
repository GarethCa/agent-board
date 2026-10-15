import { useEffect, useState, type RefObject } from 'react';
import type { WebTabBounds } from '../../../preload/api';
import { useTabDrag } from './shell-moves';
import { overlap, sameBounds, viewBounds } from './web-view-bounds';

/** What draws over a session window and must not be hidden by a web tab's page: menus, dialogs, popovers, pickers. */
const OVERLAYS = '[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]';

/** How far the pointer moves with a button held before it is a drag, which the page would otherwise take over. */
const DRAG_DISTANCE = 4;

/** The middle of a box. */
const middle = ({ x, y, width, height }: WebTabBounds) => ({ x: x + width / 2, y: y + height / 2 });

/**
 * Whether anything of the window is drawn over the tab's area at `bounds`, `host`, as the page is drawn over the whole
 * window and would hide it: a modal dialog anywhere (which hides the rest from assistive tech, the tab's window with
 * it), an overlay (a menu, a popover, a confirmation) that crosses the area in front of it, or anything else in front
 * of its middle, such as another session window. Its edges are left out: the window's own chrome (the details' handle,
 * a resize grip) sits on them by design.
 */
function covered(host: HTMLElement, bounds: WebTabBounds): boolean {
  if (host.closest('[aria-hidden="true"], [inert]') !== null) return true;
  const inFront = ({ x, y }: { x: number; y: number }) => {
    const top = document.elementFromPoint(x, y);
    return top !== null && !host.contains(top);
  };
  if (inFront(middle(bounds))) return true;
  for (const overlay of document.querySelectorAll(OVERLAYS)) {
    // The session window the tab is in is a dialog too.
    if (overlay.contains(host)) continue;
    const meet = overlap(overlay.getBoundingClientRect(), bounds);
    if (meet !== null && inFront(middle(meet))) return true;
  }
  return false;
}

/**
 * Whether something in the window is being dragged: a tab (between windows too), a pane's divider, the window's edge.
 * Pointer events over the page go to the page, so it hides meanwhile, leaving the drag and its drop targets the window's.
 */
function useDragging(): boolean {
  const tabDrag = useTabDrag();
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let from: { x: number; y: number } | undefined;
    const down = (event: PointerEvent) => (from = { x: event.clientX, y: event.clientY });
    const move = (event: PointerEvent) => {
      if (from !== undefined && event.buttons !== 0 && Math.hypot(event.clientX - from.x, event.clientY - from.y) > DRAG_DISTANCE) setDragging(true);
    };
    const up = () => {
      from = undefined;
      setDragging(false);
    };
    const start = () => setDragging(true);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('dragstart', start, true);
    window.addEventListener('dragend', up, true);
    window.addEventListener('drop', up, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('dragstart', start, true);
      window.removeEventListener('dragend', up, true);
      window.removeEventListener('drop', up, true);
    };
  }, []);
  return dragging || tabDrag !== undefined;
}

/**
 * Lays the tab's page over `host`, the tab's area, every frame while `showing`: as panes split, resize and move, the
 * window resizes, or an expanded tile pans with the board. It hides while the tab isn't showing, while something is
 * drawn over it (`covered`), and while something is dragged. Returns whether the page is drawn.
 */
export function useWebViewBounds(tabId: string, host: RefObject<HTMLElement | null>, showing: boolean): boolean {
  const dragging = useDragging();
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    let last: WebTabBounds | null | undefined;
    const place = (bounds: WebTabBounds | null) => {
      if (last !== undefined && sameBounds(last, bounds)) return;
      last = bounds;
      window.agentBoard.webTabs.setBounds(tabId, bounds);
      setDrawn(bounds !== null);
    };
    if (!showing || dragging) {
      place(null);
      return;
    }
    let frame = 0;
    const tick = () => {
      const element = host.current;
      const bounds = element === null ? null : viewBounds(element.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
      place(bounds === null || covered(element!, bounds) ? null : bounds);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      place(null);
    };
  }, [tabId, host, showing, dragging]);
  return drawn;
}
