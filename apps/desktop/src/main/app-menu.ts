import type { MenuItemConstructorOptions } from 'electron';
import { menuBarItems, NO_MENU_BAR, selectionMenu, type MenuBar } from './menu-bar-items';
import { viewMenu, type TechnicalItem } from './view-menu';

type MenuBarKeys = ReturnType<typeof menuBarItems>;

/** Where Check for Updates… goes until the app has an updater of its own. */
export const RELEASES_URL = 'https://github.com/GarethCa/agent-board/releases';

/** Window › Overview's shortcut: ⌘⇧O, or Ctrl+Shift+O, from any window. */
const OVERVIEW_ACCELERATOR = 'CommandOrControl+Shift+O';
const SETTINGS_ACCELERATOR = 'CommandOrControl+,';
/** File › Close Window, off ⌘W, which Close Tab owns (as in Safari). Off macOS Ctrl+Shift+W is a session window's Close Tab. */
const CLOSE_WINDOW_ACCELERATOR = 'Command+Shift+W';
/** With no tab to close (the board, Settings, the Overview), ⌘W closes the window, as in Safari. */
const CLOSE_WINDOW_ACCELERATOR_NO_TABS = 'Command+W';

/** The accelerators main's own items hold, which no registry action may take. */
const MAIN_ACCELERATORS = [SETTINGS_ACCELERATOR, OVERVIEW_ACCELERATOR, CLOSE_WINDOW_ACCELERATOR];

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
      { label: 'Settings…', accelerator: SETTINGS_ACCELERATOR, click: actions.settings },
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

/** File: what makes something on the board, then a session window's tabs, then closing. */
function fileMenu(mac: boolean, keys: MenuBarKeys): MenuItemConstructorOptions {
  const closeTab = keys.key('Close Tab', 'window.closeTab');
  return {
    label: 'File',
    submenu: [
      keys.key('New Agent…', 'make.agent'),
      keys.key('New Shell', 'make.shell'),
      keys.key('New Zone', 'make.zone'),
      keys.key('New Sticky Note', 'make.note'),
      keys.key('New Text', 'make.text'),
      keys.key('New Shape', 'make.shape'),
      keys.key('Find a Shape…', 'make.insert'),
      { type: 'separator' },
      keys.key('New Shell Tab', 'window.newTab'),
      keys.key('Save Document', 'window.saveDoc'),
      { type: 'separator' },
      closeTab,
      // Not the close role, whose own ⌘W (Ctrl+W off macOS, a terminal's delete-word) it would bring back.
      { label: 'Close Window', ...(mac ? { accelerator: closeTab.accelerator === undefined ? CLOSE_WINDOW_ACCELERATOR_NO_TABS : CLOSE_WINDOW_ACCELERATOR } : {}), click: (_item, window) => window?.close() },
      ...(mac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
    ],
  };
}

/**
 * Edit: the roles, so copy and paste work in every field, with the board's own actions beside them. Duplicate and
 * Order own ⌘D and ⌘[ ⌘]; Window's session items show them as a grey line.
 */
function editMenu(keys: MenuBarKeys, mac: boolean): MenuItemConstructorOptions {
  return {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(mac ? [{ role: 'pasteAndMatchStyle' as const }] : []),
      keys.key('Duplicate', 'edit.duplicate'),
      keys.key('Delete', 'edit.delete'),
      { role: 'selectAll' },
      { type: 'separator' },
      {
        label: 'Order',
        submenu: [keys.key('Bring to Front', 'edit.front'), keys.key('Bring Forward', 'edit.forward'), keys.key('Send Backward', 'edit.backward'), keys.key('Send to Back', 'edit.back')],
      },
      keys.key('Swap Arrow Direction', 'edit.swapDirection'),
      keys.key('Reset Rotation', 'edit.resetRotation'),
      { type: 'separator' },
      keys.key('Ask Claude About Selection', 'make.askClaude'),
    ],
  };
}

