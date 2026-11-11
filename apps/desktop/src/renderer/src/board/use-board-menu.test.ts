import { describe, expect, it } from 'vitest';
import type { Agent, Shell } from '@agent-board/daemon/protocol';
import { tileNodeId, type BoardNode } from './tiles';
import { menuFor } from './use-board-menu';

const agentTile = (sessionId: string): BoardNode =>
  ({
    id: tileNodeId('agent', sessionId),
    type: 'tile',
    position: { x: 0, y: 0 },
    data: { label: sessionId, harness: 'claude', agent: { sessionId, name: sessionId } as Agent },
  }) as BoardNode;
const shellTile = (id: string): BoardNode =>
  ({ id: tileNodeId('shell', id), type: 'tile', position: { x: 0, y: 0 }, data: { label: id, harness: null, shell: { id } as Shell } }) as BoardNode;
const note = { id: 'item:note', type: 'item', position: { x: 0, y: 0 }, data: {} } as unknown as BoardNode;

describe('menuFor', () => {
  it("opens one agent's own menu", () => {
    expect(menuFor([agentTile('a')], 0)).toBe('agent');
  });

  it('keeps the selection menu for anything else selected alone', () => {
    expect(menuFor([shellTile('s')], 0)).toBe('selection');
    expect(menuFor([note], 0)).toBe('selection');
  });

  it('keeps the selection menu for two or more, agents or not', () => {
    expect(menuFor([agentTile('a'), agentTile('b')], 0)).toBe('selection');
    expect(menuFor([agentTile('a'), note], 0)).toBe('selection');
  });

  it('keeps the selection menu for an agent with a connector selected too', () => {
    expect(menuFor([agentTile('a')], 1)).toBe('selection');
  });

  it('opens the selection menu with nothing selected', () => {
    expect(menuFor([], 0)).toBe('selection');
  });
});
