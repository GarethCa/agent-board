import { ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { SETUP_IPC, WINDOW_QUERY } from '../preload/api';
import { revealWindow } from './background';

/** The Settings window's size as it opens: its sidebar and a page of rows beside it. */
const SETTINGS_SIZE = { width: 780, height: 560 };

export interface SettingsWindowOptions {
  /** Opens a renderer window loaded with `query`. */
  open(query: Record<string, string>, options: { title: string; width: number; height: number }): BrowserWindow;
}

/**
 * The Settings window: one of its own, beside the board and never over it, as macOS apps' settings are. Settings… (⌘,)
 * in the app menu, the board menu's Settings… row and the gear open it, or bring it forward if it is open. Asked for a
 * pane, it shows that; otherwise it opens on the pane it last showed, which it keeps itself. A pane asked of an open
 * window waits in main until its page takes it (`takeSettingsPane`), so one asked while it still loads isn't lost.
 */
export function registerSettingsWindow({ open }: SettingsWindowOptions): { show(pane?: string): void; isSettings(contents: WebContents): boolean } {
  let window: BrowserWindow | undefined;
  /** The pane last asked of an open window, kept until its page takes it: it may still be loading. */
  let asked: string | undefined;

  const show = (pane?: string) => {
    if (window !== undefined && !window.isDestroyed()) {
      revealWindow(window);
      if (pane !== undefined) {
        asked = pane;
        window.webContents.send(SETUP_IPC.settingsPane);
      }
      return;
    }
    asked = undefined;
    const opened = open({ [WINDOW_QUERY.settings]: pane ?? '' }, { title: 'Settings', ...SETTINGS_SIZE });
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
