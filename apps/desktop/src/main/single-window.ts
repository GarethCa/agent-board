import type { BrowserWindow, WebContents } from 'electron';
import { revealWindow } from './background';

export interface SingleWindowOptions {
  /** Opens a renderer window loaded with `query`. */
  open(
    query: Record<string, string>,
    options: { title: string; width: number; height: number; x?: number; y?: number; parent?: BrowserWindow },
  ): BrowserWindow;
  /** The board's window, while it is open. */
  board(): BrowserWindow | undefined;
  /** Whether the board is full screen; the window's own answer unless a test has said otherwise. */
  isFullScreen?(window: BrowserWindow): boolean;
}

/** One app window of a kind, as the Settings and Overview windows are: its title and the size it opens at. */
export interface SingleWindowKind {
  title: string;
  size: { width: number; height: number };
}

/**
 * A window there is only ever one of, beside the board; but while the board is full screen it opens as a child window
 * over the board, centred on it, on the board's Space, so it never takes a full-screen Space of its own. Shown while it
 * is open, it is brought forward; an open window of the other kind is closed and opened again as the kind wanted, as it
 * would bring its own Space forward. `show` says whether it opened a new window or brought the open one forward.
 */
export function singleWindow(
  { open, board, isFullScreen = (window) => window.isFullScreen() }: SingleWindowOptions,
  { title, size }: SingleWindowKind,
): { show(query: Record<string, string>): { window: BrowserWindow; opened: boolean }; is(contents: WebContents): boolean } {
  let window: BrowserWindow | undefined;
  /** Whether the open window is a child of the board (an overlay), not a window of its own. */
  let overlay = false;

  const show = (query: Record<string, string>) => {
    const candidate = board();
    const parent = candidate !== undefined && !candidate.isDestroyed() && isFullScreen(candidate) ? candidate : undefined;
    if (window !== undefined && !window.isDestroyed() && overlay !== (parent !== undefined)) {
      const stale = window;
      window = undefined;
      stale.destroy();
    }
    if (window !== undefined && !window.isDestroyed()) {
      revealWindow(window);
      return { window, opened: false };
    }
    overlay = parent !== undefined;
    // An overlay is centred on its board, so it is on the board's display and not wherever a new window would go.
    const bounds = parent?.getBounds();
    const opened = open(query, {
      title,
      ...size,
      ...(parent === undefined || bounds === undefined
        ? {}
        : {
            parent,
            x: Math.round(bounds.x + (bounds.width - size.width) / 2),
            y: Math.round(bounds.y + (bounds.height - size.height) / 2),
          }),
    });
    window = opened;
    opened.on('closed', () => {
      if (window === opened) window = undefined;
    });
    return { window: opened, opened: true };
  };

  return { show, is: (contents) => window !== undefined && !window.isDestroyed() && window.webContents === contents };
}
