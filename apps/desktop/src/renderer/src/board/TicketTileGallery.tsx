import type { Agent, AgentState, BoardItem, PullRequest, TicketWatch, TicketWatchNews } from '@agent-board/daemon/protocol';
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';
import { useMemo } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { HybridTile } from './HybridTile';
import { PopupTabs } from './AgentPopup';
import { popUpRow } from './agent-popup';
import { tokenNumber } from '../theme';
import { PopoverPreview } from '../ui';
import { newStickyData } from './items/StickyNode';
import { TicketBoard } from './TicketBoard';
import { TicketOpenTile } from './TicketOpenTile';
import { galleryAgent } from './TileGallery';
import { WatchesSheet } from './TicketWatches';
import { showInTicket } from './ticket-shown';
import { TICKET_TERMINAL_SIZE, type TicketView } from './ticket-view';
import { TicketViewsContext } from './tile';

const AT = '2026-01-01T00:00:00.000Z';

const line = (summary: string): Agent['status'] => ({ summary, progress: null, updatedAt: AT, setBy: null });
const pr = (number: number, state: PullRequest['state'], checks: PullRequest['checks'] = 'passing'): PullRequest => ({ number, title: 'Watch settings', url: '', state, checks });

const chat = (id: string, state: AgentState, fields: Partial<Agent> = {}): Agent => ({
  ...galleryAgent(state),
  sessionId: id,
  name: 'ACME-726',
  ticketChat: true,
  issue: { provider: 'linear', id: 'ACME-726', title: 'Watch settings for a zone', url: '' },
  subagents: [],
  pullRequests: [],
  ...fields,
});

const helper = (ticket: string, id: string, name: string, state: AgentState, fields: Partial<Agent> = {}): Agent => ({
  ...galleryAgent(state),
  sessionId: `${ticket}-${id}`,
  name,
  ticket,
  ledBy: ticket,
  spawnedBy: ticket,
  subagents: [],
  pullRequests: [],
  ...fields,
});

const crew = (ticket: string, states: [AgentState, AgentState, AgentState], fields: Partial<Agent>[] = []): Agent[] => [
  helper(ticket, 'design', 'Designer', states[0], { role: 'custom', roleName: 'designer', ...(states[0] === 'done' ? { endedAt: AT } : {}), ...fields[0] }),
  helper(ticket, 'build', 'Builder', states[1], { role: 'implementer', ...fields[1] }),
  helper(ticket, 'review', 'Reviewer', states[2], { role: 'reviewer', reviewOf: `${ticket}-build`, ...fields[2] }),
];

const ready = { category: 'ready-for-review' as const, label: null, waitingOn: null, setAt: AT, setBy: null };
const ask = { question: 'Retry the flaky check for two minutes or five?', options: [], at: AT } as unknown as Agent['ask'];

