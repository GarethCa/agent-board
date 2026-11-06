// The user's queue, one thing at a time, over the board: Start ▸ on "To look at", or its row in the Captain's For you.
// Agents' requests from Needs you come first, then the queue's items in its order. ↵ opens, → goes on, S puts an item
// last, D takes it off, esc closes.
import { useEffect, useRef, useState } from 'react';
import { Inbox } from 'lucide-react';
import type { BoardItem, QueueJob } from '@agent-board/daemon/protocol';
import { Button, Dialog, Kbd } from '../../ui';
import { needsYouEntries, type NeedsYouEntry } from '../../../../shared/needs-you';
import { useNeedsYouShows } from '../../needs-you-setting';
import { whenText, whoText } from './memory-card';
import { closeFocus, useFocusedQueue, type QueueBoard } from './queue-board';
import { jobLine, queueData } from './queue-card';
import { itemKind, lookItems, needsInScope, needsLine, type LookItem } from './to-look-at';
import { useRows, why } from './ListCardNodeParts';

interface FocusCardProps {
  queueTitle: string;
  /** What is shown now: undefined once nothing is left. */
  item: LookItem | undefined;
  /** Its place, from 1, and how many there are. */
  at: number;
  total: number;
  now: Date;
  onOpen(): void;
  onNext(): void;
  onSkip(): void;
  onDone(): void;
  onClose(): void;
  /** Drawn in place, for the gallery. */
  inline?: boolean;
}

/** What one thing to look at says: its kind, its words, and who put it there when; or the agent and what it asks. */
function FocusBody({ item, at, total, now }: Pick<FocusCardProps, 'at' | 'total' | 'now'> & { item: LookItem }) {
  const place = `${at} of ${total}`;
  if (item.kind === 'needs') {
    const { tag, line } = needsLine(item.entry);
    return (
      <div className="queue-focus" data-testid="queue-focus-card" data-kind="needs">
        <div className="queue-focus-top">
          <span className="queue-focus-kind" data-tone="needs">
            {tag.toUpperCase()}
          </span>
          <span>{place}</span>
        </div>
        <h3 className="queue-focus-title">{line}</h3>
        <p className="queue-focus-facts">{item.entry.agent.name} waits for you: it is in Needs you too.</p>
      </div>
    );
  }
  const { job } = item;
  const kind = itemKind(job);
  return (
    <div className="queue-focus" data-testid="queue-focus-card" data-kind="job">
      <div className="queue-focus-top">
        <span className="queue-focus-kind">{kind.head}</span>
        <span>{place}</span>
      </div>
      <h3 className="queue-focus-title">{jobLine(job)}</h3>
      <p className="queue-focus-facts">
        Put here by {whoText(job.madeBy)}, {whenText(job.createdAt, now)}
      </p>
    </div>
  );
}

/**
 * The focus view's card: one thing at a time, with Next, Skip and Done, and its own action (open it, or open the agent
 * that asks) as the primary button. Nothing left, it says so.
 */
export function FocusCardView(props: FocusCardProps) {
  const { item, onOpen, onNext, onSkip, onDone, onClose, inline } = props;
  const job = item?.kind === 'job' ? item.job : undefined;
  const footer =
    item === undefined ? (
      <Button variant="primary" onClick={onClose}>
        Close
      </Button>
    ) : (
      <>
        <Button variant="ghost" title="Go on to the next, leaving this one where it is" onClick={onNext}>
          Next <Kbd>→</Kbd>
        </Button>
        {job !== undefined && (
          <>
            <Button title="Move it to the end of the queue, for later" onClick={onSkip}>
              Skip <Kbd>S</Kbd>
            </Button>
            <Button title="Take it off the queue" onClick={onDone}>
              Done <Kbd>D</Kbd>
            </Button>
          </>
        )}
        {(job === undefined || job.link !== null) && (
          <Button variant="primary" title={job?.link ?? undefined} onClick={onOpen}>
            {job === undefined ? 'Open the agent' : itemKind(job).open} <Kbd>↵</Kbd>
          </Button>
        )}
      </>
    );
  return (
    <Dialog
      title={
        <span className="queue-focus-head">
          <Inbox aria-hidden /> {props.queueTitle}
        </span>
      }
      aria-label={`${props.queueTitle}, one at a time`}
      onClose={onClose}
      footer={footer}
      inline={inline}
      data-testid="queue-focus"
    >
      {item === undefined ? (
        <div className="queue-focus" data-testid="queue-focus-card" data-kind="done">
          <h3 className="queue-focus-title">All caught up</h3>
          <p className="queue-focus-facts">Nothing waits for you here. Agents put finished work here as it is ready.</p>
        </div>
      ) : (
        <FocusBody {...props} item={item} />
      )}
    </Dialog>
  );
}

