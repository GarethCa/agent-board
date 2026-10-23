import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Viewport } from '@xyflow/react';
import type { Agent, Connector, ExternalSession, Shell } from '@agent-board/daemon/protocol';
import type { ConnectorChange, ItemChange, ShellChange, ZoneChange } from '../../../preload/api';
import { VIEW_KEYS } from '../../../shared/view-saver';
import { useToast } from '../ui';
import { changeBacklog } from './change-backlog';
import { clickOpensFrom, type ClickOpens } from './click-opens';
import { withConnectorChange } from './connectors/endpoints';
import { connectionsViewFrom, type ConnectionsView } from './connections-view';
import { agentNoteLookFrom, type AgentNoteLook } from './items/agent-note-look';
import { crewLookFrom, type CrewLook } from './crew-view';
import { expandedFrom, overlapsFrom, sizesFrom, type ExpandedSizes, type ExpandedTiles, type OverlapsAllowed } from './expanded';
import { withItem, withItemChange } from './items/items';
import { placeholderCount, placeholderStickies, placeholderTiles } from './placeholders';
import { withSavedPlace, type Place } from './saved-place';
import { tileSizesFrom, type TileSizes } from './tile-size';
import { unfoldedFrom, type Unfolded } from './fold';
import type { BoardNode } from './tiles';
import { withoutZone, withZone } from './zone-nodes';
import { zoneNode } from './ZoneNode';

/** How many times the board lists agents again when changes keep landing while the list is in flight. */
const MAX_AGENT_LIST_ATTEMPTS = 5;

/** `items` with `item` added, or replacing the one with the same key. */
function upsertBy<T>(items: T[], item: T, key: (item: T) => string): T[] {
  const index = items.findIndex((known) => key(known) === key(item));
  return index < 0 ? [...items, item] : items.with(index, item);
}

const upsertAgent = (agents: Agent[], agent: Agent) => upsertBy(agents, agent, (known) => known.sessionId);
/** `shells` with a heard change applied. */
const applyShellChange = (shells: Shell[], change: ShellChange) =>
  change.type === 'shell.updated' ? upsertBy(shells, change.shell, (known) => known.id) : shells.filter((shell) => shell.id !== change.shellId);
const upsertExternal = (externals: ExternalSession[], session: ExternalSession) =>
  upsertBy(externals, session, (known) => known.id);

/** The view state the board opens with, read with its lists. */
export interface SavedView {
  expanded: ExpandedTiles;
  /** The tiles expanded before their session window opened: expanded again when it closes. */
  hiddenExpanded: ExpandedTiles;
  expandedSizes: ExpandedSizes;
  tileSizes: TileSizes;
  unfolded: Unfolded;
  overlapsAllowed: OverlapsAllowed;
  clickOpens: ClickOpens;
  crewLook: CrewLook;
  connections: ConnectionsView;
  agentNoteLook: AgentNoteLook;
}

interface BoardDataOptions {
  setNodes: Dispatch<SetStateAction<BoardNode[]>>;
  /** Shows why `action` failed; `retry` tries it again. */
  report(action: string, retry?: () => void): (error: unknown) => void;
  /** Takes the board's notice down, given undefined. */
  setNotice(notice?: { message: string; retry?: () => void }): void;
  /** Hears each shell change as it comes, after the board's shells have taken it. */
  onShellChange(change: ShellChange): void;
  /** Puts back the view state read with the board: its setters run in the same render as the lists'. */
  restoreView(view: SavedView): void;
}

/**
 * What the board shows, from the daemon: its zones and items (into the nodes), agents, shells, external sessions and
 * connectors, listed once and kept current by their changes, with the view state saved beside them. Each list is
 * subscribed to before it is listed, and a change that crosses a list in flight is applied over it (S3).
 */
