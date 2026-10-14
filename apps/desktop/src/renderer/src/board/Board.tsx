import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  ReactFlowProvider,
  PanOnScrollMode,
  SelectionMode,
  getViewportForBounds,
  useNodesState,
  useReactFlow,
  useStoreApi,
  useUpdateNodeInternals,
  ViewportPortal,
  type EdgeChange,
  type EdgeTypes,
  type FinalConnectionState,
  type Node,
  type NodeTypes,
  type Rect,
  type Viewport,
} from '@xyflow/react';
import {
  DEFAULT_ZONE_SIZE,
  MIN_ZONE_SIZE,
  ZONE_COLORS,
  type Agent,
  issueCardData,
  type IssueCardData,
  type TrackerIssue,
  type BoardItem,
  type BoardItemKind,
  DEFAULT_CONNECTOR_LOOK,
  type Connector,
  type ConnectorEnd,
  type ConnectorSide,
  type UpdateConnectorParams,
  type UpdateItemParams,
  type ExternalSession,
  type Shell,
  type Zone,
  type ZoneBinding,
  type TileMove,
  type ZoneLayout,
} from '@agent-board/daemon/protocol';
import { paneIds } from '@agent-board/daemon/pane-layout';
import { repoZoneOf } from '@agent-board/daemon/repo-zone';
import { BoardChrome } from '../chrome/BoardChrome';
import type { PointerMode } from '../chrome/CreateToolbar';
import type { ZoneSource } from '../chrome/zones';
import { errorMessage } from '../../../shared/errors';
import { ZOOM_KEY } from '../keys';
import { tokenNumber } from '../theme';
import { Button, ContextMenu, Dialog, MENU_FOCUS_RETURN_MS, useToast } from '../ui';
import { SessionWindowsLayer, useSessionWindows } from '../windows/SessionWindows';
import type { NavSession } from '../windows/session-nav';
import { requestReviewTab } from '../review/review-tab';
import { shownWindow } from '../windows/session-windows';
import { ConnectorActionsContext, type ConnectorActions } from './connectors/actions';
import { ConnectorEdge, ConnectorMarkers } from './connectors/ConnectorEdge';
import { withConnectorHandles } from './connectors/ConnectorHandles';
import {
  connectorEdges,
  CONNECTOR_EDGE_PREFIX,
  connectorIdOf,
  endOfNode,
  isConnectorEdge,
  nearestSide,
  newEndAt,
  nodeIdOf,
  withConnector,
  withConnectorChange,
} from './connectors/endpoints';
import { AddZonePopover } from './AddZonePopover';
import { draggedZoneLayout, popoverPlacement } from './add-zone';
import { AgentFlowEdge, BriefEdge, FlowEdgeActionsContext } from './FlowEdge';
import { FLOW_EDGE_TYPE, FLOW_PORTS, flowEdgeIdOf, flowEdges, handoffEnds, HandoffsContext, isFlowEdge, isFlowPort, panClear } from './flow-edges';
import { useFlowEdges } from './use-flow-edges';
import { ConnectionLine } from './ConnectionLine';
import { EdgeRules } from './EdgeRules';
import { BRIEF_EDGE_TYPE, briefEdges, cardHasAgent, issueCardFor } from './brief-edges';
import { handlesLost } from './handle-bounds';
import { withSavedPlace } from './saved-place';
import { IssueCardDialog } from './IssueCardDialog';
import type { PickedIssue } from './IssuePicker';
import { IssueCardContext, type IssueCardActions } from './items/IssueNode';
import { withoutZone, withZone } from './zone-nodes';
import { BOARD_CLIPBOARD_TYPE } from './editing/clipboard';
import { boardEntries, selectionEntries, type ContextActions } from './editing/context-menu';
import type { States } from './editing/history';
import { SelectionBox, SnapGuides } from './editing/SelectionOverlays';
import { useEditing } from './editing/use-editing';
import { renameDirect, renameKey, paneLabel, RenameRequestContext, type RenameTarget } from './rename';
import { historyKey, useHistory, type BoardState, type Change } from './editing/use-history';
import { useSnapping } from './editing/use-snapping';
import {
  bringToFront,
  collapseFront,
  collapseTile,
  allowingOverlap,
  collapsedBetween,
  expandedFrom,
  keepSizes,
  rememberSize,
  sizesFrom,
  type ExpandedSizes,
  expandTile,
  keepExpanded,
  keepOverlaps,
  overlapsFrom,
  type OverlapsAllowed,
  withoutOverlaps,
  VIEW_FOLLOW_DELAY_MS,
  resizeExpanded,
  type ExpandedTiles,
} from './expanded';
import { clickOpensFrom, tileOpenAction, type ClickOpens } from './click-opens';
import {
  isItemNode,
  ITEM_NODE_PREFIX,
  ItemActionsContext,
  placeOnBoard,
  SeveralSelectedContext,
  withItem,
  withItemChange,
  withoutItem,
  type ItemActions,
  type ItemChange,
  type ItemNodeType,
} from './items/items';
import { MIN_SHAPE_SIZE } from './items/ShapeNode';
import { ITEM_KINDS, ITEM_NODE_TYPES, type ItemKind } from './items/kinds';
import { classifyDrop, classifyPaste, imageBoardSize, imageProblem, type Incoming } from './items/paste';
import type { ConnectorChange, ShellChange, WindowTarget, ZoneChange } from '../../../preload/api';
import { VIEW_KEYS, viewSaver } from '../../../shared/view-saver';
import { useProvideBoardCommands, type BoardCommands } from './commands';
import { AGENT_TILE_SIZE, freeItemSpot, freeSpotFor, ZONE_PADDING } from './layout';
import { tidyLoose as tidyLooseLayout, tidyZone as tidyZoneLayout } from './tidy';
import { LinkIssueDialog } from './LinkIssueDialog';
import { ScheduleDialog } from './ScheduleDialog';
import { ResumeExternalDialog } from './ResumeExternalDialog';
import { NewAgentDialog } from './NewAgentDialog';
import { DefaultRepoDialog } from './DefaultRepoDialog';
import { useRestartBanner } from './RestartBanner';
import { changeBacklog } from './change-backlog';
import { placeholderCount, placeholderStickies, placeholderTiles } from './placeholders';
import { DEFAULT_REPRESENTATION, RepresentationProvider } from './representations';
import { TileNode } from './TileNode';
import { ClickOpensContext, ShellFoldersContext, TileActionsContext, type ShellFolders, type TileActions, type TileData, type TileNodeType } from './tile';
import {
  DRAGGED_TILE_Z_INDEX,
  isSessionTile,
  isZone,
  layoutOf,
  shellWithPane,
  subjectOf,
  tileNodeId,
  tileSubject,
  withTiles,
  type BoardNode,
} from './tiles';
import { ToolOverlay, TOOL_DRAG_MIN, type ArmedTool } from './ToolOverlay';
import { usePlaceSession } from './use-place-session';
import { issueStartIn } from './place-session';
import {
  AddIssueContext,
  BindZoneContext,
  ZoneBindingContext,
  type ZoneBindingActions,
  CancelCloneContext,
  DropTargetContext,
  NewAgentContext,
  NewShellContext,
  SaveZoneLayoutContext,
  whyNoAgents,
  ZoneNode,
  zoneNode,
  ZoneResizeContext,
  ZoneTrackerContext,
} from './ZoneNode';
import { ZoneTrackerDialog } from './ZoneTrackerDialog';
import { droppedOnto } from './displace';
import { useDisplaced } from './use-displaced';
import { DRAG_THRESHOLD, isTyping, useTileMoves } from './use-tile-moves';
import { useZoneResize } from './use-zone-resize';

// Module-level so React Flow never sees a new object and re-mounts every node.
const nodeTypes: NodeTypes = {
  zone: withConnectorHandles(ZoneNode),
  tile: withConnectorHandles(TileNode),
  ...Object.fromEntries(Object.entries(ITEM_NODE_TYPES).map(([type, node]) => [type, withConnectorHandles(node)])),
};
const edgeTypes: EdgeTypes = { connector: ConnectorEdge, [BRIEF_EDGE_TYPE]: BriefEdge, [FLOW_EDGE_TYPE]: AgentFlowEdge };

/**
 * Where a connector dragged from a handle was let go: on an object, on empty board, or on
 * something else, such as the toolbar, where nothing is made. A zone counts only by its tab (or a handle): its body is
 * where a new note goes.
 */
type ConnectorDrop = { type: 'node'; nodeId: string } | { type: 'board' } | { type: 'nothing' };

function dropAt(point: { x: number; y: number }, zoneIds: ReadonlySet<string>): ConnectorDrop {
  for (const element of document.elementsFromPoint(point.x, point.y)) {
    const node = element.closest<HTMLElement>('.react-flow__node');
    const nodeId = node?.dataset.id;
    if (nodeId !== undefined) {
      if (zoneIds.has(nodeId) && element.closest('.zone-tab') === null) continue;
      return { type: 'node', nodeId };
    }
    if (element.classList.contains('react-flow__pane')) return { type: 'board' };
    if (element.closest('.react-flow__panel, .react-flow__minimap, .react-flow__controls, .connector-bar, .connector-label')) {
      return { type: 'nothing' };
    }
  }
  return { type: 'nothing' };
}

/** How much room bringing something into view leaves round what it shows, as a fraction of the view (not a spacing token). */
const FIT_MARGIN = 0.15;

/** The keys that arm a tool (T, S, Z, A and `). */
const TOOL_KEYS: Record<string, ArmedTool> = { t: 'text', s: 'shape', z: 'zone', a: 'agent', '`': 'shell' };

/** `items` with `item` added, or replacing the one with the same key. */
function upsertBy<T>(items: T[], item: T, key: (item: T) => string): T[] {
  const index = items.findIndex((known) => key(known) === key(item));
  return index < 0 ? [...items, item] : items.with(index, item);
}

const upsert = (agents: Agent[], agent: Agent) => upsertBy(agents, agent, (known) => known.sessionId);
/** `shells` with a heard change applied. */
const applyShellChange = (shells: Shell[], change: ShellChange) =>
  change.type === 'shell.updated' ? upsertBy(shells, change.shell, (known) => known.id) : shells.filter((shell) => shell.id !== change.shellId);
const upsertExternal = (externals: ExternalSession[], session: ExternalSession) =>
  upsertBy(externals, session, (known) => known.id);

/** What a shell tile's window calls it. */
function shellTitle(shell: Shell): string {
  return `${shell.name} · ${shell.cwd}`;
}

/** A tile with a session window (an agent's or a shell's), as the session window's steps see it: an external has none. */
function navSessionOf(node: TileNodeType): NavSession[] {
  const { agent, shell } = node.data;
  const target: WindowTarget | undefined =
    agent !== undefined
      ? { kind: 'session', id: agent.sessionId, title: agentTitle(agent) }
      : shell !== undefined
        ? { kind: 'shell', id: shell.id, title: shellTitle(shell) }
        : undefined;
  return target === undefined ? [] : [{ target, zoneId: node.parentId ?? null, ...node.position }];
}

/** What an agent's session window calls it. */
function agentTitle(agent: Agent): string {
  return `${agent.name} · ${agent.branch}`;
}

/** `item` with the change in `patch` made, as the daemon will make it. */
function patched(item: BoardItem, patch: UpdateItemParams): BoardItem {
  return { ...item, ...patch, data: patch.data === undefined ? item.data : { ...item.data, ...patch.data } };
}

/** The infinite board (ADR-0003): zones from the daemon, tiles drawn by the board's representation. */
export function Board() {
  return (
    <ReactFlowProvider>
      <BoardView />
    </ReactFlowProvider>
  );
}

/** The toast id of the board's one notice: a newer failure replaces it, so they don't pile up. */
const NOTICE = 'board-notice';

/**
 * A delete waiting for the user to confirm it: of a live agent, or one that would lose work (`force`); or of a shell
 * tile with live panes.
 */
type PendingDelete = { message: string } & ({ kind: 'agent'; sessionId: string; force: boolean } | { kind: 'shell'; shellId: string });

/** What a click on a node presses rather than the node itself: its buttons, fields and links, and what takes input. */
/** How long a rename request waits for its tile to open its field before it lapses, ms. */
const RENAME_REQUEST_MS = 250;

const CONTROLS = 'button, a, input, textarea, select, [role="menuitem"], .nodrag, .editable-name';

/** How many times the board lists agents again when changes keep landing while the list is in flight. */
const MAX_AGENT_LIST_ATTEMPTS = 5;

