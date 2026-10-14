import { useCallback, useEffect, useState } from 'react';
import type { Agent, Shell } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';

/** A change to a live list: one item added or replaced, or one removed by its id. */
type ListChange<T> = { put: T } | { removed: string };

/** How long a window waits to list again after listing failed. */
const RELIST_MS = 3000;

/**
 * A list the daemon keeps, kept live: listed as the window opens, then changed as the daemon says. Undefined until
 * listed: a list that couldn't be read is never taken for an empty one (a window would lay out its tabs against
 * nothing), so it says why in `problem` and is listed again shortly. Changes heard while the list is in flight are
 * newer than it, so they are played over it. `put` takes one in at once, from the call that made or changed it, before
 * its event arrives.
 */
function useLiveList<T>(
  list: () => Promise<T[]>,
  subscribe: (hear: (change: ListChange<T>) => void) => () => void,
  idOf: (item: T) => string,
): { items: T[] | undefined; problem: string | undefined; put(item: T): void } {
  const [items, setItems] = useState<T[]>();
  const [problem, setProblem] = useState<string>();
  const update = useCallback(
    (current: T[], change: ListChange<T>): T[] => {
      if ('removed' in change) return current.filter((item) => idOf(item) !== change.removed);
      const id = idOf(change.put);
      return current.some((item) => idOf(item) === id) ? current.map((item) => (idOf(item) === id ? change.put : item)) : [...current, change.put];
    },
    [idOf],
  );
  useEffect(() => {
    let live = true;
    let early: ListChange<T>[] | undefined = [];
    let retry: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe((change) => {
      early?.push(change);
      setItems((current) => (current === undefined ? current : update(current, change)));
    });
    const read = () =>
      list().then(
        (all) => {
          if (!live) return;
          setItems(early!.reduce(update, all));
          setProblem(undefined);
          early = undefined;
        },
        (error: unknown) => {
          if (!live) return;
          setProblem(errorMessage(error));
          retry = setTimeout(read, RELIST_MS);
        },
      );
    void read();
    return () => {
      live = false;
      clearTimeout(retry);
      unsubscribe();
    };
  }, [list, subscribe, update]);
  const put = useCallback((item: T) => setItems((current) => (current === undefined ? current : update(current, { put: item }))), [update]);
  return { items, problem, put };
}

const listShells = () => window.agentBoard.shells.list();
const hearShells = (hear: (change: ListChange<Shell>) => void) =>
  window.agentBoard.shells.onChanged((event) => hear(event.type === 'shell.updated' ? { put: event.shell } : { removed: event.shellId }));
const shellId = (shell: Shell) => shell.id;

/** Every shell the daemon has, tiles and tabs, kept live; undefined until listed, with why it isn't. `apply` takes one in from a call. */
export function useLiveShells(): { shells: Shell[] | undefined; problem: string | undefined; apply(shell: Shell): void } {
  const { items, problem, put } = useLiveList(listShells, hearShells, shellId);
  return { shells: items, problem, apply: put };
}

const listAgents = () => window.agentBoard.agents.list();
const hearAgents = (hear: (change: ListChange<Agent>) => void) =>
  window.agentBoard.agents.onChanged((event) => hear(event.type === 'agent.updated' ? { put: event.agent } : { removed: event.sessionId }));
const agentId = (agent: Agent) => agent.sessionId;

/** Every agent, kept live; undefined until listed, with why it isn't. */
export function useLiveAgents(): { agents: Agent[] | undefined; problem: string | undefined } {
  const { items, problem } = useLiveList(listAgents, hearAgents, agentId);
  return { agents: items, problem };
}
