import type { MenuItemConstructorOptions } from 'electron';
import { menuBarItems, NO_MENU_BAR } from './menu-bar-items';

/** What View › Show Technical Details shows and does: it is there only under the Simplified design, ticked while on. */
export interface TechnicalItem {
  simplified: boolean;
  on: boolean;
  set(on: boolean): void;
}

/**
 * The View menu: the board's zoom (with no keys: ⌘+ ⌘- ⌘0 are the terminal text's), its tools and what it draws, then
 * a window's views, full screen and Developer. Reload and Force Reload (⌘R, ⇧⌘R) would reload the whole app, not a
 * page, so only a dev build (not `packaged`) has them. Show Technical Details has no key: the obvious one (⌥⌘D) is
 * taken.
 */
export function viewMenu(packaged: boolean, technical: TechnicalItem, keys = menuBarItems(NO_MENU_BAR)): MenuItemConstructorOptions {
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
    submenu: [
      keys.action('Zoom In', 'zoomIn'),
      keys.action('Zoom Out', 'zoomOut'),
      keys.action('Zoom to Fit', 'zoomToFit'),
      { type: 'separator' },
      { label: 'Tool', submenu: [keys.key('Select', 'move.select'), keys.key('Box Select', 'move.box'), keys.key('Hand', 'move.hand')] },
      keys.key('Cycle Connections', 'move.connections'),
      keys.key('Cycle Crews', 'move.crews'),
      keys.action('Snap to Grid', 'snapToGrid', true),
      keys.action('Show Minimap', 'minimap', true),
      { type: 'separator' },
      showTechnical,
      keys.key('Show Terminal', 'window.terminalView'),
      keys.key('Show Details', 'window.details'),
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { label: 'Developer', submenu: [...reloads, { role: 'toggleDevTools' }] },
    ],
  };
}
