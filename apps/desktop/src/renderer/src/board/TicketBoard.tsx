import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { ChevronLeft, ChevronRight, LayoutDashboard, MessageSquare, Ticket } from 'lucide-react';
import { applyNodeChanges, PanOnScrollMode, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, useStoreApi, type Node, type NodeChange, type NodeProps, type NodeTypes } from '@xyflow/react';
import type { Agent, BoardItem, TicketBoardPlace } from '@agent-board/daemon/protocol';
import { VIEW_KEYS } from '../../../shared/view-saver';
import { useNeedsYouShows } from '../needs-you-setting';
import { useEscStep } from '../keys/esc-ladder';
import { useMenuBarAction } from '../keys/menu-bar-bridge';
import { useMinimapShown } from '../chrome/minimap-shown';
import { BoardMinimap } from '../chrome/ZoomControls';
import { isTyping } from '../keys/typing';
import { Button, ContextMenu, Island } from '../ui';
import { Composer } from '../session/Composer';
import { BoardBackdrop } from './BoardBackdrop';
import { patched } from './editing/use-history';
import { itemKind, ITEM_KINDS, ITEM_NODE_TYPES } from './items/kinds';
import { ItemActionsContext, isItemNode, withItem, withItemChange, withoutItem, type ItemActions, type ItemNodeType } from './items/items';
import { withRotation } from './items/Rotatable';
import { boardLevelFrom, MEMBER_PREFIX, MEMBER_SIZE, memberNodeId, memberPlaces, savedLevel, shownLevel, stillHeld, ticketMembers, type HeldPlace, type TicketBoardFocus } from './ticket-board';
import { HELPER_ICONS, OneButton } from './ticket-parts';
import { TicketWatchesMenu, WatchIcons } from './TicketWatches';
import { TileActionsContext } from './tile';
import { stopPropagation } from './tile-parts';
import { pulseTile } from './tile-attention';
import { motionDuration, tokenNumber } from '../theme';
import { expandedTrace, FIT_NOTED_MS } from './expanded-trace';
import { clearRooms, coveredView, fitView, UNCOVERED } from './view-follow';
import { helperIcon, ticketFace, type HelperIcon, type TicketFace } from './ticket-tile';
import { FrostBadge } from './FrostMark';

/**
 * The board level the window shows, kept in the view state so a relaunch lands where the user was: a ticket's own
 * board, or the main board. A level whose chat has left the board, or is no longer a ticket's chat, shows the main
 * board, and is cleared once the board has loaded.
 */
export function useBoardLevel(loaded: boolean, agents: readonly Agent[]) {
  const [level, setLevel] = useState<string | null>(null);
  // Once the user has chosen a level, the saved one read at launch, however late it comes, never overrides it.
  const chosen = useRef(false);
  useEffect(() => {
    window.agentBoard.view.get(VIEW_KEYS.boardLevel).then((saved) => chosen.current || setLevel(boardLevelFrom(saved)), () => {});
  }, []);
  const go = useCallback((next: string | null) => {
    chosen.current = true;
    setLevel(next);
    void window.agentBoard.view.set(VIEW_KEYS.boardLevel, savedLevel(next)).catch(() => {});
  }, []);
  const shown = shownLevel(level, agents);
  useEffect(() => {
    if (loaded && level !== null && shown === null) go(null);
  }, [loaded, level, shown, go]);
  return { level: shown, open: go, leave: useCallback(() => go(null), [go]) };
}


type MemberData = { agent: Agent } & ({ kind: 'chat'; face: TicketFace; team: readonly Agent[] } | { kind: 'helper'; helper: HelperIcon });
type MemberNode = Node<MemberData, 'member'>;
type TicketBoardNode = MemberNode | ItemNodeType;

/** How much room a tile or item shown from ⌘K or Needs you keeps round it, as a share of the view. */
const FOCUS_MARGIN = 0.5;
const isMemberNode = (node: Node): node is MemberNode => node.type === 'member';

