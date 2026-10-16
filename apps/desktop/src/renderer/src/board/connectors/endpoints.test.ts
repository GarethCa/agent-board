import { describe, expect, it } from 'vitest';
import type { Connector } from '@agent-board/daemon/protocol';
import { autoEnds, autoSides, connectorEdges, endOfNode, withConnectorParams, nearestSide, newEndAt, nodeIdOf, shapeOf, withConnector, withConnectorChange } from './endpoints';

const connector = (overrides: Partial<Connector> = {}): Connector => ({
  id: 'c1',
  from: { type: 'item', id: 'a', side: 'right' },
  to: { type: 'agent', id: 's1', side: 'left' },
  style: 'curved',
  startEnd: 'none',
  endEnd: 'arrow',
  color: null,
  label: '',
  points: [],
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

describe('shapeOf', () => {
  it('is how the connector is drawn, as a hand-off made from it is', () => {
    expect(shapeOf(connector({ style: 'elbow', points: [{ x: 3, y: 4 }] }))).toEqual({ fromSide: 'right', toSide: 'left', style: 'elbow', points: [{ x: 3, y: 4 }] });
  });
});

describe('withConnectorParams', () => {
  it('changes what was given, an end moving to another side of its object', () => {
    const changed = withConnectorParams(connector(), { id: 'c1', label: 'see', fromSide: 'bottom', points: [{ x: 1, y: 2 }] });
    expect(changed).toMatchObject({ label: 'see', from: { type: 'item', id: 'a', side: 'bottom' }, to: { side: 'left' }, points: [{ x: 1, y: 2 }] });
    expect(changed).not.toHaveProperty('fromSide');
  });
});

describe('node ids', () => {
  it('map each kind of object to the board node that draws it, and back', () => {
    const ends = [
      { type: 'zone', id: 'z1' },
      { type: 'item', id: 'i1' },
      { type: 'agent', id: 's1' },
      { type: 'shell', id: 'sh1' },
      { type: 'external', id: 'e1' },
    ] as const;
    for (const end of ends) {
      const id = nodeIdOf(end);
      expect(endOfNode({ id, type: end.type === 'zone' ? 'zone' : 'tile' }, 'top')).toEqual({ ...end, side: 'top' });
    }
    expect(nodeIdOf({ type: 'item', id: 'i1' })).toBe('item:i1');
  });

  it("don't join a node they have no end for", () => {
    expect(endOfNode({ id: 'other', type: 'other' }, 'top')).toBeUndefined();
  });
});

describe('connectorEdges', () => {
  const nodes = new Set(['item:a', 'agent:s1']);

  it('draws a connector between the handles on the sides it names', () => {
    expect(connectorEdges([connector()], nodes, new Set())).toEqual([
      expect.objectContaining({
        id: 'connector:c1',
        type: 'connector',
        source: 'item:a',
        sourceHandle: 'right',
        target: 'agent:s1',
        targetHandle: 'left',
        selected: false,
      }),
    ]);
  });

  it("leaves out a connector whose end isn't on the board, and marks the selected ones", () => {
    const orphan = connector({
      id: 'c2',
      to: { type: 'item', id: 'gone', side: 'top' },
    });
    const edges = connectorEdges([connector(), orphan], nodes, new Set(['c1']));
    expect(edges.map((edge) => [edge.id, edge.selected])).toEqual([['connector:c1', true]]);
  });
});

describe('withConnector', () => {
  it('adds a connector, or replaces the one with its id', () => {
    const one = connector();
    const added = withConnector([one], connector({ id: 'c2' }));
    expect(added.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(withConnector(added, connector({ label: 'new' }))[0]!.label).toBe('new');
  });
});

describe('withConnectorChange', () => {
  it('applies an update, and a removal', () => {
    const one = connector();
    const updated = withConnectorChange([], {
      type: 'connector.updated',
      connector: one,
    });
    expect(updated).toEqual([one]);
    expect(withConnectorChange(updated, { type: 'connector.removed', id: 'c1' })).toEqual([]);
  });
});

describe('nearestSide', () => {
  const wide = { x: 0, y: 0, width: 400, height: 100 };

  it('is the side a point is nearest, by the rectangle’s proportions', () => {
    expect(nearestSide(wide, { x: 390, y: 50 })).toBe('right');
    expect(nearestSide(wide, { x: 10, y: 50 })).toBe('left');
    expect(nearestSide(wide, { x: 200, y: 90 })).toBe('bottom');
    expect(nearestSide(wide, { x: 200, y: 10 })).toBe('top');
    // 100 along a 400-wide rectangle is as close to its middle as 25 is down a 100-high one.
    expect(nearestSide(wide, { x: 300, y: 80 })).toBe('bottom');
  });
});

describe('newEndAt', () => {
  const source = { x: 0, y: 0, width: 100, height: 100 };
  const size = { width: 200, height: 160 };

  it('puts the side of the new note that faces the source at the drop point', () => {
    expect(newEndAt(source, { x: 400, y: 50 }, size)).toEqual({
      centre: { x: 500, y: 50 },
      side: 'left',
    });
    expect(newEndAt(source, { x: -300, y: 50 }, size)).toEqual({
      centre: { x: -400, y: 50 },
      side: 'right',
    });
    expect(newEndAt(source, { x: 50, y: 400 }, size)).toEqual({
      centre: { x: 50, y: 480 },
      side: 'top',
    });
    expect(newEndAt(source, { x: 50, y: -400 }, size)).toEqual({
      centre: { x: 50, y: -480 },
      side: 'bottom',
    });
  });
});

describe('autoSides', () => {
  const tile = (x: number, y: number) => ({ x, y, width: 280, height: 160 });
  const here = tile(0, 0);

  it('joins the sides of two tiles that face each other: bottom to top for one below, right to left for one to the right', () => {
    expect(autoSides('auto', 'auto', here, tile(0, 400))).toEqual({ fromSide: 'bottom', toSide: 'top' });
    expect(autoSides('auto', 'auto', here, tile(0, -400))).toEqual({ fromSide: 'top', toSide: 'bottom' });
    expect(autoSides('auto', 'auto', here, tile(600, 0))).toEqual({ fromSide: 'right', toSide: 'left' });
    expect(autoSides('auto', 'auto', here, tile(-600, 0))).toEqual({ fromSide: 'left', toSide: 'right' });
  });

  it('goes by how far off each tile is in its own proportions, so one down and across from a wide tile is mostly below', () => {
    // 300 across a 280-wide tile is about 1.07 widths; 240 down a 160-high one is 1.5 heights.
    expect(autoSides('auto', 'auto', here, tile(300, 240))).toEqual({ fromSide: 'bottom', toSide: 'top' });
    expect(autoSides('auto', 'auto', here, tile(500, 240))).toEqual({ fromSide: 'right', toSide: 'left' });
  });

  it('picks the same pair of sides for the edge each way between two tiles', () => {
    const there = tile(120, 380);
    const forth = autoSides('auto', 'auto', here, there);
    const back = autoSides('auto', 'auto', there, here);
    expect(back).toEqual({ fromSide: forth.toSide, toSide: forth.fromSide });
  });

  it('keeps a side the user picked, and picks only the automatic end', () => {
    expect(autoSides('right', 'auto', here, tile(0, 400))).toEqual({ fromSide: 'right', toSide: 'top' });
    expect(autoSides('left', 'bottom', here, tile(0, 400))).toEqual({ fromSide: 'left', toSide: 'bottom' });
  });

  it('draws from right to left until both tiles have been measured', () => {
    expect(autoSides('auto', 'auto', undefined, tile(0, 400))).toEqual({ fromSide: 'right', toSide: 'left' });
    expect(autoSides('auto', 'auto', here, { x: 0, y: 400, width: 0, height: 0 })).toEqual({ fromSide: 'right', toSide: 'left' });
  });
});

describe('autoEnds', () => {
  const tile = (x: number, y: number, width = 256, height = 136) => ({ x, y, width, height });

  it('joins a side round the corner when the tiles differ in size', () => {
    expect(autoEnds('auto', 'auto', tile(0, 0, 960, 600), tile(1352, 812))).toMatchObject({ fromSide: 'right', toSide: 'top' });
  });

  it('gives an automatic end the middle of its side, and a side the user picked no point of its own', () => {
    const [a, b] = [tile(0, 0), tile(0, 400)];
    expect(autoEnds('auto', 'auto', a, b)).toEqual({ fromSide: 'bottom', toSide: 'top', source: { x: 128, y: 136 }, target: { x: 128, y: 400 } });
    expect(autoEnds('right', 'auto', a, b)).toEqual({ fromSide: 'right', toSide: 'top', target: { x: 128, y: 400 } });
  });
});
