import type { AgentState } from './protocol.ts';

/**
 * When each agent's shown state began (`Agent.stateSince`), kept in memory as its agent is read: a state read again
 * keeps its time, and a new one starts now. A hand-off is timed as part of the state it came from, so an agent idle
 * for an hour still reads so after handing off. An agent first read after a daemon restart starts at `fallback` when
 * its row knows when its state began (when it was paused, or ended), else at that first read.
 */
export function stateClock() {
  const seen = new Map<string, { state: AgentState; since: string }>();
  return {
    since(sessionId: string, state: AgentState, now: string, fallback: string | null): string {
      const last = seen.get(sessionId);
      if (last !== undefined && (last.state === state || state === 'handing-off')) return last.since;
      const since = last === undefined && fallback !== null ? fallback : now;
      seen.set(sessionId, { state, since });
      return since;
    },
    /** Drops a deleted agent's time. */
    forget(sessionId: string): void {
      seen.delete(sessionId);
    },
  };
}
