import { describe, expect, it } from 'vitest';
import { capBites, clampPopup, dragPopup, fitPopup, parsePopupSize, POPUP_CAP, POPUP_LAPTOP, POPUP_MIN, POPUP_SIZE_KEY, popupRoom, popupSize, readPopupSize, splitPopupSize, writePopupSize } from './popup-size';

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

  it('is kept to the board it shows on, and the board less its margin stands in when there is none', () => {
    expect(popupSize(LAPTOP, null)).toEqual(LAPTOP);
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

  it('is dropped by a reset, which gives its default size back', () => {
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

describe('the pop-up split, two agents side by side', () => {
  it('grows to the board, 16px in from each of its edges, on any board', () => {
    expect(splitPopupSize(LAPTOP)).toEqual(LAPTOP);
    expect(splitPopupSize(ULTRAWIDE)).toEqual(ULTRAWIDE);
    expect(splitPopupSize({ width: -4, height: 10 })).toEqual({ width: 0, height: 10 });
  });

  it('grows past the size dragged to, and that size comes back as the split ends', () => {
    const saved = { width: 900, height: 600 };
    expect(popupSize(LAPTOP, saved, { split: true })).toEqual(LAPTOP);
    expect(popupSize(LAPTOP, saved)).toEqual(saved);
    expect(popupSize(LAPTOP, null, { split: true })).toEqual(LAPTOP);
    expect(popupSize(LAPTOP, null)).toEqual(LAPTOP);
  });
});

describe('on a board the cap leaves alone, a laptop, the pop-up opens to its full width', () => {
  // A 1512 x 982 MacBook window's board less its margins: the 16:10 fit would leave about 60px of board either side.
  const MACBOOK = { width: 1480, height: 840 };

  it('opens as wide as the room, not held to 16:10, and as tall as it', () => {
    expect(fitPopup(MACBOOK).width).toBeLessThan(MACBOOK.width);
    expect(popupSize(MACBOOK, null)).toEqual(MACBOOK);
  });

  it('on a tall board, is as wide as the room with the 16:10 height, so it is never taller than wide', () => {
    expect(popupSize({ width: 968, height: 1168 }, null)).toEqual({ width: 968, height: 605 });
  });

  it("drags out from its side edge to the room's edge, and no further", () => {
    const narrowed = dragPopup(popupSize(MACBOOK, null), 'e', -300, 0, popupRoom(MACBOOK, false));
    expect(narrowed.width).toBe(880);
    expect(dragPopup(narrowed, 'e', 600, 0, popupRoom(MACBOOK, false))).toEqual(MACBOOK);
    expect(dragPopup(narrowed, 'w', -600, 0, popupRoom(MACBOOK, false))).toEqual(MACBOOK);
  });

  it('counts a 16" MacBook Pro at its default and a 14" at More Space as laptops: full width, no cap, no fill', () => {
    for (const room of [{ width: 1696, height: 960 }, { width: 1768, height: 1004 }]) {
      expect(capBites(room)).toBe(false);
      expect(popupSize(room, null)).toEqual(room);
      expect(popupSize(room, null, { split: true })).toEqual(room);
    }
  });

  it('set to fill from a wide screen, still opens to the full width', () => {
    expect(popupSize(MACBOOK, null, { fill: true })).toEqual(MACBOOK);
  });
});

describe('on a wide screen the pop-up stops at 1600px, unless set to fill it', () => {
  // A 3440px board less its margins, and the widest board the cap leaves alone, a laptop's (1832px), and one a pixel
  // wider.
  const WIDE = { width: 3408, height: 1408 };
  const AT = { width: 1800, height: 1000 };
  const PAST = { width: 1801, height: 1000 };

  it('bites only on a board wider than a laptop’s, 1832px', () => {
    expect(POPUP_CAP).toBe(1600);
    expect(POPUP_LAPTOP).toBe(1800);
    expect(capBites(LAPTOP)).toBe(false);
    expect(capBites(AT)).toBe(false);
    expect(capBites(PAST)).toBe(true);
    expect(capBites(WIDE)).toBe(true);
  });

  it('opens 1600px wide on a 3440px board, with its full height', () => {
    expect(popupSize(WIDE, null)).toEqual({ width: 1600, height: 1408 });
    expect(popupRoom(WIDE, false)).toEqual({ width: 1600, height: 1408 });
  });

  it('split, is two panes of about 800px', () => {
    expect(popupSize(WIDE, null, { split: true })).toEqual({ width: 1600, height: 1408 });
  });

  it('set to fill, fills the board as before, split or not', () => {
    expect(popupSize(WIDE, null, { fill: true })).toEqual(fitPopup(WIDE));
    expect(popupSize(WIDE, null, { split: true, fill: true })).toEqual(WIDE);
    expect(popupRoom(WIDE, true)).toEqual(WIDE);
  });

  it('keeps a dragged size past the cap: the cap holds only the size it opens at', () => {
    const saved = { width: 2400, height: 900 };
    expect(popupSize(WIDE, saved)).toEqual(saved);
    expect(popupSize(WIDE, saved, { fill: true })).toEqual(saved);
    expect(popupSize(WIDE, { width: 4000, height: 900 })).toEqual({ width: 3408, height: 900 });
    expect(popupSize(WIDE, { width: 1200, height: 900 })).toEqual({ width: 1200, height: 900 });
  });

  it("drags its side edges out to the board's edges, past the cap", () => {
    expect(dragPopup(popupSize(WIDE, null), 'e', 2000, 0, WIDE)).toEqual(WIDE);
  });

  it('on a wide but short board (a 1920 x 1080 monitor) opens at the cap with its full height, and fill fills it', () => {
    // Wider than a laptop's, but its 16:10 fit is narrower than the cap.
    const room = { width: 1888, height: 951 };
    expect(popupSize(room, null)).toEqual({ width: 1600, height: 951 });
    expect(popupSize(room, null, { fill: true })).toEqual(room);
    expect(dragPopup(popupSize(room, null), 'w', -400, 0, room)).toEqual(room);
  });

  it('on a 1440p board, fill is the 16:10 fit as before', () => {
    expect(popupSize({ width: 2528, height: 1310 }, null, { fill: true })).toEqual({ width: 2096, height: 1310 });
  });

  it("changes nothing on a laptop's board, 1832px or less", () => {
    for (const room of [LAPTOP, AT]) {
      for (const split of [false, true]) {
        expect(popupSize(room, null, { split })).toEqual(popupSize(room, null, { split, fill: true }));
        expect(popupSize(room, { width: 900, height: 500 }, { split })).toEqual(popupSize(room, { width: 900, height: 500 }, { split, fill: true }));
      }
    }
    expect(popupSize(AT, null, { split: true })).toEqual(AT);
  });
});
