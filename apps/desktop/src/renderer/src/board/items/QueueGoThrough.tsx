// The user's queue going through its things one at a time, in its own tile: agents' requests from Needs you first, then
// its items in order. Nothing is drawn over the board, so the rest of it stays usable. While the tile is selected,
// ↵ opens, → goes on, S puts an item last and D takes it off; ← Back returns to the list.
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { jobParts } from '@agent-board/daemon/memory-lines';
import type { QueueJob } from '@agent-board/daemon/protocol';
import { Button, Kbd } from '../../ui';
import { whenText, whoText } from './memory-card';
import { goThroughKey, nextPlace, placeAfterDone, placeIn, type GoThroughAct, type GoThroughPlace } from './go-through';
import { itemKind, needsLine, type LookItem } from './to-look-at';

export interface GoThroughActions {
  onOpen(): void;
  onNext(): void;
  onSkip(): void;
  onDone(): void;
  onBack(): void;
}

interface GoThroughViewProps extends GoThroughActions {
  title: string;
  item: LookItem;
  /** Its place, from 1, and how many there are. */
  at: number;
  total: number;
  now: Date;
  rootRef?: RefObject<HTMLDivElement | null>;
  /** The tile's toolbar, as the list's card has it. */
  children?: ReactNode;
}

/** What one thing says: its kind, its headline and the rest of its text, and who put it there when; or the agent and what it asks. */
function GoThroughBody({ item, now }: { item: LookItem; now: Date }) {
  if (item.kind === 'needs') {
    const { tag, line } = needsLine(item.entry);
    return (
      <>
        <span className="queue-going-kind" data-tone="needs">
          {tag.toUpperCase()}
        </span>
        <h3 className="queue-going-title">{line}</h3>
        <p className="queue-going-facts">{item.entry.agent.name} waits for you: it is in Needs you too.</p>
      </>
    );
  }
  const { job } = item;
  const { headline, body } = jobParts(job.text);
  return (
    <>
      <span className="queue-going-kind">{itemKind(job).head}</span>
      <h3 className="queue-going-title">{headline}</h3>
      {body !== '' && <p className="queue-going-detail">{body}</p>}
      <p className="queue-going-facts">
        Put here by {whoText(job.madeBy)}, {whenText(job.createdAt, now)}
      </p>
    </>
  );
}

/**
 * The queue's tile on one thing: ← Back, its name and "n of m" at its head, the thing itself, and at its foot Skip and Done,
 * then Next and its own action (open it, or the agent that asks) as the primary button. An agent's request has no Skip or
 * Done: it goes once the agent is answered.
 */
export function GoThroughView(props: GoThroughViewProps) {
  const { title, item, at, total, now, rootRef, onOpen, onNext, onSkip, onDone, onBack, children } = props;
  const job: QueueJob | undefined = item.kind === 'job' ? item.job : undefined;
  return (
    <div ref={rootRef} tabIndex={-1} role="region" className="listcard listcard-unfolded queue-going" data-testid="queue-going" data-kind={item.kind} aria-label={`${title}, one at a time`}>
      {children}
      <div className="listcard-head">
        <button type="button" className="queue-going-back nodrag" data-testid="queue-going-back" title="Back to the list" onClick={onBack}>
          ← Back
        </button>
        <b className="listcard-title">{title}</b>
        <span className="queue-going-place" data-testid="queue-going-place" aria-live="polite">
          {at} of {total}
        </span>
      </div>
      <div className="queue-going-body nowheel">
        <GoThroughBody item={item} now={now} />
      </div>
      <div className="queue-going-foot">
        {job !== undefined && (
          <div className="queue-going-row">
            <Button size="sm" className="nodrag" title="Move it to the end of the queue, for later" onClick={onSkip}>
              Skip <Kbd>S</Kbd>
            </Button>
            <Button size="sm" className="nodrag" title="Take it off the queue" onClick={onDone}>
              Done <Kbd>D</Kbd>
            </Button>
          </div>
        )}
        <div className="queue-going-row">
          <Button size="sm" variant="ghost" className="nodrag" title="Go on to the next, leaving this one where it is" onClick={onNext}>
            Next <Kbd>→</Kbd>
          </Button>
          {(job === undefined || job.link !== null) && (
            <Button size="sm" variant="primary" className="nodrag queue-going-open" title={job?.link ?? undefined} onClick={onOpen}>
              {job === undefined ? 'Open the agent' : itemKind(job).open} <Kbd>↵</Kbd>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

interface QueueGoThroughProps {
  title: string;
  /** What it goes through, read live: never empty (the tile shows its list then). */
  items: readonly LookItem[];
  /** Whether the tile is the one selected: only then does it take its keys. */
  selected: boolean;
  /** The thing it shows, kept outside the tile (the board stops drawing a tile off screen), and how to move it. */
  place: GoThroughPlace;
  onPlace(place: GoThroughPlace): void;
  /** Which start this is: the tile takes the focus at each. */
  start: number;
  openAgent(item: Extract<LookItem, { kind: 'needs' }>): void;
  openLink(url: string): void;
  change(job: QueueJob, action: 'done' | 'skip'): void;
  onBack(): void;
  children?: ReactNode;
}

/** The tile going through its queue: the thing shown kept as the queue changes, its buttons, and its keys while selected. */
export function QueueGoThrough({ items, selected, place, onPlace: setPlace, start, openAgent, openLink, change, onBack, ...shown }: QueueGoThroughProps) {
  const index = Math.max(placeIn(items, place), 0);
  const item = items[index]!;
  const root = useRef<HTMLDivElement>(null);
  const acts: Record<GoThroughAct, () => void> = {
    open: () => {
      if (item.kind === 'needs') openAgent(item);
      else if (item.job.link !== null) openLink(item.job.link);
    },
    next: () => setPlace(nextPlace(items, index)),
    skip: () => {
      if (item.kind !== 'job') return;
      setPlace(nextPlace(items, index));
      change(item.job, 'skip');
    },
    done: () => {
      if (item.kind !== 'job') return;
      setPlace(placeAfterDone(items, index));
      change(item.job, 'done');
    },
  };
  useGoThroughKeys(selected, root, acts);
  // Started from the Captain's For you or the peek, the focus is off the tile: on it, its keys work at once.
  useEffect(() => root.current?.focus({ preventScroll: true }), [start]);
  return (
    <GoThroughView
      {...shown}
      rootRef={root}
      item={item}
      at={index + 1}
      total={items.length}
      now={new Date()}
      onOpen={acts.open}
      onNext={acts.next}
      onSkip={acts.skip}
      onDone={acts.done}
      onBack={onBack}
    />
  );
}

/** ↵, →, S and D while the tile is selected, pressed on it or the bare board (`goThroughKey`). */
function useGoThroughKeys(selected: boolean, root: RefObject<HTMLDivElement | null>, acts: Record<GoThroughAct, () => void>) {
  // The latest actions, read as a key is pressed: the listener is added once a selection.
  const latest = useRef(acts);
  latest.current = acts;
  useEffect(() => {
    if (!selected) return;
    const keys = (event: KeyboardEvent) => {
      const act = goThroughKey(event, root.current?.closest('.react-flow__node') ?? root.current);
      if (act === undefined) return;
      // Caught before the board's: React Flow would move the selected tile on →.
      event.preventDefault();
      event.stopPropagation();
      latest.current[act]();
    };
    window.addEventListener('keydown', keys, true);
    return () => window.removeEventListener('keydown', keys, true);
  }, [selected, root]);
}
