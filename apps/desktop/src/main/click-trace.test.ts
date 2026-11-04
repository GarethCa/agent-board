import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, describe, expect, it } from 'vitest';
import { describeBoard, traceNotificationClick } from './click-trace';

const windowWith = (state: { destroyed?: boolean; minimized?: boolean; visible?: boolean; fullScreen?: boolean }) =>
  ({
    isDestroyed: () => state.destroyed ?? false,
    isMinimized: () => state.minimized ?? false,
    isVisible: () => state.visible ?? true,
    isFullScreen: () => state.fullScreen ?? false,
  }) as unknown as BrowserWindow;

describe('describeBoard', () => {
  it('names where a click finds the board', () => {
    expect(describeBoard(undefined)).toBe('closed');
    expect(describeBoard(windowWith({ destroyed: true }))).toBe('closed');
    expect(describeBoard(windowWith({ minimized: true, visible: false }))).toBe('minimised');
    expect(describeBoard(windowWith({ visible: false }))).toBe('hidden');
    expect(describeBoard(windowWith({ fullScreen: true }))).toBe('full-screen');
    expect(describeBoard(windowWith({}))).toBe('visible');
  });
});

describe('traceNotificationClick', () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('appends a line to the log, and never throws when it cannot', () => {
    dir = mkdtempSync(join(tmpdir(), 'click-trace-'));
    const log = join(dir, 'daemon.log');
    traceNotificationClick(log, 's1', undefined, 0);
    traceNotificationClick(log, 's2', windowWith({}), 2);
    expect(readFileSync(log, 'utf8').split('\n')).toEqual([
      '[agent-board app] notification clicked: session s1, board window closed, 0 windows open',
      '[agent-board app] notification clicked: session s2, board window visible, 2 windows open',
      '',
    ]);
    expect(() => traceNotificationClick(join(dir!, 'missing', 'daemon.log'), 's3', undefined, 0)).not.toThrow();
  });
});
