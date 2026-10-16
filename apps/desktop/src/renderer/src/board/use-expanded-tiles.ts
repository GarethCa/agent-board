import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, ExternalSession, Shell } from '@agent-board/daemon/protocol';
import { VIEW_KEYS, viewSaver } from '../../../shared/view-saver';
import type { SessionWindows } from '../windows/session-windows';
import {
  allowingOverlap,
  bringToFront,
  collapsedBetween,
  collapseFront,
  collapseTile,
  expandTile,
  keepExpanded,
  keepOverlaps,
  keepSizes,
  rememberSize,
  resizeExpanded,
  withoutOverlaps,
  type ExpandedSizes,
  type ExpandedTiles,
  type OverlapsAllowed,
} from './expanded';
import { keepTileSizes, withTileSize, type TileSize, type TileSizes } from './tile-size';
import { keepUnfolded, withUnfolded, type Unfolded } from './fold';
import { tileNodeId, type BoardNode } from './tiles';
import type { SavedView } from './use-board-data';
import { useDisplaced } from './use-displaced';

interface ExpandedTilesOptions {
  nodes: BoardNode[];
  loaded: boolean;
  agents: Agent[];
  /** Undefined until listed. */
  shells: Shell[] | undefined;
  externals: ExternalSession[];
  /** The session windows: a session shown in one is not also expanded. */
  windows: SessionWindows;
  /** Lays the session tiles out again, with the expanded ones and the tile sizes as they are now. */
  relayout(): void;
  /** The tiles of each crew frame, by node id: an expanded tile pushes each crew aside as one. */
  crews: readonly (readonly string[])[];
}

/**
 * The tiles expanded in place and the sizes of compact tiles: which are open, back to front, how big
 * each is, and which two may overlap. Saved with the view as they change and laid out again; an expanded tile
 * collapses when its session goes or shows in its session window. Returns the nodes as drawn with them open.
 */
export function useExpandedTiles({ nodes, loaded, agents, shells, externals, windows, relayout, crews }: ExpandedTilesOptions) {
  /**
   * The tiles expanded in place, back to front, with their sizes: the one place the board keeps
   * which are open.
   */
  const [expanded, setExpanded] = useState<ExpandedTiles>([]);
  /** The size each tile was last let go at once resized while expanded: it opens at that size again. */
  const [expandedSizes, setExpandedSizes] = useState<ExpandedSizes>({});
  const expandedSizesRef = useRef(expandedSizes);
  expandedSizesRef.current = expandedSizes;
  /** The size each compact tile was resized to, by node id: saved with the view, so it is the same after a restart. */
  const [tileSizes, setTileSizes] = useState<TileSizes>({});
  const tileSizesRef = useRef(tileSizes);
  tileSizesRef.current = tileSizes;
  /** The closed agents the user unfolded from their chips: the other closed agents are drawn as chips. */
  const [unfolded, setUnfolded] = useState<Unfolded>([]);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const unfoldedRef = useRef(unfolded);
  unfoldedRef.current = unfolded;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  /** Which tile the user dragged onto which, one of the two expanded: the two may overlap. */
  const [overlapsAllowed, setOverlapsAllowed] = useState<OverlapsAllowed>(new Map());
  /**
   * The nodes as drawn: the expanded tiles kept apart and what they would cover moved clear of them until they collapse
   *, a crew as one, never saved.
   */
  const shown = useDisplaced(nodes, expanded, overlapsAllowed, crews);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  /** Puts back the expanded tiles and sizes saved with the view, in the render that shows the board's lists. */
  const restoreExpanded = useCallback((view: SavedView) => {
    setExpanded(view.expanded);
    setExpandedSizes(view.expandedSizes);
    setTileSizes(view.tileSizes);
    setUnfolded(view.unfolded);
    setOverlapsAllowed(view.overlapsAllowed);
  }, []);

  /** What the board does to its expanded tiles and tile sizes. */
  const actions = useMemo(
    () => ({
      /** Expands the tile at its last size, in front; opened, it makes room for itself, wherever it was dragged. */
      expand(nodeId: string) {
        setExpanded((current) => expandTile(current, nodeId, expandedSizesRef.current));
        setOverlapsAllowed((current) => withoutOverlaps(current, [nodeId]));
      },
      bringTileToFront: (nodeId: string) => setExpanded((current) => bringToFront(current, nodeId)),
      collapse: (nodeId: string) => setExpanded((current) => collapseTile(current, nodeId)),
      /** Collapses the expanded tile in front, if any. */
      collapseFrontTile: () => setExpanded(collapseFront),
      /** Resizes the expanded tile, and remembers the size it opens at again. */
      resizeExpandedTile(nodeId: string, size: TileSize) {
        setExpanded((current) => resizeExpanded(current, nodeId, size));
        setExpandedSizes((current) => rememberSize(current, nodeId, size));
      },
      /** Sets the compact tile's size, or puts it back to the default for undefined. */
      sizeTile: (nodeId: string, size: TileSize | undefined) => setTileSizes((current) => withTileSize(current, nodeId, size)),
      /** Unfolds a closed agent's chip to its tile, or folds it back to its chip. */
      setUnfolded: (nodeId: string, open: boolean) => setUnfolded((current) => withUnfolded(current, nodeId, open, agentsRef.current)),
      /** Lets the two tiles overlap, `nodeId` dropped onto `onto`, one of them expanded; any pair `nodeId` was in ends. */
      allowOverlap: (nodeId: string, onto: string | undefined) => setOverlapsAllowed((current) => allowingOverlap(current, nodeId, onto)),
      /** Ends the pairs the tiles are in: they make room again. */
      freeOverlaps: (nodeIds: readonly string[]) => setOverlapsAllowed((current) => withoutOverlaps(current, nodeIds)),
    }),
    [],
  );

  // A tile expanded, collapsed, brought to the front or resized is laid out again.
  useEffect(() => {
    if (loaded) relayout();
  }, [loaded, expanded, tileSizes, unfolded, relayout]);
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
    setTileSizes((current) => keepTileSizes(current, present));
    setOverlapsAllowed((current) => keepOverlaps(current, present));
    setUnfolded((current) => keepUnfolded(current, agents));
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
  const saveTileSizes = useMemo(() => viewSaver((value) => window.agentBoard.view.set(VIEW_KEYS.tileSizes, value), SAVE_EXPANDED_DELAY_MS), []);
  useEffect(() => {
    if (loaded) saveTileSizes(tileSizes);
  }, [loaded, tileSizes, saveTileSizes]);
  const saveUnfolded = useMemo(() => viewSaver((value) => window.agentBoard.view.set(VIEW_KEYS.unfolded, value), SAVE_EXPANDED_DELAY_MS), []);
  useEffect(() => {
    if (loaded) saveUnfolded(unfolded);
  }, [loaded, unfolded, saveUnfolded]);
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

  return { shown, shownRef, expandedRef, tileSizesRef, unfoldedRef, restoreExpanded, ...actions };
}

/** How long the expanded tiles must stay as they are before they are saved. */
const SAVE_EXPANDED_DELAY_MS = 200;
