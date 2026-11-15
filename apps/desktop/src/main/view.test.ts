import { describe, expect, it, vi } from 'vitest';
import { VIEW_IPC } from '../preload/api';
import { viewSaver } from '../shared/view-saver';
import { markAppWindow } from './app-windows';
import { holdQuitForViewSaves, registerViewIpc, type ViewState } from './view';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  windows: [] as { sent: unknown[][]; isDestroyed(): boolean; send(...args: unknown[]): void }[],
  boardWindows: [] as { isDestroyed(): boolean; webContents: { send(...args: unknown[]): void } }[],
  beforeQuit: [] as ((event: { preventDefault(): void }) => void)[],
  quit: (() => {}) as () => void,
}));

vi.mock('electron', () => ({
  app: {
    on: (name: string, listener: (event: { preventDefault(): void }) => void) => {
      if (name === 'before-quit') electron.beforeQuit.push(listener);
    },
    quit: () => electron.quit(),
  },
  BrowserWindow: { getAllWindows: () => electron.boardWindows },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => electron.handlers.set(channel, handler),
    on: (channel: string, listener: (...args: unknown[]) => unknown) => electron.listeners.set(channel, listener),
  },
  webContents: {
    getAllWebContents: () => electron.windows,
  },
}));

function register(set: ViewState['set'], saved?: (key: string, value: unknown) => void) {
  const window = () => {
    const sent: unknown[][] = [];
    const made = { sent, isDestroyed: () => false, send: (...args: unknown[]) => void sent.push(args) };
    markAppWindow(made as unknown as Electron.WebContents, () => true);
    return made;
  };
  electron.windows.splice(0, electron.windows.length, window(), window());
  registerViewIpc({ get: async () => null, set, measured: async () => {}, remeasure: () => {} }, saved);
  return electron.handlers.get(VIEW_IPC.set)!;
}

describe('the view state IPC', () => {
  it('tells every other window what was saved, once it is, not the one that saved it', async () => {
    const set = register(async () => {});
    await set({ sender: electron.windows[0] }, 'connections', 'handoffs');
    expect(electron.windows[0]!.sent).toEqual([]);
    expect(electron.windows[1]!.sent).toEqual([[VIEW_IPC.changed, { key: 'connections', value: 'handoffs' }]]);
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
    await expect(set({ sender: electron.windows[0] }, 'connections', 'handoffs')).rejects.toThrow('daemon down');
    for (const window of electron.windows) expect(window.sent).toEqual([]);
  });
});

describe('a quit', () => {
  /** A window whose flush requests are kept, to answer by hand; and Electron's quit, which emits before-quit again. */
  function setUp(windows: number) {
    electron.beforeQuit.splice(0);
    const asked = Array.from({ length: windows }, () => [] as unknown[][]);
    electron.boardWindows.splice(0, electron.boardWindows.length, ...asked.map((sent) => ({ isDestroyed: () => false, webContents: { send: (...args: unknown[]) => void sent.push(args) } })));
    const quits = vi.fn();
    const quit = () => {
      const prevented = vi.fn();
      for (const listener of electron.beforeQuit) listener({ preventDefault: prevented });
      if (prevented.mock.calls.length === 0) quits();
    };
    electron.quit = quit;
    holdQuitForViewSaves(1_000);
    const answer = (window: number) => electron.listeners.get(VIEW_IPC.flushed)!({ sender: electron.boardWindows[window]!.webContents }, asked[window]![0]![1]);
    return { asked, quit, quits, answer };
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('waits until every window has sent the saves it was waiting to make, and main its own, then quits', async () => {
    const { asked, quit, quits, answer } = setUp(2);
    const set = vi.fn().mockResolvedValue(undefined);
    viewSaver(set, 200)({ x: 1 });
    quit();
    expect(asked.map((sent) => sent.map(([channel]) => channel))).toEqual([[VIEW_IPC.flush], [VIEW_IPC.flush]]);
    expect(set).toHaveBeenCalledWith({ x: 1 });
    answer(0);
    await settle();
    expect(quits).not.toHaveBeenCalled();
    answer(1);
    await settle();
    expect(quits).toHaveBeenCalledTimes(1);
  });

  it('quits after the wait when a window never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { quit, quits } = setUp(1);
      quit();
      await vi.advanceTimersByTimeAsync(999);
      expect(quits).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(quits).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still quits when a window can no longer be asked, once the others have answered', async () => {
    const { quit, quits, answer } = setUp(2);
    electron.boardWindows[0]!.webContents.send = () => {
      throw new Error('Object has been destroyed');
    };
    quit();
    answer(1);
    await settle();
    expect(quits).toHaveBeenCalledTimes(1);
  });

  it('asks once while it waits: a second Quit is held back with the first', async () => {
    const { asked, quit, quits, answer } = setUp(1);
    quit();
    quit();
    expect(asked[0]).toHaveLength(1);
    answer(0);
    await settle();
    expect(quits).toHaveBeenCalledTimes(1);
  });
});
