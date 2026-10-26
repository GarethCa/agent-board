import { ipcMain } from 'electron';
import type { DaemonLink } from '@agent-board/daemon/client';
import type { LayoutMeasured } from '@agent-board/daemon/protocol';
import { VIEW_IPC } from '../preload/api';

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

/** The view state IPC the preload's `view` API calls. */
export function registerViewIpc(view: ViewState): void {
  ipcMain.handle(VIEW_IPC.get, (_event, key: string) => view.get(key));
  ipcMain.handle(VIEW_IPC.set, (_event, key: string, value: unknown) => view.set(key, value));
  ipcMain.handle(VIEW_IPC.measured, (_event, report: LayoutMeasured) => view.measured(report));
}
