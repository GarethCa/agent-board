import type { MenuItemConstructorOptions } from 'electron';

/** What View › Show Technical Details shows and does: it is there only under the Simplified design, ticked while on. */
export interface TechnicalItem {
  simplified: boolean;
  on: boolean;
  set(on: boolean): void;
}

/**
 * The View menu. Reload and Force Reload (⌘R, ⇧⌘R) would reload the whole app, not a page, so only a dev build (not
 * `packaged`) has them. Show Technical Details has no key: the obvious one (⌥⌘D) is taken.
 */
export function viewMenu(packaged: boolean, technical: TechnicalItem): MenuItemConstructorOptions {
  const reloads: MenuItemConstructorOptions[] = packaged ? [] : [{ role: 'reload' }, { role: 'forceReload' }];
  const showTechnical: MenuItemConstructorOptions = {
    label: 'Show Technical Details',
    type: 'checkbox',
    visible: technical.simplified,
    checked: technical.on,
    // Electron has already ticked or unticked it.
    click: (item) => technical.set(item.checked),
  };
  return {
    label: 'View',
    submenu: [showTechnical, { type: 'separator', visible: technical.simplified }, ...reloads, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
  };
}
