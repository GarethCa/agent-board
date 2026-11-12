import { ipcMain } from 'electron';
import { OVERVIEW_IPC, WINDOW_QUERY } from '../preload/api';
import { VIEW_KEYS } from '../shared/view-saver';
import { singleWindow, type SingleWindowOptions } from './single-window';
import type { ViewState } from './view';

/** The Overview window's size as it opens: a column for each of six projects at a laptop's width. */
const OVERVIEW_SIZE = { width: 1280, height: 800 };

export interface OverviewWindowOptions extends SingleWindowOptions {
  /** The daemon's view state, where the last look is kept (`VIEW_KEYS.overviewSeenAt`) across restarts. */
  view: Pick<ViewState, 'get' | 'set'>;
  /** The time now; a test's clock, else the system's. */
  now?(): Date;
}

/**
 * The Overview window: every agent on the board by project and work category, one window of its own beside the board,
 * or over it while it is full screen (`singleWindow`). Window › Overview (⌘⇧O) opens it, or brings it forward if it is
 * open. Main keeps when the user last looked ("since HH:MM"): the first look is the first time it opens, and Mark all
 * seen moves it to now.
 */
export function registerOverviewWindow({ view, now = () => new Date(), ...options }: OverviewWindowOptions): { show(): void } {
  const overview = singleWindow(options, { title: 'Overview', size: OVERVIEW_SIZE });
  let seenAt: Promise<string> | undefined;

  // A look the daemon couldn't keep still holds until the app quits, so the dots clear; it is logged, as it will be
  // gone after a restart.
  const mark = (at: string): Promise<string> => {
    const marked = view.set(VIEW_KEYS.overviewSeenAt, at).then(
      () => at,
      (error: unknown) => {
        console.error('agent-board: could not keep the Overview’s last look:', error);
        return at;
      },
    );
    seenAt = marked;
    return marked;
  };
  // A failed read is not kept: the next look asks the daemon again.
  const seen = (): Promise<string> =>
    (seenAt ??= view.get(VIEW_KEYS.overviewSeenAt).then(
      (kept) => (typeof kept === 'string' && !Number.isNaN(Date.parse(kept)) ? kept : mark(now().toISOString())),
      (error: unknown) => {
        console.error('agent-board: could not read the Overview’s last look:', error);
        seenAt = undefined;
        return now().toISOString();
      },
    ));

  ipcMain.handle(OVERVIEW_IPC.seen, () => seen());
  ipcMain.handle(OVERVIEW_IPC.markSeen, () => mark(now().toISOString()));

  return { show: () => void overview.show({ [WINDOW_QUERY.overview]: '1' }) };
}
