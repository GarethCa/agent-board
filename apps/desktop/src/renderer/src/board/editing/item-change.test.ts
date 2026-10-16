import { describe, expect, it } from 'vitest';
import type { BoardItem } from '@agent-board/daemon/protocol';
import { emptyHistory, record, redo, undo } from './history';
import { itemChange, type BoardState } from './use-history';

const shape: BoardItem = {
  id: 'box',
  kind: 'shape',
  zoneId: null,
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