const readJobs = (id: string) => window.agentBoard.items.readQueue(id).then((view) => view.jobs);

/** The focus view on the open queue, read again as it changes; an item done or skipped shows the one after it. */
function QueueFocusOn({ queue, board, onError }: { queue: BoardItem; board: QueueBoard; onError(message: string): void }) {
  const data = queueData(queue.data);
  const jobs = useRows(queue.id, queue.updatedAt, readJobs, (error) => onError(`Could not read “${data.title}”: ${why(error)}`));
  const shows = useNeedsYouShows();
  const needs: NeedsYouEntry[] = needsInScope(needsYouEntries(board.agents, shows), queue.zoneId);
  const items = lookItems(jobs ?? [], needs);
  const [at, setAt] = useState(0);
  const index = items.length === 0 ? 0 : Math.min(at, items.length - 1);
  const item = items[index];
  const change = (job: QueueJob, action: 'done' | 'skip') =>
    void window.agentBoard.items
      .changeQueue(queue.id, action === 'done' ? { action: 'done', job: job.id } : { action: 'move', job: job.id, before: null })
      .catch((error: unknown) => onError(`Could not change “${data.title}”: ${why(error)}`));
  const act = {
    onOpen: () => {
      if (item?.kind === 'needs') {
        closeFocus();
        board.openAgent(item.entry.agent);
      } else if (item?.job.link != null) board.openLink(item.job.link);
    },
    onNext: () => setAt(items.length === 0 ? 0 : (index + 1) % items.length),
    onSkip: () => item?.kind === 'job' && change(item.job, 'skip'),
    onDone: () => item?.kind === 'job' && change(item.job, 'done'),
  };
  useFocusKeys(act);
  if (jobs === undefined) return null;
  return <FocusCardView queueTitle={data.title} item={item} at={index + 1} total={items.length} now={new Date()} onClose={closeFocus} {...act} />;
}

/** ↵, →, S and D while the focus view is open, unless typing in a field. */
function useFocusKeys(actions: { onOpen(): void; onNext(): void; onSkip(): void; onDone(): void }) {
  // The latest actions, read as a key is pressed: the listener is added once.
  const latest = useRef(actions);
  latest.current = actions;
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const act = latest.current;
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey || target?.closest('input, textarea, [contenteditable="true"]') != null) return;
      // A focused button presses itself on ↵: only the card's own ↵ opens.
      if (event.key === 'Enter' && target instanceof HTMLButtonElement) return;
      const run = { Enter: act.onOpen, ArrowRight: act.onNext, s: act.onSkip, S: act.onSkip, d: act.onDone, D: act.onDone }[event.key];
      if (run === undefined) return;
      event.preventDefault();
      run();
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);
}

/** The focus view, when a user's queue has asked for it: mounted once, beside the board. */
export function QueueFocusHost({ queues, board, onError }: { queues: readonly BoardItem[]; board: QueueBoard; onError(message: string): void }) {
  const focused = useFocusedQueue();
  const queue = queues.find((each) => each.id === focused);
  useEffect(() => {
    if (focused !== undefined && queue === undefined) closeFocus();
  }, [focused, queue]);
  return queue === undefined ? null : <QueueFocusOn key={queue.id} queue={queue} board={board} onError={onError} />;
}