export function useBoardData({ setNodes, report, setNotice, onShellChange, restoreView }: BoardDataOptions) {
  const toasts = useToast();
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
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [externals, setExternals] = useState<ExternalSession[]>([]);
  /** Undefined until listed. */
  const [shells, setShells] = useState<Shell[]>();
  /** The agents as last rendered, for callbacks that must not re-create on every change. */
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const connectorsRef = useRef(connectors);
  connectorsRef.current = connectors;
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
  /** Shell changes heard while the list is in flight, to replay over it; kept only while a list is. */
  const shellBacklog = useRef(changeBacklog<ShellChange>({ keeping: false })).current;

  // Subscribed before the first load. A change can still cross the list in flight and be older or newer than it, so
  // the load lists again until no change lands meanwhile.
  useEffect(
    () =>
      window.agentBoard.agents.onChanged((change) => {
        agentChanged.current = true;
        if (change.type === 'agent.updated') setAgents((current) => upsertAgent(current, change.agent));
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
        onShellChange(change);
      }),
    [onShellChange],
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
      // A view that can't be read opens the board fitted.
      Promise.all([
        window.agentBoard.view.get(VIEW_KEYS.viewport),
        window.agentBoard.view.get(VIEW_KEYS.expanded),
        window.agentBoard.view.get(VIEW_KEYS.clickOpens),
        window.agentBoard.view.get(VIEW_KEYS.crewLook),
        window.agentBoard.view.get(VIEW_KEYS.expandedSizes),
        window.agentBoard.view.get(VIEW_KEYS.expandedOverlaps),
        window.agentBoard.view.get(VIEW_KEYS.tileSizes),
        window.agentBoard.view.get(VIEW_KEYS.connections),
        window.agentBoard.view.get(VIEW_KEYS.agentNoteLook),
        window.agentBoard.view.get(VIEW_KEYS.unfolded),
        window.agentBoard.view.get(VIEW_KEYS.hiddenExpanded),
      ]).catch(() => [null, null, null, null, null, null, null, null, null, null, null] as const),
    ]).then(
      ([zones, loadedAgents, loadedExternals, items, listedShells, listedConnectors, [viewport, savedExpanded, savedClickOpens, savedCrewLook, savedSizes, savedOverlaps, savedTileSizes, savedConnections, savedAgentNoteLook, savedUnfolded, savedHidden]]) => {
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
        restoreView({
          expanded: expandedFrom(savedExpanded),
          hiddenExpanded: expandedFrom(savedHidden),
          expandedSizes: sizesFrom(savedSizes),
          tileSizes: tileSizesFrom(savedTileSizes),
          unfolded: unfoldedFrom(savedUnfolded),
          overlapsAllowed: overlapsFrom(savedOverlaps),
          clickOpens: clickOpensFrom(savedClickOpens),
          crewLook: crewLookFrom(savedCrewLook),
          connections: connectionsViewFrom(savedConnections),
          agentNoteLook: agentNoteLookFrom(savedAgentNoteLook),
        });
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

  /** What the board heard of its agents, shells and external sessions other than by their changes: a call's answer. */
  const heard = useMemo(
    () => ({
      /** Takes in an agent as a call returned it, before its event arrives. */
      agentHeard: (agent: Agent) => setAgents((current) => upsertAgent(current, agent)),
      /** Drops a deleted agent before its event arrives. */
      agentGone: (sessionId: string) => setAgents((current) => current.filter((agent) => agent.sessionId !== sessionId)),
      /** Takes in the place an agent's move was saved at (`withSavedPlace`): `asked` is the agent as the move was asked. */
      agentPlaced: (asked: Agent, saved: Place) =>
        setAgents((current) => current.map((agent) => (agent.sessionId === asked.sessionId ? withSavedPlace(agent, asked, saved) : agent))),
      /** Takes in a shell as a call returned it, before its event arrives: the first, if the shells aren't listed yet. */
      shellHeard: (shell: Shell) => setShells((current) => applyShellChange(current ?? [], { type: 'shell.updated', shell })),
      /** Takes in shells as a call returned them, before their events arrive: the first of the list, if it isn't listed yet. */
      shellsHeard: (taken: readonly Shell[]) =>
        setShells((current) => taken.reduce((all, shell) => applyShellChange(all, { type: 'shell.updated', shell }), current ?? [])),
      /** Takes in the place a shell's move was saved at, as `agentPlaced` does. */
      shellPlaced: (asked: Shell, saved: Place) =>
        setShells((current) => current?.map((shell) => (shell.id === asked.id ? withSavedPlace(shell, asked, saved) : shell))),
      /** Drops an external session the board no longer shows, before its event arrives. */
      externalGone: (id: string) => setExternals((current) => current.filter((session) => session.id !== id)),
      /** Takes in the place an external session's move was saved at, as `agentPlaced` does. */
      externalPlaced: (asked: ExternalSession, saved: Place) =>
        setExternals((current) => current.map((session) => (session.id === asked.id ? withSavedPlace(session, asked, saved) : session))),
    }),
    [],
  );

  return {
    loaded,
    fitOnLoad,
    loadedEmpty,
    savedViewport,
    agents,
    agentsRef,
    externals,
    externalsRef,
    shells,
    shellsRef,
    ...heard,
    connectors,
    setConnectors,
    connectorsRef,
    reloadExternals,
    clonesWatched,
  };
}

/** `nodes` with a zone change from the daemon applied. */
function withZoneChange(nodes: BoardNode[], change: ZoneChange): BoardNode[] {
  return change.type === 'zone.updated' ? withZone(nodes, change.zone) : withoutZone(nodes, change.id);
}

/** A saved viewport, if `value` is one. */
function viewportFrom(value: unknown): Viewport | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { x, y, zoom } = value as Record<string, unknown>;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  return finite(x) && finite(y) && finite(zoom) && zoom > 0 ? { x, y, zoom } : undefined;
}
