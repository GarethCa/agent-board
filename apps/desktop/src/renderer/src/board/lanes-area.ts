// A zone's lanes area (`Zone.lanes`): the part of a zone on shelves or in clusters that they are laid out in, sized by
// its own corner handles, and the free area round it, where each tile stays where it was put. Pure, so it is unit-tested.
import type { ZoneLayout } from '@agent-board/daemon/protocol';

type Point = { x: number; y: number };
type Size = { width: number; height: number };

/** A corner of the lanes area, by its handle. */
export const LANES_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
export type LanesCorner = (typeof LANES_CORNERS)[number];

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * The lanes area `start` with its `corner` dragged by `by` (board pixels): the other corner stays, it stays inside a zone
 * of `zone`, and it goes no smaller than `least`, what its lanes need.
 */
export function lanesDragged(start: ZoneLayout, corner: LanesCorner, by: Point, zone: Size, least: Size): ZoneLayout {
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  const left = corner.endsWith('left') ? clamp(start.x + by.x, 0, right - least.width) : start.x;
  const top = corner.startsWith('top') ? clamp(start.y + by.y, 0, bottom - least.height) : start.y;
  const newRight = corner.endsWith('right') ? clamp(right + by.x, left + least.width, zone.width) : right;
  const newBottom = corner.startsWith('bottom') ? clamp(bottom + by.y, top + least.height, zone.height) : bottom;
  return { x: left, y: top, width: newRight - left, height: newBottom - top };
}
