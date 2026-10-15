import { describe, expect, it, vi } from 'vitest';
import { fitPlace } from './windows';

vi.mock('electron', () => ({ app: { on: vi.fn() }, BrowserWindow: {}, ipcMain: { handle: vi.fn() }, screen: {} }));

describe('fitPlace', () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  const size = { width: 960, height: 640 };

  it('puts the tab strip, near its start, under where the tab was let go', () => {
    expect(fitPlace({ x: 400, y: 300 }, size, area)).toEqual({ x: 280, y: 252, width: 960, height: 640 });
  });

  it('keeps the window on the display, at an edge or a corner', () => {
    expect(fitPlace({ x: 1430, y: 890 }, size, area)).toEqual({ x: 480, y: 260, width: 960, height: 640 });
    expect(fitPlace({ x: 10, y: 30 }, size, area)).toEqual({ x: 0, y: 25, width: 960, height: 640 });
  });

  it('keeps it on a display left of or above the main one', () => {
    expect(fitPlace({ x: -1000, y: -500 }, size, { x: -1920, y: -1080, width: 1920, height: 1080 })).toEqual({ x: -1120, y: -640, width: 960, height: 640 });
  });
});
