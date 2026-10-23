import { useCallback, useEffect, useState } from 'react';
import type { AgentStart } from '@agent-board/daemon/protocol';
import type { AgentStartChange } from '../../../preload/api';

/** A start as the board shows it: `lost` when the daemon no longer knows it (it restarted mid-start), so only Delete is left. */
export type ShownStart = AgentStart & { lost?: true };

/** What a lost start's tile says. */
export const LOST_START_ERROR = 'agent-board restarted while it was starting: delete it and start it again.';

/** `starts` with a heard change applied (not a reset, which lists them again). */
export function withStartChange(starts: readonly ShownStart[], change: AgentStartChange): ShownStart[] {
  if (change.type === 'agent.startsReset') return [...starts];
  if (change.type === 'agent.startEnded') return starts.filter((start) => start.sessionId !== change.sessionId);
  const index = starts.findIndex((start) => start.sessionId === change.start.sessionId);
  return index < 0 ? [...starts, change.start] : starts.with(index, change.start);
}

/**
 * `listed`, the starts the daemon knows, with the ones the board showed that it doesn't kept as lost: a daemon that
 * restarted mid-start has no record of them, so their tiles say so, and only Delete takes them away.
 */
export function withListedStarts(shown: readonly ShownStart[], listed: readonly AgentStart[]): ShownStart[] {
  const known = new Set(listed.map((start) => start.sessionId));
  const lost = shown
    .filter((start) => !known.has(start.sessionId))
    .map((start): ShownStart => ({ ...start, error: LOST_START_ERROR, confirm: false, lost: true }));
  return [...listed, ...lost];
}

/**
 * The agents being started, and the starts that failed (`AgentStart`), from the daemon: listed once and kept current
 * by their changes, and listed again each time the app reaches the daemon anew. Subscribed before each list, so a
 * change that crosses it is applied again on top. `drop` takes a start's tile away here, whatever the daemon says.
 */
export function useAgentStarts(report: (action: string) => (error: unknown) => void): { starts: ShownStart[]; drop(sessionId: string): void } {
  const [starts, setStarts] = useState<ShownStart[]>([]);
  useEffect(() => {
    let crossed: AgentStartChange[] | undefined;
    let cancelled = false;
    const list = () => {
      crossed = [];
      window.agentBoard.agents.starts().then((listed) => {
        if (cancelled) return;
        const changes = crossed ?? [];
        crossed = undefined;
        setStarts((shown) => changes.reduce(withStartChange, withListedStarts(shown, listed)));
      }, report('list the agents being started'));
    };
    const unsubscribe = window.agentBoard.agents.onStartChanged((change) => {
      if (change.type === 'agent.startsReset') return list();
      crossed?.push(change);
      setStarts((current) => withStartChange(current, change));
    });
    list();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [report]);
  const drop = useCallback((sessionId: string) => setStarts((current) => current.filter((start) => start.sessionId !== sessionId)), []);
  return { starts, drop };
}
