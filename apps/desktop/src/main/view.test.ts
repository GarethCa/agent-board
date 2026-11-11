import { describe, expect, it, vi } from 'vitest';
import { VIEW_IPC } from '../preload/api';
import { registerViewIpc, type ViewState } from './view';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  windows: [] as { sent: unknown[][]; isDestroyed(): boolean; send(...args: unknown[]): void }[],
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => electron.handlers.set(channel, handler) },
  webContents: {
    getAllWebContents: () => electron.windows,
  },
}));

function register(set: ViewState['set'], saved?: (key: string, value: unknown) => void) {
  const window = () => {
    const sent: unknown[][] = [];
    return { sent, isDestroyed: () => false, send: (...args: unknown[]) => void sent.push(args) };
  };
  electron.windows.splice(0, electron.windows.length, window(), window());
  registerViewIpc({ get: async () => null, set, measured: async () => {}, remeasure: () => {} }, saved);
  return electron.handlers.get(VIEW_IPC.set)!;
}

describe('the view state IPC', () => {
  it('tells every other window what was saved, once it is, not the one that saved it', async () => {
    const set = register(async () => {});
    await set({ sender: electron.windows[0] }, 'crewLook', 'chips');
    expect(electron.windows[0]!.sent).toEqual([]);
    expect(electron.windows[1]!.sent).toEqual([[VIEW_IPC.changed, { key: 'crewLook', value: 'chips' }]]);
  });

  it('tells the main process of each save too, once it is: a key press there reads the setting at once', async () => {
    const saved = vi.fn();
    const set = register(async () => {}, saved);
    await set({ sender: electron.windows[0] }, 'keyboard.extendedShortcuts', false);
    expect(saved).toHaveBeenCalledWith('keyboard.extendedShortcuts', false);
  });

  it('tells no window of a save that failed', async () => {
    const set = register(async () => {
      throw new Error('daemon down');
    });
    await expect(set({ sender: electron.windows[0] }, 'crewLook', 'chips')).rejects.toThrow('daemon down');
    for (const window of electron.windows) expect(window.sent).toEqual([]);
  });
});
