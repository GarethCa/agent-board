import type { MenuItemConstructorOptions } from 'electron';

/**
 * The View menu. Reload and Force Reload (⌘R, ⇧⌘R) would reload the whole app, not a page, so only a dev build (not
 * `packaged`) has them.
 */
export function viewMenu(packaged: boolean): MenuItemConstructorOptions {
  const reloads: MenuItemConstructorOptions[] = packaged ? [] : [{ role: 'reload' }, { role: 'forceReload' }];
  return { label: 'View', submenu: [...reloads, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] };
}
