// A queue's looks, apart from the board: the open card, the folded icon and the peek. They take what to show and what
// to do as props, so the gallery draws them as the board does.
import { useEffect, useRef, useState, type ComponentProps, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUpToLine, Check, Hand, Inbox, NotebookText, Search, Ticket, Trash2, Undo2 } from 'lucide-react';
import { jobsFrom } from '@agent-board/daemon/memory-lines';
import { MAX_DRAIN_DROPS, MAX_JOB_TEXT, type Agent, type QueueAudience, type QueueJob, type QueueRowKind } from '@agent-board/daemon/protocol';
import { Button, IconButton, Segmented } from '../../ui';
import type { NeedsYouEntry } from '../../../../shared/needs-you';
import { itemKind, needsLine } from './to-look-at';
import { JOB_DRAG, setJobDropOver, startJobDrag } from './queue-board';
import { peekKeys, ScopeChip, ListCardAddBox, ListCardFace, ListCardIconView } from './ListCardParts';
import { countsText, DONE_SHOWN, doneJobs, jobCorner, jobLine, jobState, matchingJobs, nextJob, openInCardOrder, QUEUE_CARD_ROWS } from './queue-card';

/** A job or note to add: its text, and its link when the line ends ` -> link`. */
export type AddJob = (job: { kind: QueueRowKind; text: string; link: string | null }) => void;

/** The ticket for agents' work, the inbox for the user's own queue. */
function queueGlyph(audience: QueueAudience): ReactNode {
  return audience === 'user' ? <Inbox className="listcard-glyph" /> : <Ticket className="listcard-glyph" />;
}

/** "a job", "an item". */
const a = (noun: string) => `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}`;

/** What a queue's add box says, for its audience. */
const placeholderFor = (audience: QueueAudience, kind: QueueRowKind) =>
  kind === 'note' ? 'Add a note…' : audience === 'user' ? 'Add something to look at…' : 'Add a job…';

/** The box at a card's foot, and the peek's: ↵ queues a job, or a note with the switch; a paste of several lines, one each. */
function QueueAddBox({ audience, onAdd, autoFocus }: { audience: QueueAudience; onAdd: AddJob; autoFocus?: boolean }) {
  const [kind, setKind] = useState<QueueRowKind>('job');
  // What a row is called: a job for agents, an item in the user's own queue.
  const forYou = audience === 'user';
  const item = forYou ? 'item' : 'job';
  const addLines = (text: string) => jobsFrom(text).forEach((line) => onAdd({ kind, ...line }));
  return (
    <ListCardAddBox
      onAdd={addLines}
      onLines={addLines}
      placeholder={placeholderFor(audience, kind)}
      label={`${placeholderFor(audience, kind).replace('…', '')}: one a line, a link after ->`}
      maxLength={MAX_JOB_TEXT}
      testId="queue-add"
      autoFocus={autoFocus}
      lead={
        <button
          type="button"
          className="queue-kind"
          data-kind={kind}
          aria-label={kind === 'job' ? `Adds ${a(item)}: switch to a note` : `Adds a note: switch to ${a(item)}`}
          title={kind === 'job' ? `Adds ${a(item)}, ${forYou ? 'for you to look at' : 'for an agent to take'}. Click for a note, which is read, never taken` : `Adds a note, read, never taken. Click for ${a(item)}`}
          onClick={() => setKind(kind === 'job' ? 'note' : 'job')}
        >
          {kind === 'note' ? <NotebookText /> : forYou ? <Inbox /> : <Ticket />}
          {kind === 'note' ? 'note' : item}
        </button>
      }
    />
  );
}

/** A row's chip: where a job is, in a work queue; what kind of thing it is (a pull request, a doc), in the user's. */
function rowChip(job: QueueJob, next: QueueJob | undefined, audience: QueueAudience): { text: string; tone: string } {
  return audience === 'user' ? { text: itemKind(job).chip, tone: 'kind' } : jobState(job, next);
}

