import { describe, expect, it } from 'vitest';
import { fadeEdges, foldTo, heightPulled, keptFrame, scrollToShow } from './card-size';

const sizes = { folded: { width: 128, height: 132 }, open: { width: 340, height: 220 } };

describe('foldTo', () => {
  it('folds to the icon, keeping the size the card had open', () => {
    expect(foldTo({ width: 480, height: 600, data: {} }, true, sizes)).toEqual({ size: sizes.folded, kept: { openSize: { width: 480, height: 600 } } });
  });

  it('unfolds to the size it kept, or the card’s own for one that kept none', () => {
    expect(foldTo({ width: 128, height: 132, data: { openSize: { width: 480, height: 600 } } }, false, sizes)).toEqual({ size: { width: 480, height: 600 }, kept: {} });
    expect(foldTo({ width: 128, height: 132, data: {} }, false, sizes)).toEqual({ size: sizes.open, kept: {} });
    expect(foldTo({ width: 128, height: 132, data: { openSize: { width: 'wide' } } }, false, sizes)).toEqual({ size: sizes.open, kept: {} });
  });
});

describe('fadeEdges', () => {
  it('fades no edge of a list that fits', () => {
    expect(fadeEdges({ scrollTop: 0, clientHeight: 200, scrollHeight: 200 })).toBeUndefined();
    expect(fadeEdges({ scrollTop: 0, clientHeight: 200, scrollHeight: 201 })).toBeUndefined();
  });

  it('fades the edges with rows past them', () => {
    expect(fadeEdges({ scrollTop: 0, clientHeight: 200, scrollHeight: 500 })).toBe('bottom');
    expect(fadeEdges({ scrollTop: 120, clientHeight: 200, scrollHeight: 500 })).toBe('both');
    expect(fadeEdges({ scrollTop: 300, clientHeight: 200, scrollHeight: 500 })).toBe('top');
  });
});

describe('scrollToShow', () => {
  const list = { scrollTop: 100, clientHeight: 200 };
  it('leaves a row in view where it is, and scrolls just far enough to one above or below', () => {
    expect(scrollToShow(list, { top: 120, bottom: 160 })).toBe(100);
    expect(scrollToShow(list, { top: 40, bottom: 80 })).toBe(40);
    expect(scrollToShow(list, { top: 330, bottom: 370 })).toBe(170);
  });
  it('shows the top of a row taller than the list', () => {
    expect(scrollToShow(list, { top: 400, bottom: 700 })).toBe(400);
  });
});

describe('keptFrame', () => {
  const frame = { x: 10, y: 20, width: 360, height: 330 };

  it('keeps the saved height of a card grown round its rows when only its width was pulled', () => {
    expect(keptFrame(frame, { grown: 330, saved: 104 })).toEqual({ x: 10, y: 20, width: 360, height: 104 });
    expect(keptFrame({ ...frame, height: 330.6 }, { grown: 330, saved: 104 })).toMatchObject({ height: 104 });
  });

  it('keeps the height the handles gave once its height was pulled', () => {
    expect(keptFrame({ ...frame, height: 450 }, { grown: 330, saved: 104 })).toEqual({ ...frame, height: 450 });
    expect(keptFrame({ ...frame, height: 200 }, { grown: 330, saved: 104 })).toEqual({ ...frame, height: 200 });
  });

  it('keeps the frame as given on a card that did not grow', () => {
    expect(keptFrame(frame, { grown: undefined, saved: 104 })).toEqual(frame);
  });

  it('counts a pixel of rounding as no pull', () => {
    expect(heightPulled(104.5, 104)).toBe(false);
    expect(heightPulled(110, 104)).toBe(true);
  });
});
