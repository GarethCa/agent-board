import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { viewMenu, type TechnicalItem } from './view-menu';

const technical = (over: Partial<TechnicalItem> = {}): TechnicalItem => ({ simplified: false, on: false, set: vi.fn(), ...over });
const items = (packaged: boolean, item = technical()) => viewMenu(packaged, item).submenu as MenuItemConstructorOptions[];
const roles = (packaged: boolean) => items(packaged).map((item) => item.role);
const showTechnical = (item: TechnicalItem) => items(true, item).find((entry) => entry.label === 'Show Technical Details')!;

describe('the View menu', () => {
  it('has Reload and Force Reload in a dev build', () => {
    expect(roles(false)).toEqual(expect.arrayContaining(['reload', 'forceReload', 'toggleDevTools']));
  });

  it('has neither in a packaged build, so ⌘R never reloads the app', () => {
    expect(roles(true)).not.toContain('reload');
    expect(roles(true)).not.toContain('forceReload');
    expect(roles(true)).toContain('toggleDevTools');
  });

  it('shows Show Technical Details, with no key of its own, only under the Simplified design', () => {
    expect(showTechnical(technical()).visible).toBe(false);
    const item = showTechnical(technical({ simplified: true }));
    expect(item.visible).toBe(true);
    expect(item.type).toBe('checkbox');
    expect(item.accelerator).toBeUndefined();
  });

  it('ticks Show Technical Details while it is on, and turns it on or off when picked', () => {
    expect(showTechnical(technical({ simplified: true })).checked).toBe(false);
    const set = vi.fn();
    const item = showTechnical(technical({ simplified: true, on: true, set }));
    expect(item.checked).toBe(true);
    // Electron ticks or unticks a checkbox before calling its click.
    (item.click as (menuItem: { checked: boolean }) => void)({ checked: false });
    expect(set).toHaveBeenCalledWith(false);
  });
});
