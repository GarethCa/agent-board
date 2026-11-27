// A queue full screen: its jobs in groups on the left, searchable and filtered by chips, beside the one picked, with
// what it is, its text to edit, its link, its result, who did what to it and when, its buttons, and Next ▸ to the next
// one. It takes what to show and what to do as props, so the gallery draws it as the board does.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUpFromLine, ArrowUpToLine, Bot, Check, ClockArrowDown, ExternalLink, Hand, Play, Plus, Search, Trash2, Undo2 } from 'lucide-react';
import { jobsFrom } from '@agent-board/daemon/memory-lines';
import { isQueueWork, MAX_JOB_TEXT, queueKindOn, type Agent, type HistoryVersion, type QueueAudience, type QueueJob, type StepsWho } from '@agent-board/daemon/protocol';
import { Button, IconButton, Kbd } from '../../ui';
import { isTyping } from '../../keys/typing';
import type { NeedsYouEntry } from '../../../../shared/needs-you';
import { FullScreen, type FullScreenKey } from './FullScreen';
import { editText, QueueAddBox, queueGlyph, rowChip, type JobActions } from './QueueCard';
import { handable, isLaterRow, jobLine, nextJob, puttable } from './queue-card';
import { itemKind, lookCount, needsLine } from './to-look-at';
import { whenText, whoText } from './memory-card';
import { fullAction, fullGroups, fullKey, headCount, lookPlace, nextRow, NO_FILTER, rowBy, rowsOf, shownGroups, standing, whoWhen, type FullAction, type FullFilter, type FullRow } from './queue-full';

export interface QueueFullProps extends JobActions {
  title: string;
  scope: string;
  audience: QueueAudience;
  /** Its jobs and notes as the daemon lists them: open ones in order, then those done. */
  jobs: readonly QueueJob[];
  /** The user's queue: what agents ask, above its items. */
  needs?: readonly NeedsYouEntry[];
  now: Date;
  /** A job's versions, newest first, for who did what to it and when. */
  history?(job: QueueJob): Promise<HistoryVersion<QueueJob>[]>;
  /** The agent a taker or a finisher is, when it is still on the board. */
  agentOf?(who: StepsWho): Agent | undefined;
  onOpenAgent?(agent: Agent): void;
  openLink(url: string): void;
  /** The user's queue: Go through, in the tile. */
  onStart?(): void;
  /** A work queue's drain, and the sheet that turns it on. */
  drain?: { on: boolean; most: number };
  onDrain?(): void;
  onClose(): void;
  /** Drawn open in place, not over the page: for the gallery. */
  inline?: boolean;
  /** Where it starts, for the gallery: the row picked, and the list's filter. */
  initial?: { picked?: string; filter?: Partial<FullFilter> };
  /** The queue on the board, for the focus as it closes. */
  object?(): HTMLElement | null | undefined;
}

/** Esc in an edit or the add box cancels it, and in a search with text clears it: not the whole view. */
const escapeStays = (focused: Element | null) =>
  focused instanceof HTMLElement && (focused.closest('.queue-full-edit, .queue-full-add') !== null || (focused.closest('.memory-full-search') !== null && (focused as HTMLInputElement).value !== ''));

