import { describe, expect, it } from 'vitest';
import { isCutShort, overlayFrame } from './whole-line';

describe('a line cut short', () => {
  it('is one whose text runs past its width, by more than a pixel’s rounding', () => {
    expect(isCutShort({ scrollWidth: 320, clientWidth: 200 })).toBe(true);
    expect(isCutShort({ scrollWidth: 201, clientWidth: 200 })).toBe(false);
    expect(isCutShort({ scrollWidth: 200, clientWidth: 200 })).toBe(false);
  });

  it('is never one drawn with no width', () => {
    expect(isCutShort({ scrollWidth: 40, clientWidth: 0 })).toBe(false);
  });
});

describe('where its whole line is laid', () => {
  it('over the cell, as wide, in the node’s own pixels at the board’s zoom', () => {
    const node = { left: 100, top: 50, width: 680, height: 488 };
    expect(overlayFrame({ left: 140, top: 90, width: 200, height: 20 }, node, 1)).toEqual({ left: 40, top: 40, width: 200 });
    expect(overlayFrame({ left: 140, top: 90, width: 200, height: 20 }, node, 2)).toEqual({ left: 20, top: 20, width: 100 });
  });

  it('as drawn, when the scale is unknown', () => {
    expect(overlayFrame({ left: 10, top: 10, width: 50, height: 10 }, { left: 0, top: 0, width: 0, height: 0 }, 0)).toEqual({ left: 10, top: 10, width: 50 });
  });
});
