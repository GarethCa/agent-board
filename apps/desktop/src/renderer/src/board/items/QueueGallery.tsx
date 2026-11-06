import { QUEUE_CARD_SIZE, LIST_CARD_FOLDED_SIZE, ZONE_COLORS, type QueueJob } from '@agent-board/daemon/protocol';
import { PopoverPreview } from '../../ui';
import { jobBrief } from '@agent-board/daemon/memory-lines';
import type { Agent } from '@agent-board/daemon/protocol';
import type { NeedsYouEntry } from '../../../../shared/needs-you';
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';
import { HybridTile } from '../HybridTile';
import { galleryAgent } from '../TileGallery';
import { DrainSheetView, NEW_DRAIN } from './DrainSheet';
import { HandOnView } from './HandOn';
import { FocusCardView } from './QueueFocus';
import { TakenJobsContext } from './taken-jobs';
import { QueueCardView, QueueIconView, QueuePeek } from './QueueCard';
import { nextJob } from './queue-card';

const at = (hour: number, minute = 0) => new Date(2026, 10, 5, hour, minute).toISOString();
const lead = { kind: 'agent', sessionId: 'lead', name: 'lead' } as const;
const impl2 = { kind: 'agent', sessionId: 'impl-2', name: 'impl-2' } as const;
const impl3 = { kind: 'agent', sessionId: 'impl-3', name: 'impl-3' } as const;
const you = { kind: 'user' } as const;

function job(id: string, text: string, more: Partial<QueueJob> = {}): QueueJob {
  return {
    id,
    queueId: 'gallery',
    kind: 'job',
    text,
    link: null,
    state: 'queued',
    takenBy: null,
    takenAt: null,
    drops: 0,
    doneBy: null,
    doneAt: null,
    madeBy: lead,
    changedBy: more.madeBy ?? lead,
    lastChange: 'add',
    createdAt: at(9),
    updatedAt: at(9),
    ...more,
  };
}

/** A work queue as the daemon lists it: open ones in order, then those done, newest first. */
const JOBS: QueueJob[] = [
  job('j1', 'Rate-limit the login route', { state: 'taken', takenBy: impl2, takenAt: at(10, 20), link: 'https://example.test/acme/api/issues/84' }),
  job('j2', 'Drop the v1 webhooks', { drops: 1, link: 'https://example.test/acme/api/issues/88' }),
  job('j3', 'Ask before touching billing', { kind: 'note', madeBy: you }),
  job('j4', 'Paginate /orders', { state: 'taken', takenBy: impl3, takenAt: at(11, 5) }),
  job('j5', 'Retry failed refunds', { link: 'https://example.test/acme/api/issues/91' }),
  job('j6', 'Fix the flaky cart test', { madeBy: you }),
  job('j7', 'Cache product images', { state: 'done', doneBy: impl2, doneAt: at(9, 40) }),
];

/** The user's own queue: what is ready for them to look at. */
const TO_LOOK_AT: QueueJob[] = [
  job('u1', 'Cache product images', { link: 'https://example.test/acme/api/pull/214' }),
  job('u2', 'Split the checkout: the plan', { madeBy: { kind: 'agent', sessionId: 'lead-web', name: 'lead · web' }, link: 'docs/plans/checkout-split.md' }),
  job('u3', 'Load-test findings', { madeBy: impl3 }),
];

const noop = () => {};
const NOW = new Date(2026, 10, 5, 15, 0);

/** A work queue no one takes from yet. */
const WAITING: QueueJob[] = [job('w1', 'Empty-cart state'), job('w2', 'Cart drawer keyboard trap', { madeBy: you })];

/** An agent waiting on the user, in the user's queue's zone; one idle; one at work holding a job. */
const ASKING: Agent = { ...galleryAgent('waiting'), sessionId: 'gallery-asking', name: 'impl-3', zoneId: 'api', ask: { question: 'Keep the old cursor param?', options: [], askedAt: at(11, 2) } } as unknown as Agent;
const IDLE: Agent = { ...galleryAgent('idle'), sessionId: 'gallery-idle', name: 'impl-4', zoneId: 'web' };
const WORKER: Agent = { ...galleryAgent('running'), sessionId: 'gallery-worker', name: 'impl-2', zoneId: 'web' };
const NEEDS: NeedsYouEntry[] = [{ agent: ASKING, kind: 'asks', since: at(11, 2) }];
const HELD = new Map([[WORKER.sessionId, [{ sessionId: WORKER.sessionId, queueId: 'gallery', queueTitle: 'api jobs', job: JOBS[0]! }]]]);
const FOCUS_ACTS = { onOpen: noop, onNext: noop, onSkip: noop, onDone: noop, onClose: noop };
/** The api zone's colour, as a zone stores it. */
const ZONE = ZONE_COLORS[0];
const card = { width: QUEUE_CARD_SIZE.width, height: QUEUE_CARD_SIZE.height };
const folded = { width: LIST_CARD_FOLDED_SIZE.width, height: LIST_CARD_FOLDED_SIZE.height };
const open = (jobs: QueueJob[]) => jobs.filter((each) => each.state !== 'done').length;

/**
 * A queue in each of its looks: a work queue open with jobs taken and waiting, the user's own, an empty one asking who it
 * is for; folded with the next job, just taken from, empty and the user's; and its peek.
 */
