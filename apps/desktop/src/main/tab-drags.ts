import { BrowserWindow, ipcMain, screen, type Rectangle, type WebContents } from 'electron';
import { headless } from './background';
import { sendToAllWindows } from './broadcast';
import type { WindowOwner } from '@agent-board/daemon/protocol';
import { TAB_DRAG_IPC, type ScreenPoint, type TabDrag, type TabMove } from '../preload/api';

export interface TabDragIpcOptions {
  /** The board's window, if it is open: it makes every move, so its one undo history has them all. */
  board(): BrowserWindow | undefined;
  /** Opens the board's window. */
  openBoard(): BrowserWindow;
  /** Whose window a popped-out window's page is, if it is one: what its drags and moves may act on. */
  poppedOwner(contents: WebContents): WindowOwner | undefined;
}

/** Who asks main for something of the drags: the board's window, a popped-out one (whose window it is), or neither. */
export type DragSender = 'board' | WindowOwner | undefined;

const same = (a: { kind: string; id: string }, b: { kind: string; id: string }) => a.kind === b.kind && a.id === b.id;

/**
 * Whether `sender` may have the board make `move`: the board makes any; a popped-out window only one dropped on it,
 * into its own window (or, for a tab that is only a place in a window, out of it). Nothing else may move another
 * window's tabs.
 */
export function mayMove(move: TabMove, sender: DragSender): boolean {
  if (sender === 'board') return true;
  if (sender === undefined) return false;
  if (move.kind === 'surface') return (move.to !== null && same(move.to.owner, sender)) || (move.from !== null && same(move.from, sender));
  return 'owner' in move.to && same(move.to.owner, sender);
}

/** Whether `sender` may end `drag` untaken, for it to pop out: the board, or the popped-out window it was dragged from. */
export const mayPopOut = (drag: TabDrag, sender: DragSender): boolean => sender === 'board' || (sender !== undefined && same(drag.from, sender));

/**
 * Dragging tabs between OS windows (slice 4; ADR-0001). The drag itself is the platform's: Chromium carries
 * it to every window of the app. Here every window hears what is dragged (its data can't be read until it drops), a
 * drag no window took that was let go outside them all is popped out where the pointer is, and a popped-out window's
 * moves and ⌘Z go to the board's window, which makes them. With the board's window closed, a move or pop-out opens it
 * and waits for it: a drag is never lost.
 */
export function registerTabDragIpc(options: TabDragIpcOptions): void {
  const relay = boardRelay(options);
  const senderOf = (contents: WebContents): DragSender => (options.board()?.webContents === contents ? 'board' : options.poppedOwner(contents));
  ipcMain.handle(TAB_DRAG_IPC.ready, (event) => relay.ready(event.sender));

  // The window a drag began in: if it closes before the drag ends, main ends it everywhere.
  let source: WebContents | undefined;
  const watched = new WeakSet<WebContents>();
  ipcMain.handle(TAB_DRAG_IPC.set, (event, drag: TabDrag | null) => {
    if (drag !== null) source = event.sender;
    else if (source === event.sender) source = undefined;
    if (drag !== null && !watched.has(event.sender)) {
      watched.add(event.sender);
      event.sender.once('destroyed', () => {
        if (source !== event.sender) return;
        source = undefined;
        sendToAllWindows(TAB_DRAG_IPC.changed, null);
      });
    }
    sendToAllWindows(TAB_DRAG_IPC.changed, drag);
  });

  ipcMain.handle(TAB_DRAG_IPC.untaken, (event, drag: TabDrag, at: ScreenPoint | undefined) => {
    if (!mayPopOut(drag, senderOf(event.sender))) throw new Error('a window pops out only what was dragged from it');
    const point = dropPoint(at);
    // Only the windows there to drop on: not a hidden or minimised one, nor one full screen in a Space of its own while
    // another has the keyboard. Headless, every window is hidden, and painted offscreen where it would be.
    const windows = BrowserWindow.getAllWindows().filter(
      (window) => !window.isDestroyed() && (headless || window.isVisible()) && !window.isMinimized() && !(window.isFullScreen() && !window.isFocused()),
    );
    // Let go over a window that didn't take it (its title bar, say) is a drag given up.
    if (!outsideWindows(point, windows.map((window) => window.getBounds()))) return;
    relay.send(TAB_DRAG_IPC.popOut, drag, point);
  });

  ipcMain.handle(TAB_DRAG_IPC.move, (event, move: TabMove) => {
    if (!mayMove(move, senderOf(event.sender))) throw new Error('a window moves only tabs dropped on it, or out of it');
    relay.send(TAB_DRAG_IPC.makeMove, move);
  });
  // An undo has nothing to undo in a board's window opened for it, whose history starts empty.
  ipcMain.handle(TAB_DRAG_IPC.history, (event, action: 'undo' | 'redo') => {
    if (senderOf(event.sender) === undefined) throw new Error('only the app’s windows step through the board’s history');
    if (!relay.listening()) throw new Error('the board’s window is closed, and with it what could be undone');
    relay.send(TAB_DRAG_IPC.replay, action);
  });
  ipcMain.handle(TAB_DRAG_IPC.settled, () => sendToAllWindows(TAB_DRAG_IPC.settledAll));
}

/**
 * Sends to the board's window once it is listening (`ready`, as it loads), keeping what comes before for it, and
 * opening the board's window if it is closed: a popped-out window's moves wait for it rather than going nowhere.
 */
export function boardRelay({ board, openBoard }: Pick<TabDragIpcOptions, 'board' | 'openBoard'>) {
  let listening: WebContents | undefined;
  const waiting: unknown[][] = [];
  const isListening = () => {
    const window = board();
    return window !== undefined && !window.isDestroyed() && listening !== undefined && !listening.isDestroyed() && window.webContents === listening;
  };
  return {
    send(channel: string, ...args: unknown[]) {
      if (isListening()) {
        listening!.send(channel, ...args);
        return;
      }
      waiting.push([channel, ...args]);
      const window = board();
      if (window === undefined || window.isDestroyed()) openBoard();
    },
    ready(contents: WebContents) {
      // Only the board's own window listens: any other saying so would leave its moves waiting for nothing.
      if (board()?.webContents !== contents) return;
      listening = contents;
      if (!isListening()) return;
      for (const message of waiting.splice(0)) contents.send(...(message as [string, ...unknown[]]));
    },
    listening: isListening,
  };
}

/** Whether the point on the screen is over none of the windows. */
export function outsideWindows(point: ScreenPoint, windows: readonly Rectangle[]): boolean {
  return !windows.some(({ x, y, width, height }) => point.x >= x && point.x < x + width && point.y >= y && point.y < y + height);
}

/**
 * Where a drag no window took ended, on the screen: as its end said, else (no place given, as Chromium sometimes
 * gives, and as a script's drag always does) where the pointer is now.
 */
export function dropPoint(at: ScreenPoint | undefined): ScreenPoint {
  const given = at !== undefined && Number.isFinite(at.x) && Number.isFinite(at.y) && (at.x !== 0 || at.y !== 0);
  return given ? { x: Math.round(at.x), y: Math.round(at.y) } : screen.getCursorScreenPoint();
}
