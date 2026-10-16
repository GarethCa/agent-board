// Making room: when an orchestrator puts something exactly where it asks, what is in the way moves aside,
// not the thing asked for. Pure, so every case is unit-tested.
import { clearOf, GRID_COLUMN, gridColumnAtOrRight, gridPoint, MAX_SEARCH_STEPS, TILE_GAP, type Point, type Rect } from './board-layout.ts';

/** Something that may be moved aside: its id, and what it takes (a tile with the room above it for its characters). */
export interface Movable {
  id: string;
  rect: Rect;
}

/**
 * Where those of `movable` in the way of `placed` go, so each keeps a gap from it, from `fixed` (what may not move) and
 * from each other: pushed right a whole grid column at a time, left to right, so a row keeps its order and its grid,
 * and what a pushed one then hits is pushed too. Each search stops after `cap` columns and goes to the first grid
 * column past everything instead.
 * Returns the new top-left of each moved rect, by id; the rest stay.
 */
export function makeRoom(placed: Rect, movable: readonly Movable[], fixed: readonly Rect[], cap = MAX_SEARCH_STEPS): Map<string, Point> {
  const taken = [placed, ...fixed];
  const moved = new Map<string, Point>();
  for (const { id, rect } of movable.toSorted((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y || (a.id < b.id ? -1 : 1))) {
    if (clearOf(rect, taken)) {
      taken.push(rect);
      continue;
    }
    let steps = 1;
    while (steps <= cap && !clearOf({ ...rect, x: rect.x + steps * GRID_COLUMN }, taken)) steps++;
    // Past the cap, the first grid column clear of everything.
    const x = steps <= cap ? rect.x + steps * GRID_COLUMN : gridPoint(gridColumnAtOrRight(Math.max(...taken.map((each) => each.x + each.width)) + TILE_GAP), 0).x;
    moved.set(id, { x, y: rect.y });
    taken.push({ ...rect, x });
  }
  return moved;
}
