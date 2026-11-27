import { describe, expect, it } from 'vitest';
import type { WindowTarget } from '../../../preload/api';
import { closeWindow, minimiseWindow, popInWindow, popOutWindow, showWindow, switchWindow, type SessionWindows } from '../windows/session-windows';
import { windowedOf } from './agent-popup';
import { expandTile, pinnedToOpen, windowedExpanded, windowHolds, type ExpandedTiles } from './expanded';

// Every way into an agent's full screen (its session window shown on the board, popped out, or its pop-up) and every
// way out, run through the board's own window moves and its two restore steps: a tile pinned expanded is back at its
// place and size each time, and the other pinned tile is never touched.

const target = (id: string): WindowTarget => ({ kind: 'session', id, title: id });
const node = (id: string) => `agent:${id}`;
const pinned = new Set([node('pin'), node('other')]);
const present = new Set([node('pin'), node('other'), node('loose'), node('next')]);
const sizes = { [node('pin')]: { width: 1180, height: 750 }, [node('other')]: { width: 900, height: 560 } };

interface Board {
  expanded: ExpandedTiles;
  hidden: ExpandedTiles;
}

/** The board after its window effects settle for `windows` and the pop-up of `poppedUp`, as `useExpandedTiles` runs them. */
function settle(board: Board, windows: SessionWindows, poppedUp?: string): Board {
  let state = board;
  for (let pass = 0; pass < 4; pass += 1) {
    const windowed = windowedOf(windows, poppedUp);
    const next = windowedExpanded(state.expanded, state.hidden, windowed, present, pinned);
    const opening = pinnedToOpen(pinned, next.expanded, present, windowed, next.hidden);
    const expanded = opening.reduce((open, id) => expandTile(open, id, sizes), next.expanded);
    if (expanded === state.expanded && next.hidden === state.hidden) return state;
    state = { expanded, hidden: next.hidden };
  }
  return state;
}

const start = (): Board => settle({ expanded: [], hidden: [] }, []);
const sizeOf = (board: Board, id: string) => board.expanded.find((entry) => entry.id === node(id));

/** Where a way in leaves the windows and the pop-up. */
const WAYS_IN: Record<string, { windows: SessionWindows; poppedUp?: string }> = {
  // ⌘K ↵ / ⇧↵, Needs you, the inbox, a banner, a ticket tile and the header's Maximise all show its window on the board.
  'its window on the board': { windows: showWindow([], target('pin')) },
  'its pop-up': { windows: [], poppedUp: 'pin' },
  'its pop-out window': { windows: popOutWindow([], target('pin')) },
};

/** Where a way out leaves them, from the window shown on the board. */
const WAYS_OUT: Record<string, (windows: SessionWindows) => SessionWindows> = {
  'Esc, a click on the board, or Minimise (docked)': (windows) => minimiseWindow(windows, 'pin'),
  '⌘W or the close button': (windows) => closeWindow(windows, 'pin'),
  '⌘K to another agent, in the same window': (windows) => switchWindow(windows, 'pin', target('next')),
  '⌘K to another agent, its own window (docks this one)': (windows) => showWindow(windows, target('next')),
};

describe("a pinned tile through its agent's full screen", () => {
  it('starts with both pinned tiles open at their sizes', () => {
    const board = start();
    expect(sizeOf(board, 'pin')).toEqual({ id: node('pin'), ...sizes[node('pin')] });
    expect(sizeOf(board, 'other')).toEqual({ id: node('other'), ...sizes[node('other')] });
  });

  for (const [wayIn, opened] of Object.entries(WAYS_IN)) {
    it(`is off the board while ${wayIn} has its session, the other pinned tile left open`, () => {
      const inside = settle(start(), opened.windows, opened.poppedUp);
      expect(sizeOf(inside, 'pin')).toBeUndefined();
      expect(sizeOf(inside, 'other')).toEqual(sizeOf(start(), 'other'));
    });
  }

  for (const [wayOut, leave] of Object.entries(WAYS_OUT)) {
    it(`is back at its size after ${wayOut}`, () => {
      const inside = settle(start(), showWindow([], target('pin')));
      const left = settle(inside, leave(showWindow([], target('pin'))));
      expect(sizeOf(left, 'pin')).toEqual(sizeOf(start(), 'pin'));
      expect(sizeOf(left, 'other')).toEqual(sizeOf(start(), 'other'));
    });
  }

  it('is back from its pop-up closed, or ⌘K to another agent popped up', () => {
    const inside = settle(start(), [], 'pin');
    expect(sizeOf(settle(inside, []), 'pin')).toEqual(sizeOf(start(), 'pin'));
    expect(sizeOf(settle(inside, [], 'next'), 'pin')).toEqual(sizeOf(start(), 'pin'));
  });

  it('is back from its pop-up maximised to its window and left from there', () => {
    const popped = settle(start(), [], 'pin');
    const maximised = settle(popped, showWindow([], target('pin')));
    expect(sizeOf(maximised, 'pin')).toBeUndefined();
    expect(sizeOf(settle(maximised, minimiseWindow(showWindow([], target('pin')), 'pin')), 'pin')).toEqual(sizeOf(start(), 'pin'));
  });

  it('is back from its pop-out closed, or brought back to the board and left', () => {
    const out = popOutWindow([], target('pin'));
    const inside = settle(start(), out);
    expect(sizeOf(settle(inside, closeWindow(out, 'pin')), 'pin')).toEqual(sizeOf(start(), 'pin'));
    const back = popInWindow(out, target('pin'));
    const shown = settle(inside, back);
    expect(sizeOf(shown, 'pin')).toBeUndefined();
    expect(sizeOf(settle(shown, minimiseWindow(back, 'pin')), 'pin')).toEqual(sizeOf(start(), 'pin'));
  });

  it("is back when another agent's pop-up docks its window", () => {
    const inside = settle(start(), showWindow([], target('pin')));
    expect(sizeOf(settle(inside, minimiseWindow(showWindow([], target('pin')), 'pin'), 'next'), 'pin')).toEqual(sizeOf(start(), 'pin'));
  });

  it('opens no second entry for a tile its window still has in hidden, in the commit its window docks', () => {
    const inside = settle(start(), showWindow([], target('pin')));
    const docked = windowedOf(minimiseWindow(showWindow([], target('pin')), 'pin'), undefined);
    // The pin's effect runs on the hidden that came before the restore gave the tile back.
    expect(pinnedToOpen(pinned, inside.expanded, present, docked, inside.hidden)).toEqual([]);
  });

  it('leaves an unpinned tile compact while its window is docked, as before', () => {
    const loose = { expanded: [{ id: node('loose'), width: 800, height: 500 }], hidden: [] };
    const inside = settle(loose, showWindow([], target('loose')));
    const docked = settle(inside, minimiseWindow(showWindow([], target('loose')), 'loose'));
    expect(sizeOf(docked, 'loose')).toBeUndefined();
    expect(sizeOf(settle(docked, []), 'loose')).toEqual({ id: node('loose'), width: 800, height: 500 });
  });
});

describe('windowHolds', () => {
  const windowed = { open: new Set(['shown']), all: new Set(['shown', 'docked']) };
  it('holds a tile while its window is open, and a docked one only when it is not pinned', () => {
    expect(windowHolds('shown', windowed, new Set(['shown']))).toBe(true);
    expect(windowHolds('docked', windowed, new Set())).toBe(true);
    expect(windowHolds('docked', windowed, new Set(['docked']))).toBe(false);
    expect(windowHolds('none', windowed, new Set())).toBe(false);
  });
});
