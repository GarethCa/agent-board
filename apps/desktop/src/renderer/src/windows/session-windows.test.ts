import { describe, expect, it } from 'vitest';
import {
  closeWindow,
  minimiseWindow,
  popInWindow,
  popOutWindow,
  poppedOut,
  restoreWindows,
  showWindow,
  shownWindow,
  switchWindow,
  type SessionWindows,
} from './session-windows';
import type { WindowTarget } from '../../../preload/api';

const session = (id: string, title: string): WindowTarget => ({ kind: 'session', id, title });

const placements = (windows: SessionWindows) => windows.map((entry) => `${entry.id}:${entry.placement}`);

describe('session windows', () => {
  it('shows a session, docking the one shown before', () => {
    const one = showWindow([], session('a', 'Agent A'));
    expect(one).toEqual([{ kind: 'session', id: 'a', title: 'Agent A', placement: 'shown' }]);

    const two = showWindow(one, session('b', 'Agent B'));
    expect(placements(two)).toEqual(['a:docked', 'b:shown']);
    expect(shownWindow(two)?.id).toBe('b');
  });

  it('restores a docked session in its dock slot, docking the shown one', () => {
    const windows = showWindow(showWindow(showWindow([], session('a', 'A')), session('b', 'B')), session('c', 'C'));

    expect(placements(showWindow(windows, session('a', 'A')))).toEqual(['a:shown', 'b:docked', 'c:docked']);
  });

  it('keeps the latest title', () => {
    expect(showWindow(showWindow([], session('a', 'old')), session('a', 'new'))[0]!.title).toBe('new');
  });

  it('minimises to the dock, leaving nothing shown', () => {
    const windows = minimiseWindow(showWindow([], session('a', 'A')), 'a');
    expect(placements(windows)).toEqual(['a:docked']);
    expect(shownWindow(windows)).toBeUndefined();
  });

  it('closes a window, shown or docked', () => {
    const windows = showWindow(showWindow([], session('a', 'A')), session('b', 'B'));
    expect(placements(closeWindow(windows, 'a'))).toEqual(['b:shown']);
    expect(closeWindow(closeWindow(windows, 'a'), 'b')).toEqual([]);
  });

  it('pops a window out of the board, and showing it again leaves it popped out', () => {
    const popped = popOutWindow(showWindow(showWindow([], session('a', 'A')), session('b', 'B')), session('b', 'B'));
    expect(placements(popped)).toEqual(['a:docked', 'b:popped']);
    expect(shownWindow(popped)).toBeUndefined();

    expect(placements(showWindow(popped, session('b', 'B')))).toEqual(['a:docked', 'b:popped']);
  });

  it('pops out a window the board never opened, from its tile, keeping the one shown', () => {
    const popped = popOutWindow(showWindow([], session('a', 'A')), session('b', 'B'));
    expect(placements(popped)).toEqual(['a:shown', 'b:popped']);
  });

  it('pops a window back in shown, docking the one shown meanwhile', () => {
    const popped = popOutWindow(showWindow([], session('a', 'A')), session('a', 'A'));
    const meanwhile = showWindow(popped, session('b', 'B'));

    expect(placements(popInWindow(meanwhile, session('a', 'A')))).toEqual(['a:shown', 'b:docked']);
  });

  it('pops in a window the board did not know was out, e.g. after the board reloaded', () => {
    expect(popInWindow([], session('a', 'A'))).toEqual([{ kind: 'session', id: 'a', title: 'A', placement: 'shown' }]);
  });

  it('remembers whether a window shows a session or a shell tile', () => {
    const windows = showWindow(showWindow([], session('a', 'A')), { kind: 'shell', id: 's', title: 'Shell 1' });
    expect(windows.map((entry) => entry.kind)).toEqual(['session', 'shell']);
    expect(popOutWindow(windows, { kind: 'shell', id: 's', title: 'Shell 1' })[1]).toEqual({ kind: 'shell', id: 's', title: 'Shell 1', placement: 'popped' });
  });

  it('leaves unknown sessions alone', () => {
    const windows = showWindow([], session('a', 'A'));
    expect(minimiseWindow(windows, 'x')).toBe(windows);
    expect(closeWindow(windows, 'x')).toBe(windows);
  });
});

