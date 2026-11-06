import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, Shell } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { crewTracker, directoryTracker, type AgentTracker } from './crew-agents';

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

/**
 * The selection `tracker` makes of the agents, kept live; undefined until listed. The state it sets is the tracker's
 * array, which stays the same one until the selection changes, so a component renders for no other agent's change.
 * `watching` is applied to the tracker as it is made and whenever it changes. The listing is retried until it
 * succeeds, like `useLiveList`'s.
 */
function useAgentSelection<T extends AgentTracker>(make: () => T, applyTo: (tracker: T) => void, remake: readonly unknown[], when: unknown): { agents: Agent[] | undefined; problem: string | undefined } {
  const [selected, setSelected] = useState<Agent[]>();
  const [problem, setProblem] = useState<string>();
  const tracker = useRef<T | undefined>(undefined);
  const latest = useRef(applyTo);
  latest.current = applyTo;
  useEffect(() => {
    if (tracker.current === undefined) return;
    latest.current(tracker.current);
    setSelected(tracker.current.snapshot());
  }, [when]);
  useEffect(() => {
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const own = make();
    latest.current(own);
    tracker.current = own;
    const unsubscribe = hearAgents((change) => {
      own.hear(change);
      setSelected(own.snapshot());
    });
    const read = () =>
      listAgents().then(
        (listed) => {
          if (!live) return;
          own.load(listed);
          setSelected(own.snapshot());
          setProblem(undefined);
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
      tracker.current = undefined;
      // Another session's selection must not show while this one lists.
      setSelected(undefined);
    };
  }, remake);
  return { agents: selected, problem };
}

/**
 * The agents `parentId` started or recorded starting (`recordedKeys`), kept live; undefined until listed. It renders
 * again only when one of those changes, not for any other agent's.
 */
export function useCrewAgents(parentId: string, recordedKeys: readonly string[]): Agent[] | undefined {
  const keysId = recordedKeys.join('\n');
  return useAgentSelection(
    () => crewTracker(parentId),
    (tracker) => tracker.setKeys(keysId === '' ? [] : keysId.split('\n')),
    [parentId],
    keysId,
  ).agents;
}

/**
 * Every agent, for a window's tabs and its + menu, with `watching` (the session ids it shows) kept as they are and
 * the rest known by id and name alone: it renders again for a watched agent's change, an agent's coming, going or
 * renaming, and no other. Undefined until listed, with why it isn't.
 */
export function useDirectoryAgents(watching: readonly string[]): { agents: Agent[] | undefined; problem: string | undefined } {
  const watchingId = watching.join('\n');
  return useAgentSelection(
    directoryTracker,
    (tracker) => tracker.watch(watchingId === '' ? [] : watchingId.split('\n')),
    [],
    watchingId,
  );
}
