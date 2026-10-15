import type { IpcRenderer, IpcRendererEvent } from 'electron';
import { ipcErrorMessage } from '../shared/errors';

/** The two ways the preload's API talks to main: a call that answers, and a channel main sends on. */
export function ipcCalls(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'off'>) {
  return {
    /** Invokes a main-process handler, failing with just the daemon's message. */
    invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
      return ipc.invoke(channel, ...args).catch((error: unknown) => {
        throw new Error(ipcErrorMessage(error));
      });
    },
    /** Calls `listener` with each message main sends on `channel`, until the function returned is called. */
    subscribe<Args extends unknown[]>(channel: string, listener: (...args: Args) => void): () => void {
      const handler = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as Args));
      ipc.on(channel, handler);
      return () => ipc.off(channel, handler);
    },
    /**
     * Like `subscribe`, for a channel whose messages begin with the id of who they are for: one listener serves them all,
     * so a hundred terminals don't each run every message through a listener of their own. Listens only while some id
     * does.
     */
    keyed<Args extends unknown[]>(channel: string): (id: string, listener: (...args: Args) => void) => () => void {
      const listeners = new Map<string, (...args: Args) => void>();
      const dispatch = (_event: IpcRendererEvent, id: string, ...args: unknown[]) => listeners.get(id)?.(...(args as Args));
      return (id, listener) => {
        if (listeners.size === 0) ipc.on(channel, dispatch);
        listeners.set(id, listener);
        return () => {
          if (listeners.get(id) !== listener) return;
          listeners.delete(id);
          if (listeners.size === 0) ipc.off(channel, dispatch);
        };
      };
    },
  };
}
