/** The tallest a shape grows to fit its text, px: past it the text is cut off, as it was before shapes grew. */
const MAX_GROWN_HEIGHT = 4000;

/** A shape's box on the board: its top-left corner, size and angle, degrees clockwise about its centre. */
export interface ShapeBox {
  x: number;
  y: number;
  height: number;
  rotation: number;
}

/**
 * `box` made `height` tall, with the corner and height to save. The shape is drawn rotated about its centre, so growing
 * from the top-left corner would slide a turned shape: its top edge is held in its own frame instead, and it extends
 * its own bottom edge.
 */
export function grownBox({ x, y, height: from, rotation }: ShapeBox, height: number): { x: number; y: number; height: number } {
  const half = (height - from) / 2;
  const radians = (rotation * Math.PI) / 180;
  return { x: x - half * Math.sin(radians), y: y + half * (Math.cos(radians) - 1), height };
}

/**
 * The height a shape `height` tall needs for its text to show whole, or 0 if it can't be measured, at most
 * `MAX_GROWN_HEIGHT`. The text area is a fixed share of the shape's height (a diamond's is small), so the height scales
 * with what the text needs.
 */
export function heightToFit(root: HTMLElement | null, height: number): number {
  const label = root?.querySelector<HTMLElement>('.shape-label');
  const text = label?.firstElementChild;
  if (!label || !text || label.clientHeight === 0) return 0;
  const style = getComputedStyle(label);
  const needs = text.scrollHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  return Math.min(MAX_GROWN_HEIGHT, Math.ceil((needs * height) / label.clientHeight));
}
