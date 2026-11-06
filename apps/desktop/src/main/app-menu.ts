import type { MenuItemConstructorOptions } from 'electron';
import { viewMenu, type TechnicalItem } from './view-menu';

/** Where Check for Updates… goes until the app has an updater of its own. */
export const RELEASES_URL = 'https://github.com/GarethCa/agent-board/releases';

/** What the app menu's own items do. */
export interface AppMenuActions {
  about(): void;
  settings(): void;
  checkForUpdates(): void;
}

/** The macOS app menu: About, Settings… (⌘,), Check for Updates…, then the standard Services, Hide and Quit. */
export function appMenu(name: string, actions: AppMenuActions): MenuItemConstructorOptions {
  return {
    label: name,
    submenu: [
      { label: `About ${name}`, click: actions.about },
      { label: 'Check for Updates…', click: actions.checkForUpdates },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CommandOrControl+,', click: actions.settings },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };
}

/** A window minimised to the board's dock, as the Window menu lists it: picking it restores it. */
export interface MinimisedItem {
  title: string;
  restore(): void;
}

/**
 * Electron's Window menu, with a Minimised section after its own items (when any window is minimised) so a window that
 * is not in the dock, because the Dock setting leaves it out, is still found. The section's labels are the windows' names.
 */
export function windowMenu(mac: boolean, minimised: readonly MinimisedItem[]): MenuItemConstructorOptions {
  const items = minimised.map((item): MenuItemConstructorOptions => ({ label: item.title, click: item.restore }));
  const section: MenuItemConstructorOptions[] = items.length === 0 ? [] : [{ type: 'separator' }, { label: 'Minimised', enabled: false }, ...items];
  return {
    role: 'windowMenu',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(mac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [{ role: 'close' as const }]),
      ...section,
    ],
  };
}

/** What the menu bar's items do. */
export interface MenuActions extends AppMenuActions {
  gettingStarted(): void;
}

/**
 * The whole menu bar. Only macOS has an app menu. Items given a `role` take Electron's own accelerators, which this
 * template doesn't show, so the roles are trusted not to clash.
 */
export function menuTemplate(
  options: { mac: boolean; packaged: boolean; name: string },
  actions: MenuActions,
  technical: TechnicalItem,
  minimised: readonly MinimisedItem[] = [],
): MenuItemConstructorOptions[] {
  return [
    ...(options.mac ? [appMenu(options.name, actions)] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    // No zoom items: ⌘+ ⌘- ⌘0 size the terminal text, and the board has its own zoom.
    viewMenu(options.packaged, technical),
    windowMenu(options.mac, minimised),
    { role: 'help', submenu: [{ label: 'Getting started', click: actions.gettingStarted }] },
  ];
}