describe('restoring session windows', () => {
  const saved = [
    { kind: 'session', id: 'a', title: 'A', placement: 'docked' },
    { kind: 'shell', id: 's', title: 'Shell 1', placement: 'shown' },
    { kind: 'session', id: 'p', title: 'P', placement: 'popped' },
  ];

  it('takes back the windows as they were saved', () => {
    expect(restoreWindows(saved, [])).toEqual(saved);
  });

  it('keeps what the board opened with on top, shown', () => {
    expect(placements(restoreWindows(saved, showWindow([], session('a', 'A'))))).toEqual(['a:shown', 's:docked', 'p:popped']);
    expect(placements(restoreWindows(saved, showWindow([], session('new', 'New'))))).toEqual(['a:docked', 's:docked', 'p:popped', 'new:shown']);
    // Saved as popped out, then popped back in while the board was closed.
    expect(placements(restoreWindows(saved, showWindow([], session('p', 'P'))))).toEqual(['a:docked', 's:docked', 'p:shown']);
  });

  it('keeps every window opened before the saved ones came back, as it is now', () => {
    // A notification's agent shown, and another window minimised, while the saved list was still being read.
    const opened = minimiseWindow(showWindow(showWindow([], session('early', 'Early')), session('n', 'N')), 'n');
    const shownNow = showWindow(opened, session('early', 'Early'));

    expect(placements(restoreWindows(saved, shownNow))).toEqual(['a:docked', 's:docked', 'p:popped', 'early:shown', 'n:docked']);
    // One popped out meanwhile stays out; one saved as out but docked now is docked.
    expect(placements(restoreWindows(saved, [{ ...session('x', 'X'), placement: 'popped' }]))).toEqual(['a:docked', 's:shown', 'p:popped', 'x:popped']);
    expect(placements(restoreWindows(saved, [{ ...session('p', 'P'), placement: 'docked' }]))).toEqual(['a:docked', 's:shown', 'p:docked']);
  });

  it('drops what it cannot read, repeats, and every shown window after the first', () => {
    const messy = [
      ...saved,
      { kind: 'session', id: 'a', title: 'again', placement: 'docked' },
      { kind: 'session', id: 'b', title: 'B', placement: 'shown' },
      { kind: 'tab', id: 'c', title: 'C', placement: 'docked' },
      { kind: 'session', id: 'd', placement: 'docked' },
      'nonsense',
    ];
    expect(placements(restoreWindows(messy, []))).toEqual(['a:docked', 's:shown', 'p:popped', 'b:docked']);
    expect(restoreWindows({ not: 'a list' }, [])).toEqual([]);
    expect(restoreWindows(null, [])).toEqual([]);
  });

  it('swaps the shown window to another session in place, leaving nothing in the dock', () => {
    const windows = showWindow(showWindow([], session('a', 'A')), session('b', 'B'));
    const switched = switchWindow(windows, 'b', session('c', 'C'));
    expect(placements(switched)).toEqual(['a:docked', 'c:shown']);
    expect(shownWindow(switched)?.title).toBe('C');
  });

  it('takes a docked session out of the dock when switching to it', () => {
    const windows = showWindow(showWindow([], session('a', 'A')), session('b', 'B'));
    expect(placements(switchWindow(windows, 'b', session('a', 'A')))).toEqual(['a:shown']);
  });

  it('leaves a popped-out session in its own window, and names those for stepping to go past', () => {
    const windows = popOutWindow(showWindow(showWindow([], session('c', 'C')), session('a', 'A')), session('b', 'B'));
    expect(switchWindow(windows, 'a', session('b', 'B'))).toBe(windows);
    expect([...poppedOut(windows)]).toEqual(['b']);
  });

  it('just shows the session if the window to switch from is gone', () => {
    expect(placements(switchWindow([], 'a', session('b', 'B')))).toEqual(['b:shown']);
  });
});