export function QueueGallery() {
  return (
    <section className="listcard-gallery" data-testid="queue-gallery" aria-label="Queue">
      <div className="listcard-gallery-row">
        <div style={card} data-testid="queue-gallery-card">
          <QueueCardView title="api jobs" scope="Zone · api" zoneColor={ZONE} zoneName="api" audience="agents" jobs={JOBS} onAdd={noop} onOpen={noop} fresh="j4" />
        </div>
        <div style={card} data-testid="queue-gallery-inbox">
          <QueueCardView title="To look at" scope="Board" audience="user" jobs={TO_LOOK_AT} onAdd={noop} onOpen={noop} />
        </div>
        <div style={card} data-testid="queue-gallery-empty">
          <QueueCardView title="web jobs" scope="Zone · web" zoneName="web" audience="agents" jobs={[]} onAdd={noop} onOpen={noop} onAudience={noop} />
        </div>
      </div>
      <div className="listcard-gallery-row" data-testid="queue-gallery-icons">
        <div style={folded}>
          <QueueIconView audience="agents" title="api jobs" scope="Zone · api" zoneColor={ZONE} count={open(JOBS)} next={nextJob(JOBS)} onOpen={noop} />
        </div>
        <div style={folded}>
          <QueueIconView audience="agents" title="api jobs" scope="Zone · api" count={open(JOBS)} next={nextJob(JOBS)} sub="impl-3 took Paginate /orders" pulse onOpen={noop} />
        </div>
        <div style={folded}>
          <QueueIconView audience="agents" title="web jobs" scope="Zone · web" count={0} onOpen={noop} />
        </div>
        <div style={folded}>
          <QueueIconView audience="user" title="To look at" scope="Board" count={TO_LOOK_AT.length} next={nextJob(TO_LOOK_AT)} onOpen={noop} />
        </div>
      </div>
      <div className="listcard-gallery-row">
        <div className="listcard-gallery-peek" data-testid="queue-gallery-peek">
          <PopoverPreview aria-label="api jobs: every job" className="listcard-peek-popover">
            <QueuePeek
              title="api jobs"
              scope="Zone · api"
              zoneColor={ZONE}
              audience="agents"
              jobs={JOBS}
              onAdd={noop}
              onEdit={noop}
              onMove={noop}
              onDone={noop}
              onDrop={noop}
              onRemove={noop}
              autoFocus={false}
            />
          </PopoverPreview>
        </div>
      </div>
    </section>
  );
}

/**
 * A queue reaching agents and the user: the user's with a Needs-you row, one no one takes from, a ticket on its taker's
 * tile, the focus view, Hand on and the drain sheet.
 */
export function QueueHandOnGallery() {
  return (
    <section className="listcard-gallery" data-testid="queue-hand-on-gallery" aria-label="Queue, handed on">
      <div className="listcard-gallery-row">
        <div style={card} data-testid="queue-gallery-look">
          <QueueCardView title="To look at" scope="Zone · api" zoneColor={ZONE} audience="user" jobs={TO_LOOK_AT} needs={NEEDS} onAdd={noop} onOpen={noop} onStart={noop} />
        </div>
        <div style={card} data-testid="queue-gallery-idle">
          <QueueCardView title="web jobs" scope="Zone · web" zoneName="web" audience="agents" jobs={WAITING} onAdd={noop} onOpen={noop} onDrain={noop} />
        </div>
        {/* Room above the tile for what stands on it (a Character, under the Simplified design), as the board gives it. */}
        <div className="listcard-gallery-tile" data-testid="queue-gallery-ticket">
          <div style={AGENT_TILE_SIZE}>
            <TakenJobsContext value={HELD}>
              <HybridTile id={WORKER.sessionId} tile={{ label: WORKER.name, harness: WORKER.harness, agent: WORKER }} />
            </TakenJobsContext>
          </div>
        </div>
      </div>
      <div className="listcard-gallery-row">
        <div data-testid="queue-gallery-focus">
          <FocusCardView queueTitle="To look at" item={{ kind: 'job', job: TO_LOOK_AT[0]! }} at={2} total={4} now={NOW} {...FOCUS_ACTS} inline />
        </div>
        <div data-testid="queue-gallery-focus-needs">
          <FocusCardView queueTitle="To look at" item={{ kind: 'needs', entry: NEEDS[0]! }} at={1} total={4} now={NOW} {...FOCUS_ACTS} inline />
        </div>
      </div>
      <div className="listcard-gallery-row">
        <div data-testid="queue-gallery-hand">
          <HandOnView job={WAITING[0]!} agents={[IDLE, WORKER]} chosen={IDLE.sessionId} text={jobBrief({ title: 'web jobs', ref: 'item:4f1c2a9e' }, WAITING[0]!.id, WAITING[0]!.text, null, 'handed to you')} onChoose={noop} onText={noop} onSend={noop} onCancel={noop} inline />
        </div>
        <div data-testid="queue-gallery-drain">
          <DrainSheetView title="web jobs" zoneName="web" drain={NEW_DRAIN} onChange={noop} onStart={noop} onStop={noop} onCancel={noop} inline />
        </div>
      </div>
    </section>
  );
}
