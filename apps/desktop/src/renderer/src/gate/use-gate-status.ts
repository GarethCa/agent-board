import { useCallback, useEffect, useState } from 'react';
import type { GateStatus } from '@agent-board/daemon/protocol';
import { useGateRun } from './GatesProvider';

/**
 * What the agent's gate buttons and Gate tab need from its worktree: the commit it is at, what is uncommitted
 * and its zone's gate command. Asked of the daemon (local git, never GitHub) while `active`: as it becomes so, as its
 * run changes, as `moment` does (the agent's state: a turn that ends may have committed), as the app is focused, and by
 * hand.
 */
export function useGateStatus(sessionId: string | undefined, active: boolean, moment?: string): { status: GateStatus | undefined; refresh(): void } {
  const [status, setStatus] = useState<GateStatus>();
  const run = useGateRun(sessionId);
  const refresh = useCallback(() => {
    if (sessionId === undefined) return;
    window.agentBoard.gates.status(sessionId).then(setStatus, () => {});
  }, [sessionId]);
  // Its run's status and steps: asked again as the run moves on, so a pass on a newer commit shows.
  const runKey = run === undefined ? '' : `${run.startedAt}/${run.status}`;
  useEffect(() => {
    if (!active) return;
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [active, refresh, runKey, moment]);
  return { status, refresh };
}
