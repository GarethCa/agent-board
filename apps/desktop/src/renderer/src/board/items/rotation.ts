// The Rotate tool's sums: an item turns about its own centre, by as far as the pointer goes round it. Pure,
// so unit-tested.
import { normalisedAngle } from '@agent-board/daemon/protocol';
import type { Point } from '../../geometry';

/** The steps Shift snaps an angle to, in degrees. */
export const ROTATION_SNAP = 15;

/** The angle of `point` round `centre`, in degrees clockwise from straight up, as the board's y grows downwards. */
export function angleAt(centre: Point, point: Point): number {
  return normalisedAngle((Math.atan2(point.x - centre.x, centre.y - point.y) * 180) / Math.PI);
}

/** An item at `start` turned by `turn` degrees; with `snap` (Shift held), to the nearest `ROTATION_SNAP`. */
export function rotatedBy(start: number, turn: number, snap: boolean): number {
  const angle = start + turn;
  return normalisedAngle(snap ? Math.round(angle / ROTATION_SNAP) * ROTATION_SNAP : angle);
}
