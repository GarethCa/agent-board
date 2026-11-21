import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { HUMAN_STATUS_LABELS, humanStatus } from '@agent-board/daemon/human-status';
import { lookShown } from '@agent-board/daemon/character';
import { Activity as ActivityIcon, ChevronDown, Columns2, Expand, FileCheck, GitMerge, LayoutDashboard, MessageSquare, MoreHorizontal, Plus, SquareArrowOutUpRight, SquareTerminal, Ticket, UnfoldHorizontal } from 'lucide-react';
import { OWN_SURFACE } from '@agent-board/daemon/window-layout';
import { VIEW_KEYS } from '../../../shared/view-saver';
import { useEscStep } from '../keys/esc-ladder';
import { leaveToTile, useLeaveKeys } from '../keys/escape-hatch';
import { keyText, pressed } from '../keys/registry';
import { isTyping } from '../keys/typing';
import { useGateRuns } from '../gate/GatesProvider';
import { useReviews } from '../review/ReviewsProvider';
import { roundsOf, showsReviewTab } from '../review/reviews';
import { ReviewViewer } from '../review/ReviewViewer';
import { ActivityLog, useActivity } from '../orchestrators/ActivityLog';
import type { ShelfViews } from '../session/AgentShelves';
import { showsShelves } from '../session/agent-sidebar';
import { SessionBody, type PaneRow, type WindowContent } from '../session/SessionBody';
import { adoptChatView, popUpViewKey, useSessionView, type SessionView } from '../session/session-view';
import { SessionName } from '../session/SessionName';
import { ROW_TAB_TYPE, TabStrip, useAddEntries, type StripTab, type TabAdds } from '../session/TabStrip';
import { Dividers, useDividerDrag } from '../session/use-divider-drag';
import type { SplitTree } from '@agent-board/daemon/pane-layout';
import { StateAction } from '../session/SimplifiedHeader';
import { useSidebarCollapsed } from '../session/use-sidebar-collapsed';
import { useSimplified } from '../design';
import { useNeedsYouShows } from '../needs-you-setting';
import { agentPill } from '../states';
import { Button, ContextMenu, EditableName, IconButton, Kbd, Menu, Segmented, StatusPill, useRenaming, type MenuEntry, type SegmentedOption } from '../ui';
import { tabAtDigit } from '../session/tabs';
import { ACTIVITY_TAB, BOARD_TAB, escClosesFromBehind, isViewKey, popUpRow, popUpRowOwner, popUpTabOn, popUpTabShown, popUpViews, REVIEW_TAB, viewsOpenAtFirst, type PopUpRowTab, type PopUpView } from './agent-popup';
import { afterClose, closedView, foldRow, keptOrders, movedTab, openedView, popUpRowKey, rowOrder, soloRow, steppedTab, viewRow, withKeptOrder, type KeptOrders, type RowKey } from './popup-tab-row';
import { TicketBoard } from './TicketBoard';
import { BackToTileButton } from './BackToTile';
import { setPopupFill, usePopupFill } from './popup-fill';
import { usePopupFrost } from './popup-frost';
import { capBites, dragPopup, POPUP_CAP, POPUP_EDGES, popupRoom, popupSize, readPopupSize, writePopupSize, type PopupEdge, type Size } from './popup-size';
import { atRightEdge, besideCandidates, canDropInSplit, dropAtEdge, dropInSplit, openSplit, selectInSplit, tabOnInSplit, type PopupSplit, type SplitSide } from './popup-split';
import { useCharacterStyle } from './characters';
import { useNowForSince } from '../inbox/use-now';
import { useBoardCommands } from './commands';
import { HarnessMark } from './HarnessMark';
import { agentMenu, popUpAgentMenu, pullRequestEntries, type BesideChoice, type ModelEntry } from './menu-model';
import { nameTarget } from './rename';
import { StatusMark } from './StatusMark';
import { ticketFace } from './ticket-tile';
import { poseOfPill } from './tile-pose';
import { sinceLabel } from './tile-shows';
import { TileCharacter } from './TileCharacter';
import { useTicketChatMenu } from './use-ticket-chat-menu';
import { ClickOpensContext, TileActionsContext } from './tile';

/**
 * The agent menu's rows its pop-up has of its own: Open is the pop-up itself, Expand and Pop out are in its header, and
 * its name renames on a double-click or its pencil.
 */
const POPUP_OWN = new Set(['open', 'expand', 'pop-out', 'rename']);

/**
 * An agent's pop-up: its session over the dimmed board, which stays where it was under it, opened by a double-click on
 * its tile or ⋯ → Open. Inside the board's window, so nothing takes the focus from the app. Three parts, each its own
 * slot: the header (mark, name and status, then the one action for what it is doing now, Expand, Pop out, More and –
 * back to the tile) and the body (its session, as its window shows it), with no row of controls at its foot: its pull
 * requests and their checks are in More. It takes the keys as it opens, so the board's behind it act on nothing unseen.
 * –, Esc, or a click on the dimmed board closes it, the tile selected.
 */
export function AgentPopup({
  agent,
  helpers,
  on,
  popped = [],
  nodeId,
  onClose,
  board: ticketBoard,
}: {
  agent: Agent;
  /** A ticket's helpers, each a tab after its chat's (`popUpHelpers`); undefined for an agent that is no ticket. */
  helpers?: readonly Agent[] | undefined;
  /** The helper's tab it opens on, as Answer does; else it opens on its chat. */
  on?: string | undefined;
  /** The helpers popped out into a window of their own: a click on one's tab brings its window forward. */
  popped?: readonly string[] | undefined;
  nodeId: string;
  onClose(): void;
  /** What a ticket's Board tab draws its board from; without it the Board tab shows the chat. */
  board?: PopUpBoard | undefined;
}) {
  const root = useRef<HTMLElement>(null);
  const board = useBoardCommands();
  const leave = () => leaveToTile(root.current, onClose, board.selectNode);
  // Esc from its header, or ⌘Esc from anywhere in it, as a session window's; its terminal keeps its own Esc.
  useLeaveKeys(root, onClose, board.selectNode);
  // The keys are its own once it is up (its session takes them as a window's does, else the pop-up itself).
  useEffect(() => {
    const surface = root.current;
    if (surface && !surface.contains(document.activeElement)) surface.focus();
  }, []);
  // Esc with the focus behind it, on the board: the pop-up is in front of all of it.
  useEscStep(
    'surface',
    (event) => escClosesFromBehind({ escape: pressed('window.escape', event), typing: isTyping(event), inPopUp: event.target instanceof Node && root.current?.contains(event.target) === true }),
    leave,
  );
  // Only a click that starts on the dimmed board closes it: a selection dragged out of its terminal ends there too.
  const pressedOnScrim = useRef(false);
  const onScrimDown = (event: PointerEvent) => {
    pressedOnScrim.current = event.target === event.currentTarget;
  };
  const onScrim = (event: MouseEvent) => {
    if (event.target === event.currentTarget && pressedOnScrim.current) leave();
    pressedOnScrim.current = false;
  };
  const scrim = useRef<HTMLDivElement>(null);
  // Two agents side by side, grown to the board's edges; kept only while it is open.
  const [split, setSplit] = useState<PopupSplit>();
  const { style, edges, wide } = usePopupSize(scrim, split !== undefined);
  const splitting: PopUpSplitting = { split, onSplit: setSplit, agents: ticketBoard?.agents ?? [] };
  const frost = usePopupFrost();
  return (
    <div ref={scrim} className="agent-popup-scrim" data-testid="agent-popup-scrim" data-frost={frost || undefined} onPointerDown={onScrimDown} onClick={onScrim}>
      <div className="agent-popup-frame" style={style}>
        {/* nokey: the board's own keys (Delete, the arrows) leave the tiles behind it be. */}
        <section
          ref={root}
          className="agent-popup nokey"
          data-testid="agent-popup"
          data-session-id={agent.sessionId}
          role="dialog"
          aria-modal="true"
          aria-label={`${agent.name}, pop-up`}
          tabIndex={-1}
          data-ticket={helpers !== undefined || undefined}
          data-split={split !== undefined || undefined}
        >
          <PopupWideContext.Provider value={wide}>
            {helpers === undefined ? (
              <PopupBody agent={agent} nodeId={nodeId} onClose={onClose} root={root} splitting={splitting} />
            ) : (
              <TicketPopupBody chat={agent} helpers={helpers} on={on} popped={popped} nodeId={nodeId} onClose={onClose} root={root} board={ticketBoard} splitting={splitting} />
            )}
          </PopupWideContext.Provider>
        </section>
        {/* Split, it has all the board: nothing to drag. */}
        {split === undefined && edges}
      </div>
    </div>
  );
}

