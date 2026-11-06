// The agents a details strip needs: the ones an agent started, and the ones it recorded starting. Pure, so it is
// unit-tested; `useCrewAgents` keeps the strip from rendering for any other agent's change.
import type { Agent } from '@agent-board/daemon/protocol';

/** Whether `parentId` started `agent`: the one rule for who is in a crew, shared with the Crew section. */
export const startedBy = (agent: Pick<Agent, 'spawnedBy'>, parentId: string): boolean => agent.spawnedBy === parentId;

/** The agents `parentId` started, or whose session ids are in `recordedKeys`, in the order `all` lists them. */
export function crewAgents(all: Iterable<Agent>, parentId: string, recordedKeys: ReadonlySet<string>): Agent[] {
  const crew: Agent[] = [];
  for (const each of all) if (startedBy(each, parentId) || recordedKeys.has(each.sessionId)) crew.push(each);
  return crew;
}

/** Whether `next` holds the very same agent objects as `current`, in the same order: then nothing has changed. */
function sameAgents(current: readonly Agent[], next: readonly Agent[]): boolean {
  return current.length === next.length && current.every((each, index) => each === next[index]);
}

/** A change to the agents: one added or replaced, or one removed by its session id. */
export type AgentChange = { put: Agent } | { removed: string };

/** Follows every agent and exposes a selection of them, as an array that stays the very same one until it changes. */
export interface AgentTracker {
  /** The agents as listed. Changes heard before this are played over them. */
  load(listed: readonly Agent[]): void;
  /** Takes in a heard change. */
  hear(change: AgentChange): void;
  /** The selection: undefined until loaded. */
  snapshot(): Agent[] | undefined;
}

/**
 * A tracker whose selection is `pick(all, previous)`: in the order `all` lists them, with `previous` the selection
 * before, to reuse its objects. `refresh` picks again, after what `pick` reads has changed.
 */
function agentTracker(pick: (all: ReadonlyMap<string, Agent>, previous: Agent[] | undefined) => Agent[]): AgentTracker & { refresh(): void } {
  let all: Map<string, Agent> | undefined;
  let early: AgentChange[] | undefined = [];
  let selected: Agent[] | undefined;
  const apply = (map: Map<string, Agent>, change: AgentChange) => {
    if ('removed' in change) map.delete(change.removed);
    else map.set(change.put.sessionId, change.put);
  };
  const refresh = () => {
    if (all === undefined) return;
    const next = pick(all, selected);
    if (selected === undefined || !sameAgents(selected, next)) selected = next;
  };
  return {
    load(listed) {
      const map = new Map(listed.map((each) => [each.sessionId, each]));
      for (const change of early ?? []) apply(map, change);
      early = undefined;
      all = map;
      refresh();
    },
    hear(change) {
      early?.push(change);
      if (all === undefined) return;
      apply(all, change);
      refresh();
    },
    snapshot: () => selected,
    refresh,
  };
}

export interface CrewTracker extends AgentTracker {
  /** The session ids of the crew records, which count as crew whoever started them. */
  setKeys(keys: readonly string[]): void;
}

/** Follows the whole board's agents and exposes only the crew of `parentId`. */
export function crewTracker(parentId: string): CrewTracker {
  let keys: ReadonlySet<string> = new Set();
  const tracker = agentTracker((all) => crewAgents(all.values(), parentId, keys));
  return {
    ...tracker,
    setKeys(next) {
      keys = new Set(next);
      tracker.refresh();
    },
  };
}

export interface DirectoryTracker extends AgentTracker {
  /** The session ids of the agents a window shows, whose every change it needs. */
  watch(ids: readonly string[]): void;
}

/**
 * Follows every agent for a window's tabs and its + menu. A watched agent (the window's own, and those its tabs show)
 * is kept as it is; any other is known by its id and name alone, for the menu, so its other changes (its state, its
 * last message) leave the array the same one. The window renders for none of them.
 */
export function directoryTracker(): DirectoryTracker {
  let watched: ReadonlySet<string> = new Set();
  const tracker = agentTracker((all, previous) => {
    const before = new Map(previous?.map((each) => [each.sessionId, each]));
    return [...all.values()].map((each) => {
      const known = before.get(each.sessionId);
      return !watched.has(each.sessionId) && known?.name === each.name ? known : each;
    });
  });
  return {
    ...tracker,
    watch(ids) {
      watched = new Set(ids);
      tracker.refresh();
    },
  };
}
