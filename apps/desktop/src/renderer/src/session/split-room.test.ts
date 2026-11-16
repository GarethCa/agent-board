import { describe, expect, it } from 'vitest';
import { dividerStops, MIN_PANE_COLS, MIN_PANE_ROWS, nextStop, noRoomToSplit, restingRatio, snapRatio } from './split-room';

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

// At 13px, 120 columns are 936 px and 80 are 624.
/**
 * The columns xterm fits in a terminal side `px` wide, as its fit does: the pane's padding either side (12 px each) and
 * its scrollbar (14 px) are not columns.
 */
const fitted = (px: number, fontSize = 13) => Math.floor((px - 2 * 12 - 14) / (0.6 * fontSize));

describe('where a divider rests between a terminal and a page', () => {
  const wide = { width: 2560, fontSize: 13 };
  const laptop = { width: 1440, fontSize: 13 };

  it('gives the terminal 120 columns on a wide screen, as the terminal counts them, the page the rest, on either side', () => {
    expect(fitted(restingRatio({ ...wide, first: 'terminal', second: 'page' }) * 2560)).toBe(120);
    expect(fitted((1 - restingRatio({ ...wide, first: 'page', second: 'terminal' })) * 2560)).toBe(120);
    expect(fitted(restingRatio({ width: 2400, fontSize: 13, first: 'terminal', second: 'page' }) * 2400)).toBe(120);
  });

  it('halves a laptop screen, and two of a kind on any screen', () => {
    expect(restingRatio({ ...laptop, first: 'terminal', second: 'page' })).toBe(0.5);
    expect(restingRatio({ ...wide, first: 'terminal', second: 'terminal' })).toBe(0.5);
    expect(restingRatio({ ...wide, first: 'page', second: 'page' })).toBe(0.5);
  });

  it('grows the terminal side with its font', () => {
    expect(fitted(restingRatio({ width: 2560, fontSize: 16, first: 'terminal', second: 'page' }) * 2560, 16)).toBe(120);
  });
});

describe('the stops a double-click on a divider steps through', () => {
  const sides = { width: 2560, fontSize: 13, first: 'terminal', second: 'page' } as const;
  const atColumns = restingRatio(sides);

  it('steps the terminal side from 120 columns to half to a third, then round again', () => {
    const stops = dividerStops(sides);
    expect(stops).toHaveLength(3);
    expect(fitted(stops[0]! * 2560)).toBe(120);
    expect(stops.slice(1)).toEqual([0.5, 1 / 3]);
    expect(nextStop(stops[0]!, stops)).toBe(0.5);
    expect(nextStop(0.5, stops)).toBe(1 / 3);
    expect(nextStop(1 / 3, stops)).toBe(stops[0]);
  });

  it('starts at the first stop from anywhere else', () => {
    expect(nextStop(0.8, dividerStops(sides))).toBeCloseTo(atColumns);
  });

  it('counts the stops from the terminal side when it is the second', () => {
    const stops = dividerStops({ ...sides, first: 'page', second: 'terminal' });
    expect(stops[0]).toBeCloseTo(1 - atColumns);
    expect(stops[1]).toBe(0.5);
    expect(stops[2]).toBeCloseTo(2 / 3);
  });

  it('leaves out 120 columns where it would leave the other side under 80', () => {
    expect(dividerStops({ ...sides, width: 1440 })).toEqual([0.5, 1 / 3]);
  });
});

describe('a dragged divider snapping to 120 columns', () => {
  const sides = { width: 2560, fontSize: 13, first: 'terminal', second: 'page' } as const;
  const atColumns = restingRatio(sides) * 2560;

  it('snaps when let go within a few pixels of it, and not further off', () => {
    expect(snapRatio((atColumns + 10) / 2560, sides)).toBeCloseTo(atColumns / 2560);
    expect(snapRatio((atColumns - 10) / 2560, sides)).toBeCloseTo(atColumns / 2560);
    expect(snapRatio((atColumns + 40) / 2560, sides)).toBeCloseTo((atColumns + 40) / 2560);
  });

  it('leaves a divider be where 120 columns is no stop', () => {
    expect(snapRatio(0.4, { ...sides, width: 1440 })).toBe(0.4);
  });
});
