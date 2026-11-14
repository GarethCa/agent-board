import { describe, expect, it } from 'vitest';
import type { Shell, Zone } from '@agent-board/daemon/protocol';
import { withFoldedZones } from '../fold-zone';
import { tileNodeId, withTiles, type BoardNode } from '../tiles';
import { zoneNode, type ZoneNodeType } from '../ZoneNode';
import { snapsTo } from './use-snapping';

const zone = (id: string, x: number, folded: boolean) =>
  zoneNode({ id, x, y: 0, width: 800, height: 400, repoRoot: null, folder: '', name: id, color: '#4c6ef5', spacing: 'normal', folded } as Zone);
const shell = (id: string, zoneId: string) => ({ id, zoneId, position: { x: 40, y: 80, z: 0 }, name: id, cwd: '/', layout: { type: 'pane', sessionId: `${id}-pane` }, endedPanes: [] }) as unknown as Shell;

/** The board's nodes as saved, and as drawn by id. */
function board(zones: ZoneNodeType[], shells: Shell[]) {
  const nodes = withTiles(zones, [], shells, []);
  const drawn = new Map(withFoldedZones(nodes).map((node) => [node.id, node]));
  return { nodes, drawnOf: (node: BoardNode) => drawn.get(node.id) };
}

describe('snapsTo', () => {
  it('snaps to a folded zone, but not to the tiles out of sight in it', () => {
    const { nodes, drawnOf } = board([zone('folded', 0, true), zone('dragged', 1000, true)], [shell('hidden', 'folded')]);
    const at = (id: string) => nodes.find((node) => node.id === id)!;
    const dragged = new Set(['dragged']);
    expect(snapsTo(at('folded'), drawnOf(at('folded')), dragged)).toBe(true);
    const hidden = at(tileNodeId('shell', 'hidden'));
    expect(snapsTo(hidden, drawnOf(hidden), dragged)).toBe(false);
  });

  it('snaps to the tiles of an open zone, and never to what moves with the drag', () => {
    const { nodes, drawnOf } = board([zone('open', 0, false), zone('dragged', 1000, false)], [shell('shown', 'open'), shell('along', 'dragged')]);
    const at = (id: string) => nodes.find((node) => node.id === id)!;
    const dragged = new Set(['dragged']);
    const shown = at(tileNodeId('shell', 'shown'));
    expect(snapsTo(shown, drawnOf(shown), dragged)).toBe(true);
    expect(snapsTo(at('dragged'), drawnOf(at('dragged')), dragged)).toBe(false);
    const along = at(tileNodeId('shell', 'along'));
    expect(snapsTo(along, drawnOf(along), dragged)).toBe(false);
  });
});
