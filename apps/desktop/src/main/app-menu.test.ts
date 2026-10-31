import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { appMenu, menuTemplate } from './app-menu';

const actions = () => ({ about: vi.fn(), settings: vi.fn(), checkForUpdates: vi.fn(), gettingStarted: vi.fn() });
const technical = () => ({ simplified: true, on: false, set: vi.fn() });
const items = (a = actions()) => appMenu('agent-board', a).submenu as MenuItemConstructorOptions[];

describe('the app menu', () => {
  it('has About, Check for Updates…, Settings…, Hide, Hide Others, Show All and Quit', () => {
    const list = items();
    expect(list.map((item) => item.label ?? item.role).filter((x) => x !== undefined)).toEqual([
      'About agent-board',
      'Check for Updates…',
      'Settings…',
      'services',
      'hide',
      'hideOthers',
      'unhide',
      'quit',
    ]);
  });

  it('puts Settings… on ⌘,', () => {
    expect(items().find((item) => item.label === 'Settings…')?.accelerator).toBe('CommandOrControl+,');
  });

  it('gives no two items in the whole menu bar the same accelerator', () => {
    const accelerators = (list: MenuItemConstructorOptions[]): string[] =>
      list.flatMap((item) => [
        ...(item.accelerator === undefined ? [] : [String(item.accelerator)]),
        ...(Array.isArray(item.submenu) ? accelerators(item.submenu) : []),
      ]);
    for (const mac of [true, false]) {
      for (const packaged of [true, false]) {
        const all = accelerators(menuTemplate({ mac, packaged, name: 'agent-board' }, actions(), technical()));
        expect(new Set(all).size).toBe(all.length);
      }
    }
  });

  it('has the app menu only on macOS', () => {
    const labels = (mac: boolean) => menuTemplate({ mac, packaged: true, name: 'agent-board' }, actions(), technical()).map((menu) => menu.label);
    expect(labels(true)[0]).toBe('agent-board');
    expect(labels(false)[0]).toBeUndefined();
  });

  it('calls each item’s action', () => {
    const a = actions();
    for (const label of ['About agent-board', 'Settings…', 'Check for Updates…']) {
      (items(a).find((item) => item.label === label)!.click as () => void)();
    }
    expect([a.about, a.settings, a.checkForUpdates].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
  });
});
