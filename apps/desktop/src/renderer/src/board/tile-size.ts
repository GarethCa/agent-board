// How big each compact session tile is once the user has resized it, by node id. Pure, so every rule is
// unit-tested. The board holds the sizes in one state, saved in the daemon's view state so the tiles are the same size
// after a restart. A tile never resized is `AGENT_TILE_SIZE` and has no entry.
import { AGENT_TILE_SIZE } from './layout';

export type TileSize = { width: number; height: number };

/** Sizes a tile has been resized to, by node id. */
export type TileSizes = Readonly<Record<string, TileSize>>;

/** The least a tile can be: its head (a two-line name), branch and footer still fit. */
export const TILE_MIN_SIZE: TileSize = { width: 200, height: 120 };

/** The most a tile can be: well past what any description needs. */
export const TILE_MAX_SIZE: TileSize = { width: 640, height: 480 };

/** The step a resize snaps to, px on the board. */
const TILE_SIZE_STEP = 8;

/** `size` snapped to the step, then within the least and most a tile can be. */
export function clampTileSize(size: TileSize): TileSize {
  const fit = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value / TILE_SIZE_STEP) * TILE_SIZE_STEP));
  return { width: fit(size.width, TILE_MIN_SIZE.width, TILE_MAX_SIZE.width), height: fit(size.height, TILE_MIN_SIZE.height, TILE_MAX_SIZE.height) };
}

export const isDefaultSize = (size: TileSize) => size.width === AGENT_TILE_SIZE.width && size.height === AGENT_TILE_SIZE.height;

/** The size of the tile `id`: what it was resized to, or the default. */
export const tileSizeOf = (sizes: TileSizes, id: string): TileSize => sizes[id] ?? AGENT_TILE_SIZE;

/** `sizes` with the tile `id` at `size` (clamped), or back to the default, which takes its entry away: it is the reset. */
export function withTileSize(sizes: TileSizes, id: string, size: TileSize | undefined): TileSizes {
  const clamped = size === undefined ? undefined : clampTileSize(size);
  if (clamped === undefined || isDefaultSize(clamped)) {
    if (!(id in sizes)) return sizes;
    return Object.fromEntries(Object.entries(sizes).filter(([known]) => known !== id));
  }
  const known = sizes[id];
  return known?.width === clamped.width && known.height === clamped.height ? sizes : { ...sizes, [id]: clamped };
}

/** Only the sizes of tiles still on the board, by node id. */
export function keepTileSizes(sizes: TileSizes, present: ReadonlySet<string>): TileSizes {
  const ids = Object.keys(sizes);
  return ids.every((id) => present.has(id)) ? sizes : Object.fromEntries(ids.filter((id) => present.has(id)).map((id) => [id, sizes[id]!]));
}

/** The sizes saved from the last run (view state), taking only well-formed ones, clamped; the default is no entry. */
export function tileSizesFrom(saved: unknown): TileSizes {
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return {};
  let sizes: TileSizes = {};
  for (const [id, size] of Object.entries(saved)) {
    if (typeof size !== 'object' || size === null) continue;
    const { width, height } = size as Record<string, unknown>;
    if (typeof width === 'number' && typeof height === 'number' && Number.isFinite(width) && Number.isFinite(height)) {
      sizes = withTileSize(sizes, id, { width, height });
    }
  }
  return sizes;
}
