import { useContext, useEffect, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { Expand, SquareArrowOutUpRight } from 'lucide-react';
import { useReviewTabAsked } from '../../review/review-tab';
import { showsShelves } from '../../session/agent-sidebar';
import { SessionBody, type PaneRow, type WindowContent } from '../../session/SessionBody';
import type { AttachState } from '../../session/TerminalPane';
import { adoptChatView, popUpViewKey, useSessionView } from '../../session/session-view';
import { useSidebarCollapsed } from '../../session/use-sidebar-collapsed';
import { useSimplified } from '../../design';
import { useNeedsYouShows } from '../../needs-you-setting';
import { IconButton, type MenuEntry } from '../../ui';
import { REVIEW_TAB, viewsOpenAtFirst } from '../agent-popup';
import { soloRow } from '../popup-tab-row';
import { TicketBoard } from '../TicketBoard';
import { BackToTileButton } from '../BackToTile';
import { ticketFace } from '../ticket-tile';
import { TileActionsContext } from '../tile';
import { PopupViewSwitch, SplitButton, PopupPlus, AgentViewHeader } from './AgentViewHeader';
import { PopupPanes } from './AgentViewPanes';
import { PANEL_ID, AgentViewTabs } from './AgentViewTabs';
import { type PopUpMenuHooks, AgentViewMenu, TicketMoreMenu } from './AgentViewMenu';
import { usePaneTabs, type PopUpSplitting, usePopUpSplit, useViewKit, usePopUpRow } from './use-agent-view-row';
import { NowAction } from './NowAction';

/** Where an open agent is drawn when not in its pop-up over the board: an OS window of its own (popped out), or its expanded tile. */
export interface AgentViewFrame {
  /** Its header's own buttons in place of Expand, Pop out and back to its tile: Back to board, say. */
  buttons: ReactNode;
  /** Rows its ⋯ adds at its end: Close window. */
  menuEnd: MenuEntry[];
  /** The rows of the agent's menu (by id) left out there: a window of its own is out of the board already. */
  drops: readonly string[];
  /** A line over its terminal: why it isn't asking yet, say. */
  notice: ReactNode;
  /** Hears how its terminal is attached. */
  onAttachState(state: AttachState): void;
  /** Drawn as its expanded tile on the board rather than a window: tile-sized, with no split. */
  tile?: AgentViewTile | undefined;
}

/**
 * A pop-up drawn as an agent's expanded tile: the pop-up's own header, tab row and body, in a node of the board. Its
 * header drags the tile, not a window.
 */
export interface AgentViewTile {
  /** Its tile's node, whose rename asks open the header's name field. */
  nodeId: string;
  /** What its header and body add to the pop-up's classes: the board drags the tile by its header. */
  headClassName: string;
  bodyClassName: string;
  /** The header's focus, which ⌘J gives it with the extended keys on. */
  headTabIndex: number | undefined;
  onHeadDoubleClick(event: MouseEvent): void;
  /** In place of the pop-up's status: a paused agent's frost mark, and its frozen chip. */
  status: ReactNode;
  /** Whether it is too narrow for the shelves beside a terminal: they open on the rail, for it alone. */
  narrow(): boolean;
  /** In place of its session, when it shows none: a capture window's stand-in. */
  standIn?: ReactNode;
  /** Its window buttons (Pin, ⤢, Pop out), before ⋯ as the pop-up's Expand and Pop out are, so ⋯ stays by its closing button. */
  lead?: ReactNode;
}

/** What an open agent's view is given: the agent (a ticket's chat with its helpers), and where it sits. */
export interface AgentViewProps {
  /** The agent open, or a ticket's chat when `helpers` is given. */
  agent: Agent;
  /** A ticket's helpers, each a tab after its chat's (`popUpHelpers`); undefined for an agent that is no ticket. */
  helpers?: readonly Agent[] | undefined;
  /** The helper's tab a ticket opens on, as Answer does; else it opens on its chat. */
  on?: string | undefined;
  /** A ticket's helpers popped out into a window of their own: a click on one's tab brings its window forward. */
  popped?: readonly string[] | undefined;
  /** What a ticket's Board tab draws its board from; without it the Board tab shows the chat. */
  board?: PopUpBoard | undefined;
  nodeId: string;
  /** Leaves it as its frame leaves: back to its tile, collapsed, or its window closed. */
  onClose(): void;
  root: RefObject<HTMLElement | null>;
  splitting: PopUpSplitting;
  /** Where it is drawn, when not in its pop-up over the board: a window of its own, or its expanded tile. */
  frame?: AgentViewFrame | undefined;
}

/** A ticket's row, which always shows, its own tab named for its agent. */
const TICKET_ROW: ReturnType<typeof soloRow> = { shows: true, ownLabel: undefined };

/**
 * An open agent, wherever it is drawn: its header, its row of tabs and its body. One agent alone has the one Chat |
 * Terminal switch, then its terminal or chat with its sidebar, the views it has listed first there, and no row of tabs
 * until a second tab opens (a view, a shell): its own tab is then named for the view it shows, and the row goes once
 * the last other tab closes. A ticket (`helpers`) has its id and title in the header, with Merge once it is ready, and
 * always its row: its Board, its chat and each helper, in the order they were dragged into. The tab the user came from
 * is underlined, and ⌘[ goes back to it; ⌃Tab and ⌃⇧Tab step along the row, ⌘1–⌘9 pick a place in it; ⌥-click on a
 * tab opens that agent in its own window. No row of controls anywhere: they are in the header's ⋯ (a ticket's has the
 * ticket's own rows first: its pull request with its checks, Watches…, its board) and in the row's +. In a `frame`,
 * a window of its own or its expanded tile, the same, with the frame's own buttons in its header.
 */
export function AgentView({ agent: own, helpers, on, popped = [], board, nodeId, onClose, root, splitting, frame }: AgentViewProps) {
  const { expand, popOutAgent, openAgent, openPullRequest } = useContext(TileActionsContext);
  const shows = useNeedsYouShows();
  const simplified = useSimplified();
  const team = helpers ?? [];
  // A ticket's face, from its chat and helpers; undefined for one agent alone, which has none of a ticket's.
  const ticket = helpers === undefined ? undefined : ticketFace(own, helpers, shows, { simplified });
  const isTicket = ticket !== undefined;
  const tile = frame?.tile;
  const panelId = tile === undefined ? PANEL_ID : `${PANEL_ID}-${tile.nodeId}`;
  const [asked, setAsked] = useState<string>();
  const kit = useViewKit(
    [own, ...team],
    own,
    asked,
    // One agent alone has no Board, though the board gives its pop-up the board's agents as it gives a ticket's.
    isTicket && board !== undefined
      ? (onOpenAgent) => (
          <TicketBoard chatId={own.sessionId} agents={board.agents} desk={board.desk} onError={board.onError} onLeave={() => row.back()} onOpenAgent={onOpenAgent} inPopUp />
        )
      : undefined,
  );
  // A ticket's overview, the Board, is open as it opens.
  const [openAtFirst] = useState(() => (isTicket ? viewsOpenAtFirst(kit.views) : []));
  const row = usePopUpRow({ own, helpers: team, views: kit.views, popped: isTicket ? popped : [], on: isTicket ? on : undefined, openAtFirst, ticket: isTicket, onPopped: openAgent, root });
  useReviewTabAsked(
    [own, ...team].map((agent) => agent.sessionId),
    (id) => {
      setAsked(id);
      row.openReview();
    },
  );
  const { shown, order } = row;
  const content: WindowContent = { kind: 'session', sessionId: shown.sessionId, agent: shown };
  const shelves = showsShelves(content);
  const [detailsCollapsed, setDetailsCollapsed] = useSidebarCollapsed(shelves, root, tile?.narrow ?? (() => false));
  const viewKey = popUpViewKey(own, isTicket);
  // A ticket's chat's own pick moves into the ticket's the first time its pop-up opens; after that it is the pop-up's.
  useEffect(() => {
    if (isTicket) adoptChatView(viewKey);
  }, [isTicket, viewKey]);
  const [picked] = useSessionView(viewKey);
  const [paneRow, setPaneRow] = useState<PaneRow>();
  const tabs = usePaneTabs(row, paneRow);
  const split = usePopUpSplit(splitting, row, tabs, isTicket ? popped : (splitting.popped ?? []));
  const rowTabs = [...row.row, ...split.extra];
  const solo = isTicket ? TICKET_ROW : soloRow([...rowTabs, ...(paneRow?.tabs ?? []).map((tab) => ({ key: tab.id, kind: 'shell' as const }))], picked === 'terminal' ? 'terminal' : 'chat');
  // Rename from ⋯ opens the header's name field, the one name one agent alone shows.
  const [renameAsk, setRenameAsk] = useState(0);
  // Any other (the one beside, a ticket's) is renamed in place on its tab.
  const [renamingTab, setRenamingTab] = useState<string>();
  const menuOf = (of: Agent): PopUpMenuHooks =>
    split.menuOf(of, { rename: !isTicket && of.sessionId === own.sessionId ? () => setRenameAsk((n) => n + 1) : () => setRenamingTab(of.sessionId), openBeside: undefined, drops: frame?.drops });
  const instead = (then: () => void) => () => {
    onClose();
    then();
  };
  const pr = ticket?.pr;
  const prOwner = pr === undefined ? undefined : [own, ...team].find((agent) => agent.pullRequests.includes(pr));
  const merge = ticket?.button?.kind === 'merge' && pr !== undefined && prOwner !== undefined ? () => openPullRequest(prOwner, pr) : undefined;
  return (
    <>
      <AgentViewHeader agent={own} ticket={ticket && { id: ticket.ticketId, title: ticket.title }} renameAsk={renameAsk} dragsWindow={frame !== undefined && tile === undefined} tile={tile}>
        <PopupViewSwitch viewKey={viewKey} agentOn={tabs.agentOn || split.live !== undefined} />
        <SplitButton split={split.live} beside={split.beside} onEnd={split.end} />
        {/* With no row yet, its + sits in the header: the way to a first shell or view. */}
        {!solo.shows && <PopupPlus paneRow={paneRow} views={kit.views} open={row.open} beside={split.beside} onSelect={split.select} />}
        <NowAction agent={shown} placement={frame === undefined || tile !== undefined ? 'board' : 'own-window'} onMerge={merge} />
        {frame === undefined && (
          <>
            <IconButton icon={<Expand />} size="sm" aria-label="Expand" tooltip="Expand it here, on its terminal" onClick={instead(() => expand(nodeId))} />
            <IconButton
              icon={<SquareArrowOutUpRight />}
              size="sm"
              aria-label="Pop out"
              tooltip={isTicket ? `Pop out ${shown.name} to its own window` : 'Pop out to its own window'}
              onClick={instead(() => popOutAgent(shown))}
            />
          </>
        )}
        {tile?.lead}
        {!isTicket ? (
          <AgentViewMenu agent={own} nodeId={nodeId} menu={menuOf(own)} end={frame?.menuEnd} />
        ) : (
          <TicketMoreMenu chat={own} helpers={team} nodeId={nodeId} name={ticket.ticketId ?? ticket.title} drops={frame?.drops} end={frame?.menuEnd} />
        )}
        {frame === undefined ? <BackToTileButton from={root} leave={onClose} label="Back to its tile" tooltip="Back to its tile; it keeps running" /> : frame.buttons}
      </AgentViewHeader>
      {solo.shows && (
        <AgentViewTabs
          row={rowTabs}
          shells={paneRow?.tabs ?? []}
          active={split.active}
          from={row.from}
          nodeId={nodeId}
          views={kit.views}
          open={row.open}
          panelId={panelId}
          dragShells={tile !== undefined}
          ownLabel={split.live === undefined ? solo.ownLabel : undefined}
          paneRow={paneRow}
          menuOf={menuOf}
          sides={split.sides}
          beside={split.beside}
          label={isTicket ? "The ticket's views, chat, helpers and shells" : 'Its terminal, shells and views'}
          onSelect={split.select}
          onClose={tabs.close}
          onMove={split.move(row.move)}
          onDragKey={split.dragging}
          renaming={renamingTab}
          onRenamed={() => setRenamingTab(undefined)}
          onOpenWindow={(other) => instead(() => openAgent(other))()}
        />
      )}
      <PopupPanes className={tile === undefined ? 'agent-popup-body' : `agent-popup-body ${tile.bodyClassName}`} id={panelId} role={solo.shows ? 'tabpanel' : undefined} split={split} viewKey={viewKey}>
        {tile?.standIn ?? (
          <SessionBody
            key={shown.sessionId}
            content={content}
            detailsCollapsed={detailsCollapsed}
            onDetailsCollapsed={setDetailsCollapsed}
            shelves={shelves}
            // On the board, a tile takes the keys only once clicked.
            autoFocus={tile === undefined}
            // Straight under the header or the row: no strip of its own over it, unless something is amiss; its shell
            // tabs in the row, the one view switch in the header, its chat's controls at the chat's top.
            chatControlsSlot={null}
            ownStrip={false}
            viewKey={viewKey}
            onRow={setPaneRow}
            views={row.shelfViews}
            notice={frame?.notice}
            onAttachState={frame?.onAttachState}
            cover={
              row.view === undefined
                ? undefined
                : kit.render(row.view, {
                    onDismissed: () => {
                      setAsked(undefined);
                      row.close(REVIEW_TAB);
                    },
                    // A member of the ticket's row opens on its tab; anything else in its own window.
                    onOpenAgent: (agent) => (order.includes(agent.sessionId) ? tabs.select(agent.sessionId) : openAgent(agent)),
                  })
            }
          />
        )}
      </PopupPanes>
    </>
  );
}

/** What a ticket's pop-up needs from the board to draw its Board tab: the ticket's board as the board itself has it. */
export interface PopUpBoard {
  agents: readonly Agent[];
  /** The board's dots, as the main board draws them. */
  desk: { gap: number; size: number };
  onError(action: string): (error: unknown) => void;
}
