import { memo, useCallback, useContext, useMemo, useState } from 'react';
import { type NodeProps } from '@xyflow/react';
import { Bot, Inbox, Ticket } from 'lucide-react';
import { jobsFrom } from '@agent-board/daemon/memory-lines';
import { QUEUE_CARD_SIZE, LIST_CARD_FOLDED_SIZE, LIST_CARD_MIN_SIZE, type QueueAudience, type QueueChange, type QueueJob } from '@agent-board/daemon/protocol';
import { IconButton, useToast } from '../../ui';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { scopeText } from './memory-card';
import { needsYouEntries } from '../../../../shared/needs-you';
import { useNeedsYouShows } from '../../needs-you-setting';
import { openDrain, openFocus, openHandOn, QueueBoardContext } from './queue-board';
import { lookCount, needsInScope } from './to-look-at';
import { QueueCardView, QueueIconView, QueuePeek, type AddJob } from './QueueCard';
import { agentLine, freshJob, jobLine, newestChange, nextJob, queueData, queueTitle } from './queue-card';
import { CardResizer } from './CardSizing';
import { foldTo } from './card-size';
import { ListCardPeekPopover, ListCardToolbar, useFocusOnce, useFresh, useLift, useRows, useZone, why } from './ListCardNodeParts';

/** A queue's jobs and notes as the daemon lists them, for the user. */
const readJobs = (id: string) => window.agentBoard.items.readQueue(id).then((view) => view.jobs);

/**
 * A queue on the board: open, a card listing its jobs in order with a box to add one (C); folded, its ticket icon alone
 * (E), or the inbox for a queue that is the user's. Either opens the peek beside it, with every job to search, edit,
 * reorder, finish, put back or remove.
 */