/** A queue full screen, over the board: Esc, the close button or a click outside closes it. */
export function QueueFull(props: QueueFullProps) {
  const { title, scope, audience, jobs, needs = [], now, history, agentOf, onOpenAgent, openLink, onStart, drain, onDrain, onClose, inline = false, initial, object, ...acts } = props;
  const { onAdd, onEdit, onMove, onDone, onDrop, onRemove, onGone, onHand, onLater } = acts;
  const [filter, setFilter] = useState<FullFilter>({ ...NO_FILTER, ...initial?.filter });
  const [picked, setPicked] = useState(initial?.picked);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ job: QueueJob; text: string }>();
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const forYou = audience === 'user';

  const groups = fullGroups(jobs, needs, audience, now);
  const shown = shownGroups(groups, filter);
  const rows = rowsOf(shown);
  // When the picked row goes (done by an agent, removed, filtered out), the row now in its place is picked, not the first.
  const at = useRef(0);
  const found = rows.findIndex((row) => row.key === picked);
  const current = found >= 0 ? rows[found] : rows[Math.min(at.current, rows.length - 1)];
  useEffect(() => {
    const index = rows.findIndex((row) => row.key === current?.key);
    if (index >= 0) at.current = index;
  });
  // A key or button that moves the picked row loses the focus with it (React moves or remounts its row), so the row
  // picked is given the focus back once the list has redrawn, unless the user has gone to another field.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    const active = document.activeElement;
    const lost = !(active instanceof HTMLElement) || active === document.body || !active.isConnected || active.getAttribute('role') === 'dialog';
    if (!lost) return;
    refocus.current = false;
    list.current?.querySelector<HTMLElement>('.queue-full-item[aria-current="true"]')?.focus();
  });
  // A chip whose group has emptied is let go, so it doesn't come back on by itself when the group does.
  const groupIds = groups.map((group) => group.id).join(' ');
  useEffect(() => {
    if (filter.group !== null && !groupIds.split(' ').includes(filter.group)) setFilter((was) => ({ ...was, group: null }));
  }, [groupIds, filter.group]);
  const next = nextRow(rows, current?.key);
  const nextUp = nextJob(jobs);
  // Move to the top puts a waiting row first in its own group, as the list shows it.
  const top = groups.find((group) => group.rows.some((each) => each.key === current?.key))?.rows.find((each) => each.kind === 'job');
  const set = (change: Partial<FullFilter>) => setFilter((was) => ({ ...was, ...change }));
  const pick = (row: FullRow | undefined, focus = false) => {
    if (row === undefined) return;
    setAdding(false);
    setPicked(row.key);
    if (focus) list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(row.key)}"]`)?.focus();
  };
  // The row being edited went (an agent removed it): its draft is offered back.
  useEffect(() => {
    if (editing === undefined || jobs.some((job) => job.id === editing.job.id)) return;
    onGone?.(editing.job, editing.text);
    setEditing(undefined);
  }, [jobs, editing, onGone]);

  const startEditing = (job: QueueJob) => setEditing({ job, text: editText(job) });
  const save = (job: QueueJob) => {
    const line = jobsFrom(editing?.text ?? '')[0];
    if (line !== undefined && (line.text !== job.text || line.link !== job.link)) onEdit(job, line);
    setEditing(undefined);
  };
  const run = (action: FullAction | undefined) => {
    if (action === undefined) return;
    const { job } = action;
    if (action.op === 'edit') return startEditing(job);
    refocus.current = true;
    if (action.op === 'move') void onMove(job, action.before);
    else if (action.op === 'done') {
      // Done goes through: the next row still to do is picked, as Next ▸ does.
      const after = nextRow(rows, job.id);
      if (after !== undefined) setPicked(after.key);
      onDone(job);
    } else if (action.op === 'later' || action.op === 'back') onLater?.(job, action.op === 'later');
    else onHand?.(job);
  };
  const can = { hand: onHand !== undefined, later: onLater !== undefined };

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isTyping(event)) return;
    const key = fullKey(event);
    if (key === undefined) return;
    event.preventDefault();
    if (key === 'search') search.current?.focus();
    else if (key === 'add') setAdding(true);
    else if (key === 'up' || key === 'down') pick(rowBy(rows, current?.key, key === 'up' ? -1 : 1), true);
    else run(fullAction(key, current, groups, audience, can));
  };

  const row = (each: FullRow) => (
    <li key={each.key}>
      <button
        type="button"
        className="memory-full-item queue-full-item"
        data-row={each.key}
        data-done={(each.kind === 'job' && each.job.state === 'done') || undefined}
        aria-current={each.key === current?.key || undefined}
        tabIndex={each.key === current?.key ? 0 : -1}
        onClick={() => pick(each)}
      >
        {each.kind === 'needs' ? (
          <>
            <span className="memory-full-item-name">
              <span className="queue-state" data-tone="needs">
                {needsLine(each.entry).tag}
              </span>
              <b>{each.entry.agent.name}</b>
            </span>
            <span className="memory-full-item-sub">{needsLine(each.entry).line}</span>
          </>
        ) : (
          <>
            <span className="memory-full-item-name">
              {each.place === undefined ? (
                <StateChip {...rowChip(each.job, nextUp, audience)} />
              ) : (
                <span className="queue-full-place">{each.place}</span>
              )}
              <b>{jobLine(each.job)}</b>
            </span>
            <span className="memory-full-item-sub">{rowSub(each.job, now)}</span>
          </>
        )}
      </button>
    </li>
  );

  const footKeys: FullScreenKey[] = [
    { keys: '↑↓', label: 'move' },
    { keys: '⌥↑⌥↓', label: 'reorder' },
    { keys: 'D', label: 'done' },
    ...(forYou || onHand === undefined ? [] : [{ keys: 'H', label: 'hand to an agent' }]),
    { keys: 'L', label: 'later' },
    { keys: 'E', label: 'edit' },
    { keys: 'N', label: 'add' },
    { keys: '/', label: 'search' },
    { keys: 'esc', label: 'back to the board' },
  ];
  const openCount = jobs.filter((job) => job.state !== 'done').length;

  return (
    <FullScreen
      className="queue-full"
      testId="queue-full"
      title={title}
      face={queueGlyph(audience)}
      sub={`${scope} · ${forYou ? 'no agent takes these' : 'its agents take them in order'}`}
      count={forYou ? `${lookCount(openCount, needs)} to look at` : headCount(jobs, now)}
      headEnd={
        forYou ? (
          onStart !== undefined &&
          lookCount(openCount, needs) > 0 && (
            <Button size="sm" variant="ghost" icon={<Play />} onClick={onStart}>
              Go through
            </Button>
          )
        ) : (
          onDrain !== undefined && (
            <Button size="sm" variant="ghost" icon={<Bot />} onClick={onDrain}>
              {drain?.on === true ? `Agents start for jobs, at most ${drain.most}` : 'Start agents…'}
            </Button>
          )
        )
      }
      bar={
        <>
          <label className="listcard-search memory-full-search">
            <Search className="listcard-search-mark" aria-hidden="true" />
            <input
              ref={search}
              className="listcard-search-input"
              value={filter.search}
              placeholder={forYou ? 'Search what is for you' : 'Search jobs and notes'}
              aria-label="Search jobs and notes"
              onChange={(event) => set({ search: event.target.value })}
              onKeyDown={(event) => event.key === 'Escape' && filter.search !== '' && (event.preventDefault(), event.stopPropagation(), set({ search: '' }))}
            />
            <Kbd>/</Kbd>
          </label>
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              className="memory-full-chip"
              data-tone={group.id === 'needs' ? 'warn' : undefined}
              aria-pressed={filter.group === group.id}
              onClick={() => set({ group: filter.group === group.id ? null : group.id })}
            >
              {group.id === 'needs' ? 'Agents ask' : group.label.replace(', in order', '')} {group.rows.length}
            </button>
          ))}
          <span className="full-screen-bar-end">
            <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              {forYou ? 'Add' : 'Add a job'}
            </Button>
          </span>
        </>
      }
      side={
        <ul ref={list} className="memory-full-list" aria-label="Jobs in groups">
          {shown.map((group) => (
            <li key={group.id} className="queue-full-group">
              <span className="memory-full-group" aria-hidden="true">
                {group.label} · {group.rows.length}
              </span>
              <ul className="queue-full-rows">{group.rows.map(row)}</ul>
            </li>
          ))}
          {rows.length === 0 && <li className="memory-full-none">{filter.search.trim() !== '' ? `Nothing matches “${filter.search}”` : forYou ? 'All caught up' : 'No jobs yet'}</li>}
        </ul>
      }
      detail={
        adding ? (
          <section
            className="memory-full-entry queue-full-add"
            aria-label={forYou ? 'Add something to look at' : 'Add a job'}
            onKeyDown={(event) => event.key === 'Escape' && (event.preventDefault(), setAdding(false))}
          >
            <h3 className="queue-full-heading">{forYou ? 'Add something to look at' : 'Add a job'}</h3>
            <QueueAddBox audience={audience} onAdd={(job) => (onAdd(job), setAdding(false))} autoFocus />
            <span className="queue-full-hint">↵ adds · one a line, a link after -&gt; · esc cancels</span>
          </section>
        ) : current === undefined ? (
          <div className="memory-full-empty">
            <b>{forYou ? 'All caught up' : 'No jobs yet'}</b>
            <span>{forYou ? 'Agents put finished work here for you to look at, and so can you.' : 'Add a job for its agents to take in order.'}</span>
          </div>
        ) : current.kind === 'needs' ? (
          <article className="memory-full-entry" aria-label={current.entry.agent.name}>
            <div className="memory-full-entry-head">
              <span className="queue-state" data-tone="needs">
                {needsLine(current.entry).tag}
              </span>
              <span className="queue-full-standing">{whenText(current.entry.since, now)}</span>
            </div>
            <h3 className="queue-full-heading">{current.entry.agent.name}</h3>
            <p className="queue-full-text">{needsLine(current.entry).line}</p>
            <div className="queue-full-acts">
              <Button size="sm" variant="primary" onClick={() => onOpenAgent?.(current.entry.agent)}>
                Open the agent
              </Button>
            </div>
            <QueueNext next={next} onNext={() => pick(next, true)} />
          </article>
        ) : (
          <JobDetail
            key={current.job.id}
            job={current.job}
            place={current.place}
            audience={audience}
            of={forYou ? lookPlace(groups, current.key, lookCount(openCount, needs)) : undefined}
            first={top?.kind === 'job' ? top.job : undefined}
            now={now}
            editing={editing?.job.id === current.job.id ? editing.text : undefined}
            onEditing={(text) => (text === undefined ? setEditing(undefined) : setEditing({ job: current.job, text }))}
            onSave={() => save(current.job)}
            history={history}
            agentOf={agentOf}
            onOpenAgent={onOpenAgent}
            openLink={openLink}
            acts={{
              onMove: (job, before) => run({ op: 'move', job, before }),
              onDone: (job) => run({ op: 'done', job }),
              onDrop: (job) => ((refocus.current = true), onDrop(job)),
              onRemove,
              onHand,
            }}
            onLater={onLater === undefined ? undefined : () => run(fullAction('later', current, groups, audience, can))}
          >
            <QueueNext next={next} onNext={() => pick(next, true)} />
          </JobDetail>
        )
      }
      keys={footKeys}
      inline={inline}
      onClose={onClose}
      // The row shown, in the list, so ↑↓ move at once; with none, the search.
      initialFocus={(root) => root.querySelector<HTMLElement>('.queue-full-item[aria-current="true"]') ?? root.querySelector<HTMLElement>('.memory-full-search input')}
      escapeStays={escapeStays}
      object={object}
      onKeyDown={keys}
    />
  );
}

