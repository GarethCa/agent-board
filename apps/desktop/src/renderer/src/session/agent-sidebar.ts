// An agent's window shows its shelves, under either design: the shelves open on the agent's own page, with the rest a
// tab away. Shells, tab windows and a session with no agent keep the details strip.
import { storedValue } from '../stored-value';

/**
 * Whether a window shows the shelves: an agent's own window. A session with no agent (one that isn't an agent, one not
 * listed yet, one deleted) keeps the details strip, as shells and tab windows do: the shelves have nothing to say of it.
 */
export function showsShelves(content: { kind: string; agent?: unknown }): boolean {
  return content.kind === 'session' && content.agent !== undefined;
}

/** Whether the shelves are collapsed to their rail (`rail`) or open (unset): one choice for every agent window, ⌘I's. */
export const shelvesCollapsed = storedValue('agent-board.shelves-rail');
