import { describe, expect, it } from 'vitest';
import { windowChrome } from '../preload/api';
import { chromeOptions } from './chrome';

describe('the window chrome', () => {
  it('has no title bar on macOS: the traffic lights float over the board, beside its menu island', () => {
    expect(windowChrome('darwin')).toBe('inset');
    expect(chromeOptions('darwin', 'board')).toEqual({ titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 30 } });
  });

  it('sits the traffic lights inline in a popped-out window’s header', () => {
    expect(chromeOptions('darwin', 'pop-out')).toEqual({ titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 } });
  });

  it('sits the traffic lights inline in the Settings window’s title bar', () => {
    expect(chromeOptions('darwin', 'settings')).toEqual({ titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 12 } });
  });

  it('keeps the native frame, and its window controls, everywhere else', () => {
    for (const platform of ['linux', 'win32'] as const) {
      expect(windowChrome(platform)).toBe('framed');
      expect(chromeOptions(platform, 'board')).toEqual({});
      expect(chromeOptions(platform, 'pop-out')).toEqual({});
      expect(chromeOptions(platform, 'settings')).toEqual({});
    }
  });
});
