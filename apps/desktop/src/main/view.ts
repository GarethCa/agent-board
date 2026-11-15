import { app, BrowserWindow, ipcMain } from 'electron';
import type { DaemonLink } from '@agent-board/daemon/client';
import type { LayoutMeasured } from '@agent-board/daemon/protocol';
import { VIEW_IPC } from '../preload/api';
import { flushViewSaves } from '../shared/view-saver';
import { sendToWindowsExcept } from './broadcast';

/** The daemon's view state: how the app left the board. */
export interface ViewState {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  /** How a window draws the board now (`layout.measured`). */
  measured(report: LayoutMeasured): Promise<void>;
  /** Says the last of those again: the daemon keeps it in memory only, so after it reconnects it has none. */
  remeasure(): void;
}

export function daemonViewState(daemon: DaemonLink): ViewState {
  /** What a window last said it draws. */
  let last: LayoutMeasured | undefined;
  return {
    get: (key) => daemon.call('view.get', { key }),
    set: async (key, value) => {
      await daemon.call('view.set', { key, value });
    },
    measured: async (report) => {
      last = report;
      await daemon.call('layout.measured', report);
    },
    remeasure: () => {
      if (last !== undefined) daemon.call('layout.measured', last).catch(() => {});
    },
  };
}

/**
 * The view state IPC the preload's `view` API calls. `saved` hears each window's save once it is made, for what the
 * main process must know at once (a key press in a web tab's page), as every other window does.
 */
export function registerViewIpc(view: ViewState, saved?: (key: string, value: unknown) => void): void {
  ipcMain.handle(VIEW_IPC.get, (_event, key: string) => view.get(key));
  ipcMain.handle(VIEW_IPC.set, async (event, key: string, value: unknown) => {
    await view.set(key, value);
    saved?.(key, value);
    sendToWindowsExcept(event.sender, VIEW_IPC.changed, { key, value });
  });
  ipcMain.handle(VIEW_IPC.measured, (_event, report: LayoutMeasured) => view.measured(report));
}

/** How long a quit waits for the windows to send the view saves they were waiting to make. */
const FLUSH_BEFORE_QUIT_MS = 1_000;

/**
 * Holds the app's quit back until every window, and main, has sent the view saves it was waiting to make (a closed
 * session window, the board's viewport), so the next launch opens the board as it was left; a window that doesn't
 * answer within `capMs` is not waited for.
 */
export function holdQuitForViewSaves(capMs = FLUSH_BEFORE_QUIT_MS): void {
  let saved = false;
  let saving = false;
  let next = 0;
  const answers = new Map<number, () => void>();
  ipcMain.on(VIEW_IPC.flushed, (_event, id: unknown) => {
    if (typeof id === 'number') answers.get(id)?.();
  });
  app.on('before-quit', (event) => {
    if (saved) return;
    event.preventDefault();
    if (saving) return;
    saving = true;
    const asked = BrowserWindow.getAllWindows()
      .filter((window) => !window.isDestroyed())
      .map(
        (window) =>
          new Promise<void>((resolve) => {
            const id = ++next;
            answers.set(id, resolve);
            try {
              window.webContents.send(VIEW_IPC.flush, id);
            } catch {
              // Its page already gone, closing as the app quits: it has nothing left to send.
              resolve();
            }
          }),
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((resolve) => (timer = setTimeout(resolve, capMs)));
    const quit = () => {
      clearTimeout(timer);
      answers.clear();
      saved = true;
      app.quit();
    };
    // Quits whatever the wait comes to, so a failure in it never leaves the app unable to quit.
    void Promise.race([Promise.all([...asked, flushViewSaves()]), cap]).then(quit, quit);
  });
}
