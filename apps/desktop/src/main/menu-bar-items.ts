import type { MenuItemConstructorOptions } from 'electron';
import { NO_MENU_BAR_STATE, type MenuBarAction, type MenuBarCommand, type MenuBarRow, type MenuBarSection, type MenuBarState } from '../shared/menu-bar';

/** What the menu bar's items are drawn from and send their picks to: the focused window's state, and that window. */
export interface MenuBar {
  state: MenuBarState;
  run(command: MenuBarCommand): void;
}

export const NO_MENU_BAR: MenuBar = { state: NO_MENU_BAR_STATE, run: () => {} };

/** Electron passes a menu item's click this: whether its accelerator was pressed. */
type ClickEvent = { triggeredByAccelerator?: boolean } | undefined;

/**
 * The items one menu bar draws from its state. Each chord is one item's accelerator only: the first enabled item to ask
 * for it gets it (so on the board ⌘D is Duplicate's, and in a session window Split Beside's), and another shows it as a
 * grey line (`also`, such as "in a session window"), so the menu bar never holds
 * a chord twice. A bare board key is never an accelerator, as it would fire while you type: it shows as "Board key: A".
 */
export function menuBarItems(bar: MenuBar, taken: readonly string[] = []) {
  const used = new Set(taken);
  return {
    /** The key-registry action `id`, which the focused window runs as if its key were pressed. */
    key(label: string, id: string, also?: string): MenuItemConstructorOptions {
      const key = bar.state.keys[id];
      const enabled = key?.enabled ?? true;
      const accelerator = enabled && key?.accelerator !== undefined && !used.has(key.accelerator) ? key.accelerator : undefined;
      if (accelerator !== undefined) used.add(accelerator);
      const sublabel =
        key?.text === undefined || accelerator !== undefined ? undefined : key.accelerator === undefined ? `Board key: ${key.text}` : `${key.text}${also === undefined ? '' : ` ${also}`}`;
      return {
        label,
        ...(accelerator === undefined ? {} : { accelerator }),
        ...(sublabel === undefined ? {} : { sublabel }),
        enabled,
        click: (_item, _window, event: ClickEvent) => bar.run({ kind: 'key', id, viaKey: event?.triggeredByAccelerator === true }),
      };
    },
    /** One of the window's own commands with no key: greyed when the focused window has nothing to run it. */
    action(label: string, id: MenuBarAction, toggle = false): MenuItemConstructorOptions {
      const action = bar.state.actions[id];
      return {
        label,
        ...(toggle ? { type: 'checkbox' as const, checked: action?.checked === true } : {}),
        enabled: action !== undefined,
        click: () => bar.run({ kind: 'action', id }),
      };
    },
  };
}

/**
 * The agent's or the project's menu, as the selection's ⋯ menu lists it, or `none` greyed when nothing is selected. A
 * row keeps its board key as a grey line; a destructive one can't be drawn red in a native menu.
 */
export function selectionMenu(bar: MenuBar, section: MenuBarSection, none: string): MenuItemConstructorOptions[] {
  const rows = bar.state[section];
  if (rows === null || rows.length === 0) return [{ label: none, enabled: false }];
  const item = (row: MenuBarRow): MenuItemConstructorOptions => {
    if (row === 'separator') return { type: 'separator' };
    if ('heading' in row) return { label: row.heading, enabled: false };
    return {
      label: row.label,
      enabled: row.enabled,
      ...(row.shortcut === undefined ? {} : { sublabel: `Board key: ${row.shortcut}` }),
      ...(row.checked === undefined ? {} : { type: 'checkbox' as const, checked: row.checked }),
      ...(row.entries === undefined ? { click: () => bar.run({ kind: 'row', section, id: row.id }) } : { submenu: row.entries.map(item) }),
    };
  };
  return rows.map(item);
}