/** Opens an agent on the ticket's board in its session window. */
const OpenMemberContext = createContext<(agent: Agent) => void>(() => {});

// Module-level so React Flow never sees a new object and re-mounts every node.
const nodeTypes: NodeTypes = {
  member: MemberTile,
  ...Object.fromEntries(Object.entries(ITEM_NODE_TYPES).map(([type, node]) => [type, withRotation(node)])),
};

interface TicketBoardProps {
  /** The ticket chat's session id: whose board this is. */
  chatId: string;
  agents: readonly Agent[];
  /** Zooms back out to the main board. */
  onLeave(): void;
  onOpenAgent(agent: Agent): void;
  onError(action: string): (error: unknown) => void;
  /** The board's dots, as the main board draws them. */
  desk: { gap: number; size: number };
  /**
   * A tile or item to show once it is drawn, by its node id here (`member:<session id>`, `item:<id>`): the board flies
   * to it, selects it alone and pulses it, as the main board does a tile picked in ⌘K. `nonce` asks again for the same.
   */
  focus?: TicketBoardFocus;
  /** Given, the items it shows, asking the daemon for none: a still board, as the gallery draws one. It then leaves the focus where it is. */
  shownItems?: readonly BoardItem[];
  /**
   * Drawn on a pop-up's Board tab rather than zoomed into: no breadcrumb, as its tab says where it is, and Esc is the
   * pop-up's. The main board's own level leaves an Esc from inside a pop-up be.
   */
  inPopUp?: boolean;
}

/**
 * A ticket's own board, zoomed into from its tile, over the main board: its chat and helpers as tiles to move, beside
 * the notes and documents on it, under a breadcrumb back out. Esc, or the breadcrumb, zooms out. A tile moved here keeps
 * its place on the main board: its place here is its own (`agent.placeOnTicket`).
 */
export function TicketBoard(props: TicketBoardProps) {
  return (
    <ReactFlowProvider>
      <TicketBoardShown {...props} />
    </ReactFlowProvider>
  );
}

