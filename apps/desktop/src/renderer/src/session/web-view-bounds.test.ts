import { describe, expect, it } from 'vitest';
import { overlap, sameBounds, viewBounds } from './web-view-bounds';

const viewport = { width: 1000, height: 800 };

describe("where a web tab's page is drawn", () => {
  it("is its area of the window, its edges at whole pixels", () => {
    expect(viewBounds({ left: 10.4, top: 20.6, width: 300.2, height: 200.5 }, viewport)).toEqual({ x: 10, y: 21, width: 301, height: 200 });
  });

  it('is cut to the window, so a tile half off it draws only its part inside', () => {
    expect(viewBounds({ left: -100, top: 700, width: 300, height: 200 }, viewport)).toEqual({ x: 0, y: 700, width: 200, height: 100 });
  });

  it('is nowhere when none of it is in the window, or it has no size (a tab not showing)', () => {
    expect(viewBounds({ left: 1200, top: 0, width: 300, height: 200 }, viewport)).toBeNull();
    expect(viewBounds({ left: 0, top: 0, width: 0, height: 0 }, viewport)).toBeNull();
  });

  it('tells a move from no change', () => {
    expect(sameBounds({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 })).toBe(true);
    expect(sameBounds({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 5 })).toBe(false);
    expect(sameBounds(null, null)).toBe(true);
    expect(sameBounds(null, { x: 1, y: 2, width: 3, height: 4 })).toBe(false);
  });
});

describe('an overlay over a web tab', () => {
  const bounds = { x: 100, y: 100, width: 200, height: 100 };

  it('meets its page where their boxes cross', () => {
    expect(overlap({ left: 250, top: 50, right: 400, bottom: 150 }, bounds)).toEqual({ x: 250, y: 100, width: 50, height: 50 });
  });

  it('misses it when they only touch, or are apart', () => {
    expect(overlap({ left: 300, top: 100, right: 400, bottom: 200 }, bounds)).toBeNull();
    expect(overlap({ left: 0, top: 0, right: 50, bottom: 50 }, bounds)).toBeNull();
  });
});
