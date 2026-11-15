import { useContext, useState, type MouseEvent } from 'react';
import { Check, Expand, GitMerge, GitPullRequest, Hammer, Play, Ticket } from 'lucide-react';
import { waitsForYou, type Agent, type PullRequest } from '@agent-board/daemon/protocol';
import { chatBuilds } from '@agent-board/daemon/ticket-tiles';
import { Button, Chip, EditableName, HoverCard, RenameButton, useRenaming, useSlowClickRename, type Renaming } from '../ui';
import { useSimplified } from '../design';
import { useNeedsYouShows } from '../needs-you-setting';
import { useNowForSince } from '../inbox/use-now';
import { useMenuBarSection } from '../keys/menu-bar-bridge';
import { dropKey, dropOver as dropOverValue } from '../session/shell-moves';
import { useAgentTileMenu } from './agent-tile-menu';
import { FrostMark } from './FrostMark';
import { HandPlacedMark } from './HandPlacedMark';
import { menuBarAgentEntries, withoutRename } from './menu-model';
import { frostedClasses } from './paused';
import { useRenameRequest } from './rename';
import { ClickOpensContext, TileActionsContext, type TileData } from './tile';
import { tileTime } from './tile-headline';
import { lastMessageCard, nameClass, stopPropagation, TileButton, TileMenu } from './tile-parts';
import { boardRow, ticketChatEntries, ticketMenuEntries } from './ticket-chat-menu';
import { ticketFace, type HelperIcon, type TicketButton } from './ticket-tile';
import { HELPER_ICONS, TicketViewSwitch, useSwitchTicketView, useTicketView, viewRows } from './ticket-parts';
import { showInTicket } from './ticket-shown';
import { useTileShows } from './view-settings';
import { useFittedLines } from './use-fitted-lines';
import { TicketWatchesMenu, WatchIcons } from './TicketWatches';

type TicketTileProps = { id: string; selected: boolean; chat: Agent; helpers: readonly Agent[] } & Pick<TileData, 'from' | 'implementer'>;

/**
 * A ticket's tile at rest: one chat with its helpers folded inside it, as a card. Its ticket and title, one line of what
 * is true now, its helpers as icons and its pull request on the right, then one state word and at most one button, for
 * the one thing it asks (`ticketFace`). Needs you is the usual tile's look; Ready to merge rings it green; merged, it lies
 * flat and stays until removed. It keeps the agent tile's root and data, so the board finds, drops onto and measures it
 * as it does that one, in Classic and Simplified alike.
 */