/** One row: its chip, its text on one line, and its corner (its taker, its link, who queued it). */
function JobRow({ job, next, audience }: { job: QueueJob; next: QueueJob | undefined; audience: QueueAudience }) {
  const state = rowChip(job, next, audience);
  return (
    <>
      <span className="queue-state" data-tone={state.tone}>
        {state.text}
      </span>
      <span className="listcard-value" title={job.text}>
        {jobLine(job)}
      </span>
      <span className="listcard-who" title={job.link ?? undefined}>
        {jobCorner(job)}
      </span>
    </>
  );
}

/** An agent's request from Needs you, on the user's queue: its tag, what it asks, and the agent; a click opens the agent. */
function NeedsRow({ entry }: { entry: NeedsYouEntry }) {
  const { tag, line } = needsLine(entry);
  return (
    <>
      <span className="queue-state" data-tone="needs">
        {tag}
      </span>
      <span className="listcard-value" title={line}>
        {line}
      </span>
      <span className="listcard-who">{entry.agent.name}</span>
    </>
  );
}

/**
 * What a card's foot says: how many rows it doesn't list; else, for a work queue with jobs waiting, that agents start
 * for them (its drain on, whatever waits; or that it left jobs dropped twice for the user), that no one is taking them,
 * or that agents take them in order.
 */
function footText({ more, audience, next, drain, idle, left }: { more: number; audience: QueueAudience; next: QueueJob | undefined; drain?: { on: boolean; most: number }; idle: boolean; left: number }): string {
  if (more > 0) return `+${more} more`;
  if (audience !== 'agents') return '';
  if (drain?.on === true) return left > 0 ? `Agents start for its jobs · ${left} dropped twice, for you` : `Agents start for its jobs · at most ${drain.most}`;
  if (next === undefined) return '';
  return idle ? 'No one is taking these' : 'Agents take them in order';
}

/** The queue a row is dragged from, on the board: its id, and its zone (who may take the job). */
export interface DragFrom {
  queueId: string;
  zoneId: string | null;
}

/** Whether a row can be handed to an agent: a waiting job of a queue for agents. */
const handable = (job: QueueJob, audience: QueueAudience) => audience === 'agents' && job.kind === 'job' && job.state === 'queued';

/** A row's drag, for a job that can be handed on: dropped on an idle agent's tile, it opens Hand on. */
function dragProps(queue: DragFrom | undefined, job: QueueJob, audience: QueueAudience) {
  if (queue === undefined || !handable(job, audience)) return {};
  return {
    draggable: true,
    'data-draggable': true,
    title: 'Drag it onto an idle agent to hand it on',
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.stopPropagation();
      event.dataTransfer.setData(JOB_DRAG, JSON.stringify({ queueId: queue.queueId, jobId: job.id }));
      event.dataTransfer.effectAllowed = 'move';
      startJobDrag({ queueId: queue.queueId, jobId: job.id, zoneId: queue.zoneId });
    },
    onDragEnd: () => {
      startJobDrag(undefined);
      setJobDropOver(undefined);
    },
  };
}

/** What an empty queue says, for its audience. */
function QueueEmpty({ audience, zoneName, onAudience }: { audience: QueueAudience; zoneName?: string; onAudience?(audience: QueueAudience): void }) {
  const who = zoneName === undefined ? "the board's agents" : `${zoneName}'s agents`;
  return (
    <div className="listcard-empty">
      <b>{audience === 'user' ? 'All caught up' : 'No jobs yet'}</b>
      {audience === 'user' ? (
        <span>Agents put finished work here for you to look at, and so can you: type below, or paste a list.</span>
      ) : (
        <>
          <span>Type a job below, or paste a list, one a line, for {who} to take in order.</span>
          <span>
            They take the next with <code className="queue-command">agent-board queue take</code>
          </span>
        </>
      )}
      {onAudience !== undefined && (
        <Segmented
          className="queue-audience nodrag"
          aria-label="Who it is for"
          options={[
            { id: 'agents', label: 'For agents' },
            { id: 'user', label: 'For you' },
          ]}
          value={audience}
          onChange={onAudience}
        />
      )}
    </div>
  );
}

