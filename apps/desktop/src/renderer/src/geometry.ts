// Points and rectangles, on the board or on screen, and the few sums done with them everywhere. Pure, so unit-tested.

import type { Point, Rect } from '@agent-board/daemon/board-layout';

// The board's layout geometry (`board-layout`) is the daemon's too: its rects and sums are these.
export { clamp, overlaps, type Point, type Rect, type Size } from '@agent-board/daemon/board-layout';

/** Whether `point` is inside `rect`, its edges included. */
export function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

export function centreOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * The upright box round `rect` turned `degrees` clockwise about its centre: what a rotated item takes up, for laying
 * things out round it.
 */
export function rotatedBounds(rect: Rect, degrees: number): Rect {
  if (degrees % 360 === 0) return rect;
  const radians = (degrees * Math.PI) / 180;
  const [cos, sin] = [Math.abs(Math.cos(radians)), Math.abs(Math.sin(radians))];
  const width = rect.width * cos + rect.height * sin;
  const height = rect.width * sin + rect.height * cos;
  const centre = centreOf(rect);
  return { x: centre.x - width / 2, y: centre.y - height / 2, width, height };
}
