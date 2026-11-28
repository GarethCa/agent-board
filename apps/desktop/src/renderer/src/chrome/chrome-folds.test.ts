import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromeFolds, islandsWidth, onOwnRow, pickFolds, rowShift, toolbarShift, watchZone, type OwnRow, type TopRow } from './chrome-folds';

describe('the top row’s folds', () => {
  it('folds nothing in a wide window, then each step below its width', () => {
    expect(chromeFolds(1280)).toBe('');
    expect(chromeFolds(1240)).toBe('');
    expect(chromeFolds(1239)).toBe('1240');
    expect(chromeFolds(1099)).toBe('1240 1100');
    expect(chromeFolds(959)).toBe('1240 1100 960');
  });

  it('takes the islands’ width as the window’s, less the room the Captain’s pane takes beside the board', () => {
    expect(islandsWidth(1280, 1280, 1280)).toBe(1280);
    expect(islandsWidth(1280, 1280, 920)).toBe(920);
    expect(chromeFolds(islandsWidth(1280, 1280, 920))).toBe('1240 1100 960');
  });

  it('never counts a flow wider than the board as room', () => {
    expect(islandsWidth(1280, 1280, 1300)).toBe(1280);
  });

  it('keeps the toolbar in the board’s middle where it clears both islands', () => {
    expect(toolbarShift({ leftEnd: 300, rightStart: 1000, toolbar: 300, centre: 640 })).toBe(0);
  });

  it('moves the toolbar the least way that clears an island, keeping a gap either side', () => {
    // The board's middle puts the toolbar over the left island, so it moves right; over the right one, it moves left.
    expect(toolbarShift({ leftEnd: 300, rightStart: 720, toolbar: 390, centre: 460 })).toBe(300 + 8 - (460 - 195));
    expect(toolbarShift({ leftEnd: 100, rightStart: 600, toolbar: 300, centre: 500 })).toBe(600 - 8 - 300 - (500 - 150));
  });

  it('says the toolbar doesn’t fit where the islands leave it too little room, so the row folds further', () => {
    expect(toolbarShift({ leftEnd: 352, rightStart: 655, toolbar: 393, centre: 460 })).toBeUndefined();
    expect(toolbarShift({ leftEnd: 252, rightStart: 655, toolbar: 387, centre: 460 })).toBe(252 + 8 - (460 - 193.5));
  });

  it('keeps a wider least gap where it is asked to, as Classic asks for its islands’ inset', () => {
    // Fits with 8 px either side, but not with 14: Classic folds its drawing tools instead of letting the islands meet.
    expect(toolbarShift({ leftEnd: 261, rightStart: 806, toolbar: 529, centre: 550 })).toBe(261 + 8 - (550 - 264.5));
    expect(toolbarShift({ leftEnd: 261, rightStart: 806, toolbar: 529, centre: 550 }, 14)).toBeUndefined();
    expect(toolbarShift({ leftEnd: 261, rightStart: 806, toolbar: 435, centre: 550 }, 14)).toBe(0);
  });

  it('centres a toolbar on its own row under the islands, kept inside the board with the gap either side', () => {
    expect(rowShift({ toolbar: 300, centre: 320, start: 0, end: 640 }, 14)).toBe(0);
    // The Captain's pane narrows the board from the right: its middle moves, and the toolbar with it.
    expect(rowShift({ toolbar: 300, centre: 300, start: 0, end: 600 }, 14)).toBe(0);
    // Off-centre where the middle would put it past an edge.
    expect(rowShift({ toolbar: 600, centre: 200, start: 0, end: 640 }, 14)).toBe(14 - (200 - 300));
    expect(rowShift({ toolbar: 500, centre: 560, start: 100, end: 800 }, 14)).toBe(800 - 14 - 500 - (560 - 250));
    // Wider than the board less its gaps: from its start.
    expect(rowShift({ toolbar: 700, centre: 320, start: 0, end: 640 }, 14)).toBe(14 - (320 - 350));
  });
});