export const QueueNode = memo(function QueueNode({ id: nodeId, data, selected: picked, dragging }: NodeProps<ItemNodeType>) {
  const selected = useOnlySelected(picked);
  const { update, remove } = useContext(ItemActionsContext);
  const toast = useToast();
  const { item } = data;
  const queue = queueData(item.data);
  const zone = useZone(item.zoneId);
  const lift = useLift(queue.folded === true);
  const scope = scopeText(queue.noAgents, zone.name);
  const jobs = useRows(item.id, item.updatedAt, readJobs, (error) =>
    toast.show({ tone: 'error', id: `queue-read-${item.id}`, message: `Could not read “${queue.title}”: ${why(error)}` }),
  );
  // A queue just made opens with its add box focused.
  const focusAdd = useFocusOnce(nodeId, data.editing);
  const fresh = useFresh(jobs, freshJob, newestChange);
  const [peek, setPeek] = useState(false);
  const shown = jobs ?? [];
  // The user's queue shows Needs-you rows too: its zone's agents', or every agent's when it is loose.
  const board = useContext(QueueBoardContext);
  const shows = useNeedsYouShows();
  const needs = useMemo(() => (queue.audience === 'user' ? needsInScope(needsYouEntries(board.agents, shows), item.zoneId) : []), [queue.audience, board.agents, shows, item.zoneId]);
  const start = () => {
    setPeek(false);
    openFocus(item.id);
  };
  const taken = shown.some((job) => job.state === 'taken');

  const change = useCallback(
    (what: QueueChange) =>
      window.agentBoard.items.changeQueue(item.id, what).then(
        () => true,
        (error: unknown) => {
          toast.show({ tone: 'error', id: `queue-${item.id}`, message: `Could not change “${queue.title}”: ${why(error)}` });
          return false;
        },
      ),
    [item.id, queue.title, toast],
  );
  const add: AddJob = (job) => void change({ action: 'add', ...job });
  // A removed row is one Undo from back, where it was: its history keeps its text, and the row after it says where.
  const removeJob = (job: QueueJob) => {
    const open = shown.filter((each) => each.state !== 'done');
    const after = job.state === 'done' ? undefined : open[open.findIndex((each) => each.id === job.id) + 1];
    void change({ action: 'remove', job: job.id }).then((removed) => {
      if (!removed) return;
      toast.show({
        message: `Removed “${jobLine(job)}” from “${queue.title}”`,
        action: {
          label: 'Undo',
          onClick: () =>
            void window.agentBoard.items.queueHistory(item.id, job.id).then(
              async (versions) => {
                const kept = versions.find((version) => version.value !== null);
                if (kept === undefined || !(await change({ action: 'restore', job: job.id, version: kept.version }))) return;
                // Back where it was, when the row that followed it is still open: else at the end, where restore puts it.
                if (after !== undefined) await window.agentBoard.items.changeQueue(item.id, { action: 'move', job: job.id, before: after.id }).catch(() => undefined);
              },
              (error: unknown) => toast.show({ tone: 'error', id: `queue-${item.id}`, message: `Could not put back “${jobLine(job)}”: ${why(error)}` }),
            ),
        },
      });
    });
  };
  const fold = (folded: boolean) => {
    if (folded) setPeek(false);
    const { size, kept } = foldTo(item, folded, { folded: LIST_CARD_FOLDED_SIZE, open: QUEUE_CARD_SIZE });
    update({ id: item.id, data: { folded, ...kept }, ...size });
  };
  // Who it is for; a name it was given for its audience follows it, one the user typed stays.
  const setAudience = (audience: QueueAudience) => {
    if (audience === queue.audience) return;
    const named = queue.title === queueTitle(queue.audience, zone.name);
    // The user's queue starts no agents: a drain that was on goes off with the switch.
    const drain = audience === 'user' && queue.drain?.on === true ? { drain: { ...queue.drain, on: false } } : {};
    update({ id: item.id, data: { audience, ...drain, ...(named ? { title: queueTitle(audience, zone.name) } : {}) } });
  };
  const forYou = queue.audience === 'user';
  const toolbar = (
    <ListCardToolbar
      visible={selected && !dragging}
      folded={queue.folded === true}
      onFold={fold}
      agents={{ noAgents: queue.noAgents, scope: scopeText(false, zone.name), toggle: () => update({ id: item.id, data: { noAgents: !queue.noAgents } }) }}
      noun="queue"
      onDelete={() => remove(item.id)}
    >
      <IconButton
        icon={forYou ? <Ticket /> : <Inbox />}
        size="sm"
        disabled={taken}
        aria-label={forYou ? 'Make it a queue for agents' : 'Make it a queue for you'}
        tooltip={taken ? 'An agent has a job from it: it stays for agents' : forYou ? 'For agents: they take its jobs' : 'For you: things to look at, which no agent takes'}
        onClick={() => setAudience(forYou ? 'agents' : 'user')}
      />
      {!forYou && (
        <IconButton
          icon={<Bot />}
          size="sm"
          aria-label="Start agents to take jobs"
          tooltip={queue.drain?.on === true ? `Agents start for its jobs, at most ${queue.drain.most}: change it` : 'Start agents to take jobs…'}
          onClick={() => openDrain(item.id)}
        />
      )}
    </ListCardToolbar>
  );

  const body = queue.folded ? (
    <QueueIconView
      audience={queue.audience}
      title={queue.title}
      scope={scope}
      zoneColor={zone.color}
      lift={lift}
      count={lookCount(jobs === undefined ? queue.count : shown.filter((job) => job.state !== 'done').length, needs)}
      next={nextJob(shown)}
      pulse={fresh !== undefined}
      sub={fresh === undefined ? undefined : agentLine(fresh)}
      onOpen={() => setPeek(true)}
    >
      {toolbar}
    </QueueIconView>
  ) : (
    <QueueCardView
      title={queue.title}
      scope={scope}
      zoneColor={zone.color}
      zoneName={zone.name}
      audience={queue.audience}
      jobs={shown}
      count={jobs === undefined ? queue.count : undefined}
      loaded={jobs !== undefined}
      onAdd={add}
      onOpen={() => setPeek(true)}
      onAudience={setAudience}
      needs={needs}
      onOpenAgent={board.openAgent}
      onStart={start}
      dragFrom={queue.noAgents ? undefined : { queueId: item.id, zoneId: item.zoneId }}
      drain={queue.drain}
      onDrain={() => openDrain(item.id)}
      fresh={fresh?.id}
      focusAdd={focusAdd}
    >
      {toolbar}
    </QueueCardView>
  );

  return (
    <>
      <CardResizer visible={selected && queue.folded !== true} least={LIST_CARD_MIN_SIZE} onResized={(frame) => update({ id: item.id, ...frame })} />
      <ListCardPeekPopover
        anchor={<div className="listcard-anchor">{body}</div>}
        open={peek}
        onOpenChange={setPeek}
        aria-label={`${queue.title}: every job`}
        className="listcard-peek-popover"
      >
        <QueuePeek
          needs={needs}
          onOpenAgent={board.openAgent}
          onStart={start}
          dragFrom={queue.noAgents ? undefined : { queueId: item.id, zoneId: item.zoneId }}
          // A queue set to No agents gives its jobs to no agent: no Hand, as no drag.
          onHand={queue.noAgents ? undefined : (job) => {
            setPeek(false);
            openHandOn({ queueId: item.id, jobId: job.id });
          }}
          title={queue.title}
          scope={scope}
          zoneColor={zone.color}
          audience={queue.audience}
          jobs={shown}
          focusAdd={shown.length === 0}
          onAdd={add}
          onEdit={(job, line) => void change({ action: 'edit', job: job.id, ...line })}
          onMove={(job, before) => change({ action: 'move', job: job.id, before: before?.id ?? null })}
          onDone={(job) => void change({ action: 'done', job: job.id })}
          onDrop={(job) => void change({ action: 'drop', job: job.id })}
          onRemove={removeJob}
          onGone={(job, draft) =>
            toast.show({
              message: `“${jobLine(job)}” was removed while you edited it`,
              ...(draft.trim() === '' ? {} : { persistent: true, action: { label: 'Add your text back', onClick: () => jobsFrom(draft).forEach((line) => add({ kind: job.kind, ...line })) } }),
            })
          }
        />
      </ListCardPeekPopover>
    </>
  );
});
