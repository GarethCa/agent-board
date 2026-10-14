// The pure parts of Add zone: the box the Zone tool drags out, and the popover's search.
import { DEFAULT_ZONE_SIZE, MIN_ZONE_SIZE, type ZoneLayout } from '@agent-board/daemon/protocol';
import type { Point } from '../geometry';
import { TOOL_DRAG_MIN } from './ToolOverlay';

/**
 * The zone the Zone tool's drag from `from` to `to` (board coordinates) outlines: the box between them, at least
 * `MIN_ZONE_SIZE` from where the drag started. A click, with no drag to speak of, outlines a zone of the default size
 * centred on it.
 */
export function draggedZoneLayout(from: Point, to: Point): ZoneLayout {
  if (Math.hypot(to.x - from.x, to.y - from.y) < TOOL_DRAG_MIN) {
    return {
      x: from.x - DEFAULT_ZONE_SIZE.width / 2,
      y: from.y - DEFAULT_ZONE_SIZE.height / 2,
      ...DEFAULT_ZONE_SIZE,
    };
  }
  const width = Math.abs(to.x - from.x);
  const height = Math.abs(to.y - from.y);
  return {
    x: width < MIN_ZONE_SIZE.width ? from.x : Math.min(from.x, to.x),
    y: height < MIN_ZONE_SIZE.height ? from.y : Math.min(from.y, to.y),
    width: Math.max(width, MIN_ZONE_SIZE.width),
    height: Math.max(height, MIN_ZONE_SIZE.height),
  };
}

/** Whether every word of `query` is in one of `texts`, ignoring case. An empty query matches everything. */
export function matches(texts: readonly (string | null | undefined)[], query: string): boolean {
  const haystack = texts.filter(Boolean).join(' ').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** Where Add zone sits by its outline: beside it, or over its right edge when neither side has room. */
export interface PopoverPlacement {
  side: 'right' | 'left';
  sideOffset: number;
}

/** The gap between the outline and the popover beside it, px. */
const POPOVER_GAP = 10;

/**
 * Beside the outline (`outline`, in window coordinates) on the right if the popover (`width` wide) fits in `view`,
 * else on the left, else over the outline's right edge, inside it.
 */
export function popoverPlacement(
  outline: { left: number; right: number },
  view: { left: number; right: number },
  width: number,
): PopoverPlacement {
  if (view.right - outline.right >= width + POPOVER_GAP * 2) return { side: 'right', sideOffset: POPOVER_GAP };
  if (outline.left - view.left >= width + POPOVER_GAP * 2) return { side: 'left', sideOffset: POPOVER_GAP };
  return { side: 'right', sideOffset: -(width + POPOVER_GAP * 2) };
}
