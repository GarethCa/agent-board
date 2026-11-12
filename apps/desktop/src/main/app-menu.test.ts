import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { appMenu, menuTemplate, windowMenu } from './app-menu';

const actions = () => ({ about: vi.fn(), settings: vi.fn(), checkForUpdates: vi.fn(), gettingStarted: vi.fn(), overview: vi.fn() });
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

  it('has no accelerator but the allow-listed ones, and none a bare key', () => {
    // Menu accelerators are chords the renderer's board and terminal keys also use (see keys/registry.ts), and a key the
    // menu owns can be taken from a focused terminal. Adding one means adding it here, with who owns the routing.
    const ALLOWED = ['CommandOrControl+,', 'CommandOrControl+Shift+O']; // Settings…, Window › Overview
    const accelerators = (list: MenuItemConstructorOptions[]): string[] =>
      list.flatMap((item) => [
        ...(item.accelerator === undefined ? [] : [String(item.accelerator)]),
        ...(Array.isArray(item.submenu) ? accelerators(item.submenu) : []),
      ]);
    for (const mac of [true, false]) {
      for (const packaged of [true, false]) {
        const all = accelerators(menuTemplate({ mac, packaged, name: 'agent-board' }, actions(), technical()));
        for (const accelerator of all) {
          expect(accelerator).toContain('+');
          expect(ALLOWED).toContain(accelerator);
        }
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

describe('the Window menu', () => {
  const labels = (list: MenuItemConstructorOptions[]) => list.map((item) => item.label ?? item.role ?? item.type);

  it('is Overview over the standard one while nothing is minimised', () => {
    expect(labels(windowMenu(true, vi.fn(), []).submenu as MenuItemConstructorOptions[])).toEqual(['Overview', 'separator', 'minimize', 'zoom', 'separator', 'front']);
  });

  it('opens the Overview on ⌘⇧O', () => {
    const a = actions();
    const windowItem = menuTemplate({ mac: true, packaged: true, name: 'agent-board' }, a, technical()).find((item) => item.role === 'windowMenu')!;
    const overview = (windowItem.submenu as MenuItemConstructorOptions[]).find((item) => item.label === 'Overview')!;
    expect(overview.accelerator).toBe('CommandOrControl+Shift+O');
    (overview.click as () => void)();
    expect(a.overview).toHaveBeenCalledOnce();
  });

  it('lists the minimised windows under a Minimised heading, and restores the one picked', () => {
    const restore = vi.fn();
    const list = windowMenu(true, vi.fn(), [{ title: 'API', restore }, { title: 'Docs', restore: vi.fn() }]).submenu as MenuItemConstructorOptions[];
    expect(labels(list).slice(-4)).toEqual(['separator', 'Minimised', 'API', 'Docs']);
    expect(list.find((item) => item.label === 'Minimised')?.enabled).toBe(false);
    (list.find((item) => item.label === 'API')!.click as () => void)();
    expect(restore).toHaveBeenCalledOnce();
  });

  it('is in the menu bar with the minimised windows', () => {
    const template = menuTemplate({ mac: true, packaged: false, name: 'agent-board' }, actions(), technical(), [{ title: 'API', restore: vi.fn() }]);
    const windowItem = template.find((item) => item.role === 'windowMenu')!;
    expect((windowItem.submenu as MenuItemConstructorOptions[]).some((item) => item.label === 'API')).toBe(true);
  });
});
