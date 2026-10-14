import { app, BrowserWindow, ipcMain, screen, type Rectangle } from 'electron';
import { revealWindow } from './background';
import { sendToAllWindows } from './broadcast';
import { WINDOW_IPC, WINDOW_QUERY, type PopOutEnd, type WindowTarget } from '../preload/api';
import { VIEW_KEYS, viewSaver } from '../shared/view-saver';
import type { ViewState } from './view';

/** How long after a popped-out window stops moving or resizing its place is saved. */
const SAVE_BOUNDS_DELAY_MS = 300;

/** A popped-out window's size when it has no saved place. */
const POP_OUT_SIZE = { width: 960, height: 640 };

export interface WindowIpcOptions {
  /** Opens a renderer window loaded with `query`, at `x`, `y` if given. */
  open(
    query: Record<string, string>,
    options: { title: string; width: number; height: number; x?: number; y?: number },
  ): BrowserWindow;
  /** The daemon's view state, where popped-out windows' places are kept (`VIEW_KEYS.popOutBounds`), by window ID. */
  view: ViewState;
  /** Whether the board's window is open. */
  hasBoard(): boolean;
  /** Opens the board's window, with `showing`'s window shown on it. */
  openBoard(showing: WindowTarget): void;
}

/**
 * The session window IPC: popping a session window out into its own OS window, one per session or shell tile, and
 * back in. Every window hears when a popped-out one goes away, so the board can show it again or forget it. Popping
 * back in with the board closed opens the board. A popped-out window reopens where it was (`VIEW_KEYS.popOutBounds`), and
 * the windows the app closes as it quits are not reported as gone: the board reopens them at its next start.
 */
export function registerWindowIpc({ open, view, hasBoard, openBoard }: WindowIpcOptions): void {
  const popped = new Map<string, { window: BrowserWindow; target: WindowTarget; end: PopOutEnd }>();
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

  ipcMain.handle(WINDOW_IPC.popOut, async (_event, target: WindowTarget, reveal: boolean) => {
    const existing = popped.get(target.id);
    if (existing !== undefined) {
      if (reveal) revealWindow(existing.window);
      return;
    }
    const { id, kind, title } = target;
    const place = onScreen((await loadPlaces())[id]);
    // Asked twice while the places were loading: the first opened it.
    const opened = popped.get(id);
    if (opened !== undefined) return reveal ? revealWindow(opened.window) : undefined;
    const window = open({ [WINDOW_QUERY.popOut]: id, [WINDOW_QUERY.kind]: kind, [WINDOW_QUERY.title]: title }, { title, ...(place ?? POP_OUT_SIZE) });
    const entry = { window, target, end: 'closed' as PopOutEnd };
    popped.set(id, entry);
    const remember = () => {
      if (!window.isDestroyed()) setPlace(id, window.getBounds());
    };
    window.on('move', remember);
    window.on('resize', remember);
    window.on('closed', () => {
      if (popped.get(id) !== entry) return;
      popped.delete(id);
      // Closed by the quit, not the user: the board still has it out, to reopen there next time.
      if (quitting) return;
      setPlace(id, undefined);
      sendToAllWindows(WINDOW_IPC.returned, target, entry.end);
    });
  });

  ipcMain.handle(WINDOW_IPC.popIn, (_event, id: string) => {
    const entry = popped.get(id);
    if (entry === undefined) return;
    entry.end = 'popIn';
    if (!hasBoard()) openBoard(entry.target);
    entry.window.close();
  });

  ipcMain.handle(WINDOW_IPC.close, (_event, id: string) => popped.get(id)?.window.close());

  ipcMain.handle(WINDOW_IPC.isFullScreen, (event) => BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false);
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
