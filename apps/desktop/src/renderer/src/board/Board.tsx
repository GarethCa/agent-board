import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeChanges as applyFlowNodeChanges,
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
  type NodeChange,
  type NodeTypes,
  type Rect,
} from '@xyflow/react';
import {
  DEFAULT_ZONE_SIZE,
  MIN_ZONE_SIZE,
  ZONE_COLORS,
  type Agent,
  type AgentStart,
  type ArrangeSpacing,
  issueCardData,
  type IssueCardData,
  type TrackerIssue,
  type BoardItem,
  type BoardItemKind,
  DEFAULT_CONNECTOR_LOOK,
  type Connector,
  type ConnectorEnd,
  type ConnectorSide,
  type FlowEdgeSide,
  type UpdateConnectorParams,
  type ExternalSession,
  type Shell,
  type ShellPlace,
  type ShapeType,
  type Zone,
  type ZoneBinding,
  type TileMove,
  type ZoneLayout,
  zoneSnapshot,
} from '@agent-board/daemon/protocol';
import { EFFORT_LABELS } from './AgentSetup';
import { paneIds } from '@agent-board/daemon/pane-layout';
import { repoZoneOf } from '@agent-board/daemon/repo-zone';
import { BoardChrome } from '../chrome/BoardChrome';
import type { PointerMode } from '../chrome/CreateToolbar';
import type { ZoneSource } from '../chrome/zones';
import { errorMessage } from '../../../shared/errors';
import { ZOOM_KEY } from '../keys';
import { motionDuration, tokenNumber } from '../theme';
import { Button, Checkbox, Dialog, useToast } from '../ui';
import { markSeen } from '../session/mark-seen';
import { boardSettled } from '../session/terminal-sharpness';
import { handOffWebTabs, SessionWindowsLayer } from '../windows/SessionWindows';
import type { NavSession } from '../windows/session-nav';
import { requestReviewTab } from '../review/review-tab';
import { requestTab } from '../session/tab-request';
import { forgetViewsExcept } from '../session/session-view';
import {
  agentWorktrees,
  dropKey,
  dropMove,
  dropOver,
  dropTaken,
  ownerAtPoint,
  paneAtPoint,
  placeOf,
  tabDrag,
  tabMover,
  surfaceMoveChanges,
  tabMoveChanges,
  tilesFirst,
  useDragsFromOtherWindows,
  useTabDrag,
  type TabDrag,
  type SurfaceMove,
  type TabMove,
} from '../session/shell-moves';
import { boardDrop } from '../session/window-drags';
import { documentSurfaceOf, gateSurfaceOf, liveShellCount, planSurfaceOf, pullRequestSurfaceOf, tabSurface } from '../session/tabs';
import { shownWindow } from '../windows/session-windows';
import { BoardBackdrop } from './BoardBackdrop';
import { oneAtATime } from './one-at-a-time';
import { installWheelLatch } from './wheel-latch';
import { CONNECTOR_LABEL_PLACES, ConnectorActionsContext, type ConnectorActions } from './connectors/actions';
import { ConnectorEdge, ConnectorMarkers } from './connectors/ConnectorEdge';
import { withConnectorHandles } from './connectors/ConnectorHandles';
import { setNearNode, useFindNear } from './connectors/near';
import {
  connectorEdges,
  CONNECTOR_EDGE_PREFIX,
  connectorIdOf,
  endOfNode,
  isConnectorEdge,
  nearestSide,
  newEndAt,
  nodeIdOf,
  shapeOf,
  withConnector,
  withConnectorParams,
  createParamsOf,
} from './connectors/endpoints';
import { AddZonePopover } from './AddZonePopover';
import { draggedZoneLayout, popoverPlacement } from './add-zone';
import { AgentFlowEdge, BriefEdge, FlowEdgeActionsContext, type FlowEdgeActions } from './FlowEdge';
import { TakenJobsContext, useTakenJobs } from './items/taken-jobs';
import { draggedJob, JOB_DRAG, openHandOn, QueueBoardContext, setJobDropOver, startJobDrag, takesJobFrom, type QueueBoard } from './items/queue-board';
import { HandOnHost } from './items/HandOn';
import { DrainSheetHost } from './items/DrainSheet';
import { QueueFocusHost } from './items/QueueFocus';
import { FLOW_EDGE_TYPE, flowEdgeIdOf, flowEdgeIdsOf, flowEdges, type FlowRailData, handoffEnds, HandoffsContext, isFlowEdge, NEW_EDGE_LABEL, panClear } from './flow-edges';
import { useFlowEdges } from './use-flow-edges';
import { foldedSessionIds, foldedToast, roomOf, unfoldedToast, unfoldMoves, withFoldedExternals, withFoldedZones } from './fold-zone';
import { letGoFoldedTerminals } from '../session/TerminalPane';
import { foldedStack, isLead, laidOutTile, pinnedLead, withShelves } from './shelves';
import { ShelvesContext } from './ShelvesView';
import { useShelves } from './use-shelves';
import { useIncoming } from './use-incoming';
import { ConnectionLine, HandingOffContext } from './ConnectionLine';
import { HandOffChooser } from './connectors/HandOffChooser';
import { EdgeRules } from './EdgeRules';
import { MasterPanel } from '../master/MasterPanel';
import { masterRails } from '../master/master-view';
import { useMasterPanel } from '../master/use-master-panel';
import { BRIEF_EDGE_TYPE, briefEdges, cardHasAgent, issueCardFor } from './brief-edges';
import { handlesLost } from './handle-bounds';
import { IssueCardDialog } from './IssueCardDialog';
import type { PickedIssue } from './IssuePicker';
import { IssueCardContext, type IssueCardActions } from './items/IssueNode';
import { withSavedLayout, withZone } from './zone-nodes';
import type { States } from './editing/history';
import { SelectionBox, SnapGuides } from './editing/SelectionOverlays';
import { useAskClaude } from './ask/AskClaude';
import { SuggestionActionsContext, SuggestionGhosts, useSuggestionCommands } from './ask/SuggestionGhosts';
import { DocumentCardsContext, type DocumentCards } from './items/DocumentNode';
import { PlanCardsContext, type PlanCards } from './items/PlanNode';
import { StepsLookupContext } from './items/StepsNode';
import type { StepsLookup } from './items/steps-view';
import { useShownDocuments } from '../doc/use-shown-documents';
import { CREW_STOP_LINE, agentLine, externalEnded, externalLine, sameDelete, type PendingDelete } from './editing/delete-plan';
import { useEditing } from './editing/use-editing';
import { renameDirect, renameKey, paneLabel, RenameRequestContext, type RenameTarget } from './rename';
import { zoneDeleteText, type ZoneToDelete } from './editing/delete-zones';
import { historyKey, itemChange, patched, useHistory, type BoardState, type Change, type DissolvedGroup } from './editing/use-history';
import { useSnapping } from './editing/use-snapping';
import { tidySize, VIEW_FOLLOW_DELAY_MS } from './expanded';
import { tileOpenAction } from './click-opens';
import { focusTerminalIn, pulseTile } from './tile-attention';
import { crewFrames, crewMoves, frameableTiles, landingRects, withCrewFollowing } from './crews';
import { restoreViewSettings, setCrewLook, setViewSetting, useViewSettings } from './view-settings';
import { ConnectionCountsContext, edgeCounts, nextConnectionsView, shownEdges } from './connections-view';
import { railOf, withRailSelected } from './rails';
import { CrewFramesContext, CrewViewContext, nextCrewLook, type CrewView } from './crew-view';
import { AgentNoteLookContext, type AgentNoteLook } from './items/agent-note-look';
import { useSimplified } from '../design';
import { agentNoteTethers, isTether, TETHER_EDGE_TYPE } from './items/agent-note-tethers';
import { TetherEdge } from './items/TetherEdge';
import {
  boundsOnBoard,
  isItemNode,
  ITEM_NODE_PREFIX,
  ItemActionsContext,
  placeOnBoard,
  SeveralSelectedContext,
  restoredData,
  withItem,
  withoutItem,
  type ItemActions,
  type ItemNodeType,
} from './items/items';
import { MIN_SHAPE_SIZE } from './items/ShapeNode';
import { cardOfRunningCrew, crewCardData } from './items/crew-card';
import { CrewCardBoardContext, type CrewCardBoard } from './items/CrewCardNode';
import { SHAPES } from './items/shapes/catalogue';
import { QuickInsert } from './items/shapes/QuickInsert';
import { lastShape, noteShapeUsed } from './items/shapes/recents';
import { newShapeData } from './items/text-style';
import { ITEM_KINDS, ITEM_NODE_TYPES, type ItemKind } from './items/kinds';
import { liveRotations, LiveRotationsContext, withRotation } from './items/Rotatable';
import type { BoardRequest, ScreenPoint, WindowTarget } from '../../../preload/api';
import { VIEW_KEYS, viewSaver } from '../../../shared/view-saver';
import { useProvideBoardCommands, type BoardCommands } from './commands';
import { tileSizeOf, withTileSize } from './tile-size';
import { AGENT_TILE_SIZE, freeItemSpot, freeSpotFor, isFolded, rotatedBounds, sizedFootprint, TILE_GAP, ZONE_PADDING, type Point } from '@agent-board/daemon/board-layout';
import { arrangeBoard as arrangeBoardLayout } from '@agent-board/daemon/arrange-board';
import { tidyLoose as tidyLooseLayout, tidyZone as tidyZoneLayout } from '@agent-board/daemon/board-tidy';
import { LinkIssueDialog } from './LinkIssueDialog';
import { ClockDialog, type ClockEditing } from './ClockDialog';
import { clockData, clockTethers } from './clocks';
import { ClockBoardContext, type ClockBoard } from './items/ClockNode';
import { useClockStatuses } from './use-clocks';
import { GateCommandDialog } from '../gate/GateCommandDialog';
import { ResumeExternalDialog } from './ResumeExternalDialog';
import { NewAgentDialog } from './NewAgentDialog';
import { CrewFlow, prefabNamed, type CrewFlowStart } from '../crews/CrewFlow';
import { usePrefabs } from '../crews/prefab-store';
import { RoleTemplatesDialog } from './RoleTemplatesDialog';
import { DefaultRepoDialog } from './DefaultRepoDialog';
import { useRestartBanner } from './RestartBanner';
import { useBoardData, type SavedView } from './use-board-data';
import { agentTitle, shellTitle, useBoardWindows } from './use-board-windows';
import { useExpandedTiles } from './use-expanded-tiles';
import { DEFAULT_REPRESENTATION, RepresentationProvider } from './representations';
import { TileNode } from './TileNode';
import { TileMenuBoardContext } from './agent-tile-menu';
import { ClickOpensContext, ShellFoldersContext, TileActionsContext, type ShellFolders, type TileActions, type TileData, type TileNodeType } from './tile';
import {
  DRAGGED_TILE_Z_INDEX,
  EXTERNAL_NODE_PREFIX,
  isSessionTile,
  isStartTile,
  isZone,
  layoutOf,
  shellWithPane,
  compactSizeOf,
  sizeOfNode,
  subjectOf,
  tileNodeId,
  tileSubject,
  withTiles,
  type BoardNode,
  savedMove,
  savedPlace,
} from './tiles';
import { ToolOverlay, TOOL_DRAG_MIN, type ArmedTool } from './ToolOverlay';
import { useAgentStarts } from './use-agent-starts';
import { usePlaceSession } from './use-place-session';
import { dropPlace, issueStartIn } from './place-session';
import type { ZoneBindingActions } from './menu-model';
import {
  AddIssueContext,
  BindZoneContext,
  ZoneBindingContext,
  CancelCloneContext,
  DropTargetContext,
  NewAgentContext,
  NewShellContext,
  SaveZoneLayoutContext,
  whyNoAgents,
  ZoneNode,
  ZoneResizeContext,
  ZoneTrackerContext,
} from './ZoneNode';
import { ZoneTrackerDialog } from './ZoneTrackerDialog';
import { droppedOnto } from './displace';
import { DRAG_THRESHOLD, useTileMoves } from './use-tile-moves';
import { useBoardMenu } from './use-board-menu';
import { useBoardShortcuts } from './use-board-shortcuts';
import { useDeleteSelection } from './use-delete-selection';
import { useRenameRequests } from './use-rename-requests';
import { CONTROLS, quickInsertAt, SESSION_SURFACES } from './board-shortcuts';
import type { SheetContext } from '../keys/cheat-sheet';
import { useCheatSheet } from '../keys/CheatSheet';
import { keyText } from '../keys/registry';
import { centreOf } from '../geometry';
import { useZoneResize } from './use-zone-resize';
import { useMeasuredBoxes } from './measured-boxes';
import { AgentNoteMeasurer } from './items/AgentNoteMeasurer';
import { CAPTURE_FRAME, captureViewport, edgesAmong, nodesInZone, useCaptureReady } from './capture-mode';
import { useDemoCamera } from '../demo/use-demo-camera';
import { NewNoteContext } from './ProjectWell';
import { projectSummaries, ProjectSummaryContext } from './project-summary';
import { useNeedsYouShows } from '../needs-you-setting';

// Module-level so React Flow never sees a new object and re-mounts every node.
const nodeTypes: NodeTypes = {
  zone: withConnectorHandles(ZoneNode),
  tile: withConnectorHandles(TileNode),
  // An item's connector handles turn with it.
  ...Object.fromEntries(Object.entries(ITEM_NODE_TYPES).map(([type, node]) => [type, withRotation(withConnectorHandles(node))])),
};
/** How long a tile's hidden connections stay shown after the pointer leaves it, to reach one. */
const HOVER_GRACE_MS = 400;
const edgeTypes: EdgeTypes = { connector: ConnectorEdge, [BRIEF_EDGE_TYPE]: BriefEdge, [FLOW_EDGE_TYPE]: AgentFlowEdge, [TETHER_EDGE_TYPE]: TetherEdge };

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
    if (element.closest('.react-flow__panel, .react-flow__minimap, .react-flow__controls, .connector-bar, .connector-label, .connector-end-label')) {
      return { type: 'nothing' };
    }
  }
  return { type: 'nothing' };
}

/** How much room bringing something into view leaves round what it shows, as a fraction of the view (not a spacing token). */
const FIT_MARGIN = 0.15;
/** The zoom ⌘K flies the board in to, at least, to show a tile: its name and state read. */
const READABLE_ZOOM = 1;

/** Where a mouse event is on the screen; undefined for a touch. */
function pointOf(event: unknown): { x: number; y: number } | undefined {
  const { clientX, clientY } = event as { clientX?: unknown; clientY?: unknown };
  return typeof clientX === 'number' && typeof clientY === 'number' ? { x: clientX, y: clientY } : undefined;
}

/**
 * Gives the keyboard to the board once the windows a move changed have settled (a window whose tab went shows another,
 * whose terminal would take it), so ⌘Z takes the move back, as it does any board edit.
 */
function keyboardToBoard(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest(SESSION_SURFACES) !== null) active.blur();
    }),
  );
}

/** After a move, or its undo or redo: the board has the keyboard, and so does no popped-out window's terminal. */
function movesSettled(): void {
  keyboardToBoard();
  window.agentBoard.tabDrags.settled();
}

/**
 * Moves a pull request, web or session tab between windows (slice 4), as the daemon lays both out: a web
 * tab's page handed off first, so the window it goes to takes it as it is, and handed back if the move fails.
 */