interface QueueCardViewProps {
  title: string;
  scope: string;
  zoneColor?: string;
  zoneName?: string;
  audience: QueueAudience;
  /** Its jobs and notes as the daemon lists them: open ones in order, then those done. */
  jobs: readonly QueueJob[];
  /** How many are open: its saved count until its jobs are read. */
  count?: number;
  loaded?: boolean;
  onAdd: AddJob;
  onOpen(): void;
  /** An empty one asks who it is for. */
  onAudience?(audience: QueueAudience): void;
  /** The row an agent just changed, which flashes once. */
  fresh?: string;
  focusAdd?: boolean;
  /** The user's queue: the Needs-you rows it shows above its items, an agent opened by a click on one, and Start ▸. */
  needs?: readonly NeedsYouEntry[];
  onOpenAgent?(agent: Agent): void;
  onStart?(): void;
  /** Where it is on the board: its waiting jobs' rows can be dragged onto an agent. */
  dragFrom?: DragFrom;
  /** A work queue's drain: how many it starts at most while on, and the sheet that turns it on. */
  drain?: { on: boolean; most: number };
  onDrain?(): void;
  children?: ReactNode;
}

/**
 * A queue open on the board (C): a raised card in the theme's neutrals, the ticket's face (the inbox's, for the user's
 * own) and its count at its head's left, a line of counts, the taken jobs then the rest in order, and a box to add one.
 */
export function QueueCardView(props: QueueCardViewProps) {
  const { title, scope, zoneColor, zoneName, audience, jobs, count, loaded = true, onAdd, onOpen, onAudience, fresh, focusAdd, needs = [], onOpenAgent, onStart, dragFrom, drain, onDrain, children } = props;
  const open = openInCardOrder(jobs);
  const shownNeeds = needs.slice(0, QUEUE_CARD_ROWS);
  const rows = open.slice(0, QUEUE_CARD_ROWS - shownNeeds.length);
  const next = nextJob(jobs);
  const more = open.length + needs.length - rows.length - shownNeeds.length;
  const looking = audience === 'user' && open.length + needs.length > 0;
  return (
    <div className="listcard listcard-unfolded" data-testid="queue-card" data-audience={audience} onDoubleClick={(event) => (event.stopPropagation(), onOpen())}>
      {children}
      <div className="listcard-head">
        <ListCardFace glyph={queueGlyph(audience)} count={(count ?? open.length) + needs.length} />
        <b className="listcard-title">{title}</b>
        <ScopeChip scope={scope} zoneColor={zoneColor} testId="queue-scope" />
      </div>
      {loaded && jobs.length > 0 && audience === 'agents' && <span className="queue-counts">{countsText(jobs, audience)}</span>}
      {!loaded ? (
        <div className="listcard-rows" />
      ) : open.length + needs.length === 0 ? (
        <QueueEmpty audience={audience} zoneName={zoneName} onAudience={jobs.length === 0 ? onAudience : undefined} />
      ) : (
        <ul className="listcard-rows" aria-label="Jobs in order">
          {shownNeeds.map((entry) => (
            <li key={`${entry.agent.sessionId}:${entry.kind}`} className="listcard-row queue-needs-row">
              <button type="button" className="queue-needs-open nodrag" aria-label={`Open ${entry.agent.name}: ${needsLine(entry).line}`} onClick={() => onOpenAgent?.(entry.agent)}>
                <NeedsRow entry={entry} />
              </button>
            </li>
          ))}
          {rows.map((job) => (
            <li key={job.id} className="listcard-row nodrag" data-fresh={job.id === fresh || undefined} {...dragProps(dragFrom, job, audience)}>
              <JobRow job={job} next={next} audience={audience} />
            </li>
          ))}
        </ul>
      )}
      <div className="listcard-foot">
        <QueueAddBox audience={audience} onAdd={onAdd} autoFocus={focusAdd} />
        <span className="listcard-foot-line">
          <span>{footText({ more, audience, next, drain, idle: !open.some((job) => job.state === 'taken'), left: open.filter((job) => job.state === 'queued' && job.kind === 'job' && job.drops >= MAX_DRAIN_DROPS).length })}</span>
          <span className="queue-foot-actions">
            {audience === 'agents' && onDrain !== undefined && (drain?.on === true || (next !== undefined && !open.some((job) => job.state === 'taken'))) && (
              <Button size="sm" variant={drain?.on === true ? 'ghost' : 'primary'} className="nodrag" data-testid="queue-drain" onClick={onDrain}>
                {drain?.on === true ? 'Change' : 'Start agents ▸'}
              </Button>
            )}
            {looking && onStart !== undefined && (
              <Button size="sm" variant="primary" className="nodrag" data-testid="queue-start" onClick={onStart}>
                Go through ▸
              </Button>
            )}
            <button type="button" className="listcard-open nodrag" onClick={onOpen}>
              Open ↗
            </button>
          </span>
        </span>
      </div>
    </div>
  );
}