/** A row's line under its text: its taker, who finished it and what it came to, else who queued it and when. */
function rowSub(job: QueueJob, now: Date): string {
  if (job.state === 'taken' && job.takenBy !== null) return `${whoText(job.takenBy)}${job.takenAt === null ? '' : ` · ${whenText(job.takenAt, now)}`}`;
  if (job.state === 'done') return job.result === null ? `done ${job.doneAt === null ? '' : whenText(job.doneAt, now)}`.trim() : `✓ ${job.result}`;
  if (isLaterRow(job)) return 'waits till you move it up';
  return `${isQueueWork(job.kind) ? `${job.kind === 'task' ? 'a task' : `${job.kind}`}` : 'info · read, never taken'} · from ${whoText(job.madeBy)} · ${whenText(job.createdAt, now)}`;
}

/** A row's state, as its chip says it. */
const StateChip = ({ tone, text }: ReturnType<typeof rowChip>) => (
  <span className="queue-state" data-tone={tone}>
    {text}
  </span>
);

/** Next ▸ under the one picked: the next still to do, so the full screen goes through them. */
function QueueNext({ next, onNext }: { next: FullRow | undefined; onNext(): void }) {
  if (next === undefined) return null;
  return (
    <div className="queue-full-next">
      <span className="queue-full-standing">Next: {next.kind === 'needs' ? `${next.entry.agent.name} ${needsLine(next.entry).tag}` : jobLine(next.job)}</span>
      <Button size="sm" variant="ghost" onClick={onNext}>
        Next ▸
      </Button>
    </div>
  );
}

