import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BoardItem } from '@agent-board/daemon/protocol';
import { itemNode, placeOnBoard, withItem, withoutItem } from './items';

const zones = [
  { id: 'a', x: 0, y: 0, width: 500, height: 400 },
  { id: 'b', x: 300, y: 100, width: 500, height: 400 },
];
const size = { width: 100, height: 100 };

const item = (overrides: Partial<BoardItem> = {}): BoardItem => ({
  id: 'i1',
  kind: 'sticky',
  zoneId: null,
  x: 10,
  y: 20,
  width: 100,
  height: 80,
  z: 1,
  data: { text: '', color: '#fff3a3' },
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

describe('itemNode', () => {
  it('draws shapes below tiles (1) and everything else above them', () => {
    expect(itemNode(item({ kind: 'shape' })).zIndex).toBeLessThan(1);
    expect(itemNode(item({ kind: 'sticky' })).zIndex).toBeGreaterThan(1);
    expect(itemNode(item({ kind: 'text' })).zIndex).toBeGreaterThan(1);
  });
});

describe('placeOnBoard', () => {
  it('leaves an item on the board, in board coordinates, when its centre is in no zone', () => {
    expect(placeOnBoard({ x: 900, y: 900 }, size, zones)).toEqual({ zoneId: null, x: 900, y: 900 });
  });

  it('puts an item whose centre is in a zone in that zone, relative to it', () => {
    expect(placeOnBoard({ x: 50, y: 60 }, size, zones)).toEqual({ zoneId: 'a', x: 50, y: 60 });
  });

  it('picks the zone drawn on top (the later one) where zones overlap', () => {
    expect(placeOnBoard({ x: 350, y: 150 }, size, zones)).toEqual({ zoneId: 'b', x: 50, y: 50 });
  });

  it('goes by the centre, so an item hanging over a zone edge belongs where most of it is', () => {
    expect(placeOnBoard({ x: -60, y: 10 }, size, zones)).toEqual({ zoneId: null, x: -60, y: 10 });
    expect(placeOnBoard({ x: -40, y: 10 }, size, zones)).toEqual({ zoneId: 'a', x: -40, y: 10 });
  });
});

describe('itemNode', () => {
  it('makes a node of the kind, a child of its zone so it moves with it', () => {
    expect(itemNode(item({ zoneId: 'a' }))).toMatchObject({
      id: 'item:i1',
      type: 'item:sticky',
      parentId: 'a',
      position: { x: 10, y: 20 },
      width: 100,
      height: 80,
      data: { item: item({ zoneId: 'a' }) },
    });
    expect(itemNode(item()).parentId).toBeUndefined();
  });
});

describe('withItem', () => {
  const zone = { id: 'a', type: 'zone', position: { x: 0, y: 0 }, data: {} };

  it('adds a new item at the end, on top', () => {
    const nodes = withItem([zone], item());
    expect(nodes.map((node) => node.id)).toEqual(['a', 'item:i1']);
  });

  it("replaces a known item's node in place, keeping what React Flow added, such as its selection", () => {
    const before = withItem([zone], item()).map((node) => ({ ...node, selected: true }));
    const after = withItem(before, item({ x: 99, data: { text: 'new', color: '#fff3a3' } }));

    expect(after[1]).toMatchObject({ selected: true, position: { x: 99, y: 20 } });
    expect(after[1]!.data).toEqual({ item: item({ x: 99, data: { text: 'new', color: '#fff3a3' } }) });
  });

  it('keeps the position of an item being dragged, so a change from elsewhere does not yank it', () => {
    const dragging = withItem([zone], item()).map((node) => ({ ...node, dragging: true }));
    expect(withItem(dragging, item({ x: 500 }))[1]!.position).toEqual({ x: 10, y: 20 });
  });

  it('keeps items in z order, so a change of z changes which draws on top', () => {
    const tile = { id: 'agent:t', type: 'tile', position: { x: 0, y: 0 }, data: {} };
    const three = [item({ id: 'i1', z: 1 }), item({ id: 'i2', z: 2 }), item({ id: 'i3', z: 3 })].reduce<Node[]>(
      withItem,
      [zone, tile],
    );
    expect(three.map((node) => node.id)).toEqual(['a', 'agent:t', 'item:i1', 'item:i2', 'item:i3']);

    const raised = withItem(three, item({ id: 'i1', z: 4 }));
    expect(raised.map((node) => node.id)).toEqual(['a', 'agent:t', 'item:i2', 'item:i3', 'item:i1']);
    const lowered = withItem(raised, item({ id: 'i4', z: 0 }));
    expect(lowered.map((node) => node.id)).toEqual(['a', 'agent:t', 'item:i4', 'item:i2', 'item:i3', 'item:i1']);
  });

  it('leaves out an item whose zone is not on the board', () => {
    expect(withItem([], item({ zoneId: 'gone' }))).toEqual([]);
  });

  it('removes an item', () => {
    expect(withoutItem(withItem([zone], item()), 'i1')).toEqual([zone]);
  });
});