/**
 * A queue folded (E): the ticket (or the inbox) on a big round face with its count, a NEXT tab peeking out above it while
 * a job waits, its name under it and the next job's title. A click opens the peek.
 */
export function QueueIconView({ audience, next, sub, ...props }: Omit<ComponentProps<typeof ListCardIconView>, 'glyph' | 'empty' | 'testId' | 'tab'> & { audience: QueueAudience; next?: QueueJob }) {
  return (
    <ListCardIconView
      glyph={queueGlyph(audience)}
      empty={audience === 'user' ? 'All caught up' : 'Empty · click to add'}
      testId="queue-icon"
      // The tab stands in the icon's top padding, so its face sits where a folded memory's does, tab or none.
      tab={
        audience === 'user' || next === undefined ? undefined : (
          <span className="queue-next-tab" title={`next: ${jobLine(next)}`}>
            NEXT
          </span>
        )
      }
      sub={sub}
      {...props}
    />
  );
}

interface QueuePeekProps {
  title: string;
  scope: string;
  zoneColor?: string;
  audience: QueueAudience;
  jobs: readonly QueueJob[];
  onAdd: AddJob;
  onEdit(job: QueueJob, line: { text: string; link: string | null }): void;
  /** Puts an open row just before another, or last for null: false when that fails. */
  onMove(job: QueueJob, before: QueueJob | null): Promise<boolean> | void;
  onDone(job: QueueJob): void;
  /** Puts a taken job back at the front, for someone else. */
  onDrop(job: QueueJob): void;
  onRemove(job: QueueJob): void;
  /** The row being edited went (an agent removed it): the user's draft, so it isn't lost. */
  onGone?(job: QueueJob, draft: string): void;
  search?: string;
  focusAdd?: boolean;
  autoFocus?: boolean;
  /** The user's queue: its Needs-you rows, above its items, an agent opened by a click on one, and Start ▸. */
  needs?: readonly NeedsYouEntry[];
  onOpenAgent?(agent: Agent): void;
  onStart?(): void;
  /** Hands a waiting job to an agent: Hand on, for it. With it, its rows drag onto a tile too. */
  onHand?(job: QueueJob): void;
  dragFrom?: DragFrom;
}

/** A row's text as it is edited: its link after ` -> `, as it is typed. */
const editText = (job: QueueJob) => (job.link === null ? job.text : `${job.text} -> ${job.link}`);

/**
 * Every job and note of a queue, in its order, searchable, over the board, with the last few done under them. A click
 * on a row edits it (↵ saves, esc puts it back). Each open row moves to the top, is done, or goes back (taken), or is
 * removed. Keys: / searches, ↑ and ↓ move between rows, ⌥↑ and ⌥↓ move the row, E (or ↵) edits it, D finishes it,
 * ⌫ removes it.
 */