describe('which folds the top row takes', () => {
  /** What each fold saves, in px, from the left island, the toolbar or the right island. */
  const SAVES: Record<string, { left?: number; toolbar?: number; right?: number }> = {
    title: { left: 80 },
    find: { left: 40 },
    'needs-word': { right: 90 },
    draw: { toolbar: 120 },
    'draw-word': { toolbar: 40 },
    words: { toolbar: 100 },
  };
  /** A 640 px board whose islands and toolbar, `widths` wide unfolded, narrow by what each fold in `folds` saves. */
  const measuring = (widths: { left: number; toolbar: number; right: number }) => (folds: string): TopRow & OwnRow => {
    const saved = (part: 'left' | 'toolbar' | 'right') => folds.split(' ').reduce((sum, token) => sum + (SAVES[token]?.[part] ?? 0), 0);
    return { leftEnd: widths.left - saved('left'), rightStart: 640 - widths.right + saved('right'), toolbar: widths.toolbar - saved('toolbar'), centre: 320, start: 0, end: 640 };
  };

  it('takes no fit fold where the toolbar fits between the islands', () => {
    expect(pickFolds('1240', measuring({ left: 100, toolbar: 300, right: 100 }), 14)).toEqual({ folds: '1240', shift: 0 });
  });

  it('takes as few fit folds as let the toolbar fit, and moves it the least way clear', () => {
    const picked = pickFolds('', measuring({ left: 300, toolbar: 330, right: 160 }), 14);
    expect(picked.folds).toBe('title draw');
    expect(picked.shift).toBeGreaterThan(0);
  });

  it('puts the toolbar on its own row where no fold lets it fit between the islands, unfolding what its row has room for', () => {
    // As at 640 px with the traffic lights pushing the board menu in: every fold leaves the toolbar too little room. On
    // its own row the board's name still goes, as the islands would meet without it, but the toolbar keeps its tools.
    const picked = pickFolds('1240 1100 960', measuring({ left: 330, toolbar: 560, right: 300 }), 14);
    expect(picked).toEqual({ folds: '1240 1100 960 title row', shift: 0 });
  });

  it('on its own row, folds the islands only as far as keeps them clear of each other, and the toolbar as far as the board needs', () => {
    const picked = pickFolds('', measuring({ left: 420, toolbar: 700, right: 300 }), 14);
    // The name's fold leaves the islands 340 and 340, closer than 14; Find's clears them. 700 is wider than the board less
    // its gaps (612), and Draw's fold brings it to 580.
    expect(picked.folds).toBe('title find draw row');
    expect(picked.shift).toBe(0);
  });

  it('folds by width alone where the row has no islands to measure', () => {
    expect(pickFolds('1240', () => undefined, 14)).toEqual({ folds: '1240', shift: 0 });
  });

  it('says which folds put the toolbar on its own row', () => {
    expect(onOwnRow('1240 title row')).toBe(true);
    expect(onOwnRow('1240 title draw')).toBe(false);
  });
});

describe('the top row and the traffic lights’ safe zone', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('folds again when the zone changes, as leaving full screen brings the lights back with nothing resized, and not for other style changes', () => {
    const properties = new Map<string, string>([['--traffic-lights-right', '0px']]);
    const root = { style: { getPropertyValue: (name: string) => properties.get(name) ?? '' } };
    let changed = () => {};
    const observed: unknown[] = [];
    vi.stubGlobal('document', { documentElement: root });
    vi.stubGlobal(
      'MutationObserver',
      class {
        constructor(callback: () => void) {
          changed = callback;
        }
        observe(target: unknown, options: unknown) {
          observed.push(target, options);
        }
        disconnect() {}
      },
    );
    const onChange = vi.fn();
    watchZone(onChange);
    expect(observed).toEqual([root, { attributes: true, attributeFilter: ['style'] }]);

    properties.set('--accent', 'red');
    changed();
    expect(onChange).not.toHaveBeenCalled();
    properties.set('--traffic-lights-right', '78px');
    changed();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
