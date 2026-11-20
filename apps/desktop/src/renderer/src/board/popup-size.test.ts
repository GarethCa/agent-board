import { describe, expect, it } from 'vitest';
import { clampPopup, dragPopup, fitPopup, parsePopupSize, POPUP_MIN, POPUP_SIZE_KEY, popupSize, readPopupSize, writePopupSize } from './popup-size';

// The room each board leaves the pop-up: the board less the 16px margin round it.
const LAPTOP = { width: 1408, height: 828 };
const ULTRAWIDE = { width: 3408, height: 1348 };

describe("an agent's pop-up fits the board", () => {
  it('is the largest 16:10 box in the room the board leaves it', () => {
    // A laptop's: its height is the limit.
    expect(fitPopup(LAPTOP)).toEqual({ width: 1325, height: 828 });
    // A tall board's: its width is.
    expect(fitPopup({ width: 968, height: 1168 })).toEqual({ width: 968, height: 605 });
  });

  it('on an ultrawide is a centred 16:10 box as tall as the board, with board on either side', () => {
    const fit = fitPopup(ULTRAWIDE);
    expect(fit).toEqual({ width: 2157, height: 1348 });
    expect(fit.width).toBeLessThan(ULTRAWIDE.width);
  });

  it('has no pixel cap', () => {
    expect(fitPopup({ width: 5968, height: 3468 })).toEqual({ width: 5549, height: 3468 });
  });

  it('never runs negative where there is no room', () => {
    expect(fitPopup({ width: 0, height: 0 })).toEqual({ width: 0, height: 0 });
    expect(fitPopup({ width: -4, height: -4 })).toEqual({ width: 0, height: 0 });
  });
});

describe('a size dragged by hand', () => {
  it('stays centred: an edge moved a pixel grows or shrinks it by two', () => {
    const start = { width: 1000, height: 600 };
    expect(dragPopup(start, 'e', 50, 0, LAPTOP)).toEqual({ width: 1100, height: 600 });
    expect(dragPopup(start, 'w', 50, 0, LAPTOP)).toEqual({ width: 900, height: 600 });
    expect(dragPopup(start, 's', 0, 40, LAPTOP)).toEqual({ width: 1000, height: 680 });
    expect(dragPopup(start, 'n', 0, 40, LAPTOP)).toEqual({ width: 1000, height: 520 });
    expect(dragPopup(start, 'se', 10, 10, LAPTOP)).toEqual({ width: 1020, height: 620 });
    expect(dragPopup(start, 'nw', 10, 10, LAPTOP)).toEqual({ width: 980, height: 580 });
    expect(dragPopup(start, 'ne', 10, 10, LAPTOP)).toEqual({ width: 1020, height: 580 });
    expect(dragPopup(start, 'sw', 10, 10, LAPTOP)).toEqual({ width: 980, height: 620 });
  });

  it('an edge moves only its own side: a side edge leaves the height be', () => {
    expect(dragPopup({ width: 1000, height: 600 }, 'e', 30, 200, LAPTOP).height).toBe(600);
    expect(dragPopup({ width: 1000, height: 600 }, 'n', 200, 30, LAPTOP).width).toBe(1000);
  });

  it('never grows past the room, and never shrinks past its minimum', () => {
    expect(dragPopup({ width: 1000, height: 600 }, 'se', 2000, 2000, LAPTOP)).toEqual({ width: 1408, height: 828 });
    expect(dragPopup({ width: 1000, height: 600 }, 'nw', 2000, 2000, LAPTOP)).toEqual(POPUP_MIN);
  });

  it('in a room smaller than the minimum, is the room', () => {
    expect(clampPopup({ width: 100, height: 100 }, { width: 368, height: 268 })).toEqual({ width: 368, height: 268 });
  });

  it('is kept to the board it shows on, and the fit stands in when there is none', () => {
    expect(popupSize(LAPTOP, null)).toEqual(fitPopup(LAPTOP));
    expect(popupSize(LAPTOP, { width: 900, height: 500 })).toEqual({ width: 900, height: 500 });
    // A size dragged on the ultrawide, shown on the laptop.
    expect(popupSize(LAPTOP, { width: 3000, height: 1300 })).toEqual({ width: 1408, height: 828 });
  });
});

/** A storage as the browser's, in memory. */
function memory(seed: Record<string, string> = {}) {
  const items = new Map(Object.entries(seed));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

describe('the size kept for every pop-up', () => {
  it('is kept and read back, rounded to whole pixels', () => {
    const storage = memory();
    writePopupSize({ width: 900.4, height: 500.6 }, storage);
    expect(storage.items.get(POPUP_SIZE_KEY)).toBe('{"width":900,"height":501}');
    expect(readPopupSize(storage)).toEqual({ width: 900, height: 501 });
  });

  it('is dropped by a reset, which gives the fit back', () => {
    const storage = memory({ [POPUP_SIZE_KEY]: '{"width":900,"height":500}' });
    writePopupSize(null, storage);
    expect(readPopupSize(storage)).toBeNull();
  });

  it('reads anything that is not a size as none', () => {
    for (const text of [null, '', 'not json', '42', 'null', '{"width":900}', '{"width":-1,"height":500}', '{"width":"900","height":500}']) expect(parsePopupSize(text), String(text)).toBeNull();
  });

  it('holds up where storage is blocked', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readPopupSize(blocked)).toBeNull();
    expect(() => writePopupSize({ width: 900, height: 500 }, blocked)).not.toThrow();
  });
});