async function moveSurface({ surface, from, to }: SurfaceMove) {
  const web = surface.kind === 'web' ? surface.id : undefined;
  if (web !== undefined) await window.agentBoard.webTabs.handOff(web);
  try {
    return await window.agentBoard.shells.moveSurface(surface, from, to);
  } catch (error) {
    if (web !== undefined) await window.agentBoard.webTabs.cancelHandOff(web);
    throw error;
  }
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

/** Closes every confirmation of deleting a session. */
const DELETE_FINAL = "Deleting a session can't be undone.";

/** The id of the hint shown while a "Connect to…" waits for its other end. */
const CONNECT_HINT = 'connect-to';

function BoardView() {
  const [nodes, setNodes] = useNodesState<BoardNode>([]);
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
  /** Shows why `action` failed. */
  const report = useCallback(
    (action: string, retry?: () => void) => (error: unknown) =>
      setNotice({ message: `Could not ${action}: ${errorMessage(error)}`, retry }),
    [setNotice],
  );
  /** The connectors selected, by id. React Flow reports a selection, and the edges are drawn from `connectors`. */
  const [selectedConnectors, setSelectedConnectors] = useState<ReadonlySet<string>>(new Set());
  const selectedConnectorsRef = useRef(selectedConnectors);
  selectedConnectorsRef.current = selectedConnectors;
  /** Whether a drag snaps to the grid rather than to what is near it; kept in the view state. */
  const [grid, setGrid] = useState(false);
  /** What was selected as a Shift-drag on empty board or a zone's bare body began: its marquee adds to that (WbTools). */
  const keptSelection = useRef<{ nodes: ReadonlySet<string>; connectors: ReadonlySet<string> }>(undefined);
  /** The connector label being typed. */
  const [editingConnector, setEditingConnector] = useState<ConnectorActions['editing']>();
  /**
   * The node a connector is being dragged from a handle of, while it is: the object near the pointer shows its handles
   * (`useFindNear`), and the one under it is marked.
   */
  const [connecting, setConnecting] = useState<string>();
  /** Whether the connector being dragged leaves an agent's tile, so could be a hand-off. */
  const connectingFromAgent = useRef(false);
  /** Whether ⌥ is held while it is, so let go on another agent's tile it is a hand-off: only agents' tiles are targets. */
  const [handingOff, setHandingOff] = useState(false);
  /** Whether Escape has called off the hand-off being dragged: letting go then joins nothing. */
  const handOffCancelled = useRef(false);
  /** A connector just dropped from one agent's tile on another's, until the chooser says what it is. */
  const [handOffChoice, setHandOffChoice] = useState<{ connectorId: string; from: string; to: string; toSide: FlowEdgeSide; at: { x: number; y: number } }>();
  /** The zone a new agent is being asked for, with the issue it starts from and where its tile goes, if known. */
  const [newAgent, setNewAgent] = useState<{ zone?: Zone; issue?: PickedIssue; issueZoneId?: string; card?: IssueCardData; name?: string; position?: { x: number; y: number } }>();
  const setNewAgentZone = useCallback((zone: Zone | undefined) => setNewAgent(zone && { zone }), []);
  const [trackerZone, setTrackerZone] = useState<Zone>();
  /** The group whose default repo is being picked. */
  const [defaultRepoZone, setDefaultRepoZone] = useState<Zone>();
  /** Where Add zone's outline is on the board, and the tab it opened on, while it is open. */
  // The zone last brought into view, from the zones pill, the board menu or ⌘K: the zones pill keeps it in view.
  const [currentZone, setCurrentZone] = useState<string>();
  const [addingZone, setAddingZone] = useState<{ layout: ZoneLayout; source: ZoneSource }>();
  /** The zone whose issue is being picked, for its card or an agent. */
  const [issueZone, setIssueZone] = useState<Zone>();
  /** The zone a dragged tile or note would move into if dropped now. */
  const [dropTarget, setDropTarget] = useState<string>();
  /** The agent whose issue is being picked, and its zone. */
  const [linking, setLinking] = useState<{ agent: Agent; zone: Zone }>();
  /** The clock whose editor is open, or the agent a new one is for. */
  const [clockEditing, setClockEditing] = useState<ClockEditing>();
  const [gateCommandZone, setGateCommandZone] = useState<Zone>();
  const [roleTemplatesZone, setRoleTemplatesZone] = useState<Zone>();
  const [crewFlow, setCrewFlow] = useState<CrewFlowStart>();
  /** The builder of a crew just started, until its tile is on the board to show. */
  const [crewStarted, setCrewStarted] = useState<string>();
  // Keeps the library followed, and the board's right-click menu current with it; a Classic zone's ⋯ follows it itself.
  usePrefabs();
  const { windows, windowsRestored, windowsRef, showWindow, closeWindow, popOut, popOutTabWindow, openShell, openAgent, poppedOut, onShellChange } = useBoardWindows();
  /** The view settings every window shares: what a double-click opens, how crews and agent notes look, which connections are drawn. */
  const { clickOpens, crewLook, connections, agentNoteLook: savedNoteLook } = useViewSettings();
  // The Simplified design has one look for a note an agent writes, a card: the setting is Classic's alone.
  const agentNoteLook: AgentNoteLook = useSimplified() ? 'document' : savedNoteLook;
  const crewLookRef = useRef(crewLook);
  crewLookRef.current = crewLook;
  const cycleCrewLook = useCallback(() => setCrewLook(nextCrewLook(crewLookRef.current)), []);
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  const cycleConnections = useCallback(() => setViewSetting('connections', nextConnectionsView(connectionsRef.current)), []);
  /** The tile the pointer is over, whose own connections show meanwhile, and a moment after it leaves: time to reach one. */
  const [hoveredTile, setHoveredTile] = useState<string>();
  const hoverEnds = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Always followed, but kept in state only while some are hidden: the board redraws for it, and not at all with all drawn.
  const hoveredNow = useRef<string>(undefined);
  const hoverTile = useCallback((id: string | undefined) => {
    clearTimeout(hoverEnds.current);
    const set = (to: string | undefined) => {
      hoveredNow.current = to;
      if (connectionsRef.current !== 'all') setHoveredTile(to);
    };
    if (id !== undefined) set(id);
    else hoverEnds.current = setTimeout(() => set(undefined), HOVER_GRACE_MS);
  }, []);
  useEffect(() => setHoveredTile(connections === 'all' ? undefined : hoveredNow.current), [connections]);
  useEffect(() => () => clearTimeout(hoverEnds.current), []);
  // Who is in each crew frame, where the tiles are saved: for the tiles, and for an expanded tile to push each crew
  // aside as one; kept while the same so a frame moving with its crew redraws only the zones.
  const savedFrames = useMemo(() => (crewLook === 'frames' ? crewFrames(frameableTiles(nodes)) : []), [crewLook, nodes]);
  const crewsKey = savedFrames.map((frame) => frame.members.join(' ')).join('\n');
  const framedKey = savedFrames.flatMap((frame) => frame.members).join(' ');
  const crewView = useMemo<CrewView>(() => ({ look: crewLook, framed: new Set(framedKey.split(' ').filter(Boolean)) }), [crewLook, framedKey]);
  const crewBlocks = useMemo(
    () => (crewsKey === '' ? [] : crewsKey.split('\n').map((members) => members.split(' ').map((id) => tileNodeId('agent', id)))),
    [crewsKey],
  );
  /** React Flow's node changes applied, with an orchestrator's crew dragged along with it under crew frames. */
  const applyNodeChanges = useCallback(
    (changes: NodeChange<BoardNode>[]) => {
      setNodes((current) => applyFlowNodeChanges(crewLookRef.current === 'frames' ? withCrewFollowing(changes, current) : changes, current));
    },
    [setNodes],
  );
  /** The agent the user asked to open from its notification, until the board has its agents to open it. */
  const [openRequest, setOpenRequest] = useState<string>();
  const [pendingDeletes, setPendingDeletes] = useState<PendingDelete[]>([]);
  const pendingDelete = pendingDeletes[0];
  /** Asks the user to confirm a delete, after any already waiting. */
  const askDelete = useCallback(
    (ask: PendingDelete) => setPendingDeletes((current) => (current.some((known) => sameDelete(known, ask)) ? current : [...current, ask])),
    [],
  );
  /** Drops the delete being asked about: it was confirmed or cancelled. */
  const settleDelete = useCallback(() => {
    setPendingDeletes((current) => current.slice(1));
    setCloneTicked(false);
  }, []);
  /** Whether the box a delete offers (`cloneLabel`) is ticked: it starts unticked for each. */
  const [cloneTicked, setCloneTicked] = useState(false);
  /** The home directory loose shells start in, for shell tiles' folder chips and `~` in paths; undefined until the daemon says. */
  const [home, setHome] = useState<string>();
  /** An ended agent to restart once the user says so, as the shell its pane dropped into is running something. */
  const [pendingRestart, setPendingRestart] = useState<{ sessionId: string; message: string }>();
  /** A failed start to start again once the user confirms its warning: its worktree has Codex config of its own. */
  const [confirmingStart, setConfirmingStart] = useState<AgentStart>();
  /** The external session being resumed in agent-board, and where the board draws a tile it slotted into its zone. */
  const [resumingExternal, setResumingExternal] = useState<{ session: ExternalSession; position?: { x: number; y: number } }>();
  const { flowToScreenPosition, getInternalNode, getNodes, getZoom, screenToFlowPosition, setViewport, updateNodeData } = useReactFlow<BoardNode>();
  const flowStore = useStoreApi<BoardNode>();

  /**
   * Brings a part of the board into view, zooming out if it must but never in. Not `fitView({ nodes })`: that waits for
   * the node to be measured, and a node off-screen is culled, so never measured, and the view jumps to the board's origin.
   */
  const bringIntoView = useCallback(
    (rect: Rect) => {
      const { width, height, minZoom } = flowStore.getState();
      void setViewport(getViewportForBounds(rect, width, height, minZoom, getZoom(), FIT_MARGIN), {
        duration: motionDuration(tokenNumber('--motion-base')),
      });
    },
    [flowStore, setViewport, getZoom],
  );
  /**
   * Flies the board to a part of it: centred, zoomed in to a size to read if the board is zoomed out past it, or out
   * as far as it must to fit. With reduced motion it jumps there. Returns how long the flight takes, in ms.
   */
  const flyTo = useCallback(
    (rect: Rect) => {
      const { width, height, minZoom } = flowStore.getState();
      const duration = motionDuration(tokenNumber('--motion-base'));
      void setViewport(getViewportForBounds(rect, width, height, minZoom, Math.max(getZoom(), READABLE_ZOOM), FIT_MARGIN), { duration });
      return duration;
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
  /** The board's nodes as last rendered, for callbacks that run as a node goes, before React Flow has caught up. */
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  /** Items made here that the daemon hasn't confirmed yet: a change to one waits for it. */
  const pendingCreates = useRef(new Map<string, Promise<unknown>>());
  /** Tiles moved here whose new place the daemon hasn't saved yet, by node id: they show there meanwhile. */
  const pendingPlaces = useRef(new Map<string, TileMove>());
  /** The zones of agents being started from an issue the New agent dialog picked, by session id, for their issue's card. */
  const issueCardsDue = useRef(new Map<string, Zone>());
  /** The agents being started: each has a tile until its agent is listed. */
  const { starts, drop: dropStart } = useAgentStarts(report);
  const startsRef = useRef(starts);
  startsRef.current = starts;
  /**
   * Spots taken by loose shells being made, until their tiles are on the board (`shellId` once the daemon has made
   * one), so a second made meanwhile goes elsewhere.
   */
  const looseSpots = useRef(new Set<{ rect: ZoneLayout; shellId?: string }>());
  /** Each zone's layout as this window last saved it, for undoing its next move or resize. */
  const savedZoneLayouts = useRef(new Map<string, ZoneLayout>());
  /** The fill opacity each zone had before the slider drag under way on it (null: the theme's own), until it is saved. */
  const fillBeforeDrag = useRef(new Map<string, number | null>());
  /** Puts board objects back as an undo or redo has them; set once the board's actions are. */
  const applyStates = useRef<(states: States<BoardState>) => void>(() => {});
  const history = useHistory((states) => applyStates.current(states));

  /** `nodes` with the session tiles laid out from the agents, shells and external sessions, moves in flight applied. */
  const laidOut = useCallback(
    (nodes: BoardNode[]) =>
      withTiles(nodes, agentsRef.current, shellsRef.current ?? [], externalsRef.current, pendingPlaces.current, expandedRef.current, tileSizesRef.current, new Set(unfoldedRef.current), startsRef.current),
    [],
  );
  const relayout = useCallback(() => setNodes(laidOut), [setNodes, laidOut]);

  /** Puts back the expanded tiles saved with the view; set once their hook is, below the board's data. */
  const restoreTiles = useRef<(view: SavedView) => void>(() => {});
  /** Puts back the view state read with the board, all in the render that shows its lists. */
  const restoreView = useCallback((view: SavedView) => {
    restoreTiles.current(view);
    restoreViewSettings(view);
  }, []);

  const flow = useFlowEdges(report, history.record, (message) => toasts.show({ tone: 'info', message }));
  const flowEdgesRef = useRef(flow.edges);
  flowEdgesRef.current = flow.edges;
  const {
    loaded,
    fitOnLoad,
    loadedEmpty,
    savedViewport,
    agents,
    agentsRef,
    agentHeard,
    agentGone,
    agentPlaced,
    externals,
    externalsRef,
    externalGone,
    externalPlaced,
    shells,
    shellsRef,
    shellHeard,
    shellsHeard,
    shellPlaced,
    connectors,
    setConnectors,
    connectorsRef,
    reloadExternals,
    clonesWatched,
  } = useBoardData({
    setNodes,
    report,
    setNotice,
    onShellChange,
    restoreView,
  });

  const {
    shown,
    shownRef,
    expandedRef,
    tileSizesRef,
    unfoldedRef,
    restoreExpanded,
    expand,
    bringTileToFront,
    collapse,
    collapseFrontTile,
    resizeExpandedTile,
    sizeTile,
    setUnfolded,
    allowOverlap,
    freeOverlaps,
  } = useExpandedTiles({ nodes, loaded, agents, shells, externals, windows, windowsRestored, relayout, crews: crewBlocks });
  /** The crew frames as drawn, for the zones: round where their tiles are drawn, pushed aside by an expanded tile or not. */
  const shownFrames = useMemo(
    () => (crewLook === 'frames' ? crewFrames(frameableTiles(nodes), shown.filter(isSessionTile)) : []),
    [crewLook, nodes, shown],
  );
  // Each project's heading under the Simplified design: how many of its agents need you, and the rest by status. A
  // folded zone's chip reads it in both designs, with the external sessions it hides counted too.
  const needsYouShows = useNeedsYouShows();
  const foldedZones = nodes.flatMap((node) => (isZone(node) && node.data.zone.folded ? [node.id] : [])).join('\n');
  const summaries = useMemo(
    () => withFoldedExternals(projectSummaries(agents, needsYouShows), foldedZones === '' ? [] : foldedZones.split('\n'), externals),
    [agents, needsYouShows, foldedZones, externals],
  );
  // The same map until a count changes: every well reads it, and agents change on every bit of activity.
  const summariesKey = JSON.stringify([...summaries]);
  const projectSummary = useMemo(() => summaries, [summariesKey]);
  restoreTiles.current = restoreExpanded;
  const clockStatuses = useClockStatuses(report, loaded);
  useCaptureReady(loaded);
  useMeasuredBoxes(nodes, shown, expandedRef.current, agentNoteLook);
  // The shelved zones' work on their shelves, as drawn only: what the user dragged and saved stays as it was.
  const shelves = useShelves();
  const shelfLinks = useMemo(() => flow.edges.map((edge) => ({ from: tileNodeId('agent', edge.from), to: tileNodeId('agent', edge.to) })), [flow.edges]);
  const shelved = useMemo(
    () => withShelves(shown, { agents, links: shelfLinks, shows: needsYouShows, choice: shelves.choice }),
    [shown, agents, shelfLinks, needsYouShows, shelves.choice],
  );
  const shelvedRef = useRef(shelved);
  shelvedRef.current = shelved;
  const { openStack, showDone } = shelves;
  /**
   * An agent folded out of sight in a zone laid out by status, shown: Done shown if that is where it is, its stack fanned
   * out on shelves, and the part of the board it will be drawn in, to bring into view. Undefined for one drawn as a tile.
   */
  const unfoldStack = useCallback(
    (sessionId: string) => {
      const place = foldedStack(shelvedRef.current, sessionId, AGENT_TILE_SIZE.height);
      if (place?.showDone === true) showDone(place.zoneId);
      if (place?.fan === true) openStack(place.zoneId, place.key);
      return place?.rect;
    },
    [openStack, showDone],
  );
  const shelvesActions = useMemo(() => ({ toggleStack: shelves.toggleStack, toggleDone: shelves.toggleDone, shows: needsYouShows }), [shelves.toggleStack, shelves.toggleDone, needsYouShows]);
  // The board's nodes as drawn: a shelved zone's work on its shelves, a folded zone as a chip with nothing of its inside.
  const drawn = useMemo(() => withFoldedZones(shelved), [shelved]);
  // A folded zone's terminals are let go whatever the keep-terminals setting says: that is the memory it frees.
  const foldedSessions = useMemo(
    () => [...foldedSessionIds(nodes.filter(isZone).map((node) => node.data.zone), agents, shells ?? [])].sort().join('\n'),
    [nodes, agents, shells],
  );
  // Every change, to none too: one opened while its zone stays folded goes as it leaves its pane, and none once unfolded.
  useEffect(() => {
    letGoFoldedTerminals(foldedSessions === '' ? [] : foldedSessions.split('\n'));
  }, [foldedSessions]);

  // The refs laidOut reads are this render's.
  useEffect(() => {
    if (loaded) relayout();
  }, [loaded, agents, shells, externals, starts, relayout]);

  // A new loose shell's tile is on the board now: its spot needs keeping no longer.
  useEffect(() => {
    for (const spot of looseSpots.current) {
      if (spot.shellId !== undefined && shells?.some((shell) => shell.id === spot.shellId)) looseSpots.current.delete(spot);
    }
  }, [shells]);

  // A wheel gesture stays with the surface it started on, so a pan keeps its momentum across a terminal or a note.
  useEffect(() => (container.current === null ? undefined : installWheelLatch(container.current, ZOOM_KEY)), []);

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

  /**
   * Deletes the agent, keeping its worktree and branch if `keep`; without `force`, the daemon refuses if that would lose
   * work, and the user is asked.
   */
  const deleteAgent = useCallback(
    (sessionId: string, force: boolean, keep = false) => {
      window.agentBoard.agents.delete(sessionId, force, keep).then((result) => {
        if (result.status === 'unsaved') {
          const message = `${result.message}. Deleting the agent removes its worktree and branch, and that work with them.`;
          return askDelete({
            title: 'Delete agent?',
            lines: [message, DELETE_FINAL],
            confirm: 'Delete anyway',
            keepLabel: 'Keep worktree and branch',
            run: (keepIt) => deleteAgent(sessionId, true, keepIt),
          });
        }
        agentGone(sessionId);
        closeWindow(sessionId);
      }, report('delete the agent'));
    },
    [report, agentGone, closeWindow, askDelete],
  );
  /** An agent's Restart or Resume, pressed again while one is going: ignored. */
  const lifecycleOnce = useMemo(() => oneAtATime(), []);
  /** Restarts the ended agent; without `force`, the daemon refuses if its shell is running something, and the user is asked. */
  const restartAgent = useCallback(
    (sessionId: string, force: boolean) => {
      setPendingRestart(undefined);
      void lifecycleOnce(sessionId, () =>
        window.agentBoard.agents.restart(sessionId, force).then((result) => {
          if (result.status === 'busy') return setPendingRestart({ sessionId, message: `${result.message}. Restarting the agent ends it.` });
          agentHeard(result.agent);
        }, report('restart the agent')),
      );
    },
    [report, agentHeard, lifecycleOnce],
  );
  /** Deletes the shell tile and ends its panes. */
  const deleteShell = useCallback(
    (shellId: string) => {
      window.agentBoard.shells.delete(shellId).then(() => closeWindow(shellId), report('delete the shell'));
    },
    [report, closeWindow],
  );
  /** Takes the external session's tile off the board, without touching the session. */
  const dismissExternal = useCallback(
    (id: string) =>
      void window.agentBoard.external.dismiss(id).then(
        () => externalGone(id),
        report('remove the session from the board'),
      ),
    [report, externalGone],
  );
  /** `moveTile`, for the tile actions made before it. */
  const moveTileRef = useRef<(nodeId: string, tile: TileData, move: TileMove, coalesce?: string) => void>(() => {});
  /** Where the view will move to show a tile just expanded, once it is laid out. */
  const viewFollow = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(viewFollow.current), []);
  /** The name of what a rename target names now, as the board last heard it: '' for a pane without a label. */
  const nameOf = useCallback((target: RenameTarget): string | undefined => {
    if (target.kind === 'agent') return agentsRef.current.find((agent) => agent.sessionId === target.sessionId)?.name;
    if (target.kind === 'zone') return nodesRef.current.filter(isZone).find((node) => node.id === target.zoneId)?.data.zone.name;
    const shell = shellsRef.current?.find((known) => known.id === target.shellId);
    if (shell === undefined) return undefined;
    return target.kind === 'shell' ? shell.name : (paneLabel(shell, target.sessionId) ?? '');
  }, []);
  /** A zone's new name on the board: the daemon sends no change for it, so the board follows what it saved. */
  const showZoneName = useCallback((target: RenameTarget, name: string) => {
    if (target.kind !== 'zone') return;
    setNodes((current) => {
      const known = current.filter(isZone).find((node) => node.id === target.zoneId);
      return known === undefined ? current : withZone(current, { ...known.data.zone, name });
    });
  }, []);
  const tileActions = useMemo<TileActions>(
    () => ({
      expand(nodeId) {
        const subject = tileSubject(nodeId);
        // Expanding it, or bringing it forward, is looking at the session.
        if (subject?.kind === 'agent') markSeen(subject.id);
        if (expandedRef.current.some((entry) => entry.id === nodeId)) return bringTileToFront(nodeId);
        // A chip has nothing to expand: it unfolds first.
        const chip = subject?.kind === 'agent' && agentsRef.current.some((agent) => agent.sessionId === subject.id && isFolded(agent, new Set(unfoldedRef.current)));
        if (chip) setUnfolded(nodeId, true);
        // Already in its own OS window: that comes forward instead.
        const popped = windowsRef.current.find(
          (entry) => subject !== undefined && subject.kind !== 'external' && entry.id === subject.id && entry.placement === 'popped',
        );
        if (popped !== undefined) return showWindow(popped);
        // Opened, it makes room for itself, wherever it was dragged.
        expand(nodeId);
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
      collapse,
      setFolded(nodeId, folded) {
        const open = !folded;
        if (unfoldedRef.current.includes(nodeId) === open) return;
        history.record([[historyKey.unfolded(nodeId), { type: 'unfolded', open: !open }, { type: 'unfolded', open }]]);
        setUnfolded(nodeId, open);
        // Folding a tile that is expanded in place closes that too.
        if (folded) collapse(nodeId);
      },
      resizeTile(nodeId, size, place) {
        const node = nodesRef.current.find((known) => known.id === nodeId);
        if (node === undefined || !isSessionTile(node)) return;
        const before = tileSizeOf(tileSizesRef.current, nodeId);
        const next = withTileSize(tileSizesRef.current, nodeId, size);
        const after = tileSizeOf(next, nodeId);
        const saved = pendingPlaces.current.get(nodeId) ?? subjectOf(node.data).position;
        const moved = place !== undefined && (saved === null || saved.x !== place.x || saved.y !== place.y);
        // One drag, one step: the size, and the place when resizing from the left or top moved it.
        if (before.width !== after.width || before.height !== after.height) {
          history.record([[historyKey.tileSize(nodeId), { type: 'tileSize', size: before }, { type: 'tileSize', size: after }]]);
        }
        sizeTile(nodeId, size);
        if (moved) moveTileRef.current(nodeId, node.data, { zoneId: node.parentId ?? null, ...place });
      },
      resizeExpanded(nodeId, size, place) {
        resizeExpandedTile(nodeId, size);
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
        // Its tabs' shells end with it too.
        if (shell === undefined || liveShellCount({ kind: 'shell', shell }, shellsRef.current ?? []) === 0) return deleteShell(shellId);
        askDelete({ title: 'Delete shell?', lines: [`${shell.name} still has running shells. Deleting it ends them.`, DELETE_FINAL], confirm: 'Delete anyway', run: () => deleteShell(shellId) });
      },
      // A live agent is never deleted on one click: it may be mid-task even with nothing to lose yet. One with a worktree
      // of its own, live or ended, asks whether to remove it with its branch or keep them.
      deleteAgent(sessionId) {
        const agent = agentsRef.current.find((known) => known.sessionId === sessionId);
        const liveShells = agent === undefined ? 0 : liveShellCount({ kind: 'agent', agent }, shellsRef.current ?? []);
        if (agent === undefined || (agent.endedAt !== null && !agent.ownsWorktree && liveShells === 0)) return deleteAgent(sessionId, false);
        askDelete({
          title: 'Delete agent?',
          lines: [agentLine(agent, liveShells), DELETE_FINAL],
          confirm: agent.endedAt === null ? 'Delete anyway' : 'Delete agent',
          keepLabel: agent.ownsWorktree ? 'Keep worktree and branch' : undefined,
          run: (keep) => deleteAgent(sessionId, false, keep),
        });
      },
      // A live agent may be mid-task: ask first. Its worktree, branch and conversation stay, for Restart to carry on.
      // A paused one is closed for good as it is, never woken: asked about the same.
      stopAgent(sessionId) {
        const agent = agentsRef.current.find((known) => known.sessionId === sessionId);
        if (agent === undefined || (agent.endedAt !== null && agent.state !== 'hibernated')) return;
        askDelete({
          title: 'Stop agent?',
          lines: [
            agent.state === 'hibernated'
              ? `${agent.name} is paused. Stopping it closes it as it is, no longer paused; its worktree, branch and conversation stay, and Restart carries it on.`
              : `${agent.name} is still running. Stopping it ends its session; its worktree, branch and conversation stay, and Restart carries it on.`,
          ],
          confirm: 'Stop agent',
          run: () => void window.agentBoard.agents.stop(sessionId).catch(report('stop the agent')),
        });
      },
      interruptAgent: (sessionId) => void window.agentBoard.agents.interrupt(sessionId).catch(report('interrupt the agent')),
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
      scheduleAgent(agent) {
        const clockId = agent.schedule?.clockId;
        const clock = clockId === undefined ? undefined : nodesRef.current.find((node) => node.id === `${ITEM_NODE_PREFIX}${clockId}`);
        setClockEditing(clock !== undefined && isItemNode(clock) ? { clockId: clockId!, data: clock.data.item.data } : { agent });
      },

      setMuted: (sessionId, muted) =>
        void window.agentBoard.agents.setMuted(sessionId, muted).then(
          agentHeard,
          report(muted ? "mute the agent's notifications" : "unmute the agent's notifications"),
        ),
      setEffort: (sessionId, effort) =>
        void window.agentBoard.agents.setEffort(sessionId, effort).then(({ agent, applies }) => {
          agentHeard(agent);
          const when = applies === 'after-turn' ? 'once it is back at its prompt' : applies === 'restart' ? 'when it restarts' : undefined;
          if (when !== undefined) toasts.show({ tone: 'info', message: `${agent.name} takes ${effort === null ? 'its default' : EFFORT_LABELS[effort]} reasoning ${when}.` });
        }, report("change the agent's reasoning")),
      openLink: (url) => void window.agentBoard.trackers.openLink(url).catch(report('open the link')),
      // An ended one is forgotten at once; one still running is only taken off the board, which it is told first.
      dismissExternal(id) {
        const session = externalsRef.current.find((known) => known.id === id);
        if (session === undefined || externalEnded(session)) return dismissExternal(id);
        askDelete({ title: 'Remove from board?', lines: [externalLine(session)], confirm: 'Remove from board', run: () => dismissExternal(id) });
      },
      // Recorded for undo once it is saved, as the name the daemon kept. The tile follows the daemon's change event.
      rename: async (target, name) => {
        const before = nameOf(target);
        if (before === undefined) return;
        try {
          const saved = await renameDirect(target, name);
          showZoneName(target, saved);
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
      resumeAgent: (sessionId) => lifecycleOnce(sessionId, () => window.agentBoard.agents.resume(sessionId).then(agentHeard, report('resume the agent'))),
      continueOnCredits: (sessionId) => window.agentBoard.agents.continueOnCredits(sessionId).then(agentHeard, report('continue it on credits')),
      pauseAgent: (sessionId) => lifecycleOnce(sessionId, () => window.agentBoard.agents.pause(sessionId).then(agentHeard, report('pause the agent'))),
      sendUnsent: (sessionId) => window.agentBoard.agents.sendUnsent(sessionId).then(agentHeard, report('send the message')),
      clearUnsent: (sessionId) => window.agentBoard.agents.clearUnsent(sessionId).then(agentHeard, report('clear the message')),
      typeFirstPrompt: (sessionId) => window.agentBoard.agents.typeFirstPrompt(sessionId).then(agentHeard, report('send its first prompt')),
      trustFolder: (sessionId) => window.agentBoard.agents.trustFolder(sessionId).then(agentHeard, report('trust its folder')),
      resendUndelivered: (sessionId) => window.agentBoard.agents.resendUndelivered(sessionId).then(agentHeard, report('resend what was not delivered')),
      clearUndelivered: (sessionId) => window.agentBoard.agents.clearUndelivered(sessionId).then(agentHeard, report('clear what was not delivered')),
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
      openTab(agent, tab) {
        const show = (tabId: string) => {
          if (!poppedOut(agent.sessionId)) requestTab(agent.sessionId, tabSurface(tabId));
          openAgent(agent);
        };
        if (tab !== undefined) return show(tab);
        window.agentBoard.shells.createTab({ kind: 'agent', id: agent.sessionId }).then((shell) => show(shell.id), report('open a shell'));
      },
      openPullRequest(agent, pr) {
        const surface = pullRequestSurfaceOf(pr);
        // One not on GitHub as gh names it has no tab to open in: it opens in the browser, as it did before PR tabs.
        if (surface === undefined) return void window.agentBoard.trackers.openLink(pr.url).catch(report('open the link'));
        if (!poppedOut(agent.sessionId)) requestTab(agent.sessionId, surface);
        // Its expanded tile shows its tabs as its window would, and takes the request there.
        if (!expandedRef.current.some((tile) => tile.id === tileNodeId('agent', agent.sessionId))) openAgent(agent);
      },
      openGate(agent, run) {
        if (run) void window.agentBoard.gates.run(agent.sessionId).catch(report('run the gate'));
        if (!poppedOut(agent.sessionId)) requestTab(agent.sessionId, gateSurfaceOf(agent.sessionId));
        if (!expandedRef.current.some((tile) => tile.id === tileNodeId('agent', agent.sessionId))) openAgent(agent);
      },
      openPlan(agent) {
        if (!poppedOut(agent.sessionId)) requestTab(agent.sessionId, planSurfaceOf(agent.sessionId));
        if (!expandedRef.current.some((tile) => tile.id === tileNodeId('agent', agent.sessionId))) openAgent(agent);
      },
      openDoc(agent, document) {
        if (!poppedOut(agent.sessionId)) requestTab(agent.sessionId, documentSurfaceOf(document));
        if (!expandedRef.current.some((tile) => tile.id === tileNodeId('agent', agent.sessionId))) openAgent(agent);
      },
      retryStart(start) {
        if (start.confirm) return setConfirmingStart(start);
        window.agentBoard.agents.retryStart(start.sessionId).catch(report('start the agent again'));
      },
      retryAgentStart: (sessionId) => void window.agentBoard.agents.retryStart(sessionId).catch(report('start the agent again')),
      // Gone from the board here whatever the daemon says, though what went wrong is still said.
      dismissStart: (sessionId) => void window.agentBoard.agents.dismissStart(sessionId).catch(report('remove the agent')).finally(() => dropStart(sessionId)),
      async renameStart(sessionId, name) {
        try {
          await window.agentBoard.agents.updateStart(sessionId, { name });
        } catch (error) {
          report('rename it')(error);
          throw error;
        }
      },
    }),
    [openAgent, openShell, showWindow, poppedOut, popOut, deleteAgent, deleteShell, dismissExternal, askDelete, restartAgent, getNodes, getInternalNode, inView, bringIntoView, report, setNotice, history, nameOf, showZoneName, expand, bringTileToFront, collapse, sizeTile, setUnfolded, resizeExpandedTile, agentHeard, lifecycleOnce, dropStart],
  );

  const restartBanner = useRestartBanner(agents, shells, tileActions);
  // A document an agent shows is put in a Document tab of its window, shown as the window opens (or at once, if it is open).
  useShownDocuments(agents, (agent, document) => {
    if (!poppedOut(agent.sessionId)) requestTab(agent.sessionId, documentSurfaceOf(document));
  });
  const documentCards = useMemo<DocumentCards>(
    () => ({
      find(sessionId, documentId) {
        const agent = agents.find((each) => each.sessionId === sessionId);
        const document = agent?.docs.find((each) => each.id === documentId);
        return agent === undefined || document === undefined ? undefined : { agent, document };
      },
      open: (agent, document) => tileActions.openDoc(agent, document),
    }),
    [agents, tileActions],
  );
  // A steps card names agents: who does a step, who waits on it, and who answers it while it is live.
  const stepsLookup = useMemo<StepsLookup>(
    () => ({
      live: (sessionId) => agents.some((each) => each.sessionId === sessionId && each.endedAt === null),
      name: (sessionId) => agents.find((each) => each.sessionId === sessionId)?.name,
    }),
    [agents],
  );
  const planCards = useMemo<PlanCards>(
    () => ({ find: (sessionId) => agents.find((each) => each.sessionId === sessionId), open: (agent) => tileActions.openPlan(agent) }),
    [agents, tileActions],
  );

  /**
   * The zones as laid out now, bottom one first, for placing an item or a tile. A folded zone is left out: its chip takes
   * no tile, so one dropped on it stays loose on top rather than joining a zone whose tiles are not drawn.
   */
  const zoneLayouts = useCallback(
    (): (ZoneLayout & { id: string })[] =>
      getNodes()
        .filter(isZone)
        .filter((zone) => !zone.data.zone.folded)
        .map((zone) => ({ id: zone.id, ...layoutOf(zone) })),
    [getNodes],
  );
  /** The room each zone takes on the board now, a folded one its chip's: what a tile put loose on the board keeps clear of. */
  const zoneRooms = useCallback((): (Rect & { id: string })[] => getNodes().filter(isZone).map((zone) => ({ id: zone.id, ...layoutOf(zone) })), [getNodes]);
  // The camera a recording spec drives, in demo mode only, beside the board's own moves (flyTo, bringIntoView).
  useDemoCamera(useCallback((zoneId: string) => zoneRooms().find((zone) => zone.id === zoneId), [zoneRooms]));

  const placeSession = usePlaceSession({
    zones: () => getNodes().filter(isZone).map((node) => node.data.zone),
    zoneLayouts,
    onShell: (shell) => {
      shellHeard(shell);
      openShell(shell);
    },
    onDialog: (zone, position) => setNewAgent({ zone, position }),
    report,
  });
  /** A zone's + agent: the New agent dialog, with a repo field in a group. */
  const newAgentInZone = setNewAgentZone;

  /** Asks the daemon to save the move of `tile`'s session, and takes in what it answers. */
  // The answer is taken as far as it is newer than what the board has heard meanwhile (see saved-place.ts). The daemon's
  // events carry everything else, so an answer never adds a session the board hasn't heard of. Where the answer is
  // ignored, the board waits on the event of its own move, which always follows; that is the case too when `asked`,
  // read from what was last rendered, misses an event heard but not yet drawn. One case it gets wrong: moved elsewhere
  // and then back to the very same place before the answer comes, the tile looks unmoved, so the answer's place is
  // shown until the session's next event.
  const saveMove = useCallback(async (tile: TileData, move: TileMove) => {
    if (tile.start !== undefined) {
      // Its agent takes the place once its session runs; the start's change event moves its tile meanwhile.
      await window.agentBoard.agents.updateStart(tile.start.sessionId, { move });
    } else if (tile.agent !== undefined) {
      const { sessionId } = tile.agent;
      const asked = agentsRef.current.find((agent) => agent.sessionId === sessionId) ?? tile.agent;
      const moved = await window.agentBoard.agents.move(sessionId, move);
      agentPlaced(asked, moved);
    } else if (tile.shell !== undefined) {
      const { id } = tile.shell;
      const asked = shellsRef.current?.find((shell) => shell.id === id) ?? tile.shell;
      const moved = await window.agentBoard.shells.move(id, move);
      shellPlaced(asked, moved);
    } else if (tile.external !== undefined) {
      const { id } = tile.external;
      const asked = externalsRef.current.find((session) => session.id === id) ?? tile.external;
      const moved = await window.agentBoard.external.move(id, move);
      externalPlaced(asked, moved);
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
    onMove: (nodeId) => freeOverlaps([nodeId]),
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
    (nodeId: string, tile: TileData, drawn: TileMove, coalesce?: string) => {
      // A folded chip is drawn below where its tile is saved: saved from where the tile would be.
      const move = savedMove(tile, drawn);
      recordTileMove(nodeId, tile, move, coalesce);
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
    const move = { ...placeOnBoard(at, compactSizeOf(node), zoneLayouts()), toFront: true };
    // Its crew comes along under crew frames, each where it was beside it, undone with it as one step.
    // Measured from where it is drawn, as its crew is.
    const drawn = shown.find((known): known is TileNodeType => known.id === node.id && isSessionTile(known)) ?? node;
    const crew = crewLookRef.current === 'frames' ? crewMoves(shown, drawn, move, landingRects(shown, move.zoneId, drawn)) : [];
    const step = crew.length === 0 ? undefined : `crew:${node.id}:${Date.now()}`;
    moveTile(node.id, node.data, move, step);
    if (crew.length > 0) {
      const following = new Set(crew.map((member) => member.node.id));
      setNodes((current) => current.map((known) => (following.has(known.id) ? { ...known, dragging: false } : known)));
      for (const member of crew) moveTile(member.node.id, member.node.data, member.move, step);
    }
    // The one it was dropped onto stays where it was seen, even if only drawn there, moved clear of something.
    const target = shown.find((known): known is TileNodeType => known.id === onto && isSessionTile(known));
    const stored = nodesRef.current.find((known) => known.id === onto);
    // Not one drawn where its zone's layout puts it (shelves, clusters): that is no place of its own to keep.
    if (target !== undefined && stored !== undefined && !laidOutTile(stored, nodesRef.current)) {
      const { x, y } = target.position;
      if (x !== stored.position.x || y !== stored.position.y) moveTile(target.id, target.data, { zoneId: target.parentId ?? null, x, y });
    }
    allowOverlap(node.id, onto);
  };

  /**
   * Makes a move the user dropped, in any window, across OS windows too, and records it for undo: a
   * whole shell, a pane out of its split, or a pull request, web or session tab between windows. Nothing restarts:
   * only a shell's owner or place, or where a tab is, changes. The window it lands in keeps the tab it shows, so the
   * keyboard stays where it was and ⌘Z can take the move back. Resolves with whether it was made (a refusal is said),
   * and the shell moved, for a shell.
   */
  const moveTab = useCallback(
    (move: TabMove): Promise<{ made: boolean; shell?: Shell }> => {
      const before = shellsRef.current ?? [];
      const made =
        move.kind === 'surface'
          ? moveSurface(move).then(({ was }) => {
              history.record(surfaceMoveChanges(move, was));
              return undefined;
            })
          : move.kind === 'tab'
            ? window.agentBoard.shells.moveTab(move.shellId, move.to).then((moved) => {
                shellsHeard(moved);
                history.record(tabMoveChanges(before, moved));
                return moved.find((shell) => shell.id === move.shellId);
              })
            : window.agentBoard.shells.movePane(move.shellId, move.sessionId, move.to).then(({ moved, source, layoutBefore }) => {
                shellsHeard([source, moved]);
                const to = placeOf(moved);
                if (to !== undefined) {
                  history.record([
                    [historyKey.pane(move.sessionId), { type: 'panePlace', in: { shellId: source.id, layout: layoutBefore } }, { type: 'panePlace', alone: { shellId: moved.id, to } }],
                  ]);
                }
                return moved;
              });
      return made.then(
        (moved) => {
          movesSettled();
          return { made: true, ...(moved === undefined ? {} : { shell: moved }) };
        },
        (error: unknown) => {
          report(move.kind === 'tab' ? 'move the shell' : move.kind === 'pane' ? 'move the pane' : 'move the tab')(error);
          return { made: false };
        },
      );
    },
    [history, report, shellsHeard],
  );

  // The windows and tiles make the moves dropped on them through the board, while it is there, and so do popped-out
  // windows, through main, as do their ⌘Z and ⇧⌘Z: one undo history has every move.
  useDragsFromOtherWindows();
  useEffect(() => {
    tabMover.set((move) => void moveTab(move));
    const unsubscribe = [
      window.agentBoard.tabDrags.onMakeMove((move) => void moveTab(move)),
      window.agentBoard.tabDrags.onReplay((action) => (action === 'undo' ? history.undo() : history.redo())),
    ];
    return () => {
      tabMover.set(undefined);
      for (const each of unsubscribe) each();
    };
  }, [moveTab, history]);
  // What a dragged tab, pane or shell tile is over is shown only while one is dragged.
  const draggingTab = useTabDrag();
  useEffect(() => {
    if (draggingTab === undefined) dropOver.set(undefined);
  }, [draggingTab]);

  /**
   * Where a tab or pane dropped at `point` (on the screen) goes: into the tabs of the window or tile under it, or onto
   * the board as a shell tile centred there. Dropped on a window that won't take it (its own), it stays. A tab that is
   * only a place in a window goes as `boardDrop` says (slice 4).
   */
  const shellDropped = (drag: TabDrag, point: { x: number; y: number }) => {
    const owner = ownerAtPoint(point.x, point.y);
    const onWindow = document.elementFromPoint(point.x, point.y)?.closest(SESSION_SURFACES) != null;
    if (drag.kind === 'surface') {
      if (owner === undefined && onWindow) return;
      const popped = windowsRef.current.some((entry) => entry.id === drag.from.id && entry.placement === 'popped');
      const done = boardDrop(drag, owner, popped);
      if (done?.kind === 'move') void moveTab(done.move);
      else if (done?.kind === 'popIn') {
        // Its web tabs' pages come back with it, as they are.
        const target = windowTargetOf(done.owner);
        void (target === undefined ? Promise.resolve() : handOffWebTabs(target)).then(() => window.agentBoard.windows.popIn(done.owner.id));
      }
      return;
    }
    if (owner !== undefined || onWindow) {
      const move = owner === undefined ? undefined : dropMove(drag, { owner }, paneAtPoint(point.x, point.y));
      if (move !== undefined) void moveTab(move);
      return;
    }
    const at = screenToFlowPosition(point);
    const corner = { x: at.x - AGENT_TILE_SIZE.width / 2, y: at.y - AGENT_TILE_SIZE.height / 2 };
    const move = dropMove(drag, { tile: { ...placeOnBoard(corner, AGENT_TILE_SIZE, zoneLayouts()), toFront: true } });
    if (move !== undefined) void moveTab(move);
  };

  /** Whether a drag held over the board at `point` would land on the tile or window there, which shows it would. */
  const landsOn = (drag: TabDrag, owner: ReturnType<typeof ownerAtPoint>): boolean =>
    owner !== undefined && (drag.kind === 'surface' ? boardDrop(drag, owner, false) !== undefined : dropMove(drag, { owner }) !== undefined);

  /** The agent a lone shell tile dragged to `point` would become a tab of, dropped now: its tile's or window's under it. */
  const adopterOf = (dragged: BoardNode[], point: { x: number; y: number } | undefined) => {
    const [node] = dragged;
    if (dragged.length !== 1 || node === undefined || point === undefined || !isSessionTile(node) || node.data.shell === undefined) return undefined;
    return ownerAtPoint(point.x, point.y, { skip: node.id, agentsOnly: true });
  };

  /** The zone the dragged node would move into if dropped now, if it would change zone. */
  const dropTargetOf = (node: BoardNode): string | undefined => {
    const absolute = absoluteOf(node);
    let zoneId: string | null | undefined;
    if (isItemNode(node)) {
      const size = { width: node.width ?? node.data.item.width, height: node.height ?? node.data.item.height };
      zoneId = placeOnBoard(absolute, size, zoneLayouts()).zoneId;
    } else if (isSessionTile(node)) zoneId = placeOnBoard(absolute, compactSizeOf(node), zoneLayouts()).zoneId;
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

  /**
   * Stops a crew card's crew, the user having said yes, then runs `then`: the daemon checks and logs the stop as any
   * other caller's. A crew that stopped by itself while the question waited is left as it is, and `then` runs at once.
   */
  const stopCrewOf = useCallback(
    (card: BoardItem, then?: () => void) => {
      const now = nodesRef.current.find((node): node is ItemNodeType => isItemNode(node) && node.data.item.id === card.id);
      // A card the board no longer draws says nothing of its crew: the daemon says whether it still runs.
      if (now !== undefined && !cardOfRunningCrew(now.data.item)) return then?.();
      window.agentBoard.orchestrators.stopCrew(crewCardData(card.data).crewId).then(() => then?.(), report('stop the crew'));
    },
    [report],
  );

  /**
   * Asks the user whether to stop a crew card's crew, and stops it on their yes. With `then`, its card is to go as well,
   * and `then` takes it once the crew has stopped. One question a crew: two crews asked the same thing each get theirs.
   */
  const askStopCrew = useCallback(
    (card: BoardItem, then?: () => void) => {
      const { crewId, title } = crewCardData(card.data);
      askDelete({
        key: `crew:${crewId}`,
        title: then === undefined ? 'Stop this crew?' : 'Stop this crew and take its card off the board?',
        lines: [`“${title}”`, CREW_STOP_LINE],
        confirm: then === undefined ? 'Stop crew' : 'Stop and remove',
        run: () => stopCrewOf(card, then),
      });
    },
    [askDelete, stopCrewOf],
  );

  /** Takes an item off the board, undoably, with the connectors joined to it. */
  const takeItem = useCallback(
    (id: string, abandoned: boolean) => {
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
    [setNodes, report, itemLabel, onceCreated, history],
  );

  /** A running crew's card as a delete of the selection takes it (`useDeleteSelection`). */
  const crewCards = useMemo(
    () => ({
      ask: (card: BoardItem) => askStopCrew(card, () => takeItem(card.id, false)),
      take: (card: BoardItem) => stopCrewOf(card, () => takeItem(card.id, false)),
    }),
    [askStopCrew, stopCrewOf, takeItem],
  );

  const itemActions = useMemo<ItemActions>(() => {
    return {
      update(params, coalesce, { silent = false } = {}) {
        // Deleted meanwhile, here or in another window (its editor saves as it goes): nothing left to save.
        const known = nodesRef.current.find((node): node is ItemNodeType => isItemNode(node) && node.data.item.id === params.id);
        if (known === undefined) return;
        const { item } = known.data;
        // The saves of one typing undo together.
        const typing = params.data !== undefined && 'text' in params.data ? `text:${params.id}` : undefined;
        if (!silent) history.record([itemChange(item, params)], coalesce ?? typing);
        const label = itemLabel(params.id);
        setNodes((current) => {
          const node = current.find((known) => isItemNode(known) && known.data.item.id === params.id);
          return node !== undefined && isItemNode(node) ? withItem(current, patched(node.data.item, params)) : current;
        });
        onceCreated(params.id, () => window.agentBoard.items.update(params)).catch(report(`save the ${label}`));
      },
      remove(id, { abandoned = false } = {}) {
        const known = nodesRef.current.find((node): node is ItemNodeType => isItemNode(node) && node.data.item.id === id);
        // The daemon keeps a running crew's card: taking it off stops its crew first, on the user's yes.
        if (known !== undefined && cardOfRunningCrew(known.data.item)) return crewCards.ask(known.data.item);
        takeItem(id, abandoned);
      },
      openLink: (url) => void window.agentBoard.trackers.openLink(url).catch(report('open the link')),
    };
  }, [setNodes, report, itemLabel, onceCreated, history, crewCards, takeItem]);

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
      const { id, kind, zoneId, x, y, width, height, rotation, data, z } = item;
      const created = window.agentBoard.items
        .create({ id, kind, zoneId, x, y, width, height, rotation, data })
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
      const zone = place.zoneId === null ? undefined : getNodes().find((node) => node.id === place.zoneId);
      const zoneName = zone !== undefined && isZone(zone) ? zone.data.zone.name : undefined;
      const id = crypto.randomUUID();
      putItem(
        { id, kind, ...place, ...size, z: topZ() + 1, rotation: 0, data: made.data ?? newData?.({ zoneName }) ?? {}, createdAt: '', updatedAt: '' },
        { editing: editOnCreate },
      );
      selectOnly(new Set([`${ITEM_NODE_PREFIX}${id}`]));
      return id;
    },
    [zoneLayouts, getNodes, putItem, topZ, selectOnly],
  );

  /** The board's own box on the screen. */
  const boardOnScreen = useCallback((): Rect => {
    const { left, top, width, height } = container.current!.getBoundingClientRect();
    return { x: left, y: top, width, height };
  }, []);
  /** The board position in the middle of the window. */
  const boardCentre = useCallback(() => screenToFlowPosition(centreOf(boardOnScreen())), [screenToFlowPosition, boardOnScreen]);

  const connectorActions = useMemo<ConnectorActions>(
    () => ({
      // Shown at once, and not taken back if the daemon refuses it: the notice says it wasn't saved.
      update(params: UpdateConnectorParams) {
        // Deleted meanwhile, here or in another window: nothing left to save.
        const connector = connectorsRef.current.find((known) => known.id === params.id);
        if (connector === undefined) return;
        // The saves of one label's typing undo together.
        const typed = CONNECTOR_LABEL_PLACES.filter((place) => params[place] !== undefined);
        const typing = typed.length === 1 ? `${typed[0]}:${params.id}` : undefined;
        history.record([[historyKey.connector(params.id), { type: 'connector', connector }, { type: 'connector', connector: withConnectorParams(connector, params) }]], typing);
        setConnectors((current) => {
          const known = current.find((connector) => connector.id === params.id);
          return known === undefined ? current : withConnector(current, withConnectorParams(known, params));
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
      edit: (id, place = 'label') => setEditingConnector(id === undefined ? undefined : { id, place }),
    }),
    [onceCreated, report, editingConnector, setNodes, history],
  );

  // As a click on its line selects it: alone, with nothing else selected.
  const flowEdgeActions = useMemo<FlowEdgeActions>(
    () => ({
      ...flow.actions,
      select(id) {
        setNodes((current) => current.map((node) => (node.selected === true ? { ...node, selected: false } : node)));
        setSelectedConnectors(new Set());
        flow.actions.select(id);
      },
    }),
    [flow.actions, setNodes],
  );

  /**
   * Puts `connector` on the board under its own id, as given: a new one, a copy, or one an undo brings back. It shows at
   * once; the daemon is told once both objects it joins exist there (a note made for it is still on its way).
   */
  const putConnector = useCallback(
    (connector: Connector) => {
      history.record([[historyKey.connector(connector.id), null, { type: 'connector', connector }]]);
      setConnectors((current) => withConnector(current, connector));
      const { id, from, to } = connector;
      const waits = [from, to]
        .flatMap((end) => (end.type === 'item' ? [pendingCreates.current.get(end.id)] : []))
        .filter((p) => p !== undefined);
      const created = Promise.all(waits)
        .then(() => window.agentBoard.connectors.create(createParamsOf(connector)))
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
  /** Joins `from` to `to` with a new connector of the default look; its id. */
  const createConnector = useCallback(
    (from: ConnectorEnd, to: ConnectorEnd) => {
      const id = crypto.randomUUID();
      putConnector({ id, from, to, ...DEFAULT_CONNECTOR_LOOK, points: [], createdAt: '', updatedAt: '' });
      return id;
    },
    [putConnector],
  );

  /** The object near the pointer while a connector is drawn: the one whose handles show, and the one it joins. */
  const findNear = useFindNear();

  /** The board node a "Connect to…" is waiting to be told the other end of, until it is clicked or called off. */
  const [connectingFrom, setConnectingFrom] = useState<string>();

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

  /** Joins two nodes with a connector, each at its side facing the other. */
  const connectNodes = useCallback(
    (fromId: string, toId: string) => {
      const nodes = getNodes();
      const [from, to] = [fromId, toId].map((id) => nodes.find((known) => known.id === id));
      const [fromRect, toRect] = [rectOf(fromId), rectOf(toId)];
      if (from === undefined || to === undefined || fromRect === undefined || toRect === undefined || fromId === toId) return;
      const middle = (rect: { x: number; y: number; width: number; height: number }) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
      const fromEnd = endOfNode(from, nearestSide(fromRect, middle(toRect)));
      const toEnd = endOfNode(to, nearestSide(toRect, middle(fromRect)));
      if (fromEnd !== undefined && toEnd !== undefined) createConnector(fromEnd, toEnd);
    },
    [getNodes, rectOf, createConnector],
  );

  // "Connect to…" has picked its first end: the next click on an object is the other, anything else calls it off.
  useEffect(() => {
    if (connectingFrom === undefined) return;
    // Shown for as long as the mode lasts (not for a few seconds), and dismissing it ends the mode: a click is never
    // silently a connector.
    const finish = () => setConnectingFrom(undefined);
    toasts.show({ id: CONNECT_HINT, message: `Click what to connect it to. ${keyText('edit.escape')} cancels.`, tone: 'info', persistent: true, onDismissed: finish });
    const onPointerDown = (event: PointerEvent) => {
      const target = (event.target as Element | null)?.closest?.('.react-flow__node')?.getAttribute('data-id');
      if (target === undefined || target === null || target === connectingFrom) return finish();
      event.preventDefault();
      event.stopPropagation();
      connectNodes(connectingFrom, target);
      finish();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      finish();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      toasts.dismiss(CONNECT_HINT);
    };
  }, [connectingFrom, connectNodes, toasts, setNotice]);

  /**
   * A connector dragged from a handle was let go. On an object (on one of its handles, or on or near it, as its handles
   * showed) it joins the two, at that handle's side or else the side facing the other; on empty board it makes a new
   * sticky note there, joined; anywhere else, nothing happens.
   */
  const connectorDropped = useCallback(
    (event: MouseEvent | TouchEvent, { fromNode, fromHandle, toNode, toHandle }: FinalConnectionState) => {
      setConnecting(undefined);
      setHandingOff(false);
      if (handOffCancelled.current) {
        handOffCancelled.current = false;
        return;
      }
      if (fromNode === null || fromHandle?.id == null) return;
      const touch = 'changedTouches' in event ? event.changedTouches[0] : event;
      if (touch === undefined) return;
      const point = { x: touch.clientX, y: touch.clientY };
      const at = screenToFlowPosition(point);
      const from = endOfNode(fromNode, fromHandle.id as ConnectorSide);
      if (from === undefined) return;
      const nodes = getNodes();
      // `picked` when it was dropped on a handle: dropped anywhere else on an object, a hand-off's end there is automatic.
      let target: { nodeId: string; side: ConnectorSide; picked?: true } | undefined;
      if (toNode !== null && toHandle?.id != null) {
        target = { nodeId: toNode.id, side: toHandle.id as ConnectorSide, picked: true };
      } else {
        const drop = dropAt(point, new Set(nodes.filter(isZone).map((zone) => zone.id)));
        if (drop.type === 'nothing' || (drop.type === 'node' && drop.nodeId === fromNode.id)) return;
        // The object whose handles were lit as it was let go, by the same hit-test: on it, or near it.
        const near = findNear(point, (nodeId) => nodeId !== fromNode.id);
        if (near !== undefined) {
          // It arrives on the side facing where it came from.
          const rect = rectOf(near);
          const source = rectOf(fromNode.id);
          if (rect !== undefined && source !== undefined) {
            target = { nodeId: near, side: nearestSide(rect, { x: source.x + source.width / 2, y: source.y + source.height / 2 }) };
          }
        }
      }
      if (target !== undefined) {
        // Not to itself.
        if (target.nodeId === fromNode.id) return;
        const node = nodes.find((known) => known.id === target.nodeId);
        const to = node && endOfNode(node, target.side);
        if (to === undefined) return;
        // From one agent to another it can be a hand-off: with ⌥ held it is one, and otherwise the chooser
        // asks, the arrow drawn meanwhile.
        const [here, there] = [tileSubject(fromNode.id), tileSubject(target.nodeId)];
        if (here?.kind === 'agent' && there?.kind === 'agent') {
          const toSide = target.picked ? to.side : 'auto';
          if (event.altKey) {
            void flow.actions.create(here.id, there.id, { fromSide: from.side, toSide });
            return;
          }
          setHandOffChoice({ connectorId: createConnector(from, to), from: here.id, to: there.id, toSide, at: point });
          return;
        }
        createConnector(from, to);
        return;
      }
      const source = rectOf(fromNode.id);
      if (source === undefined) return;
      const { centre, side } = newEndAt(source, at, ITEM_KINDS.sticky.size);
      const noteId = createItem('sticky', centre);
      createConnector(from, { type: 'item', id: noteId, side });
    },
    [screenToFlowPosition, getNodes, rectOf, createConnector, createItem, flow.actions, findNear, setNotice],
  );

  /**
   * The chooser picked Hand off for the arrow just drawn between two agents: it becomes a hand-off, from the
   * same sides in the same shape (its end automatic if it wasn't dropped on a handle), its Edge rules open.
   * One undo makes it the arrow again.
   */
  const handOff = useCallback(
    ({ connectorId, from, to, toSide }: { connectorId: string; from: string; to: string; toSide: FlowEdgeSide }) => {
      setHandOffChoice(undefined);
      const connector = connectorsRef.current.find((known) => known.id === connectorId);
      if (connector === undefined) return;
      const shape = { ...shapeOf(connector), toSide };
      const replaced: Change = [historyKey.connector(connectorId), { type: 'connector', connector }, null];
      void flow.actions.create(from, to, shape, [replaced]).then((made) => {
        if (!made) return;
        // Not through connectorActions.remove, which would record it on its own.
        setConnectors((current) => current.filter((known) => known.id !== connectorId));
        onceCreated(connectorId, () => window.agentBoard.connectors.delete(connectorId)).catch(report('delete the connector'));
      });
    },
    [flow.actions, onceCreated, report],
  );

  /** The tool armed for the next click or drag on the board (T, S, or its button), if any. */
  const [tool, setTool] = useState<ArmedTool>();
  /** How a drag on the board acts while no tool is armed (V, H, or the toolbar). */
  const [mode, setMode] = useState<PointerMode>('select');
  const pickMode = useCallback((picked: PointerMode) => {
    setTool(undefined);
    setMode(picked);
  }, []);

  // While a connector is dragged, the object near the pointer, other than the one it is drawn from, shows its handles.
  useEffect(() => {
    if (connecting === undefined) return;
    const onMove = (event: PointerEvent) => findNear({ x: event.clientX, y: event.clientY }, (nodeId) => nodeId !== connecting);
    window.addEventListener('pointermove', onMove, { capture: true });
    return () => {
      window.removeEventListener('pointermove', onMove, { capture: true });
      setNearNode(undefined);
    };
  }, [connecting, findNear]);

  // While a connector is dragged from an agent's tile, holding ⌥ makes it a hand-off: the line thickens
  // and says what it carries before it is let go.
  useEffect(() => {
    if (connecting === undefined || !connectingFromAgent.current) return;
    const onAlt = (event: KeyboardEvent | PointerEvent) => setHandingOff(event.altKey);
    window.addEventListener('keydown', onAlt, { capture: true });
    window.addEventListener('keyup', onAlt, { capture: true });
    window.addEventListener('pointermove', onAlt, { capture: true });
    return () => {
      window.removeEventListener('keydown', onAlt, { capture: true });
      window.removeEventListener('keyup', onAlt, { capture: true });
      window.removeEventListener('pointermove', onAlt, { capture: true });
    };
  }, [connecting]);

  // Escape calls off a hand-off being dragged: nothing is joined, wherever it is let go.
  useEffect(() => {
    if (!handingOff) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      handOffCancelled.current = true;
      flowStore.getState().cancelConnection();
      setConnecting(undefined);
      setHandingOff(false);
    };
    // Before the board's own Escape, which would also put a tile down.
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [handingOff, flowStore]);

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
      // The shape picked last: a click puts it down at its own size.
      const shape = lastShape();
      const data = { ...newShapeData(shape) };
      if (Math.hypot(to.x - from.x, to.y - from.y) < TOOL_DRAG_MIN) return createItem('shape', start, { size: SHAPES[shape].size, data });
      // Never smaller than a shape can be resized to, so a drag just past a click isn't a speck.
      const size = {
        width: Math.max(MIN_SHAPE_SIZE, Math.abs(end.x - start.x)),
        height: Math.max(MIN_SHAPE_SIZE, Math.abs(end.y - start.y)),
      };
      createItem('shape', { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, { size, data });
    },
    [screenToFlowPosition, createItem, placeSession],
  );

  /**
   * The Agent or Shell tool dragged off the toolbar and let go at `at` on the screen: its tile goes there, unless
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

  /**
   * Saves the zone's new layout, which can be undone (unless not `record`ed), and draws it so while its tiles are laid
   * out again. With `move`, draws it at its new place too: nothing dragged it there.
   */
  const saveZoneLayout = useCallback(
    (id: string, layout: ZoneLayout, { move = false, record = true }: { move?: boolean; record?: boolean } = {}) => {
      const zone = nodesRef.current.filter(isZone).find((node) => node.id === id)?.data.zone;
      const before = savedZoneLayouts.current.get(id) ?? (zone && { x: zone.x, y: zone.y, width: zone.width, height: zone.height });
      if (record && before !== undefined) history.record([[historyKey.zone(id), { type: 'zone', layout: before }, { type: 'zone', layout }]]);
      savedZoneLayouts.current.set(id, layout);
      window.agentBoard.zones.update(id, layout).catch(report("save the zone's layout"));
      // The node may still have a dragged size: set this one while the tiles are laid out again.
      setNodes((current) =>
        laidOut(current.map((node) => (isZone(node) && node.id === id ? withSavedLayout(node, layout, { move }) : node))),
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

  /** What a tile takes up in a tidy: an expanded tile its expanded size, so the rest are laid out clear of it. */
  const tidySizeOf = useCallback((node: TileNodeType) => tidySize(expandedRef.current, node.id, compactSizeOf(node)), [expandedRef]);

  /**
   * Tidies the zone: its tiles in rows, in reading order, round its notes and cards, and its height fitted to
   * them, at its spacing (or `spacing`, one just picked). Saved, as one step to undo.
   */
  const tidyZone = useCallback(
    (zoneId: string, spacing?: ArrangeSpacing) => {
      const zone = nodesRef.current.filter(isZone).find((node) => node.id === zoneId);
      // On shelves or in clusters the zone lays itself out: a tidy would move the places its tiles aren't drawn at, and
      // Free would no longer be as it was.
      if (zone === undefined || zone.data.zone.layoutMode !== 'free') return;
      const children = nodesRef.current.filter((node) => node.parentId === zoneId);
      const tiles = children.filter(isSessionTile);
      const items = children.filter(isItemNode).map((node) => node.data.item);
      const layout = layoutOf(zone);
      const { positions, size } = tidyZoneLayout(
        layout,
        tiles.map((node) => ({ id: node.id, ...node.position, ...tidySizeOf(node) })),
        items,
        spacing ?? zone.data.zone.spacing,
      );
      moveTilesTo(tiles, positions, zoneId);
      freeOverlaps([...positions.keys()]);
      if (size.width !== layout.width || size.height !== layout.height) saveZoneLayout(zoneId, { ...layout, ...size });
    },
    [moveTilesTo, saveZoneLayout, tidySizeOf],
  );

  /** What deleting `zones` leaves of each: the tiles that stay loose and the connectors that go with it. */
  const zonesToDelete = useCallback(
    (zones: Zone[]): ZoneToDelete[] =>
      zones.map((zone) => ({
        zone,
        tiles: nodesRef.current.filter((node) => node.parentId === zone.id && isSessionTile(node)).length,
        connectors: connectorsRef.current.filter((connector) => [connector.from, connector.to].some((end) => end.type === 'zone' && end.id === zone.id)).length,
      })),
    [],
  );

  /**
   * Deletes zones, after the user has confirmed, then runs `then` as part of the same undo step if
   * they all went (the rest of a mixed selection): for each, the daemon puts its tiles loose where they
   * are drawn and removes it, as one step; its notes, cards and connectors stay where they are, as when a zone goes (the
   * connectors on the zone itself go with it). No session, worktree, branch or repo folder is touched; with
   * `deleteClone`, a managed clone's folder goes too. One step to undo, which makes the zones again, bound to
   * their repos, and puts back what was in them.
   */
  const removeZones = useCallback(
    async (zones: Zone[], deleteClone: boolean, then?: () => void) => {
      setNotice(undefined);
      const recorded: [string, BoardState, null][] = [];
      const removed: { zone: Zone; cloneError: string | null }[] = [];
      for (const zone of zones) {
        const held = nodesRef.current.filter((node) => node.parentId === zone.id);
        const group: DissolvedGroup = {
          zone: zoneSnapshot(zone),
          // Where each is saved, not where it is drawn: a folded chip is drawn lower, and undoing would save that.
          tiles: held.filter(isSessionTile).map((node) => ({ nodeId: node.id, at: savedPlace(node) })),
          items: held.filter(isItemNode).map(({ data: { item } }) => ({ id: item.id, x: item.x, y: item.y })),
          connectors: connectorsRef.current.filter((connector) => [connector.from, connector.to].some((end) => end.type === 'zone' && end.id === zone.id)),
        };
        let cloneError: string | null;
        try {
          ({ cloneError } = await window.agentBoard.zones.dissolve(zone.id, { deleteClone: deleteClone && zone.managedClone }));
        } catch (error) {
          report(`delete ${zone.name}`)(error);
          continue;
        }
        // The daemon deleted the connectors on the zone with it, and doesn't announce that.
        const gone = new Set(group.connectors.map((connector) => connector.id));
        if (gone.size > 0) setConnectors((current) => current.filter((connector) => !gone.has(connector.id)));
        recorded.push([historyKey.zoneGroup(zone.id), { type: 'zoneGroup', group }, null]);
        removed.push({ zone, cloneError });
      }
      history.record(recorded);
      // The rest of a mixed selection goes only if every zone did, and in this step, so one ⌘Z takes it all back.
      if (removed.length === zones.length) then?.();
      const failed = removed.filter((each) => each.cloneError !== null);
      if (removed.length === 0) return;
      toasts.show({
        tone: failed.length > 0 ? 'error' : 'success',
        message:
          failed.length > 0
            ? `${failed.map((each) => each.zone.name).join(', ')} deleted, but its clone could not be removed: ${failed[0]!.cloneError}`
            : removed.length === 1
              ? `${removed[0]!.zone.name} is deleted: its tiles stay where they are`
              : `${removed.length} zones are deleted: their tiles stay where they are`,
      });
    },
    [report, toasts, history],
  );

  /** Asks to delete `zones` in one confirmation that names them, then deletes them. */
  const deleteZones = useCallback(
    (zones: Zone[]) => {
      const { title, lines, cloneLabel } = zoneDeleteText(zonesToDelete(zones), home);
      askDelete({ title, lines, confirm: 'Delete', cloneLabel: cloneLabel, run: (_keep, deleteClone) => void removeZones(zones, deleteClone) });
    },
    [askDelete, removeZones, zonesToDelete, home],
  );

  /** Tidies the tiles loose on the board: in a grid where they are, clear of zones and items. Saved, as one step to undo. */
  const tidyLoose = useCallback(() => {
    const loose = nodesRef.current.filter(isSessionTile).filter((node) => node.parentId === undefined);
    const obstacles = nodesRef.current.flatMap((node): Rect[] => {
      // A folded zone is in the way only where its chip is.
      if (isZone(node)) return [roomOf(node)];
      if (isItemNode(node) && node.parentId === undefined) return [node.data.item];
      return [];
    });
    const positions = tidyLooseLayout(loose.map((node) => ({ id: node.id, ...node.position, ...tidySizeOf(node) })), obstacles);
    moveTilesTo(loose, positions, null);
    freeOverlaps([...positions.keys()]);
  }, [moveTilesTo, tidySizeOf]);

  /**
   * Puts zones, and agents and shells loose on the board, at `places` (by node id), saved as an arrange saves them but
   * as no step to undo. What it moved, with where each was.
   */
  const placeUnrecorded = useCallback(
    (places: ReadonlyMap<string, Point>) => {
      const from = new Map<string, Point>();
      for (const node of nodesRef.current) {
        const at = places.get(node.id);
        if (at === undefined) continue;
        from.set(node.id, { ...node.position });
        // As the daemon has it now, as an arrange saves it.
        if (isZone(node)) saveZoneLayout(node.id, { ...at, width: node.data.zone.width, height: node.data.zone.height }, { move: true, record: false });
        else if (isSessionTile(node)) tileMoves.moveTile(node.id, node.data, savedMove(node.data, { zoneId: null, ...at }));
      }
      return from;
    },
    [saveZoneLayout, tileMoves.moveTile],
  );

  /**
   * Makes room for the folded zone to open: the zones, and the agents and shells loose on the board, that sit where it
   * will be are moved out of its way, and their new places saved. Not a step to undo: an undo would put them back under
   * the open zone. Returns what puts them all back, for an unfold that then fails.
   */
  const makeRoomToUnfold = useCallback(
    (zoneId: string) => {
      const moved = placeUnrecorded(unfoldMoves(nodesRef.current, zoneId, tidySizeOf));
      return () => void placeUnrecorded(moved);
    },
    [placeUnrecorded, tidySizeOf],
  );

  /**
   * Arranges the board: whole zones in rows a gap apart, with what is in them, and the agents and shells loose on the
   * board in rows below them, clear of what stays: the notes, shapes and text loose on it (turned ones by their upright
   * box), and other sessions' tiles. Never inside a zone. Saved, as one step to undo.
   */
  const arrangeBoard = useCallback(() => {
    const zones = nodesRef.current.filter(isZone);
    const loose = nodesRef.current.filter(isSessionTile).filter((node) => node.parentId === undefined);
    const moving = loose.filter((node) => !node.id.startsWith(EXTERNAL_NODE_PREFIX));
    const fixed = [
      ...nodesRef.current.flatMap((node): Rect[] => (isItemNode(node) && node.parentId === undefined ? [rotatedBounds(node.data.item, node.data.item.rotation)] : [])),
      ...loose.filter((node) => !moving.includes(node)).map((node) => sizedFootprint(node.position, tidySizeOf(node))),
    ];
    // Laid out as drawn, so the gaps hold on the screen, but each zone saved at its own size: the room the board makes
    // round an expanded tile, or grows a zone by to hold its tiles, is never saved.
    const arranged = arrangeBoardLayout(
      // A folded zone is a chip: its neighbours close up round it.
      zones.map((node) => ({ id: node.id, ...roomOf(node) })),
      moving.map((node) => ({ id: node.id, ...node.position, ...tidySizeOf(node) })),
      fixed,
    );
    for (const node of zones) {
      const at = arranged.zones.get(node.id);
      // As the daemon has it now: a resize from elsewhere (another window, an orchestrator's arrange) included.
      const { width, height } = node.data.zone;
      if (at !== undefined) saveZoneLayout(node.id, { ...at, width, height }, { move: true });
    }
    moveTilesTo(moving.filter((node) => arranged.tiles.has(node.id)), arranged.tiles, null);
    freeOverlaps([...arranged.tiles.keys()]);
  }, [moveTilesTo, saveZoneLayout, tidySizeOf]);

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
        const { id, zoneId, x, y, width, height, z, rotation } = item;
        // A data update merges: `restoredData` says what of the item's data goes back.
        if (nodeIds.has(`${ITEM_NODE_PREFIX}${id}`)) itemActions.update({ id, zoneId, x, y, width, height, z, rotation, data: restoredData(item) });
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
          laidOut(current.map((node) => (isZone(node) && node.id === id ? withSavedLayout(node, layout) : node))),
        );
      } else if (state?.type === 'zoneGroup') {
        // Undoing a delete: the zone again under its own id, then its tiles and items back in it. This runs after the
        // undo has returned, so it must not record: the tile move is the unrecorded one, and the items go to the daemon,
        // whose word of them updates the board.
        const { zone, tiles, items, connectors } = state.group;
        if (nodeIds.has(zone.id)) continue;
        window.agentBoard.zones.restore(zone).then((restored) => {
          if (zone.repoRoot != null && restored.repoRoot === null) {
            toasts.show({ message: `${restored.name} is back as a group: its repo is no longer there` });
          }
          setNodes((current) => withZone(current, restored));
          for (const { nodeId, at } of tiles) {
            const node = nodesRef.current.find((known): known is TileNodeType => known.id === nodeId && isSessionTile(known));
            if (node !== undefined) tileMoves.moveTile(nodeId, node.data, { zoneId: zone.id, ...at });
          }
          for (const { id, x, y } of items) {
            if (nodesRef.current.some((known) => known.id === `${ITEM_NODE_PREFIX}${id}`)) window.agentBoard.items.update({ id, zoneId: zone.id, x, y }).catch(report('put a note back in its group'));
          }
          // The daemon deleted these with the group. Made straight away, not through putConnector, which would record.
          for (const connector of connectors) {
            const { id, from, to } = connector;
            const present = (end: ConnectorEnd) => end.type === 'zone' || nodesRef.current.some((known) => known.id === nodeIdOf(end));
            if (!present(from) || !present(to)) continue;
            setConnectors((current) => withConnector(current, connector));
            window.agentBoard.connectors.create(createParamsOf(connector)).catch((error: unknown) => {
              setConnectors((current) => current.filter((known) => known.id !== id));
              report('put a connector back')(error);
            });
          }
        }, report('bring the group back'));
      } else if (state === null && key.startsWith(historyKey.zoneGroup(''))) {
        // Redoing a delete.
        const id = key.slice(historyKey.zoneGroup('').length);
        if (nodeIds.has(id)) window.agentBoard.zones.dissolve(id).catch(report('delete the zone'));
      } else if (state?.type === 'zoneLook') {
        const id = key.slice(historyKey.zoneLook('').length);
        if (!nodeIds.has(id)) continue;
        window.agentBoard.zones.setLook(id, state.look).then((saved) => setNodes((current) => withZone(current, saved)), report('undo the zone’s look'));
      } else if (state?.type === 'zoneSpacing') {
        const id = key.slice(historyKey.zoneSpacing('').length);
        if (!nodeIds.has(id)) continue;
        window.agentBoard.zones.configure(id, { spacing: state.spacing }).then((saved) => setNodes((current) => withZone(current, saved)), report('undo the zone’s spacing'));
      } else if (state?.type === 'tile') {
        const nodeId = key.slice(historyKey.tile('').length);
        const node = nodesRef.current.find((known): known is TileNodeType => known.id === nodeId && isSessionTile(known));
        if (node !== undefined) tileMoves.moveTile(nodeId, node.data, state.move);
      } else if (state?.type === 'tileSize') {
        const nodeId = key.slice(historyKey.tileSize('').length);
        if (nodeIds.has(nodeId)) sizeTile(nodeId, state.size);
      } else if (state?.type === 'unfolded') {
        const nodeId = key.slice(historyKey.unfolded('').length);
        if (nodeIds.has(nodeId)) setUnfolded(nodeId, state.open);
      } else if (state?.type === 'name') {
        // Not through the tile action, which would record it; and left be if the session or shell has gone.
        if (nameOf(state.target) !== undefined) renameDirect(state.target, state.name).then((saved) => showZoneName(state.target, saved), report('undo the rename'));
      }
    }
    for (const state of entries) {
      if (state?.type !== 'connector') continue;
      const { connector } = state;
      const present = (end: ConnectorEnd) => nodeIds.has(nodeIdOf(end)) || coming.has(nodeIdOf(end));
      if (!present(connector.from) || !present(connector.to)) continue;
      if (connectorsRef.current.some((known) => known.id === connector.id)) {
        connectorActions.update(createParamsOf(connector));
      } else putConnector(connector);
    }
    // Only between agents still on the board: undo never brings back an agent, or the edge with it. One still there is
    // only reshaped: its rules stay as they are now.
    for (const state of entries) {
      if (state?.type !== 'flowEdge') continue;
      const { id, from, to, fromSide, toSide, style, points } = state.edge;
      const agentsHere = nodeIds.has(tileNodeId('agent', from)) && nodeIds.has(tileNodeId('agent', to));
      if (flowEdgesRef.current.some((known) => known.id === id)) {
        // Its ends go back to the agents they were on, if both are still here.
        flow.actions.update(id, { ...(agentsHere && { from, to }), fromSide, toSide, style, points });
      } else if (agentsHere) flow.actions.restore(state.edge);
    }
    // Shells and panes moved between windows and the board, one call after another: a shell tile is back on
    // the board before its tabs go back to it. One gone meanwhile is left be.
    const shellPlaces = tilesFirst(
      [...states].flatMap(([key, state]) => (state?.type === 'shellPlace' ? [{ id: key.slice(historyKey.shell('').length), to: state.to, order: state.order }] : [])),
    );
    const panePlaces = [...states].flatMap(([key, state]) => (state?.type === 'panePlace' ? [{ sessionId: key.slice(historyKey.pane('').length), state }] : []));
    const surfacePlaces = [...states.values()].flatMap((state) => (state?.type === 'surfacePlace' ? [state] : []));
    if (shellPlaces.length === 0 && panePlaces.length === 0 && surfacePlaces.length === 0) return;
    /** Whether the owner or zone a shell would go back to has gone meanwhile (deleted, say): it stays where it is. */
    const placeGone = (to: ShellPlace) =>
      'owner' in to
        ? to.owner.kind === 'agent'
          ? !agentsRef.current.some((agent) => agent.sessionId === to.owner.id)
          : !shellsRef.current?.some((shell) => shell.id === to.owner.id && shell.owner === null)
        : to.tile.zoneId !== null && !nodeIds.has(to.tile.zoneId);
    // One after another, each on its own: one that fails is said, and the rest still go back.
    let moving = Promise.resolve();
    const then = (step: () => Promise<void>) => {
      moving = moving.then(() => step().catch(report('move the shell back')));
    };
    for (const place of shellPlaces) {
      then(async () => {
        if (!shellsRef.current?.some((shell) => shell.id === place.id) || placeGone(place.to)) return;
        shellsHeard(await window.agentBoard.shells.moveTab(place.id, place.to, place.order));
      });
    }
    for (const { sessionId, state } of panePlaces) {
      then(async () => {
        if ('in' in state) {
          if (!shellsRef.current?.some((shell) => shell.id === state.in.shellId)) return;
          shellHeard(await window.agentBoard.shells.returnPane(state.in.shellId, sessionId, state.in.layout));
          return;
        }
        const holder = shellsRef.current?.find((shell) => paneIds(shell.layout).includes(sessionId));
        if (holder === undefined || placeGone(state.alone.to)) return;
        const { moved, source } = await window.agentBoard.shells.movePane(holder.id, sessionId, state.alone.to, state.alone.shellId);
        shellsHeard([source, moved]);
      });
    }
    // Tabs that are only a place in a window, back into the window they were in, out of the one they are in
    // now; a tab window they go back into pops out again. One whose window has gone meanwhile is said, and left be.
    for (const state of surfacePlaces) {
      then(async () => {
        await moveSurface({ kind: 'surface', surface: state.surface, from: state.from, to: state.in });
        popOutTabWindow(state.in?.owner, state.surface);
      });
    }
    // The keyboard stays the board's, so ⌘Z and ⇧⌘Z go on stepping through moves.
    void moving.then(movesSettled);
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
    updateConnector: connectorActions.update,
    moveTile,
    moveZone,
    select: selectOnly,
    pasteAt: () => (pointer.current === undefined ? boardCentre() : screenToFlowPosition(pointer.current)),
    duplicateOffset: desk.gap,
    report,
    inform: (message) => toasts.show({ tone: 'info', message }),
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

  /** Where on the screen the shape palette (`/`) is open, if it is. */
  const [quickInsert, setQuickInsert] = useState<{ x: number; y: number }>();
  const openQuickInsert = useCallback((at: { x: number; y: number } | undefined) => setQuickInsert(quickInsertAt(at, boardOnScreen())), [boardOnScreen]);
  /** The shape picked from the palette, put down at its own size, centred where the palette was opened. */
  const insertShape = useCallback(
    (shape: ShapeType, at: { x: number; y: number }) => {
      setQuickInsert(undefined);
      noteShapeUsed(shape);
      createItem('shape', screenToFlowPosition(at), { size: SHAPES[shape].size, data: { ...newShapeData(shape) } });
    },
    [createItem, screenToFlowPosition],
  );

  // Where the cheat sheet opens: in a session window or expanded tile, on the one tile selected, or on the board.
  const cheatSheet = useCheatSheet(
    useCallback((): SheetContext => {
      if (document.activeElement?.closest(SESSION_SURFACES) != null) return 'window';
      const [node, ...rest] = editing.selection().nodes;
      return node !== undefined && rest.length === 0 && isSessionTile(node) ? 'tile' : 'board';
    }, [editing.selection]),
  );

  const { renameRequest, renameRequests, requestRename } = useRenameRequests();
  const typeInShape = useCallback((nodeId: string) => updateNodeData(nodeId, { editing: true }), [updateNodeData]);
  useBoardShortcuts({
    openCheatSheet: cheatSheet.open,
    arrangeBoard,
    typeInShape,
    cycleConnections,
    cycleCrewLook,
    openQuickInsert,
    loaded,
    tool,
    setTool,
    pickMode,
    createItem,
    pointer,
    boardCentre,
    screenToFlowPosition,
    collapseFrontTile,
    selection: editing.selection,
    clickOpens,
    tileActions,
    renameRequest,
    requestRename,
  });

  const { deleteSelected, onBeforeDelete } = useDeleteSelection({
    editing,
    nodesRef,
    shellsRef,
    selectedConnectorsRef,
    tileActions,
    askDelete,
    remove: { agent: deleteAgent, shell: deleteShell, external: dismissExternal },
    crewCards,
    zonesToDelete,
    removeZones,
    report,
    home,
  });

  // Ask Claude about the selection (CM): its answer comes back as an agent note, its suggested edits as ghosts.
  const askClaude = useAskClaude({
    loaded,
    zones: () => nodesRef.current.filter(isZone).map((node) => node.data.zone),
    connectors: () => connectorsRef.current,
    zoneLayouts,
    onStarted: () => {},
  });
  const suggestionActions = useSuggestionCommands({
    item: (id) => nodesRef.current.find((node): node is ItemNodeType => isItemNode(node) && node.data.item.id === id)?.data.item,
    rectOf: (object) => {
      const node = getInternalNode(nodeIdOf(object));
      return node === undefined ? undefined : boundsOnBoard(node.internals.userNode, { ...node.internals.positionAbsolute, width: node.measured.width ?? 0, height: node.measured.height ?? 0 });
    },
    putItem,
    putConnector,
    updateItem: itemActions.update,
    zoneLayouts,
    topZ,
  });

  /** The zone a crew can start in nearest a point on the board: the one it is in, else the closest. */
  const zoneNearest = (at: { x: number; y: number }): Zone | undefined => {
    const distance = (zone: Zone) => Math.hypot(Math.max(zone.x - at.x, 0, at.x - zone.x - zone.width), Math.max(zone.y - at.y, 0, at.y - zone.y - zone.height));
    const bound = nodes.filter(isZone).map((node) => node.data.zone).filter((zone) => zone.clone === null);
    return bound.reduce<Zone | undefined>((best, zone) => (best === undefined || distance(zone) < distance(best) ? zone : best), undefined);
  };

  const { menu, tileBoard, onNodeContextMenu, onSelectionContextMenu, onPaneContextMenu } = useBoardMenu({
    askClaude: askClaude.open,
    editing,
    deleteSelected,
    selectedConnectors,
    requestRename,
    connectFrom: setConnectingFrom,
    connectNodes,
    grid,
    toggleGrid,
    tidyLoose,
    arrangeBoard,
    selectOnly,
    nodeOf: (nodeId) => nodesRef.current.find((node) => node.id === nodeId),
    addClock: (at) => {
      const clockId = createItem('clock', screenToFlowPosition(at));
      setClockEditing({ clockId, data: { ...clockData({}) } });
    },
    addSteps: (at) => void createItem('steps', screenToFlowPosition(at)),
    addMemory: (at) => void createItem('memory', screenToFlowPosition(at)),
    addQueue: (at) => void createItem('queue', screenToFlowPosition(at)),
    startCrew: (name, at) => {
      const prefab = prefabNamed(name);
      if (prefab !== undefined) setCrewFlow({ kind: 'prompt', prefab, suggested: zoneNearest(screenToFlowPosition(at)) });
    },
    crewLibrary: (at) => setCrewFlow({ kind: 'library', suggested: zoneNearest(screenToFlowPosition(at)) }),
    leadPinned: (nodeId) => {
      const subject = tileSubject(nodeId);
      const agent = subject?.kind === 'agent' ? agents.find((known) => known.sessionId === subject.id) : undefined;
      const zone = agent?.zoneId === null || agent === undefined ? undefined : nodes.find((node) => node.id === agent.zoneId);
      if (agent === undefined || !isLead(agent, agents) || zone === undefined || !isZone(zone) || zone.data.zone.layoutMode === 'free') return undefined;
      return pinnedLead(agent, agents, shelves.choice.freed);
    },
    setLeadPinned: (nodeId, pinned) => {
      const subject = tileSubject(nodeId);
      if (subject?.kind === 'agent') shelves.setPinned(subject.id, pinned, new Set(agents.map((agent) => agent.sessionId)));
    },
  });

  const { onFilesDropped } = useIncoming({ loaded, createItem, report, pasteItems: editing.paste, pasteDiagram: editing.pasteDiagram, pointer, boardCentre, screenToFlowPosition });

  /** A new sticky note where the screen point `at` is, from a project's right-click menu. */
  const newNoteAt = useCallback((at: { x: number; y: number }) => void createItem('sticky', screenToFlowPosition(at)), [createItem, screenToFlowPosition]);

  /** Starts a shell tile in the zone and opens its window. */
  const newShell = useCallback(
    (zone: Zone) => {
      window.agentBoard.shells.create({ zoneId: zone.id }).then((shell) => {
        shellHeard(shell);
        openShell(shell);
      }, report('start a shell'));
    },
    [shellHeard, openShell, report],
  );

  /** Where the tiles loose on the board are. */
  const looseTiles = () => [
    ...getNodes()
      .filter((node) => isSessionTile(node) && node.parentId === undefined)
      .map((node) => ({ ...node.position, ...sizeOfNode(node) })),
    ...[...looseSpots.current].map((spot) => spot.rect),
  ];

  /** The window of the agent or shell tile `owner` names, as the board opens it. */
  const windowTargetOf = (owner: { kind: string; id: string }): WindowTarget | undefined => {
    if (owner.kind === 'agent') {
      const agent = agentsRef.current.find((known) => known.sessionId === owner.id);
      return agent && { kind: 'session', id: agent.sessionId, title: agentTitle(agent) };
    }
    const shell = owner.kind === 'shell' ? shellsRef.current?.find((known) => known.id === owner.id && known.owner === null) : undefined;
    return shell && { kind: 'shell', id: shell.id, title: shellTitle(shell) };
  };

  /**
   * Pops a tab let go outside every window (slice 4) out into an OS window of its own, at `at` on the screen.
   * A shell tab or a pane becomes a shell tile loose on the board, beside the tile of the window it left and clear of
   * everything, and that tile's window pops out; a shell tile's own tab, alone, pops its window out as it is. A
   * window's own tab pops its window out; another session's leaves the window, and that session's window pops out. A
   * pull request or web tab goes into a tab window of its own. Undone, the tab goes back; the windows stay as they are.
   */
  const popOutDragged = (drag: TabDrag, at: ScreenPoint) => {
    if (drag.kind === 'surface') {
      const { surface, from } = drag;
      if (surface.kind === 'own') {
        const target = windowTargetOf(from);
        if (target !== undefined) popOut(target, at);
        return;
      }
      if (surface.kind === 'session') {
        const target = windowTargetOf(surface.target);
        if (target === undefined) return;
        // Only once it has left the window: refused, it is still shown there, and nothing pops out.
        void moveTab({ kind: 'surface', surface, from, to: null }).then(({ made }) => made && popOut(target, at));
        return;
      }
      if (surface.kind !== 'pr' && surface.kind !== 'web' && surface.kind !== 'gate') return;
      const owner = { kind: 'tabs', id: crypto.randomUUID() } as const;
      void moveTab({ kind: 'surface', surface, from, to: { owner } }).then(({ made }) => made && popOutTabWindow(owner, surface, at));
      return;
    }
    const shell = shellsRef.current?.find((known) => known.id === drag.shellId);
    if (shell === undefined) return;
    if (drag.kind === 'tab' && shell.owner === null) {
      popOut({ kind: 'shell', id: shell.id, title: shellTitle(shell) }, at);
      return;
    }
    const left = getNodes().find((node) => node.id === tileNodeId(drag.from.kind === 'agent' ? 'agent' : 'shell', drag.from.id));
    const centre = boardCentre();
    const beside =
      left === undefined
        ? { x: centre.x - AGENT_TILE_SIZE.width / 2, y: centre.y - AGENT_TILE_SIZE.height / 2 }
        : { x: absoluteOf(left).x + AGENT_TILE_SIZE.width + TILE_GAP, y: absoluteOf(left).y };
    const position = freeSpotFor(beside, AGENT_TILE_SIZE, [...zoneRooms(), ...looseTiles()]);
    const move = dropMove(drag, { tile: { zoneId: null, ...position, toFront: true } });
    if (move === undefined) return;
    void moveTab(move).then(({ shell: moved }) => {
      if (moved?.owner === null) popOut({ kind: 'shell', id: moved.id, title: shellTitle(moved) }, at);
    });
  };
  const popOutDraggedRef = useRef(popOutDragged);
  popOutDraggedRef.current = popOutDragged;
  useEffect(() => window.agentBoard.tabDrags.onPopOut((drag, at) => popOutDraggedRef.current(drag, at)), []);
  // Loaded, and listening for them: the moves and pop-outs a popped-out window made while the board was closed come now.
  useEffect(() => {
    if (loaded) window.agentBoard.tabDrags.ready();
  }, [loaded]);

  /** A free spot for a new zone, near the middle of the view, clear of the zones and loose tiles. */
  const newZoneSpot = () => {
    const centre = boardCentre();
    const wanted = { x: centre.x - DEFAULT_ZONE_SIZE.width / 2, y: centre.y - DEFAULT_ZONE_SIZE.height / 2 };
    return freeSpotFor(wanted, DEFAULT_ZONE_SIZE, [...zoneRooms(), ...looseTiles()]);
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
          shellHeard(split);
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
      initRepo(zone) {
        setNotice(undefined);
        window.agentBoard.zones.initRepo(zone.id).then((bound) => {
          setNodes((current) => withZone(current, bound));
          toasts.show({ tone: 'success', message: `${bound.name} is a git repo now: new agents get worktrees of their own` });
        }, report('make it a git repo'));
      },
      pickDefaultRepo: setDefaultRepoZone,
      tidy: (zone) => tidyZone(zone.id),
      setSpacing(zone, spacing) {
        window.agentBoard.zones.configure(zone.id, { spacing }).then((saved) => {
          setNodes((current) => withZone(current, saved));
          // One step with the tidy it makes: an undo puts the spacing back with the tiles.
          history.record([[historyKey.zoneSpacing(zone.id), { type: 'zoneSpacing', spacing: zone.spacing }, { type: 'zoneSpacing', spacing }]]);
          tidyZone(zone.id, spacing);
        }, report('change the zone’s spacing'));
      },
      openSettings: () => void window.agentBoard.setup.openSettings('board.tidying').catch(report('open Settings')),
      setLayoutMode(zone, layoutMode) {
        // Only how the zone is drawn: no tile's saved place changes, so Free again shows it as it was.
        window.agentBoard.zones.configure(zone.id, { layoutMode }).then((saved) => setNodes((current) => withZone(current, saved)), report('change the zone’s layout'));
      },
      fold(zone) {
        window.agentBoard.zones.fold(zone.id).then((result) => {
          setNodes((current) => withZone(current, result.zone));
          toasts.show(foldedToast(result));
        }, report('fold the zone'));
      },
      unfold(zone, wake) {
        // First, so the zone opens onto nothing: its chip is unfolded as soon as the daemon says so, before this answers
        // (which waits for each agent to wake).
        const putBack = makeRoomToUnfold(zone.id);
        window.agentBoard.zones.unfold(zone.id, wake).then(
          (result) => {
            setNodes((current) => withZone(current, result.zone));
            const woken = new Set(result.woken);
            const paused = agentsRef.current.filter((agent) => agent.zoneId === zone.id && agent.state === 'hibernated' && !woken.has(agent.sessionId)).length;
            toasts.show(unfoldedToast(result, paused));
          },
          (error: unknown) => {
            // It did not open: what made room for it goes back. A call that failed once the zone was open (it is drawn
            // unfolded as the daemon says so) leaves them clear of it.
            const now = nodesRef.current.filter(isZone).find((node) => node.id === zone.id)?.data.zone;
            if (now?.folded !== false) putBack();
            report('unfold the zone')(error);
          },
        );
      },
      rename: (zone, name) => tileActions.rename({ kind: 'zone', zoneId: zone.id }, name),
      recolor(zone, color) {
        const { fillOpacity } = zone;
        history.record([[historyKey.zoneLook(zone.id), { type: 'zoneLook', look: { color: zone.color, fillOpacity } }, { type: 'zoneLook', look: { color, fillOpacity } }]]);
        window.agentBoard.zones.setLook(zone.id, { color }).then((saved) => setNodes((current) => withZone(current, saved)), report('recolour the zone'));
      },
      previewFill(zone, fillOpacity) {
        // What the zone had before the drag, for the one step it is undone by.
        if (!fillBeforeDrag.current.has(zone.id)) fillBeforeDrag.current.set(zone.id, zone.fillOpacity);
        setNodes((current) => {
          const known = current.filter(isZone).find((node) => node.id === zone.id);
          return known === undefined ? current : withZone(current, { ...known.data.zone, fillOpacity });
        });
      },
      cancelFill(zone) {
        if (!fillBeforeDrag.current.has(zone.id)) return;
        const before = fillBeforeDrag.current.get(zone.id)!;
        fillBeforeDrag.current.delete(zone.id);
        setNodes((current) => {
          const known = current.filter(isZone).find((node) => node.id === zone.id);
          return known === undefined ? current : withZone(current, { ...known.data.zone, fillOpacity: before });
        });
      },
      setFill(zone, fillOpacity) {
        const before = fillBeforeDrag.current.has(zone.id) ? fillBeforeDrag.current.get(zone.id)! : zone.fillOpacity;
        fillBeforeDrag.current.delete(zone.id);
        history.record([[historyKey.zoneLook(zone.id), { type: 'zoneLook', look: { color: zone.color, fillOpacity: before } }, { type: 'zoneLook', look: { color: zone.color, fillOpacity } }]]);
        window.agentBoard.zones.setLook(zone.id, { fillOpacity }).then((saved) => setNodes((current) => withZone(current, saved)), report("set the zone's fill opacity"));
      },
      deleteZone: (zone: Zone) => deleteZones([zone]),
      setTrustsFolder(zone, trustsFolder) {
        window.agentBoard.zones.configure(zone.id, { trustsFolder }).then(
          (saved) => {
            setNodes((current) => withZone(current, saved));
            toasts.show({
              tone: 'success',
              message: trustsFolder
                ? `New agents in ${saved.name} start without Claude's trust prompt`
                : `New agents in ${saved.name} show Claude's trust prompt again`,
            });
          },
          report('change whether the zone trusts its folder'),
        );
      },
      setBoardMcp(zone, boardMcp) {
        window.agentBoard.zones.configure(zone.id, { boardMcp }).then(
          (saved) => {
            setNodes((current) => withZone(current, saved));
            toasts.show({ tone: 'success', message: `Agents started in ${saved.name} ${boardMcp ? 'get' : "don't get"} the board MCP server` });
          },
          report('change the zone’s board MCP setting'),
        );
      },
      editGateCommand: setGateCommandZone,
      editRoleTemplates: setRoleTemplatesZone,
      startCrew: (name: string, zone: Zone) => {
        const prefab = prefabNamed(name);
        if (prefab !== undefined) setCrewFlow({ kind: 'prompt', prefab, zone });
      },
      crewLibrary: (zone: Zone) => setCrewFlow({ kind: 'library', zone }),
      setAgentsOrchestrate(zone, agentsOrchestrate) {
        window.agentBoard.zones.configure(zone.id, { agentsOrchestrate }).then(
          (saved) => {
            setNodes((current) => withZone(current, saved));
            toasts.show({
              tone: 'success',
              message: agentsOrchestrate
                ? `Agents you start in ${saved.name} may orchestrate there`
                : `No agent in ${saved.name} orchestrates any more`,
            });
          },
          report('change whether the zone’s agents may orchestrate'),
        );
      },
    }),
    [setNodes, reloadExternals, toasts, report, tidyZone, deleteZones, history, makeRoomToUnfold],
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
        const position = freeSpotFor(wanted, AGENT_TILE_SIZE, [...zoneRooms(), ...looseTiles()]);
        const spot: { rect: ZoneLayout; shellId?: string } = { rect: { ...position, ...AGENT_TILE_SIZE } };
        looseSpots.current.add(spot);
        return window.agentBoard.shells.create({ zoneId: null, position }).then(
          (shell) => {
            spot.shellId = shell.id;
            shellHeard(shell);
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
    [boardCentre, zoneRooms, openShell, report],
  );

  const masterPanel = useMasterPanel();
  const openSettings = () => void window.agentBoard.setup.openSettings().catch(report('open Settings'));
  // The board's items as they are drawn: the master's panel shows its latest digest note.
  const boardItems = useMemo(() => nodes.filter(isItemNode).map((node) => node.data.item), [nodes]);
  /** The zones an agent or crew can start in. */
  const startableZones = () => nodesRef.current.filter(isZone).map((node) => node.data.zone).filter((zone) => zone.clone === null);
  /** The startable zone in the middle of the view, if one is. A folded one is a chip, wherever its room was. */
  const zoneInView = () => {
    const centre = boardCentre();
    return startableZones()
      .filter((zone) => !zone.folded)
      .find((zone) => centre.x >= zone.x && centre.x <= zone.x + zone.width && centre.y >= zone.y && centre.y <= zone.y + zone.height);
  };

  /**
   * Takes the user to the chip of the folded zone the tile is in, and says so. A tile in a folded zone is not drawn, so
   * its chip is where it is; unfolding stays the user's to ask for.
   */
  const showFoldedHome = (nodeId: string, show: (rect: Rect) => void) => {
    const parentId = nodesRef.current.find((known) => known.id === nodeId)?.parentId;
    const home = parentId === undefined ? undefined : nodesRef.current.filter(isZone).find((known) => known.id === parentId);
    if (home?.data.zone.folded !== true) return false;
    selectOnly(new Set([home.id]));
    show(roomOf(home));
    return true;
  };

  const boardCommands = useMemo<BoardCommands>(
    () => ({
      openSession(sessionId) {
        const shell = shellWithPane(shellsRef.current, sessionId);
        const agent = agentsRef.current.find((known) => known.sessionId === sessionId);
        if (shell !== undefined) openShell(shell);
        else if (agent !== undefined) openAgent(agent);
        return shell !== undefined || agent !== undefined;
      },
      showItem(itemId) {
        const nodeId = `${ITEM_NODE_PREFIX}${itemId}`;
        const node = getInternalNode(nodeId);
        if (node === undefined) return;
        selectOnly(new Set([nodeId]));
        bringIntoView({ ...node.internals.positionAbsolute, ...sizeOfNode(node) });
      },
      focusSession(sessionId) {
        const shell = shellWithPane(shellsRef.current, sessionId);
        const nodeId = shell !== undefined ? tileNodeId('shell', shell.id) : tileNodeId('agent', sessionId);
        if (showFoldedHome(nodeId, bringIntoView)) return;
        const folded = shell === undefined ? unfoldStack(sessionId) : undefined;
        if (folded !== undefined) {
          selectOnly(new Set([nodeId]));
          bringIntoView(folded);
          return;
        }
        const node = getInternalNode(nodeId);
        if (node === undefined) return;
        selectOnly(new Set([nodeId]));
        bringIntoView({ ...node.internals.positionAbsolute, ...sizeOfNode(node) });
      },
      showTile({ kind, id }) {
        const nodeId = tileNodeId(kind, id);
        if (showFoldedHome(nodeId, flyTo)) return true;
        const folded = kind === 'agent' ? unfoldStack(id) : undefined;
        if (folded !== undefined) {
          selectOnly(new Set([nodeId]));
          pulseTile(nodeId, flyTo(folded));
          return true;
        }
        const node = getInternalNode(nodeId);
        if (node === undefined) return false;
        selectOnly(new Set([nodeId]));
        pulseTile(nodeId, flyTo({ ...node.internals.positionAbsolute, ...sizeOfNode(node) }));
        return true;
      },
      openTile({ kind, id }) {
        const node = nodesRef.current.find((known) => known.id === tileNodeId(kind, id));
        if (node === undefined || !isSessionTile(node)) return false;
        const opens = tileOpenAction(clickOpens, { hasWindow: node.data.external === undefined });
        // Its window opens whether its tile is drawn or not; a tile in a folded zone is not there to expand.
        if (opens !== 'window' && showFoldedHome(node.id, flyTo)) return true;
        selectOnly(new Set([node.id]));
        if (opens === 'window') tileActions.maximise(node.data);
        else tileActions.expand(node.id);
        return true;
      },
      switchExpanded(fromNodeId, { kind, id }) {
        const nodeId = tileNodeId(kind, id);
        if (nodesRef.current.every((known) => known.id !== nodeId)) return false;
        collapse(fromNodeId);
        tileActions.expand(nodeId);
        focusTerminalIn(nodeId);
        return true;
      },
      showZone(zoneId, collapseNodeId) {
        // Where it is now: its node may have been moved or resized since the daemon sent it.
        const node = getNodes().filter(isZone).find((known) => known.id === zoneId);
        if (node === undefined) return false;
        if (collapseNodeId !== undefined) collapse(collapseNodeId);
        bringIntoView(layoutOf(node));
        setCurrentZone(zoneId);
        return true;
      },
      canStartAgent: () => nodesRef.current.some((node) => isZone(node) && node.data.zone.clone === null),
      newAgentNamed(name, zoneId) {
        // The zone asked for, else the one in the middle of the view, else the first.
        const zone = startableZones().find((known) => known.id === zoneId) ?? zoneInView() ?? startableZones()[0];
        if (zone !== undefined) setNewAgent({ zone, name });
      },
      startCrew(name, zoneId) {
        // A guess at where, so the prompt box shows it in its Zone, to change: the window's zone, else the one in view.
        const suggested = startableZones().find((known) => known.id === zoneId) ?? zoneInView();
        if (name === null) return setCrewFlow({ kind: 'library', suggested });
        const prefab = prefabNamed(name);
        if (prefab !== undefined) setCrewFlow({ kind: 'prompt', prefab, suggested });
      },
    }),
    [getNodes, getInternalNode, zoneLayouts, openShell, openAgent, report, selectOnly, bringIntoView, flyTo, clickOpens, tileActions, collapse, boardCentre, unfoldStack],
  );
  useProvideBoardCommands(loaded ? boardCommands : undefined);

  // A crew may start in a zone out of view, and its builder's tile is all there is of it yet: shown once it is there.
  useEffect(() => {
    if (crewStarted !== undefined && boardCommands.showTile({ kind: 'agent', id: crewStarted })) setCrewStarted(undefined);
  }, [crewStarted, nodes, boardCommands]);

  // What a popped-out window's ⌘K switcher asked of the board, once it has loaded: a zone, New agent, a session's window.
  const [boardRequest, setBoardRequest] = useState<BoardRequest>();
  useEffect(() => window.agentBoard.windows.onBoardRequested(setBoardRequest), []);
  useEffect(() => {
    if (!loaded || boardRequest === undefined) return;
    setBoardRequest(undefined);
    if (boardRequest.kind === 'zone') boardCommands.showZone(boardRequest.zoneId);
    else if (boardRequest.kind === 'newAgent') boardCommands.newAgentNamed(boardRequest.name, boardRequest.zoneId);
    // One already open may hold a typed prompt or unsaved edits, which a pop-out's request mustn't throw away.
    else if (boardRequest.kind === 'crew') {
      if (crewFlow === undefined) boardCommands.startCrew(boardRequest.prefab, boardRequest.zoneId);
    }
    else showWindow(boardRequest.target);
  }, [loaded, boardRequest, boardCommands, showWindow, crewFlow]);

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
        .map((node) => (isItemNode(node) ? node.data.item : { ...node.position, ...sizeOfNode(node) }));
      const at = freeItemSpot(zone.width, size, taken);
      const { provider, id, title, url, state } = issue;
      createItem('issue', { x: zone.x + at.x + size.width / 2, y: zone.y + at.y + size.height / 2 }, { data: { provider, id, title, url, state } });
    },
    [createItem, getNodes],
  );

  // An agent started from an issue the New agent dialog picked: its card feeds it all the same, in a spot clear of
  // its tile, with the issue as the tracker lists it now, else as the agent has it.
  useEffect(() => {
    for (const [sessionId, zone] of issueCardsDue.current) {
      const linked = agents.find((agent) => agent.sessionId === sessionId)?.issue;
      if (linked === undefined) continue;
      issueCardsDue.current.delete(sessionId);
      if (linked === null) continue;
      const unlisted = { ...linked, state: '' };
      void window.agentBoard.trackers.issues(zone.id, linked.id).then(
        (found) => placeIssueCard(zone, found.find((each) => each.id === linked.id) ?? unlisted),
        () => placeIssueCard(zone, unlisted),
      );
    }
  }, [agents, placeIssueCard]);

  /** Opens the New agent dialog for an agent fed by the issue's card, which goes in once the agent has started: cancelled, it leaves no card. */
  const startFromIssue = useCallback((zone: Zone, issue: TrackerIssue) => setNewAgent({ zone, issue, issueZoneId: zone.id, card: issue }), []);

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
        if (start.kind === 'refuse') return report('start an agent')(start.reason);
        const { zone, issueZoneId } = start;
        // In a zone the board slots the tile in clear of the card; a card loose on the board puts it beside itself.
        const left = item.x + item.width + ZONE_PADDING;
        const beside = dropPlace({ x: left + AGENT_TILE_SIZE.width / 2, y: item.y + AGENT_TILE_SIZE.height / 2 }, zoneLayouts());
        setNewAgent({ zone, issue: card, issueZoneId, position: zone === undefined ? { x: beside.x, y: beside.y } : undefined });
      },
    }),
    [agents, issueStartOf, zoneLayouts, report],
  );

  /** The Add issue dialog's Start agent: the New agent dialog, with a repo field in a group. */
  const startFromZoneIssue = startFromIssue;

  const cancelClone = useCallback(
    (zone: Zone) => {
      clonesWatched.current.delete(zone.id);
      window.agentBoard.zones.cancelClone(zone.id).catch(report('cancel the clone'));
    },
    [report],
  );

  /** What clocks draw from: their statuses, the agents' names, and their editor. */
  const queueBoard = useMemo<QueueBoard>(
    () => ({ agents, openAgent, openLink: (url) => void window.agentBoard.trackers.openLink(url).catch(report('open the link')) }),
    [agents, openAgent, report],
  );
  /** What crew cards draw from: the agents as they are now, how to open what a card points at, and its crew's stop. */
  const crewCardBoard = useMemo<CrewCardBoard>(() => {
    const withAgent = (sessionId: string, open: (agent: Agent) => void) => {
      const agent = agentsRef.current.find((known) => known.sessionId === sessionId);
      if (agent !== undefined) open(agent);
    };
    return {
      agents,
      openAgent: (sessionId) => withAgent(sessionId, openAgent),
      openPullRequest: (sessionId, pr) => withAgent(sessionId, (agent) => tileActions.openPullRequest(agent, pr)),
      stop: (card) => askStopCrew(card),
    };
  }, [agents, openAgent, tileActions, askStopCrew]);
  const queues = useMemo(() => boardItems.filter((item) => item.kind === 'queue'), [boardItems]);
  /** The agent under the pointer that takes a dragged job of a queue in `zoneId`: idle, and in its scope. */
  const jobTakerAt = (x: number, y: number, zoneId: string | null) => {
    const owner = ownerAtPoint(x, y, { agentsOnly: true });
    const agent = owner === undefined ? undefined : agents.find((each) => each.sessionId === owner.id);
    return agent !== undefined && takesJobFrom(agent, zoneId) ? agent : undefined;
  };
  const clockBoard = useMemo<ClockBoard>(
    () => ({
      statuses: clockStatuses,
      agentName: (sessionId) => agents.find((agent) => agent.sessionId === sessionId)?.name,
      edit(clockId) {
        const node = nodesRef.current.find((known) => known.id === `${ITEM_NODE_PREFIX}${clockId}`);
        if (node !== undefined && isItemNode(node)) setClockEditing({ clockId, data: node.data.item.data });
      },
    }),
    [clockStatuses, agents],
  );

  const allEdges = useMemo(() => {
    const nodeIds = new Set(nodes.map((node) => node.id));
    const agentNames = new Map(agents.map((agent) => [agent.sessionId, agent.name]));
    // Done with their turn: a manual edge out of one waits for Send.
    const ready = new Map(
      agents.filter((agent) => agent.endedAt === null && (agent.state === 'idle' || agent.state === 'waiting')).map((agent) => [agent.sessionId, agent.finishedAt]),
    );
    return [
      ...connectorEdges(connectors, nodeIds, selectedConnectors),
      ...briefEdges(nodes, agents),
      ...agentNoteTethers(nodes),
      ...masterRails(nodeIds, agents),
      ...clockTethers(nodes, clockStatuses),
      // Its tiles as React Flow measured them, as each rail is drawn from (`useLine`): a token's slot is by the side its rail ends on.
      ...flowEdges(flow.edges, nodeIds, flow.selected, { live: flow.live, names: agentNames, ready, rectOf: (sessionId) => rectOf(tileNodeId('agent', sessionId)) }),
    ];
  }, [connectors, nodes, selectedConnectors, agents, flow.edges, flow.selected, flow.live, rectOf, clockStatuses]);
  // With some hidden, a tile that is selected or hovered shows its own; the rest are told how many they have.
  const selectedKey = connections === 'all' ? '' : nodes.filter((node) => node.selected === true).map((node) => node.id).join('\n');
  // What a shelved zone folded into its stacks is hidden, and so are the lines to it.
  const hiddenKey = drawn.flatMap((node) => (node.hidden === true ? [node.id] : [])).join('\n');
  const edges = useMemo(() => {
    const hidden = new Set(hiddenKey.split('\n').filter(Boolean));
    const shown = hidden.size === 0 ? allEdges : allEdges.filter((edge) => !hidden.has(edge.source) && !hidden.has(edge.target));
    if (connections === 'all') return shown;
    const revealed = new Set(selectedKey.split('\n').filter(Boolean));
    if (hoveredTile !== undefined) revealed.add(hoveredTile);
    return shownEdges(shown, connections, revealed);
  }, [allEdges, connections, selectedKey, hoveredTile, hiddenKey]);
  /** In a capture window, what it draws: its zone and what is in it, and the edges between those (capture-mode.ts). */
  const captured = useMemo(() => {
    if (CAPTURE_FRAME === undefined) return undefined;
    const kept = nodesInZone(drawn, CAPTURE_FRAME.zoneId);
    return { nodes: kept, edges: edgesAmong(edges, kept) };
  }, [drawn, edges]);
  const hiddenCounts = useMemo(() => {
    if (connections === 'all') return new Map<string, number>();
    const drawn = new Set(shownEdges(allEdges, connections, new Set()).map((edge) => edge.id));
    // A note's tether to its agent is no connection to count.
    return edgeCounts(allEdges.filter((edge) => !drawn.has(edge.id) && !isTether(edge)));
  }, [allEdges, connections]);
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
  // A rail picked selects the edge its token is from, unless one of its edges is selected already.
  const railsDrawn = useRef(new Map<string, FlowRailData>());
  railsDrawn.current = new Map(allEdges.filter(isFlowEdge).map((edge) => [edge.id, edge.data as FlowRailData]));
  const edgesChanged = useCallback((changes: EdgeChange[]) => {
    const flowChanges = changes.filter((change) => 'id' in change && isFlowEdge(change)) as Exclude<EdgeChange, { type: 'add' }>[];
    if (flowChanges.length > 0) {
      setSelectedFlowEdges((current) =>
        flowChanges.reduce<ReadonlySet<string>>((next, change) => {
          if (change.type !== 'select' && change.type !== 'remove') return next;
          // A rail no longer drawn is its first edge, as its id says.
          const drawn = railsDrawn.current.get(change.id);
          const ids = drawn === undefined ? [flowEdgeIdOf(change)] : flowEdgeIdsOf({ data: drawn });
          return withRailSelected(next, ids, change.type === 'select' && change.selected, drawn?.token.edge.id ?? ids[0]!);
        }, current),
      );
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
  const rotations = useMemo(liveRotations, []);
  const severalSelected = useMemo(() => nodes.filter((node) => node.selected === true).length > 1, [nodes]);
  /** The flow edge whose Edge rules are open: the one selected, alone. */
  const shownFlowEdge = flow.selected.size === 1 ? flow.edges.find((edge) => flow.selected.has(edge.id)) : undefined;
  // The edges on its rail: a switch in its rules picks between them.
  const shownRail = shownFlowEdge && railOf(flow.edges, shownFlowEdge);
  const agentName = (sessionId: string) => agents.find((agent) => agent.sessionId === sessionId)?.name ?? 'an agent';
  const shownDirections = shownRail?.edges.map((edge) => ({ edge, name: `${agentName(edge.from)} → ${agentName(edge.to)}` }));
  const shownEnds = shownFlowEdge && {
    from: agents.find((agent) => agent.sessionId === shownFlowEdge.from),
    to: agents.find((agent) => agent.sessionId === shownFlowEdge.to),
  };
  // Opened on an edge whose tiles it would cover, the panel pans the board left until they clear it.
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
  const takenJobs = useTakenJobs();
  /** The zones on the board, for the board menu and the zone island. */
  const zones = useMemo(() => nodes.filter(isZone).map((node) => node.data.zone), [nodes]);
  // Each agent's name and worktree: a shell moved into another agent's window says whose worktree it runs in.
  useEffect(() => agentWorktrees.set(agents.map((agent) => ({ name: agent.name, worktree: agent.worktree }))), [agents]);
  // A deleted agent's Terminal / Chat choice goes with it.
  useEffect(() => {
    if (loaded) forgetViewsExcept(agents.map((agent) => agent.sessionId));
  }, [loaded, agents]);
  /** Where every agent's and shell's tile sits, for the session window's steps through its zone. */
  const navSessions = useMemo(() => nodes.filter(isSessionTile).flatMap(navSessionOf), [nodes]);

  return (
    <div
      className={handingOff ? 'board board-connecting board-drawing-flow' : connecting !== undefined ? 'board board-connecting' : 'board'}
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
        // A queue's job, to hand to the agent it is dropped on: that tile lights up.
        // Only an idle agent in the job's queue's scope takes it: a working one, or one out of scope, takes no drop.
        const job = draggedJob();
        if (job !== undefined && event.dataTransfer.types.includes(JOB_DRAG)) {
          event.preventDefault();
          const taker = jobTakerAt(event.clientX, event.clientY, job.zoneId);
          event.dataTransfer.dropEffect = taker === undefined ? 'none' : 'move';
          setJobDropOver(taker?.sessionId);
          return;
        }
        // A tab dragged in this window or another of the app's: that a drag is on is heard from main, as its data
        // type may not reach a window it didn't start in.
        const drag = tabDrag();
        if (drag === undefined) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const owner = ownerAtPoint(event.clientX, event.clientY);
        dropOver.set(owner !== undefined && landsOn(drag, owner) ? dropKey(owner) : undefined);
      }}
      onDragLeave={(event) => {
        // Off the window, the tile or window it was over is no longer shown.
        if (event.relatedTarget === null) {
          dropOver.set(undefined);
          setJobDropOver(undefined);
        }
      }}
      onDrop={(event) => {
        const job = draggedJob();
        if (job !== undefined && event.dataTransfer.types.includes(JOB_DRAG)) {
          event.preventDefault();
          setJobDropOver(undefined);
          startJobDrag(undefined);
          const taker = jobTakerAt(event.clientX, event.clientY, job.zoneId);
          if (taker !== undefined) openHandOn({ queueId: job.queueId, jobId: job.jobId, sessionId: taker.sessionId });
          return;
        }
        const drag = tabDrag();
        if (drag !== undefined) {
          event.preventDefault();
          dropTaken();
          shellDropped(drag, { x: event.clientX, y: event.clientY });
          return;
        }
        onFilesDropped(event);
      }}
      onPointerDownCapture={(event) => {
        tileMoves.onPressed({ x: event.clientX, y: event.clientY });
        const classes = (event.target as HTMLElement).classList;
        keptSelection.current =
          event.shiftKey && (classes.contains('react-flow__pane') || classes.contains('zone'))
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
                      <TileMenuBoardContext value={tileBoard}>
                      <ConnectionCountsContext value={hiddenCounts}>
                      <CrewViewContext value={crewView}>
                      <AgentNoteLookContext value={agentNoteLook}>
                      <CrewFramesContext value={shownFrames}>
                      <ShelvesContext value={shelvesActions}>
                      <ProjectSummaryContext value={projectSummary}>
                      <NewNoteContext value={newNoteAt}>
                      <ShellFoldersContext value={shellFolders}>
                      <RenameRequestContext value={renameRequests}>
                        <ItemActionsContext value={itemActions}>
                          <DocumentCardsContext value={documentCards}>
                          <PlanCardsContext value={planCards}>
                          <StepsLookupContext value={stepsLookup}>
                          <ClockBoardContext value={clockBoard}>
                          <QueueBoardContext value={queueBoard}>
                          <CrewCardBoardContext value={crewCardBoard}>
                          <SuggestionActionsContext value={suggestionActions}>
                          <LiveRotationsContext value={rotations}>
                          <SeveralSelectedContext value={severalSelected}>
                          <ConnectorActionsContext value={connectorActions}>
                          <FlowEdgeActionsContext value={flowEdgeActions}>
                          <HandoffsContext value={handoffs}>
                          <TakenJobsContext value={takenJobs}>
                          <HandingOffContext value={handingOff}>
                            <RepresentationProvider style={DEFAULT_REPRESENTATION}>
                              <ReactFlow
                              nodes={captured?.nodes ?? drawn}
                              edges={captured?.edges ?? edges}
                              edgeTypes={edgeTypes}
                              onEdgesChange={edgesChanged}
                              // A connector can join any two objects, whichever handles: the sides are the user's choice.
                              connectionMode={ConnectionMode.Loose}
                              edgesReconnectable={false}
                              onConnectStart={(event, { nodeId }) => {
                                handOffCancelled.current = false;
                                connectingFromAgent.current = nodeId !== null && tileSubject(nodeId)?.kind === 'agent';
                                setHandingOff(connectingFromAgent.current && event.altKey);
                                setConnecting(nodeId ?? undefined);
                              }}
                              connectionLineComponent={ConnectionLine}
                              onConnectEnd={connectorDropped}
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
                              onNodeMouseEnter={(_event, node) => hoverTile(node.id)}
                              onNodeMouseLeave={() => hoverTile(undefined)}
                              onEdgeMouseEnter={() => hoverTile(hoveredNow.current)}
                              onEdgeMouseLeave={() => hoverTile(undefined)}
                              onNodeClick={(event, node) => {
                                if (event.shiftKey) return;
                                if (node.selected === true && severalSelected) selectOnly(new Set([node.id]));
                                if ((event.target as HTMLElement).closest(CONTROLS) !== null) return;
                                if (isSessionTile(node)) {
                                  if (node.data.expanded === true) tileActions.expand(node.id);
                                }
                              }}
                              onNodeDrag={(event, _node, dragged) => {
                                setDropTarget(dragged.length === 1 ? dropTargetOf(dragged[0]!) : undefined);
                                const adopter = adopterOf(dragged, pointOf(event));
                                dropOver.set(adopter === undefined ? undefined : dropKey(adopter));
                              }}
                              onNodeDragStop={(event, _node, dragged) => {
                                tileMoves.onDragStop();
                                snapping.onDragStop();
                                setDropTarget(undefined);
                                dropOver.set(undefined);
                                // A shell tile dropped on an agent's tile or window becomes one of its tabs,
                                // rather than overlapping it.
                                const adopter = adopterOf(dragged, pointOf(event));
                                if (adopter !== undefined) {
                                  void moveTab({ kind: 'tab', shellId: (dragged[0] as TileNodeType).data.shell!.id, to: { owner: adopter } });
                                  return;
                                }
                                // Where it was last drawn: snapped, and under the pointer, which React Flow's own reckoning isn't.
                                for (const node of dragged.filter(isZone)) {
                                  saveLayout(node.id, layoutOf(nodesRef.current.filter(isZone).find((known) => known.id === node.id) ?? node));
                                }
                                for (const node of dragged.filter(isItemNode)) itemDropped(node);
                                for (const node of dragged.filter(isSessionTile)) tileDropped(node);
                                // A start's tile goes where it was dropped, in a zone or out of one; it has no crew or undo yet.
                                for (const node of dragged.filter(isStartTile)) {
                                  tileMoves.moveTile(node.id, node.data, placeOnBoard(absoluteOf(node), compactSizeOf(node), zoneLayouts()));
                                }
                              }}
                              // Items, connectors, sessions and zones are deleted from the keyboard, sessions and zones behind a
                              // confirmation.
                              deleteKeyCode={['Backspace', 'Delete']}
                              onBeforeDelete={onBeforeDelete}
                              onEdgesDelete={(deleted) => {
                                for (const edge of deleted.filter(isConnectorEdge)) connectorActions.remove(connectorIdOf(edge));
                                // Of a rail, the edges selected: the direction its Edge rules show.
                                for (const edge of deleted.filter(isFlowEdge)) for (const id of flowEdgeIdsOf(edge as { data?: FlowRailData }).filter((each) => flow.selected.has(each))) flow.actions.remove(id);
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
                              // button or the wheel; Shift adds to the selection, by click or by marquee, and with it held
                              // a marquee starts on anything. Box select is select mode with a zone's body falling
                              // through to the board (app.css), so a drag there draws a marquee too.
                              nodesDraggable={mode !== 'hand'}
                              elementsSelectable={mode !== 'hand'}
                              selectionOnDrag={mode !== 'hand'}
                              panOnDrag={mode === 'hand' ? true : [1]}
                              panActivationKeyCode="Space"
                              multiSelectionKeyCode="Shift"
                              selectionMode={SelectionMode.Full}
                              onNodeContextMenu={onNodeContextMenu}
                              onSelectionContextMenu={onSelectionContextMenu}
                              onPaneContextMenu={onPaneContextMenu}
                              onlyRenderVisibleElements
                              elevateNodesOnSelect={false}
                              minZoom={0.05}
                              // A capture window is framed on its zone, and keeps the user's view as it is.
                              fitView={CAPTURE_FRAME === undefined && fitOnLoad}
                              fitViewOptions={{ maxZoom: 1 }}
                              defaultViewport={CAPTURE_FRAME === undefined ? savedViewport : captureViewport(CAPTURE_FRAME)}
                              onMoveEnd={(_event, { x, y, zoom }) => {
                                boardSettled();
                                if (CAPTURE_FRAME === undefined) saveViewport({ x, y, zoom });
                              }}
                              proOptions={{ hideAttribution: true }}
                            >
                              <BoardBackdrop gap={desk.gap} size={desk.size} />
                              <ConnectorMarkers />
                              <SelectionBox onAsk={askClaude.open} />
                              <SuggestionGhosts />
                              {askClaude.popover}
                              <SnapGuides guides={snapping.guides} />
                              {tool !== undefined && (
                                <ToolOverlay
                                  tool={tool}
                                  ghostSize={{ width: AGENT_TILE_SIZE.width * getZoom(), height: AGENT_TILE_SIZE.height * getZoom() }}
                                  onUse={(from, to) => placeWithTool(tool, from, to)}
                                />
                              )}
                              {quickInsert !== undefined && (
                                <QuickInsert at={quickInsert} onPlace={(shape) => insertShape(shape, quickInsert)} onClose={() => setQuickInsert(undefined)} />
                              )}
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
                            {handOffChoice !== undefined && (
                              <HandOffChooser
                                at={handOffChoice.at}
                                payload={NEW_EDGE_LABEL}
                                onArrow={() => setHandOffChoice(undefined)}
                                onHandOff={() => handOff(handOffChoice)}
                              />
                            )}
                          </RepresentationProvider>
                          </HandingOffContext>
                          </TakenJobsContext>
                          </HandoffsContext>
                          </FlowEdgeActionsContext>
                          </ConnectorActionsContext>
                          </SeveralSelectedContext>
                          </LiveRotationsContext>
                          </SuggestionActionsContext>
                          </CrewCardBoardContext>
                          </QueueBoardContext>
                          </ClockBoardContext>
                          </StepsLookupContext>
                          </PlanCardsContext>
                          </DocumentCardsContext>
                        </ItemActionsContext>
                      </RenameRequestContext>
                      </ShellFoldersContext>
                      </NewNoteContext>
                      </ProjectSummaryContext>
                      </ShelvesContext>
                      </CrewFramesContext>
                      </AgentNoteLookContext>
                      </CrewViewContext>
                      </ConnectionCountsContext>
                      </TileMenuBoardContext>
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
      {/* A capture window draws the canvas alone (capture-mode.ts): no chrome, panel, dialog or session window over the zone. */}
      {CAPTURE_FRAME === undefined && (
        <>
          <AgentNoteMeasurer nodes={nodes} look={agentNoteLook} />
          {cheatSheet.sheet}
          <BoardChrome
            onKeyboardHelp={cheatSheet.open}
            loaded={loaded}
            empty={loaded && nodes.length === 0 && newAgent === undefined}
            loadedEmpty={loadedEmpty}
            zones={zones}
            agents={agents}
            pane={masterPanel.open ? masterPanel.side : undefined}
            onMaster={() => masterPanel.toggle('captain')}
            onNeedsYou={() => masterPanel.toggle('needs-you')}
            onSettings={openSettings}
            shells={shells}
            onOpenShell={openShell}
            onAddZone={openAddZone}
            onArrangeBoard={arrangeBoard}
            onCrewLibrary={() => boardCommands.startCrew(null, null)}
            onJump={(zone) => {
              // Where it is now: its node may have been moved or resized since the daemon sent it.
              const node = getNodes().filter(isZone).find((known) => known.id === zone.id);
              if (node === undefined) return;
              bringIntoView(layoutOf(node));
              setCurrentZone(zone.id);
            }}
            currentZone={currentZone}
            onOpenAgent={openAgent}
            onError={report}
            minimapColor={minimapColor}
            grid={grid}
            onGrid={toggleGrid}
            mode={mode}
            onMode={pickMode}
            tool={tool}
            onTool={setTool}
            ghostSize={{ width: AGENT_TILE_SIZE.width * getZoom(), height: AGENT_TILE_SIZE.height * getZoom() }}
            onDropTool={dropTool}
            onSticky={() => createItem('sticky', boardCentre())}
            onSteps={() => createItem('steps', boardCentre())}
            onMemory={() => createItem('memory', boardCentre())}
            onQueue={() => createItem('queue', boardCentre())}
            onRunInShell={startLooseShell}
            onCloseWindow={closeWindow}
          />
          {loaded && masterPanel.open && (
            <MasterPanel
              agents={agents}
              zones={zones}
              items={boardItems}
              side={masterPanel.side}
              focusRequest={masterPanel.focusRequest}
              onClose={masterPanel.close}
              onSettings={openSettings}
              onShowAgent={(sessionId) => boardCommands.showTile({ kind: 'agent', id: sessionId })}
              onShowZone={(zoneId) => boardCommands.showZone(zoneId)}
              onOpenAgent={openAgent}
              onOpenPlan={(agent) => tileActions.openPlan(agent)}
              onOpenLink={(url) => void window.agentBoard.trackers.openLink(url).catch(report('open the link'))}
            />
          )}
          <QueueFocusHost queues={queues} board={queueBoard} onError={(message) => setNotice({ message })} />
          <HandOnHost queues={queues} board={queueBoard} onError={(message) => setNotice({ message })} />
          <DrainSheetHost queues={queues} zones={zones} onSave={(id, drain) => itemActions.update({ id, data: { drain: { ...drain } } })} />
          {/* Only while both its agents are on the board: one deleted takes the edge, which may not have been heard yet. */}
          {shownFlowEdge !== undefined && shownEnds?.from !== undefined && shownEnds.to !== undefined && (
            <EdgeRules
              key={shownFlowEdge.id}
              edge={shownFlowEdge}
              fromName={shownEnds.from.name}
              toName={shownEnds.to.name}
              madeByName={agents.find((agent) => agent.sessionId === shownFlowEdge.madeBy)?.name}
              fromRevision={shownEnds.from.lastMessage}
              drawn={flow.drawn === shownFlowEdge.id}
              live={flow.live.has(shownFlowEdge.id)}
              directions={shownDirections}
              actions={flow.actions}
              onDelete={() => flow.actions.remove(shownFlowEdge.id)}
              onClose={() => setSelectedFlowEdges(new Set())}
            />
          )}
          {/* Over the board, or in the session window shown over it, whose title bar it would otherwise cover. */}
          {loaded && shownWindow(windows) === undefined && restartBanner}
          {newAgent !== undefined && (
            <NewAgentDialog
              key={newAgent.zone?.id ?? 'loose'}
              zone={newAgent.zone}
              agents={agents}
              issue={newAgent.issue}
              issueZoneId={newAgent.issueZoneId}
              name={newAgent.name}
              position={newAgent.position}
              onStarted={(sessionId, fromIssue) => {
                const zone = newAgent.zone;
                // Started from an issue picked for it: its card goes in first, so the tile's slot is clear of it (R1).
                if (newAgent.card !== undefined && zone !== undefined) placeIssueCard(zone, newAgent.card);
                // Started from an issue another way (the dialog's own picker): its card goes in once its agent is.
                else if (fromIssue && zone !== undefined && newAgent.issue === undefined) issueCardsDue.current.set(sessionId, zone);
                setNewAgent(undefined);
              }}
              onCancel={() => setNewAgent(undefined)}
              onCrew={(prefab) => {
                setCrewFlow({ kind: 'prompt', prefab, zone: newAgent.zone, suggested: newAgent.position && zoneNearest(newAgent.position), fromSheet: { position: newAgent.position } });
                setNewAgent(undefined);
              }}
              onCrewLibrary={() => {
                setCrewFlow({ kind: 'library', zone: newAgent.zone, suggested: newAgent.position && zoneNearest(newAgent.position), fromSheet: { position: newAgent.position } });
                setNewAgent(undefined);
              }}
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
                agentHeard(agent);
                setLinking(undefined);
              }}
              onCancel={() => setLinking(undefined)}
            />
          )}
          {roleTemplatesZone !== undefined && (
            <RoleTemplatesDialog key={roleTemplatesZone.id} zone={roleTemplatesZone} onClose={() => setRoleTemplatesZone(undefined)} />
          )}
          {crewFlow !== undefined && (
            <CrewFlow
              key={`${crewFlow.kind}:${crewFlow.kind === 'prompt' ? crewFlow.prefab.name : ''}:${crewFlow.zone?.id ?? ''}:${crewFlow.suggested?.id ?? ''}`}
              start={crewFlow}
              zones={nodes.filter(isZone).map((node) => node.data.zone).filter((zone) => zone.clone === null)}
              onStarted={(sessionId) => {
                setCrewFlow(undefined);
                setCrewStarted(sessionId);
              }}
              onClose={() => {
                // Back to the sheet it was picked in.
                if (crewFlow.fromSheet !== undefined) setNewAgent({ zone: crewFlow.zone, position: crewFlow.fromSheet.position });
                setCrewFlow(undefined);
              }}
              onAddZone={() => {
                setCrewFlow(undefined);
                openAddZone();
              }}
            />
          )}
          {gateCommandZone !== undefined && (
            <GateCommandDialog
              key={gateCommandZone.id}
              zone={gateCommandZone}
              onSaved={(saved) => {
                setGateCommandZone(undefined);
                setNodes((current) => withZone(current, saved));
              }}
              onCancel={() => setGateCommandZone(undefined)}
            />
          )}
          {clockEditing !== undefined && (
            <ClockDialog
              key={'clockId' in clockEditing ? clockEditing.clockId : clockEditing.agent.sessionId}
              editing={clockEditing}
              status={'clockId' in clockEditing ? clockStatuses.get(clockEditing.clockId) : undefined}
              agents={agents}
              onUpdate={(id, data) => itemActions.update({ id, data: { ...data } })}
              onDelete={(id) => itemActions.remove(id)}
              onClose={() => setClockEditing(undefined)}
            />
          )}
          <TileActionsContext value={tileActions}>
            <ClickOpensContext value={clickOpens}>
              <TileMenuBoardContext value={tileBoard}>{menu}</TileMenuBoardContext>
            </ClickOpensContext>
          </TileActionsContext>
          {pendingDelete !== undefined && (
            <Dialog
              role="alertdialog"
              title={pendingDelete.title}
              onClose={settleDelete}
              footer={
                <>
                  <Button variant="ghost" onClick={settleDelete}>
                    Cancel
                  </Button>
                  {pendingDelete.keepLabel !== undefined && (
                    <Button
                      variant="secondary"
                      disabled={cloneTicked}
                      title={cloneTicked ? 'A clone can only be deleted with the worktrees it holds' : undefined}
                      onClick={() => {
                        const deleteClone = cloneTicked;
                        settleDelete();
                        pendingDelete.run(true, deleteClone);
                      }}
                    >
                      {pendingDelete.keepLabel}
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    onClick={() => {
                      const deleteClone = cloneTicked;
                      settleDelete();
                      pendingDelete.run(false, deleteClone);
                    }}
                  >
                    {pendingDelete.confirm}
                  </Button>
                </>
              }
            >
              {pendingDelete.lines.map((line, index) => (
                // Lines may repeat (two shells of one name), and the list is fixed for the dialog.
                <p key={index}>{line}</p>
              ))}
              {pendingDelete.cloneLabel !== undefined && (
                <Checkbox label={pendingDelete.cloneLabel} checked={cloneTicked} onChange={(event) => setCloneTicked(event.target.checked)} />
              )}
            </Dialog>
          )}
          {resumingExternal !== undefined && (
            <ResumeExternalDialog
              key={resumingExternal.session.id}
              session={resumingExternal.session}
              position={resumingExternal.position}
              onResumed={(agent) => {
                const nodeId = tileNodeId('external', resumingExternal.session.id);
                externalGone(resumingExternal.session.id);
                collapse(nodeId);
                agentHeard(agent);
                setResumingExternal(undefined);
              }}
              onClose={() => setResumingExternal(undefined)}
            />
          )}
          {confirmingStart !== undefined && (
            <Dialog
              role="alertdialog"
              aria-label="Codex config in this repo"
              title="This repo has its own Codex config"
              onClose={() => setConfirmingStart(undefined)}
              footer={
                <>
                  <Button variant="ghost" onClick={() => setConfirmingStart(undefined)}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => {
                      setConfirmingStart(undefined);
                      window.agentBoard.agents.retryStart(confirmingStart.sessionId, true).catch(report('start the agent'));
                    }}
                  >
                    Start anyway
                  </Button>
                </>
              }
            >
              <p>{confirmingStart.error}</p>
            </Dialog>
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
              opensMaximised={clickOpens === 'maximised'}
            />
          </TileActionsContext>
        </>
      )}
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


/** How long the view must be still before where it is gets saved. */
const SAVE_VIEWPORT_DELAY_MS = 300;

