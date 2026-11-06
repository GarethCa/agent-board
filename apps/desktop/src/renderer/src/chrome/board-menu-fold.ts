import { useSyncExternalStore } from 'react';
import { storedValue, type StoredValue } from '../stored-value';

/** The board menu's sections that fold. */
export type MenuSection = 'zones' | 'sessions' | 'help' | 'quick-settings';

// Whether each section of the board menu is open: only Zones until the user opens another, then as they left each one, in
// every window. ("sessions-open" is the key the Agents and shells list has always used.)
const FOLDS: Record<MenuSection, StoredValue> = {
  zones: storedValue('agent-board.board-menu.zones-open'),
  sessions: storedValue('agent-board.board-menu.sessions-open'),
  help: storedValue('agent-board.board-menu.help-open'),
  'quick-settings': storedValue('agent-board.board-menu.quick-settings-open'),
};

/** Whether the section is open as the user left it: Zones until they fold it, every other one until they open it. */
export function menuSectionOpen(section: MenuSection): boolean {
  const left = FOLDS[section].get();
  return left === undefined ? section === 'zones' : left === 'open';
}

export function setMenuSectionOpen(section: MenuSection, open: boolean): void {
  FOLDS[section].set(open ? 'open' : 'closed');
}

/** Whether the section is open as the user left it, and a setter that remembers the choice. */
export function useMenuSectionOpen(section: MenuSection): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(FOLDS[section].subscribe, () => menuSectionOpen(section));
  return [open, (next) => setMenuSectionOpen(section, next)];
}
