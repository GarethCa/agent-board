// Points and rectangles, on the board or on screen, and the few sums done with them everywhere. Pure, so unit-tested.

import type { Point, Rect } from '@agent-board/daemon/board-layout';

// The board's layout geometry (`board-layout`) is the daemon's too: its rects and sums are these.
export { clamp, overlaps, rotatedBounds, type Point, type Rect, type Size } from '@agent-board/daemon/board-layout';

/** Whether `point` is inside `rect`, its edges included. */
export function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

export function centreOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
