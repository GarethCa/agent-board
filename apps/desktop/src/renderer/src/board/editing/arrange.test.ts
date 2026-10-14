import { describe, expect, it } from 'vitest';
import { align, distribute, reorder } from './arrange';

const box = (id: string, x: number, y: number, width = 100, height = 50) => ({ id, x, y, width, height });

describe('align', () => {
  const boxes = [box('a', 0, 0, 100), box('b', 50, 100, 200), box('c', 300, 40, 50)];

  it('lines left edges up with the leftmost', () => {
    expect(Object.fromEntries(align(boxes, 'left'))).toEqual({ b: { x: 0, y: 100 }, c: { x: 0, y: 40 } });
  });

  it('lines right edges up with the rightmost', () => {
    expect(Object.fromEntries(align(boxes, 'right'))).toEqual({ a: { x: 250, y: 0 }, b: { x: 150, y: 100 } });
  });

  it('lines centres up on the middle of the selection', () => {
    // Spans 0..350: centre 175.
    expect(Object.fromEntries(align(boxes, 'centre'))).toEqual({ a: { x: 125, y: 0 }, b: { x: 75, y: 100 }, c: { x: 150, y: 40 } });
  });

  it('lines top, middle and bottom edges up', () => {
    expect(Object.fromEntries(align(boxes, 'top'))).toEqual({ b: { x: 50, y: 0 }, c: { x: 300, y: 0 } });
    expect(Object.fromEntries(align(boxes, 'bottom'))).toEqual({ a: { x: 0, y: 100 }, c: { x: 300, y: 100 } });
    // Spans 0..150: middle 75.
    expect(Object.fromEntries(align(boxes, 'middle'))).toEqual({ a: { x: 0, y: 50 }, b: { x: 50, y: 50 }, c: { x: 300, y: 50 } });
  });
});

describe('distribute', () => {
  it('spaces boxes evenly between the first and last, by their gaps', () => {
    const boxes = [box('a', 0, 0, 100), box('c', 400, 0, 100), box('b', 110, 0, 50)];
    // 500 wide in all, 250 of boxes: two gaps of 125.
    expect(Object.fromEntries(distribute(boxes, 'x'))).toEqual({ b: { x: 225, y: 0 } });
  });

  it('spaces vertically too', () => {
    const boxes = [box('a', 0, 0, 10, 10), box('b', 0, 15, 10, 10), box('c', 0, 100, 10, 10)];
    expect(Object.fromEntries(distribute(boxes, 'y'))).toEqual({ b: { x: 0, y: 50 } });
  });

  it('needs three to have anything to space', () => {
    expect(distribute([box('a', 0, 0), box('b', 300, 0)], 'x').size).toBe(0);
  });
});

describe('reorder', () => {
  const stack = [
    { id: 'a', z: 1 },
    { id: 'b', z: 2 },
    { id: 'c', z: 3 },
    { id: 'd', z: 4 },
  ];
  const order = (changes: Map<string, number>) =>
    stack
      .map(({ id, z }) => ({ id, z: changes.get(id) ?? z }))
      .toSorted((p, q) => p.z - q.z)
      .map(({ id }) => id)
      .join('');

  it('brings the selection to the front, keeping its own order', () => {
    expect(order(reorder(stack, new Set(['a', 'c']), 'front'))).toBe('bdac');
  });

  it('sends the selection to the back', () => {
    expect(order(reorder(stack, new Set(['b', 'd']), 'back'))).toBe('bdac');
  });

  it('brings each selected one forward past the next', () => {
    expect(order(reorder(stack, new Set(['a']), 'forward'))).toBe('bacd');
    expect(order(reorder(stack, new Set(['c', 'd']), 'forward'))).toBe('abcd');
    expect(order(reorder(stack, new Set(['a', 'b']), 'forward'))).toBe('cabd');
  });

  it('sends each selected one backward past the next', () => {
    expect(order(reorder(stack, new Set(['d']), 'backward'))).toBe('abdc');
    expect(order(reorder(stack, new Set(['a']), 'backward'))).toBe('abcd');
  });

  it('changes only the z values that must change, reusing the ones there', () => {
    const changes = reorder(stack, new Set(['c']), 'forward');
    expect(Object.fromEntries(changes)).toEqual({ c: 4, d: 3 });
  });

  it('numbers them afresh when z values tie or are missing', () => {
    const tied = [
      { id: 'a', z: null },
      { id: 'b', z: null },
      { id: 'c', z: 5 },
    ];
    const changes = reorder(tied, new Set(['a']), 'front');
    const z = (id: string) => changes.get(id) ?? tied.find((entry) => entry.id === id)!.z!;
    expect(z('b')).toBeLessThan(z('c'));
    expect(z('c')).toBeLessThan(z('a'));
  });
});
