// What the menu bar's renderer half and its main half say to each other. Main draws the native menus (`main/app-menu.ts`);
// the focused window says what its keys are and what the agent or project selected in it can do, and runs the item picked.

/** How a key-registry action shows in the menu bar, as the focused window has it now. */
export interface MenuBarKey {
  /** An Electron accelerator for its chord, when it has a modifier: bare board keys are never accelerators. */
  accelerator?: string;
  /** The key as the registry writes it, such as `⌘D` or `A`. */
  text?: string;
  /** False while the action is off: an extended key with the setting off, or a Simplified key under Classic. */
  enabled: boolean;
}

/** A row of a model menu (`renderer/src/board/menu-model.tsx`), as data main can draw. */
export type MenuBarRow =
  | {
      /** The row's path in its menu, `submenu/row`, which a pick sends back. */
      id: string;
      label: string;
      enabled: boolean;
      /** The board key the ⋯ menu shows at the row's end. */
      shortcut?: string;
      checked?: boolean;
      danger?: boolean;
      entries?: MenuBarRow[];
    }
  | { heading: string }
  | 'separator';

/** Menu bar items with no key of their own that a window runs: the board's zoom controls and the Needs-you pill. */
export const MENU_BAR_ACTIONS = ['zoomIn', 'zoomOut', 'zoomToFit', 'snapToGrid', 'minimap', 'needsYou'] as const;
export type MenuBarAction = (typeof MENU_BAR_ACTIONS)[number];

/** The menus a selection fills. */
export type MenuBarSection = 'agent' | 'project';

/** What a window tells main, whenever it changes and it has the focus or gains it. */
export interface MenuBarState {
  /** Every registry action, by its id. */
  keys: Readonly<Record<string, MenuBarKey>>;
  /** The window's own commands that have no key (`MenuBarAction`) and it can run now; a toggle says whether it is on. */
  actions: Readonly<Partial<Record<MenuBarAction, { checked?: boolean }>>>;
  /** The menu of the agent selected, or null with none. */
  agent: readonly MenuBarRow[] | null;
  /** The menu of the project (zone) selected, or null with none. */
  project: readonly MenuBarRow[] | null;
}

/** An item picked in the menu bar, for the focused window to run. */
export type MenuBarCommand =
  /** A key-registry action. `viaKey`: its accelerator was pressed, rather than the item clicked. */
  | { kind: 'key'; id: string; viaKey: boolean }
  /** One of the window's own commands. */
  | { kind: 'action'; id: MenuBarAction }
  /** A row of the agent's or the project's menu, by its path. */
  | { kind: 'row'; section: MenuBarSection; id: string };

/** Before a window reports: no keys known, nothing selected. */
export const NO_MENU_BAR_STATE: MenuBarState = { keys: {}, actions: {}, agent: null, project: null };
