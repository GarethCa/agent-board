import { useEffect, useState } from 'react';
import type { Agent, Shell, Zone } from '@agent-board/daemon/protocol';

/** Replaces `item` in `list` by its key, adding it if it is new. */
function upsert<T>(list: readonly T[], item: T, key: (item: T) => string): T[] {
  return list.some((known) => key(known) === key(item)) ? list.map((known) => (key(known) === key(item) ? item : known)) : [...list, item];
}

/** Keeps a list live: listed once, then changed by each event heard, a change heard while it lists taking precedence. */
function useLiveList<T, C>(list: () => Promise<T[]>, subscribe: (listener: (change: C) => void) => () => void, apply: (current: T[], change: C) => T[]): T[] | undefined {
  const [items, setItems] = useState<T[]>();
  useEffect(() => {
    let changes: C[] = [];
    let listed = false;
    const unsubscribe = subscribe((change) => {
      if (listed) setItems((current) => apply(current ?? [], change));
      else changes.push(change);
    });
    list().then(
      (all) => {
        listed = true;
        setItems(changes.reduce(apply, all));
        changes = [];
      },
      () => {
        listed = true;
        setItems((current) => current ?? []);
      },
    );
    return unsubscribe;
    // Listed once: the functions are the preload's, the same each render.
  }, []);
  return items;
}

/**
 * The agents, shells and zones, kept live from the daemon's changes: for a window without the board's own lists, such
 * as a popped-out session window's ⌘K switcher. Each is undefined until listed.
 */
export function useLiveLists(): { agents: readonly Agent[]; shells: readonly Shell[] | undefined; zones: readonly Zone[] } {
  const { agents, shells, zones } = window.agentBoard;
  const liveAgents = useLiveList(agents.list, agents.onChanged, (current, change) =>
    change.type === 'agent.removed' ? current.filter((agent) => agent.sessionId !== change.sessionId) : upsert(current, change.agent, (agent) => agent.sessionId),
  );
  const liveShells = useLiveList(shells.list, shells.onChanged, (current, change) =>
    change.type === 'shell.removed' ? current.filter((shell) => shell.id !== change.shellId) : upsert(current, change.shell, (shell) => shell.id),
  );
  const liveZones = useLiveList(zones.list, zones.onChanged, (current, change) =>
    change.type === 'zone.removed' ? current.filter((zone) => zone.id !== change.id) : upsert(current, change.zone, (zone) => zone.id),
  );
  return { agents: liveAgents ?? [], shells: liveShells, zones: liveZones ?? [] };
}