function TicketBoardShown({ chatId, agents, onLeave, onOpenAgent, onError, desk, focus, shownItems, inPopUp = false }: TicketBoardProps) {
  const shows = useNeedsYouShows();
  const { screenToFlowPosition, getInternalNode, setViewport } = useReactFlow();
  const flowStore = useStoreApi();
  const members = useMemo(() => ticketMembers(chatId, agents), [chatId, agents]);
  const chat = members[0];
  const helpers = useMemo(() => members.slice(1), [members]);
  const face = chat === undefined ? undefined : ticketFace(chat, helpers, shows);

  const [items, setItems] = useState<ItemNodeType[]>();
  const itemsRef = useRef<ItemNodeType[]>([]);
  itemsRef.current = items ?? [];
  useEffect(() => {
    if (shownItems !== undefined) return setItems(shownItems.reduce<ItemNodeType[]>(withItem, []));
    setItems(undefined);
    let current = true;
    window.agentBoard.items.list(chatId).then(
      (listed) => current && setItems(listed.reduce<ItemNodeType[]>(withItem, [])),
      (error: unknown) => {
        if (current) setItems([]);
        onError('show the ticket’s board')(error);
      },
    );
    const unsubscribe = window.agentBoard.items.onChanged((change) => setItems((known) => known && withItemChange(known, change, chatId)));
    return () => {
      current = false;
      unsubscribe();
    };
  }, [chatId, onError, shownItems]);

  // The members as tiles, each where it was placed here; React Flow's own marks (selected, measured, a drag's place) kept.
  // A tile just dropped stays where it was dropped until the daemon has saved its place, and goes back at once if it can't.
  const [held, setHeld] = useState<ReadonlyMap<string, HeldPlace>>(new Map());
  const [memberNodes, setMemberNodes] = useState<MemberNode[]>([]);
  const memberNodesRef = useRef<MemberNode[]>([]);
  memberNodesRef.current = memberNodes;
  useEffect(() => {
    const places = memberPlaces(members, held);
    setMemberNodes((known) =>
      members.map((agent) => {
        const id = memberNodeId(agent.sessionId);
        const before = known.find((node) => node.id === id);
        const place = places.get(agent.sessionId)!;
        const size = agent.ticketChat ? MEMBER_SIZE.chat : MEMBER_SIZE.helper;
        const data: MemberData = agent.ticketChat ? { agent, kind: 'chat', face: ticketFace(agent, helpers, shows), team: members } : { agent, kind: 'helper', helper: helperIcon(agent, shows) };
        return { ...before, id, type: 'member', position: before?.dragging === true ? before.position : place, ...size, data, zIndex: 1 };
      }),
    );
  }, [members, helpers, shows, held]);
  // A drop the daemon has saved, or moved on from, is let go.
  useEffect(() => {
    const done = [...held].filter(([sessionId, drop]) => {
      const member = members.find((each) => each.sessionId === sessionId);
      return member === undefined || !stillHeld(member, drop);
    });
    if (done.length > 0) setHeld((current) => new Map([...current].filter(([sessionId]) => !done.some(([gone]) => gone === sessionId))));
  }, [members, held]);
  const dropMember = useCallback(
    (agent: Agent, place: TicketBoardPlace) => {
      setHeld((current) => new Map(current).set(agent.sessionId, { place, from: agent.ticketPlace }));
      window.agentBoard.agents.placeOnTicket(agent.sessionId, place).catch((error: unknown) => {
        setHeld((current) => {
          const next = new Map(current);
          next.delete(agent.sessionId);
          return next;
        });
        onError('move it')(error);
      });
    },
    [onError],
  );

  const nodes = useMemo<TicketBoardNode[]>(() => [...memberNodes, ...(items ?? [])], [memberNodes, items]);

  // What was asked for is shown once it is here, and drawn: the items come later than the members, and the view's own
  // first fit comes once they are drawn.
  const shownFocus = useRef<number>(undefined);
  const drawn = useNodesInitialized();
  const focusHere = focus !== undefined && items !== undefined && drawn && nodes.some((node) => node.id === focus.nodeId);
  useEffect(() => {
    if (focus === undefined || !focusHere || shownFocus.current === focus.nonce) return;
    shownFocus.current = focus.nonce;
    const only = (node: Node) => (node.id === focus.nodeId ? node.selected !== true : node.selected === true);
    setMemberNodes((known) => (known.some(only) ? known.map((node) => ({ ...node, selected: node.id === focus.nodeId })) : known));
    setItems((known) => known && (known.some(only) ? known.map((node) => ({ ...node, selected: node.id === focus.nodeId })) : known));
    const duration = motionDuration(tokenNumber('--motion-base'));
    // Clear of the side panels open over the board and of its minimap, as on the main board.
    const node = getInternalNode(focus.nodeId);
    const { width, height, minZoom, domNode } = flowStore.getState();
    const { width: tileWidth, height: tileHeight } = node?.measured ?? {};
    if (node !== undefined && tileWidth !== undefined && tileHeight !== undefined) {
      const rect = { ...node.internals.positionAbsolute, width: tileWidth, height: tileHeight };
      const rooms = clearRooms({ width, height }, domNode === null ? UNCOVERED : coveredView(domNode, domNode));
      expandedTrace.noteView('focus', 'ticketBoard');
      void setViewport(fitView(rect, rooms, minZoom, 1, FOCUS_MARGIN), { duration });
    }
    pulseTile(focus.nodeId, duration);
  }, [focus, focusHere, getInternalNode, setViewport, flowStore]);
  const onNodesChange = useCallback((changes: NodeChange<TicketBoardNode>[]) => {
    const kept = changes.filter((change) => change.type !== 'remove' && change.type !== 'add' && change.type !== 'replace');
    const isMember = (change: NodeChange<TicketBoardNode>) => 'id' in change && change.id.startsWith(MEMBER_PREFIX);
    setMemberNodes((known) => applyNodeChanges(kept.filter(isMember), known) as MemberNode[]);
    setItems((known) => known && (applyNodeChanges(kept.filter((change) => !isMember(change)), known) as ItemNodeType[]));
  }, []);

  const itemActions = useMemo<ItemActions>(
    () => ({
      update(params) {
        const known = itemsRef.current.find((node) => node.data.item.id === params.id);
        if (known === undefined) return;
        setItems((current) => current && withItem(current, patched(known.data.item, params)));
        window.agentBoard.items.update(params).catch(onError(`save the ${itemKind(known.data.item.kind).label}`));
      },
      remove(id) {
        setItems((current) => current && withoutItem(current, id));
        window.agentBoard.items.delete(id).catch(onError('remove it'));
      },
      openLink: (url) => void window.agentBoard.trackers.openLink(url).catch(onError('open the link')),
    }),
    [onError],
  );

  /** A new sticky note on the ticket's board, centred at `centre`, ready to type into. */
  const addNote = useCallback(
    (centre: { x: number; y: number }) => {
      const { size, newData } = ITEM_KINDS.sticky;
      const at = { x: centre.x - size.width / 2, y: centre.y - size.height / 2 };
      window.agentBoard.items
        .create({ kind: 'sticky', ticket: chatId, zoneId: null, ...at, ...size, rotation: 0, data: newData?.({}) ?? {} })
        .then(
          (made) =>
            setItems((current) => {
              const shown = withItem(current ?? [], made);
              return shown.map((node) => (node.data.item.id === made.id ? { ...node, selected: true, data: { ...node.data, editing: true } } : { ...node, selected: false }));
            }),
          onError('add the sticky note'),
        );
    },
    [chatId, onError],
  );

  // The minimap shows this level while it is shown: on or off for every level at once, and View › Minimap turns it here.
  // A still board (the gallery's) always shows it, so its picture doesn't hang on the setting.
  const [minimap, setMinimap] = useMinimapShown();
  useMenuBarAction('minimap', () => setMinimap(!minimap), minimap);

  useEscStep(
    'level',
    (event) => {
      if (inPopUp || isTyping(event) || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
      const active = document.activeElement;
      return active === null || active === document.body || (active.closest('.react-flow, .ticket-board') !== null && active.closest('.agent-popup') === null);
    },
    onLeave,
  );
  // The board's own menu, on a right-click on its background: what lays out its tiles. A still board (the gallery's) has none.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number }>();
  const arrange = useCallback(() => {
    window.agentBoard.orchestrators.arrangeTicket(chatId).catch(onError('arrange the ticket’s board'));
  }, [chatId, onError]);
  // The keys are the level's once it opens: the focus leaves what opened it (a tile's ⋯ under it, whose own Esc
  // would act on that tile) for this board. A still board (the gallery's) leaves the focus to the page around it.
  const root = useRef<HTMLDivElement>(null);
  const shown = chat !== undefined;
  const still = shownItems !== undefined;
  useEffect(() => {
    if (shown && !still && !root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true });
  }, [chatId, shown, still]);

  if (chat === undefined || face === undefined) return null;

  return (
    <div
      ref={root}
      className="ticket-board"
      tabIndex={-1}
      data-in-pop-up={inPopUp || undefined}
      data-testid="ticket-board"
      data-ticket={chatId}
      // The main board's own handlers (a note on a double-click, drops) are under this one: nothing here reaches them.
      onDoubleClick={(event: MouseEvent) => {
        event.stopPropagation();
        if ((event.target as HTMLElement).classList.contains('react-flow__pane')) addNote(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      }}
      onDragOver={(event) => event.stopPropagation()}
      onDrop={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      // Enter opens the member focused, or the one member selected, in its session window, as on the main board.
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== 'Enter' || isTyping(event.nativeEvent) || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        // A button's own Enter is its press.
        if ((event.target as HTMLElement).closest('button, a') !== null) return;
        const focused = (event.target as HTMLElement).closest<HTMLElement>('.react-flow__node-member')?.dataset.id;
        const selected = memberNodesRef.current.filter((node) => node.selected === true);
        const node = focused !== undefined ? memberNodesRef.current.find((each) => each.id === focused) : selected.length === 1 ? selected[0] : undefined;
        if (node === undefined) return;
        event.preventDefault();
        onOpenAgent(node.data.agent);
      }}
    >
      <div className="island-top-centre ticket-board-bar">
        {!inPopUp && (
        <Island className="ticket-board-crumb" data-testid="ticket-board-crumb" role="navigation" aria-label="Board level">
          <button type="button" className="ticket-board-crumb-back" data-testid="ticket-board-back" title="Back to the board (Esc)" onClick={onLeave}>
            <ChevronLeft aria-hidden />
            Board
          </button>
          <ChevronRight aria-hidden className="ticket-board-crumb-sep" />
          <span className="ticket-board-crumb-here" aria-current="page">
            <Ticket aria-hidden className="ticket-board-crumb-icon" />
            {face.ticketId !== undefined && <b>{face.ticketId}</b>}
            <span className="ticket-board-crumb-title">{face.title}</span>
          </span>
        </Island>
        )}
        {(face.watches.length > 0 || chat.watch !== undefined) && (
          // Its watches' news, beside the breadcrumb: what the eye and the icons on its tile say.
          <Island className="ticket-board-watches" data-testid="ticket-board-watches" role="group" aria-label="Its watches">
            <WatchIcons icons={face.watches} />
            <TicketWatchesMenu chat={chat} name={face.ticketId ?? face.title} />
          </Island>
        )}
      </div>
      {items !== undefined && (
        <OpenMemberContext value={onOpenAgent}>
          <ItemActionsContext value={itemActions}>
            <ReactFlow<TicketBoardNode>
              nodes={nodes}
              edges={[]}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onPaneContextMenu={
                still
                  ? undefined
                  : (event) => {
                      event.preventDefault();
                      setMenuAt({ x: event.clientX, y: event.clientY });
                    }
              }
              onNodeDragStop={(_event, _node, dragged) => {
                for (const node of dragged) {
                  const { x, y } = node.position;
                  if (isMemberNode(node)) dropMember(node.data.agent, { x, y });
                  else if (isItemNode(node)) itemActions.update({ id: node.data.item.id, x, y });
                }
              }}
              deleteKeyCode={null}
              zoomOnDoubleClick={false}
              panOnScroll
              panOnScrollMode={PanOnScrollMode.Free}
              zoomOnScroll={false}
              zoomOnPinch
              panOnDrag={[1]}
              selectionOnDrag
              panActivationKeyCode="Space"
              multiSelectionKeyCode="Shift"
              elevateNodesOnSelect={false}
              minZoom={0.1}
              fitView
              fitViewOptions={{ maxZoom: 1 }}
              onInit={() => expandedTrace.noteView('fitOnOpen', 'ticketBoard', FIT_NOTED_MS)}
              onMoveStart={(event, viewport) => expandedTrace.moveStarted(event !== null, viewport, 'ticketBoard')}
              onMoveEnd={(_event, viewport) => expandedTrace.moveEnded(viewport, 'ticketBoard')}
              proOptions={{ hideAttribution: true }}
            >
              <BoardBackdrop gap={desk.gap} size={desk.size} />
              {(minimap || still) && <BoardMinimap nodeColor={minimapColor} label="Minimap of the ticket’s board" />}
            </ReactFlow>
          </ItemActionsContext>
        </OpenMemberContext>
      )}
      {menuAt !== undefined && (
        <ContextMenu
          at={menuAt}
          label="Ticket board"
          entries={[{ label: 'Arrange', icon: <LayoutDashboard />, hint: 'Its chat and helpers beside its notes; nothing on the main board moves', onSelect: arrange }]}
          onClose={() => setMenuAt(undefined)}
        />
      )}
    </div>
  );
}