export function TicketTile({ id, selected, chat, helpers, from, implementer }: TicketTileProps) {
  const shows = useNeedsYouShows();
  const actions = useContext(TileActionsContext);
  const { expand, openAgent, rename, openPullRequest, resumeAgent, readWatches } = actions;
  const view = useTicketView(id);
  const switchView = useSwitchTicketView(id, chat.sessionId);
  const clickOpens = useContext(ClickOpensContext);
  const dropOver = dropOverValue.use();
  const look = useTileShows();
  const face = ticketFace(chat, helpers, shows, { simplified: useSimplified() });
  // Its title is its ticket's while it has one, which a rename of its chat would not change: no rename is offered then.
  const ownRenaming = useRenaming(chat.name, (name) => rename({ kind: 'agent', sessionId: chat.sessionId }, name));
  const renaming = face.renames ? ownRenaming : NO_RENAME;
  const menu = useAgentTileMenu(id, chat, { from, implementer }, renaming.startSoon);
  const kinds = ticketChatEntries(chat, (kind) => actions.setTicketChat(chat.sessionId, kind));
  const entries = ticketMenuEntries(
    [...viewRows(view, switchView), boardRow(() => actions.openTicketBoard(chat.sessionId))],
    kinds,
    face.renames ? menu.entries : withoutRename(menu.entries),
  );
  useMenuBarSection('agent', selected, menuBarAgentEntries(entries));
  useRenameRequest(id, renaming);
  const nameClicks = useSlowClickRename(renaming, selected);
  const fitted = useFittedLines();
  const now = useNowForSince(face.asker.stateSince);
  const time = face.ask === 'needs-you' ? tileTime(face.asker, 'needs-you', now) : undefined;
  const card = lastMessageCard(chat);
  const drop = dropKey({ kind: 'agent', id: chat.sessionId });
  const team = [chat, ...helpers];
  const prOwner = face.pr === undefined ? undefined : team.find((agent) => agent.pullRequests.includes(face.pr!));
  const openPr = (pr: PullRequest) => prOwner !== undefined && openPullRequest(prOwner, pr);
  const open = () => (clickOpens !== 'expand' ? openAgent(chat) : expand(id));
  // In the board view, a double-click takes the user into the ticket's board; its one button still opens the chat.
  const openOnDoubleClick = () => (view === 'board' ? actions.openTicketBoard(chat.sessionId) : open());
  return (
    <HoverCard label={card?.label ?? 'Last message'} content={card?.text}>
      <div
        className={frostedClasses('hybrid-tile hybrid-tile-agent ticket-tile', chat)}
        data-testid="agent-tile"
        data-ticket-tile=""
        data-representation="hybrid"
        data-harness={chat.harness}
        data-state={chat.state}
        data-ask={face.ask}
        data-flat={face.flat || undefined}
        data-session-id={chat.sessionId}
        data-zone={chat.zoneId ?? ''}
        data-tab-drop={drop}
        data-drop-over={dropOver === drop || undefined}
        data-muted={chat.muted}
        data-corner={look.cornerAlways ? undefined : 'hover'}
        data-seen={(chat.seen && waitsForYou(chat, shows)) || undefined}
        data-needs-you={face.needsYouNow || undefined}
        title={card !== undefined ? undefined : clickOpens !== 'expand' ? 'Double-click to open its session window' : 'Double-click to expand it here'}
        onDoubleClick={openOnDoubleClick}
      >
        <div className="hybrid-tile-head">
          {face.ticketId !== undefined && (
            <span className="ticket-tile-id" data-testid="ticket-id">
              <Ticket aria-hidden />
              {face.ticketId}
            </span>
          )}
          <EditableName className={nameClass(face.title)} value={chat.name} title={face.title} shown={face.title} renaming={renaming} clicks={face.renames ? nameClicks : undefined} label="Agent name" />
          <FrostMark agent={chat} />
          {look.cornerAlways && face.renames && <RenameButton renaming={renaming} />}
          <HandPlacedMark nodeId={id} />
          <span className="hybrid-tile-corner">
            <span className="hybrid-tile-actions">
              {!look.cornerAlways && face.renames && <RenameButton renaming={renaming} />}
              <TicketWatchesMenu chat={chat} name={face.ticketId ?? face.title} />
              <TicketViewSwitch view={view} onSwitch={switchView} />
              <TileButton icon={<Expand />} aria-label="Expand" title="Open it here, with its chat and helpers" onClick={() => expand(id)} />
              <TileMenu entries={entries} onOpen={menu.reread} />
            </span>
          </span>
        </div>
        <span ref={fitted} className="hybrid-tile-body hybrid-tile-now ticket-tile-now" data-testid="tile-description" data-tone={face.ask === 'needs-you' ? 'ask' : face.news ? 'news' : undefined} title={face.line}>
          <span className="hybrid-tile-text">{face.line}</span>
        </span>
        <span className="ticket-tile-mid">
          <span className="ticket-tile-helpers" data-testid="ticket-helpers">
            {/* Who works on it: the chat itself, when it builds, then its helpers. Out of the head, which is the title's. */}
            {chatBuilds(chat) && (
              // Beside its watches, its hammer alone: the row is one line, and a watch is never cut off.
              <span
                className="ticket-tile-builds"
                data-testid="ticket-builds"
                title="This chat builds the ticket: it writes the code"
                {...(face.buildsWord ? {} : { role: 'img', 'aria-label': 'builds', 'data-compact': '' })}
              >
                <Hammer aria-hidden />
                {face.buildsWord && 'builds'}
              </span>
            )}
            {face.helpers.map((helper) => (
              <HelperButton
                key={helper.sessionId}
                helper={helper}
                onShow={() => {
                  showInTicket(id, helper.sessionId);
                  expand(id);
                }}
                onOpenWindow={() => openAgent(helpers.find((each) => each.sessionId === helper.sessionId)!)}
              />
            ))}
          </span>
          <WatchIcons icons={face.watches} />
          {face.pr !== undefined && (
            <Chip
              className="hybrid-tile-pr ticket-tile-watch nodrag"
              data-testid="ticket-pr"
              data-state={face.pr.state}
              title={`#${face.pr.number} ${face.pr.title}: open it`}
              onClick={() => openPr(face.pr!)}
              onDoubleClick={stopPropagation}
            >
              {face.merged ? <GitMerge aria-hidden /> : <GitPullRequest aria-hidden />}#{face.pr.number}
            </Chip>
          )}
        </span>
        <span className="ticket-tile-foot">
          <span className="ticket-tile-state" data-testid="tile-state-word" data-kind={face.wordKind}>
            <span className="ticket-tile-dot" aria-hidden />
            {face.word}
            {time !== undefined && <span className="hybrid-tile-when">· {time}</span>}
          </span>
          {face.button !== undefined && (
            <OneButton
              button={face.button}
              onOpen={() => (face.asker === chat ? open() : openAgent(face.asker))}
              onMerge={() => face.pr !== undefined && openPr(face.pr)}
              onWake={() => resumeAgent(face.asker.sessionId)}
              onRead={() => readWatches(chat.sessionId)}
            />
          )}
        </span>
      </div>
    </HoverCard>
  );
}