/** How far, in px, a press on an edge moves before it is a drag: a click with a trackpad's jitter keeps no size. */
const DRAG_SLOP = 3;

/**
 * The pop-up's size on the board under `scrim`: the 16:10 fit, or the size dragged to from its edges and corners, which
 * every pop-up keeps through restarts. A double-click on an edge gives the fit back. It stays centred as it is dragged.
 * Split, it grows to the board's edges, and has its size back as the split ends. On a wide screen (`wide`) it stops at
 * the cap's width, centred, unless set to fill it.
 */
function usePopupSize(scrim: RefObject<HTMLElement | null>, split: boolean): { style: CSSProperties | undefined; edges: ReactNode; wide: boolean } {
  const fill = usePopupFill();
  const [room, setRoom] = useState<Size | null>(null);
  const [saved, setSaved] = useState(readPopupSize);
  const drag = useRef<{ edge: PopupEdge; x: number; y: number; start: Size; room: Size; moved: boolean; last: Size } | null>(null);
  // The room it has: the board less the scrim's padding, its margin. Before it is painted, and again whenever the
  // board's window is resized.
  useLayoutEffect(() => {
    const element = scrim.current;
    if (!element) return;
    const measure = () => {
      const pad = getComputedStyle(element);
      const across = Number.parseFloat(pad.paddingLeft) + Number.parseFloat(pad.paddingRight);
      const down = Number.parseFloat(pad.paddingTop) + Number.parseFloat(pad.paddingBottom);
      setRoom({ width: element.clientWidth - across, height: element.clientHeight - down });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrim]);
  const size = room === null ? null : popupSize(room, saved, { split, fill });
  const dragged = (event: PointerEvent, held: NonNullable<typeof drag.current>) => dragPopup(held.start, held.edge, event.clientX - held.x, event.clientY - held.y, held.room);
  const onDown = (edge: PopupEdge) => (event: PointerEvent<HTMLElement>) => {
    if (size === null || room === null || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { edge, x: event.clientX, y: event.clientY, start: size, room: popupRoom(room, fill), moved: false, last: size };
  };
  const onMove = (event: PointerEvent<HTMLElement>) => {
    const held = drag.current;
    if (held === null) return;
    held.moved ||= Math.abs(event.clientX - held.x) > DRAG_SLOP || Math.abs(event.clientY - held.y) > DRAG_SLOP;
    if (!held.moved) return;
    held.last = dragged(event, held);
    setSaved(held.last);
  };
  const onUp = (event: PointerEvent<HTMLElement>) => {
    const held = drag.current;
    if (held === null) return;
    drag.current = null;
    // A click, or the first of a double-click, keeps no size.
    if (held.moved) writePopupSize(dragged(event, held));
  };
  // A drag the system takes away keeps the size it reached, as a pointer-up there would.
  const onCancel = () => {
    const held = drag.current;
    drag.current = null;
    if (held?.moved) writePopupSize(held.last);
  };
  const onReset = () => {
    setSaved(null);
    writePopupSize(null);
  };
  const edges = POPUP_EDGES.map((edge) => (
    <div
      key={edge}
      className="agent-popup-edge"
      data-edge={edge}
      data-testid={`agent-popup-edge-${edge}`}
      aria-hidden
      title="Drag to resize · double-click to fit"
      onPointerDown={onDown(edge)}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
      onDoubleClick={onReset}
    />
  ));
  return { style: size === null ? undefined : { width: size.width, height: size.height }, edges, wide: room !== null && capBites(room) };
}

/**
 * A lone agent's pop-up: its header, with the one Chat | Terminal switch, then its terminal or chat with its sidebar, the
 * views it has listed first there. It has no row of tabs until a second tab opens (a view, a shell); its own tab is then
 * named for the view it shows, and the row goes once the last other tab closes. No row of controls anywhere: they are in
 * its header's ⋯, which is the same menu as an agent tab's ⋯ and a right-click on its tab, and in the row's +.
 */
function PopupBody({ agent, nodeId, onClose, root, splitting }: { agent: Agent; nodeId: string; onClose(): void; root: RefObject<HTMLElement | null>; splitting: PopUpSplitting }) {
  const { expand, popOutAgent, openAgent } = useContext(TileActionsContext);
  const content: WindowContent = { kind: 'session', sessionId: agent.sessionId, agent };
  const shelves = showsShelves(content);
  const [detailsCollapsed, setDetailsCollapsed] = useSidebarCollapsed(shelves, root, () => false);
  const kit = useViewKit([agent], agent);
  const row = usePopUpRow({ own: agent, helpers: [], views: kit.views, popped: [], on: undefined, openAtFirst: [], ticket: false, onPopped: openAgent, root });
  const viewKey = popUpViewKey(agent, false);
  const [picked] = useSessionView(viewKey);
  const [paneRow, setPaneRow] = useState<PaneRow>();
  const tabs = usePaneTabs(row, paneRow);
  const split = usePopUpSplit(splitting, row, tabs, []);
  const rowTabs = [...row.row, ...split.extra];
  const solo = soloRow([...rowTabs, ...(paneRow?.tabs ?? []).map((tab) => ({ key: tab.id, kind: 'shell' as const }))], picked === 'terminal' ? 'terminal' : 'chat');
  // Rename from ⋯ opens the header's name field, the one name it shows.
  const [renameAsk, setRenameAsk] = useState(0);
  // Another's (the one beside) is renamed in place on its tab.
  const [renamingTab, setRenamingTab] = useState<string>();
  const menuOf = (of: Agent) => split.menuOf(of, { rename: of.sessionId === agent.sessionId ? () => setRenameAsk((n) => n + 1) : () => setRenamingTab(of.sessionId), openBeside: undefined });
  const menu = menuOf(agent);
  const instead = (then: () => void) => () => {
    onClose();
    then();
  };
  return (
    <>
      <PopupHeader agent={agent} renameAsk={renameAsk}>
        <PopupViewSwitch viewKey={viewKey} agentOn={tabs.agentOn || split.live !== undefined} />
        <SplitButton split={split.live} beside={split.beside} onEnd={split.end} />
        {/* With no row yet, its + sits in the header: the way to a first shell or view. */}
        {!solo.shows && <PopupPlus paneRow={paneRow} views={kit.views} open={row.open} beside={split.beside} onSelect={split.select} />}
        <StateAction agent={agent} placement="board" />
        <IconButton icon={<Expand />} size="sm" aria-label="Expand" tooltip="Expand it here, on its terminal" onClick={instead(() => expand(nodeId))} />
        <IconButton icon={<SquareArrowOutUpRight />} size="sm" aria-label="Pop out" tooltip="Pop out to its own window" onClick={instead(() => popOutAgent(agent))} />
        <MoreMenu agent={agent} nodeId={nodeId} menu={menu} />
        <BackToTileButton from={root} leave={onClose} label="Back to its tile" tooltip="Back to its tile; it keeps running" />
      </PopupHeader>
      {solo.shows && (
        <PopupTabs
          row={rowTabs}
          shells={paneRow?.tabs ?? []}
          active={split.active}
          from={row.from}
          nodeId={nodeId}
          views={kit.views}
          open={row.open}
          ownLabel={split.live === undefined ? solo.ownLabel : undefined}
          paneRow={paneRow}
          menuOf={menuOf}
          sides={split.sides}
          beside={split.beside}
          label="Its terminal, shells and views"
          onSelect={split.select}
          onClose={tabs.close}
          onMove={split.move(row.move)}
          onDragKey={split.dragging}
          renaming={renamingTab}
          onRenamed={() => setRenamingTab(undefined)}
          onOpenWindow={(other) => instead(() => openAgent(other))()}
        />
      )}
      <PopupPanes className="agent-popup-body" id={PANEL_ID} role={solo.shows ? 'tabpanel' : undefined} split={split} viewKey={viewKey}>
        <SessionBody
          content={content}
          detailsCollapsed={detailsCollapsed}
          onDetailsCollapsed={setDetailsCollapsed}
          shelves={shelves}
          // Its chat's controls sit at the chat's top: the header has none of them.
          chatControlsSlot={null}
          ownStrip={false}
          viewKey={viewKey}
          onRow={setPaneRow}
          views={row.shelfViews}
          cover={row.view === undefined ? undefined : kit.render(row.view, { onDismissed: () => row.close(REVIEW_TAB) })}
        />
      </PopupPanes>
    </>
  );
}

/** The pop-up's switch's two views, the chat first. */
const POP_UP_VIEWS: SegmentedOption<SessionView>[] = [
  { id: 'chat', label: 'Chat', icon: <MessageSquare /> },
  { id: 'terminal', label: 'Terminal', icon: <SquareTerminal /> },
];

/**
 * The header's one Chat | Terminal switch, for every agent in the pop-up (a shell ignores it), kept for the pop-up the
 * next time it opens. Dimmed while a view or a shell tab is on, which it doesn't change.
 */
export function PopupViewSwitch({ viewKey, agentOn }: { viewKey: string; agentOn: boolean }) {
  const [view, pick] = useSessionView(viewKey);
  return (
    <span className="agent-popup-switch-group">
      <span className="agent-popup-switch" data-testid="agent-popup-switch" data-dimmed={!agentOn || undefined} title={agentOn ? 'Every agent in this pop-up' : 'Applies when an agent tab is on'}>
        <Segmented<SessionView> aria-label="View of every agent in this pop-up" value={view} onChange={pick} options={POP_UP_VIEWS} />
      </span>
      <FillButton />
    </span>
  );
}

/** Whether the board is wide enough for the cap to bite, and so for the fill button to show. */
const PopupWideContext = createContext(false);

/**
 * The header's fill button, beside the Chat | Terminal switch, on a wide screen only: pressed, every pop-up fills the
 * board; not, it stops at the cap's width. It flips the Settings option, so the next pop-up opens the same way.
 */
function FillButton() {
  const wide = useContext(PopupWideContext);
  const fill = usePopupFill();
  if (!wide) return null;
  return (
    <IconButton
      className="agent-popup-fill"
      data-testid="agent-popup-fill"
      icon={<UnfoldHorizontal />}
      size="sm"
      aria-label="Fill the screen"
      aria-pressed={fill}
      tooltip={fill ? `Back to ${POPUP_CAP} px wide` : 'Fill the screen'}
      onClick={() => setPopupFill(!fill)}
    />
  );
}

/**
 * A pop-up's row as its tabs act on it: the agents' and views' tabs from `row`, the shown agent's shell tabs from its
 * body. A shell tab on covers the agent's own pane; a view on covers both. Picking an agent brings its own pane forward.
 */
function usePaneTabs(row: ReturnType<typeof usePopUpRow>, paneRow: PaneRow | undefined) {
  const shell = row.view === undefined ? paneRow?.active : undefined;
  const isShell = (key: string) => paneRow?.tabs.some((tab) => tab.id === key) === true;
  const select = (key: string) => {
    if (isShell(key)) {
      // Off a view, back to the agent the shell is of, and on to its shell.
      if (row.view !== undefined) row.pick(row.shown.sessionId);
      paneRow?.select(key);
      return;
    }
    // Its own tab again brings its own pane forward; another agent's leaves this one's layout as it was.
    if (key === row.shown.sessionId && row.view === undefined) paneRow?.select(OWN_SURFACE);
    row.pick(key);
  };
  const close = (key: string) => (isShell(key) ? paneRow?.close(key) : row.close(key));
  return { active: row.view ?? shell ?? row.active, agentOn: row.view === undefined && shell === undefined, select, close };
}

/** What the row's keys step along and pick with: the row's own, or a split's while it is open. */
interface RowKeysTarget {
  order: readonly string[];
  active: string;
  pick(key: string): void;
}

/** What a pop-up's body splits by: the split, kept by the pop-up (it sizes the window), and the board's agents. */
interface PopUpSplitting {
  split: PopupSplit | undefined;
  onSplit(split: PopupSplit | undefined): void;
  /** Every agent on the board: Open beside… offers the zone's. */
  agents: readonly Agent[];
}

/** The split as a body acts on it (`usePopUpSplit`). */
type PopUpSplitControl = ReturnType<typeof usePopUpSplit>;

/**
 * A body's split: the row's own agent on the left, the one picked beside it on the right, each tab picking into the
 * pane with the focus. An agent from outside the row gets a tab of its own while it is beside. The one beside going (it
 * ended, or popped out) ends the split.
 */
function usePopUpSplit({ split, onSplit, agents }: PopUpSplitting, row: ReturnType<typeof usePopUpRow>, tabs: ReturnType<typeof usePaneTabs>, popped: readonly string[]) {
  const rowAgents = row.row.flatMap((each) => (each.agent === undefined ? [] : [each.agent]));
  const members = new Set(rowAgents.map((agent) => agent.sessionId));
  const left = row.shown.sessionId;
  const right = split === undefined ? undefined : (rowAgents.find((agent) => agent.sessionId === split.right) ?? agents.find((agent) => agent.sessionId === split.right && agent.endedAt === null));
  const live = right === undefined || right.sessionId === left || popped.includes(right.sessionId) ? undefined : split;
  useEffect(() => {
    if (split !== undefined && live === undefined) onSplit(undefined);
  });
  const beside: BesideChoice[] =
    live !== undefined
      ? []
      : besideCandidates({ shown: row.shown, row: rowAgents, agents, popped }).map((agent) => ({ id: agent.sessionId, label: agent.name, onSelect: () => onSplit(openSplit(left, agent.sessionId)) }));
  const isAgent = (key: string) => members.has(key) || key === live?.right;
  // The row's own pane showing `key`, as a click on its tab would, the focus on it.
  const showLeft = (key: string) => tabs.select(key);
  const select = (key: string) => {
    if (live === undefined) return tabs.select(key);
    const step = selectInSplit(live, left, key, members, isAgent(key));
    onSplit(step.split);
    if (step.split?.focused === 'left') showLeft(step.left ?? key);
  };
  const active = live === undefined ? tabs.active : tabOnInSplit(live, tabs.active);
  const extraKeys = live !== undefined && !members.has(live.right) ? [live.right] : [];
  const { keysRef } = row;
  useLayoutEffect(() => {
    keysRef.current = live === undefined ? undefined : { order: [...row.order, ...extraKeys], active, pick: select };
  });
  // A shell or a view coming on in the left pane (⌘T, the sidebar) while the right has the focus gives the left the focus.
  const leftTabRef = useRef(tabs.active);
  useEffect(() => {
    if (leftTabRef.current === tabs.active) return;
    leftTabRef.current = tabs.active;
    if (live?.focused === 'right' && !isAgent(tabs.active)) onSplit({ ...live, focused: 'left' });
  });
  // The tab being dragged, as `getData` is empty until the drop.
  const draggedRef = useRef<string>(undefined);
  const dropsAgent = (key: string) => isAgent(key) || agents.some((agent) => agent.sessionId === key && agent.endedAt === null);
  const canDrop = (side: SplitSide | 'edge') => {
    const key = draggedRef.current;
    return key !== undefined && canDropInSplit(live, left, side, key, members, dropsAgent(key));
  };
  const drop = (side: SplitSide | 'edge', key: string) => {
    if (!dropsAgent(key)) return;
    if (live === undefined) {
      if (side === 'edge') onSplit(dropAtEdge(left, key));
      return;
    }
    if (side === 'edge') return;
    const step = dropInSplit(live, left, side, key, members);
    onSplit(step.split);
    if (step.left !== undefined) showLeft(step.left);
  };
  const extra: PopUpRowTab[] = live !== undefined && right !== undefined && !members.has(right.sessionId) ? [{ key: right.sessionId, kind: 'agent', agent: right, chat: false }] : [];
  const menuOf = (agent: Agent, hooks: PopUpMenuHooks): PopUpMenuHooks => ({
    ...hooks,
    openBeside: live === undefined && agent.sessionId === left ? beside : undefined,
    openBesideThis: live === undefined ? beside.find((each) => each.id === agent.sessionId)?.onSelect : undefined,
    closeSide: live !== undefined && agent.sessionId === live.right ? () => onSplit(undefined) : undefined,
  });
  return {
    live,
    right: live === undefined ? undefined : right,
    beside,
    select,
    drop,
    extra,
    menuOf,
    /** The tab on: the one in the pane with the focus. */
    active,
    canDrop,
    dragging: (key: string | undefined) => {
      draggedRef.current = key;
    },
    sides: live === undefined ? undefined : { left, right: live.right },
    focus: (side: SplitSide) => {
      if (live !== undefined && live.focused !== side) onSplit({ ...live, focused: side });
    },
    ratio: (ratio: number) => {
      if (live !== undefined) onSplit({ ...live, ratio });
    },
    end: () => onSplit(undefined),
    /** The row's reorder, leaving out the tab of an agent from outside the row: it has no place in the row's order. */
    move:
      (move: (key: string, index: number) => void) =>
      (key: string, index: number): void => {
        if (row.order.includes(key)) move(key, index);
      },
  };
}

/** Open beside…, as a menu's row: each agent it can open beside the one shown. */
const besideMenu = (beside: readonly BesideChoice[]): MenuEntry => ({ label: 'Open beside…', icon: <Columns2 />, detail: 'split', entries: beside.map(({ label, onSelect }) => ({ label, onSelect })) });

/**
 * The header's split button: pressed while split, ending it; else the agents to open beside the one shown, or nothing
 * where there are none.
 */
function SplitButton({ split, beside, onEnd }: { split: PopupSplit | undefined; beside: readonly BesideChoice[]; onEnd(): void }) {
  if (split !== undefined)
    return <IconButton className="agent-popup-split" data-testid="agent-popup-split" icon={<Columns2 />} size="sm" aria-label="End the split" aria-pressed tooltip="End the split, back to one agent" onClick={onEnd} />;
  if (beside.length === 0) return null;
  return (
    <Menu align="end" entries={[{ heading: 'Open beside' }, ...beside.map(({ label, onSelect }) => ({ label, onSelect }))]}>
      <IconButton className="agent-popup-split" data-testid="agent-popup-split" icon={<Columns2 />} size="sm" aria-label="Open beside…" aria-pressed={false} tooltip="Split: another agent beside this one" />
    </Menu>
  );
}

/** A side of the split, as its divider drags it. */
type SideLeaf = { type: 'pane'; side: SplitSide };
const SPLIT_ID = 'popup-split';
const percent = (fraction: number) => `${fraction * 100}%`;

/**
 * The body's panes: the row's own pane (`children`), and split, the agent beside it on the right, its chat or terminal
 * as the header's switch has it, with no sidebar, strip or controls of its own; a divider between them drags. A tab
 * dropped on a pane shows there; one dropped at the right edge of a body not split opens beside.
 */
function PopupPanes({ split, viewKey, children, className, id, role }: { split: PopUpSplitControl; viewKey: string; children: ReactNode; className: string; id: string; role: string | undefined }) {
  const box = useRef<HTMLDivElement>(null);
  const [view] = useSessionView(viewKey);
  const [over, setOver] = useState<SplitSide | 'edge'>();
  const { live, right } = split;
  const layout: SplitTree<SideLeaf> =
    live === undefined ? { type: 'pane', side: 'left' } : { type: 'split', id: SPLIT_ID, direction: 'horizontal', ratio: live.ratio, first: { type: 'pane', side: 'left' }, second: { type: 'pane', side: 'right' } };
  const latest = useRef(split);
  latest.current = split;
  const { geometry, dividers } = useDividerDrag(box, layout, (leaf) => leaf.side, (_id, ratio) => Promise.resolve(latest.current.ratio(ratio)), { onStep: () => latest.current.ratio(0.5) });
  const leftWidth = geometry.panes.find((pane) => pane.id === 'left')?.rect.width ?? 1;
  const sideAt = (clientX: number): SplitSide | 'edge' | undefined => {
    const rect = box.current?.getBoundingClientRect();
    if (rect === undefined) return undefined;
    const x = clientX - rect.left;
    if (live === undefined) return atRightEdge(x, rect.width) ? 'edge' : undefined;
    return x < rect.width * live.ratio ? 'left' : 'right';
  };
  const carries = (event: DragEvent) => event.dataTransfer.types.includes(ROW_TAB_TYPE);
  const pane = (side: SplitSide) => ({
    className: 'agent-popup-pane',
    'data-side': side,
    'data-testid': `agent-popup-pane-${side}`,
    'data-focused': (live !== undefined && live.focused === side) || undefined,
    onPointerDownCapture: () => split.focus(side),
    onFocusCapture: () => split.focus(side),
  });
  return (
    <div
      ref={box}
      className={className}
      id={id}
      role={role}
      data-split={live !== undefined || undefined}
      data-drop={over}
      onDragOver={(event) => {
        if (!carries(event)) return;
        const at = sideAt(event.clientX);
        const side = at !== undefined && split.canDrop(at) ? at : undefined;
        setOver(side);
        if (side === undefined) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(undefined);
      }}
      onDrop={(event) => {
        setOver(undefined);
        const key = event.dataTransfer.getData(ROW_TAB_TYPE);
        const side = sideAt(event.clientX);
        if (key === '' || side === undefined) return;
        event.preventDefault();
        split.drop(side, key);
      }}
    >
      <div {...pane('left')} style={live === undefined ? undefined : { flexBasis: percent(leftWidth) }}>
        {children}
      </div>
      {live !== undefined && right !== undefined && (
        <div {...pane('right')}>
          <SessionBody
            key={right.sessionId}
            content={{ kind: 'session', sessionId: right.sessionId, agent: right }}
            detailsCollapsed
            onDetailsCollapsed={() => {}}
            shelves={false}
            view={view === 'terminal' ? 'terminal' : 'chat'}
            chatControlsSlot={null}
            ownStrip={false}
            viewKey={viewKey}
            autoFocus={false}
          />
        </div>
      )}
      {live !== undefined && <Dividers {...dividers} testId="agent-popup-divider" />}
    </div>
  );
}

/**
 * A pop-up's + (its tooltip says ⌘T): what Today's strip's + offered for the agent's pane (shells here or at a
 * folder, web pages, scripts, other sessions, pull requests, the to-do list), then the views, then Open beside….
 * Nothing while it has neither a pane nor a view to offer.
 */
function PopupPlus({
  paneRow,
  views,
  open,
  beside,
  onSelect,
}: {
  paneRow: PaneRow | undefined;
  views: readonly PopUpView[];
  open: readonly string[];
  /** The agents it can open beside the one shown; none while split. */
  beside: readonly BesideChoice[];
  onSelect(key: string): void;
}) {
  const pane = useAddEntries(paneRow?.adds() ?? NOTHING_TO_ADD, { split: false });
  const viewRows: MenuEntry[] = [
    ...(views.length === 0 ? [] : [{ heading: 'Views' }]),
    ...views.map((view) => ({ label: view.label, icon: viewIcon(view.key), hint: open.includes(view.key) ? 'open' : undefined, onSelect: () => onSelect(view.key) })),
  ];
  const before: MenuEntry[] = [...(paneRow === undefined ? [] : [{ heading: 'New tab' }, ...pane.entries, ...(viewRows.length > 0 ? ['separator' as const] : [])]), ...viewRows];
  const entries: MenuEntry[] = [...before, ...(beside.length === 0 ? [] : [...(before.length > 0 ? ['separator' as const] : []), besideMenu(beside)])];
  if (entries.length === 0) return null;
  return (
    <Menu align="end" entries={entries} open={pane.menuOpen} onOpenChange={pane.onOpenChange}>
      <IconButton
        className="agent-popup-plus"
        data-testid="agent-popup-plus"
        icon={<Plus />}
        size="xs"
        variant="ghost"
        aria-label="New tab"
        tooltip={
          <>
            New tab: a shell, a page, a view, or one beside<Kbd>{keyText('window.newTab')}</Kbd>
          </>
        }
      />
    </Menu>
  );
}

/** A + before the body has drawn its panes: no shells to offer yet. */
const NOTHING_TO_ADD: TabAdds = { here: '', onNewShell: () => {}, onNewShellAt: () => {}, onRunScript: () => {}, scripts: () => Promise.resolve({ runner: 'npm', scripts: [] }), sessions: [], named: false, shells: false, onSplit: () => {} };

/** A view's icon, on its tab, its row in the sidebar and its icon on the rail. */
function viewIcon(key: PopUpView['key']): ReactNode {
  return key === BOARD_TAB ? <LayoutDashboard /> : key === ACTIVITY_TAB ? <ActivityIcon /> : <FileCheck />;
}

/**
 * The views a pop-up has for its agents, `who` (its chat first) and `owner` (whose activity it shows), and how each is
 * drawn: Activity while the agent has an activity log, Review while one of them has a review to show; a ticket's Board
 * comes from `board`.
 */
function useViewKit(who: readonly Agent[], owner: Agent, board?: (onOpenAgent: (agent: Agent) => void) => ReactNode) {
  const reviews = useReviews();
  const reviewed = who.map((agent) => ({ agent, rounds: roundsOf(reviews, agent.sessionId) })).find(({ rounds }) => showsReviewTab(rounds, false));
  const activity = useActivity(owner.sessionId);
  const hasActivity = activity.lines.length > 0 || activity.error !== undefined;
  const views = popUpViews({ board: board !== undefined, activity: hasActivity, reviewRound: reviewed?.rounds.at(-1)?.round });
  const render = (key: PopUpView['key'], { onDismissed, onOpenAgent = () => {} }: { onDismissed(): void; onOpenAgent?(agent: Agent): void }): ReactNode =>
    key === BOARD_TAB ? (
      board?.(onOpenAgent)
    ) : key === ACTIVITY_TAB ? (
      <ActivityLog orchestrator={owner} activity={activity} titled={false} />
    ) : reviewed !== undefined ? (
      <ReviewViewer implementer={reviewed.agent} rounds={reviewed.rounds} onDismissed={onDismissed} />
    ) : null;
  return { views, render };
}

/**
 * A pop-up's row: its views open as tabs, then its own agent and its helpers, in the order they were dragged into; which
 * tab is on, the one it came from (⌘[ goes back to it) and the agent shown under a view that is on. A view opens from the
 * sidebar or +, or goes to its tab when it is open already; its × closes it. ⌃Tab and ⌃⇧Tab step along the row, ⌘1–⌘9
 * pick a place in it.
 */
function usePopUpRow({
  own,
  helpers,
  views,
  popped,
  on,
  openAtFirst,
  ticket,
  onPopped,
  root,
}: {
  own: Agent;
  helpers: readonly Agent[];
  views: readonly PopUpView[];
  popped: readonly string[];
  on: string | undefined;
  openAtFirst: readonly string[];
  ticket: boolean;
  /** Brings forward a helper popped out into a window of its own, never drawn here as well. */
  onPopped(agent: Agent): void;
  root: RefObject<HTMLElement | null>;
}) {
  const [tab, setTab] = useState(on ?? own.sessionId);
  // The agent tab on last: the one shown, out of view, under a view that is on.
  const [agentTab, setAgentTab] = useState(on ?? own.sessionId);
  const [from, setFrom] = useState<string>();
  const [opened, setOpened] = useState<readonly string[]>(openAtFirst);
  const [kept, keep] = useKeptOrders();
  const owner = ticket ? popUpRowOwner(own) : `agent:${own.sessionId}`;
  // Only views it has now: one it no longer has (a review dismissed) leaves the row.
  const openViews = views.filter((view) => opened.includes(view.key));
  const open = openViews.map((view) => view.key);
  const row = rowOrder(popUpRow(own, helpers, openViews, { ticket }), kept[owner]);
  const order = row.map((each) => each.key);
  const showing = popUpTabOn(tab, agentTab, own, helpers, popped, open);
  const view = typeof showing === 'string' ? showing : undefined;
  const shown = typeof showing === 'string' ? popUpTabShown(agentTab, own, helpers, popped) : showing;
  const active = view ?? shown.sessionId;
  const pick = (key: string) => {
    const helper = helpers.find((each) => each.sessionId === key);
    if (helper !== undefined && popped.includes(helper.sessionId)) return onPopped(helper);
    if (key === active) return;
    const isView = views.some((each) => each.key === key);
    if (isView) setOpened((before) => openedView(before, key));
    else setAgentTab(key);
    setFrom(active);
    setTab(key);
  };
  const back = () => pick(from !== undefined && order.includes(from) && from !== active ? from : own.sessionId);
  // Closing the tab that is on goes back to the one it came from, or its own; that one is on now, so nothing is
  // underlined, and a closed tab is never the one ⌘[ goes back to.
  const close = (key: string) => {
    if (key === active) {
      const to = afterClose(key, { active, from, order, under: shown.sessionId });
      setTab(to);
      if (!isViewKey(to)) setAgentTab(to);
    }
    if (key === active || key === from) setFrom(undefined);
    setOpened((before) => closedView(before, key));
  };
  // A split routes the keys as it routes a click (`usePopUpSplit`): its row, its tab on and its pick, while it is open.
  const keysRef = useRef<RowKeysTarget>(undefined);
  useRowKeys(root, (press) => {
    const keys = keysRef.current ?? { order, active, pick };
    // One agent alone, with no row, leaves its keys to its terminal.
    if (keys.order.length < 2) return false;
    if (press.kind === 'back') return from !== undefined && keys.order.includes(from) && from !== keys.active ? (keys.pick(from), true) : false;
    const to = press.kind === 'step' ? steppedTab(keys.order, keys.active, press.step, new Set(popped)) : tabAtDigit(keys.order, press.digit);
    if (to !== undefined) keys.pick(to);
    return to !== undefined;
  });
  const shelfViews: ShelfViews = {
    views: views.map((each) => ({ key: each.key, label: each.label, icon: viewIcon(each.key), state: viewRow(each.key, open, active) })),
    onOpen: pick,
  };
  return { row, order, open, view, shown, active, from, pick, back, close, move: (key: string, index: number) => keep(owner, movedTab(order, key, index)), shelfViews, keysRef };
}

/** The header: the agent's mark, name and status, then `children`, its buttons, at the end. `renameAsk` going up opens its name field. */
function PopupHeader({ agent, renameAsk, children }: { agent: Agent; renameAsk: number; children: ReactNode }) {
  const shows = useNeedsYouShows();
  const simplified = useSimplified();
  return (
    <header className="session-window-head agent-popup-head">
      <HarnessMark className="session-window-mark" harness={agent.harness} />
      <SessionName agent={agent} name={agent.name} title={agent.name} ask={renameAsk} />
      {simplified ? <StatusMark status={humanStatus(agent, shows).status} /> : <StatusPill {...agentPill(agent, shows)} />}
      <span className="session-window-head-fill" />
      {children}
    </header>
  );
}

/** What an agent's menu in its pop-up does that only the pop-up can: open its name field, split beside it, end the split. */
interface PopUpMenuHooks {
  rename(): void;
  /** The agents to open beside it: undefined for an agent not shown, or while split. */
  openBeside: readonly BesideChoice[] | undefined;
  /** Opens this agent beside the one shown, on another agent's menu; undefined where it can't. */
  openBesideThis?: (() => void) | undefined;
  /** Ends the split, on its right side's menu. */
  closeSide?: (() => void) | undefined;
}

/** A menu with nothing of the pop-up's own to do: a gallery's. */
const NO_MENU_HOOKS = (): PopUpMenuHooks => ({ rename: () => {}, openBeside: undefined });

/** A lone agent's header ⋯: its pull requests with their checks, then the same menu as an agent tab's ⋯. */
function MoreMenu({ agent, nodeId, menu }: { agent: Agent; nodeId: string; menu: PopUpMenuHooks }) {
  const actions = useContext(TileActionsContext);
  const prs = pullRequestEntries(agent, actions);
  const entries = [...prs, ...(prs.length > 0 ? ['separator' as const] : []), ...usePopUpAgentEntries(agent, nodeId, menu)];
  return (
    <Menu align="end" entries={entries}>
      <IconButton icon={<MoreHorizontal />} size="sm" aria-label="More" tooltip="More: Pause, Run gate, Rename, Stop session, Delete…" />
    </Menu>
  );
}

/** The room a tab's ⋯ or × takes, kept on each tab that isn't on, so the row holds still as the tab that is on moves. */
const TabEndSlot = () => <span className="agent-popup-tab-end-slot" aria-hidden />;

/** ⋯ on the agent's tab that is on: its menu, the same as a right-click on its tab. */
function TabMoreMenu({ agent, nodeId, menu }: { agent: Agent; nodeId: string; menu: PopUpMenuHooks }) {
  return (
    <Menu align="start" entries={usePopUpAgentEntries(agent, nodeId, menu)}>
      <IconButton className="agent-popup-tab-more" data-testid="agent-popup-tab-more" icon={<MoreHorizontal />} size="xs" variant="ghost" aria-label={`More for ${agent.name}`} tooltip="Pause, Run gate, Rename, Stop session, Delete…" />
    </Menu>
  );
}

/** The menu a right-click on an agent's tab opens, at the pointer. */
function TabContextMenu({ agent, nodeId, menu, at, onClose }: { agent: Agent; nodeId: string; menu: PopUpMenuHooks; at: { x: number; y: number }; onClose(): void }) {
  return <ContextMenu at={at} entries={usePopUpAgentEntries(agent, nodeId, menu)} label={`${agent.name}'s menu`} onClose={onClose} />;
}

/** An agent's menu in its pop-up (`popUpAgentMenu`), wired to the board's actions and the pop-up's own. */
function usePopUpAgentEntries(agent: Agent, nodeId: string, { rename, openBeside, openBesideThis, closeSide }: PopUpMenuHooks): ModelEntry[] {
  const actions = useContext(TileActionsContext);
  const clickOpens = useContext(ClickOpensContext);
  const rounds = roundsOf(useReviews(), agent.sessionId);
  const gate = useGateRuns().get(agent.sessionId);
  return popUpAgentMenu({ nodeId, agent, clickOpens, gate, rounds, rename, actions, openBeside, openBesideThis, closeSide });
}

/** An agent's name, in place of its tab's label while it is renamed from its menu; `onDone` once the field closes. */
function TabRename({ agent, onDone }: { agent: Agent; onDone(): void }) {
  const { rename } = useContext(TileActionsContext);
  const target = nameTarget({ agent });
  const renaming = useRenaming(agent.name, async (next) => {
    if (target !== undefined) await rename(target, next);
  });
  const opened = useRef(false);
  useEffect(() => {
    if (renaming.editing) opened.current = true;
    else if (opened.current) onDone();
    else renaming.startSoon();
    // Only the field opening and closing matters.
  }, [renaming.editing]);
  return <EditableName className="agent-popup-tab-rename" value={agent.name} renaming={renaming} label="Agent name" />;
}

/** The agent's menu (Pause, Run gate, Delete…), less the rows its pop-up has of its own. */
function usePopupAgentMenu(agent: Agent, nodeId: string): ModelEntry[] {
  const actions = useContext(TileActionsContext);
  const clickOpens = useContext(ClickOpensContext);
  const rounds = roundsOf(useReviews(), agent.sessionId);
  const gate = useGateRuns().get(agent.sessionId);
  return agentMenu({ nodeId, agent, clickOpens, gate, rounds, rename: () => {}, actions }).filter(
    (entry: ModelEntry) => entry === 'separator' || !('id' in entry) || !POPUP_OWN.has(entry.id),
  );
}

/** The height of an agent's character on its tab, in px. */
const TAB_CHARACTER_HEIGHT = 18;
const PANEL_ID = 'agent-popup-panel';

/**
 * A ticket's pop-up: a header with the ticket and, when it is ready, Merge; under it one row of tabs, its Board, its chat
 * and each helper, in the order they were dragged into; under that what the tab that is on shows, with no row of its own
 * above it. The tab the user came from is underlined, and ⌘[ goes back to it; ⌃Tab and ⌃⇧Tab step along the row, ⌘1–⌘9
 * pick a place in it. ⌥-click on a tab opens that agent in its own window. Its ⋯ has the ticket's own rows (its pull
 * request with its checks, Watches…, its board) and its chat's.
 */
function TicketPopupBody({
  chat,
  helpers,
  on,
  popped,
  nodeId,
  onClose,
  root,
  board,
  splitting,
}: {
  chat: Agent;
  helpers: readonly Agent[];
  on: string | undefined;
  popped: readonly string[];
  nodeId: string;
  onClose(): void;
  root: RefObject<HTMLElement | null>;
  board: PopUpBoard | undefined;
  splitting: PopUpSplitting;
}) {
  const { expand, popOutAgent, openAgent, openPullRequest } = useContext(TileActionsContext);
  const shows = useNeedsYouShows();
  const face = ticketFace(chat, helpers, shows, { simplified: useSimplified() });
  const kit = useViewKit(
    [chat, ...helpers],
    chat,
    board &&
      ((onOpenAgent) => (
        <TicketBoard chatId={chat.sessionId} agents={board.agents} desk={board.desk} onError={board.onError} onLeave={() => row.back()} onOpenAgent={onOpenAgent} inPopUp />
      )),
  );
  // Its overview, the Board, is open as it opens.
  const [openAtFirst] = useState(() => viewsOpenAtFirst(kit.views));
  const row = usePopUpRow({ own: chat, helpers, views: kit.views, popped, on, openAtFirst, ticket: true, onPopped: openAgent, root });
  const { shown, order } = row;
  const content: WindowContent = { kind: 'session', sessionId: shown.sessionId, agent: shown };
  const shelves = showsShelves(content);
  const [detailsCollapsed, setDetailsCollapsed] = useSidebarCollapsed(shelves, root, () => false);
  const viewKey = popUpViewKey(chat, true);
  // The chat's own pick moves into the ticket's the first time its pop-up opens; after that it is the pop-up's.
  useEffect(() => adoptChatView(viewKey), [viewKey]);
  const [paneRow, setPaneRow] = useState<PaneRow>();
  const tabs = usePaneTabs(row, paneRow);
  const split = usePopUpSplit(splitting, row, tabs, popped);
  // The helper whose tab is renamed in place, from its menu.
  const [renamingTab, setRenamingTab] = useState<string>();
  const menuOf = (agent: Agent): PopUpMenuHooks => split.menuOf(agent, { rename: () => setRenamingTab(agent.sessionId), openBeside: undefined });
  const instead = (then: () => void) => () => {
    onClose();
    then();
  };
  const pr = face.pr;
  const prOwner = pr === undefined ? undefined : [chat, ...helpers].find((agent) => agent.pullRequests.includes(pr));
  const name = face.ticketId ?? face.title;
  return (
    <>
      <header className="session-window-head agent-popup-head">
        {face.ticketId !== undefined && (
          <span className="ticket-tile-id" data-testid="ticket-id">
            <Ticket aria-hidden />
            {face.ticketId}
          </span>
        )}
        <span className="agent-popup-title" title={face.title}>
          {face.title}
        </span>
        <span className="session-window-head-fill" />
        <PopupViewSwitch viewKey={viewKey} agentOn={tabs.agentOn || split.live !== undefined} />
        <SplitButton split={split.live} beside={split.beside} onEnd={split.end} />
        <StateAction agent={shown} placement="board" />
        {face.button?.kind === 'merge' && pr !== undefined && prOwner !== undefined && (
          <Button size="sm" variant="primary" icon={<GitMerge />} data-testid="agent-popup-merge" title="Open its pull request, to merge it there" onClick={() => openPullRequest(prOwner, pr)}>
            Merge
          </Button>
        )}
        <IconButton icon={<Expand />} size="sm" aria-label="Expand" tooltip="Expand it here, on its terminal" onClick={instead(() => expand(nodeId))} />
        <IconButton icon={<SquareArrowOutUpRight />} size="sm" aria-label="Pop out" tooltip={`Pop out ${shown.name} to its own window`} onClick={instead(() => popOutAgent(shown))} />
        <TicketMoreMenu chat={chat} helpers={helpers} nodeId={nodeId} name={name} />
        <BackToTileButton from={root} leave={onClose} label="Back to its tile" tooltip="Back to its tile; it keeps running" />
      </header>
      <PopupTabs
        row={[...row.row, ...split.extra]}
        shells={paneRow?.tabs ?? []}
        active={split.active}
        from={row.from}
        nodeId={nodeId}
        views={kit.views}
        open={row.open}
        paneRow={paneRow}
        menuOf={menuOf}
        sides={split.sides}
        beside={split.beside}
        renaming={renamingTab}
        onRenamed={() => setRenamingTab(undefined)}
        label="The ticket's views, chat, helpers and shells"
        onSelect={split.select}
        onClose={tabs.close}
        onMove={split.move(row.move)}
        onDragKey={split.dragging}
        onOpenWindow={(agent) => instead(() => openAgent(agent))()}
      />
      <PopupPanes className="agent-popup-body" id={PANEL_ID} role="tabpanel" split={split} viewKey={viewKey}>
        <SessionBody
          key={shown.sessionId}
          content={content}
          detailsCollapsed={detailsCollapsed}
          onDetailsCollapsed={setDetailsCollapsed}
          shelves={shelves}
          // Straight under the ticket's tabs: no strip of its own over it, unless something is amiss; its shell tabs in
          // the row, the one view switch in the header, its chat's controls at the chat's top.
          chatControlsSlot={null}
          ownStrip={false}
          viewKey={viewKey}
          onRow={setPaneRow}
          views={row.shelfViews}
          cover={
            row.view === undefined
              ? undefined
              : kit.render(row.view, {
                  onDismissed: () => row.close(REVIEW_TAB),
                  // A member of the ticket's row opens on its tab; anything else in its own window.
                  onOpenAgent: (agent) => (order.includes(agent.sessionId) ? tabs.select(agent.sessionId) : openAgent(agent)),
                })
          }
        />
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

/**
 * Each pop-up row's kept order, read from the view state as it opens and saved there as a tab is dragged. A save reads
 * what is saved first and adds to it, one after another, so a drag before the load (or after it failed) keeps the
 * other owners' orders; when the read fails, nothing is written.
 */
function useKeptOrders(): [KeptOrders, (owner: string, order: readonly string[]) => void] {
  const [orders, setOrders] = useState<KeptOrders>({});
  const saving = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    window.agentBoard.view.get(VIEW_KEYS.popUpTabOrder).then(
      // A drag made before the saved orders came in stays over theirs.
      (saved) => setOrders((dragged) => ({ ...keptOrders(saved), ...dragged })),
      () => {},
    );
  }, []);
  const keep = (owner: string, order: readonly string[]) => {
    setOrders((before) => withKeptOrder(before, owner, order));
    saving.current = saving.current
      .then(() => window.agentBoard.view.get(VIEW_KEYS.popUpTabOrder))
      .then((saved) => window.agentBoard.view.set(VIEW_KEYS.popUpTabOrder, withKeptOrder(keptOrders(saved), owner, order)))
      .then(
        () => {},
        () => {},
      );
  };
  return [orders, keep];
}

/**
 * The row's keys, wherever the focus is in the pop-up, its terminal too: caught on the window on the way in, as React's
 * own capture handlers (its panes', whose ⌘1–9 pick a shell tab) sit on the page's root, above the pop-up, and would
 * have them first. `run` says whether the row took the press.
 */
function useRowKeys(root: RefObject<HTMLElement | null>, run: (press: RowKey) => boolean): void {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.target instanceof Node) || root.current?.contains(event.target) !== true) return;
      const press = popUpRowKey(event);
      if (press === undefined || !latest.current(press)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [root]);
}

