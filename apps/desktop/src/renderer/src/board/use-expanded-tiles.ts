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
  windowedExpanded,
  withoutOverlaps,
  type ExpandedSizes,
  type ExpandedTiles,
  type OverlapsAllowed,
} from './expanded';
import { keepTileSizes, withTileSize, type TileSize, type TileSizes } from './tile-size';
import { keepUnfolded, withUnfolded, type Unfolded } from './fold';
import { forgetTicketsShown } from './ticket-shown';
import { drawsAsTicket, heldInCard, tileNodeId, type BoardNode } from './tiles';
import { keepTicketViews, liveWhileOpen, restingOver, restsInTerminal, shownTicketViews, ticketOver, ticketsLeavingTerminal, ticketViewOf, withTicketTerminals, withTicketView, type TicketView, type TicketViews } from './ticket-view';
import { useViewSettings, useViewSettingsLoaded } from './view-settings';
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
  /** Whether the saved session windows have been taken back. */
  windowsRestored: boolean;
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
export function useExpandedTiles({ nodes, loaded, agents, shells, externals, windows, windowsRestored, relayout, crews }: ExpandedTilesOptions) {
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
  /** The tiles that were expanded when their session window opened, to be expanded again when it closes (saved with the view). */
  const [hidden, setHidden] = useState<ExpandedTiles>([]);
  /** Which tile the user dragged onto which, one of the two expanded: the two may overlap. */
  const [overlapsAllowed, setOverlapsAllowed] = useState<OverlapsAllowed>(new Map());
  /** The ticket tiles switched by hand to the card, the terminal or the board: the rest show as Settings says. */
  const [ticketViews, setTicketViews] = useState<TicketViews>({});
  const ticketViewsRef = useRef(ticketViews);
  ticketViewsRef.current = ticketViews;
  const openAs = useViewSettings().ticketTilesOpenAs;
  const openAsRef = useRef(openAs);
  openAsRef.current = openAs;
  const settingsLoaded = useViewSettingsLoaded();
  /** The node ids of the ticket chats drawn as their ticket's tile, and of those whose ticket is over (`ticketOver`). */
  const { tickets, over: overNow } = useMemo(() => ticketTiles(agents), [agents]);
  /** The open ticket tiles that opened while their ticket was live (`liveWhileOpen`): they keep their view until closed. */
  const liveOpenRef = useRef<ReadonlySet<string>>(new Set());
  const liveOpen = useMemo(() => {
    const open = [...expanded, ...hidden].map((entry) => entry.id);
    liveOpenRef.current = liveWhileOpen(liveOpenRef.current, open, overNow);
    return liveOpenRef.current;
  }, [expanded, hidden, overNow]);
  /** The over tickets that rest as their card: all but those still open since they were live. */
  const over = useMemo(() => restingOver(overNow, liveOpen), [overNow, liveOpen]);
  /** The views the tiles show: the switched ones, and the card for each over ticket resting. */
  const ticketViewsShown = useMemo(() => shownTicketViews(ticketViews, over), [ticketViews, over]);
  const ticketsRef = useRef(tickets);
  ticketsRef.current = tickets;
  const overRef = useRef(over);
  overRef.current = over;
  /** Whether the tile is a ticket tile in the terminal view now. */
  const inTerminal = (nodeId: string) => restsInTerminal(ticketsRef.current, overRef.current, ticketViewsRef.current, openAsRef.current, nodeId);
  const inTerminalRef = useRef(inTerminal);
  inTerminalRef.current = inTerminal;
  /**
   * The nodes as drawn: the expanded tiles kept apart and what they would cover moved clear of them until they collapse
   *, a crew as one, never saved.
   */
  const shown = useDisplaced(nodes, expanded, overlapsAllowed, crews, tileSizes);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  /** Puts back the expanded tiles and sizes saved with the view, in the render that shows the board's lists. */
  const restoreExpanded = useCallback((view: SavedView) => {
    setExpanded(view.expanded);
    setHidden(view.hiddenExpanded);
    setExpandedSizes(view.expandedSizes);
    setTileSizes(view.tileSizes);
    setUnfolded(view.unfolded);
    setOverlapsAllowed(view.overlapsAllowed);
    setTicketViews(view.ticketViews);
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
      /**
       * Collapses the tile; not a ticket tile in the terminal view, which rests open (`restsInTerminal`): only the user's
       * own way back, `setTicketView`, puts that back to its card.
       */
      collapse(nodeId: string) {
        if (inTerminalRef.current(nodeId)) return;
        setExpanded((current) => collapseTile(current, nodeId));
      },
      /** Collapses the expanded tile in front, if any, from the user's Esc: a ticket tile in the terminal view is switched to its card, and stays one. */
      collapseFrontTile() {
        const front = expandedRef.current.at(-1)?.id;
        if (front !== undefined && inTerminalRef.current(front)) setTicketViews((current) => withTicketView(current, front, 'card'));
        setExpanded(collapseFront);
      },
      /**
       * Switches a ticket tile to the card, the terminal or the board, and it keeps that view: the terminal expands it in
       * place; the card, and the board (which rests as the card), collapse it to the card at rest.
       */
      setTicketView(nodeId: string, view: TicketView) {
        setTicketViews((current) => withTicketView(current, nodeId, view));
        if (view !== 'terminal') setExpanded((current) => collapseTile(current, nodeId));
        else {
          setExpanded((current) => expandTile(current, nodeId, expandedSizesRef.current));
          setOverlapsAllowed((current) => withoutOverlaps(current, [nodeId]));
        }
      },
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
    const present = presentTiles(agents, shells, externals);
    setExpanded((current) => keepExpanded(current, present));
    setExpandedSizes((current) => keepSizes(current, present));
    setTileSizes((current) => keepTileSizes(current, present));
    setOverlapsAllowed((current) => keepOverlaps(current, present));
    setUnfolded((current) => keepUnfolded(current, agents));
    setTicketViews((current) => keepTicketViews(current, present));
  }, [loaded, agents, shells, externals]);
  // A ticket tile in the terminal view is expanded in place, its terminal drawn by the expanded tile; not while its
  // session window has it, nor before the setting that says which view it opens in is read.
  useEffect(() => {
    if (!loaded || !settingsLoaded || !windowsRestored) return;
    const terminals = tickets.filter((id) => ticketViewOf(ticketViews, id, openAs, over.has(id)) === 'terminal');
    const windowed = new Set([...windows.map((entry) => tileNodeId(entry.kind === 'shell' ? 'shell' : 'agent', entry.id)), ...hidden.map((entry) => entry.id)]);
    const opening = terminals.filter((id) => !windowed.has(id) && !expandedRef.current.some((entry) => entry.id === id));
    if (opening.length === 0) return;
    setExpanded((current) => withTicketTerminals(current, terminals, windowed, expandedSizesRef.current));
    // Opened as `expand` opens a tile: it makes room for itself again.
    setOverlapsAllowed((current) => withoutOverlaps(current, opening));
  }, [loaded, settingsLoaded, windowsRestored, tickets, over, ticketViews, openAs, windows, hidden]);
  // The default turned from Terminal to Card or Board: the ticket tiles not switched by hand go back to their card.
  // Not the saved setting being read, which is no change.
  const openAsBefore = useRef<typeof openAs | undefined>(undefined);
  useEffect(() => {
    if (!settingsLoaded) return;
    const before = openAsBefore.current;
    openAsBefore.current = openAs;
    const leaving = before === undefined ? [] : ticketsLeavingTerminal(ticketsRef.current, overRef.current, ticketViewsRef.current, before, openAs);
    if (leaving.length > 0) setExpanded((current) => leaving.reduce(collapseTile, current));
  }, [settingsLoaded, openAs]);
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
  const saveHidden = useMemo(() => viewSaver((value) => window.agentBoard.view.set(VIEW_KEYS.hiddenExpanded, value), SAVE_EXPANDED_DELAY_MS), []);
  useEffect(() => {
    if (loaded) saveHidden(hidden);
  }, [loaded, hidden, saveHidden]);
  const saveTicketViews = useMemo(() => viewSaver((value) => window.agentBoard.view.set(VIEW_KEYS.ticketViews, value), SAVE_EXPANDED_DELAY_MS), []);
  useEffect(() => {
    if (loaded) saveTicketViews(ticketViews);
  }, [loaded, ticketViews, saveTicketViews]);
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
    if (collapsed.length === 0) return;
    setOverlapsAllowed((current) => withoutOverlaps(current, collapsed));
    // A ticket tile collapsed, or gone, opens on its chat again.
    forgetTicketsShown(collapsed);
  }, [expanded]);
  // A session shown in its session window, on the board or popped out, is not also expanded: one terminal sizes it. It
  // is expanded again, at that size, once its window is closed; docked, it stays compact.
  useEffect(() => {
    // Once the saved windows are back, else a tile whose window is still on its way would look closed.
    if (!loaded || !windowsRestored || shells === undefined) return;
    const present = presentTiles(agents, shells, externals);
    const idOf = (entry: SessionWindows[number]) => tileNodeId(entry.kind === 'shell' ? 'shell' : 'agent', entry.id);
    const windowed = {
      open: new Set(windows.filter((entry) => entry.placement !== 'docked').map(idOf)),
      all: new Set(windows.map(idOf)),
    };
    const next = windowedExpanded(expanded, hidden, windowed, present);
    if (next.hidden !== hidden) setHidden(next.hidden);
    if (next.expanded !== expanded) setExpanded(next.expanded);
  }, [loaded, windowsRestored, windows, expanded, hidden, agents, shells, externals]);

  return { shown, shownRef, expandedRef, tileSizesRef, unfoldedRef, restoreExpanded, ticketViewsShown, ...actions };
}

/** The node ids of the session tiles on the board. */
function presentTiles(agents: Agent[], shells: Shell[], externals: ExternalSession[]): Set<string> {
  return new Set([
    ...agents.map((agent) => tileNodeId('agent', agent.sessionId)),
    ...shells.map((shell) => tileNodeId('shell', shell.id)),
    ...externals.map((session) => tileNodeId('external', session.id)),
  ]);
}

/** The ticket chats drawn as their ticket's tile, by node id, and those whose ticket is over: helpers counted as its card holds them. */
function ticketTiles(agents: readonly Agent[]): { tickets: string[]; over: ReadonlySet<string> } {
  const chats = agents.filter((agent) => agent.ticketChat && drawsAsTicket(agent));
  const held = agents.filter((agent) => agent.ticket !== null && heldInCard(agent, agents));
  const over = chats.filter((chat) => ticketOver(chat, held.filter((helper) => helper.ticket === chat.sessionId)));
  return { tickets: chats.map((chat) => tileNodeId('agent', chat.sessionId)), over: new Set(over.map((chat) => tileNodeId('agent', chat.sessionId))) };
}

/** How long the expanded tiles must stay as they are before they are saved. */
const SAVE_EXPANDED_DELAY_MS = 200;