/** The renaming of a tile whose name is not its own to change: it never starts. */
const NO_RENAME: Renaming = { editing: false, problem: undefined, start() {}, startSoon() {}, commit() {}, cancel() {} };

/** A helper as an icon: a click opens the tile with the helper shown in place of the chat; ⌥-click opens its own window. */
function HelperButton({ helper, onShow, onOpenWindow }: { helper: HelperIcon; onShow(): void; onOpenWindow(): void }) {
  const click = (event: MouseEvent) => (event.altKey ? onOpenWindow() : onShow());
  return (
    <button
      type="button"
      className="ticket-tile-helper nodrag"
      data-testid="ticket-helper"
      data-kind={helper.kind}
      data-state={helper.state}
      title={`${helper.title}. Click to show it here; ⌥-click to open its window`}
      aria-label={helper.title}
      onClick={click}
      onDoubleClick={stopPropagation}
    >
      {HELPER_ICONS[helper.kind]}
      {helper.state === 'done' && (
        <span className="ticket-tile-tick" aria-hidden>
          <Check />
        </span>
      )}
    </button>
  );
}

/** Its one button, at rest and opened. Merge opens the pull request, where the merge stays the user's click: the ticket never merges itself. */
export function OneButton({ button, onOpen, onMerge, onWake, onRead }: { button: TicketButton; onOpen(): void; onMerge(): void; onWake(): Promise<void>; onRead(): void }) {
  const [pending, setPending] = useState(false);
  const press = () => {
    if (button.kind === 'open') return onOpen();
    if (button.kind === 'merge') return onMerge();
    if (button.kind === 'read') return onRead();
    setPending(true);
    void onWake().finally(() => setPending(false));
  };
  return (
    <Button
      size="xs"
      variant={button.prominent ? 'primary' : 'secondary'}
      icon={button.kind === 'merge' ? <GitMerge /> : button.kind === 'wake' ? <Play /> : undefined}
      className="hybrid-tile-act ticket-tile-act nodrag"
      data-testid="tile-act"
      data-kind={button.kind}
      data-prominent={button.prominent || undefined}
      title={button.kind === 'merge' ? 'Open its pull request, to merge it there' : button.kind === 'read' ? 'Mark its watches’ news read' : undefined}
      disabled={pending}
      onClick={press}
      onDoubleClick={stopPropagation}
    >
      {button.label}
    </Button>
  );
}
