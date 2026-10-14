// Points and rectangles, on the board or on screen, and the few sums done with them everywhere. Pure, so unit-tested.

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** A rectangle from its top-left. */
export interface Rect extends Point, Size {}

/** Whether two rects share any area: touching along an edge isn't overlapping. */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Whether `point` is inside `rect`, its edges included. */
export function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

export function centreOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** `value`, kept between `low` and `high`. */
export function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
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