export function QueuePeek(props: QueuePeekProps) {
  const { title, scope, zoneColor, audience, jobs, onAdd, onEdit, onMove, onDone, onDrop, onRemove, onGone, search: initial = '', focusAdd = false, autoFocus = true, needs = [], onOpenAgent, onStart, onHand, dragFrom } = props;
  const [search, setSearch] = useState(initial);
  const [editing, setEditing] = useState<{ job: QueueJob; text: string }>();
  const searchField = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // The row ⌥↑ or ⌥↓ moved, and where it was: moving its row in the list loses the focus, so it is given back once the
  // rows read again have it somewhere else, unless the focus is somewhere by then. A move that fails forgets it.
  const moved = useRef<{ id: string; from: number }>(undefined);
  const open = jobs.filter((job) => job.state !== 'done');
  const done = doneJobs(jobs).slice(0, DONE_SHOWN);
  const next = nextJob(jobs);
  const shown = [...matchingJobs(open, search), ...matchingJobs(done, search)];
  const save = (job: QueueJob) => {
    const line = jobsFrom(editing?.text ?? '')[0];
    if (line !== undefined && (line.text !== job.text || line.link !== job.link)) onEdit(job, line);
    setEditing(undefined);
  };
  useEffect(() => {
    const move = moved.current;
    if (move === undefined || jobs.filter((job) => job.state !== 'done').findIndex((job) => job.id === move.id) === move.from) return;
    moved.current = undefined;
    // Only the focus the move lost is given back: one the user has put somewhere else since stays there.
    const active = document.activeElement;
    if (active === null || active === document.body) list.current?.querySelector<HTMLButtonElement>(`.listcard-peek-entry[data-row="${move.id}"]`)?.focus();
  }, [jobs]);
  useEffect(() => {
    if (editing === undefined || jobs.some((job) => job.id === editing.job.id)) return;
    onGone?.(editing.job, editing.text);
    setEditing(undefined);
  }, [jobs, editing, onGone]);
  const startEditing = (job: QueueJob) => setEditing({ job, text: editText(job) });
  /** ⌥↑ and ⌥↓: one place up or down among the open rows. */
  const moveBy = (job: QueueJob, by: -1 | 1) => {
    const at = open.findIndex((each) => each.id === job.id);
    if (at < 0 || at + by < 0 || at + by >= open.length) return;
    moved.current = { id: job.id, from: at };
    void Promise.resolve(onMove(job, by < 0 ? open[at - 1]! : (open[at + 2] ?? null))).then((done) => {
      if (done === false) moved.current = undefined;
    });
  };
  const keys = peekKeys({
    list,
    search: searchField,
    row: (id) => shown.find((each) => each.id === id),
    onEdit: startEditing,
    onRemove,
    other: (event, job) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
      event.preventDefault();
      moveBy(job, event.key === 'ArrowUp' ? -1 : 1);
      return true;
    },
  });
  const rowKeys = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    const job = shown.find((each) => each.id === target.dataset.row);
    if (job !== undefined && (event.key === 'd' || event.key === 'D') && job.kind === 'job' && job.state !== 'done') {
      event.preventDefault();
      onDone(job);
    } else keys(event);
  };
  const editKeys = (job: QueueJob) => (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // ⇧↵ saves too: a row is one line.
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      save(job);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setEditing(undefined);
    }
  };
  const actions = (job: QueueJob) => (
    <span className="listcard-row-actions">
      {job.state === 'queued' && open[0]?.id !== job.id && (
        <IconButton icon={<ArrowUpToLine />} size="sm" aria-label={`Move ${jobLine(job)} to the top`} tooltip="Move to the top" onClick={() => onMove(job, open[0] ?? null)} />
      )}
      {onHand !== undefined && handable(job, audience) && (
        <IconButton icon={<Hand />} size="sm" aria-label={`Hand ${jobLine(job)} to an agent`} tooltip="Hand it to an idle agent" onClick={() => onHand(job)} />
      )}
      {job.state === 'taken' && <IconButton icon={<Undo2 />} size="sm" aria-label={`Put ${jobLine(job)} back`} tooltip="Put it back at the front, for someone else" onClick={() => onDrop(job)} />}
      {job.kind === 'job' && job.state !== 'done' && <IconButton icon={<Check />} size="sm" aria-label={`Finish ${jobLine(job)}`} tooltip="Done" onClick={() => onDone(job)} />}
      <IconButton icon={<Trash2 />} size="sm" aria-label={`Remove ${jobLine(job)}`} tooltip="Remove; its history keeps it" onClick={() => onRemove(job)} />
    </span>
  );
  return (
    <div className="listcard-peek" data-testid="queue-peek" onKeyDown={rowKeys}>
      <div className="listcard-peek-head">
        <b className="listcard-title">{title}</b>
        <span className="queue-counts">{countsText(jobs, audience)}</span>
        <ScopeChip scope={scope} zoneColor={zoneColor} />
      </div>
      <label className="listcard-search">
        <Search className="listcard-search-mark" aria-hidden="true" />
        <input
          ref={searchField}
          className="listcard-search-input"
          value={search}
          autoFocus={autoFocus && !focusAdd}
          placeholder={jobs.length === 0 ? 'Nothing to search yet' : 'Search jobs and notes'}
          aria-label="Search jobs and notes"
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <ul ref={list} className="listcard-peek-rows nowheel" aria-label="Jobs in order">
        {needs.map((entry) => (
          <li key={`${entry.agent.sessionId}:${entry.kind}`} className="listcard-peek-row queue-needs-row">
            <button type="button" className="listcard-peek-entry" aria-label={`Open ${entry.agent.name}: ${needsLine(entry).line}`} onClick={() => onOpenAgent?.(entry.agent)}>
              <NeedsRow entry={entry} />
            </button>
          </li>
        ))}
        {shown.map((job) => (
          <li
            key={job.id}
            className="listcard-peek-row"
            data-editing={editing?.job.id === job.id || undefined}
            data-done={job.state === 'done' || undefined}
            {...(editing?.job.id === job.id ? {} : dragProps(dragFrom, job, audience))}
          >
            {editing?.job.id === job.id ? (
              <>
                <span className="queue-state" data-tone={rowChip(job, next, audience).tone}>
                  {rowChip(job, next, audience).text}
                </span>
                <textarea
                  className="listcard-edit"
                  value={editing.text}
                  maxLength={MAX_JOB_TEXT}
                  autoFocus
                  aria-label={`Edit ${jobLine(job)}`}
                  // A row is one line: a line break typed or pasted becomes a space, so nothing after it is lost.
                  onChange={(event) => setEditing({ job: editing.job, text: event.target.value.replace(/\s*\n\s*/g, ' ') })}
                  onKeyDown={editKeys(job)}
                  onBlur={() => save(job)}
                />
                <span className="listcard-who">{job.updatedAt === editing.job.updatedAt ? '↵ saves · esc' : 'changed meanwhile: ↵ replaces'}</span>
              </>
            ) : (
              <button type="button" className="listcard-peek-entry" data-row={job.id} aria-label={`Edit ${jobLine(job)}`} onClick={() => startEditing(job)}>
                <JobRow job={job} next={next} audience={audience} />
              </button>
            )}
            {actions(job)}
          </li>
        ))}
        {shown.length + needs.length === 0 && (
          <li className="listcard-peek-none">{jobs.length === 0 ? (audience === 'user' ? 'All caught up' : 'No jobs yet') : `Nothing matches “${search}”`}</li>
        )}
      </ul>
      <div className="listcard-peek-foot">
        <QueueAddBox audience={audience} onAdd={onAdd} autoFocus={autoFocus && focusAdd} />
        <span className="listcard-peek-hint">
          {audience === 'user' && onStart !== undefined && jobs.some((job) => job.state !== 'done') ? (
            <Button size="sm" variant="primary" className="queue-peek-start" data-testid="queue-peek-start" onClick={onStart}>
              Go through ▸
            </Button>
          ) : null}
          / searches · ↑↓ move · ⌥↑↓ reorder · E edits · D done · ⌫ removes
        </span>
      </div>
    </div>
  );
}
