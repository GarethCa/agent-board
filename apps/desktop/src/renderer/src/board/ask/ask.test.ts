import { describe, expect, it } from 'vitest';
import { DEFAULT_CONNECTOR_LOOK, type Connector, type SuggestedEdit } from '@agent-board/daemon/protocol';
import { answerSpots, captureZoom, selectionAsk, selectionSummary, type DiagramObject } from './selection-diagram';
import { chipAt, suggestionPlan, withoutSuggestions } from './suggestions';

const shape = (id: string, shape: string, text: string, x: number, y: number, width = 120, height = 60, zone?: string): DiagramObject => ({
  end: { type: 'item', id },
  kind: 'shape',
  shape,
  text,
  rect: { x, y, width, height },
  ...(zone === undefined ? {} : { zone }),
});

const connector = (id: string, from: string, to: string, label = ''): Connector => ({
  id,
  from: { type: 'item', id: from, side: 'right' },
  to: { type: 'item', id: to, side: 'left' },
  ...DEFAULT_CONNECTOR_LOOK,
  label,
  points: [],
  createdAt: '',
  updatedAt: '',
});

describe('selectionAsk', () => {
  const objects = [
    shape('db', 'database', 'Postgres', 600, 90, 100, 90, 'Checkout'),
    shape('gw', 'rounded', 'API gateway', 200, 100, 120, 60, 'Checkout'),
    shape('orders', 'service', ' Orders service ', 400, 100, 130, 70, 'Checkout'),
  ];

  it('numbers the nodes in reading order, from the selection’s top-left, with the arrows between them and their zone', () => {
    const ask = selectionAsk(objects, [connector('c1', 'gw', 'orders', 'orders'), connector('c2', 'orders', 'db'), connector('c3', 'orders', 'elsewhere')])!;
    expect(ask.origin).toEqual({ x: 200, y: 90 });
    expect(ask.diagram).toEqual({
      nodes: [
        { id: 'n1', kind: 'shape', shape: 'database', text: 'Postgres', x: 400, y: 0, width: 100, height: 90 },
        { id: 'n2', kind: 'shape', shape: 'rounded', text: 'API gateway', x: 0, y: 10, width: 120, height: 60 },
        { id: 'n3', kind: 'shape', shape: 'service', text: 'Orders service', x: 200, y: 10, width: 130, height: 70 },
      ],
      edges: [
        { from: 'n2', to: 'n3', label: 'orders' },
        { from: 'n3', to: 'n1' },
      ],
      groups: [{ name: 'Checkout', nodes: ['n1', 'n2', 'n3'] }],
    });
    expect(ask.objects).toEqual({ n1: { type: 'item', id: 'db' }, n2: { type: 'item', id: 'gw' }, n3: { type: 'item', id: 'orders' } });
    // The rightmost node, nearest the note.
    expect(ask.anchor).toBe('n1');
    // Only the connectors between two of its objects are drawn in its picture.
    expect(ask.connectorIds).toEqual(['c1', 'c2']);
    expect(ask.bounds).toEqual({ x: 200, y: 90, width: 500, height: 90 });
  });

  it('draws the picture at a true 2×: zoom 2 on a plain screen, 1 on a Retina one, less only when it would not fit', () => {
    const bounds = { x: 0, y: 0, width: 400, height: 100 };
    const room = { width: 1200, height: 700 };
    expect(captureZoom(bounds, room, 1, 2)).toEqual({ zoom: 2, scale: 2 });
    expect(captureZoom(bounds, room, 2, 2)).toEqual({ zoom: 1, scale: 2 });
    // 1200 px of room for 800 board px: zoom 1.5, a 1.5× picture, which the prompt says.
    expect(captureZoom({ ...bounds, width: 800 }, room, 1, 2)).toEqual({ zoom: 1.5, scale: 1.5 });
    expect(captureZoom(bounds, room, 1, 1.25)).toEqual({ zoom: 1.25, scale: 1.25 });
  });

  it('has nothing for an empty selection', () => {
    expect(selectionAsk([], [])).toBeUndefined();
  });

  it('puts the note to the right of the selection, level with its top, and the tile under it', () => {
    expect(answerSpots({ x: 200, y: 90, width: 500, height: 90 })).toEqual({ note: { x: 748, y: 90 }, tile: { x: 748, y: 350 } });
  });

  it('says what is sent', () => {
    const ask = selectionAsk(objects, [connector('c1', 'gw', 'orders'), connector('c2', 'orders', 'db')])!;
    expect(selectionSummary(ask.diagram)).toBe('3 shapes · 2 arrows');
    const note: DiagramObject = { end: { type: 'item', id: 'n' }, kind: 'sticky', text: 'hi', rect: { x: 0, y: 0, width: 10, height: 10 } };
    expect(selectionSummary(selectionAsk([note], [])!.diagram)).toBe('1 object');
  });
});

describe('suggestionPlan', () => {
  const outbox: SuggestedEdit = {
    id: '1',
    title: 'Outbox',
    shapes: [{ key: 's1', shape: 'database', text: 'outbox', x: 400, y: 300, width: 90, height: 70 }],
    arrows: [
      { from: { object: { type: 'item', id: 'orders' } }, to: { shape: 's1' }, label: 'writes' },
      { from: { object: { type: 'item', id: 'gone' } }, to: { shape: 's1' }, label: '' },
    ],
  };
  const rects: Record<string, { x: number; y: number; width: number; height: number }> = { orders: { x: 400, y: 100, width: 130, height: 70 } };
  let next = 0;
  const newId = () => `id${++next}`;

  it('makes its shapes, and joins them to what is still on the board on the sides that face each other', () => {
    next = 0;
    const plan = suggestionPlan(outbox, (object) => rects[object.id], newId);
    expect(plan.shapes).toEqual([{ id: 'id1', shape: 'database', text: 'outbox', rect: { x: 400, y: 300, width: 90, height: 70 } }]);
    expect(plan.connectors).toHaveLength(1);
    expect(plan.connectors[0]).toMatchObject({ from: { type: 'item', id: 'orders', side: 'bottom' }, to: { type: 'item', id: 'id1', side: 'top' }, label: 'writes' });
    expect(chipAt(plan)).toEqual({ x: 498, y: 335 });
  });

  it('drops the suggestions dealt with', () => {
    expect(withoutSuggestions([outbox, { ...outbox, id: '2' }], new Set(['1'])).map((each) => each.id)).toEqual(['2']);
  });
});
