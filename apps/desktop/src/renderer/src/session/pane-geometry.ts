// Where each pane of a split tree goes in its window, as fractions of it, so the window can lay the panes out flat
// (keyed by id, so splitting never re-mounts a terminal) and drag a divider: a shell's panes by session, or a session
// window's panes by pane id. Pure, so it is unit-tested.
import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO, type SplitDirection, type SplitTree } from '@agent-board/daemon/pane-layout';

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
  /** In layout order, each by the id `idOf` gave its leaf. */
  panes: { id: string; rect: Rect }[];
  dividers: Divider[];
}

const WHOLE: Rect = { x: 0, y: 0, width: 1, height: 1 };

export function paneGeometry<L extends { type: 'pane' }>(layout: SplitTree<L>, idOf: (leaf: L) => string, region: Rect = WHOLE): PaneGeometry {
  if (layout.type !== 'split') return { panes: [{ id: idOf(layout as L), rect: region }], dividers: [] };
  const side = layout.direction === 'horizontal';
  const first: Rect = side ? { ...region, width: region.width * layout.ratio } : { ...region, height: region.height * layout.ratio };
  const second: Rect = side
    ? { ...region, x: region.x + first.width, width: region.width - first.width }
    : { ...region, y: region.y + first.height, height: region.height - first.height };
  const a = paneGeometry(layout.first, idOf, first);
  const b = paneGeometry(layout.second, idOf, second);
  return {
    panes: [...a.panes, ...b.panes],
    dividers: [{ splitId: layout.id, direction: layout.direction, region, ratio: layout.ratio }, ...a.dividers, ...b.dividers],
  };
}

/** A shell pane's id in its geometry: its session's. */
export const bySession = (pane: { sessionId: string }) => pane.sessionId;

/**
 * The ratio that puts the divider under `point`, a position in the window as fractions of it, as near as the layout
 * allows.
 */
export function ratioAt(divider: Divider, point: { x: number; y: number }): number {
  const { region } = divider;
  const ratio = divider.direction === 'horizontal' ? (point.x - region.x) / region.width : (point.y - region.y) / region.height;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

/** Where a drop on a pane lands: in its strip from the middle, or in a new pane at an edge. */
export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom';

/** How near an edge, as a share of the pane, a drop splits there. */
const EDGE_SHARE = 0.25;

/** The drop zone under `point`, a position in the pane as fractions of it: the nearest edge within a quarter, else the middle. */
export function dropZoneAt(point: { x: number; y: number }): DropZone {
  const distances: [DropZone, number][] = [
    ['left', point.x],
    ['right', 1 - point.x],
    ['top', point.y],
    ['bottom', 1 - point.y],
  ];
  const [edge, distance] = distances.reduce((nearest, each) => (each[1] < nearest[1] ? each : nearest));
  return distance < EDGE_SHARE ? edge : 'center';
}

export type Direction = 'left' | 'right' | 'up' | 'down';

/** Rounding slack, so panes that touch count as beside each other. */
const EPSILON = 1e-6;

/**
 * The rect to move the focus to from `rects[from]` (⌘⌥ and an arrow): of those wholly on that side, the nearest, then
 * the one whose middle is most in line. Undefined when none is.
 */
export function nearestInDirection(rects: readonly Rect[], from: number, direction: Direction): number | undefined {
  const at = rects[from];
  if (at === undefined) return undefined;
  const across = direction === 'left' || direction === 'right';
  const middle = (rect: Rect) => (across ? rect.y + rect.height / 2 : rect.x + rect.width / 2);
  /** How far `rect` is past `at` that way, or undefined when it isn't wholly on that side. */
  const gap = (rect: Rect): number | undefined => {
    const distance =
      direction === 'right'
        ? rect.x - (at.x + at.width)
        : direction === 'left'
          ? at.x - (rect.x + rect.width)
          : direction === 'down'
            ? rect.y - (at.y + at.height)
            : at.y - (rect.y + rect.height);
    return distance < -EPSILON ? undefined : distance;
  };
  let best: { index: number; gap: number; offset: number } | undefined;
  rects.forEach((rect, index) => {
    const distance = index === from ? undefined : gap(rect);
    if (distance === undefined) return;
    const offset = Math.abs(middle(rect) - middle(at));
    if (best === undefined || distance < best.gap - EPSILON || (Math.abs(distance - best.gap) <= EPSILON && offset < best.offset)) best = { index, gap: distance, offset };
  });
  return best?.index;
}
