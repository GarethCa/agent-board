import { describe, expect, it } from 'vitest';
import { DEFAULT_DETAILS_WIDTH, MIN_DETAILS_WIDTH, clampDetailsWidth, detailsAfterDrag, detailsAfterKey, maxDetailsWidth } from './details-width';

describe('the details strip width', () => {
  it('allows at most half the window, and never less than its minimum', () => {
    expect(maxDetailsWidth(1000)).toBe(500);
    expect(maxDetailsWidth(300)).toBe(MIN_DETAILS_WIDTH);
  });

  it('clamps to the limits, and is the default for a width that is not a number', () => {
    expect(clampDetailsWidth(900, 1000)).toBe(500);
    expect(clampDetailsWidth(250, 1000)).toBe(250);
    expect(clampDetailsWidth(NaN, 1000)).toBe(DEFAULT_DETAILS_WIDTH);
  });

  it('follows a drag, collapsing to the rail below the minimum', () => {
    expect(detailsAfterDrag(320, 1000)).toEqual({ collapsed: false, width: 320 });
    expect(detailsAfterDrag(MIN_DETAILS_WIDTH, 1000)).toEqual({ collapsed: false, width: MIN_DETAILS_WIDTH });
    expect(detailsAfterDrag(MIN_DETAILS_WIDTH - 1, 1000)).toEqual({ collapsed: true });
    expect(detailsAfterDrag(800, 1000)).toEqual({ collapsed: false, width: 500 });
  });

  it('steps with the arrow keys, collapsing past the minimum and opening again from the rail', () => {
    expect(detailsAfterKey('ArrowRight', 300, false, 1000)).toEqual({ collapsed: false, width: 316 });
    expect(detailsAfterKey('ArrowLeft', 300, false, 1000)).toEqual({ collapsed: false, width: 284 });
    expect(detailsAfterKey('ArrowLeft', MIN_DETAILS_WIDTH + 4, false, 1000)).toEqual({ collapsed: false, width: MIN_DETAILS_WIDTH });
    expect(detailsAfterKey('ArrowLeft', MIN_DETAILS_WIDTH, false, 1000)).toEqual({ collapsed: true });
    expect(detailsAfterKey('ArrowLeft', 300, true, 1000)).toBeUndefined();
    expect(detailsAfterKey('ArrowRight', 300, true, 1000)).toEqual({ collapsed: false, width: MIN_DETAILS_WIDTH });
    expect(detailsAfterKey('ArrowRight', 500, false, 1000)).toEqual({ collapsed: false, width: 500 });
    expect(detailsAfterKey('a', 300, false, 1000)).toBeUndefined();
  });
});
