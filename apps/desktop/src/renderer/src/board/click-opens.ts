// What a double-click on an agent's or shell tile opens: its session window, the default, or the tile expanded
// in place. Kept in the daemon's view state. Pure, so the rules are unit-tested.

/** The click setting: the session window, or the tile expanded in place. */
export type ClickOpens = 'window' | 'expand';

/** The click setting as saved (view state, read back untyped): the session window unless Expand in place was saved. */
export function clickOpensFrom(saved: unknown): ClickOpens {
  return saved === 'expand' ? 'expand' : 'window';
}

/**
 * What opening a tile (a double-click, or Enter on it) does, under the setting. A tile with no session window (an
 * external session's) always expands.
 */
export function tileOpenAction(setting: ClickOpens, tile: { hasWindow: boolean }): 'window' | 'expand' {
  return setting === 'window' && tile.hasWindow ? 'window' : 'expand';
}
