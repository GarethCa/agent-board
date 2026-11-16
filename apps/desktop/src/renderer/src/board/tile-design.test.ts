import { describe, expect, it } from 'vitest';
import { TILE_DESIGN_CHOICES, TILE_DESIGNS, tileDesignOf } from './tile-design';

describe('the tile design', () => {
  it("is today's design until another is picked", () => {
    expect(tileDesignOf(undefined)).toBe('current');
  });

  it('reads back each design Settings offers', () => {
    for (const design of TILE_DESIGN_CHOICES) expect(tileDesignOf(design)).toBe(design);
  });

  it("reads one Settings doesn't offer as today's, so the switch always has a choice picked", () => {
    for (const design of TILE_DESIGNS) expect(TILE_DESIGN_CHOICES).toContain(tileDesignOf(design));
  });

  it("falls back to today's design for one this version doesn't know", () => {
    expect(tileDesignOf('stained-glass')).toBe('current');
  });

  it("offers today's design first, then Porthole and Shelf", () => {
    expect(TILE_DESIGN_CHOICES).toEqual(['current', 'porthole', 'shelf']);
  });
});
