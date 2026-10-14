// Where each pane of a shell tile goes in its window, as fractions of it, so the window can lay the panes out flat
// (keyed by session, so splitting never re-mounts a terminal) and drag a divider. Pure, so it is unit-tested.
import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO, type PaneLayout, type SplitDirection } from '@agent-board/daemon/pane-layout';

/** A rectangle as fractions of the whole window: 0..1 from its top-left. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Divider {
  splitId: string;
  direction: SplitDirection;
  /** The space the split divides; its divider crosses it at `ratio`. */
  region: Rect;
  ratio: number;
}

export interface PaneGeometry {
  /** In layout order. */
  panes: { sessionId: string; rect: Rect }[];
  dividers: Divider[];
}

const WHOLE: Rect = { x: 0, y: 0, width: 1, height: 1 };

export function paneGeometry(layout: PaneLayout, region: Rect = WHOLE): PaneGeometry {
  if (layout.type === 'pane') return { panes: [{ sessionId: layout.sessionId, rect: region }], dividers: [] };
  const side = layout.direction === 'horizontal';
  const first: Rect = side ? { ...region, width: region.width * layout.ratio } : { ...region, height: region.height * layout.ratio };
  const second: Rect = side
    ? { ...region, x: region.x + first.width, width: region.width - first.width }
    : { ...region, y: region.y + first.height, height: region.height - first.height };
  const a = paneGeometry(layout.first, first);
  const b = paneGeometry(layout.second, second);
  return {
    panes: [...a.panes, ...b.panes],
    dividers: [{ splitId: layout.id, direction: layout.direction, region, ratio: layout.ratio }, ...a.dividers, ...b.dividers],
  };
}

/**
 * The ratio that puts the divider under `point`, a position in the window as fractions of it, as near as the layout
 * allows.
 */
export function ratioAt(divider: Divider, point: { x: number; y: number }): number {
  const { region } = divider;
  const ratio = divider.direction === 'horizontal' ? (point.x - region.x) / region.width : (point.y - region.y) / region.height;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}
