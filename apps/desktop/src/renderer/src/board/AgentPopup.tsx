import { useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { HUMAN_STATUS_LABELS, humanStatus } from '@agent-board/daemon/human-status';
import { lookShown } from '@agent-board/daemon/character';
import { ChevronDown, Expand, GitMerge, LayoutDashboard, MoreHorizontal, Plus, SquareArrowOutUpRight, Ticket } from 'lucide-react';
import { VIEW_KEYS } from '../../../shared/view-saver';
import { useEscStep } from '../keys/esc-ladder';
import { leaveToTile, useLeaveKeys } from '../keys/escape-hatch';
import { pressed } from '../keys/registry';
import { isTyping } from '../keys/typing';
import { useGateRuns } from '../gate/GatesProvider';
import { useReviews } from '../review/ReviewsProvider';
import { roundsOf } from '../review/reviews';
import { showsShelves } from '../session/agent-sidebar';
import { SessionBody, type WindowContent } from '../session/SessionBody';
import { SessionName } from '../session/SessionName';
import { TabStrip, type StripTab } from '../session/TabStrip';
import { StateAction } from '../session/SimplifiedHeader';
import { useSidebarCollapsed } from '../session/use-sidebar-collapsed';
import { useSimplified } from '../design';
import { useNeedsYouShows } from '../needs-you-setting';
import { agentPill } from '../states';
import { Button, IconButton, Menu, StatusPill, type MenuEntry } from '../ui';
import { tabAtDigit } from '../session/tabs';
import { BOARD_TAB, escClosesFromBehind, popUpRow, popUpRowOwner, popUpTabOn, type PopUpRowTab } from './agent-popup';
import { foldRow, keptOrders, movedTab, popUpRowKey, rowOrder, steppedTab, withKeptOrder, type KeptOrders, type RowKey } from './popup-tab-row';
import { TicketBoard } from './TicketBoard';
import { BackToTileButton } from './BackToTile';
import { usePopupFrost } from './popup-frost';
import { dragPopup, POPUP_EDGES, popupSize, readPopupSize, writePopupSize, type PopupEdge, type Size } from './popup-size';
import { useCharacterStyle } from './characters';
import { useNowForSince } from '../inbox/use-now';
import { useBoardCommands } from './commands';
import { HarnessMark } from './HarnessMark';
import { agentMenu, pullRequestEntries, type ModelEntry } from './menu-model';
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
  const { style, edges } = usePopupSize(scrim);
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
        >
          {helpers === undefined ? (
            <PopupBody agent={agent} nodeId={nodeId} onClose={onClose} root={root} />
          ) : (
            <TicketPopupBody chat={agent} helpers={helpers} on={on} popped={popped} nodeId={nodeId} onClose={onClose} root={root} board={ticketBoard} />
          )}
        </section>
        {edges}
      </div>
    </div>
  );
}

/** How far, in px, a press on an edge moves before it is a drag: a click with a trackpad's jitter keeps no size. */
const DRAG_SLOP = 3;

/**
 * The pop-up's size on the board under `scrim`: the 16:10 fit, or the size dragged to from its edges and corners, which
 * every pop-up keeps through restarts. A double-click on an edge gives the fit back. It stays centred as it is dragged.
 */
