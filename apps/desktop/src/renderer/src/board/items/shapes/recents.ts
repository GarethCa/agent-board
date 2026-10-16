// The shapes used last, newest first: the picker's Recent row, the `/` palette's empty list and the Shape button's icon.
import { useSyncExternalStore } from 'react';
import { SHAPE_TYPES, type ShapeType } from '@agent-board/daemon/protocol';

const STORAGE_KEY = 'agent-board.recent-shapes';
/** How many the Recent row holds: one row of the picker. */
const RECENT_SHAPES = 6;

/** `recents` with `shape` put first, once, cut to `RECENT_SHAPES`. */
export function withRecent(recents: readonly ShapeType[], shape: ShapeType): ShapeType[] {
  return [shape, ...recents.filter((recent) => recent !== shape)].slice(0, RECENT_SHAPES);
}

/** The recents in what was stored, keeping only shapes this app knows, once each. */
export function parseRecents(stored: string | null): ShapeType[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const known = parsed.filter((shape): shape is ShapeType => SHAPE_TYPES.includes(shape as ShapeType));
  return [...new Set(known)].slice(0, RECENT_SHAPES);
}

let current: ShapeType[] | undefined;
const listeners = new Set<() => void>();

/** The recent shapes, newest first. */
export function recentShapes(): ShapeType[] {
  if (current === undefined) {
    try {
      current = parseRecents(localStorage.getItem(STORAGE_KEY));
    } catch {
      current = [];
    }
  }
  return current;
}

/** The shape used last, which the Shape tool draws: a rectangle before any. */
export const lastShape = (): ShapeType => recentShapes()[0] ?? 'rectangle';

/** Notes `shape` as just used. */
export function noteShapeUsed(shape: ShapeType): void {
  current = withRecent(recentShapes(), shape);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // The recents just don't outlast this run.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The recent shapes, kept current as one is used. */
export const useRecentShapes = (): ShapeType[] => useSyncExternalStore(subscribe, recentShapes);
