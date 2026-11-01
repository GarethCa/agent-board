import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } }));

const { registerSettingsWindow } = await import('./settings-window');
const { SETUP_IPC } = await import('../preload/api');

type Fake = ReturnType<typeof fakeWindow>;

function fakeWindow(bounds = { x: 100, y: 50, width: 1400, height: 900 }) {
  let destroyed = false;
  let fullScreen = false;
  let onClosed = () => {};
  return {
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => {
      destroyed = true;
      onClosed();
    }),
    isMinimized: () => false,
    show: vi.fn(),
    focus: vi.fn(),
    showInactive: vi.fn(),
    on: (event: string, handler: () => void) => {
      if (event === 'closed') onClosed = handler;
    },
    isFullScreen: () => fullScreen,
    setFull: (value: boolean) => (fullScreen = value),
    getBounds: () => bounds,
    webContents: { send: vi.fn() },
  };
}

describe('the Settings window', () => {
  let board: Fake | undefined;
  let opened: { query: Record<string, string>; options: Record<string, unknown>; window: Fake }[];
  let settings: ReturnType<typeof registerSettingsWindow>;

  beforeEach(() => {
    handlers.clear();
    board = fakeWindow();
    opened = [];
    settings = registerSettingsWindow({
      open: (query, options) => {
        const window = fakeWindow();
        opened.push({ query, options, window });
        return window as never;
      },
      board: () => board as never,
    });
  });

  it('is a window of its own while the board is not full screen', () => {
    settings.show('usage');
    expect(opened).toHaveLength(1);
    expect(opened[0]!.options.parent).toBeUndefined();
    expect(opened[0]!.query).toEqual({ settings: 'usage' });
  });

  it('is a child of the board, centred on it, while the board is full screen', () => {
    board!.setFull(true);
    settings.show();
    expect(opened[0]!.options).toMatchObject({ parent: board, x: 100 + (1400 - 780) / 2, y: 50 + (900 - 560) / 2 });
  });

  it('is a window of its own when there is no board, or its board is gone', () => {
    board = undefined;
    settings.show();
    expect(opened[0]!.options.parent).toBeUndefined();
    opened[0]!.window.destroy();
    board = fakeWindow();
    board.setFull(true);
    board.destroy();
    settings.show();
    expect(opened[1]!.options.parent).toBeUndefined();
  });

  it('closes a window of its own and reopens it as an overlay once the board has gone full screen', () => {
    settings.show();
    board!.setFull(true);
    settings.show('advanced.webTabs');
    expect(opened).toHaveLength(2);
    expect(opened[0]!.window.destroy).toHaveBeenCalled();
    expect(opened[1]!.options.parent).toBe(board);
    expect(opened[1]!.query).toEqual({ settings: 'advanced.webTabs' });
    expect(opened[0]!.window.show).not.toHaveBeenCalled();
  });

  it('replaces an overlay with a window of its own once the board has left full screen', () => {
    board!.setFull(true);
    settings.show();
    board!.setFull(false);
    settings.show();
    expect(opened).toHaveLength(2);
    expect(opened[0]!.window.destroy).toHaveBeenCalled();
    expect(opened[1]!.options.parent).toBeUndefined();
  });

  it('brings an open window of the right kind forward and hands it the pane asked, opening no second', () => {
    board!.setFull(true);
    settings.show();
    settings.show('usage.plan');
    expect(opened).toHaveLength(1);
    expect(opened[0]!.window.webContents.send).toHaveBeenCalledWith(SETUP_IPC.settingsPane);
    expect(handlers.get(SETUP_IPC.takeSettingsPane)!()).toBe('usage.plan');
    expect(handlers.get(SETUP_IPC.takeSettingsPane)!()).toBeNull();
  });

  it('forgets a pane asked of a window it replaced', () => {
    settings.show();
    settings.show('usage.plan');
    board!.setFull(true);
    settings.show();
    expect(handlers.get(SETUP_IPC.takeSettingsPane)!()).toBeNull();
    expect(settings.isSettings(opened[1]!.window.webContents as never)).toBe(true);
    expect(settings.isSettings(opened[0]!.window.webContents as never)).toBe(false);
  });
});
