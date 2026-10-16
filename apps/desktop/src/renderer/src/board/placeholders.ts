import { itemNode, type ItemNodeType } from './items/items';
import { STICKY_COLORS, STICKY_SIZE } from '@agent-board/daemon/protocol';
import type { TileNodeType } from './tile';

const COLUMNS = 20;
const TILE = { width: 220, height: 88 };
const GAP = 32;

/** `count` placeholder tiles in a grid, for exercising the board before sessions exist (benchmarks only). */
export function placeholderTiles(count: number): TileNodeType[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `placeholder-${index}`,
    type: 'tile',
    position: {
      x: (index % COLUMNS) * (TILE.width + GAP),
      y: Math.floor(index / COLUMNS) * (TILE.height + GAP),
    },
    width: TILE.width,
    height: TILE.height,
    data: { label: `placeholder ${index + 1}`, harness: index % 2 === 0 ? 'claude' : 'codex' },
    zIndex: 1,
  }));
}

/** `count` placeholder sticky notes in a grid below the placeholder tiles' first rows (benchmarks only). */
export function placeholderStickies(count: number): ItemNodeType[] {
  return Array.from({ length: count }, (_, index) =>
    itemNode({
      id: `placeholder-${index}`,
      kind: 'sticky',
      zoneId: null,
      x: (index % COLUMNS) * (STICKY_SIZE.width + GAP),
      y: 4 * (TILE.height + GAP) + Math.floor(index / COLUMNS) * (STICKY_SIZE.height + GAP),
      ...STICKY_SIZE,
      z: index,
      rotation: 0,
      data: {
        text: index % 3 === 0 ? `**Note ${index + 1}**\n- one thing\n- _another_` : `Placeholder note ${index + 1}`,
        color: STICKY_COLORS[index % STICKY_COLORS.length]!.value,
      },
      createdAt: '',
      updatedAt: '',
    }),
  );
}

/**
 * How many placeholders of a sort the window was opened with: tiles (`?placeholders=N`) or sticky notes
 * (`?stickies=N`). 0 normally.
 */
export function placeholderCount(search: string, name: 'placeholders' | 'stickies'): number {
  const count = Number(new URLSearchParams(search).get(name));
  return Number.isInteger(count) && count > 0 ? count : 0;
}
