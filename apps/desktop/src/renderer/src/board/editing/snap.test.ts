import { describe, expect, it } from 'vitest';
import { snapToGrid, snapToGuides } from './snap';

const rect = (x: number, y: number, width = 100, height = 50) => ({ x, y, width, height });

describe('snapToGuides', () => {
  it('moves nothing and draws nothing with nothing near', () => {
    expect(snapToGuides(rect(0, 0), [rect(500, 500)], 6)).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it('lines a left edge up with a left edge within the threshold, with a guide spanning both', () => {
    const { dx, dy, guides } = snapToGuides(rect(103, 0), [rect(100, 200)], 6);
    expect(dx).toBe(-3);
    expect(dy).toBe(0);
    expect(guides).toContainEqual({ axis: 'x', at: 100, from: 0, to: 250 });
  });

  it('lines centres up', () => {
    // Centre 52 against 50.
    const { dx } = snapToGuides(rect(2, 300, 100), [rect(0, 0, 100)], 6);
    expect(dx).toBe(-2);
  });

  it('lines a right edge up with a left edge', () => {
    // Right edge 196 against 200.
    const { dx } = snapToGuides(rect(96, 300), [rect(200, 0)], 6);
    expect(dx).toBe(4);
  });

  it('snaps top and bottom edges and middles on y', () => {
    const { dy, guides } = snapToGuides(rect(400, 205), [rect(0, 200)], 6);
    expect(dy).toBe(-5);
    expect(guides.filter((guide) => guide.axis === 'y').map((guide) => guide.at)).toEqual(expect.arrayContaining([200, 225, 250]));
  });

  it('takes the nearest line on each axis', () => {
    const { dx } = snapToGuides(rect(105, 0), [rect(100, 300), rect(104, 600)], 6);
    expect(dx).toBe(-1);
  });

  it('leaves it be past the threshold', () => {
    expect(snapToGuides(rect(110, 0), [rect(100, 300)], 6).dx).toBe(0);
  });

  it('draws one guide per line, across every object on it', () => {
    const { guides } = snapToGuides(rect(100, 100), [rect(100, 0), rect(100, 400)], 6);
    const left = guides.filter((guide) => guide.axis === 'x' && guide.at === 100);
    expect(left).toEqual([{ axis: 'x', at: 100, from: 0, to: 450 }]);
  });
});

describe('snapToGrid', () => {
  it('moves the top-left corner to the nearest grid point', () => {
    expect(snapToGrid({ x: 27, y: 31 }, 20)).toEqual({ dx: -7, dy: 9 });
    expect(snapToGrid({ x: -9, y: 40 }, 20)).toEqual({ dx: 9, dy: 0 });
  });
});
