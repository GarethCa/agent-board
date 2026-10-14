// Where session tiles sit on the board: the x, y and z columns agents, shells and external sessions share.
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { finiteNumberParam, invalidParams, optionalBooleanParam, paramsObject } from './params.ts';
import type { TileMove, TilePosition } from './protocol.ts';

/** A row's place columns: x and y are both set or both NULL. */
export interface PositionColumns {
  x: number | null;
  y: number | null;
  z: number | null;
}

export function tilePosition(row: PositionColumns): TilePosition | null {
  return row.x === null || row.y === null ? null : { x: row.x, y: row.y, z: row.z };
}

/** A move's zone (a string, or null for none), x, y and optional z. */
export function moveParams(fields: Record<string, unknown>): TileMove {
  return {
    zoneId: zoneIdParam(fields),
    x: finiteNumberParam(fields, 'x'),
    y: finiteNumberParam(fields, 'y'),
    z: fields.z === undefined ? undefined : finiteNumberParam(fields, 'z'),
    toFront: optionalBooleanParam(fields, 'toFront'),
  };
}

/**
 * Saves `move` as the place of the tile `id` with `update`, a statement taking (zone, x, y, z, id). Without a z, the
 * tile keeps the stacking order it had at `from`.
 */
export function saveMove(db: DatabaseSync, update: StatementSync, id: string, from: TilePosition | null, move: TileMove): void {
  const z = move.toFront === true ? frontZ(db) : (move.z ?? from?.z ?? null);
  update.run(move.zoneId, move.x, move.y, z, id);
}

/** A new tile's optional `position`: its x and y. */
export function optionalPlaceParam(fields: Record<string, unknown>): { x: number; y: number } | undefined {
  if (fields.position === undefined) return undefined;
  const position = paramsObject(fields.position);
  return { x: finiteNumberParam(position, 'x'), y: finiteNumberParam(position, 'y') };
}

/** A tile's `zoneId`: a string, or null for none. */
export function zoneIdParam(fields: Record<string, unknown>): string | null {
  const zoneId = fields.zoneId;
  if (zoneId !== null && typeof zoneId !== 'string') throw invalidParams('zoneId must be a string or null');
  return zoneId;
}

/** The z that puts a tile above every other tile, of any kind. */
export function frontZ(db: DatabaseSync): number {
  const { top } = db
    .prepare(
      `SELECT max(z) AS top FROM (SELECT z FROM agents UNION ALL SELECT z FROM shells UNION ALL SELECT z FROM external_sessions)`,
    )
    .get() as { top: number | null };
  return (top ?? 0) + 1;
}
