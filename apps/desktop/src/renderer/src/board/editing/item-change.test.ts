import { describe, expect, it } from 'vitest';
import type { BoardItem } from '@agent-board/daemon/protocol';
import { emptyHistory, record, redo, undo } from './history';
import { agentDeleteChanges, historyKey, itemChange, type BoardState } from './use-history';
import type { Connector } from '@agent-board/daemon/protocol';

const shape: BoardItem = {
  id: 'box',
  kind: 'shape',
  zoneId: null,
  ticket: null,
  x: 0,
  y: 0,
  width: 160,
  height: 150,
  z: 1,
  rotation: 0,
  data: { shape: 'database', text: 'orders', fill: null },
  createdAt: '',
  updatedAt: '',
};

describe("an item's change in the undo history", () => {
  it('undoes Change shape to the kind it was, keeping its text, and redoes it', () => {
    const [key, before, after] = itemChange(shape, { id: 'box', data: { shape: 'cloud' } });
    const history = record(emptyHistory<BoardState>(), { before: new Map([[key, before]]), after: new Map([[key, after]]), at: 0 });
    const undone = undo(history)!;
    expect(undone.apply.get(key)).toMatchObject({ type: 'item', item: { data: { shape: 'database', text: 'orders' } } });
    expect(redo(undone.history)!.apply.get(key)).toMatchObject({ type: 'item', item: { data: { shape: 'cloud', text: 'orders' } } });
  });
});

describe("an agent's delete in the undo history", () => {
  const line = { id: 'line', from: { type: 'item', id: 'box', side: 'right' }, to: { type: 'item', id: 'other', side: 'left' } } as Connector;

  it('is one step that makes the item and its connectors again when undone', () => {
    const changes = agentDeleteChanges({ type: 'item.removed', undo: { item: shape, connectors: [line] } });
    expect(changes).toEqual([
      [historyKey.item('box'), { type: 'item', item: shape }, null],
      [historyKey.connector('line'), { type: 'connector', connector: line }, null],
    ]);
    const history = record(emptyHistory<BoardState>(), {
      before: new Map(changes.map(([key, before]) => [key, before])),
      after: new Map(changes.map(([key, , after]) => [key, after])),
      at: 0,
    });
    const undone = undo(history)!;
    expect(undone.apply.get(historyKey.item('box'))).toEqual({ type: 'item', item: shape });
    expect(undone.apply.get(historyKey.connector('line'))).toEqual({ type: 'connector', connector: line });
  });

  it("records nothing for a removal with nothing to undo, or one on a ticket's board", () => {
    expect(agentDeleteChanges({ type: 'item.removed' })).toEqual([]);
    expect(agentDeleteChanges({ type: 'item.updated' })).toEqual([]);
    expect(agentDeleteChanges({ type: 'item.removed', undo: { item: { ...shape, ticket: 'chat' }, connectors: [] } })).toEqual([]);
  });
});