function usePopupSize(scrim: RefObject<HTMLElement | null>): { style: CSSProperties | undefined; edges: ReactNode } {
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
  const size = room === null ? null : popupSize(room, saved);
  const dragged = (event: PointerEvent, held: NonNullable<typeof drag.current>) => dragPopup(held.start, held.edge, event.clientX - held.x, event.clientY - held.y, held.room);
  const onDown = (edge: PopupEdge) => (event: PointerEvent<HTMLElement>) => {
    if (size === null || room === null || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { edge, x: event.clientX, y: event.clientY, start: size, room, moved: false, last: size };
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
  return { style: size === null ? undefined : { width: size.width, height: size.height }, edges };
}

function PopupBody({ agent, nodeId, onClose, root }: { agent: Agent; nodeId: string; onClose(): void; root: RefObject<HTMLElement | null> }) {
  const { expand, popOutAgent } = useContext(TileActionsContext);
  const content: WindowContent = { kind: 'session', sessionId: agent.sessionId, agent };
  const shelves = showsShelves(content);
  const [detailsCollapsed, setDetailsCollapsed] = useSidebarCollapsed(shelves, root, () => false);
  // Where the shelves' and the chat's controls go: the header, which has no row of controls under it.
  const [controlsSlot, setControlsSlot] = useState<HTMLElement | null>(null);
  const [chatControlsSlot, setChatControlsSlot] = useState<HTMLElement | null>(null);
  const instead = (then: () => void) => () => {
    onClose();
    then();
  };
  return (
    <>
      <PopupHeader agent={agent}>
        <span className="session-window-chat-controls" ref={setChatControlsSlot} />
        {shelves && <span className="session-window-shelf-controls" ref={setControlsSlot} />}
        <StateAction agent={agent} placement="board" />
        <IconButton icon={<Expand />} size="sm" aria-label="Expand" tooltip="Expand it here, on its terminal" onClick={instead(() => expand(nodeId))} />
        <IconButton icon={<SquareArrowOutUpRight />} size="sm" aria-label="Pop out" tooltip="Pop out to its own window" onClick={instead(() => popOutAgent(agent))} />
        <MoreMenu agent={agent} nodeId={nodeId} />
        <BackToTileButton from={root} leave={onClose} label="Back to its tile" tooltip="Back to its tile; it keeps running" />
      </PopupHeader>
      <div className="agent-popup-body">
        <SessionBody
          content={content}
          detailsCollapsed={detailsCollapsed}
          onDetailsCollapsed={setDetailsCollapsed}
          shelves={shelves}
          controlsSlot={controlsSlot}
          chatControlsSlot={chatControlsSlot}
          compactControls
        />
      </div>
    </>
  );
}

/** The header: the agent's mark, name and status, then `children`, its buttons, at the end. */
function PopupHeader({ agent, children }: { agent: Agent; children: ReactNode }) {
  const shows = useNeedsYouShows();
  const simplified = useSimplified();
  return (
    <header className="session-window-head agent-popup-head">
      <HarnessMark className="session-window-mark" harness={agent.harness} />
      <SessionName agent={agent} name={agent.name} title={agent.name} />
      {simplified ? <StatusMark status={humanStatus(agent, shows).status} /> : <StatusPill {...agentPill(agent, shows)} />}
      <span className="session-window-head-fill" />
      {children}
    </header>
  );
}

/** ⋯: its pull requests with their checks, then the agent's menu (Pause and Delete too), less what the header has. */
function MoreMenu({ agent, nodeId }: { agent: Agent; nodeId: string }) {
  return (
    <Menu align="end" entries={usePopupMoreEntries(agent, nodeId)}>
      <IconButton icon={<MoreHorizontal />} size="sm" aria-label="More" tooltip="More: its pull requests, Pause, Delete…" />
    </Menu>
  );
}

/** The room a tab's ⋯ or × takes, kept on each tab that isn't on, so the row holds still as the tab that is on moves. */
const TabEndSlot = () => <span className="agent-popup-tab-end-slot" aria-hidden />;

/** ⋯ on the agent's tab that is on, in a ticket's pop-up: the same menu as a lone agent's pop-up has in its header. */
function TabMoreMenu({ agent, nodeId }: { agent: Agent; nodeId: string }) {
  return (
    <Menu align="start" entries={usePopupMoreEntries(agent, nodeId)}>
      <IconButton className="agent-popup-tab-more" data-testid="agent-popup-tab-more" icon={<MoreHorizontal />} size="xs" variant="ghost" aria-label={`More for ${agent.name}`} tooltip="Its pull requests, Pause, Delete…" />
    </Menu>
  );
}

function usePopupMoreEntries(agent: Agent, nodeId: string): ModelEntry[] {
  const actions = useContext(TileActionsContext);
  const prs = pullRequestEntries(agent, actions);
  return [...prs, ...(prs.length > 0 ? ['separator' as const] : []), ...usePopupAgentMenu(agent, nodeId)];
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
}: {
  chat: Agent;
  helpers: readonly Agent[];
  on: string | undefined;
  popped: readonly string[];
  nodeId: string;
  onClose(): void;
  root: RefObject<HTMLElement | null>;
  board: PopUpBoard | undefined;
}) {
  const { expand, popOutAgent, openAgent, openPullRequest } = useContext(TileActionsContext);
  const shows = useNeedsYouShows();
  const face = ticketFace(chat, helpers, shows, { simplified: useSimplified() });
  const [tab, setTab] = useState(on ?? chat.sessionId);
  const [from, setFrom] = useState<string>();
  // A view closed by its × is out of the row until + opens it again.
  const [closed, setClosed] = useState<readonly string[]>([]);
  const [kept, keep] = useKeptOrders();
  const owner = popUpRowOwner(chat);
  const row = rowOrder(
    popUpRow(chat, helpers).filter((each) => !closed.includes(each.key)),
    kept[owner],
  );
  const order = row.map((each) => each.key);
  const showing = popUpTabOn(closed.includes(tab) ? undefined : tab, chat, helpers, popped);
  const shown = showing === BOARD_TAB ? chat : showing;
  const active = showing === BOARD_TAB ? BOARD_TAB : shown.sessionId;
  const pick = (key: string) => {
    // A helper popped out into its own window is brought forward there, never drawn here as well.
    const helper = helpers.find((each) => each.sessionId === key);
    if (helper !== undefined && popped.includes(helper.sessionId)) return openAgent(helper);
    if (key === active) return;
    setClosed((views) => views.filter((view) => view !== key));
    setFrom(active);
    setTab(key);
  };
  const back = () => pick(from !== undefined && order.includes(from) && from !== active ? from : chat.sessionId);
  // Closing the tab that is on goes back to the one it came from, or the chat; that one is on now, so nothing is
  // underlined, and a closed tab is never the one ⌘[ goes back to.
  const close = (key: string) => {
    if (key === active) setTab(from !== undefined && from !== key && order.includes(from) ? from : chat.sessionId);
    if (key === active || key === from) setFrom(undefined);
    setClosed((views) => [...views, key]);
  };
  useRowKeys(root, (press) => {
    if (press.kind === 'back') return from !== undefined && order.includes(from) ? (pick(from), true) : false;
    const to = press.kind === 'step' ? steppedTab(order, active, press.step, new Set(popped)) : tabAtDigit(order, press.digit);
    if (to !== undefined) pick(to);
    return to !== undefined;
  });
  const content: WindowContent = { kind: 'session', sessionId: shown.sessionId, agent: shown };
  const onBoard = showing === BOARD_TAB && board !== undefined;
  const shelves = !onBoard && showsShelves(content);
  const [detailsCollapsed, setDetailsCollapsed] = useSidebarCollapsed(shelves, root, () => false);
  const [controlsSlot, setControlsSlot] = useState<HTMLElement | null>(null);
  const [chatControlsSlot, setChatControlsSlot] = useState<HTMLElement | null>(null);
  const [switchSlot, setSwitchSlot] = useState<HTMLElement | null>(null);
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
        <span className="session-window-chat-controls" ref={setChatControlsSlot} />
        {shelves && <span className="session-window-shelf-controls" ref={setControlsSlot} />}
        <span className="agent-popup-switch" ref={setSwitchSlot} />
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
        row={row}
        active={active}
        from={from}
        nodeId={nodeId}
        closed={closed}
        onSelect={pick}
        onClose={close}
        onMove={(key, index) => keep(owner, movedTab(order, key, index))}
        onOpenWindow={(agent) => instead(() => openAgent(agent))()}
      />
      <div className="agent-popup-body" id={PANEL_ID} role="tabpanel">
        {onBoard ? (
          <TicketBoard
            chatId={chat.sessionId}
            agents={board.agents}
            desk={board.desk}
            onError={board.onError}
            onLeave={back}
            // A member of the ticket's row opens on its tab; anything else in its own window.
            onOpenAgent={(agent) => (order.includes(agent.sessionId) ? pick(agent.sessionId) : openAgent(agent))}
            inPopUp
          />
        ) : (
          <SessionBody
            key={shown.sessionId}
            content={content}
            detailsCollapsed={detailsCollapsed}
            onDetailsCollapsed={setDetailsCollapsed}
            shelves={shelves}
            controlsSlot={controlsSlot}
            chatControlsSlot={chatControlsSlot}
            compactControls
            // Straight under the ticket's tabs: no strip of its own over it, unless something is amiss, and its view switch in the header.
            ownStrip={false}
            switchSlot={switchSlot}
          />
        )}
      </div>
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
 * whose tooltip says since when. The tab that is on ends in ⋯ (its agent's menu) or, on a view, ×. Tabs drag along it
 * into any order. What doesn't fit folds into "+n ▾", from the right, but never the tab that is on nor one that asks;
 * + ends the row, with the views to open.
 */
export function PopupTabs({
  row,
  active,
  from,
  nodeId,
  closed,
  onSelect,
  onClose,
  onMove,
  onOpenWindow,
}: {
  row: readonly PopUpRowTab[];
  active: string;
  from: string | undefined;
  nodeId: string;
  /** The views closed by their ×, which + offers again. */
  closed: readonly string[];
  onSelect(key: string): void;
  onClose(key: string): void;
  /** Moves a tab to `index` in the whole row, as the strip counts it. */
  onMove(key: string, index: number): void;
  onOpenWindow(agent: Agent): void;
}) {
  const shows = useNeedsYouShows();
  const style = useCharacterStyle();
  const tabs: StripTab[] = row.map(({ key, agent, chat: isChat }) => {
    if (agent === undefined)
      return {
        id: key,
        label: 'Board',
        icon: <LayoutDashboard />,
        title: "The ticket's board",
        closable: key === active,
        closeHint: 'Close the Board',
        ...(key === active ? {} : { mark: <TabEndSlot /> }),
      };
    const status = humanStatus(agent, shows).status;
    return {
      id: key,
      label: agent.name,
      closable: false,
      closeHint: '',
      lead:
        style === 'off' ? (
          <HarnessMark harness={agent.harness} />
        ) : (
          <TileCharacter harness={agent.harness} {...lookShown(poseOfPill(agentPill(agent, shows).state), agent)} style={style} height={TAB_CHARACTER_HEIGHT} />
        ),
      ...(isChat ? { pill: 'chat' } : {}),
      mark: (
        <>
          <TabDot status={status} since={agent.stateSince} />
          {key === active ? <TabMoreMenu agent={agent} nodeId={nodeId} /> : <TabEndSlot />}
        </>
      ),
      ask: status === 'needs-you',
    };
  });
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
  const adds: MenuEntry[] = [{ label: 'Board', icon: <LayoutDashboard />, hint: closed.includes(BOARD_TAB) ? undefined : 'open', onSelect: () => onSelect(BOARD_TAB) }];
  return (
    <div ref={box} className="agent-popup-tabs" data-testid="agent-popup-tabs">
      <TabStrip
        tabs={showing}
        active={active}
        from={from}
        label="The ticket's board, chat and helpers"
        onSelect={onSelect}
        onAltSelect={(key) => {
          const agent = agentOf(key);
          if (agent !== undefined) onOpenWindow(agent);
        }}
        onClose={onClose}
        panelId={() => PANEL_ID}
        reorder={(key, index) => onMove(key, placeOf(index))}
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
            <Menu align="end" entries={adds}>
              <IconButton className="agent-popup-plus" data-testid="agent-popup-plus" icon={<Plus />} size="xs" variant="ghost" aria-label="Open a view" tooltip="Open a view as a tab" />
            </Menu>
          </span>
        }
      />
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
