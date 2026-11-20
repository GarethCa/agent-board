import { useContext, useRef, type ReactNode } from 'react';
import { NodeResizeControl, ResizeControlVariant, type ControlPosition } from '@xyflow/react';
import { ChevronLeft, ChevronRight, GitMerge, GitPullRequest, Hammer, Ticket } from 'lucide-react';
import { chatBuilds } from '@agent-board/daemon/ticket-tiles';
import type { Agent, PullRequest } from '@agent-board/daemon/protocol';
import { useLeaveKeys } from '../keys/escape-hatch';
import { useSimplified } from '../design';
import { useNeedsYouShows } from '../needs-you-setting';
import { SessionBody } from '../session/SessionBody';
import { Chip } from '../ui';
import { useAgentTileMenu } from './agent-tile-menu';
import { BackToTileButton } from './BackToTile';
import { CAPTURE_FRAME } from './capture-mode';
import { EXPANDED_MAX_SIZE, EXPANDED_MIN_SIZE, resizeAllowed, type ExpandedParent } from './expanded';
import { FrostMark } from './FrostMark';
import { withoutRename } from './menu-model';
import { frostedClasses } from './paused';
import { TileActionsContext, type TileProps } from './tile';
import { stopPropagation, TileMenu } from './tile-parts';
import { ticketFace } from './ticket-tile';
import { HELPER_ICONS, HelperCard, OneButton, TicketViewSwitch, useSwitchTicketView, useTicketView, viewRows } from './ticket-parts';
import { useTicketShown } from './ticket-shown';
import { boardRow, ticketChatEntries, ticketMenuEntries } from './ticket-chat-menu';
import { shownHelper, type TicketView } from './ticket-view';
import { useViewSettingsLoaded } from './view-settings';
import { TicketWatchesMenu, WatchIcons } from './TicketWatches';

const CORNERS: readonly ControlPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const EDGES: readonly ControlPosition[] = ['top', 'right', 'bottom', 'left'];
const noop = () => {};

/**
 * A ticket's tile opened in place, as an expanded tile is: in the terminal view its chat's live terminal with its
 * helpers as a strip of cards under it, or, its card opened, the chat with its helpers in a column beside it. A click on
 * a helper shows that helper there in place of the chat, a breadcrumb leading back; ⌥-click opens its own window. Its
 * header has the ticket, its pull request, its watches with their Watches menu, the Card | Terminal switch and ⋯, and
 * its footer the one thing it asks, in either view; Esc or Collapse puts it back to its card.
 */
type TicketOpenTileProps = TileProps & {
  parent: ExpandedParent;
  /** What a gallery draws in place of the live session shown: the terminal or chat of the agent, in the view. */
  standIn?: (shown: Agent, view: TicketView) => ReactNode;
};

export function TicketOpenTile(props: TicketOpenTileProps) {
  // Not drawn before the saved settings are read, as an expanded tile is not; a gallery's reads none.
  const loaded = useViewSettingsLoaded();
  return loaded || props.standIn !== undefined ? <TicketOpenTileShown {...props} /> : null;
}