/** How wide "+n ▾" is taken to be, in px, before it has been drawn to measure. */
const MORE_GUESS = 56;
/** How wide a tab is taken to be, in px, before it has been drawn to measure. */
const TAB_GUESS = 140;

/**
 * The row of tabs: the Board, then each agent with its character, its name, "chat" on the chat's, and its status dot,
 * whose tooltip says since when, then the shown agent's shells. The tab that is on ends in ⋯ (its agent's menu, which a
 * right-click on any agent's tab opens too) or, on a view or a shell, ×. The views and agents drag along it into any
 * order. What doesn't fit folds into "+n ▾", from the right, but never the tab that is on nor one that asks; + ends the
 * row: a new shell, the views to open, and Open beside….
 */
export function PopupTabs({
  row,
  shells = [],
  active,
  from,
  nodeId,
  views,
  open,
  ownLabel,
  paneRow,
  menuOf = NO_MENU_HOOKS,
  sides,
  beside = [],
  renaming,
  onRenamed,
  onDragKey,
  label,
  onSelect,
  onClose,
  onMove,
  onOpenWindow,
}: {
  row: readonly PopUpRowTab[];
  /** The shown agent's shell tabs (and what else its body opened), after the agents. */
  shells?: readonly StripTab[];
  /** What its shells do: undefined until its body has drawn, and in a gallery. */
  paneRow?: PaneRow | undefined;
  /** What an agent's menu does that only the pop-up can. */
  menuOf?(agent: Agent): PopUpMenuHooks;
  /** Split, the agents on each side: both their tabs are on, with a "left" and a "right" pill. */
  sides?: { left: string; right: string } | undefined;
  /** The agents its + offers to open beside the one shown. */
  beside?: readonly BesideChoice[];
  /** The agent whose tab is renamed in place, if one is. */
  renaming?: string | undefined;
  onRenamed?(): void;
  /** The tab being dragged in the row, as the drag starts, then none as it ends: the body takes it to show where it drops. */
  onDragKey?(key: string | undefined): void;
  active: string;
  from: string | undefined;
  nodeId: string;
  /** The views it has, which + offers: opening one, or going to its tab when it is open (`open`). */
  views: readonly PopUpView[];
  open: readonly string[];
  /** What one agent alone calls its own tab ("Chat" or "Terminal"), with no ⋯ of its own: its header's is the same menu. */
  ownLabel?: string | undefined;
  /** What the row is, as a screen reader says it. */
  label: string;
  onSelect(key: string): void;
  onClose(key: string): void;
  /** Moves a tab to `index` in the whole row, as the strip counts it. */
  onMove(key: string, index: number): void;
  onOpenWindow(agent: Agent): void;
}) {
  const shows = useNeedsYouShows();
  const style = useCharacterStyle();
  const tabs: StripTab[] = row.map(({ key, agent, view, chat: isChat }) => {
    if (agent === undefined)
      return {
        id: key,
        label: view?.label ?? key,
        icon: viewIcon(view?.key ?? BOARD_TAB),
        closable: key === active,
        closeHint: `Close ${view?.label ?? key}`,
        ...(key === active ? {} : { mark: <TabEndSlot /> }),
      };
    // One agent alone has one agent tab: its own, named for its view.
    if (ownLabel !== undefined)
      return { id: key, label: ownLabel, icon: ownLabel === 'Chat' ? <MessageSquare /> : <SquareTerminal />, title: agent.name, closable: false, closeHint: '', ...(key === active ? {} : { mark: <TabEndSlot /> }) };
    const status = humanStatus(agent, shows).status;
    const side = sides?.left === key ? 'left' : sides?.right === key ? 'right' : undefined;
    return {
      id: key,
      label: agent.name,
      beside: side !== undefined,
      closable: false,
      closeHint: '',
      lead:
        style === 'off' ? (
          <HarnessMark harness={agent.harness} />
        ) : (
          <TileCharacter harness={agent.harness} {...lookShown(poseOfPill(agentPill(agent, shows).state), agent)} style={style} height={TAB_CHARACTER_HEIGHT} />
        ),
      ...(side !== undefined ? { pill: side } : isChat ? { pill: 'chat' } : {}),
      mark: (
        <>
          <TabDot status={status} since={agent.stateSince} />
          {key === active || side !== undefined ? <TabMoreMenu agent={agent} nodeId={nodeId} menu={menuOf(agent)} /> : <TabEndSlot />}
        </>
      ),
      ask: status === 'needs-you',
      ...(renaming === agent.sessionId ? { editing: <TabRename agent={agent} onDone={() => onRenamed?.()} /> } : {}),
    };
  });
  // The shells: "Shell" with a terminal icon in words under one agent alone, × on the one on.
  for (const shell of shells)
    tabs.push({
      ...shell,
      ...(ownLabel !== undefined && shells.length === 1 ? { label: 'Shell', title: shell.title ?? shell.label } : {}),
      icon: shell.icon ?? <SquareTerminal />,
      closable: shell.id === active && shell.closable,
      ...(shell.id === active ? {} : { mark: <TabEndSlot /> }),
    });
  const [context, setContext] = useState<{ agent: Agent; at: { x: number; y: number } }>();
  const box = useRef<HTMLDivElement>(null);
  const folded = useFold(box, tabs, active);
  const showing = tabs.filter((tab) => !folded.includes(tab.id));
  const order = tabs.map((tab) => tab.id);
  // A drop among the tabs showing, at the place of the tab there in the whole row, or after the last one showing.
  const placeOf = (index: number) => {
    const at = showing[index];
    return at !== undefined ? order.indexOf(at.id) : order.indexOf(showing.at(-1)!.id) + 1;
  };
  const agentOf = (key: string) => row.find((each) => each.key === key)?.agent;
  const more: MenuEntry[] = tabs
    .filter((tab) => folded.includes(tab.id))
    .map((tab) => ({ label: tab.label, onSelect: () => onSelect(tab.id) }));
  const rowKeys = new Set(row.map((each) => each.key));
  return (
    <div
      ref={box}
      className="agent-popup-tabs"
      data-testid="agent-popup-tabs"
      data-split={sides !== undefined || undefined}
      onDragStart={(event) => onDragKey?.(event.dataTransfer.getData(ROW_TAB_TYPE) || undefined)}
      onDragEnd={() => onDragKey?.(undefined)}
    >
      <TabStrip
        tabs={showing}
        active={active}
        from={from}
        label={label}
        onSelect={onSelect}
        onAltSelect={(key) => {
          const agent = agentOf(key);
          if (agent !== undefined) onOpenWindow(agent);
        }}
        onClose={onClose}
        panelId={() => PANEL_ID}
        // Shells stay after the agents: only the views and agents move.
        reorder={(key, index) => rowKeys.has(key) && onMove(key, Math.min(placeOf(index), row.length))}
        onContextMenu={(key, at) => {
          const agent = agentOf(key);
          if (agent === undefined) return false;
          setContext({ agent, at });
          return true;
        }}
        trailing={
          <span className="agent-popup-row-end">
            {more.length > 0 && (
              <Menu align="end" entries={more}>
                <button type="button" className="agent-popup-more" data-testid="agent-popup-more" title="The tabs that don't fit">
                  +{more.length}
                  <ChevronDown aria-hidden />
                </button>
              </Menu>
            )}
            <PopupPlus paneRow={paneRow} views={views} open={open} beside={beside} onSelect={onSelect} />
          </span>
        }
      />
      {context !== undefined && <TabContextMenu agent={context.agent} nodeId={nodeId} menu={menuOf(context.agent)} at={context.at} onClose={() => setContext(undefined)} />}
    </div>
  );
}