/**
 * Electron's Window menu: Overview (⌘⇧O) first, then its own items, the board's ways round (Board Menu, Jump to…, Needs
 * You, the Captain) and a session window's, with a Minimised section after its own items (when any window is
 * minimised) so a window that is not in the dock, because the Dock setting leaves it out, is still found. The section's
 * labels are the windows' names.
 */
export function windowMenu(mac: boolean, overview: () => void, minimised: readonly MinimisedItem[], keys: MenuBarKeys = menuBarItems(NO_MENU_BAR)): MenuItemConstructorOptions {
  const items = minimised.map((item): MenuItemConstructorOptions => ({ label: item.title, click: item.restore }));
  const section: MenuItemConstructorOptions[] = items.length === 0 ? [] : [{ type: 'separator' }, { label: 'Minimised', enabled: false }, ...items];
  return {
    role: 'windowMenu',
    submenu: [
      { label: 'Overview', accelerator: OVERVIEW_ACCELERATOR, click: overview },
      { type: 'separator' },
      { role: 'minimize' },
      { role: 'zoom' },
      { type: 'separator' },
      keys.key('Board Menu', 'move.boardMenu'),
      keys.key('Jump to Session or Zone…', 'move.spotlight'),
      keys.action('Needs You', 'needsYou'),
      keys.key('Open the Captain', 'move.master'),
      { type: 'separator' },
      keys.key('Previous Session in Group', 'window.previous', 'in a session window'),
      keys.key('Next Session in Group', 'window.next', 'in a session window'),
      keys.key('Split Beside', 'window.splitBeside', 'in a session window'),
      keys.key('Split Below', 'window.splitBelow'),
      ...(mac ? [{ type: 'separator' as const }, { role: 'front' as const }] : []),
      ...section,
    ],
  };
}

/** What the menu bar's items do. */
export interface MenuActions extends AppMenuActions {
  gettingStarted(): void;
  /** Opens the Overview window, or brings it forward. */
  overview(): void;
}

/**
 * The whole menu bar: File, Edit, View, Agent, Project, Window and Help, and on macOS the app menu first. A
 * key-registry item runs its action in the focused window (`bar`) as if its key were pressed, so it routes by focus as
 * the key does; Agent and Project are the selection's own ⋯ menu. Items given a `role` take Electron's own
 * accelerators, which this template doesn't show, so the roles are trusted not to clash. No zoom roles: ⌘+ ⌘- ⌘0 are
 * the terminal text's, and board zoom has no key.
 */
export function menuTemplate(
  options: { mac: boolean; packaged: boolean; name: string },
  actions: MenuActions,
  technical: TechnicalItem,
  minimised: readonly MinimisedItem[] = [],
  bar: MenuBar = NO_MENU_BAR,
): MenuItemConstructorOptions[] {
  const keys = menuBarItems(bar, MAIN_ACCELERATORS);
  // Built in the bar's order, so the first menu to ask for a shared chord holds it.
  const file = fileMenu(options.mac, keys);
  const edit = editMenu(keys, options.mac);
  const view = viewMenu(options.packaged, technical, keys);
  const agent: MenuItemConstructorOptions = { label: 'Agent', submenu: selectionMenu(bar, 'agent', 'Select an agent on the board') };
  const project: MenuItemConstructorOptions = {
    label: 'Project',
    submenu: [...selectionMenu(bar, 'project', 'Select a project on the board'), { type: 'separator' }, keys.key('Arrange the Board', 'edit.arrangeBoard')],
  };
  const window = windowMenu(options.mac, actions.overview, minimised, keys);
  const help: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [{ label: 'Getting started', click: actions.gettingStarted }, keys.key('Keyboard Shortcuts', 'move.cheatSheetAnywhere')],
  };
  return [...(options.mac ? [appMenu(options.name, actions)] : []), file, edit, view, agent, project, window, help];
}
