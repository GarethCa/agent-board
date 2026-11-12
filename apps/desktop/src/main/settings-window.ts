import { ipcMain, type WebContents } from 'electron';
import { SETUP_IPC, WINDOW_QUERY } from '../preload/api';
import { singleWindow, type SingleWindowOptions } from './single-window';

/** The Settings window's size as it opens: its sidebar and a page of rows beside it. */
const SETTINGS_SIZE = { width: 780, height: 560 };

export type SettingsWindowOptions = SingleWindowOptions;

/**
 * The Settings window: one of its own, beside the board, as macOS apps' settings are, or over the board while it is
 * full screen (`singleWindow`). Settings… (⌘,) in the app menu, the board menu's Settings… row and the gear open it, or
 * bring it forward if it is open. Asked for a pane, it shows that; otherwise it opens on the pane it last showed, which
 * it keeps itself. A pane asked of an open window waits in main until its page takes it (`takeSettingsPane`), so one
 * asked while it still loads isn't lost.
 */
export function registerSettingsWindow(options: SettingsWindowOptions): { show(pane?: string): void; isSettings(contents: WebContents): boolean } {
  const settings = singleWindow(options, { title: 'Settings', size: SETTINGS_SIZE });
  /** The pane last asked of an open window, kept until its page takes it: it may still be loading. */
  let asked: string | undefined;

  const show = (pane?: string) => {
    const { window, opened } = settings.show({ [WINDOW_QUERY.settings]: pane ?? '' });
    if (opened) {
      asked = undefined;
    } else if (pane !== undefined) {
      asked = pane;
      window.webContents.send(SETUP_IPC.settingsPane);
    }
  };

  ipcMain.handle(SETUP_IPC.openSettings, (_event, pane: unknown) => show(typeof pane === 'string' ? pane : undefined));
  ipcMain.handle(SETUP_IPC.takeSettingsPane, () => {
    const taken = asked ?? null;
    asked = undefined;
    return taken;
  });

  return { show, isSettings: settings.is };
}
