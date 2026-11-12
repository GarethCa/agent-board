import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } }));

const { registerOverviewWindow } = await import('./overview-window');
const { OVERVIEW_IPC } = await import('../preload/api');

function fakeWindow(bounds = { x: 0, y: 0, width: 1600, height: 1000 }) {
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

describe('the Overview window', () => {
  let board: ReturnType<typeof fakeWindow>;
  let opened: { query: Record<string, string>; options: Record<string, unknown>; window: ReturnType<typeof fakeWindow> }[];
  let kept: Map<string, unknown>;
  let clock: Date;
  let overview: ReturnType<typeof registerOverviewWindow>;

  beforeEach(() => {
    handlers.clear();
    board = fakeWindow();
    opened = [];
    kept = new Map();
    clock = new Date('2026-11-12T07:58:00Z');
    overview = registerOverviewWindow({
      open: (query, options) => {
        const window = fakeWindow();
        opened.push({ query, options, window });
        return window as never;
      },
      board: () => board as never,
      view: {
        get: async (key) => kept.get(key),
        set: async (key, value) => void kept.set(key, value),
      },
      now: () => clock,
    });
  });

  it('opens one 1280×800 window titled Overview, and brings it forward when asked again', () => {
    overview.show();
    overview.show();
    expect(opened).toHaveLength(1);
    expect(opened[0]!.options).toMatchObject({ title: 'Overview', width: 1280, height: 800 });
    expect(opened[0]!.query).toEqual({ overview: '1' });
    expect(opened[0]!.window.show).toHaveBeenCalled();
  });

  it('opens over the board, centred on it, while the board is full screen', () => {
    board.setFull(true);
    overview.show();
    expect(opened[0]!.options).toMatchObject({ parent: board, x: (1600 - 1280) / 2, y: (1000 - 800) / 2 });
  });

  it('takes the first look as the last one, and keeps it', async () => {
    expect(await handlers.get(OVERVIEW_IPC.seen)!()).toBe('2026-11-12T07:58:00.000Z');
    clock = new Date('2026-11-12T09:00:00Z');
    expect(await handlers.get(OVERVIEW_IPC.seen)!()).toBe('2026-11-12T07:58:00.000Z');
    expect(kept.get('overview.seenAt')).toBe('2026-11-12T07:58:00.000Z');
  });

  it('reads the look kept from before a restart', async () => {
    kept.set('overview.seenAt', '2026-11-11T18:40:00.000Z');
    expect(await handlers.get(OVERVIEW_IPC.seen)!()).toBe('2026-11-11T18:40:00.000Z');
  });

  it('moves the last look to now on Mark all seen', async () => {
    kept.set('overview.seenAt', '2026-11-11T18:40:00.000Z');
    clock = new Date('2026-11-12T08:15:00Z');
    expect(await handlers.get(OVERVIEW_IPC.markSeen)!()).toBe('2026-11-12T08:15:00.000Z');
    expect(await handlers.get(OVERVIEW_IPC.seen)!()).toBe('2026-11-12T08:15:00.000Z');
    expect(kept.get('overview.seenAt')).toBe('2026-11-12T08:15:00.000Z');
  });

  it('logs a look it could not read, and asks again next time', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    kept.set('overview.seenAt', '2026-11-11T18:40:00.000Z');
    registerOverviewWindow({
      open: () => fakeWindow() as never,
      board: () => board as never,
      view: { get: async (key) => (fail ? Promise.reject(new Error('daemon gone')) : kept.get(key)), set: async () => {} },
      now: () => clock,
    });
    expect(await handlers.get(OVERVIEW_IPC.seen)!()).toBe('2026-11-12T07:58:00.000Z');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not read'), expect.any(Error));
    fail = false;
    expect(await handlers.get(OVERVIEW_IPC.seen)!()).toBe('2026-11-11T18:40:00.000Z');
    error.mockRestore();
  });

  it('logs a look it could not keep, and holds it until the app quits', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerOverviewWindow({
      open: () => fakeWindow() as never,
      board: () => board as never,
      view: { get: async () => '2026-11-11T18:40:00.000Z', set: () => Promise.reject(new Error('disk full')) },
      now: () => clock,
    });
    expect(await handlers.get(OVERVIEW_IPC.markSeen)!()).toBe('2026-11-12T07:58:00.000Z');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not keep'), expect.any(Error));
    expect(await handlers.get(OVERVIEW_IPC.seen)!()).toBe('2026-11-12T07:58:00.000Z');
    error.mockRestore();
  });
});
