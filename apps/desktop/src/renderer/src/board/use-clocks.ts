import { useEffect, useState } from 'react';
import type { ClockStatus } from '@agent-board/daemon/protocol';

/**
 * Every clock's status, by its id, kept live: when each next runs and how its latest runs went. Asked for once the board
 * has `loaded`, so a daemon that can't start is the board's to report (and retry), not this list's.
 */
export function useClockStatuses(report: (action: string) => (error: unknown) => void, loaded: boolean): ReadonlyMap<string, ClockStatus> {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, ClockStatus>>(new Map());
  useEffect(() => {
    if (!loaded) return;
    let live = true;
    const stop = window.agentBoard.items.onClockChanged(({ status }) => setStatuses((current) => new Map(current).set(status.id, status)));
    window.agentBoard.items.clocks().then(
      (all) => {
        // A change heard meanwhile is newer than the list.
        if (live) setStatuses((current) => new Map([...all.map((status) => [status.id, status] as const), ...current]));
      },
      report('load the clocks'),
    );
    return () => {
      live = false;
      stop();
    };
  }, [report, loaded]);
  return statuses;
}
