// Where a web tab's page is drawn over its window (BI2), and where an overlay crosses it. Pure.
import type { WebTabBounds } from '../../../preload/api';

/**
 * The part of the tab's area (`rect`, as the page lays it out) inside the window's `viewport`, in whole pixels: where
 * its page is drawn. Null when none of it is, or it has no size, as a tab not showing has.
 */
export function viewBounds(rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, viewport: { width: number; height: number }): WebTabBounds | null {
  const left = Math.max(0, Math.round(rect.left));
  const top = Math.max(0, Math.round(rect.top));
  const right = Math.min(viewport.width, Math.round(rect.left + rect.width));
  const bottom = Math.min(viewport.height, Math.round(rect.top + rect.height));
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

export const sameBounds = (a: WebTabBounds | null, b: WebTabBounds | null): boolean =>
  a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

/** Where `box` (an overlay's, as the page lays it out) and the page's area meet, if they do. */
export function overlap(box: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>, bounds: WebTabBounds): WebTabBounds | null {
  const left = Math.max(box.left, bounds.x);
  const top = Math.max(box.top, bounds.y);
  const right = Math.min(box.right, bounds.x + bounds.width);
  const bottom = Math.min(box.bottom, bounds.y + bounds.height);
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}