interface JobDetailProps {
  job: QueueJob;
  place?: number;
  audience: QueueAudience;
  /** The user's queue: how far through what is to look at it is ("2 of 7 to look at"). */
  of?: string;
  /** The first row of its group, which Move to the top puts it before. */
  first: QueueJob | undefined;
  now: Date;
  /** Its text as it is edited, or undefined when it isn't. */
  editing: string | undefined;
  onEditing(text: string | undefined): void;
  onSave(): void;
  history?(job: QueueJob): Promise<HistoryVersion<QueueJob>[]>;
  agentOf?(who: StepsWho): Agent | undefined;
  onOpenAgent?(agent: Agent): void;
  openLink(url: string): void;
  acts: Pick<JobActions, 'onMove' | 'onDone' | 'onDrop' | 'onRemove' | 'onHand'>;
  onLater?(): void;
  children?: ReactNode;
}

/** The job picked: what it is and where it stands, its text (a click edits it), its link, its result, its buttons, and who did what to it. */
function JobDetail({ job, place, audience, of, first, now, editing, onEditing, onSave, history, agentOf, onOpenAgent, openLink, acts, onLater, children }: JobDetailProps) {
  const [versions, setVersions] = useState<HistoryVersion<QueueJob>[]>();
  // Read again as the job changes, so what was just done shows.
  useEffect(() => {
    let live = true;
    void history?.(job).then(
      (read) => live && setVersions(read),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [history, job.id, job.updatedAt, job.state]);
  const chip = audience === 'user' ? { ...rowChip(job, undefined, audience), text: queueKindOn('user', job.kind) } : rowChip(job, undefined, audience);
  const work = isQueueWork(job.kind);
  const who = job.state === 'taken' ? job.takenBy : job.state === 'done' ? job.doneBy : null;
  const agent = who === null ? undefined : agentOf?.(who);
  const kind = job.link === null ? undefined : itemKind(job);
  const fieldKeys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSave();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onEditing(undefined);
    }
  };
  return (
    <article className="memory-full-entry" aria-label={jobLine(job)}>
      <div className="memory-full-entry-head">
        <span className="queue-state" data-tone={chip.tone}>
          {chip.text}
        </span>
        <span className="queue-full-standing">{of === undefined ? standing(job, place, audience, now) : `${of} · ${standing(job, place, audience, now)}`}</span>
        <span className="memory-full-entry-tools">
          <IconButton icon={<Trash2 />} size="sm" aria-label="Remove" tooltip="Remove; its history keeps it" onClick={() => acts.onRemove(job)} />
        </span>
      </div>
      {editing === undefined ? (
        <button type="button" className="queue-full-title" aria-label={`Edit ${jobLine(job)}`} title="Click to edit · E" onClick={() => onEditing(editText(job))}>
          {jobLine(job)}
        </button>
      ) : (
        <textarea
          className="memory-full-name queue-full-edit"
          value={editing}
          maxLength={MAX_JOB_TEXT}
          autoFocus
          aria-label={`Edit ${jobLine(job)}`}
          // A row is one line: a line break typed or pasted becomes a space, so nothing after it is lost.
          onChange={(event) => onEditing(event.target.value.replace(/\s*\n\s*/g, ' '))}
          onKeyDown={fieldKeys}
          onBlur={onSave}
        />
      )}
      {job.link !== null && (
        <button type="button" className="queue-full-link" title={job.link} onClick={() => openLink(job.link!)}>
          <ExternalLink aria-hidden="true" />
          {job.link}
        </button>
      )}
      {job.result !== null && (
        <section className="queue-full-result" aria-label="Result">
          <b>Result</b> {job.result}
        </section>
      )}
      <div className="queue-full-acts">
        {kind !== undefined && job.link !== null && (
          <Button size="sm" variant="primary" icon={<ExternalLink />} onClick={() => openLink(job.link!)}>
            {kind.open === 'Done' ? 'Open it' : kind.open}
          </Button>
        )}
        {work && job.state !== 'done' && (
          <Button size="sm" variant={kind === undefined ? 'primary' : undefined} icon={<Check />} onClick={() => acts.onDone(job)}>
            Done
          </Button>
        )}
        {onLater !== undefined && puttable(job) && (
          <Button size="sm" icon={<ClockArrowDown />} onClick={onLater}>
            Later
          </Button>
        )}
        {onLater !== undefined && job.state === 'queued' && isLaterRow(job) && (
          <Button size="sm" icon={<ArrowUpFromLine />} title="Back in line, in its place · L" onClick={onLater}>
            Move up
          </Button>
        )}
        {job.state === 'queued' && !isLaterRow(job) && first !== undefined && first.id !== job.id && (
          <Button size="sm" icon={<ArrowUpToLine />} onClick={() => void acts.onMove(job, first)}>
            Move to the top
          </Button>
        )}
        {acts.onHand !== undefined && handable(job, audience) && (
          <Button size="sm" icon={<Hand />} onClick={() => acts.onHand?.(job)}>
            Hand to an agent
          </Button>
        )}
        {job.state === 'taken' && (
          <Button size="sm" icon={<Undo2 />} onClick={() => acts.onDrop(job)}>
            Put back in line
          </Button>
        )}
        {agent !== undefined && onOpenAgent !== undefined && (
          <Button size="sm" variant="ghost" icon={<Bot />} onClick={() => onOpenAgent(agent)}>
            Open the agent
          </Button>
        )}
      </div>
      <section className="memory-full-who" aria-label="Who and when">
        <h3>Who and when</h3>
        <ol className="memory-full-timeline">
          {whoWhen(job, versions).map((line, index) => (
            <li key={`${line.at}:${index}`}>
              <span>
                {line.who} {line.what}
              </span>
              <time dateTime={line.at}>{whenText(line.at, now)}</time>
            </li>
          ))}
        </ol>
      </section>
      {children}
    </article>
  );
}
