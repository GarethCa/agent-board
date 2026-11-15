import { useEffect, useMemo, useState } from 'react';
import type { Agent, BoardItem } from '@agent-board/daemon/protocol';
import type { ItemChange } from '../../../preload/api';

/** The items on tickets' own boards, by id: `change` applied, kept only while the item is on a ticket's board. */
export function withTicketItemChange(items: ReadonlyMap<string, BoardItem>, change: ItemChange): ReadonlyMap<string, BoardItem> {
  const id = change.type === 'item.updated' ? change.item.id : change.id;
  const onTicket = change.type === 'item.updated' && typeof change.item.ticket === 'string';
  if (!onTicket && !items.has(id)) return items;
  const next = new Map(items);
  if (onTicket) next.set(id, change.item);
  else next.delete(id);
  return next;
}

/**
 * The items `listed` on the boards of `tickets`, merged into those `known`: an item `changed` since the lists were
 * asked for is as the change left it (deleted, or edited), and an item known on a ticket no longer here is dropped.
 */
export function withListedTicketItems(known: ReadonlyMap<string, BoardItem>, listed: readonly BoardItem[], tickets: readonly string[], changed: ReadonlySet<string>): ReadonlyMap<string, BoardItem> {
  const kept = [...known].filter(([, item]) => tickets.some((id) => id === item.ticket));
  return new Map([...listed.filter((item) => !changed.has(item.id)).map((item) => [item.id, item] as const), ...kept]);
}

/** The notes, documents and other items on the boards of the tickets among `agents`, for ⌘K to find. */
export function useTicketItems(agents: readonly Agent[]): readonly BoardItem[] {
  // The tickets as one string, so the lists are asked for again only when a ticket comes or goes.
  const tickets = useMemo(
    () =>
      agents
        .filter((agent) => agent.ticketChat)
        .map((agent) => agent.sessionId)
        .sort()
        .join('\n'),
    [agents],
  );
  const [items, setItems] = useState<ReadonlyMap<string, BoardItem>>(new Map());
  useEffect(() => {
    let current = true;
    const ids = tickets === '' ? [] : tickets.split('\n');
    // What a change says once the lists are asked for is newer than them.
    const changed = new Set<string>();
    const unsubscribe = window.agentBoard.items.onChanged((change) => {
      changed.add(change.type === 'item.updated' ? change.item.id : change.id);
      setItems((known) => withTicketItemChange(known, change));
    });
    // A ticket's board that won't list leaves its items unfound, the rest still found.
    Promise.all(ids.map((id) => window.agentBoard.items.list(id).catch(() => [] as BoardItem[]))).then(
      (lists) => current && setItems((known) => withListedTicketItems(known, lists.flat(), ids, changed)),
      () => {},
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [tickets]);
  return useMemo(() => [...items.values()], [items]);
}
