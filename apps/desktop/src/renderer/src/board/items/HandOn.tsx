// Handing a job on: the user picks an idle agent in the queue's scope (or dropped the job's row on its tile) and says
// what to send it. Only that text is typed at the agent's prompt, as the user's message, and the job is taken for it.
import { useEffect, useState } from 'react';
import { jobBrief } from '@agent-board/daemon/memory-lines';
import { MAX_JOB_TEXT, takesHandOn, type Agent, type BoardItem, type QueueJob } from '@agent-board/daemon/protocol';
import { Button, Dialog } from '../../ui';
import { STATE_LABELS } from '../../states';
import { inHandScope, openHandOn, useHandOn, type QueueBoard } from './queue-board';
import { jobLine, queueData } from './queue-card';
import { why } from './ListCardNodeParts';

interface HandOnViewProps {
  job: Pick<QueueJob, 'text'>;
  /** The agents in scope: an idle one can be picked, a busy one says why not. */
  agents: readonly Agent[];
  chosen: string | undefined;
  text: string;
  onChoose(sessionId: string): void;
  onText(text: string): void;
  onSend(): void;
  onCancel(): void;
  sending?: boolean;
  inline?: boolean;
}

/** The Hand on dialog: who to hand it to, and the message as it will be typed, the user's to change. */
export function HandOnView({ job, agents, chosen, text, onChoose, onText, onSend, onCancel, sending = false, inline }: HandOnViewProps) {
  const ready = chosen !== undefined && text.trim() !== '' && !sending;
  return (
    <Dialog
      title={`Hand “${jobLine(job)}” to an agent`}
      aria-label="Hand the job to an agent"
      onClose={onCancel}
      inline={inline}
      data-testid="hand-on"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSend();
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!ready}>
            Send it
          </Button>
        </>
      }
    >
      <div className="hand-on">
        <ul className="hand-on-agents" role="radiogroup" aria-label="The agent to hand it to">
          {agents.length === 0 && <li className="hand-on-none">No agent here to hand it to: start one in the zone first.</li>}
          {agents.map((agent) => {
            const free = takesHandOn(agent);
            return (
              <li key={agent.sessionId}>
                <label className="hand-on-agent" data-busy={!free || undefined}>
                  <input type="radio" name="hand-on-agent" value={agent.sessionId} checked={chosen === agent.sessionId} disabled={!free} onChange={() => onChoose(agent.sessionId)} />
                  <b>{agent.name}</b>
                  <small>{free ? 'idle' : STATE_LABELS[agent.state].toLowerCase()}</small>
                </label>
              </li>
            );
          })}
        </ul>
        <p className="hand-on-rule">Only an idle agent takes a job.</p>
        <label className="hand-on-message">
          <span>Message, sent as you</span>
          <textarea value={text} maxLength={MAX_JOB_TEXT} rows={6} onChange={(event) => onText(event.target.value)} />
        </label>
      </div>
    </Dialog>
  );
}

/** Hand on, when a job's row asked for it: the job read from its queue, the agents in its scope, then the send. */
function HandOnFor({ queue, jobId, sessionId, board, onError }: { queue: BoardItem; jobId: string; sessionId?: string; board: QueueBoard; onError(message: string): void }) {
  const data = queueData(queue.data);
  const [job, setJob] = useState<QueueJob>();
  const [chosen, setChosen] = useState(sessionId);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const close = () => openHandOn(undefined);
  useEffect(() => {
    let current = true;
    window.agentBoard.items.readQueue(queue.id).then(
      (view) => {
        if (!current) return;
        const found = view.jobs.find((each) => each.id === jobId && each.state === 'queued' && each.kind === 'job');
        if (found === undefined) {
          onError(`That job in “${data.title}” isn't waiting any more`);
          close();
          return;
        }
        setJob(found);
        setText(jobBrief({ title: data.title, ref: `item:${queue.id}` }, found.id, found.text, found.link, 'handed to you'));
      },
      (error: unknown) => current && (onError(`Could not read “${data.title}”: ${why(error)}`), close()),
    );
    return () => {
      current = false;
    };
  }, [queue.id, jobId]); // Read once, as it opens.
  const agents = board.agents.filter((agent) => inHandScope(agent, queue.zoneId));
  // A tile it was dropped on that can't take it isn't chosen.
  const picked = chosen !== undefined && agents.some((agent) => agent.sessionId === chosen && takesHandOn(agent)) ? chosen : undefined;
  if (job === undefined) return null;
  const send = () => {
    setSending(true);
    window.agentBoard.items.handJob(queue.id, job.id, picked!, text).then(close, (error: unknown) => {
      setSending(false);
      onError(`Could not hand it on: ${why(error)}`);
    });
  };
  return <HandOnView job={job} agents={agents} chosen={picked} text={text} onChoose={setChosen} onText={setText} onSend={send} onCancel={close} sending={sending} />;
}

/** Hand on, mounted once beside the board. */
export function HandOnHost({ queues, board, onError }: { queues: readonly BoardItem[]; board: QueueBoard; onError(message: string): void }) {
  const target = useHandOn();
  const queue = target === undefined ? undefined : queues.find((each) => each.id === target.queueId);
  if (target === undefined || queue === undefined) return null;
  return <HandOnFor key={`${target.queueId}:${target.jobId}`} queue={queue} jobId={target.jobId} sessionId={target.sessionId} board={board} onError={onError} />;
}
