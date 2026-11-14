// What each stage board draws at the foot of its To do: the open jobs on its zone's queues that are put off for later.
// Read again when one of those queues is written (every write moves its `updatedAt`), and when the soonest of them comes
// back.
import { useEffect, useMemo, useState } from 'react';
import { laterByZone, sameLater, type StageLater, stageQueues } from './stage-boards';
import type { BoardNode } from './tiles';

export function useStageLater(nodes: readonly BoardNode[]): StageLater {
  const listed = JSON.stringify(stageQueues(nodes));
  const queues = useMemo(() => JSON.parse(listed) as ReturnType<typeof stageQueues>, [listed]);
  const [later, setLater] = useState<StageLater>(new Map());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (queues.length === 0) {
      setLater((was) => (was.size === 0 ? was : new Map()));
      return;
    }
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    Promise.allSettled(queues.map((queue) => window.agentBoard.items.readQueue(queue.id))).then((reads) => {
      if (!current) return;
      const { byZone, wait } = laterByZone(
        reads.map((read, index) => (read.status === 'fulfilled' ? { zoneId: queues[index]!.zoneId, jobs: read.value.jobs } : null)),
        Date.now(),
      );
      // A write that changes nothing put off keeps the map, so the board isn't laid out again for it.
      setLater((was) => (sameLater(was, byZone) ? was : byZone));
      if (wait !== null) timer = setTimeout(() => setTick((each) => each + 1), wait);
    });
    return () => {
      current = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [queues, tick]);
  return later;
}
