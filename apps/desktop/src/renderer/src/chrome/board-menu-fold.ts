import { useSyncExternalStore } from 'react';
import { storedValue } from '../stored-value';

// Whether the board menu's "Agents and shells" list is open: closed until the user opens it, then as they left it, in
// every window.
const sessionsFold = storedValue('agent-board.board-menu.sessions-open');

/** Whether the list is open as the user left it (false until they open it), and a setter that remembers the choice. */
export function useSessionsOpen(): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(sessionsFold.subscribe, () => sessionsFold.get() === 'open');
  return [open, (next) => sessionsFold.set(next ? 'open' : 'closed')];
}