const tileOnly = { tile: true, chat: false };
const toChat = { tile: true, chat: true };
const seen: NonNullable<TicketWatch['seen']> = {
  lastReview: { by: 'sam', state: 'COMMENTED', at: AT },
  approvals: { by: [], decision: 'REVIEW_REQUIRED' },
  merge: { state: 'open', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' },
  checks: { state: 'passing', passing: 2, total: 2 },
};
const watch = (settings: Partial<TicketWatch['settings']>, fields: Partial<TicketWatch> = {}): TicketWatch => ({
  settings: { reviews: { tile: false, chat: false }, approvals: { tile: false, chat: false }, merge: { tile: false, chat: false }, checks: { tile: false, chat: false }, everyMinutes: 5, ...settings },
  pullRequest: { repo: 'acme/app', number: 648, url: '', state: 'open' },
  seen,
  news: [],
  ask: null,
  checkedAt: AT,
  problem: null,
  ...fields,
});
const news = (kind: TicketWatchNews['kind'], text: string, by: string | null = null): TicketWatchNews => ({ kind, text, at: AT, by });
const watchedPr = [pr(648, 'open')];

/** A ticket's tile in each of its looks at rest, by the name its screenshot takes. */
export const TICKETS: Record<string, { chat: Agent; helpers: Agent[] }> = {
  'at-rest': {
    // Its reviews watch is grey, which Simplified hides; its checks are green.
    chat: chat('ticket-rest', 'running', { status: line('Builder is adding the watch settings; the design is done.'), pullRequests: watchedPr, watch: watch({ reviews: tileOnly, checks: tileOnly }) }),
    helpers: crew('ticket-rest', ['done', 'running', 'idle']),
  },
  'needs-you': {
    chat: chat('ticket-you', 'running', { status: line('Waiting on the builder') }),
    helpers: crew('ticket-you', ['done', 'waiting', 'idle'], [{}, { ask, lastMessage: 'Retry the flaky check for two minutes or five?' }]),
  },
  'ready-to-merge': {
    chat: chat('ticket-merge', 'idle', { workCategory: ready, status: line('Approved, and its checks pass.'), pullRequests: [pr(647, 'open')] }),
    helpers: crew('ticket-merge', ['done', 'done', 'done'], [{}, { endedAt: AT }, { endedAt: AT }]),
  },
  merged: {
    chat: chat('ticket-merged', 'idle', { pullRequests: [pr(645, 'merged')] }),
    helpers: crew('ticket-merged', ['done', 'done', 'done'], [{}, { endedAt: AT }, { endedAt: AT }]),
  },
};

/** Every ticket tile here as a card, whatever Settings says they open as. */
const AS_CARDS = Object.fromEntries(Object.values(TICKETS).map(({ chat: each }) => [`agent:${each.sessionId}`, 'card' as const]));

/** Ticket tiles at rest, needing the user, ready to merge and merged: the gallery shows them, in either design. */
export function TicketTileGallery() {
  return (
    <TicketViewsContext value={AS_CARDS}>
      <div className="tile-gallery" data-testid="ticket-tile-gallery">
        {Object.entries(TICKETS).map(([name, { chat: shown, helpers }]) => (
          <div key={name} style={AGENT_TILE_SIZE} data-testid={`ticket-tile-${name}`}>
            <HybridTile id={`agent:${shown.sessionId}`} tile={{ label: shown.name, harness: shown.harness, agent: shown, helpers }} />
          </div>
        ))}
      </div>
    </TicketViewsContext>
  );
}

/** What a gallery draws for a session it cannot attach to: a few still lines of its terminal or its chat. */
function standIn(shown: Agent, view: TicketView) {
  return view === 'terminal' ? (
    <div className="ticket-gallery-terminal">
      <span>{`${shown.name} · ~/acme/watch-settings`}</span>
      <span>$ pnpm vitest run src/zone/watch-settings.test.ts</span>
      <span> ✓ 11 passed · 1 flaky</span>
      <span>Retry the flaky check for two minutes or five?</span>
    </div>
  ) : (
    <div className="ticket-gallery-chat">
      <p>{`${shown.name}: reading the diff of #651.`}</p>
      <p>The settings form saves on blur; the zone keeps its watch through a restart.</p>
    </div>
  );
}

/** A ticket's tile with its watches on, by the name its screenshot takes. */
export const WATCHED: Record<string, { chat: Agent; helpers: Agent[] }> = {
  // Tell chat off: the review is the user's to read, the ticket's one ask.
  'new-review': {
    chat: chat('watch-review', 'running', {
      chatKind: 'lead',
      status: line('Builder is adding the retries.'),
      pullRequests: watchedPr,
      watch: watch({ reviews: tileOnly, checks: tileOnly }, { news: [news('reviews', 'sam reviewed', 'sam')], ask: 'new-review' }),
    }),
    helpers: crew('watch-review', ['done', 'running', 'idle']),
  },
  // Tell chat on: its chat has the news, so the tile keeps its chat's line and its icons their own colour.
  'told-chat': {
    chat: chat('watch-told', 'running', {
      chatKind: 'lead',
      status: line('Answering sam’s review: capping the retries.'),
      pullRequests: watchedPr,
      watch: watch({ reviews: toChat, checks: tileOnly }, { news: [news('reviews', 'sam reviewed', 'sam')] }),
    }),
    helpers: crew('watch-told', ['done', 'running', 'idle']),
  },
  // Checks failing, with nothing else to ask: a quiet line and a quiet Read.
  'checks-failing': {
    chat: chat('watch-checks', 'idle', {
      chatKind: 'lead',
      status: null,
      lastMessage: null,
      pullRequests: [pr(648, 'open', 'failing')],
      watch: watch(
        { reviews: tileOnly, merge: tileOnly, checks: tileOnly },
        { seen: { ...seen, checks: { state: 'failing', passing: 1, total: 3 } }, news: [news('checks', 'Checks failing: 1 of 3 passing')] },
      ),
    }),
    helpers: crew('watch-checks', ['done', 'done', 'idle'], [{}, { endedAt: AT }]),
  },
  // All four on, each with something to say, beside the chat that builds: a review to read, approved, a conflict and
  // checks failing, in icons alone.
  crowded: {
    chat: chat('watch-crowded', 'running', {
      status: line('Fixing the conflict.'),
      pullRequests: [pr(648, 'open', 'failing')],
      watch: watch(
        { reviews: tileOnly, approvals: tileOnly, merge: tileOnly, checks: tileOnly },
        {
          seen: { ...seen, approvals: { by: ['sam'], decision: 'APPROVED' }, merge: { state: 'open', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, checks: { state: 'failing', passing: 1, total: 3 } },
          news: [news('reviews', 'priya requested changes', 'priya')],
          ask: 'new-review',
        },
      ),
    }),
    // The chat builds: no builder among its helpers, and its builds mark keeps its hammer alone beside the watches.
    helpers: crew('watch-crowded', ['done', 'running', 'running']).filter((each) => each.role !== 'implementer'),
  },
};

const SHEET = WATCHED['new-review']!.chat.watch!;

/** A ticket's tile opened, in each view, by the name its screenshot takes, with the helper it shows in place of its chat and its watches in its header. */
const OPENED: Record<string, { view: TicketView; chat: Agent; helpers: Agent[]; shows: string }> = {
  terminal: {
    view: 'terminal',
    chat: chat('ticket-terminal', 'running', { status: line('Waiting on the builder'), pullRequests: watchedPr, watch: watch({ reviews: tileOnly, checks: tileOnly }) }),
    helpers: crew('ticket-terminal', ['done', 'waiting', 'idle'], [{}, { ask, lastMessage: 'Retry the flaky check for two minutes or five?' }]),
    shows: 'ticket-terminal-build',
  },
  card: {
    view: 'card',
    chat: chat('ticket-card', 'running', {
      status: line('Reviewer is reading the builder’s pull request.'),
      pullRequests: [pr(651, 'open', 'pending')],
      watch: watch({ reviews: tileOnly, approvals: tileOnly }, { pullRequest: { repo: 'acme/app', number: 651, url: '', state: 'open' } }),
    }),
    helpers: crew('ticket-card', ['done', 'done', 'running'], [{}, { endedAt: AT, status: line('Opened #651') }, { status: line('Reading the diff') }]),
    shows: 'ticket-card-review',
  },
};

for (const { chat: each, shows } of Object.values(OPENED)) showInTicket(`agent:${each.sessionId}`, shows);

const OPENED_VIEWS = Object.fromEntries(Object.values(OPENED).map(({ chat: each, view }) => [`agent:${each.sessionId}`, view]));

/** Ticket tiles with their watches on, and the Watches menu open: the gallery shows them. */
export function TicketWatchGallery() {
  return (
    <div className="tile-gallery" data-testid="ticket-watch-gallery">
      {Object.entries(WATCHED).map(([name, { chat: shown, helpers }]) => (
        <div key={name} style={AGENT_TILE_SIZE} data-testid={`ticket-watch-${name}`}>
          <HybridTile id={`agent:${shown.sessionId}`} tile={{ label: shown.name, harness: shown.harness, agent: shown, helpers }} />
        </div>
      ))}
      <PopoverPreview className="ticket-watches-popover" aria-label="What ACME-726 watches">
        <WatchesSheet name="ACME-726" watch={SHEET} onChange={() => {}} onRead={() => {}} />
      </PopoverPreview>
    </div>
  );
}

/** A ticket's tile opened in place: its terminal over a strip of helpers, and its card opened with a column of them; each shows a helper. */
export function TicketOpenGallery() {
  return (
    <ReactFlowProvider>
      <TicketViewsContext value={OPENED_VIEWS}>
        <div className="tile-gallery" data-testid="ticket-open-gallery">
          {Object.entries(OPENED).map(([name, { chat: shown, helpers }]) => (
            <div key={name} style={TICKET_TERMINAL_SIZE} data-testid={`ticket-open-${name}`}>
              <TicketOpenTile id={`agent:${shown.sessionId}`} tile={{ label: shown.name, harness: shown.harness, agent: shown, helpers, expanded: true }} parent="board" standIn={standIn} />
            </div>
          ))}
        </div>
      </TicketViewsContext>
    </ReactFlowProvider>
  );
}

/** A ticket's own board, zoomed into: its chat and helpers as tiles, one helper placed by hand, a note beside them. */
const ZOOMED = {
  chat: chat('ticket-board', 'running', {
    status: line('I’ve given sam’s three comments to the builder.'),
    pullRequests: watchedPr,
    watch: watch({ reviews: tileOnly, checks: tileOnly }, { news: [news('reviews', 'sam reviewed', 'sam')] }),
  }),
  helpers: crew('ticket-board', ['done', 'running', 'idle'], [{ status: line('Mock published') }, { status: line('Answering sam’s 3 comments'), ticketPlace: { x: 330, y: 150 } }, {}]),
};
const ZOOMED_NOTE: BoardItem = {
  id: 'ticket-board-note',
  kind: 'sticky',
  zoneId: null,
  ticket: 'ticket-board',
  x: 0,
  y: 200,
  width: 200,
  height: 160,
  z: 1,
  rotation: 0,
  data: { ...newStickyData(), text: 'sam: make the dot 8 px on dark.' },
  createdAt: AT,
  updatedAt: AT,
};
const ZOOMED_AGENTS = [ZOOMED.chat, ...ZOOMED.helpers];
const ZOOMED_ITEMS = [ZOOMED_NOTE];
const NO_ERROR = () => () => {};

/** A ticket's own board, zoomed into, under its breadcrumb and its watches' news. */
export function TicketBoardGallery() {
  const desk = useMemo(() => ({ gap: tokenNumber('--desk-dot-gap'), size: tokenNumber('--desk-dot-size') }), []);
  return (
    <div className="ticket-board-gallery" data-testid="ticket-board-gallery">
      <TicketBoard chatId={ZOOMED.chat.sessionId} agents={ZOOMED_AGENTS} onLeave={() => {}} onOpenAgent={() => {}} onError={NO_ERROR} desk={desk} shownItems={ZOOMED_ITEMS} />
    </div>
  );
}

/** A ticket's card opened in place with a new review: its footer offers Read, the one ask, as its card at rest does. */
const OPENED_READ = chat('ticket-card-read', 'running', {
  status: line('Builder is adding the retries.'),
  pullRequests: watchedPr,
  watch: watch({ reviews: tileOnly, checks: tileOnly }, { news: [news('reviews', 'sam requested changes', 'sam')], ask: 'new-review' }),
});
const OPENED_READ_HELPERS = crew('ticket-card-read', ['done', 'running', 'idle']);
const OPENED_READ_VIEWS = { [`agent:${OPENED_READ.sessionId}`]: 'card' as const };

/** A ticket's card opened in place, with a new review its one ask: Read in its footer. */
export function TicketOpenReadGallery() {
  return (
    <ReactFlowProvider>
      <TicketViewsContext value={OPENED_READ_VIEWS}>
        <div className="tile-gallery" data-testid="ticket-open-read-gallery">
          <div style={TICKET_TERMINAL_SIZE}>
            <TicketOpenTile
              id={`agent:${OPENED_READ.sessionId}`}
              tile={{ label: OPENED_READ.name, harness: OPENED_READ.harness, agent: OPENED_READ, helpers: OPENED_READ_HELPERS, expanded: true }}
              parent="board"
              standIn={standIn}
            />
          </div>
        </div>
      </TicketViewsContext>
    </ReactFlowProvider>
  );
}

const ROW = TICKETS['needs-you']!;
const ROW_TABS = popUpRow(ROW.chat, ROW.helpers);
const REVIEWER = ROW.helpers[2]!.sessionId;
/** Wide enough for the whole row; and narrow enough that it folds, but holds the Board, the amber tab and the one on. */
const ROW_WIDE = { width: 960 };
const ROW_NARROW = { width: 560 };
const nothing = () => {};

/**
 * A ticket pop-up's one row of tabs: its Board, its chat, and its helpers, the reviewer's on and the chat underlined as
 * the one it came from, the builder amber as it asks; then the same row folded into "+n".
 */
export function TicketPopupRowGallery() {
  const row = (testId: string, size: { width: number }) => (
    <div style={size} data-testid={testId}>
      <PopupTabs
        row={ROW_TABS}
        active={REVIEWER}
        from={ROW.chat.sessionId}
        nodeId={`agent:${ROW.chat.sessionId}`}
        closed={[]}
        onSelect={nothing}
        onClose={nothing}
        onMove={nothing}
        onOpenWindow={nothing}
      />
    </div>
  );
  return (
    <div className="tile-gallery" data-testid="ticket-popup-row-gallery">
      {row('ticket-popup-row-wide', ROW_WIDE)}
      {row('ticket-popup-row-narrow', ROW_NARROW)}
    </div>
  );
}
