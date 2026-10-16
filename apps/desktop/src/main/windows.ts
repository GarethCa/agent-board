import { app, BrowserWindow, ipcMain, screen, type Rectangle, type WebContents } from 'electron';
import type { WindowOwner } from '@agent-board/daemon/protocol';
import { revealWindow } from './background';
import { sendToAllWindows } from './broadcast';
import { WINDOW_IPC, WINDOW_QUERY, type BoardRequest, type PopOutEnd, type PopOutSwitch, type ScreenPoint, type WindowTarget } from '../preload/api';
import { VIEW_KEYS, viewSaver } from '../shared/view-saver';
import type { ViewState } from './view';

/** How long after a popped-out window stops moving or resizing its place is saved. */
const SAVE_BOUNDS_DELAY_MS = 300;

/** A popped-out window's size when it has no saved place. */
const POP_OUT_SIZE = { width: 960, height: 640 };

/** Where in a window popped out by a drag the pointer is let go: on its tab strip, near its start. */
const DROPPED_GRIP = { x: 120, y: 48 };

export interface WindowIpcOptions {
  /** Opens a renderer window loaded with `query`, at `x`, `y` if given. */
  open(
    query: Record<string, string>,
    options: { title: string; width: number; height: number; x?: number; y?: number },
  ): BrowserWindow;
  /** The daemon's view state, where popped-out windows' places are kept (`VIEW_KEYS.popOutBounds`), by window ID. */
  view: ViewState;
  /** The board's window, while it is open. */
  board(): BrowserWindow | undefined;
  /** Opens the board's window, with `showing`'s window shown on it, if given. */
  openBoard(showing?: WindowTarget): BrowserWindow;
}

/**
 * The session window IPC: popping a session window out into its own OS window, one per session or shell tile, and
 * back in. Every window hears when a popped-out one goes away, so the board can show it again or forget it. Popping
 * back in with the board closed opens the board. A popped-out window reopens where it was (`VIEW_KEYS.popOutBounds`), and
 * the windows the app closes as it quits are not reported as gone: the board reopens them at its next start. From its
 * ⌘K switcher, a popped-out window shows another session in its place, or asks the board to do what it can't.
 */
