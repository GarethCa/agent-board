// Moving between the sessions of a group from the session window: the sessions of the shown one's zone,
// or the loose ones for a session in none, in board order, wrapping at the ends. Pure, so the order is unit-tested.
import type { WindowTarget } from '../../../preload/api';

/** A session with a window (an agent or a shell tile), where its tile sits: its zone (null, loose) and its place. */
export interface NavSession {
  target: WindowTarget;
  zoneId: string | null;
  /** Its tile's top left, in its zone (or on the board, loose): only compared with its zone's other tiles. */
  x: number;
  y: number;
}

/** A step to another session, and whether it went past an end to the other. */
export interface NavStep {
  target: WindowTarget;
  wrapped: boolean;
}

/** Where a session is among its group's, and the sessions either side of it. */
export interface SessionNav {
  /** From 0, in board order. */
  index: number;
  count: number;
  /** Its zone, or null for the loose sessions. */
  zoneId: string | null;
  previous: NavStep;
  next: NavStep;
}

/**
 * How far apart two tiles' tops may be and still be in one row: half a tile, so hand-placed tiles a little out of
 * line still read left to right.
 */
const ROW_TOLERANCE = 68;

/** Board order: rows top to bottom, each left to right. A row starts at its top tile and takes those near its height. */
export function boardOrder<T extends { x: number; y: number }>(sessions: readonly T[]): T[] {
  const rows: T[][] = [];
  for (const session of [...sessions].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.at(-1);
    if (row !== undefined && session.y - row[0]!.y <= ROW_TOLERANCE) row.push(session);
    else rows.push([session]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x));
}

/**
 * Where the session `id` is among its group's, or undefined if it is not on the board. Those in `skip` (popped out into
 * their own OS windows, which the board's window can't show) are stepped past and not counted.
 */
export function sessionNav(sessions: readonly NavSession[], id: string, skip: ReadonlySet<string> = new Set()): SessionNav | undefined {
  const zoneId = sessions.find((session) => session.target.id === id)?.zoneId;
  if (zoneId === undefined) return undefined;
  const group = boardOrder(
    sessions.filter((session) => session.zoneId === zoneId && (session.target.id === id || !skip.has(session.target.id))),
  );
  const index = group.findIndex((session) => session.target.id === id);
  const count = group.length;
  const stepTo = (to: number): NavStep => ({ target: group[(to + count) % count]!.target, wrapped: to < 0 || to >= count });
  return { index, count, zoneId, previous: stepTo(index - 1), next: stepTo(index + 1) };
}
