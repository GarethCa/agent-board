import { describe, expect, it } from 'vitest';
import { DEFAULT_CONNECTOR_LOOK, type BoardItem, type Connector } from '@agent-board/daemon/protocol';
import { copied, diagramCopy, mermaidOf, parseCopied, placed, plainText, serialiseCopied, skippedNotice } from './clipboard';

const item = (id: string, x: number, y: number, data: Record<string, unknown> = {}): BoardItem => ({
  id,
  kind: 'sticky',
  zoneId: 'zone',
  x: x - 1000,
  y: y - 1000,
  width: 100,
  height: 100,
  z: 1,
  rotation: 0,
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
  points: [{ x: 100, y: -40 }],
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

describe('copied', () => {
  it("keeps each item's angle, and a copy from before angles reads as straight", () => {
    const copy = copied([{ item: { ...item('a', 0, 0), rotation: 30 }, at: { x: 0, y: 0 } }], []);
    expect(copy.items[0]!.rotation).toBe(30);
    expect(placed(copy, { dx: 5, dy: 5 }, () => 'new').items[0]!.rotation).toBe(30);
    const older = JSON.stringify({ items: [{ ...copy.items[0]!, rotation: undefined }], connectors: [] });
    expect(parseCopied(older)?.items[0]!.rotation).toBe(0);
    expect(parseCopied(serialiseCopied({ items: [{ ...copy.items[0]!, rotation: 'x' as never }], connectors: [] }))).toBeUndefined();
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
      expect.objectContaining({
        id: 'new-3',
        from: { type: 'item', id: 'new-1', side: 'right' },
        to: { type: 'item', id: 'new-2', side: 'left' },
        label: 'next',
        // Its bends are kept from the middle of its ends, so they come with the copies as they are.
        points: [{ x: 100, y: -40 }],
      }),
    ]);
  });

  it('takes a connector copied before lines bent as having no bends', () => {
    const copy = twoNotes();
    const older = JSON.stringify({ ...copy, connectors: copy.connectors.map((connector) => ({ ...connector, points: undefined })) });
    expect(parseCopied(older)?.connectors[0]!.points).toEqual([]);
  });

  it('keeps a connector’s dash and end labels, and takes one copied before them as solid with none', () => {
    const copy = { ...twoNotes() };
    copy.connectors = copy.connectors.map((connector) => ({ ...connector, endEnd: 'triangle', dashed: true, startLabel: '1', endLabel: '0..*' }));
    expect(parseCopied(serialiseCopied(copy))?.connectors[0]).toMatchObject({ endEnd: 'triangle', dashed: true, startLabel: '1', endLabel: '0..*' });
    const older = JSON.stringify({
      ...copy,
      connectors: copy.connectors.map((connector) => Object.fromEntries(Object.entries(connector).filter(([key]) => !['dashed', 'startLabel', 'endLabel'].includes(key)))),
    });
    expect(parseCopied(older)?.connectors[0]).toMatchObject({ endEnd: 'triangle', label: 'next', dashed: false, startLabel: '', endLabel: '' });
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

describe('diagramCopy', () => {
  it('is the shapes a Mermaid diagram draws, laid out, and the connectors between them on the sides that face', () => {
    const copy = diagramCopy('flowchart TD\n  A[Start] -->|go| B{Ok?}')?.copy;
    expect(copy?.items.map(({ id, kind, x, y, rotation, data }) => ({ id, kind, x, y, rotation, shape: data.shape, text: data.text }))).toEqual([
      { id: 'A', kind: 'shape', x: 0, y: 0, rotation: 0, shape: 'rectangle', text: 'Start' },
      { id: 'B', kind: 'shape', x: 0, y: 176, rotation: 0, shape: 'diamond', text: 'Ok?' },
    ]);
    expect(copy?.connectors).toEqual([
      { ...DEFAULT_CONNECTOR_LOOK, id: expect.any(String), from: { type: 'item', id: 'A', side: 'bottom' }, to: { type: 'item', id: 'B', side: 'top' }, label: 'go', points: [] },
    ]);
  });

  it('pastes under new ids, its connectors joined to the copies', () => {
    let n = 0;
    const made = placed(diagramCopy('classDiagram\n  Animal <|-- Duck')!.copy, { dx: 0, dy: 0 }, () => `new-${(n += 1)}`);
    expect(made.items.map(({ id, data }) => `${id} ${String(data.text)}`)).toEqual(['new-1 Animal', 'new-2 Duck']);
    expect(made.connectors.map(({ from, to, endEnd }) => `${from.id} → ${to.id} ${endEnd}`)).toEqual(['new-2 → new-1 triangle']);
  });

  it('says what it left out, the first few lines cut short', () => {
    expect(diagramCopy('flowchart TD\n  A --> B\n  click A "x"')?.skipped).toEqual(['click A "x"']);
    expect(skippedNotice(['click A "x"'])).toBe('Drew the diagram without one line it can\'t draw: click A "x"');
    expect(skippedNotice(['a', 'b', 'c'.repeat(80), 'd', 'e'])).toBe(`Drew the diagram without 5 lines it can't draw: a; b; ${'c'.repeat(59)}…; and 2 more`);
  });

  it('is nothing for text that is not a diagram, or a diagram of nothing', () => {
    expect(diagramCopy('just some words')).toBeUndefined();
    expect(diagramCopy('flowchart TD')).toBeUndefined();
  });
});

describe('mermaidOf', () => {
  it('is the copied shapes and the connectors between them as Mermaid, other items left out', () => {
    const copy = copied(
      [
        { item: { ...item('a', 0, 0, { shape: 'rectangle', text: 'Start' }), kind: 'shape' }, at: { x: 0, y: 0 } },
        { item: { ...item('b', 200, 0, { shape: 'diamond', text: 'Ok?' }), kind: 'shape' }, at: { x: 200, y: 0 } },
        { item: item('c', 400, 0, { text: 'a sticky' }), at: { x: 400, y: 0 } },
      ],
      [connector('ab', 'a', 'b'), connector('bc', 'b', 'c')],
    );
    expect(mermaidOf(copy)).toBe('flowchart LR\n  n1["Start"]\n  n2{"Ok?"}\n  n1 -->|"next"| n2\n');
  });

  it('is nothing without a shape', () => {
    expect(mermaidOf(copied([{ item: item('c', 0, 0, { text: 'a sticky' }), at: { x: 0, y: 0 } }], []))).toBeUndefined();
  });
});
