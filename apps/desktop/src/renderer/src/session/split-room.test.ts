import { describe, expect, it } from 'vitest';
import { MIN_PANE_COLS, MIN_PANE_ROWS, noRoomToSplit } from './split-room';

// At 13px a cell is about 7.8 × 15.6 px, so a pane of 20 × 5 cells is about 156 × 78.
describe('whether a pane has room to split', () => {
  it('lets a big pane split either way', () => {
    expect(noRoomToSplit({ width: 800, height: 500 }, 'horizontal', 13)).toBeUndefined();
    expect(noRoomToSplit({ width: 800, height: 500 }, 'vertical', 13)).toBeUndefined();
  });

  it('refuses a split whose halves would be under the minimum columns, or rows', () => {
    expect(noRoomToSplit({ width: 300, height: 500 }, 'horizontal', 13)).toMatch(new RegExp(`${MIN_PANE_COLS} columns`));
    expect(noRoomToSplit({ width: 800, height: 140 }, 'vertical', 13)).toMatch(new RegExp(`${MIN_PANE_ROWS} rows`));
  });

  it('only counts the side being split', () => {
    expect(noRoomToSplit({ width: 100, height: 500 }, 'vertical', 13)).toBeUndefined();
    expect(noRoomToSplit({ width: 800, height: 40 }, 'horizontal', 13)).toBeUndefined();
  });

  it('grows with the terminal font', () => {
    expect(noRoomToSplit({ width: 400, height: 500 }, 'horizontal', 13)).toBeUndefined();
    expect(noRoomToSplit({ width: 400, height: 500 }, 'horizontal', 24)).toBeDefined();
  });
});