function TicketOpenTileShown({ id, tile, parent, standIn }: TicketOpenTileProps) {
  const chat = tile.agent!;
  const helpers = tile.helpers ?? [];
  const { collapse, expand, resizeExpanded, openAgent, openPullRequest, resumeAgent, setTicketView, setTicketChat, readWatches, openTicketBoard } = useContext(TileActionsContext);
  const shows = useNeedsYouShows();
  const face = ticketFace(chat, helpers, shows, { simplified: useSimplified() });
  const view = useTicketView(id);
  const switchView = useSwitchTicketView(id, chat.sessionId);
  const terminal = view === 'terminal';
  const [picked, show] = useTicketShown(id);
  const helper = shownHelper(picked, helpers);
  const subject = helper ?? chat;
  const menu = useAgentTileMenu(id, chat, { from: tile.from, implementer: tile.implementer }, noop);
  const kinds = ticketChatEntries(chat, (kind) => setTicketChat(chat.sessionId, kind));
  const entries = ticketMenuEntries([...viewRows(view, switchView), boardRow(() => openTicketBoard(chat.sessionId))], kinds, withoutRename(menu.entries));
  const root = useRef<HTMLElement>(null);
  const resizeStart = useRef({ x: 0, y: 0 });
  // Esc from its header, or ⌘Esc from anywhere in it: back to its card; from the terminal view, a switch by hand.
  useLeaveKeys(root, () => (terminal ? setTicketView(id, 'card') : collapse(id, 'leaveKeys')));
  const prOwner = face.pr === undefined ? undefined : [chat, ...helpers].find((agent) => agent.pullRequests.includes(face.pr!));
  const openPr = (pr: PullRequest) => prOwner !== undefined && openPullRequest(prOwner, pr);
  const helperOf = (sessionId: string) => helpers.find((each) => each.sessionId === sessionId)!;
  const cards = (
    <div className={terminal ? 'ticket-open-strip' : 'ticket-open-side'} data-testid="ticket-helper-cards">
      {!terminal && (
        <h4 className="ticket-open-side-head">
          Helpers <span>{face.helpers.length}</span>
        </h4>
      )}
      {face.helpers.map((each) => (
        <HelperCard
          key={each.sessionId}
          helper={each}
          column={!terminal}
          open={each.sessionId === helper?.sessionId}
          onShow={() => show(each.sessionId)}
          onOpenWindow={() => openAgent(helperOf(each.sessionId))}
        />
      ))}
    </div>
  );
  return (
    <section
      ref={root}
      className={frostedClasses('expanded-tile ticket-open', chat)}
      data-testid="expanded-tile"
      data-ticket-open={view}
      data-harness={chat.harness}
      data-session-id={chat.sessionId}
      data-ask={face.ask}
      aria-label={`${face.title}, ${terminal ? 'its terminal' : 'opened'}`}
      onPointerDownCapture={() => expand(id)}
      // Not for the board: a double-click in the terminal selects a word.
      onDoubleClick={stopPropagation}
    >
      <header className="session-window-head expanded-tile-head ticket-open-head">
        {face.ticketId !== undefined && (
          <span className="ticket-tile-id" data-testid="ticket-id">
            <Ticket aria-hidden />
            {face.ticketId}
          </span>
        )}
        {/* Not `nameClass`: its long variant keeps room for a rename pencil, which this header has none of. */}
        <span className="hybrid-tile-name ticket-open-title" title={face.title}>
          {face.title}
        </span>
        <span className="session-window-head-fill" />
        {/* As the mock groups them: who builds it, then what it watches (its pull request and its watches), the view switch and the rest. */}
        {chatBuilds(chat) && (
          <span className="ticket-tile-builds" data-testid="ticket-builds" title="This chat builds the ticket: it writes the code">
            <Hammer aria-hidden />
            builds
          </span>
        )}
        <FrostMark agent={chat} />
        {face.pr !== undefined && (
          <Chip className="hybrid-tile-pr ticket-tile-watch nodrag" data-testid="ticket-pr" data-state={face.pr.state} title={`#${face.pr.number} ${face.pr.title}: open it`} onClick={() => openPr(face.pr!)}>
            {face.merged ? <GitMerge aria-hidden /> : <GitPullRequest aria-hidden />}#{face.pr.number}
          </Chip>
        )}
        <WatchIcons icons={face.watches} />
        <TicketWatchesMenu chat={chat} name={face.ticketId ?? face.title} />
        <TicketViewSwitch view={view} onSwitch={switchView} />
        <span className="nodrag">
          <TileMenu entries={entries} onOpen={menu.reread} />
        </span>
        {!terminal && <BackToTileButton from={root} leave={() => collapse(id, 'button')} label="Collapse" />}
      </header>
      {helper !== undefined && <Breadcrumb helper={helper} onBack={() => show(undefined)} kind={face.helpers.find((each) => each.sessionId === helper.sessionId)?.kind} />}
      <div className="ticket-open-main" data-view={view}>
        <div className="expanded-tile-body ticket-open-body nodrag nowheel nopan">
          {standIn !== undefined ? (
            standIn(subject, view)
          ) : CAPTURE_FRAME !== undefined ? (
            // A capture window never shows what a session printed.
            <div className="expanded-tile-hidden" data-testid="terminal-hidden">
              terminal hidden
            </div>
          ) : (
            <SessionBody
              key={subject.sessionId}
              content={{ kind: 'session', sessionId: subject.sessionId, agent: subject }}
              detailsCollapsed
              onDetailsCollapsed={noop}
              autoFocus={false}
              chatControlsSlot={null}
              compactControls
              // The tile shows only the terminal or the chat: no shelves.
              shelves={false}
              view={terminal ? 'terminal' : 'chat'}
            />
          )}
        </div>
        {face.helpers.length > 0 && cards}
      </div>
      {/* Its one ask, the same in both views. */}
      <footer className="ticket-tile-foot ticket-open-foot">
        <span className="ticket-tile-state" data-testid="tile-state-word" data-kind={face.wordKind}>
          <span className="ticket-tile-dot" aria-hidden />
          {face.word}
        </span>
        {face.button !== undefined && (
          <OneButton
            button={face.button}
            onOpen={() => (face.asker === chat ? show(undefined) : showOrOpen(face.asker, helpers, show, openAgent))}
            onMerge={() => face.pr !== undefined && openPr(face.pr)}
            onWake={() => resumeAgent(face.asker.sessionId)}
            onRead={() => readWatches(chat.sessionId)}
          />
        )}
      </footer>
      {[...EDGES, ...CORNERS].map((position) => {
        const corner = CORNERS.includes(position);
        return (
          <NodeResizeControl
            key={position}
            position={position}
            variant={corner ? ResizeControlVariant.Handle : ResizeControlVariant.Line}
            minWidth={EXPANDED_MIN_SIZE.width}
            minHeight={EXPANDED_MIN_SIZE.height}
            maxWidth={EXPANDED_MAX_SIZE.width}
            maxHeight={EXPANDED_MAX_SIZE.height}
            className={corner ? 'item-resize-handle expanded-tile-resize' : 'item-resize-line expanded-tile-resize'}
            onResizeStart={(_event, { x, y }) => {
              resizeStart.current = { x, y };
            }}
            shouldResize={(_event, next) => resizeAllowed(next, resizeStart.current, parent)}
            onResizeEnd={(_event, { x, y, width, height }) => resizeExpanded(id, { width, height }, { x, y })}
          />
        );
      })}
    </section>
  );
}

/** What the one button opens for a helper that asks: that helper, shown in the tile. */
function showOrOpen(asker: Agent, helpers: readonly Agent[], show: (sessionId: string) => void, openAgent: (agent: Agent) => void) {
  if (helpers.includes(asker)) show(asker.sessionId);
  else openAgent(asker);
}

/** The line over a helper shown in place of the chat: back to the ticket's chat, then the helper's name. */
function Breadcrumb({ helper, kind, onBack }: { helper: Agent; kind: keyof typeof HELPER_ICONS | undefined; onBack(): void }) {
  return (
    <nav className="ticket-open-crumb nodrag" aria-label="Shown" data-testid="ticket-crumb">
      <button type="button" className="ticket-open-crumb-back" data-testid="ticket-crumb-back" onClick={onBack} onDoubleClick={stopPropagation}>
        <ChevronLeft aria-hidden />
        Ticket chat
      </button>
      <ChevronRight aria-hidden className="ticket-open-crumb-sep" />
      {kind !== undefined && HELPER_ICONS[kind]}
      <b>{helper.name}</b>
    </nav>
  );
}
