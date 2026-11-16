// Which design draws an agent's tile, a Settings choice kept in localStorage so every window hears it change: today's
// tile (Classic's, or the calm tile under the Simplified design), Porthole or Shelf. The glance designs draw the same
// facts (glance-tile.ts) and differ only in how they look.
import { useSyncExternalStore } from 'react';
import { storedValue } from '../stored-value';

export const TILE_DESIGNS = ['current', 'porthole', 'shelf'] as const;
export type TileDesign = (typeof TILE_DESIGNS)[number];

/** The designs Settings offers, in its order. */
export const TILE_DESIGN_CHOICES: readonly TileDesign[] = ['current', 'porthole', 'shelf'];

/** The stored design, or today's for none or one Settings doesn't offer (the switch would show nothing picked). */
export const tileDesignOf = (value: string | undefined): TileDesign => TILE_DESIGN_CHOICES.find((design) => design === value) ?? 'current';

const stored = storedValue('agent-board.tile-design');

export function setTileDesign(design: TileDesign): void {
  stored.set(design === 'current' ? undefined : design);
}

/** The design picked, heard in every window as it changes. */
export function useTileDesign(): TileDesign {
  return useSyncExternalStore(stored.subscribe, () => tileDesignOf(stored.get()), () => 'current');
}
