// An agent's subagents from its Claude hooks (ADR-0004). Pure, so every event's effect is unit-tested.
import { claudeStateAfterHook } from './claude-state.ts';
import type { SessionState, Subagent } from './protocol.ts';

/** How long a finished subagent stays in its agent's list: long enough for its tile to show it leave. */
export const SUBAGENT_RETAIN_MS = 10_000;

/**
 * The subagents after a hook call of their parent's session. `SubagentStart` adds one and `SubagentStop` finishes it;
 * hooks fired inside a subagent carry its `agent_id` and move it as they would an agent. The parent's `Stop` dozes
 * the ones still running (background subagents outlive the turn) and its `StopFailure` fails them. Returns
 * `subagents` itself when nothing changed.
 */
export function subagentsAfterHook(
  subagents: readonly Subagent[],
  payload: Record<string, unknown>,
  now: Date,
): readonly Subagent[] {
  const kept = recentSubagents(subagents, now);
  const id = typeof payload.agent_id === 'string' ? payload.agent_id : undefined;
  switch (payload.hook_event_name) {
    case 'SubagentStart': {
      if (id === undefined || kept.some((subagent) => subagent.id === id)) return kept;
      const type = typeof payload.agent_type === 'string' && payload.agent_type !== '' ? payload.agent_type : 'agent';
      return [...kept, { id, type, state: 'running', startedAt: now.toISOString(), endedAt: null, result: null }];
    }
    case 'SubagentStop': {
      const result = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : null;
      return updateLive(kept, (subagent) => subagent.id === id, { state: 'done', endedAt: now.toISOString(), result });
    }
  }
  // The parent's own turn ending; a subagent's hooks carry its id.
  if (id === undefined && (payload.hook_event_name === 'Stop' || payload.hook_event_name === 'StopFailure')) {
    const state = payload.hook_event_name === 'Stop' ? 'idle' : claudeStateAfterHook('running', payload);
    return updateLive(kept, () => true, { state });
  }
  if (id === undefined) return kept;
  return updateLive(kept, (subagent) => subagent.id === id, (subagent) => ({
    state: claudeStateAfterHook(subagent.state, payload),
  }));
}

/** The subagents once their parent's process has exited in `agentState`: the live ones end with it. */
export function subagentsAfterExit(subagents: readonly Subagent[], agentState: SessionState, now: Date): readonly Subagent[] {
  return updateLive(recentSubagents(subagents, now), () => true, {
    state: agentState === 'failed' ? 'failed' : 'done',
    endedAt: now.toISOString(),
  });
}

/** `subagents` with the live ones `which` picks changed; `subagents` itself if that changes none. */
function updateLive(
  subagents: readonly Subagent[],
  which: (subagent: Subagent) => boolean,
  change: Partial<Subagent> | ((subagent: Subagent) => Partial<Subagent>),
): readonly Subagent[] {
  let changed = false;
  const next = subagents.map((subagent) => {
    if (subagent.endedAt !== null || !which(subagent)) return subagent;
    const updated = { ...subagent, ...(typeof change === 'function' ? change(subagent) : change) };
    if (Object.entries(updated).every(([key, value]) => subagent[key as keyof Subagent] === value)) return subagent;
    changed = true;
    return updated;
  });
  return changed ? next : subagents;
}

/** Each session's subagents, kept in memory: they can't outlive the daemon, as their session's hooks can't reach it. */
export interface SubagentStore {
  /** The session's subagents, without the ones finished long enough ago to forget (even with no hook since). */
  of(id: string): readonly Subagent[];
  set(id: string, next: readonly Subagent[]): void;
  delete(id: string): void;
}

export function createSubagentStore(): SubagentStore {
  const subagents = new Map<string, readonly Subagent[]>();
  const set = (id: string, next: readonly Subagent[]) => {
    if (next.length === 0) subagents.delete(id);
    else subagents.set(id, next);
  };
  return {
    of(id) {
      const known = subagents.get(id) ?? [];
      const recent = recentSubagents(known, new Date());
      if (recent !== known) set(id, recent);
      return recent;
    },
    set,
    delete: (id) => void subagents.delete(id),
  };
}

/** `subagents` without the ones that finished `SUBAGENT_RETAIN_MS` or more ago; `subagents` itself if none did. */
export function recentSubagents(subagents: readonly Subagent[], now: Date): readonly Subagent[] {
  const kept = subagents.filter(
    (subagent) => subagent.endedAt === null || now.getTime() - Date.parse(subagent.endedAt) < SUBAGENT_RETAIN_MS,
  );
  return kept.length === subagents.length ? subagents : kept;
}
