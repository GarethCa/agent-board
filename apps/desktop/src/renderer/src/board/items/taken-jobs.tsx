// The jobs agents hold from the board's queues, for their tiles to show as tickets: read again whenever a queue
// changes (a take, a drop, a job done) or goes.
import { createContext, useContext, useEffect, useState } from 'react';
import { Ticket } from 'lucide-react';
import type { TakenJob } from '@agent-board/daemon/protocol';
import { Chip } from '../../ui';

/** The jobs each agent holds, by its session id. */
export type TakenJobs = ReadonlyMap<string, readonly TakenJob[]>;

const NONE: TakenJobs = new Map();
export const TakenJobsContext = createContext<TakenJobs>(NONE);

/** The jobs `sessionId` holds, for its tile. */
export const useHeldJobs = (sessionId: string): readonly TakenJob[] => useContext(TakenJobsContext).get(sessionId) ?? [];

/** Groups taken jobs by their taker. */
function bySession(taken: readonly TakenJob[]): TakenJobs {
  const held = new Map<string, TakenJob[]>();
  for (const each of taken) held.set(each.sessionId, [...(held.get(each.sessionId) ?? []), each]);
  return held;
}

/** The jobs agents hold, read once and again after each change to a queue. A read that fails keeps the last. */
export function useTakenJobs(): TakenJobs {
  const [held, setHeld] = useState<TakenJobs>(NONE);
  useEffect(() => {
    let current = true;
    const queues = new Set<string>();
    const read = () =>
      void window.agentBoard.items.takenJobs().then(
        (taken) => {
          for (const each of taken) queues.add(each.queueId);
          if (current) setHeld(bySession(taken));
        },
        () => {},
      );
    read();
    const stop = window.agentBoard.items.onChanged((change) => {
      if (change.type === 'item.updated' ? change.item.kind === 'queue' && queues.add(change.item.id) : queues.delete(change.id)) read();
    });
    return () => {
      current = false;
      stop();
    };
  }, []);
  return held;
}

/** A job an agent holds, on its tile: the ticket and the job, its queue in the tooltip; a click shows the queue. */
export function JobTicket({ taken, onOpen }: { taken: TakenJob; onOpen(queueId: string): void }) {
  return (
    <Chip
      className="job-ticket nodrag"
      data-testid="tile-ticket"
      title={`Its job from “${taken.queueTitle}”: ${taken.job.text}\nShow the queue`}
      onClick={() => onOpen(taken.queueId)}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Ticket aria-hidden />
      <span className="job-ticket-text">{taken.job.text.split('\n', 1)[0]}</span>
    </Chip>
  );
}