/** A node's colour on the ticket board's minimap: a note's own, a helper that needs you in the needs-you orange, else a tile's. */
function minimapColor(node: Node): string {
  const shown = node as TicketBoardNode;
  if (isItemNode(shown)) return itemKind(shown.data.item.kind).minimapColor(shown.data.item.data);
  if (isMemberNode(shown) && shown.data.kind === 'helper' && shown.data.helper.state === 'you') return 'var(--state-waiting)';
  return 'var(--raised)';
}

/**
 * A tile on a ticket's board: its chat, with its ticket, line, a box to message it, its state word and its one button
 * (Open when it asks nothing); or a helper, with its role's icon. A double-click, or Enter, opens its window.
 */
function MemberTile({ data, selected }: NodeProps<MemberNode>) {
  const open = useContext(OpenMemberContext);
  const { openPullRequest, wakeAgent, readWatches } = useContext(TileActionsContext);
  if (data.kind === 'chat') {
    const { face, agent, team } = data;
    const prOwner = face.pr === undefined ? undefined : team.find((each) => each.pullRequests.includes(face.pr!));
    return (
      <div className="ticket-board-tile ticket-board-chat" data-testid="ticket-board-chat" data-selected={selected || undefined} data-ask={face.ask} title="Double-click to open its session window" onDoubleClick={() => open(agent)}>
        <span className="ticket-board-tile-head">
          <MessageSquare aria-hidden className="ticket-board-tile-icon" />
          <b>Ticket chat</b>
        </span>
        <span className="ticket-board-tile-line">{face.line ?? face.title}</span>
        {/* Typing here messages the ticket's chat; the tile neither drags nor zooms from it, nor opens on a double-click. */}
        <div className="ticket-board-composer nodrag nowheel" onDoubleClick={stopPropagation}>
          <Composer agent={agent} placeholder="Message the ticket…" />
        </div>
        <span className="ticket-board-chat-foot">
          <span className="ticket-tile-state" data-kind={face.wordKind}>
            <span className="ticket-tile-dot" aria-hidden />
            {face.word}
          </span>
          {face.button !== undefined ? (
            <OneButton
              button={face.button}
              onOpen={() => open(face.asker)}
              onMerge={() => prOwner !== undefined && openPullRequest(prOwner, face.pr!)}
              onWake={() => wakeAgent(face.asker)}
              onRead={() => readWatches(agent.sessionId)}
            />
          ) : (
            <Button size="xs" variant="secondary" className="ticket-tile-act nodrag" data-testid="ticket-board-open" title="Open its session window, to message the ticket" onClick={() => open(agent)} onDoubleClick={stopPropagation}>
              Open
            </Button>
          )}
        </span>
      </div>
    );
  }
  const { helper } = data;
  return (
    <div
      className="ticket-helper-card ticket-board-tile ticket-board-helper"
      data-testid="ticket-board-helper"
      data-kind={helper.kind}
      data-state={helper.state}
      data-ask={helper.state === 'you' || undefined}
      data-selected={selected || undefined}
      title={`${helper.title}. Double-click to open its window`}
      onDoubleClick={() => open(data.agent)}
    >
      <span className="ticket-helper-card-icon" data-state={helper.state} data-frozen={helper.frozen}>
        {HELPER_ICONS[helper.kind]}
        <FrostBadge kind={helper.frozen} />
      </span>
      <b className="ticket-helper-card-name">{helper.name}</b>
      <span className="ticket-helper-card-word" data-state={helper.state} data-frozen={helper.frozen}>
        {helper.word}
      </span>
      <span className="ticket-helper-card-line">{helper.line}</span>
    </div>
  );
}
