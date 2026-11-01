import { ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { SETUP_IPC, WINDOW_QUERY } from '../preload/api';
import { revealWindow } from './background';

/** The Settings window's size as it opens: its sidebar and a page of rows beside it. */
const SETTINGS_SIZE = { width: 780, height: 560 };

export interface SettingsWindowOptions {
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

/**
 * The Settings window: one of its own, beside the board, as macOS apps' settings are; but while the board is full screen it
 * opens as a child window over the board, on the board's Space, so it never takes a full-screen Space of its own. Settings… (⌘,)
 * in the app menu, the board menu's Settings… row and the gear open it, or bring it forward if it is open. Asked for a
 * pane, it shows that; otherwise it opens on the pane it last showed, which it keeps itself. A pane asked of an open
 * window waits in main until its page takes it (`takeSettingsPane`), so one asked while it still loads isn't lost.
 */
export function registerSettingsWindow({ open, board, isFullScreen = (window) => window.isFullScreen() }: SettingsWindowOptions): { show(pane?: string): void; isSettings(contents: WebContents): boolean } {
  let window: BrowserWindow | undefined;
  /** The pane last asked of an open window, kept until its page takes it: it may still be loading. */
  let asked: string | undefined;

  /** Whether the open window is a child of the board (an overlay), not a window of its own. */
  let overlay = false;

  const show = (pane?: string) => {
    const candidate = board();
    // Over the board while it is full screen, so Settings stays on the board's Space; otherwise a window of its own.
    const parent = candidate !== undefined && !candidate.isDestroyed() && isFullScreen(candidate) ? candidate : undefined;
    // An open window of the other kind would bring its own Space forward, so it is closed and opened as the kind wanted.
    if (window !== undefined && !window.isDestroyed() && overlay !== (parent !== undefined)) {
      const stale = window;
      window = undefined;
      stale.destroy();
    }
    if (window !== undefined && !window.isDestroyed()) {
      revealWindow(window);
      if (pane !== undefined) {
        asked = pane;
        window.webContents.send(SETUP_IPC.settingsPane);
      }
      return;
    }
    asked = undefined;
    overlay = parent !== undefined;
    // An overlay is centred on its board, so it is on the board's display and not wherever a new window would go.
    const bounds = parent?.getBounds();
    const opened = open(
      { [WINDOW_QUERY.settings]: pane ?? '' },
      {
        title: 'Settings',
        ...SETTINGS_SIZE,
        ...(parent === undefined || bounds === undefined
          ? {}
          : {
              parent,
              x: Math.round(bounds.x + (bounds.width - SETTINGS_SIZE.width) / 2),
              y: Math.round(bounds.y + (bounds.height - SETTINGS_SIZE.height) / 2),
            }),
      },
    );
    window = opened;
    opened.on('closed', () => {
      if (window === opened) window = undefined;
    });
  };

  ipcMain.handle(SETUP_IPC.openSettings, (_event, pane: unknown) => show(typeof pane === 'string' ? pane : undefined));
  ipcMain.handle(SETUP_IPC.takeSettingsPane, () => {
    const taken = asked ?? null;
    asked = undefined;
    return taken;
  });

  return {
    show,
    isSettings: (contents) => window !== undefined && !window.isDestroyed() && window.webContents === contents,
  };
}
