import { ipcMain } from 'electron';
import type { DaemonLink } from '@agent-board/daemon/client';
import { VIEW_IPC } from '../preload/api';

/** The daemon's view state: how the app left the board. */
export interface ViewState {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export function daemonViewState(daemon: DaemonLink): ViewState {
  return {
    get: (key) => daemon.call('view.get', { key }),
    set: async (key, value) => {
      await daemon.call('view.set', { key, value });
    },
  };
}

/** The view state IPC the preload's `view` API calls. */
export function registerViewIpc(view: ViewState): void {
  ipcMain.handle(VIEW_IPC.get, (_event, key: string) => view.get(key));
  ipcMain.handle(VIEW_IPC.set, (_event, key: string, value: unknown) => view.set(key, value));
}