/**
 * Which of the row's tabs fold into "+n ▾": each tab measured as drawn (a folded one keeps the width it had), against
 * the room the row has beside its end, measured again as the pop-up is resized.
 */
function useFold(row: RefObject<HTMLElement | null>, tabs: readonly StripTab[], active: string): string[] {
  const [folded, setFolded] = useState<string[]>([]);
  const widths = useRef(new Map<string, number>());
  const [, remeasure] = useState(0);
  useEffect(() => {
    const box = row.current;
    if (box === null) return;
    const observer = new ResizeObserver(() => remeasure((n) => n + 1));
    observer.observe(box);
    return () => observer.disconnect();
  }, [row]);
  useLayoutEffect(() => {
    const box = row.current;
    if (box === null) return;
    // Each container's own gap: between the tabs (a tab counts the one after it, the last one's spare), between the
    // tabs and the row's end, and between "+n" and +.
    const gapOf = (selector: string) => {
      const element = box.querySelector(selector);
      return element === null ? 0 : parseFloat(getComputedStyle(element).columnGap) || 0;
    };
    const tabGap = gapOf('.session-tabs-list');
    for (const tab of box.querySelectorAll<HTMLElement>('[data-testid="session-tab"]')) widths.current.set(tab.dataset.tab ?? '', tab.getBoundingClientRect().width + tabGap);
    const plus = box.querySelector('.agent-popup-plus')?.getBoundingClientRect().width ?? 0;
    const more = box.querySelector('.agent-popup-more')?.getBoundingClientRect().width ?? MORE_GUESS;
    const inner = box.clientWidth - parseFloat(getComputedStyle(box).paddingLeft) - parseFloat(getComputedStyle(box).paddingRight);
    const keep = new Set([active, ...tabs.filter((tab) => tab.ask).map((tab) => tab.id)]);
    const next = foldRow(
      tabs.map((tab) => ({ key: tab.id, width: widths.current.get(tab.id) ?? TAB_GUESS })),
      { room: inner - plus - gapOf('.session-tabs'), more: more + gapOf('.agent-popup-row-end'), keep },
    ).folded;
    if (next.join('\n') !== folded.join('\n')) setFolded(next);
  });
  return folded;
}

/** A tab's status dot; its tooltip says since when, kept current as the time goes by. */
function TabDot({ status, since }: { status: keyof typeof HUMAN_STATUS_LABELS; since: string }) {
  const now = useNowForSince(since);
  return <span className="agent-popup-tab-dot" data-testid="agent-popup-tab-dot" data-status={status} title={`${HUMAN_STATUS_LABELS[status]} ${sinceLabel(since, now)}`} />;
}

/** ⋯ of a ticket's pop-up: the ticket's rows (its board, Watches…, its pull request and checks, its chat's kind), then its chat's own, then Close ticket…. */
function TicketMoreMenu({ chat, helpers, nodeId, name }: { chat: Agent; helpers: readonly Agent[]; nodeId: string; name: string }) {
  const own = usePopupAgentMenu(chat, nodeId);
  const { entries, watches } = useTicketChatMenu(chat, helpers, [], own, name);
  return (
    <>
      <Menu align="end" entries={entries}>
        <IconButton icon={<MoreHorizontal />} size="sm" aria-label="More" tooltip="More: its pull request, Watches, Run gate, Close ticket…" />
      </Menu>
      {watches}
    </>
  );
}
