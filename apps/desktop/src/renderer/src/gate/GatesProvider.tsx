import { createContext, use, useEffect, useState, type ReactNode } from 'react';
import type { GateRun, GateUpdatedEvent } from '@agent-board/daemon/protocol';
import { withGateChange } from './gate-view';

/** None outside a provider: a gallery's tiles have no gate runs. */
const GatesContext = createContext<ReadonlyMap<string, GateRun>>(new Map());

/** Every agent's latest gate run, as the daemon has them and every window hears them change. */
export function GatesProvider({ children }: { children: ReactNode }) {
  const [runs, setRuns] = useState<ReadonlyMap<string, GateRun>>(new Map());
  // Subscribed before the list: a change that crossed it is applied again on top.
  useEffect(() => {
    let backlog: GateUpdatedEvent[] | undefined = [];
    let cancelled = false;
    const unsubscribe = window.agentBoard.gates.onChanged((change) => {
      if (backlog !== undefined) backlog.push(change);
      else setRuns((current) => withGateChange(current, change));
    });
    window.agentBoard.gates.list().then(
      (listed) => {
        if (cancelled) return;
        setRuns(backlog!.reduce(withGateChange, new Map(listed.map((run) => [run.sessionId, run]))));
        backlog = undefined;
      },
      // Without them tiles show no badge until a run changes.
      () => (backlog = undefined),
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return <GatesContext value={runs}>{children}</GatesContext>;
}

/** Every agent's latest gate run, by agent. */
export function useGateRuns(): ReadonlyMap<string, GateRun> {
  return use(GatesContext);
}

/** The agent's latest gate run, if it has one. */
export function useGateRun(sessionId: string | undefined): GateRun | undefined {
  const runs = use(GatesContext);
  return sessionId === undefined ? undefined : runs.get(sessionId);
}
