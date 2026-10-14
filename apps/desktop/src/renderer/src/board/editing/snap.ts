// Snapping a dragged selection: to the edges and centres of what is near, as on Miro, or to the grid.

import type { Rect } from '../../geometry';

/**
 * An alignment guide on the board: a vertical line at x = `at` (axis `x`), or a horizontal one at y = `at` (axis `y`),
 * running from `from` to `to` along the other axis.
 */
export interface Guide {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
}

/** The box round `rects`, or undefined for none. */
export function boundsOf(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  return {
    x: left,
    y: top,
    width: Math.max(...rects.map((rect) => rect.x + rect.width)) - left,
    height: Math.max(...rects.map((rect) => rect.y + rect.height)) - top,
  };
}

/** Lines are the same if this close, in board units: snapped positions are sums of floats. */
const EPSILON = 0.5;

/** A rect's lines along an axis: its near edge, its centre and its far edge. */
const linesOf = (rect: Rect, axis: 'x' | 'y') =>
  axis === 'x' ? [rect.x, rect.x + rect.width / 2, rect.x + rect.width] : [rect.y, rect.y + rect.height / 2, rect.y + rect.height];

/** A rect's extent along the axis a guide on `axis` runs. */
const spanOf = (rect: Rect, axis: 'x' | 'y') => (axis === 'x' ? [rect.y, rect.y + rect.height] : [rect.x, rect.x + rect.width]);

/** How far `moving` must go along `axis` for one of its lines to meet the nearest line of `others`, within `threshold`. */
function nearestShift(moving: Rect, others: readonly Rect[], axis: 'x' | 'y', threshold: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (const line of linesOf(moving, axis)) {
    for (const other of others) {
      for (const target of linesOf(other, axis)) {
        const distance = Math.abs(target - line);
        if (distance <= threshold && distance < bestDistance) {
          best = target - line;
          bestDistance = distance;
        }
      }
    }
  }
  return best;
}

/** The guides along `axis` that `moving`'s lines share with `others`, each spanning everything on it. */
function guidesOn(moving: Rect, others: readonly Rect[], axis: 'x' | 'y'): Guide[] {
  const guides: Guide[] = [];
  for (const line of linesOf(moving, axis)) {
    const on = others.filter((other) => linesOf(other, axis).some((target) => Math.abs(target - line) < EPSILON));
    if (on.length === 0 || guides.some((guide) => Math.abs(guide.at - line) < EPSILON)) continue;
    const spans = [moving, ...on].map((rect) => spanOf(rect, axis));
    guides.push({ axis, at: line, from: Math.min(...spans.map(([from]) => from!)), to: Math.max(...spans.map(([, to]) => to!)) });
  }
  return guides;
}

/**
 * How far to shift `moving` (on each axis, independently) so that its nearest edge or centre lines up with an edge or
 * centre of one of `others`, if one is within `threshold`; and the guides to draw for every line it then shares.
 */
export function snapToGuides(moving: Rect, others: readonly Rect[], threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const dx = nearestShift(moving, others, 'x', threshold);
  const dy = nearestShift(moving, others, 'y', threshold);
  const snapped = { ...moving, x: moving.x + dx, y: moving.y + dy };
  return { dx, dy, guides: [...guidesOn(snapped, others, 'x'), ...guidesOn(snapped, others, 'y')] };
}

/** How far to shift something with its top-left at `corner` to put that on the grid of `gap`. */
export function snapToGrid(corner: { x: number; y: number }, gap: number): { dx: number; dy: number } {
  // `+ 0` makes a -0 a 0.
  const shift = (value: number) => Math.round(value / gap) * gap - value + 0;
  return { dx: shift(corner.x), dy: shift(corner.y) };
}
