import { describe, expect, it } from 'vitest';
import { DEFAULT_CONNECTOR_LOOK, type BoardItem, type Connector } from '@agent-board/daemon/protocol';
import { copied, parseCopied, placed, plainText, serialiseCopied } from './clipboard';

const item = (id: string, x: number, y: number, data: Record<string, unknown> = {}): BoardItem => ({
  id,
  kind: 'sticky',
  zoneId: 'zone',
  x: x - 1000,
  y: y - 1000,
  width: 100,
  height: 100,
  z: 1,
  data,
  createdAt: '',
  updatedAt: '',
});

const connector = (id: string, from: string, to: string): Connector => ({
  id,
  from: { type: 'item', id: from, side: 'right' },
  to: { type: 'item', id: to, side: 'left' },
  ...DEFAULT_CONNECTOR_LOOK,
  label: 'next',
  createdAt: '',
  updatedAt: '',
});

/** Two notes 200 apart on the board, joined, and joined to one not copied. */
const twoNotes = () =>
  copied(
    [
      { item: item('a', 0, 0, { text: 'first' }), at: { x: 0, y: 0 } },
      { item: item('b', 200, 0, { text: 'second' }), at: { x: 200, y: 0 } },
    ],
    [connector('ab', 'a', 'b'), connector('ax', 'a', 'x')],
  );

describe('copied', () => {
  it('keeps where each item is on the board, and only the connectors between copied items', () => {
    const copy = twoNotes();
    expect(copy.items.map(({ id, x, y }) => ({ id, x, y }))).toEqual([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 200, y: 0 },
    ]);
    expect(copy.connectors.map((known) => known.label)).toEqual(['next']);
  });
});

describe('placed', () => {
  it('moves the copies by the shift, under new ids, with their connectors joined to the copies', () => {
    let n = 0;
    const { items, connectors } = placed(twoNotes(), { dx: 20, dy: 30 }, () => `new-${++n}`);
    expect(items.map(({ id, x, y, data }) => ({ id, x, y, data }))).toEqual([
      { id: 'new-1', x: 20, y: 30, data: { text: 'first' } },
      { id: 'new-2', x: 220, y: 30, data: { text: 'second' } },
    ]);
    expect(connectors).toEqual([
      expect.objectContaining({ id: 'new-3', from: { type: 'item', id: 'new-1', side: 'right' }, to: { type: 'item', id: 'new-2', side: 'left' }, label: 'next' }),
    ]);
  });
});

describe('serialising', () => {
  it('reads back what it wrote', () => {
    const copy = twoNotes();
    expect(parseCopied(serialiseCopied(copy))).toEqual(copy);
  });

  it('reads nothing from anything else', () => {
    expect(parseCopied('')).toBeUndefined();
    expect(parseCopied('{"items": 3}')).toBeUndefined();
    expect(parseCopied('not json')).toBeUndefined();
    expect(parseCopied(JSON.stringify({ items: [{ kind: 'sticky' }], connectors: [] }))).toBeUndefined();
  });
});

describe('plainText', () => {
  it("is the items' text and links, a paragraph each", () => {
    const copy = copied(
      [
        { item: item('a', 0, 0, { text: 'first' }), at: { x: 0, y: 0 } },
        { item: { ...item('b', 0, 0, { url: 'https://example.com' }), kind: 'link' }, at: { x: 0, y: 0 } },
        { item: { ...item('c', 0, 0, { sha256: 'abc' }), kind: 'image' }, at: { x: 0, y: 0 } },
      ],
      [],
    );
    expect(plainText(copy)).toBe('first\n\nhttps://example.com');
  });
});
