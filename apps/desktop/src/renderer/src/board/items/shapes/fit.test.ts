import { describe, expect, it } from 'vitest';
import { grownBox } from './fit';

describe('grownBox', () => {
  it('grows a straight shape downward from where it is', () => {
    expect(grownBox({ x: 10, y: 20, height: 100, rotation: 0 }, 160)).toEqual({ x: 10, y: 20, height: 160 });
  });

  it('places two grows in a row as the one, whichever box they start from', () => {
    const box = { x: 10, y: 20, height: 100, rotation: 30 };
    const first = grownBox(box, 160);
    const chained = grownBox({ ...box, ...first }, 220);
    const direct = grownBox(box, 220);
    expect(direct.x).toBeCloseTo(chained.x);
    expect(direct.y).toBeCloseTo(chained.y);
    expect(direct.height).toBe(220);
  });

  it("extends a turned shape's own bottom edge, holding its top edge", () => {
    // Upside down, its bottom edge is above: it grows upward.
    const upside = grownBox({ x: 10, y: 20, height: 100, rotation: 180 }, 160);
    expect(upside.x).toBeCloseTo(10);
    expect(upside.y).toBeCloseTo(-40);
    // On its side, its bottom edge is to the left: the centre moves that way by half of what it grew.
    const side = grownBox({ x: 10, y: 20, height: 100, rotation: 90 }, 160);
    expect(side.x).toBeCloseTo(-20);
    expect(side.y).toBeCloseTo(-10);
  });
});