function BoardView() {
  const [nodes, setNodes, applyNodeChanges] = useNodesState<BoardNode>([]);
  const [loaded, setLoaded] = useState(false);
  /**
   * Whether the board had anything on it when it loaded, so the view fits it. Fixed at load: React Flow holds a
   * fit until the first nodes appear, so on an empty board the first note would otherwise jump to the middle.
   */
  const [fitOnLoad, setFitOnLoad] = useState(false);
  /** Whether the board held nothing at all when it loaded: no zone, item, agent, shell or external session. */
  const [loadedEmpty, setLoadedEmpty] = useState(false);
  /** Where the view was when the board was last left (`VIEWPORT_KEY`), to open on instead of fitting. */
  const [savedViewport, setSavedViewport] = useState<Viewport>();
  /** Saves where the view is, once it has stopped moving for a moment. */
  const saveViewport = useMemo(() => viewSaver((value) => window.agentBoard.view.set(VIEW_KEYS.viewport, value), SAVE_VIEWPORT_DELAY_MS), []);
  const toasts = useToast();
  /** Shows why something failed, as the board's one notice; `retry` tries it again. Undefined takes it down. */
  const setNotice = useCallback(
    (notice?: { message: string; retry?: () => void }) => {
      if (notice === undefined) toasts.dismiss(NOTICE);
      else {
        const { message, retry } = notice;
        toasts.show({ id: NOTICE, tone: 'error', message, action: retry && { label: 'Retry', onClick: retry } });
      }
    },
    [toasts],
  );
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  /** The connectors selected, by id. React Flow reports a selection, and the edges are drawn from `connectors`. */
  const [selectedConnectors, setSelectedConnectors] = useState<ReadonlySet<string>>(new Set());
  const selectedConnectorsRef = useRef(selectedConnectors);
  selectedConnectorsRef.current = selectedConnectors;
  /** Whether a drag snaps to the grid rather than to what is near it; kept in the view state. */
  const [grid, setGrid] = useState(false);
  /** What was selected as a Shift-drag on empty board began: its marquee adds to that (WbTools). */
  const keptSelection = useRef<{ nodes: ReadonlySet<string>; connectors: ReadonlySet<string> }>(undefined);
  /** The tile (node id) F2 or the context menu asked to rename, until it opens its field. */
  const [renameRequest, setRenameRequest] = useState<string>();
  const renameRequests = useMemo(() => ({ nodeId: renameRequest, done: () => setRenameRequest(undefined) }), [renameRequest]);
  // A tile not drawn (off screen, with only visible elements rendered) never answers: drop the ask rather than let it
  // open the field whenever the tile scrolls into view.
  useEffect(() => {
    if (renameRequest === undefined) return;
    const timer = setTimeout(() => setRenameRequest(undefined), RENAME_REQUEST_MS);
    return () => clearTimeout(timer);
  }, [renameRequest]);
  /** The context menu open, where it was asked for and on what: the selection, or empty board. */
  const [contextMenu, setContextMenu] = useState<{ at: { x: number; y: number }; on: 'selection' | 'board' }>();
  /** The connector whose label is being typed. */
  const [editingConnector, setEditingConnector] = useState<string>();
  /** Whether a connector is being dragged from a handle: every object shows its handles, and the one under it is marked. */
  const [connecting, setConnecting] = useState(false);
  /** Whether a new flow edge is being drawn from a tile's flow port: every agent's tile shows its ports. */
  const [drawingFlow, setDrawingFlow] = useState(false);
  /** Whether Escape has called off the flow edge being dragged: letting go then joins nothing. */
  const flowDrawCancelled = useRef(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [externals, setExternals] = useState<ExternalSession[]>([]);
  /** Undefined until listed. */
  const [shells, setShells] = useState<Shell[]>();
  /** The zone a new agent is being asked for, with the issue it starts from and where its tile goes, if known. */
  const [newAgent, setNewAgent] = useState<{ zone: Zone; issue?: PickedIssue; card?: IssueCardData }>();
  const setNewAgentZone = useCallback((zone: Zone | undefined) => setNewAgent(zone && { zone }), []);
  const [trackerZone, setTrackerZone] = useState<Zone>();
  /** The group whose default repo is being picked. */
  const [defaultRepoZone, setDefaultRepoZone] = useState<Zone>();
  /** Where Add zone's outline is on the board, and the tab it opened on, while it is open. */
  const [addingZone, setAddingZone] = useState<{ layout: ZoneLayout; source: ZoneSource }>();
  /** The zone whose issue is being picked, for its card or an agent. */
  const [issueZone, setIssueZone] = useState<Zone>();
  /** The zone a dragged tile or note would move into if dropped now. */
  const [dropTarget, setDropTarget] = useState<string>();
  /** The agent whose issue is being picked, and its zone. */
  const [linking, setLinking] = useState<{ agent: Agent; zone: Zone }>();
  const [scheduling, setScheduling] = useState<Agent>();
  const { windows, show: showWindow, close: closeWindow, popOut } = useSessionWindows();
  const windowsRef = useRef(windows);
  windowsRef.current = windows;
  /**
   * The tiles expanded in place, back to front, with their sizes: the one place the board keeps
   * which are open.
   */
  const [expanded, setExpanded] = useState<ExpandedTiles>([]);
  /** The size each tile was last let go at once resized while expanded: it opens at that size again. */
  const [expandedSizes, setExpandedSizes] = useState<ExpandedSizes>({});
  const expandedSizesRef = useRef(expandedSizes);
  expandedSizesRef.current = expandedSizes;
  /** What a double-click on an agent's or shell tile opens: read with the board, so the first one already obeys it. */
  const [clickOpens, setClickOpens] = useState<ClickOpens>('window');
  const pickClickOpens = useCallback((value: ClickOpens) => {
    setClickOpens(value);
    void window.agentBoard.view.set(VIEW_KEYS.clickOpens, value).catch(() => {});
  }, []);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  /** Which tile the user dragged onto which, one of the two expanded: the two may overlap. */
  const [overlapsAllowed, setOverlapsAllowed] = useState<OverlapsAllowed>(new Map());
  /**
   * The nodes as drawn: the expanded tiles kept apart and what they would cover moved clear of them until they collapse
   *, never saved.
   */
  const shown = useDisplaced(nodes, expanded, overlapsAllowed);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const openShell = useCallback((shell: Shell) => showWindow({ kind: 'shell', id: shell.id, title: shellTitle(shell) }), [showWindow]);
  const openAgent = useCallback(
    (agent: Agent) => showWindow({ kind: 'session', id: agent.sessionId, title: agentTitle(agent) }),
    [showWindow],
  );
  /** The agent the user asked to open from its notification, until the board has its agents to open it. */
  const [openRequest, setOpenRequest] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>();
  /** An ended agent to restart once the user says so, as the shell its pane dropped into is running something. */
  const [pendingRestart, setPendingRestart] = useState<{ sessionId: string; message: string }>();
  /** The external session being resumed in agent-board, and where the board draws a tile it slotted into its zone. */
  const [resumingExternal, setResumingExternal] = useState<{ session: ExternalSession; position?: { x: number; y: number } }>();
  const { flowToScreenPosition, getInternalNode, getNodes, getZoom, screenToFlowPosition, setViewport } = useReactFlow<BoardNode>();
  const flowStore = useStoreApi<BoardNode>();

  /**
   * Brings a part of the board into view, zooming out if it must but never in. Not `fitView({ nodes })`: that waits for
   * the node to be measured, and a node off-screen is culled, so never measured, and the view jumps to the board's origin.
   */
  const bringIntoView = useCallback(
    (rect: Rect) => {
      const { width, height, minZoom } = flowStore.getState();
      void setViewport(getViewportForBounds(rect, width, height, minZoom, getZoom(), FIT_MARGIN), {
        duration: tokenNumber('--motion-base'),
      });
    },
    [flowStore, setViewport, getZoom],
  );
  /** The part of the board in view. */
  const viewRect = useCallback(() => {
    const { width, height, transform } = flowStore.getState();
    const [x, y, zoom] = transform;
    return { x: -x / zoom, y: -y / zoom, width: width / zoom, height: height / zoom };
  }, [flowStore]);
  /** Whether a part of the board is wholly in the view now. */
  const inView = useCallback(
    (rect: Rect) => {
      const view = viewRect();
      return rect.x >= view.x && rect.y >= view.y && rect.x + rect.width <= view.x + view.width && rect.y + rect.height <= view.y + view.height;
    },
    [viewRect],
  );
  const container = useRef<HTMLDivElement>(null);
  /** Where the pointer last was over the board, in screen coordinates: where `N` puts a new note. */
  const pointer = useRef<{ x: number; y: number }>(undefined);
  /** The agents as last rendered, for callbacks that must not re-create on every change. */
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const connectorsRef = useRef(connectors);
  connectorsRef.current = connectors;
  /** The board's nodes as last rendered, for callbacks that run as a node goes, before React Flow has caught up. */
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const externalsRef = useRef(externals);
  externalsRef.current = externals;
  const shellsRef = useRef(shells);
  shellsRef.current = shells;
  /** Set by every agent change, so a list that may have crossed one in flight can be retried. */
  const agentChanged = useRef(false);
  /**
   * Item, zone and connector changes that arrive before the board has loaded, to replay over what it loads: one may be
   * newer than the list. Once loaded, changes apply straight away.
   */
  const itemBacklog = useRef(changeBacklog<ItemChange>()).current;
  const zoneBacklog = useRef(changeBacklog<ZoneChange>()).current;
  const connectorBacklog = useRef(changeBacklog<ConnectorChange>()).current;
  /** Items made here that the daemon hasn't confirmed yet: a change to one waits for it. */
  const pendingCreates = useRef(new Map<string, Promise<unknown>>());
  /** Shell changes heard while the list is in flight, to replay over it; kept only while a list is. */
  const shellBacklog = useRef(changeBacklog<ShellChange>({ keeping: false })).current;
  /** Tiles moved here whose new place the daemon hasn't saved yet, by node id: they show there meanwhile. */
  const pendingPlaces = useRef(new Map<string, TileMove>());
  /**
   * Spots taken by loose shells being made, until their tiles are on the board (`shellId` once the daemon has made
   * one), so a second made meanwhile goes elsewhere.
   */
  const looseSpots = useRef(new Set<{ rect: ZoneLayout; shellId?: string }>());
  /** Each zone's layout as this window last saved it, for undoing its next move or resize. */
  const savedZoneLayouts = useRef(new Map<string, ZoneLayout>());
  /** Puts board objects back as an undo or redo has them; set once the board's actions are. */
  const applyStates = useRef<(states: States<BoardState>) => void>(() => {});
  const history = useHistory((states) => applyStates.current(states));

  /** `nodes` with the session tiles laid out from the agents, shells and external sessions, moves in flight applied. */
  const laidOut = useCallback(
    (nodes: BoardNode[]) =>
      withTiles(nodes, agentsRef.current, shellsRef.current ?? [], externalsRef.current, pendingPlaces.current, expandedRef.current),
    [],
  );
  const relayout = useCallback(() => setNodes(laidOut), [setNodes, laidOut]);

  // A tile expanded, collapsed, brought to the front or resized is laid out again.
  useEffect(() => {
    if (loaded) relayout();
  }, [loaded, expanded, relayout]);
  // An expanded tile collapses when it goes: its agent or shell deleted, its external session dismissed.
  useEffect(() => {
    if (!loaded || shells === undefined) return;
    const present = new Set([
      ...agents.map((agent) => tileNodeId('agent', agent.sessionId)),
      ...shells.map((shell) => tileNodeId('shell', shell.id)),
      ...externals.map((session) => tileNodeId('external', session.id)),
    ]);
    setExpanded((current) => keepExpanded(current, present));
    setExpandedSizes((current) => keepSizes(current, present));
    setOverlapsAllowed((current) => keepOverlaps(current, present));
  }, [loaded, agents, shells, externals]);
  // Saved as they change, to open again after a restart.
  const saveExpanded = useMemo(() => viewSaver((value) => window.agentBoard.view.set(VIEW_KEYS.expanded, value), SAVE_EXPANDED_DELAY_MS), []);
  useEffect(() => {
    if (loaded) saveExpanded(expanded);
  }, [loaded, expanded, saveExpanded]);
  const saveExpandedSizes = useMemo(
    () => viewSaver((value) => window.agentBoard.view.set(VIEW_KEYS.expandedSizes, value), SAVE_EXPANDED_DELAY_MS),
    [],
  );
  useEffect(() => {
    if (loaded) saveExpandedSizes(expandedSizes);
  }, [loaded, expandedSizes, saveExpandedSizes]);
  const saveOverlaps = useMemo(
    () => viewSaver((value) => window.agentBoard.view.set(VIEW_KEYS.expandedOverlaps, value), SAVE_EXPANDED_DELAY_MS),
    [],
  );
  useEffect(() => {
    if (loaded) saveOverlaps([...overlapsAllowed].toSorted());
  }, [loaded, overlapsAllowed, saveOverlaps]);
  // A pair ends when either of the two collapses: by its button, Esc, maximise, pop out or a window opened for it.
  const lastExpanded = useRef(expanded);
  useEffect(() => {
    const collapsed = collapsedBetween(lastExpanded.current, expanded);
    lastExpanded.current = expanded;
    if (collapsed.length > 0) setOverlapsAllowed((current) => withoutOverlaps(current, collapsed));
  }, [expanded]);
  // A session shown in its session window, on the board or popped out, is not also expanded: one terminal sizes it.
  useEffect(() => {
    const inWindows = new Set(
      windows
        .filter((entry) => entry.placement !== 'docked')
        .map((entry) => tileNodeId(entry.kind === 'shell' ? 'shell' : 'agent', entry.id)),
    );
    // On `expanded` too: the saved expanded tiles may arrive after the saved windows.
    if (expanded.some((entry) => inWindows.has(entry.id))) setExpanded((current) => current.filter((entry) => !inWindows.has(entry.id)));
  }, [windows, expanded]);

  /** Shows why `action` failed. */
  const report = useCallback(
    (action: string, retry?: () => void) => (error: unknown) =>
      setNotice({ message: `Could not ${action}: ${errorMessage(error)}`, retry }),
    [setNotice],
  );
  const flow = useFlowEdges(report, history.record);
  const flowEdgesRef = useRef(flow.edges);
  flowEdgesRef.current = flow.edges;

  // Subscribed before the first load. A change can still cross the list in flight and be older or newer than it, so
  // the load lists again until no change lands meanwhile.
  useEffect(
    () =>
      window.agentBoard.agents.onChanged((change) => {
        agentChanged.current = true;
        if (change.type === 'agent.updated') setAgents((current) => upsert(current, change.agent));
        else setAgents((current) => current.filter((agent) => agent.sessionId !== change.sessionId));
      }),
    [],
  );

  // Subscribed before the list, like agents: a change that crossed it is applied again on top.
  useEffect(
    () =>
      window.agentBoard.shells.onChanged((change) => {
        shellBacklog.hold(change);
        // Before the list arrives there is nothing to change: the change is applied over the list once it does.
        setShells((current) => current && applyShellChange(current, change));
        if (change.type === 'shell.removed') closeWindow(change.shellId);
      }),
    [closeWindow],
  );

  useEffect(
    () =>
      window.agentBoard.external.onChanged((change) => {
        if (change.type === 'external.updated') setExternals((current) => upsertExternal(current, change.session));
        else setExternals((current) => current.filter((session) => session.id !== change.id));
      }),
    [],
  );

  // Changes from this window come back too, and change nothing.
  useEffect(
    () =>
      window.agentBoard.items.onChanged((change) => {
        if (!itemBacklog.hold(change)) setNodes((current) => withItemChange(current, change));
      }),
    [setNodes],
  );

  /** Lists external sessions again: their zones are worked out by the daemon, so they move when zones are added. */
  const reloadExternals = useCallback(
    () => window.agentBoard.external.list().then(setExternals, report('list sessions from other terminals')),
    [report],
  );
  /** Zones cloning, added from here: the board says when each is done. */
  const clonesWatched = useRef(new Set<string>());

  // Zones change by themselves too: a clone's progress, its end, its failure.
  useEffect(
    () =>
      window.agentBoard.zones.onChanged((change) => {
        if (!zoneBacklog.hold(change)) setNodes((current) => withZoneChange(current, change));
        const id = change.type === 'zone.removed' ? change.id : change.zone.id;
        // Only the window that started a clone tells of its end: every window hears every zone change.
        const watched = clonesWatched.current.has(id);
        if (change.cloneFailed !== undefined) {
          clonesWatched.current.delete(id);
          if (watched) toasts.show({ tone: 'error', message: change.cloneFailed });
        } else if (change.type === 'zone.removed') {
          clonesWatched.current.delete(id);
        } else if (change.zone.repoRoot !== null && clonesWatched.current.delete(id)) {
          toasts.show({ tone: 'success', message: `${change.zone.name} is cloned: start agents in it` });
        }
        // External sessions in a newly cloned zone's folder move into it.
        if (change.type === 'zone.updated' && change.zone.repoRoot !== null && watched) void reloadExternals();
      }),
    [setNodes, toasts, reloadExternals],
  );

  // Changes from this window come back too, and change nothing. A connector that went with its object isn't announced.
  useEffect(
    () =>
      window.agentBoard.connectors.onChanged((change) => {
        if (!connectorBacklog.hold(change)) setConnectors((current) => withConnectorChange(current, change));
      }),
    [],
  );


  useEffect(() => {
    let cancelled = false;
    const listAgents = async (): Promise<Agent[]> => {
      for (let attempt = 1; ; attempt++) {
        agentChanged.current = false;
        const listed = await window.agentBoard.agents.list();
        if (!agentChanged.current || attempt === MAX_AGENT_LIST_ATTEMPTS) return listed;
      }
    };
    shellBacklog.start();
    Promise.all([
      window.agentBoard.zones.list(),
      listAgents(),
      window.agentBoard.external.list(),
      window.agentBoard.items.list(),
      window.agentBoard.shells.list(),
      window.agentBoard.connectors.list(),
      // A daemon that can't say (an older build) opens the board fitted, as before.
      window.agentBoard.view.get(VIEW_KEYS.viewport).catch(() => null),
      window.agentBoard.view.get(VIEW_KEYS.expanded).catch(() => null),
      window.agentBoard.view.get(VIEW_KEYS.clickOpens).catch(() => null),
      window.agentBoard.view.get(VIEW_KEYS.expandedSizes).catch(() => null),
      window.agentBoard.view.get(VIEW_KEYS.expandedOverlaps).catch(() => null),
    ]).then(
      ([zones, loadedAgents, loadedExternals, items, listedShells, listedConnectors, viewport, savedExpanded, savedClickOpens, savedSizes, savedOverlaps]) => {
        if (cancelled) return;
        const search = window.location.search;
        // Items after zones: a child node needs its parent first.
        const loadedZones = zoneBacklog.replayOver(zones.map(zoneNode) as BoardNode[], withZoneChange);
        const loadedNodes = itemBacklog.replayOver([
          ...items.reduce<BoardNode[]>(withItem, loadedZones),
          ...placeholderTiles(placeholderCount(search, 'placeholders')),
          ...placeholderStickies(placeholderCount(search, 'stickies')),
        ], withItemChange);
        setConnectors(connectorBacklog.replayOver(listedConnectors, withConnectorChange));
        setNodes(loadedNodes);
        setAgents(loadedAgents);
        setExternals(loadedExternals);
        const saved = viewportFrom(viewport);
        setSavedViewport(saved);
        setExpanded(expandedFrom(savedExpanded));
        setExpandedSizes(sizesFrom(savedSizes));
        setOverlapsAllowed(overlapsFrom(savedOverlaps));
        setClickOpens(clickOpensFrom(savedClickOpens));
        const held = loadedNodes.length + loadedAgents.length + loadedExternals.length + listedShells.length;
        setFitOnLoad(saved === undefined && held > 0);
        setLoadedEmpty(held === 0);
        setShells(shellBacklog.replayOver(listedShells, applyShellChange));
        setLoaded(true);
        setNotice(undefined);
      },
      (error: unknown) => {
        shellBacklog.drop();
        if (!cancelled) report('load the board', () => setLoadAttempt((n) => n + 1))(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [setNodes, report, loadAttempt]);

  // The refs laidOut reads are this render's.
  useEffect(() => {
    if (loaded) relayout();
  }, [loaded, agents, shells, externals, relayout]);

  // A new loose shell's tile is on the board now: its spot needs keeping no longer.
  useEffect(() => {
    for (const spot of looseSpots.current) {
      if (spot.shellId !== undefined && shells?.some((shell) => shell.id === spot.shellId)) looseSpots.current.delete(spot);
    }
  }, [shells]);

  // A notification's click opens its agent's session window, or brings it forward if it is popped out.
  useEffect(() => window.agentBoard.agents.onOpenRequested(setOpenRequest), []);
  useEffect(() => {
    if (!loaded || openRequest === undefined) return;
    const agent = agents.find((known) => known.sessionId === openRequest);
    if (agent !== undefined) openAgent(agent);
    setOpenRequest(undefined);
  }, [loaded, agents, openRequest, openAgent]);

  // The resizer reports its last size around when the layout is saved, so a zone left smaller than its tiles is grown
  // again once the resize is over.
  useEffect(() => {
    if (!loaded) return;
    const tooSmall = nodes.some((node) => {
      if (!isZone(node) || node.resizing === true || node.data.covers === undefined) return false;
      const layout = layoutOf(node);
      return layout.x + layout.width < node.data.covers.right || layout.y + layout.height < node.data.covers.bottom;
    });
    if (tooSmall) relayout();
  }, [loaded, nodes, relayout]);

  /** Deletes the agent; without `force`, the daemon refuses if that would lose work, and the user is asked. */
  const deleteAgent = useCallback(
    (sessionId: string, force: boolean) => {
      setPendingDelete(undefined);
      window.agentBoard.agents.delete(sessionId, force).then((result) => {
        if (result.status === 'unsaved') {
          const message = `${result.message}. Deleting the agent removes its worktree and branch, and that work with them.`;
          return setPendingDelete({ kind: 'agent', sessionId, message, force: true });
        }
        setAgents((current) => current.filter((agent) => agent.sessionId !== sessionId));
        closeWindow(sessionId);
      }, report('delete the agent'));
    },
    [report, closeWindow],
  );
  /** Restarts the ended agent; without `force`, the daemon refuses if its shell is running something, and the user is asked. */
  const restartAgent = useCallback(
    (sessionId: string, force: boolean) => {
      setPendingRestart(undefined);
      window.agentBoard.agents.restart(sessionId, force).then((result) => {
        if (result.status === 'busy') return setPendingRestart({ sessionId, message: `${result.message}. Restarting the agent ends it.` });
        setAgents((current) => upsert(current, result.agent));
      }, report('restart the agent'));
    },
    [report],
  );
  /** Deletes the shell tile and ends its panes. */
  const deleteShell = useCallback(
    (shellId: string) => {
      setPendingDelete(undefined);
      window.agentBoard.shells.delete(shellId).then(() => closeWindow(shellId), report('delete the shell'));
    },
    [report, closeWindow],
  );
  /** `moveTile`, for the tile actions made before it. */
  const moveTileRef = useRef<(nodeId: string, tile: TileData, move: TileMove) => void>(() => {});
  /** Where the view will move to show a tile just expanded, once it is laid out. */
  const viewFollow = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(viewFollow.current), []);
  /** The name of what a rename target names now, as the board last heard it: '' for a pane without a label. */
  const nameOf = useCallback((target: RenameTarget): string | undefined => {
    if (target.kind === 'agent') return agentsRef.current.find((agent) => agent.sessionId === target.sessionId)?.name;
    const shell = shellsRef.current?.find((known) => known.id === target.shellId);
    if (shell === undefined) return undefined;
    return target.kind === 'shell' ? shell.name : (paneLabel(shell, target.sessionId) ?? '');
  }, []);
  const tileActions = useMemo<TileActions>(
    () => ({
      expand(nodeId) {
        if (expandedRef.current.some((entry) => entry.id === nodeId)) return setExpanded((current) => bringToFront(current, nodeId));
        // Already in its own OS window: that comes forward instead.
        const subject = tileSubject(nodeId);
        const popped = windowsRef.current.find(
          (entry) => subject !== undefined && subject.kind !== 'external' && entry.id === subject.id && entry.placement === 'popped',
        );
        if (popped !== undefined) return showWindow(popped);
        setExpanded((current) => expandTile(current, nodeId, expandedSizesRef.current));
        // Opened, it makes room for itself, wherever it was dragged.
        setOverlapsAllowed((current) => withoutOverlaps(current, [nodeId]));
        // It opens rightwards and down from where its tile was: the view follows if it would open past the edge, once
        // it is laid out.
        clearTimeout(viewFollow.current);
        viewFollow.current = setTimeout(() => {
          const node = getInternalNode(nodeId);
          const entry = expandedRef.current.find((known) => known.id === nodeId);
          if (node === undefined || entry === undefined) return;
          const rect = { ...node.internals.positionAbsolute, width: entry.width, height: entry.height };
          if (!inView(rect)) bringIntoView(rect);
        }, VIEW_FOLLOW_DELAY_MS);
      },
      // Its session window, maximised: an agent's or a shell tile's (an external session has none).
      maximise(tile) {
        if (tile.agent !== undefined) openAgent(tile.agent);
        else if (tile.shell !== undefined) openShell(tile.shell);
      },
      collapse: (nodeId) => setExpanded((current) => collapseTile(current, nodeId)),
      resizeExpanded(nodeId, size, place) {
        setExpanded((current) => resizeExpanded(current, nodeId, size));
        setExpandedSizes((current) => rememberSize(current, nodeId, size));
        // Let go anywhere but where its place is saved, it stays there, saved as a drag of it would be: resized from its
        // left or top, which moves its top-left, or only drawn there, moved clear of another tile, which would
        // otherwise be laid out again from its saved place once the resize is over.
        const node = nodesRef.current.find((known) => known.id === nodeId);
        if (node === undefined || !isSessionTile(node)) return;
        const saved = pendingPlaces.current.get(nodeId) ?? subjectOf(node.data).position;
        if (saved === null || saved.x !== place.x || saved.y !== place.y) {
          moveTileRef.current(nodeId, node.data, { zoneId: node.parentId ?? null, ...place });
        }
      },
      openAgent,
      openShell,
      popOutAgent: (agent) => popOut({ kind: 'session', id: agent.sessionId, title: agentTitle(agent) }),
      popOutShell: (shell) => popOut({ kind: 'shell', id: shell.id, title: shellTitle(shell) }),
      // Live panes are processes that may be mid-command: ask first.
      deleteShell(shellId) {
        const shell = shellsRef.current?.find((known) => known.id === shellId);
        if (shell === undefined || shell.endedPanes.length === paneIds(shell.layout).length) return deleteShell(shellId);
        const message = `${shell.name} still has running shells. Deleting it ends them.`;
        setPendingDelete({ kind: 'shell', shellId, message });
      },
      // A live agent is never deleted on one click: it may be mid-task even with nothing to lose yet.
      deleteAgent(sessionId) {
        const agent = agentsRef.current.find((known) => known.sessionId === sessionId);
        if (agent === undefined || agent.endedAt !== null) return deleteAgent(sessionId, false);
        const message = agent.ownsWorktree
          ? `${agent.name} is still running. Deleting it ends its session and removes its worktree and branch.`
          : `${agent.name} is still running. Deleting it ends its session and takes it off the board; ${agent.cwd} is left as it is.`;
        setPendingDelete({ kind: 'agent', sessionId, message, force: false });
      },
      // From its own repo's zone, wherever its tile sits, picked as the daemon picks it.
      linkIssue(agent) {
        const zones = getNodes()
          .filter(isZone)
          .map((node) => ({ ...node.data.zone, hasTracker: node.data.zone.tracker !== null }));
        const zone = repoZoneOf(agent, zones);
        if (zone === undefined) return setNotice({ message: `No zone on the board is bound to ${agent.repoRoot}, to take issues from.` });
        if (zone.tracker === null)
          setNotice({ message: `Pick where ${zone.name}'s issues come from first: its tab's "issues" button.` });
        else setLinking({ agent, zone });
      },
      scheduleAgent: setScheduling,
      setMuted: (sessionId, muted) =>
        void window.agentBoard.agents.setMuted(sessionId, muted).then(
          (agent) => setAgents((current) => upsert(current, agent)),
          report(muted ? "mute the agent's notifications" : "unmute the agent's notifications"),
        ),
      openLink: (url) => void window.agentBoard.trackers.openLink(url).catch(report('open the link')),
      dismissExternal: (id) =>
        void window.agentBoard.external.dismiss(id).then(
          () => setExternals((current) => current.filter((session) => session.id !== id)),
          report('dismiss the session'),
        ),
      // Recorded for undo once it is saved, as the name the daemon kept. The tile follows the daemon's change event.
      rename: async (target, name) => {
        const before = nameOf(target);
        if (before === undefined) return;
        try {
          const saved = await renameDirect(target, name);
          history.record([[renameKey(target), { type: 'name', target, name: before }, { type: 'name', target, name: saved }]]);
        } catch (error) {
          report(target.kind === 'pane' ? 'label the pane' : 'rename it')(error);
          throw error;
        }
      },
      // A tile with no place of its own yet (slotted in its zone) is resumed where the board slotted it, relative to
      // its zone. Worked out from the board's own nodes, by hand rather than with `absoluteOf`, to get where it is
      // slotted, not where an expanded tile has pushed it for now.
      resumeExternal(session) {
        const node = nodesRef.current.find((each) => each.id === tileNodeId('external', session.id));
        let position: { x: number; y: number } | undefined;
        if (session.position === null && node !== undefined) position = { x: node.position.x, y: node.position.y };
        setResumingExternal({ session, position });
      },
      resumeAgent: (sessionId) =>
        window.agentBoard.agents.resume(sessionId).then((agent) => setAgents((current) => upsert(current, agent)), report('resume the agent')),
      restartAgent: (sessionId) => restartAgent(sessionId, false),
      resumeShell: (shell) =>
        Promise.all(shell.stoppedPanes.map((sessionId) => window.agentBoard.shells.resumePane(shell.id, sessionId))).then(
          () => {},
          report('resume the shell'),
        ),
      startReview: (agent) => void window.agentBoard.reviews.start(agent.sessionId).catch(report('start a review')),
      openReview(implementer) {
        const agent = agentsRef.current.find((known) => known.sessionId === implementer);
        if (agent === undefined) return;
        requestReviewTab(implementer);
        openAgent(agent);
      },
    }),
    [openAgent, openShell, showWindow, popOut, deleteAgent, deleteShell, restartAgent, getNodes, getInternalNode, inView, bringIntoView, report, history, nameOf],
  );

  const restartBanner = useRestartBanner(agents, shells, tileActions);

  /** The zones as laid out now, bottom one first, for placing an item or a tile. */
  const zoneLayouts = useCallback(
    (): (ZoneLayout & { id: string })[] =>
      getNodes()
        .filter(isZone)
        .map((zone) => ({ id: zone.id, ...layoutOf(zone) })),
    [getNodes],
  );

  const placeSession = usePlaceSession({
    zones: () => getNodes().filter(isZone).map((node) => node.data.zone),
    zoneLayouts,
    onAgent: (agent) => setAgents((current) => upsert(current, agent)),
    onShell: (shell) => {
      setShells((current) => applyShellChange(current ?? [], { type: 'shell.updated', shell }));
      openShell(shell);
    },
    report,
  });
  /** A zone's + agent: the New agent dialog in a bound zone, else straight on, or the repo picker, in a group. */
  const newAgentInZone = useCallback(
    (zone: Zone) => (zone.repoRoot !== null ? setNewAgentZone(zone) : placeSession.newAgentIn(zone)),
    [setNewAgentZone, placeSession],
  );

  /** Asks the daemon to save the move of `tile`'s session, and takes in what it answers. */
  // The answer is taken as far as it is newer than what the board has heard meanwhile (see saved-place.ts). The daemon's
  // events carry everything else, so an answer never adds a session the board hasn't heard of. Where the answer is
  // ignored, the board waits on the event of its own move, which always follows; that is the case too when `asked`,
  // read from what was last rendered, misses an event heard but not yet drawn. One case it gets wrong: moved elsewhere
  // and then back to the very same place before the answer comes, the tile looks unmoved, so the answer's place is
  // shown until the session's next event.
  const saveMove = useCallback(async (tile: TileData, move: TileMove) => {
    if (tile.agent !== undefined) {
      const { sessionId } = tile.agent;
      const asked = agentsRef.current.find((agent) => agent.sessionId === sessionId) ?? tile.agent;
      const moved = await window.agentBoard.agents.move(sessionId, move);
      setAgents((current) => current.map((agent) => (agent.sessionId === sessionId ? withSavedPlace(agent, asked, moved) : agent)));
    } else if (tile.shell !== undefined) {
      const { id } = tile.shell;
      const asked = shellsRef.current?.find((shell) => shell.id === id) ?? tile.shell;
      const moved = await window.agentBoard.shells.move(id, move);
      setShells((current) => current?.map((shell) => (shell.id === id ? withSavedPlace(shell, asked, moved) : shell)));
    } else if (tile.external !== undefined) {
      const { id } = tile.external;
      const asked = externalsRef.current.find((session) => session.id === id) ?? tile.external;
      const moved = await window.agentBoard.external.move(id, move);
      setExternals((current) => current.map((session) => (session.id === id ? withSavedPlace(session, asked, moved) : session)));
    }
  }, []);
  // The desk's dot grid, read once: React Flow draws it as an SVG pattern from numbers. A drag snaps to it too.
  const desk = useMemo(() => ({ gap: tokenNumber('--desk-dot-gap'), size: tokenNumber('--desk-dot-size') }), []);
  const snapping = useSnapping({ applyNodeChanges, nodesRef, getInternalNode, getZoom, viewRect, grid, gap: desk.gap });
  const tileMoves = useTileMoves({
    loaded,
    nodes,
    shownRef,
    pending: pendingPlaces,
    relayout,
    save: saveMove,
    report,
    applyNodeChanges: snapping.onNodesChange,
    getZoom,
    recordNudge: (nodeId, tile, move) => recordTileMove(nodeId, tile, move, 'nudge'),
    nudgeItem: (node, to) => itemActions.update({ id: node.data.item.id, ...to }, 'nudge'),
    // Moved any way, a tile no longer overlaps by having been dragged there; a drop pairs it again after (`tileDropped`).
    onMove: (nodeId) => setOverlapsAllowed((current) => withoutOverlaps(current, [nodeId])),
  });

  /** Records the move of the tile `nodeId` (standing for `tile`'s session) to `move`, from where it is now. */
  const recordTileMove = useCallback(
    (nodeId: string, tile: TileData, move: TileMove, coalesce?: string) => {
      const { zoneId, position } = subjectOf(tile);
      const before = pendingPlaces.current.get(nodeId) ?? (position === null ? undefined : { zoneId, x: position.x, y: position.y, ...(position.z === null ? {} : { z: position.z }) });
      if (before !== undefined) history.record([[historyKey.tile(nodeId), { type: 'tile', move: before }, { type: 'tile', move }]], coalesce);
    },
    [history],
  );
  /** Moves a tile as the user asked, which can be undone. */
  const moveTile = useCallback(
    (nodeId: string, tile: TileData, move: TileMove) => {
      recordTileMove(nodeId, tile, move);
      tileMoves.moveTile(nodeId, tile, move);
    },
    [recordTileMove, tileMoves.moveTile],
  );
  moveTileRef.current = moveTile;

  /** Where the node is on the board now: React Flow's own reckoning, while dragged too. */
  const absoluteOf = (node: BoardNode) => getInternalNode(node.id)?.internals.positionAbsolute ?? node.position;

  /** Moves a dragged tile into the zone it was dropped on, or out onto the board, in front of the others, and saves where it is. */
  const tileDropped = (node: TileNodeType) => {
    const at = absoluteOf(node);
    // Dropped onto another tile, one of the two expanded, the two may overlap: after the move, which ends any pair before.
    const shown = getNodes();
    const onto = droppedOnto(shown, node.id, expandedRef.current);
    moveTile(node.id, node.data, { ...placeOnBoard(at, AGENT_TILE_SIZE, zoneLayouts()), toFront: true });
    // The one it was dropped onto stays where it was seen, even if only drawn there, moved clear of something.
    const target = shown.find((known): known is TileNodeType => known.id === onto && isSessionTile(known));
    const stored = nodesRef.current.find((known) => known.id === onto);
    if (target !== undefined && stored !== undefined) {
      const { x, y } = target.position;
      if (x !== stored.position.x || y !== stored.position.y) moveTile(target.id, target.data, { zoneId: target.parentId ?? null, x, y });
    }
    setOverlapsAllowed((current) => allowingOverlap(current, node.id, onto));
  };

  /** The zone the dragged node would move into if dropped now, if it would change zone. */
  const dropTargetOf = (node: BoardNode): string | undefined => {
    const absolute = absoluteOf(node);
    let zoneId: string | null | undefined;
    if (isItemNode(node)) {
      const size = { width: node.width ?? node.data.item.width, height: node.height ?? node.data.item.height };
      zoneId = placeOnBoard(absolute, size, zoneLayouts()).zoneId;
    } else if (isSessionTile(node)) zoneId = placeOnBoard(absolute, AGENT_TILE_SIZE, zoneLayouts()).zoneId;
    return zoneId != null && zoneId !== node.parentId ? zoneId : undefined;
  };

  /** What the user calls the item `id`, for messages: "sticky note". */
  const itemLabel = useCallback(
    (id: string) => {
      const node = getNodes().find((known) => isItemNode(known) && known.data.item.id === id);
      return node !== undefined && isItemNode(node) ? ITEM_KINDS[node.data.item.kind].label : 'item';
    },
    [getNodes],
  );

  /** Runs `call` once the daemon has the item `id`: at once, or when the create this window sent for it is done. */
  const onceCreated = useCallback(<T,>(id: string, call: () => Promise<T>): Promise<T> => {
    const pending = pendingCreates.current.get(id);
    return pending === undefined ? call() : pending.then(call);
  }, []);

  const itemActions = useMemo<ItemActions>(
    () => ({
      update(params, coalesce) {
        // Deleted meanwhile, here or in another window (its editor saves as it goes): nothing left to save.
        const known = nodesRef.current.find((node): node is ItemNodeType => isItemNode(node) && node.data.item.id === params.id);
        if (known === undefined) return;
        const { item } = known.data;
        // The saves of one typing undo together.
        const typing = params.data !== undefined && 'text' in params.data ? `text:${params.id}` : undefined;
        history.record([[historyKey.item(params.id), { type: 'item', item }, { type: 'item', item: patched(item, params) }]], coalesce ?? typing);
        const label = itemLabel(params.id);
        setNodes((current) => {
          const node = current.find((known) => isItemNode(known) && known.data.item.id === params.id);
          return node !== undefined && isItemNode(node) ? withItem(current, patched(node.data.item, params)) : current;
        });
        onceCreated(params.id, () => window.agentBoard.items.update(params)).catch(report(`save the ${label}`));
      },
      remove(id, { abandoned = false } = {}) {
        const known = nodesRef.current.find((node): node is ItemNodeType => isItemNode(node) && node.data.item.id === id);
        if (known === undefined) return;
        // Its connectors go with it, in the daemon: they come back with it if it is undone.
        const joined = connectorsRef.current.filter((connector) => [connector.from, connector.to].some((end) => end.type === 'item' && end.id === id));
        // One abandoned as it was made (a text item left empty) leaves nothing to undo; any other delete is undoable.
        if (!abandoned || joined.length > 0 || !history.forgetCreation(historyKey.item(id))) {
          history.record([
            [historyKey.item(id), { type: 'item', item: known.data.item }, null],
            ...joined.map((connector): Change => [historyKey.connector(connector.id), { type: 'connector', connector }, null]),
          ]);
        }
        const going = new Set(joined.map((connector) => connector.id));
        if (going.size > 0) setConnectors((current) => current.filter((connector) => !going.has(connector.id)));
        const label = itemLabel(id);
        setNodes((current) => withoutItem(current, id));
        onceCreated(id, () => window.agentBoard.items.delete(id)).catch(report(`delete the ${label}`));
      },
      openLink: (url) => void window.agentBoard.trackers.openLink(url).catch(report('open the link')),
    }),
    [setNodes, report, itemLabel, onceCreated, history],
  );

  /** The `z` above every item's. */
  const topZ = useCallback(() => Math.max(0, ...nodesRef.current.filter(isItemNode).map((node) => node.data.item.z)), []);

  /**
   * Puts `item` on the board under its own id, as given: a new one, a copy, or one an undo brings back. It shows at
   * once, so what is typed straight away lands in it; the daemon is told meanwhile, and given its `z` if it stacks
   * it elsewhere. `editing` opens it ready to type into.
   */
  const putItem = useCallback(
    (item: BoardItem, { editing = false } = {}) => {
      history.record([[historyKey.item(item.id), null, { type: 'item', item }]]);
      const nodeId = `${ITEM_NODE_PREFIX}${item.id}`;
      setNodes((current) =>
        withItem(current, item).map((node) => (node.id === nodeId && editing ? { ...(node as ItemNodeType), data: { ...(node as ItemNodeType).data, editing } } : node)),
      );
      const { id, kind, zoneId, x, y, width, height, data, z } = item;
      const created = window.agentBoard.items
        .create({ id, kind, zoneId, x, y, width, height, data })
        .then((made) => (made.z === z ? made : window.agentBoard.items.update({ id, z })))
        .then(
          (made) => setNodes((current) => withItem(current, made)),
          (error: unknown) => {
            setNodes((current) => withoutItem(current, id));
            report(`add the ${ITEM_KINDS[kind].label}`)(error);
            throw error;
          },
        );
      pendingCreates.current.set(id, created);
      // Unless a later create of the same id (a redo) has taken its place.
      void created.catch(() => {}).finally(() => pendingCreates.current.get(id) === created && pendingCreates.current.delete(id));
    },
    [history, setNodes, report],
  );

  /** Selects the nodes `ids`, and nothing else on the board; then the connectors `connectorIds`, if given. */
  const selectOnly = useCallback(
    (ids: ReadonlySet<string>, connectorIds: ReadonlySet<string> = new Set()) => {
      setNodes((current) => current.map((node) => ((node.selected === true) === ids.has(node.id) ? node : { ...node, selected: ids.has(node.id) })));
      setSelectedConnectors((current) => (current.size === 0 && connectorIds.size === 0 ? current : connectorIds));
    },
    [setNodes],
  );

  /**
   * Adds a new item of `kind` centred on board position `centre`, in the zone there, selected and ready to type into if
   * the kind is typed into. `made` gives its size and data where the kind doesn't make them itself (an image or link
   * card is made from what was pasted).
   */
  const createItem = useCallback(
    (
      kind: BoardItemKind,
      centre: { x: number; y: number },
      made: { size?: ItemKind['size']; data?: Record<string, unknown> } = {},
    ): string => {
      const { newData, editOnCreate } = ITEM_KINDS[kind];
      const size = made.size ?? ITEM_KINDS[kind].size;
      const at = { x: centre.x - size.width / 2, y: centre.y - size.height / 2 };
      const place = placeOnBoard(at, size, zoneLayouts());
      const id = crypto.randomUUID();
      putItem(
        { id, kind, ...place, ...size, z: topZ() + 1, data: made.data ?? newData?.() ?? {}, createdAt: '', updatedAt: '' },
        { editing: editOnCreate },
      );
      selectOnly(new Set([`${ITEM_NODE_PREFIX}${id}`]));
      return id;
    },
    [zoneLayouts, putItem, topZ, selectOnly],
  );

  /** The board position in the middle of the window. */
  const boardCentre = useCallback(() => {
    const rect = container.current!.getBoundingClientRect();
    return screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }, [screenToFlowPosition]);

  const connectorActions = useMemo<ConnectorActions>(
    () => ({
      // Shown at once, and not taken back if the daemon refuses it: the notice says it wasn't saved.
      update(params: UpdateConnectorParams) {
        // Deleted meanwhile, here or in another window: nothing left to save.
        const connector = connectorsRef.current.find((known) => known.id === params.id);
        if (connector === undefined) return;
        // The saves of one label's typing undo together.
        const typing = params.label === undefined ? undefined : `label:${params.id}`;
        history.record([[historyKey.connector(params.id), { type: 'connector', connector }, { type: 'connector', connector: { ...connector, ...params } }]], typing);
        setConnectors((current) => {
          const known = current.find((connector) => connector.id === params.id);
          return known === undefined ? current : withConnector(current, { ...known, ...params });
        });
        onceCreated(params.id, () => window.agentBoard.connectors.update(params)).catch(report('save the connector'));
      },
      remove(id) {
        const connector = connectorsRef.current.find((known) => known.id === id);
        if (connector !== undefined) history.record([[historyKey.connector(id), { type: 'connector', connector }, null]]);
        setConnectors((current) => current.filter((connector) => connector.id !== id));
        onceCreated(id, () => window.agentBoard.connectors.delete(id)).catch(report('delete the connector'));
      },
      select(id) {
        setNodes((current) => current.map((node) => (node.selected === true ? { ...node, selected: false } : node)));
        setSelectedConnectors(new Set([id]));
      },
      editing: editingConnector,
      edit: setEditingConnector,
    }),
    [onceCreated, report, editingConnector, setNodes, history],
  );

  /**
   * Puts `connector` on the board under its own id, as given: a new one, a copy, or one an undo brings back. It shows at
   * once; the daemon is told once both objects it joins exist there (a note made for it is still on its way).
   */
  const putConnector = useCallback(
    (connector: Connector) => {
      history.record([[historyKey.connector(connector.id), null, { type: 'connector', connector }]]);
      setConnectors((current) => withConnector(current, connector));
      const { id, from, to, style, startEnd, endEnd, color, label } = connector;
      const waits = [from, to]
        .flatMap((end) => (end.type === 'item' ? [pendingCreates.current.get(end.id)] : []))
        .filter((p) => p !== undefined);
      const created = Promise.all(waits)
        .then(() => window.agentBoard.connectors.create({ id, from, to, style, startEnd, endEnd, color, label }))
        .then(
          // Only the times are the daemon's to add: a look or label changed meanwhile is newer than its answer.
          ({ createdAt, updatedAt }) =>
            setConnectors((current) => current.map((known) => (known.id === id ? { ...known, createdAt, updatedAt } : known))),
          (error: unknown) => {
            setConnectors((current) => current.filter((connector) => connector.id !== id));
            report('connect them')(error);
            throw error;
          },
        );
      pendingCreates.current.set(id, created);
      // Unless a later create of the same id (a redo) has taken its place.
      void created.catch(() => {}).finally(() => pendingCreates.current.get(id) === created && pendingCreates.current.delete(id));
    },
    [report, history],
  );
  /** Joins `from` to `to` with a new connector of the default look. */
  const createConnector = useCallback(
    (from: ConnectorEnd, to: ConnectorEnd) =>
      putConnector({ id: crypto.randomUUID(), from, to, ...DEFAULT_CONNECTOR_LOOK, createdAt: '', updatedAt: '' }),
    [putConnector],
  );

  /** The rectangle of a board node, on the board. */
  const rectOf = useCallback(
    (nodeId: string) => {
      const node = getInternalNode(nodeId);
      if (node === undefined) return undefined;
      const { x, y } = node.internals.positionAbsolute;
      return {
        x,
        y,
        width: node.measured.width ?? node.width ?? 0,
        height: node.measured.height ?? node.height ?? 0,
      };
    },
    [getInternalNode],
  );

  /**
   * A connector dragged from a handle was let go. On an object (on one of its handles, or anywhere on it) it joins the
   * two, at that handle's side or else the side facing the other; on empty board it makes a new sticky note there, joined; anywhere else, nothing happens.
   */
  const connectorDropped = useCallback(
    (event: MouseEvent | TouchEvent, { fromNode, fromHandle, toNode, toHandle }: FinalConnectionState) => {
      setConnecting(false);
      setDrawingFlow(false);
      if (flowDrawCancelled.current) {
        flowDrawCancelled.current = false;
        return;
      }
      if (fromNode === null || fromHandle?.id == null) return;
      const touch = 'changedTouches' in event ? event.changedTouches[0] : event;
      if (touch === undefined) return;
      const point = { x: touch.clientX, y: touch.clientY };
      if (isFlowPort(fromHandle.id)) {
        // A flow joins two agents' tiles: let go on another one (anywhere on it), it flows out of the out port's.
        const nodeId = toNode?.id ?? (() => {
          const drop = dropAt(point, new Set());
          return drop.type === 'node' ? drop.nodeId : undefined;
        })();
        const there = nodeId === undefined ? undefined : tileSubject(nodeId);
        const here = tileSubject(fromNode.id);
        if (there?.kind !== 'agent' || here?.kind !== 'agent' || there.id === here.id) return;
        const [from, to] = fromHandle.id === FLOW_PORTS.out ? [here.id, there.id] : [there.id, here.id];
        flow.actions.create(from, to);
        return;
      }
      const at = screenToFlowPosition(point);
      const from = endOfNode(fromNode, fromHandle.id as ConnectorSide);
      if (from === undefined) return;
      const nodes = getNodes();
      let target: { nodeId: string; side: ConnectorSide } | undefined;
      if (toNode !== null && toHandle?.id != null) {
        target = { nodeId: toNode.id, side: toHandle.id as ConnectorSide };
      } else {
        const drop = dropAt(point, new Set(nodes.filter(isZone).map((zone) => zone.id)));
        if (drop.type === 'nothing') return;
        if (drop.type === 'node') {
          // It arrives on the side facing where it came from.
          const rect = rectOf(drop.nodeId);
          const source = rectOf(fromNode.id);
          if (rect !== undefined && source !== undefined) {
            target = { nodeId: drop.nodeId, side: nearestSide(rect, { x: source.x + source.width / 2, y: source.y + source.height / 2 }) };
          }
        }
      }
      if (target !== undefined) {
        // Not to itself.
        if (target.nodeId === fromNode.id) return;
        const node = nodes.find((known) => known.id === target.nodeId);
        const to = node && endOfNode(node, target.side);
        if (to !== undefined) createConnector(from, to);
        return;
      }
      const source = rectOf(fromNode.id);
      if (source === undefined) return;
      const { centre, side } = newEndAt(source, at, ITEM_KINDS.sticky.size);
      const noteId = createItem('sticky', centre);
      createConnector(from, { type: 'item', id: noteId, side });
    },
    [screenToFlowPosition, getNodes, rectOf, createConnector, createItem, flow.actions],
  );

  /** The tool armed for the next click or drag on the board (T, S, or its button), if any. */
  const [tool, setTool] = useState<ArmedTool>();
  /** How a drag on the board acts while no tool is armed (V, H, or the toolbar). */
  const [mode, setMode] = useState<PointerMode>('select');
  const pickMode = useCallback((picked: PointerMode) => {
    setTool(undefined);
    setMode(picked);
  }, []);

  // Escape calls off a flow edge being dragged (FlowDraw): nothing is joined, wherever it is let go.
  useEffect(() => {
    if (!drawingFlow) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      flowDrawCancelled.current = true;
      flowStore.getState().cancelConnection();
      setDrawingFlow(false);
    };
    // Before the board's own Escape, which would also put a tile down.
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [drawingFlow, flowStore]);

  // N adds a note at the pointer, or in the middle of the board when the pointer is off it. T, S, Z, A and ` arm the
  // text, shape, zone, agent and shell tools; Escape puts the armed one down. V selects and moves, H pans.
  useEffect(() => {
    if (!loaded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || isTyping(event)) return;
      if (event.key === 'Escape') {
        if (tool !== undefined) return setTool(undefined);
        // With the board (or nothing) focused, not a menu or dialog, which close on their own Escape.
        const active = document.activeElement;
        if (event.defaultPrevented || (active !== null && active !== document.body && active.closest('.react-flow') === null)) return;
        return setExpanded(collapseFront);
      }
      const key = event.key.toLowerCase();
      if (key === 'n') {
        event.preventDefault();
        createItem('sticky', pointer.current === undefined ? boardCentre() : screenToFlowPosition(pointer.current));
      } else if (Object.hasOwn(TOOL_KEYS, key)) {
        event.preventDefault();
        const armed = TOOL_KEYS[key]!;
        setTool((current) => (current === armed ? undefined : armed));
      } else if (key === 'v' || key === 'h') {
        event.preventDefault();
        pickMode(key === 'v' ? 'select' : 'hand');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [loaded, tool, createItem, boardCentre, screenToFlowPosition, pickMode]);

  /** Adds `file` as an image item centred on `centre`: its bytes go to the daemon's image store first. */
  const addImage = useCallback(
    async (file: File, centre: { x: number; y: number }) => {
      try {
        const problem = imageProblem(file);
        if (problem !== undefined) throw new Error(problem);
        // Decoded here for its size; a file the browser can't decode is not an image the board can show.
        const bitmap = await createImageBitmap(file);
        const natural = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        const ref = await window.agentBoard.items.importImage(await file.arrayBuffer());
        createItem('image', centre, { size: imageBoardSize(natural), data: { ...ref } });
      } catch (error) {
        report('add the image')(error);
      }
    },
    [createItem, report],
  );

  /** Adds what a paste or drop brought, one item per image, each a little way from the last. */
  const addIncoming = useCallback(
    (incoming: Incoming, centre: { x: number; y: number }) => {
      if (incoming.type === 'images') {
        incoming.files.forEach((file, n) => void addImage(file, { x: centre.x + n * 24, y: centre.y + n * 24 }));
      } else if (incoming.type === 'link') {
        createItem('link', centre, { data: { url: incoming.url } });
      } else if (incoming.type === 'refused') {
        report('add it')(incoming.reason);
      }
    },
    [addImage, createItem, report],
  );

  /** The armed tool's click or drag, from `from` to `to` on the screen, made into an item. */
  const placeWithTool = useCallback(
    (armed: ArmedTool, from: { x: number; y: number }, to: { x: number; y: number }) => {
      setTool(undefined);
      const start = screenToFlowPosition(from);
      const end = screenToFlowPosition(to);
      if (armed === 'zone') {
        const click = Math.hypot(to.x - from.x, to.y - from.y) < TOOL_DRAG_MIN;
        return setAddingZone({ layout: draggedZoneLayout(start, click ? start : end), source: 'empty' });
      }
      if (armed === 'agent' || armed === 'shell') {
        // Where the pointer let go: the ghost tile was centred there.
        return armed === 'agent' ? placeSession.placeAgent(end) : placeSession.placeShell(end);
      }
      if (armed === 'text') {
        // Placed with its top-left where it was clicked, and typed into.
        const size = ITEM_KINDS.text.size;
        return createItem('text', { x: start.x + size.width / 2, y: start.y + size.height / 2 });
      }
      if (Math.hypot(to.x - from.x, to.y - from.y) < TOOL_DRAG_MIN) return createItem('shape', start);
      // Never smaller than a shape can be resized to, so a drag just past a click isn't a speck.
      const size = {
        width: Math.max(MIN_SHAPE_SIZE, Math.abs(end.x - start.x)),
        height: Math.max(MIN_SHAPE_SIZE, Math.abs(end.y - start.y)),
      };
      createItem('shape', { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, { size });
    },
    [screenToFlowPosition, createItem, placeSession],
  );

  /**
   * The Agent or Shell tool dragged off the toolbar and let go at `at` on the screen (AG2): its tile goes there, unless
   * that is off the board or on one of the islands over it.
   */
  const dropTool = useCallback(
    (dropped: 'agent' | 'shell', at: { x: number; y: number }) => {
      setTool(undefined);
      const board = container.current?.getBoundingClientRect();
      const inside = board !== undefined && at.x >= board.left && at.x <= board.right && at.y >= board.top && at.y <= board.bottom;
      if (!inside || document.elementFromPoint(at.x, at.y)?.closest('.ui-island') != null) return;
      const point = screenToFlowPosition(at);
      if (dropped === 'agent') placeSession.placeAgent(point);
      else placeSession.placeShell(point);
    },
    [screenToFlowPosition, placeSession],
  );

  /** Moves a dragged item into the zone it was dropped on, or out onto the board, and saves where it is. */
  const itemDropped = useCallback(
    (node: ItemNodeType) => {
      const absolute = getInternalNode(node.id)?.internals.positionAbsolute ?? node.position;
      const size = { width: node.width ?? node.data.item.width, height: node.height ?? node.data.item.height };
      itemActions.update({ id: node.data.item.id, ...placeOnBoard(absolute, size, zoneLayouts()) });
    },
    [getInternalNode, zoneLayouts, itemActions],
  );

  /** Shows a zone's new tracker setting on its node. */
  const zoneSaved = useCallback(
    (zone: Zone) => {
      setNodes((current) =>
        current.map((node) => (isZone(node) && node.id === zone.id ? { ...node, data: { zone } } : node)),
      );
      setTrackerZone(undefined);
    },
    [setNodes],
  );

  const { zoneResize, onNodesChange, finish: finishResize } = useZoneResize({ nodesRef, setNodes, onNodesChange: tileMoves.onNodesChange });

  /** Saves the zone's new layout, which can be undone, and draws it so while its tiles are laid out again. */
  const saveZoneLayout = useCallback(
    (id: string, layout: ZoneLayout) => {
      const zone = nodesRef.current.filter(isZone).find((node) => node.id === id)?.data.zone;
      const before = savedZoneLayouts.current.get(id) ?? (zone && { x: zone.x, y: zone.y, width: zone.width, height: zone.height });
      if (before !== undefined) history.record([[historyKey.zone(id), { type: 'zone', layout: before }, { type: 'zone', layout }]]);
      savedZoneLayouts.current.set(id, layout);
      window.agentBoard.zones.update(id, layout).catch(report("save the zone's layout"));
      // The node may still have a dragged size: set this one while the tiles are laid out again.
      setNodes((current) =>
        laidOut(current.map((node) => (isZone(node) && node.id === id ? { ...node, width: layout.width, height: layout.height } : node))),
      );
    },
    [report, setNodes, laidOut, history],
  );

  const saveLayout = useCallback(
    (id: string, resized: ZoneLayout) => {
      const packed = finishResize(id, resized);
      // Never short of its tiles, whatever the resizer allowed: a resize packed them to fit.
      const covers = packed === undefined ? nodesRef.current.filter(isZone).find((node) => node.id === id)?.data.covers : undefined;
      const layout = {
        ...resized,
        width: Math.max(resized.width, MIN_ZONE_SIZE.width, (covers?.right ?? -Infinity) - resized.x),
        height: Math.max(resized.height, MIN_ZONE_SIZE.height, (covers?.bottom ?? -Infinity) - resized.y),
      };
      saveZoneLayout(id, layout);
      // Its tiles where the resize packed them; and resized from its left or top, its origin moved and React Flow kept
      // what is in it where it was on the board. Save their places in the zone's new terms.
      for (const node of nodesRef.current) {
        if (node.parentId !== id) continue;
        if (isSessionTile(node)) {
          const stored = subjectOf(node.data).position;
          const at = packed?.get(node.id) ?? node.position;
          if (stored?.x !== at.x || stored?.y !== at.y) moveTile(node.id, node.data, { zoneId: id, ...at });
        } else if (isItemNode(node)) {
          const { item } = node.data;
          if (item.x !== node.position.x || item.y !== node.position.y) itemActions.update({ id: item.id, ...node.position });
        }
      }
    },
    [moveTile, itemActions, finishResize, saveZoneLayout],
  );

  /** Moves each of `tiles` that `positions` puts elsewhere there, in `zoneId` (null: loose), as the user asked. */
  const moveTilesTo = useCallback(
    (tiles: readonly TileNodeType[], positions: ReadonlyMap<string, { x: number; y: number }>, zoneId: string | null) => {
      for (const node of tiles) {
        const at = positions.get(node.id)!;
        if (at.x !== node.position.x || at.y !== node.position.y) moveTile(node.id, node.data, { zoneId, ...at });
      }
    },
    [moveTile],
  );

  /**
   * Tidies the zone: its tiles in rows, in reading order, round its notes and cards, and its height fitted to
   * them. Saved, as one step to undo.
   */
  const tidyZone = useCallback(
    (zoneId: string) => {
      const zone = nodesRef.current.filter(isZone).find((node) => node.id === zoneId);
      if (zone === undefined) return;
      const children = nodesRef.current.filter((node) => node.parentId === zoneId);
      const tiles = children.filter(isSessionTile);
      const items = children.filter(isItemNode).map((node) => node.data.item);
      const layout = layoutOf(zone);
      const { positions, size } = tidyZoneLayout(layout, tiles.map((node) => ({ id: node.id, ...node.position })), items);
      moveTilesTo(tiles, positions, zoneId);
      setOverlapsAllowed((current) => withoutOverlaps(current, positions.keys()));
      if (size.width !== layout.width || size.height !== layout.height) saveZoneLayout(zoneId, { ...layout, ...size });
    },
    [moveTilesTo, saveZoneLayout],
  );

  /**
   * Dissolves a group: the daemon puts its tiles loose where they are drawn and removes it, as one step; its
   * notes, cards and connectors stay where they are, as when a zone goes.
   */
  const dissolveZone = useCallback(
    async (zone: Zone) => {
      setNotice(undefined);
      try {
        await window.agentBoard.zones.dissolve(zone.id);
        toasts.show({ tone: 'success', message: `${zone.name} is dissolved: its tiles stay where they are` });
      } catch (error) {
        report('dissolve the zone')(error);
      }
    },
    [report, toasts],
  );

  /** Tidies the tiles loose on the board: in a grid where they are, clear of zones and items. Saved, as one step to undo. */
  const tidyLoose = useCallback(() => {
    const loose = nodesRef.current.filter(isSessionTile).filter((node) => node.parentId === undefined);
    const obstacles = nodesRef.current.flatMap((node): Rect[] => {
      if (isZone(node)) return [layoutOf(node)];
      if (isItemNode(node) && node.parentId === undefined) return [node.data.item];
      return [];
    });
    const positions = tidyLooseLayout(loose.map((node) => ({ id: node.id, ...node.position })), obstacles);
    moveTilesTo(loose, positions, null);
    setOverlapsAllowed((current) => withoutOverlaps(current, positions.keys()));
  }, [moveTilesTo]);

  /**
   * Puts board objects back as an undo or redo has them, through the board's own actions: an item or connector made
   * again under its own id, changed back, or deleted; a zone's layout; a tile's place. One whose object has gone
   * meanwhile (deleted in another window, a session ended) is left be.
   */
  applyStates.current = (states: States<BoardState>) => {
    const nodeIds = new Set(nodesRef.current.map((node) => node.id));
    const entries = [...states.values()];
    const coming = new Set(entries.flatMap((state) => (state?.type === 'item' ? [`${ITEM_NODE_PREFIX}${state.item.id}`] : [])));
    // Connectors and flow edges go first and come back last, as they need both their objects.
    for (const [key, state] of states) {
      if (state === null && key.startsWith(historyKey.connector(''))) connectorActions.remove(key.slice(historyKey.connector('').length));
      const flowEdgeId = key.slice(historyKey.flowEdge('').length);
      if (state === null && key.startsWith(historyKey.flowEdge('')) && flowEdgesRef.current.some((edge) => edge.id === flowEdgeId)) {
        flow.actions.remove(flowEdgeId);
      }
    }
    for (const [key, state] of states) {
      if (state === null && key.startsWith(historyKey.item(''))) itemActions.remove(key.slice(historyKey.item('').length));
    }
    for (const state of entries) {
      if (state?.type === 'item') {
        const { item } = state;
        const { id, zoneId, x, y, width, height, z, data } = item;
        if (nodeIds.has(`${ITEM_NODE_PREFIX}${id}`)) itemActions.update({ id, zoneId, x, y, width, height, z, data });
        else putItem(item);
      }
    }
    for (const [key, state] of states) {
      if (state?.type === 'zone') {
        const id = key.slice(historyKey.zone('').length);
        if (!nodeIds.has(id)) continue;
        const { layout } = state;
        savedZoneLayouts.current.set(id, layout);
        window.agentBoard.zones.update(id, layout).catch(report("save the zone's layout"));
        setNodes((current) =>
          laidOut(current.map((node) => (isZone(node) && node.id === id ? { ...node, position: { x: layout.x, y: layout.y }, width: layout.width, height: layout.height } : node))),
        );
      } else if (state?.type === 'tile') {
        const nodeId = key.slice(historyKey.tile('').length);
        const node = nodesRef.current.find((known): known is TileNodeType => known.id === nodeId && isSessionTile(known));
        if (node !== undefined) tileMoves.moveTile(nodeId, node.data, state.move);
      } else if (state?.type === 'name') {
        // Not through the tile action, which would record it; and left be if the session or shell has gone.
        if (nameOf(state.target) !== undefined) renameDirect(state.target, state.name).catch(report('undo the rename'));
      }
    }
    for (const state of entries) {
      if (state?.type !== 'connector') continue;
      const { connector } = state;
      const present = (end: ConnectorEnd) => nodeIds.has(nodeIdOf(end)) || coming.has(nodeIdOf(end));
      if (!present(connector.from) || !present(connector.to)) continue;
      if (connectorsRef.current.some((known) => known.id === connector.id)) {
        const { id, style, startEnd, endEnd, color, label } = connector;
        connectorActions.update({ id, style, startEnd, endEnd, color, label });
      } else putConnector(connector);
    }
    // Only between agents still on the board: undo never brings back an agent, or the edge with it.
    for (const state of entries) {
      if (state?.type !== 'flowEdge' || flowEdgesRef.current.some((known) => known.id === state.edge.id)) continue;
      if (nodeIds.has(tileNodeId('agent', state.edge.from)) && nodeIds.has(tileNodeId('agent', state.edge.to))) flow.actions.restore(state.edge);
    }
  };

  /** Moves the zone's top-left corner to `at` on the board, what is in it with it, and saves it. */
  const moveZone = useCallback(
    (id: string, at: { x: number; y: number }) => {
      const zone = nodesRef.current.filter(isZone).find((node) => node.id === id);
      if (zone === undefined) return;
      setNodes((current) => current.map((node) => (node.id === id ? { ...node, position: at } : node)));
      saveLayout(id, { ...layoutOf(zone), ...at });
    },
    [setNodes, saveLayout],
  );

  const editing = useEditing({
    loaded,
    nodesRef,
    connectorsRef,
    selectedConnectorsRef,
    history,
    rectOf,
    zoneLayouts,
    topZ,
    putItem,
    putConnector,
    updateItem: itemActions.update,
    removeItem: itemActions.remove,
    removeConnector: connectorActions.remove,
    moveTile,
    moveZone,
    select: selectOnly,
    pasteAt: () => (pointer.current === undefined ? boardCentre() : screenToFlowPosition(pointer.current)),
    duplicateOffset: desk.gap,
    report,
  });

  // Whether to snap to the grid is kept in the view state, as the view is.
  useEffect(() => {
    window.agentBoard.view.get(VIEW_KEYS.snapToGrid).then((value) => setGrid(value === true), () => {});
  }, []);
  const toggleGrid = useCallback(() => {
    setGrid((current) => {
      void window.agentBoard.view.set(VIEW_KEYS.snapToGrid, !current).catch(() => {});
      return !current;
    });
  }, []);

  // F2 renames the one agent or shell tile selected; its field opens where it is drawn (compact or expanded).
  useEffect(() => {
    if (!loaded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'F2' || event.metaKey || event.ctrlKey || event.altKey || isTyping(event)) return;
      const { nodes, renamable } = editing.selection();
      if (!renamable) return;
      event.preventDefault();
      setRenameRequest(nodes[0]!.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [loaded, editing.selection]);

  // Enter opens the one agent or shell tile selected, as a double-click does.
  useEffect(() => {
    if (!loaded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isTyping(event)) return;
      // A focused control (a tile's button, a menu item) takes its own Enter, and so does anything in a window or dialog
      // open over the board (the selected tile is behind it). Only the board itself, or a tile on it, opens a tile.
      const target = event.target as HTMLElement;
      if (target.closest(CONTROLS) !== null || document.querySelector('[role="dialog"]') !== null) return;
      if (target !== document.body && target.closest('.react-flow') === null) return;
      const [node, ...rest] = editing.selection().nodes;
      if (node === undefined || rest.length > 0 || !isSessionTile(node) || node.data.expanded === true) return;
      event.preventDefault();
      if (tileOpenAction(clickOpens, { hasWindow: node.data.external === undefined }) === 'window') tileActions.maximise(node.data);
      else tileActions.expand(node.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [loaded, editing.selection, clickOpens, tileActions]);

  const contextActions: ContextActions = {
    ...editing,
    // After the menu has handed the focus back to where it was opened, or the field would lose it at once.
    rename: () => {
      const [node] = editing.selection().nodes;
      if (node !== undefined) setTimeout(() => setRenameRequest(node.id), MENU_FOCUS_RETURN_MS);
    },
    grid,
    toggleGrid,
    tidyLoose,
  };

  // Paste adds an image or a link at the pointer, or in the middle of the board; not while typing into a field.
  useEffect(() => {
    if (!loaded) return;
    const onPaste = (event: ClipboardEvent) => {
      if (isTyping(event) || event.clipboardData === null) return;
      // Board items copied here or in another window.
      if (editing.paste(event.clipboardData.getData(BOARD_CLIPBOARD_TYPE))) return event.preventDefault();
      const incoming = classifyPaste({
        files: [...event.clipboardData.files],
        text: event.clipboardData.getData('text/plain'),
      });
      if (incoming.type === 'nothing') return;
      event.preventDefault();
      addIncoming(incoming, pointer.current === undefined ? boardCentre() : screenToFlowPosition(pointer.current));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [loaded, addIncoming, boardCentre, screenToFlowPosition, editing.paste]);

  /** Starts a shell tile in the zone and opens its window. */
  const newShell = useCallback(
    (zone: Zone) => {
      window.agentBoard.shells.create({ zoneId: zone.id }).then((shell) => {
        setShells((current) => applyShellChange(current ?? [], { type: 'shell.updated', shell }));
        openShell(shell);
      }, report('start a shell'));
    },
    [openShell, report],
  );

  /** Where the tiles loose on the board are. */
  const looseTiles = () => [
    ...getNodes()
      .filter((node) => isSessionTile(node) && node.parentId === undefined)
      .map((node) => ({ ...node.position, ...AGENT_TILE_SIZE })),
    ...[...looseSpots.current].map((spot) => spot.rect),
  ];

  /** A free spot for a new zone, near the middle of the view, clear of the zones and loose tiles. */
  const newZoneSpot = () => {
    const centre = boardCentre();
    const wanted = { x: centre.x - DEFAULT_ZONE_SIZE.width / 2, y: centre.y - DEFAULT_ZONE_SIZE.height / 2 };
    return freeSpotFor(wanted, DEFAULT_ZONE_SIZE, [...getNodes().filter(isZone).map(layoutOf), ...looseTiles()]);
  };

  /** Where Add zone sits by the outline of `layout`, as the view is now. */
  const addZonePlacement = (layout: ZoneLayout) => {
    const view = container.current!.getBoundingClientRect();
    const left = flowToScreenPosition({ x: layout.x, y: layout.y }).x;
    const right = flowToScreenPosition({ x: layout.x + layout.width, y: layout.y }).x;
    return popoverPlacement({ left, right }, view, tokenNumber('--size-add-zone'));
  };

  /** Opens Add zone on the source's tab, its outline in the middle of the view, clear of the zones and loose tiles. */
  const openAddZone = (source: ZoneSource = 'empty') => {
    setNotice(undefined);
    setAddingZone({ layout: { ...newZoneSpot(), ...DEFAULT_ZONE_SIZE }, source });
  };

  /** Shows a zone Add zone made, and opens the New agent dialog in it if that is what it was made for. */
  const zoneAdded = (zone: Zone) => {
    setAddingZone(undefined);
    setNodes((current) => withZone(current, zone));
    // It may have been stepped off-screen past other zones: bring it into view without zooming in.
    bringIntoView(zone);
    if (zone.clone !== null) clonesWatched.current.add(zone.id);
    // External sessions in its folder move into it.
    if (zone.repoRoot !== null) void reloadExternals();
  };

  const bindZone = useCallback(
    async (zone: Zone, as: ZoneBinding) => {
      setNotice(undefined);
      try {
        const result = await window.agentBoard.zones.bind(zone.id, as);
        if (result.status === 'rejected') setNotice({ message: result.message });
        if (result.status === 'bound') {
          const bound = result.zone;
          setNodes((current) => withZone(current, bound));
          // External sessions in its folder move into it.
          void reloadExternals();
          toasts.show({ tone: 'success', message: `${bound.name} is bound to ${bound.repoRoot}` });
        }
      } catch (error) {
        report('bind the zone')(error);
      }
    },
    [report, reloadExternals, setNodes, toasts],
  );
  /** The home directory loose shells start in, for shell tiles' folder chips; undefined until the daemon says. */
  const [home, setHome] = useState<string>();
  useEffect(() => {
    window.agentBoard.daemonHealth().then((health) => setHome(health.homeDir), () => {});
  }, []);
  const shellFolders = useMemo<ShellFolders>(
    () => ({
      home,
      recent: () => window.agentBoard.zones.recentFolders(),
      async newPaneIn(shell, cwd) {
        try {
          const folder = cwd ?? (await window.agentBoard.zones.browseFolder('Start a new pane in'));
          const pane = paneIds(shell.layout).at(-1);
          if (folder === undefined || pane === undefined) return;
          const split = await window.agentBoard.shells.split(shell.id, pane, 'horizontal', folder);
          setShells((current) => applyShellChange(current ?? [], { type: 'shell.updated', shell: split }));
          openShell(split);
        } catch (error) {
          report('open a new pane')(error);
        }
      },
    }),
    [home, openShell, report],
  );
  const zoneBinding = useMemo<ZoneBindingActions>(
    () => ({
      unbind(zone) {
        setNotice(undefined);
        window.agentBoard.zones.unbind(zone.id).then((group) => {
          setNodes((current) => withZone(current, group));
          // External sessions in its folder go to the Unsorted group, or another zone of theirs.
          void reloadExternals();
          toasts.show({ tone: 'success', message: `${group.name} is a group again: its agents keep their repos` });
        }, report('unbind the zone'));
      },
      pickDefaultRepo: setDefaultRepoZone,
      tidy: (zone) => tidyZone(zone.id),
      async rename(zone, name) {
        const saved = await window.agentBoard.zones.setLook(zone.id, { name });
        setNodes((current) => withZone(current, saved));
      },
      recolor(zone, color) {
        window.agentBoard.zones.setLook(zone.id, { color }).then((saved) => setNodes((current) => withZone(current, saved)), report('recolour the zone'));
      },
      dissolve: (zone) => void dissolveZone(zone),
    }),
    [setNodes, reloadExternals, toasts, report, tidyZone, dissolveZone],
  );
  /**
   * Starts a shell tile loose on the board and opens its window, typing `command` into it if given (the PTY holds it
   * until the shell reads it). Resolves with the shell's id, or undefined if it could not start.
   */
  const startLooseShell = useCallback(
    (command?: string): Promise<string | undefined> => {
        // In the middle of the view, clear of the zones and loose tiles there.
        const centre = boardCentre();
        const wanted = { x: centre.x - AGENT_TILE_SIZE.width / 2, y: centre.y - AGENT_TILE_SIZE.height / 2 };
        const position = freeSpotFor(wanted, AGENT_TILE_SIZE, [...zoneLayouts(), ...looseTiles()]);
        const spot: { rect: ZoneLayout; shellId?: string } = { rect: { ...position, ...AGENT_TILE_SIZE } };
        looseSpots.current.add(spot);
        return window.agentBoard.shells.create({ zoneId: null, position }).then(
          (shell) => {
            spot.shellId = shell.id;
            setShells((current) => applyShellChange(current ?? [], { type: 'shell.updated', shell }));
            openShell(shell);
            const [pane] = paneIds(shell.layout);
            if (command !== undefined && pane !== undefined) window.agentBoard.sessions.write(pane, `${command}\r`);
            return shell.id;
          },
          (error: unknown) => {
            looseSpots.current.delete(spot);
            report('start a shell')(error);
            return undefined;
          },
        );
    },
    [boardCentre, zoneLayouts, openShell, report],
  );

  const boardCommands = useMemo<BoardCommands>(
    () => ({
      openSession(sessionId) {
        const shell = shellWithPane(shellsRef.current, sessionId);
        const agent = agentsRef.current.find((known) => known.sessionId === sessionId);
        if (shell !== undefined) openShell(shell);
        else if (agent !== undefined) openAgent(agent);
        return shell !== undefined || agent !== undefined;
      },
      focusSession(sessionId) {
        const shell = shellWithPane(shellsRef.current, sessionId);
        const nodeId = shell !== undefined ? tileNodeId('shell', shell.id) : tileNodeId('agent', sessionId);
        const node = getInternalNode(nodeId);
        if (node === undefined) return;
        setNodes((current) =>
          current.map((node) => ((node.selected === true) === (node.id === nodeId) ? node : { ...node, selected: node.id === nodeId })),
        );
        bringIntoView({ ...node.internals.positionAbsolute, ...AGENT_TILE_SIZE });
      },
    }),
    [getNodes, getInternalNode, zoneLayouts, openShell, openAgent, report, setNodes, bringIntoView],
  );
  useProvideBoardCommands(loaded ? boardCommands : undefined);

  /** How an agent starts from the issue card `item`: the New agent dialog, the repo picker, or not now. */
  const issueStartOf = useCallback((item: BoardItem, card: IssueCardData) => {
    const zones = nodesRef.current.filter(isZone).map((node) => node.data.zone);
    return issueStartIn(card, zones.find((zone) => zone.id === item.zoneId), zones);
  }, []);

  /**
   * Puts the issue's card in the zone, unless it has one already: in the first spot clear of the zone's tiles and
   * items, which a tile started for it then keeps clear of, like any new tile.
   */
  const placeIssueCard = useCallback(
    (zone: Zone, issue: IssueCardData) => {
      if (issueCardFor(getNodes(), issue, zone.id) !== undefined) return;
      const size = ITEM_KINDS.issue.size;
      const taken = getNodes()
        .filter((node) => node.parentId === zone.id && (isSessionTile(node) || isItemNode(node)))
        .map((node) => (isItemNode(node) ? node.data.item : { ...node.position, ...AGENT_TILE_SIZE }));
      const at = freeItemSpot(zone.width, size, taken);
      const { provider, id, title, url, state } = issue;
      createItem('issue', { x: zone.x + at.x + size.width / 2, y: zone.y + at.y + size.height / 2 }, { data: { provider, id, title, url, state } });
    },
    [createItem, getNodes],
  );

  /** Opens the New agent dialog for an agent fed by the issue's card, which goes in once the agent has started: cancelled, it leaves no card. */
  const startFromIssue = useCallback((zone: Zone, issue: TrackerIssue) => setNewAgent({ zone, issue, card: issue }), []);

  const issueCards = useMemo<IssueCardActions>(
    () => ({
      whyNoStart(item) {
        const card = issueCardData(item.data);
        const start = card === undefined ? undefined : issueStartOf(item, card);
        return start?.kind === 'refuse' ? start.reason : undefined;
      },
      hasAgent: (card) => cardHasAgent(card, agents),
      start(item) {
        const card = issueCardData(item.data);
        if (card === undefined) return;
        const start = issueStartOf(item, card);
        if (start.kind === 'dialog') return setNewAgent({ zone: start.zone, issue: card });
        if (start.kind === 'refuse') return report('start an agent')(start.reason);
        // No repo where the card is: the repo picker opens on a tile beside it.
        const zone = start.zone;
        const left = item.x + (zone?.x ?? 0) + item.width + ZONE_PADDING;
        placeSession.pickForIssue(card, start.issueZoneId, zone, { x: left + AGENT_TILE_SIZE.width / 2, y: item.y + (zone?.y ?? 0) + AGENT_TILE_SIZE.height / 2 });
      },
    }),
    [agents, issueStartOf, placeSession, report],
  );

  /** The Add issue dialog's Start agent: the New agent dialog where the zone gives a repo, else the repo picker. */
  const startFromZoneIssue = useCallback(
    (zone: Zone, issue: TrackerIssue) => {
      if (zone.repoRoot !== null || zone.defaultRepo !== null) return startFromIssue(zone, issue);
      placeIssueCard(zone, issue);
      placeSession.pickForIssue(issue, zone.id, zone, { x: zone.x + zone.width / 2, y: zone.y + zone.height / 2 });
    },
    [startFromIssue, placeIssueCard, placeSession],
  );

  const cancelClone = useCallback(
    (zone: Zone) => {
      clonesWatched.current.delete(zone.id);
      window.agentBoard.zones.cancelClone(zone.id).catch(report('cancel the clone'));
    },
    [report],
  );

  const edges = useMemo(() => {
    const nodeIds = new Set(nodes.map((node) => node.id));
    return [...connectorEdges(connectors, nodeIds, selectedConnectors), ...briefEdges(nodes, agents), ...flowEdges(flow.edges, nodeIds, flow.selected, flow.live)];
  }, [connectors, nodes, selectedConnectors, agents, flow.edges, flow.selected, flow.live]);
  // A node that has lost its handles is measured again, or no edge would ever be drawn to it (see handle-bounds.ts).
  // After React Flow's own effects, which take `nodes` and so may have lost them.
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    const lost = handlesLost(flowStore.getState().nodeLookup.values());
    if (lost.length > 0) updateNodeInternals(lost);
  }, [nodes, flowStore, updateNodeInternals]);
  // A connector that goes, however it goes (with its object, or in another window), is no longer selected.
  useEffect(() => {
    setSelectedConnectors((current) => {
      const kept = new Set([...current].filter((id) => connectors.some((connector) => connector.id === id)));
      return kept.size === current.size ? current : kept;
    });
  }, [connectors]);
  const { setSelected: setSelectedFlowEdges } = flow;
  const edgesChanged = useCallback((changes: EdgeChange[]) => {
    const flowChanges = changes.filter((change) => 'id' in change && isFlowEdge(change)) as Exclude<EdgeChange, { type: 'add' }>[];
    if (flowChanges.length > 0) {
      setSelectedFlowEdges((current) => {
        const next = new Set(current);
        for (const change of flowChanges) {
          if (change.type === 'select' && change.selected) next.add(flowEdgeIdOf(change));
          else if (change.type === 'select' || change.type === 'remove') next.delete(flowEdgeIdOf(change));
        }
        return next;
      });
      changes = changes.filter((change) => !flowChanges.includes(change as (typeof flowChanges)[number]));
    }
    const kept = keptSelection.current?.connectors;
    if (kept !== undefined) changes = changes.filter((change) => change.type !== 'select' || change.selected || !kept.has(change.id.slice(CONNECTOR_EDGE_PREFIX.length)));
    setSelectedConnectors((current) => {
      const next = new Set(current);
      for (const change of changes) {
        if (change.type !== 'select' && change.type !== 'remove') continue;
        const id = change.id.slice(CONNECTOR_EDGE_PREFIX.length);
        if (change.type === 'select' && change.selected) next.add(id);
        else next.delete(id);
      }
      return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next;
    });
  }, [setSelectedFlowEdges]);
  const severalSelected = useMemo(() => nodes.filter((node) => node.selected === true).length > 1, [nodes]);
  /** The flow edge whose Edge rules are open: the one selected, alone. */
  const shownFlowEdge = flow.selected.size === 1 ? flow.edges.find((edge) => flow.selected.has(edge.id)) : undefined;
  const shownEnds = shownFlowEdge && {
    from: agents.find((agent) => agent.sessionId === shownFlowEdge.from),
    to: agents.find((agent) => agent.sessionId === shownFlowEdge.to),
  };
  // Opened on an edge whose tiles it would cover, the panel pans the board left until they clear it (FlowDraw AB2).
  const shownFlowEdgeId = shownFlowEdge?.id;
  useEffect(() => {
    const edge = flowEdgesRef.current.find((known) => known.id === shownFlowEdgeId);
    const board = flowStore.getState().domNode?.getBoundingClientRect();
    if (edge === undefined || board === undefined) return;
    const ends = [edge.from, edge.to].map((id) => getInternalNode(tileNodeId('agent', id)));
    if (ends.some((node) => node === undefined)) return;
    const xs = ends.flatMap((node) => {
      const { x, y } = node!.internals.positionAbsolute;
      return [flowToScreenPosition({ x, y }).x, flowToScreenPosition({ x: x + (node!.measured.width ?? 0), y }).x];
    });
    const inset = tokenNumber('--island-inset');
    const panelLeft = board.right - inset - tokenNumber('--size-edge-rules');
    const by = panClear({ left: Math.min(...xs) - board.left, right: Math.max(...xs) - board.left }, panelLeft - board.left, inset * 2);
    if (by === 0) return;
    const [x, y, zoom] = flowStore.getState().transform;
    void setViewport({ x: x - by, y, zoom }, { duration: tokenNumber('--motion-base') });
  }, [shownFlowEdgeId, flowStore, getInternalNode, flowToScreenPosition, setViewport]);
  /** Who is handing off along a live edge, and who is receiving. */
  const handoffs = useMemo(() => handoffEnds(flow.edges, flow.live), [flow.edges, flow.live]);
  /** The zones on the board, for the board menu and the zone island. */
  const zones = useMemo(() => nodes.filter(isZone).map((node) => node.data.zone), [nodes]);
  /** Where every agent's and shell's tile sits, for the session window's steps through its zone (AL1). */
  const navSessions = useMemo(() => nodes.filter(isSessionTile).flatMap(navSessionOf), [nodes]);

  return (
    <div
      className={connecting ? 'board board-connecting' : drawingFlow ? 'board board-drawing-flow' : 'board'}
      ref={container}
      data-mode={mode}
      onPointerMove={(event) => {
        pointer.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerLeave={() => {
        pointer.current = undefined;
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        // Not for the window to open the file.
        event.preventDefault();
        addIncoming(classifyDrop([...event.dataTransfer.files]), screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      }}
      onPointerDownCapture={(event) => {
        tileMoves.onPressed({ x: event.clientX, y: event.clientY });
        keptSelection.current =
          event.shiftKey && (event.target as HTMLElement).classList.contains('react-flow__pane')
            ? { nodes: new Set(nodesRef.current.filter((node) => node.selected === true).map((node) => node.id)), connectors: selectedConnectorsRef.current }
            : undefined;
      }}
      onDoubleClick={(event) => {
        // Bare board, or a zone's body: a new note there.
        const target = event.target as HTMLElement;
        if (target.classList.contains('react-flow__pane') || target.classList.contains('zone')) {
          createItem('sticky', screenToFlowPosition({ x: event.clientX, y: event.clientY }));
        }
      }}
    >
      {loaded && (
        <DropTargetContext value={dropTarget}>
          <SaveZoneLayoutContext value={saveLayout}>
            <ZoneResizeContext value={zoneResize}>
              <NewShellContext value={newShell}>
                <NewAgentContext value={newAgentInZone}>
                  <ZoneTrackerContext value={setTrackerZone}>
                    <BindZoneContext value={bindZone}>
                      <ZoneBindingContext value={zoneBinding}>
                      <CancelCloneContext value={cancelClone}>
                      <AddIssueContext value={setIssueZone}>
                      <IssueCardContext value={issueCards}>
                      <TileActionsContext value={tileActions}>
                      <ClickOpensContext value={clickOpens}>
                      <ShellFoldersContext value={shellFolders}>
                      <RenameRequestContext value={renameRequests}>
                        <ItemActionsContext value={itemActions}>
                          <SeveralSelectedContext value={severalSelected}>
                          <ConnectorActionsContext value={connectorActions}>
                          <FlowEdgeActionsContext value={flow.actions}>
                          <HandoffsContext value={handoffs}>
                            <RepresentationProvider style={DEFAULT_REPRESENTATION}>
                              <ReactFlow
                              nodes={shown}
                              edges={edges}
                              edgeTypes={edgeTypes}
                              onEdgesChange={edgesChanged}
                              // A connector can join any two objects, whichever handles: the sides are the user's choice.
                              connectionMode={ConnectionMode.Loose}
                              edgesReconnectable={false}
                              onConnectStart={(_event, { handleId }) => {
                                flowDrawCancelled.current = false;
                                if (isFlowPort(handleId)) setDrawingFlow(true);
                                else setConnecting(true);
                              }}
                              connectionLineComponent={ConnectionLine}
                              onConnectEnd={connectorDropped}
                              onEdgeDoubleClick={(_event, edge) => isConnectorEdge(edge) && setEditingConnector(connectorIdOf(edge))}
                              onNodesChange={(changes) => {
                                const kept = keptSelection.current?.nodes;
                                onNodesChange(kept === undefined ? changes : changes.filter((change) => change.type !== 'select' || change.selected || !kept.has(change.id)));
                              }}
                              onSelectionEnd={() => {
                                // React Flow's marquee unselects its own copy of the kept nodes as it goes, past our
                                // changes: fresh nodes, selected, make it take them again.
                                const kept = keptSelection.current;
                                keptSelection.current = undefined;
                                if (kept === undefined) return;
                                if (kept.nodes.size > 0) setNodes((current) => current.map((node) => (kept.nodes.has(node.id) ? { ...node, selected: true } : node)));
                                // Its connectors too: a new set draws their edges afresh.
                                if (kept.connectors.size > 0) setSelectedConnectors((current) => new Set([...current, ...kept.connectors]));
                              }}
                              nodeTypes={nodeTypes}
                              // A press that moves less than this is a click.
                              nodeDragThreshold={DRAG_THRESHOLD}
                              onNodeDragStart={(event, _node, dragged) => {
                                tileMoves.onDragStart('touches' in event ? event.touches[0] : event, dragged);
                                snapping.onDragStart(dragged);
                                // A dragged tile comes to the front, over notes too, until it lands. An expanded one is over them already.
                                const lifted = new Set(dragged.filter((node) => isSessionTile(node) && node.data.expanded !== true).map((node) => node.id));
                                if (lifted.size > 0) {
                                  setNodes((current) => current.map((node) => (lifted.has(node.id) ? { ...node, zIndex: DRAGGED_TILE_Z_INDEX } : node)));
                                }
                              }}
                              // A click on a tile only selects it; opening it is a double-click (the tile's own) or
                              // Enter. An expanded tile comes to the front, and stays expanded until collapsed: a
                              // click elsewhere leaves it. Shift-click only adds to the selection, and a plain
                              // click on one of several selected selects it alone.
                              onNodeClick={(event, node) => {
                                if (event.shiftKey) return;
                                if (node.selected === true && severalSelected) selectOnly(new Set([node.id]));
                                if ((event.target as HTMLElement).closest(CONTROLS) !== null) return;
                                if (isSessionTile(node)) {
                                  if (node.data.expanded === true) tileActions.expand(node.id);
                                }
                              }}
                              onNodeDrag={(_event, _node, dragged) => setDropTarget(dragged.length === 1 ? dropTargetOf(dragged[0]!) : undefined)}
                              onNodeDragStop={(_event, _node, dragged) => {
                                tileMoves.onDragStop();
                                snapping.onDragStop();
                                setDropTarget(undefined);
                                // Where it was last drawn: snapped, and under the pointer, which React Flow's own reckoning isn't.
                                for (const node of dragged.filter(isZone)) {
                                  saveLayout(node.id, layoutOf(nodesRef.current.filter(isZone).find((known) => known.id === node.id) ?? node));
                                }
                                for (const node of dragged.filter(isItemNode)) itemDropped(node);
                                for (const node of dragged.filter(isSessionTile)) tileDropped(node);
                              }}
                              // Only items are deleted from the keyboard: removing a zone needs a designed, confirmed flow
                              // first, and an agent a confirmation.
                              deleteKeyCode={['Backspace', 'Delete']}
                              // React Flow adds a deleted node's children (a zone's notes) to the list: only items selected
                              // themselves go, and a connector selected itself: one on a deleted item goes with it, in the daemon.
                              onBeforeDelete={async ({ nodes: doomed, edges: doomedEdges }) => {
                                const nodes = doomed.filter((node) => isItemNode(node) && node.selected === true);
                                const going = new Set(nodes.map((node) => node.id));
                                const edges = doomedEdges.filter((edge) => edge.selected === true && !going.has(edge.source) && !going.has(edge.target));
                                return { nodes, edges };
                              }}
                              onEdgesDelete={(deleted) => {
                                for (const edge of deleted.filter(isConnectorEdge)) connectorActions.remove(connectorIdOf(edge));
                                for (const edge of deleted.filter(isFlowEdge)) flow.actions.remove(flowEdgeIdOf(edge));
                              }}
                              onNodesDelete={(deleted) => {
                                for (const node of deleted.filter(isItemNode)) itemActions.remove(node.data.item.id);
                              }}
                              // A double-click opens a tile; zooming on it too would swallow the event.
                              zoomOnDoubleClick={false}
                              // Two-finger scroll and the wheel pan the board any way; a pinch (the wheel with Ctrl, as
                              // Chromium reports it) or the command key with the wheel zooms about the pointer.
                              panOnScroll
                              panOnScrollMode={PanOnScrollMode.Free}
                              zoomOnScroll={false}
                              zoomOnPinch
                              zoomActivationKeyCode={ZOOM_KEY}
                              // The hand pans the board from anywhere: nothing on it moves or is picked. In select mode a
                              // drag on empty board draws a marquee, and the board pans with Space held, the middle
                              // button or the wheel; Shift adds to the selection, by click or by marquee.
                              nodesDraggable={mode === 'select'}
                              elementsSelectable={mode === 'select'}
                              selectionOnDrag={mode === 'select'}
                              panOnDrag={mode === 'select' ? [1] : true}
                              panActivationKeyCode="Space"
                              multiSelectionKeyCode="Shift"
                              selectionMode={SelectionMode.Full}
                              onNodeContextMenu={(event, node) => {
                                event.preventDefault();
                                // On something not selected, the menu is for it alone.
                                if (node.selected !== true) selectOnly(new Set([node.id]));
                                setContextMenu({ at: { x: event.clientX, y: event.clientY }, on: 'selection' });
                              }}
                              onSelectionContextMenu={(event) => {
                                event.preventDefault();
                                setContextMenu({ at: { x: event.clientX, y: event.clientY }, on: 'selection' });
                              }}
                              onPaneContextMenu={(event) => {
                                event.preventDefault();
                                setContextMenu({ at: { x: event.clientX, y: event.clientY }, on: 'board' });
                              }}
                              onlyRenderVisibleElements
                              elevateNodesOnSelect={false}
                              minZoom={0.05}
                              fitView={fitOnLoad}
                              fitViewOptions={{ maxZoom: 1 }}
                              defaultViewport={savedViewport}
                              onMoveEnd={(_event, { x, y, zoom }) => saveViewport({ x, y, zoom })}
                              proOptions={{ hideAttribution: true }}
                            >
                              <Background
                                variant={BackgroundVariant.Dots}
                                gap={desk.gap}
                                size={desk.size}
                                color="var(--surface-dot)"
                              />
                              <ConnectorMarkers />
                              <SelectionBox />
                              <SnapGuides guides={snapping.guides} />
                              {tool !== undefined && (
                                <ToolOverlay
                                  tool={tool}
                                  ghostSize={{ width: AGENT_TILE_SIZE.width * getZoom(), height: AGENT_TILE_SIZE.height * getZoom() }}
                                  onUse={(from, to) => placeWithTool(tool, from, to)}
                                />
                              )}
                              {placeSession.picker !== null && <ViewportPortal>{placeSession.picker}</ViewportPortal>}
                              {addingZone !== undefined && (
                                <ViewportPortal>
                                  <AddZonePopover
                                    key={`${addingZone.layout.x},${addingZone.layout.y}`}
                                    layout={addingZone.layout}
                                    source={addingZone.source}
                                    placement={addZonePlacement(addingZone.layout)}
                                    color={leastUsedColor(zones.map((zone) => zone.color))}
                                    outline={
                                      <div
                                        className="zone-outline"
                                        data-testid="zone-outline"
                                        style={{
                                          transform: `translate(${addingZone.layout.x}px, ${addingZone.layout.y}px)`,
                                          width: addingZone.layout.width,
                                          height: addingZone.layout.height,
                                        }}
                                      />
                                    }
                                    onAdded={zoneAdded}
                                    onCancel={() => setAddingZone(undefined)}
                                  />
                                </ViewportPortal>
                              )}
                            </ReactFlow>
                          </RepresentationProvider>
                          </HandoffsContext>
                          </FlowEdgeActionsContext>
                          </ConnectorActionsContext>
                          </SeveralSelectedContext>
                        </ItemActionsContext>
                      </RenameRequestContext>
                      </ShellFoldersContext>
                      </ClickOpensContext>
                      </TileActionsContext>
                      </IssueCardContext>
                      </AddIssueContext>
                      </CancelCloneContext>
                      </ZoneBindingContext>
                    </BindZoneContext>
                  </ZoneTrackerContext>
                </NewAgentContext>
              </NewShellContext>
            </ZoneResizeContext>
          </SaveZoneLayoutContext>
        </DropTargetContext>
      )}
      <BoardChrome
        loaded={loaded}
        empty={loaded && nodes.length === 0}
        loadedEmpty={loadedEmpty}
        zones={zones}
        agents={agents}
        shells={shells}
        onOpenShell={openShell}
        onAddZone={openAddZone}
        onJump={(zone) => {
          // Where it is now: its node may have been moved or resized since the daemon sent it.
          const node = getNodes().filter(isZone).find((known) => known.id === zone.id);
          if (node !== undefined) bringIntoView(layoutOf(node));
        }}
        onOpenAgent={openAgent}
        onError={report}
        minimapColor={minimapColor}
        grid={grid}
        onGrid={toggleGrid}
        clickOpens={clickOpens}
        onClickOpens={pickClickOpens}
        mode={mode}
        onMode={pickMode}
        tool={tool}
        onTool={setTool}
        ghostSize={{ width: AGENT_TILE_SIZE.width * getZoom(), height: AGENT_TILE_SIZE.height * getZoom() }}
        onDropTool={dropTool}
        onSticky={() => createItem('sticky', boardCentre())}
        onRunInShell={startLooseShell}
        onCloseWindow={closeWindow}
      />
      {/* Only while both its agents are on the board: one deleted takes the edge, which may not have been heard yet. */}
      {shownFlowEdge !== undefined && shownEnds?.from !== undefined && shownEnds.to !== undefined && (
        <EdgeRules
          key={shownFlowEdge.id}
          edge={shownFlowEdge}
          fromName={shownEnds.from.name}
          toName={shownEnds.to.name}
          fromRevision={shownEnds.from.lastMessage}
          drawn={flow.drawn === shownFlowEdge.id}
          live={flow.live.has(shownFlowEdge.id)}
          actions={flow.actions}
          onDelete={() => flow.actions.remove(shownFlowEdge.id)}
          onClose={() => setSelectedFlowEdges(new Set())}
        />
      )}
      {/* Over the board, or in the session window shown over it, whose title bar it would otherwise cover. */}
      {loaded && shownWindow(windows) === undefined && restartBanner}
      {newAgent !== undefined && (
        <NewAgentDialog
          key={newAgent.zone.id}
          zone={newAgent.zone}
          issue={newAgent.issue}
          onStarted={(agent) => {
            const zone = newAgent.zone;
            const linked = agent.issue;
            // Started from an issue picked for it: its card goes in first, so the tile's slot is clear of it (R1).
            if (newAgent.card !== undefined) placeIssueCard(zone, newAgent.card);
            setAgents((current) => upsert(current, agent));
            // Started from an issue another way (the dialog's own picker): its card feeds it all the same, in a spot
            // clear of the tile, with the issue as the tracker lists it now, else as the agent has it.
            if (newAgent.card === undefined && linked !== null && newAgent.issue === undefined) {
              const unlisted = { ...linked, state: '' };
              void window.agentBoard.trackers.issues(zone.id, linked.id).then(
                (found) => placeIssueCard(zone, found.find((each) => each.id === linked.id) ?? unlisted),
                () => placeIssueCard(zone, unlisted),
              );
            }
            setNewAgent(undefined);
          }}
          onCancel={() => setNewAgent(undefined)}
          onZoneChanged={(zone) => {
            setNewAgent((current) => current && { ...current, zone });
            setNodes((current) => withZone(current, zone));
          }}
        />
      )}
      {issueZone !== undefined && (
        <IssueCardDialog
          key={issueZone.id}
          zone={issueZone}
          whyNoStart={issueZone.clone === null ? undefined : whyNoAgents(issueZone)}
          onAddCard={(issue) => {
            placeIssueCard(issueZone, issue);
            setIssueZone(undefined);
          }}
          onStartAgent={(issue) => {
            startFromZoneIssue(issueZone, issue);
            setIssueZone(undefined);
          }}
          onCancel={() => setIssueZone(undefined)}
        />
      )}
      {defaultRepoZone !== undefined && (
        <DefaultRepoDialog
          key={defaultRepoZone.id}
          zone={defaultRepoZone}
          onSaved={(zone) => {
            setNodes((current) => withZone(current, zone));
            setDefaultRepoZone(undefined);
          }}
          onCancel={() => setDefaultRepoZone(undefined)}
        />
      )}
      {trackerZone !== undefined && (
        <ZoneTrackerDialog
          key={trackerZone.id}
          zone={trackerZone}
          onSaved={zoneSaved}
          onCancel={() => setTrackerZone(undefined)}
        />
      )}
      {linking !== undefined && (
        <LinkIssueDialog
          key={linking.agent.sessionId}
          agent={linking.agent}
          zone={linking.zone}
          onLinked={(agent) => {
            setAgents((current) => upsert(current, agent));
            setLinking(undefined);
          }}
          onCancel={() => setLinking(undefined)}
        />
      )}
      {scheduling !== undefined && (
        <ScheduleDialog
          key={scheduling.sessionId}
          agent={scheduling}
          onSaved={(agent) => {
            setAgents((current) => upsert(current, agent));
            setScheduling(undefined);
          }}
          onCancel={() => setScheduling(undefined)}
        />
      )}
      {contextMenu !== undefined && (
        <ContextMenu
          at={contextMenu.at}
          label={contextMenu.on === 'board' ? 'Board' : 'Selection'}
          entries={
            contextMenu.on === 'board'
              ? boardEntries(contextActions)
              : selectionEntries(editing.selection(), selectedConnectors.size, contextActions)
          }
          onClose={() => setContextMenu(undefined)}
        />
      )}
      {pendingDelete !== undefined && (
        <Dialog
          role="alertdialog"
          title={pendingDelete.kind === 'shell' ? 'Delete shell?' : 'Delete agent?'}
          onClose={() => setPendingDelete(undefined)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPendingDelete(undefined)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => (pendingDelete.kind === 'shell' ? deleteShell(pendingDelete.shellId) : deleteAgent(pendingDelete.sessionId, pendingDelete.force))}
              >
                Delete anyway
              </Button>
            </>
          }
        >
          <p>{pendingDelete.message}</p>
        </Dialog>
      )}
      {resumingExternal !== undefined && (
        <ResumeExternalDialog
          key={resumingExternal.session.id}
          session={resumingExternal.session}
          position={resumingExternal.position}
          onResumed={(agent) => {
            const nodeId = tileNodeId('external', resumingExternal.session.id);
            setExternals((current) => current.filter((session) => session.id !== resumingExternal.session.id));
            setExpanded((current) => collapseTile(current, nodeId));
            setAgents((current) => upsert(current, agent));
            setResumingExternal(undefined);
          }}
          onClose={() => setResumingExternal(undefined)}
        />
      )}
      {pendingRestart !== undefined && (
        <Dialog
          role="alertdialog"
          title="Restart agent?"
          onClose={() => setPendingRestart(undefined)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPendingRestart(undefined)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => restartAgent(pendingRestart.sessionId, true)}>
                Restart anyway
              </Button>
            </>
          }
        >
          <p>{pendingRestart.message}</p>
        </Dialog>
      )}
      <TileActionsContext value={tileActions}>
        <SessionWindowsLayer
          agents={agents}
          shells={shells}
          loaded={loaded}
          notice={loaded ? restartBanner : null}
          sessions={navSessions}
          zones={zones}
        />
      </TileActionsContext>
    </div>
  );
}

/** A node's colour on the minimap: a zone's own, a note's, or a tile's. */
function minimapColor(node: Node): string {
  const boardNode = node as BoardNode;
  if (isZone(boardNode)) return boardNode.data.zone.color;
  if (isItemNode(boardNode)) return ITEM_KINDS[boardNode.data.item.kind].minimapColor(boardNode.data.item.data);
  return 'var(--raised)';
}

/** The zone tint fewest of `used` have, the first of equals: the daemon's default for a new zone. */
function leastUsedColor(used: string[]): string {
  const uses = (color: string) => used.filter((each) => each === color).length;
  return ZONE_COLORS.reduce((best, color) => (uses(color) < uses(best) ? color : best));
}

/** `nodes` with a zone change from the daemon applied. */
function withZoneChange(nodes: BoardNode[], change: ZoneChange): BoardNode[] {
  return change.type === 'zone.updated' ? withZone(nodes, change.zone) : withoutZone(nodes, change.id);
}


/** How long the view must be still before where it is gets saved. */
const SAVE_VIEWPORT_DELAY_MS = 300;

/** How long the expanded tiles must stay as they are before they are saved. */
const SAVE_EXPANDED_DELAY_MS = 200;

/** A saved viewport, if `value` is one. */
function viewportFrom(value: unknown): Viewport | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { x, y, zoom } = value as Record<string, unknown>;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  return finite(x) && finite(y) && finite(zoom) && zoom > 0 ? { x, y, zoom } : undefined;
}