export function registerWindowIpc({ open, view, board, openBoard }: WindowIpcOptions): { poppedOwner(contents: WebContents): WindowOwner | undefined } {
  const popped = new Map<string, { window: BrowserWindow; target: WindowTarget; end: PopOutEnd }>();
  /** The popped-out window whose page is `contents`, if it is one. */
  const entryOf = (contents: WebContents) => [...popped.values()].find((each) => !each.window.isDestroyed() && each.window.webContents === contents);
  let quitting = false;
  app.on('before-quit', () => (quitting = true));

  /** Each popped-out window's place, by ID: read from the daemon once, then kept here and saved on every change. */
  let places: Promise<Record<string, Rectangle>> | undefined;
  const loadPlaces = () =>
    (places ??= view.get(VIEW_KEYS.popOutBounds).then(placesFrom, (): Record<string, Rectangle> => ({})));
  const savePlaces = viewSaver((value) => view.set(VIEW_KEYS.popOutBounds, value), SAVE_BOUNDS_DELAY_MS);
  const setPlace = (id: string, place: Rectangle | undefined) =>
    void loadPlaces().then((all) => {
      if (place === undefined) delete all[id];
      else all[id] = place;
      savePlaces(all);
    });

  ipcMain.handle(WINDOW_IPC.popOut, async (_event, target: WindowTarget, reveal: boolean, at: ScreenPoint | undefined) => {
    /** One already out: moved to where a drag let it go, if one did, and brought forward if asked. */
    const again = (window: BrowserWindow) => {
      if (at !== undefined) window.setBounds(placedAt(at, window.getBounds()));
      if (reveal) revealWindow(window);
    };
    const existing = popped.get(target.id);
    if (existing !== undefined) return again(existing.window);
    const { id, kind, title } = target;
    // Dragged out, it opens where it was let go, at the size it last had.
    const saved = onScreen((await loadPlaces())[id]);
    const place = at === undefined ? saved : placedAt(at, saved ?? POP_OUT_SIZE);
    // Asked twice while the places were loading: the first opened it.
    const opened = popped.get(id);
    if (opened !== undefined) return again(opened.window);
    const window = open({ [WINDOW_QUERY.popOut]: id, [WINDOW_QUERY.kind]: kind, [WINDOW_QUERY.title]: title }, { title, ...(place ?? POP_OUT_SIZE) });
    const entry = { window, target, end: 'closed' as PopOutEnd };
    popped.set(id, entry);
    // By the session it shows now: the switcher may have changed it.
    const remember = () => {
      if (!window.isDestroyed()) setPlace(entry.target.id, window.getBounds());
    };
    window.on('move', remember);
    window.on('resize', remember);
    window.on('closed', () => {
      const shown = entry.target;
      if (popped.get(shown.id) !== entry) return;
      popped.delete(shown.id);
      // Closed by the quit, not the user: the board still has it out, to reopen there next time.
      if (quitting) return;
      setPlace(shown.id, undefined);
      sendToAllWindows(WINDOW_IPC.returned, shown, entry.end);
    });
  });

  // The window switched is the one that asked: no window re-targets another.
  ipcMain.handle(WINDOW_IPC.switchPopOut, (event, target: WindowTarget): PopOutSwitch => {
    // Out in its own window already: that one comes forward, and this one stays as it is.
    const out = popped.get(target.id);
    if (out !== undefined) {
      revealWindow(out.window);
      return 'forward';
    }
    const entry = entryOf(event.sender);
    if (entry === undefined) return 'gone';
    const from = entry.target;
    popped.delete(from.id);
    entry.target = target;
    popped.set(target.id, entry);
    entry.window.setTitle(target.title);
    setPlace(from.id, undefined);
    setPlace(target.id, entry.window.getBounds());
    sendToAllWindows(WINDOW_IPC.switched, from, target);
    return 'switched';
  });

  // One request waits at a time, taken by the board once it listens: it may be opening for it.
  let request: BoardRequest | null = null;
  ipcMain.handle(WINDOW_IPC.boardRequest, (_event, asked: BoardRequest) => {
    const window = board() ?? openBoard();
    revealWindow(window);
    request = asked;
    window.webContents.send(WINDOW_IPC.boardRequested);
  });
  ipcMain.handle(WINDOW_IPC.takeBoardRequest, () => {
    const taken = request;
    request = null;
    return taken;
  });

  ipcMain.handle(WINDOW_IPC.popIn, (_event, id: string) => {
    const entry = popped.get(id);
    if (entry === undefined) return;
    entry.end = 'popIn';
    if (board() === undefined) openBoard(entry.target);
    entry.window.close();
  });

  ipcMain.handle(WINDOW_IPC.close, (_event, id: string) => popped.get(id)?.window.close());

  ipcMain.handle(WINDOW_IPC.isFullScreen, (event) => BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false);

  return {
    /** Whose window a popped-out window's page shows, if it is one's: an agent's, a shell tile's or a tab window's. */
    poppedOwner(contents) {
      const entry = entryOf(contents);
      if (entry === undefined) return undefined;
      const { kind, id } = entry.target;
      return kind === 'session' ? { kind: 'agent', id } : { kind, id };
    },
  };
}

/**
 * A window of `size` with its tab strip under `at` (where a tab dragged out of a window was let go), kept on the
 * display there.
 */
function placedAt(at: ScreenPoint, size: { width: number; height: number }): Rectangle {
  const area = screen.getDisplayNearestPoint(at).workArea;
  return fitPlace(at, size, area);
}

/** `placedAt` on the display whose work area is `area`. */
export function fitPlace(at: ScreenPoint, { width, height }: { width: number; height: number }, area: Rectangle): Rectangle {
  const along = (point: number, grip: number, length: number, from: number, room: number) => Math.round(Math.max(from, Math.min(point - grip, from + room - length)));
  return { x: along(at.x, DROPPED_GRIP.x, width, area.x, area.width), y: along(at.y, DROPPED_GRIP.y, height, area.y, area.height), width, height };
}

/** The place if it is still on a display (one may have been unplugged since), else undefined. */
function onScreen(place: Rectangle | undefined): Rectangle | undefined {
  if (place === undefined) return undefined;
  const area = screen.getDisplayMatching(place).workArea;
  const overlaps =
    place.x < area.x + area.width && place.x + place.width > area.x && place.y < area.y + area.height && place.y + place.height > area.y;
  return overlaps ? place : undefined;
}

/** The saved places that are rectangles: a damaged value never reaches the screen's maths. */
function placesFrom(saved: unknown): Record<string, Rectangle> {
  if (typeof saved !== 'object' || saved === null) return {};
  const isRectangle = (place: unknown): place is Rectangle =>
    typeof place === 'object' &&
    place !== null &&
    (['x', 'y', 'width', 'height'] as const).every((side) => Number.isFinite((place as Record<string, unknown>)[side])) &&
    (place as Rectangle).width > 0 &&
    (place as Rectangle).height > 0;
  return Object.fromEntries(Object.entries(saved).filter(([, place]) => isRectangle(place)));
}
