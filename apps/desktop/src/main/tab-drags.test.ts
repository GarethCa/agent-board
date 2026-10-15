import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { TabMove } from '../preload/api';
import { boardRelay, dropPoint, mayMove, mayPopOut, outsideWindows } from './tab-drags';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, ipcMain: { on: vi.fn(), handle: vi.fn() }, screen: { getCursorScreenPoint: () => ({ x: 7, y: 9 }) } }));

describe('outsideWindows', () => {
  const board = { x: 0, y: 0, width: 1000, height: 800 };
  const popOut = { x: 1200, y: 100, width: 600, height: 400 };

  it('is false for a point over any of the windows, edges in', () => {
    expect(outsideWindows({ x: 500, y: 400 }, [board, popOut])).toBe(false);
    expect(outsideWindows({ x: 1300, y: 200 }, [board, popOut])).toBe(false);
    expect(outsideWindows({ x: 0, y: 0 }, [board])).toBe(false);
  });

  it('is true for a point clear of them all: the desktop, or between two windows', () => {
    expect(outsideWindows({ x: 1100, y: 300 }, [board, popOut])).toBe(true);
    expect(outsideWindows({ x: 1000, y: 800 }, [board])).toBe(true);
    expect(outsideWindows({ x: -5, y: 10 }, [])).toBe(true);
  });
});

describe('boardRelay', () => {
  /** A board window stand-in: what was sent to it, and whether it has gone. */
  const fakeBoard = (id: number) => {
    const sent: unknown[][] = [];
    const window = { isDestroyed: () => false, webContents: { id, isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args) } };
    return { window: window as unknown as BrowserWindow, sent };
  };

  it('sends to the board once it says it is listening, and keeps what came before for it', () => {
    const board = fakeBoard(1);
    const relay = boardRelay({ board: () => board.window, openBoard: () => board.window });
    relay.send('move', 'a');
    expect(board.sent).toEqual([]);
    relay.ready(board.window.webContents);
    expect(board.sent).toEqual([['move', 'a']]);
    relay.send('move', 'b');
    expect(board.sent).toEqual([['move', 'a'], ['move', 'b']]);
  });

  it("opens the board's window when it is closed, and sends to it once it listens: nothing is lost", () => {
    let open: ReturnType<typeof fakeBoard> | undefined;
    const opened = fakeBoard(2);
    const relay = boardRelay({ board: () => open?.window, openBoard: () => ((open = opened), opened.window) });
    relay.send('popOut', 'tab');
    relay.send('move', 'pane');
    expect(open).toBe(opened);
    relay.ready(opened.window.webContents);
    expect(opened.sent).toEqual([['popOut', 'tab'], ['move', 'pane']]);
  });

  it('waits for a new board to listen, after the one that listened closed', () => {
    let current = fakeBoard(1);
    const relay = boardRelay({ board: () => current.window, openBoard: () => current.window });
    relay.ready(current.window.webContents);
    current = fakeBoard(3);
    relay.send('move', 'a');
    expect(current.sent).toEqual([]);
    relay.ready(current.window.webContents);
    expect(current.sent).toEqual([['move', 'a']]);
  });

  it("hears only the board's own window say it listens: another window saying so changes nothing", () => {
    const board = fakeBoard(1);
    const popOut = fakeBoard(2);
    const relay = boardRelay({ board: () => board.window, openBoard: () => board.window });
    relay.ready(board.window.webContents);
    relay.ready(popOut.window.webContents);
    relay.send('move', 'a');
    expect(board.sent).toEqual([['move', 'a']]);
    expect(popOut.sent).toEqual([]);
  });

  it('tells whether a board is listening now', () => {
    const board = fakeBoard(1);
    const relay = boardRelay({ board: () => board.window, openBoard: () => board.window });
    expect(relay.listening()).toBe(false);
    relay.ready(board.window.webContents);
    expect(relay.listening()).toBe(true);
  });
});

describe('who may move what', () => {
  const agent = { kind: 'agent', id: 'a' } as const;
  const other = { kind: 'agent', id: 'b' } as const;
  const tabs = { kind: 'tabs', id: 't' } as const;
  const pr = { kind: 'pr', repo: 'acme/app', number: 7 } as const;
  const shellInto = (owner: typeof agent | typeof other): TabMove => ({ kind: 'tab', shellId: 's', to: { owner } });

  it('lets the board make any move', () => {
    expect(mayMove(shellInto(other), 'board')).toBe(true);
    expect(mayMove({ kind: 'pane', shellId: 's', sessionId: 'p', to: { tile: { zoneId: null, x: 0, y: 0 } } }, 'board')).toBe(true);
  });

  it('lets a popped-out window move only into its own window, or a tab that is only a place out of it', () => {
    expect(mayMove(shellInto(agent), agent)).toBe(true);
    expect(mayMove(shellInto(other), agent)).toBe(false);
    expect(mayMove({ kind: 'tab', shellId: 's', to: { tile: { zoneId: null, x: 0, y: 0 } } }, agent)).toBe(false);
    expect(mayMove({ kind: 'surface', surface: pr, from: other, to: { owner: tabs } }, tabs)).toBe(true);
    expect(mayMove({ kind: 'surface', surface: pr, from: tabs, to: null }, tabs)).toBe(true);
    expect(mayMove({ kind: 'surface', surface: pr, from: other, to: { owner: agent } }, tabs)).toBe(false);
  });

  it('lets nothing else move anything', () => {
    expect(mayMove(shellInto(agent), undefined)).toBe(false);
  });

  it('lets a drag pop out only from the board, or the popped-out window it was dragged from', () => {
    const drag = { kind: 'surface', surface: pr, from: agent } as const;
    expect(mayPopOut(drag, 'board')).toBe(true);
    expect(mayPopOut(drag, agent)).toBe(true);
    expect(mayPopOut(drag, other)).toBe(false);
    expect(mayPopOut(drag, undefined)).toBe(false);
  });
});

describe('dropPoint', () => {
  it("is where the drag's end said it was", () => {
    expect(dropPoint({ x: 300.4, y: 20.6 })).toEqual({ x: 300, y: 21 });
  });

  it('is the pointer when the end gave no place', () => {
    expect(dropPoint({ x: 0, y: 0 })).toEqual({ x: 7, y: 9 });
    expect(dropPoint(undefined)).toEqual({ x: 7, y: 9 });
    expect(dropPoint({ x: Number.NaN, y: 4 })).toEqual({ x: 7, y: 9 });
  });
});
