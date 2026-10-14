import { describe, expect, it } from 'vitest';
import { centreOf, clamp, contains, overlaps } from './geometry';

describe('overlaps', () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };

  it('is true when two rects share any area', () => {
    expect(overlaps(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(overlaps(a, { x: 2, y: 2, width: 2, height: 2 })).toBe(true);
  });

  it('is false for rects that only touch along an edge or a corner', () => {
    expect(overlaps(a, { x: 10, y: 0, width: 5, height: 5 })).toBe(false);
    expect(overlaps(a, { x: 0, y: 10, width: 5, height: 5 })).toBe(false);
    expect(overlaps(a, { x: 10, y: 10, width: 5, height: 5 })).toBe(false);
  });

  it('is false for rects apart', () => {
    expect(overlaps(a, { x: 20, y: 0, width: 5, height: 5 })).toBe(false);
    expect(overlaps(a, { x: -6, y: 0, width: 5, height: 5 })).toBe(false);
  });
});

describe('contains', () => {
  const rect = { x: 10, y: 20, width: 30, height: 40 };

  it('holds a point inside or on the edge', () => {
    expect(contains(rect, { x: 25, y: 40 })).toBe(true);
    expect(contains(rect, { x: 10, y: 20 })).toBe(true);
    expect(contains(rect, { x: 40, y: 60 })).toBe(true);
  });

  it('does not hold a point outside', () => {
    expect(contains(rect, { x: 9, y: 40 })).toBe(false);
    expect(contains(rect, { x: 25, y: 61 })).toBe(false);
  });
});

describe('centreOf', () => {
  it('is the middle of the rect', () => {
    expect(centreOf({ x: 10, y: 20, width: 30, height: 40 })).toEqual({ x: 25, y: 40 });
  });
});

describe('clamp', () => {
  it('keeps a value within its bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
