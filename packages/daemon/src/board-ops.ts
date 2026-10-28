// The board as the agent-facing CLI and MCP see it (ADR-0010): one module both call, over the daemon methods the app
// uses (plus `board.identify` and `board.setStatus`). Refs, resolving them, and each view as text and as JSON.
import { cronWords } from './cron.ts';
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { BOARD_DATA_DIR_ENV, BOARD_SOCKET_ENV, BOARD_TOKEN_ENV } from './board-env.ts';
import type { AskSpec, PlanSpec } from './asks.ts';
import { connectDaemon, DaemonRpcError, type DaemonClient } from './client.ts';
import { shortCommit } from './gate-rules.ts';
import { daemonPaths, defaultDataDir } from './paths.ts';
import {
  BOARD_ERROR,
  DEFAULT_ASK_WAIT_MS,
  type Agent,
  type AgentRecord,
  type SentToOrchestrator,
  type PlanFormat,
  type PinRef,
  type RecordParams,
  roleLabel,
  type BoardCaller,
  type CrewEvent,
  type CrewEventKind,
  type Harness,
  type OrchestrateScope,
  type OrchestratorActivity,
  orchestrateScopeWords,
  type AgentNoteData,
  type BoardItem,
  type Connector,
  type ConnectorEnd,
  FLOW_CONDITION_KINDS,
  type FlowCondition,
  type FlowEdge,
  FLOW_EDGE_TRIGGERS,
  type FlowEdgePayload,
  type FlowEdgeTrigger,
  type HandoffPayload,
  relationOf,
  SECTIONED_SHAPES,
  SHAPE_SECTIONS,
  type ShapeType,
  type Shell,
  statusLine,
  type WaitState,
  type Zone,
} from './protocol.ts';
import { cutText } from './text-cut.ts';
import { minutes, planDecisionText } from './plan-told.ts';

/** A failure to show the user as it is: a bad ref, no daemon, an unknown token. */
export class BoardError extends Error {}

/** A connection to the daemon, and who is calling: the session holding the env's board token, or null outside one. */
export interface BoardSession {
  client: DaemonClient;
  socketPath: string;
  caller: BoardCaller | null;
  /** The env's board token, which `board.*` calls carry. */
  token: string | undefined;
  close(): void;
}

/**
 * Under a test (`VITEST` set, which every child of a test inherits), throws `BoardError` for the app's own daemon, the
 * live board: a test that reached it would act on the user's own agents. Its socket comes from the
 * real home dir, not `$HOME`, which test helpers swap.
 */
export function refuseLiveDaemon(
  socketPath: string,
  processEnv: NodeJS.ProcessEnv = process.env,
  liveSocket: string = daemonPaths(defaultDataDir({ HOME: userInfo().homedir })).socket,
): void {
  if (processEnv.VITEST && socketPath === liveSocket) {
    throw new BoardError(
      `refusing the app's own daemon at ${socketPath} under a test: point the test at its own daemon with AGENT_BOARD_SOCKET or AGENT_BOARD_DATA_DIR.`,
    );
  }
}

/**
 * Connects to the daemon of the session's env (`AGENT_BOARD_SOCKET`), else of `$AGENT_BOARD_DATA_DIR`, else of the
 * app's own data dir, and finds out who holds the env's board token. Never starts a daemon. Throws `BoardError` when
 * none answers, or the token is one no live session holds.
 */
export async function openBoardSession(env: NodeJS.ProcessEnv = process.env): Promise<BoardSession> {
  const socketPath = env[BOARD_SOCKET_ENV] || daemonPaths(env[BOARD_DATA_DIR_ENV] || defaultDataDir(env)).socket;
  refuseLiveDaemon(socketPath);
  let client: DaemonClient;
  try {
    client = await connectDaemon(socketPath);
  } catch {
    // In a session the daemon certainly runs: what stops the connection is likely the shell's sandbox (Codex's).
    throw new BoardError(
      env[BOARD_SOCKET_ENV]
        ? `can't reach the agent-board daemon at ${socketPath}. If your shell is sandboxed, use the agent-board MCP tools instead.`
        : `agent-board isn't running: no daemon answers at ${socketPath}. Open the app first.`,
    );
  }
  const token = env[BOARD_TOKEN_ENV] || undefined;
  let caller: BoardCaller | null = null;
  if (token !== undefined) {
    try {
      caller = await client.call('board.identify', { token });
    } catch (error) {
      client.close();
      if (error instanceof DaemonRpcError && error.code === BOARD_ERROR.unknownToken) {
        throw new BoardError(`${BOARD_TOKEN_ENV} is not a live session's board token: ${error.message}`);
      }
      throw error;
    }
  }
  return { client, socketPath, caller, token, close: () => client.close() };
}

/** Everything on the board the CLI shows. */
export interface Board {
  zones: Zone[];
  agents: Agent[];
  shells: Shell[];
  edges: FlowEdge[];
  items: BoardItem[];
  /** The board's connectors: annotation lines, and a diagram's relations. */
  connectors: Connector[];
}

export async function readBoard(client: DaemonClient): Promise<Board> {
  // The board shows where each agent's worktree is now: it may have renamed its branch since a hook last said so.
  await client.call('agent.refreshBranches');
  const [zones, agents, shells, edges, items, connectors] = await Promise.all([
    client.call('zone.list'),
    client.call('agent.list'),
    client.call('shell.list'),
    client.call('flowEdge.list'),
    client.call('item.list'),
    client.call('connector.list'),
  ]);
  // An agent's tabs are its own, not shell tiles on the board.
  return { zones, agents, shells: shells.filter((shell) => shell.owner === null), edges, items, connectors };
}

export const REF_KINDS = ['zone', 'agent', 'shell', 'edge', 'item', 'connector'] as const;
export type RefKind = (typeof REF_KINDS)[number];

/** Something a ref names. */
export type BoardObject =
  | { kind: 'zone'; zone: Zone }
  | { kind: 'agent'; agent: Agent }
  | { kind: 'shell'; shell: Shell }
  | { kind: 'edge'; edge: FlowEdge }
  | { kind: 'item'; item: BoardItem }
  | { kind: 'connector'; connector: Connector };

/** The fewest characters of an id a ref shows, however few would tell it apart. */
const MIN_REF_LENGTH = 4;

/**
 * Refs for everything on the board: `<kind>:<the shortest start of its id, at least four characters, that no other of
 * its kind shares>`, like git's short hashes. They stay the same while the board does, and lengthen only when an id
 * that starts the same way appears.
 */
export class BoardRefs {
  readonly board: Board;
  private readonly refs = new Map<string, string>();

  constructor(board: Board) {
    this.board = board;
    for (const kind of REF_KINDS) {
      const ids = this.objects(kind).map(idOf);
      for (const id of ids) {
        let length = Math.min(MIN_REF_LENGTH, id.length);
        while (length < id.length && ids.some((other) => other !== id && other.startsWith(id.slice(0, length)))) length++;
        this.refs.set(`${kind}:${id}`, `${kind}:${id.slice(0, length)}`);
      }
    }
  }

  /** The ref of the object `id` of `kind`, or its id as is for one not on the board. */
  of(kind: RefKind, id: string): string {
    return this.refs.get(`${kind}:${id}`) ?? `${kind}:${id}`;
  }

  /** The objects of `kind`. */
  objects(kind: RefKind): BoardObject[] {
    const { zones, agents, shells, edges, items, connectors } = this.board;
    switch (kind) {
      case 'zone':
        return zones.map((zone) => ({ kind, zone }));
      case 'agent':
        return agents.map((agent) => ({ kind, agent }));
      case 'shell':
        return shells.map((shell) => ({ kind, shell }));
      case 'edge':
        return edges.map((edge) => ({ kind, edge }));
      case 'item':
        return items.map((item) => ({ kind, item }));
      case 'connector':
        return connectors.map((connector) => ({ kind, connector }));
    }
  }

  refOf(object: BoardObject): string {
    return this.of(object.kind, idOf(object));
  }

  /**
   * What `text` names: `<kind>:<start of id>` or `<kind>:<name>`, a whole id, a unique name of a zone, agent or shell,
   * or `me` for the caller's tile. Throws `BoardError` for nothing, or for more than one thing.
   */
  resolve(text: string, caller: BoardCaller | null): BoardObject {
    const wanted = text.trim();
    if (wanted === 'me') {
      if (caller === null) throw new BoardError('`me` means your own tile, and you are not in an agent-board session.');
      return this.resolve(`${caller.kind}:${caller.tileId}`, null);
    }
    const colon = wanted.indexOf(':');
    const kind = colon === -1 ? undefined : (REF_KINDS as readonly string[]).includes(wanted.slice(0, colon)) ? (wanted.slice(0, colon) as RefKind) : undefined;
    const rest = kind === undefined ? wanted : wanted.slice(colon + 1);
    const kinds = kind === undefined ? REF_KINDS : [kind];
    const all = kinds.flatMap((each) => this.objects(each));
    const byId = all.filter((object) => idOf(object) === rest);
    if (byId.length === 1) return byId[0]!;
    if (kind !== undefined && rest !== '') {
      const byPrefix = all.filter((object) => idOf(object).startsWith(rest));
      if (byPrefix.length === 1) return byPrefix[0]!;
      if (byPrefix.length > 1) throw this.ambiguous(wanted, byPrefix);
    }
    const byName = all.filter((object) => nameOf(object)?.toLowerCase() === rest.toLowerCase());
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) throw this.ambiguous(wanted, byName);
    throw new BoardError(`nothing on the board is called ${JSON.stringify(wanted)}. \`agent-board tree\` lists what is.`);
  }

  private ambiguous(wanted: string, matches: BoardObject[]): BoardError {
    const listed = matches.map((object) => `  ${this.refOf(object)}  ${describeObject(object)}`).join('\n');
    return new BoardError(`${JSON.stringify(wanted)} could be any of ${matches.length} things; use a ref:\n${listed}`);
  }
}

function idOf(object: BoardObject): string {
  switch (object.kind) {
    case 'zone':
      return object.zone.id;
    case 'agent':
      return object.agent.sessionId;
    case 'shell':
      return object.shell.id;
    case 'edge':
      return object.edge.id;
    case 'item':
      return object.item.id;
    case 'connector':
      return object.connector.id;
  }
}

function nameOf(object: BoardObject): string | undefined {
  if (object.kind === 'zone') return object.zone.name;
  if (object.kind === 'agent') return object.agent.name;
  if (object.kind === 'shell') return object.shell.name;
  return undefined;
}

/** A few words saying what the object is. */
function describeObject(object: BoardObject): string {
  switch (object.kind) {
    case 'zone':
      return `${object.zone.kind === 'unbound' ? 'group' : 'zone'} ${object.zone.name}`;
    case 'agent':
      return `agent ${object.agent.name} (${object.agent.state})`;
    case 'shell':
      return `shell ${object.shell.name}`;
    case 'edge':
      return 'edge';
    case 'item':
      return `${object.item.kind} ${JSON.stringify(cut(itemText(object.item), 40))}`;
    case 'connector':
      return `connector ${relationOf(object.connector) ?? 'with ends of its own'}`;
  }
}

/** A view of the board, as the CLI prints it and as its `--json`. */
export interface BoardView {
  text: string;
  json: unknown;
}

/** `~` for the home directory at the start of a path. */
function tilde(path: string): string {
  const home = homedir();
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function cut(text: string, length: number): string {
  return cutText(text.replace(/\s+/g, ' ').trim(), length);
}

function itemText(item: BoardItem): string {
  const data = item.data as Record<string, unknown>;
  if (item.kind === 'link') return String(data.title ?? data.url ?? '');
  if (item.kind === 'issue') return `${String(data.id ?? '')} ${String(data.title ?? '')}`.trim();
  if (item.kind === 'clock') return `${cronWords(String(data.cron ?? ''))}: ${String(data.prompt ?? '')}`;
  return typeof data.text === 'string' ? data.text : '';
}

/** A shape's kind, and its sections (a class's attributes and methods), a line each; none for another item. */
function shapeOf(item: BoardItem): { shape: string; sections: { name: string; lines: string[] }[] } | undefined {
  if (item.kind !== 'shape') return undefined;
  const data = item.data as Record<string, unknown>;
  const shape = typeof data.shape === 'string' ? data.shape : 'rectangle';
  const sections = SECTIONED_SHAPES.includes(shape as ShapeType)
    ? SHAPE_SECTIONS.map((name) => ({ name, lines: typeof data[name] === 'string' && data[name] !== '' ? (data[name] as string).split('\n') : [] }))
    : [];
  return { shape, sections };
}

/** A count of a shape's sections' lines, as its one-line summary gives them: `2 attributes, 1 method`. */
function sectionCounts(sections: { name: string; lines: string[] }[]): string {
  return sections.map(({ name, lines }) => plural(lines.length, name.replace(/s$/, ''))).join(', ');
}

/**
 * A class's sections as `show` and `zone map` print them: each under a rule line, a line each; none for another item.
 * With `limit`, each line is cut to `width` characters and each section to its first `lines`, saying how many more.
 */
export function shapeSectionLines(item: BoardItem, limit?: { lines: number; width: number }): string[] {
  return (shapeOf(item)?.sections ?? []).flatMap(({ name, lines }) => {
    const shown = limit === undefined ? lines : lines.slice(0, limit.lines).map((line) => cut(line, limit.width));
    const more = lines.length - shown.length;
    return [`── ${name}`, ...(lines.length === 0 ? ['(none)'] : shown), ...(more > 0 ? [`… and ${more} more`] : [])];
  });
}

/** The agent that wrote an agent note, by ref and name; undefined for any other item. */
function writtenBy(refs: BoardRefs, item: BoardItem): string | undefined {
  if (item.kind !== 'agent-note') return undefined;
  const agent = (item.data as Partial<AgentNoteData>).agent;
  return agent === undefined ? undefined : `${refs.of('agent', agent.sessionId)} ${agent.name}`;
}

/** Where a zone points: its repo, its folder in one, or nothing for a group (with its default repo, if any). */
function zoneWhere(zone: Zone): string {
  if (zone.clone !== null) return `group, cloning ${zone.clone.repo}`;
  if (zone.kind === 'unbound') return zone.defaultRepo === null ? 'group' : `group, default repo ${tilde(zone.defaultRepo)}`;
  if (zone.kind === 'folder') return `folder ${zone.folder} of ${tilde(zone.repoRoot!)}`;
  return `repo ${tilde(zone.repoRoot!)}`;
}

/** What an agent's tile says it does: its status if it set one, else its task. */
function agentDoing(agent: Agent): string {
  if (agent.status !== null) {
    return statusLine(agent.status);
  }
  return agent.description === '' ? 'no task yet' : `task: ${cut(agent.description, 80)}`;
}

/** The shell's folder now: its first pane's. */
function shellFolder(shell: Shell): string {
  const first = Object.values(shell.paneFolders)[0];
  return tilde(first ?? shell.cwd);
}

function zoneJson(refs: BoardRefs, zone: Zone) {
  return {
    ref: refs.of('zone', zone.id),
    id: zone.id,
    name: zone.name,
    kind: zone.kind === 'unbound' ? 'group' : zone.kind,
    repoRoot: zone.repoRoot,
    folder: zone.folder,
    defaultRepo: zone.defaultRepo,
    tracker: zone.tracker,
  };
}

function agentJson(refs: BoardRefs, agent: Agent, caller: BoardCaller | null) {
  return {
    ref: refs.of('agent', agent.sessionId),
    id: agent.sessionId,
    kind: 'agent' as const,
    name: agent.name,
    you: isCaller(caller, 'agent', agent.sessionId),
    zone: agent.zoneId === null ? null : refs.of('zone', agent.zoneId),
    harness: agent.harness,
    model: agent.model,
    role: agent.role,
    roleName: agent.roleName,
    reviews: agent.reviews,
    state: agent.state,
    status: agent.status,
    workFinishedAt: agent.workFinishedAt,
    task: agent.description,
    repoRoot: agent.repoRoot,
    branch: agent.branch,
    worktree: agent.worktree,
    issue: agent.issue,
    pullRequests: agent.pullRequests.map(({ number, url, state }) => ({ number, url, state })),
    orchestrate: agent.orchestrate,
    spawnedBy: agent.spawnedBy === null ? null : refs.of('agent', agent.spawnedBy),
  };
}

function shellJson(refs: BoardRefs, shell: Shell, caller: BoardCaller | null) {
  return {
    ref: refs.of('shell', shell.id),
    id: shell.id,
    kind: 'shell' as const,
    name: shell.name,
    you: isCaller(caller, 'shell', shell.id),
    zone: shell.zoneId === null ? null : refs.of('zone', shell.zoneId),
    folder: Object.values(shell.paneFolders)[0] ?? shell.cwd,
    panes: Object.keys(shell.paneFolders).length,
  };
}

function itemJson(refs: BoardRefs, item: BoardItem) {
  const shape = shapeOf(item);
  return {
    ref: refs.of('item', item.id),
    id: item.id,
    kind: item.kind,
    zone: item.zoneId === null ? null : refs.of('zone', item.zoneId),
    text: itemText(item),
    ...(shape === undefined ? {} : { shape: shape.shape, ...Object.fromEntries(shape.sections.map(({ name, lines }) => [name, lines])) }),
    ...(item.kind === 'link' || item.kind === 'issue' ? { url: (item.data as { url?: string }).url ?? null } : {}),
    ...(item.kind === 'agent-note' ? { by: refs.of('agent', (item.data as unknown as AgentNoteData).agent.sessionId) } : {}),
  };
}

function edgeJson(refs: BoardRefs, edge: FlowEdge) {
  return {
    ref: refs.of('edge', edge.id),
    id: edge.id,
    from: refs.of('agent', edge.from),
    to: refs.of('agent', edge.to),
    trigger: edge.trigger,
    payload: edge.payload,
    path: edge.path,
    conditions: edge.conditions,
    deliverAs: edge.deliverAs,
    paused: edge.paused,
    held: edge.held,
    queued: edge.queued,
    lastDelivery: edge.lastDelivery,
    deliveries: edge.deliveries,
    madeBy: edge.madeBy === null ? null : refs.of('agent', edge.madeBy),
  };
}

function isCaller(caller: BoardCaller | null, kind: 'agent' | 'shell', id: string): boolean {
  return caller !== null && caller.kind === kind && caller.tileId === id;
}

const YOU = '  ← you';

function agentLine(refs: BoardRefs, agent: Agent, caller: BoardCaller | null): string {
  const you = isCaller(caller, 'agent', agent.sessionId) ? YOU : '';
  const finished = agent.workFinishedAt === null ? '' : ', finished';
  const role = roleLabel(agent);
  return `${refs.of('agent', agent.sessionId)}  ${agent.name}  [${agent.state}${finished}]${role === null ? '' : `  (${role})`}  ${agentDoing(agent)}${you}`;
}

function shellLine(refs: BoardRefs, shell: Shell, caller: BoardCaller | null): string {
  const you = isCaller(caller, 'shell', shell.id) ? YOU : '';
  return `${refs.of('shell', shell.id)}  ${shell.name}  [shell]  in ${shellFolder(shell)}${you}`;
}

export function itemLine(refs: BoardRefs, item: BoardItem): string {
  const text = itemText(item);
  const by = writtenBy(refs, item);
  const shape = shapeOf(item);
  const kind = shape === undefined ? item.kind : `shape ${shape.shape}`;
  const sections = shape === undefined || shape.sections.length === 0 ? '' : `  (${sectionCounts(shape.sections)})`;
  return `${refs.of('item', item.id)}  ${kind}${text === '' ? '' : `  ${JSON.stringify(cut(text, 60))}`}${sections}${by === undefined ? '' : `  by ${by}`}`;
}

/** What a connector's end is fixed to: an item by its ref and text, else the tile or zone by its ref and name. */
function connectorEndLabel(refs: BoardRefs, end: ConnectorEnd): string {
  if (end.type === 'item') {
    const item = refs.board.items.find((each) => each.id === end.id);
    const text = item === undefined ? '' : cut(itemText(item), 30);
    return `${refs.of('item', end.id)}${text === '' ? '' : ` ${JSON.stringify(text)}`}`;
  }
  if (end.type === 'external') return `external:${end.id.slice(0, 8)}`;
  const named = end.type === 'zone' ? refs.board.zones.find((each) => each.id === end.id) : end.type === 'agent' ? refs.board.agents.find((each) => each.sessionId === end.id) : refs.board.shells.find((each) => each.id === end.id);
  return `${refs.of(end.type, end.id)}${named === undefined ? '' : ` ${named.name}`}`;
}

/** A connector's relation as a class diagram reads it, else its ends and dash as drawn. */
function connectorRelation(connector: Connector): string {
  return relationOf(connector) ?? `${connector.startEnd}–${connector.endEnd}${connector.dashed ? ', dashed' : ''}`;
}

/** A connector's labels in a line, `from` end's, middle's and `to` end's, each only if it has one. */
function connectorLabels(connector: Connector): string {
  return (
    [
      ['label', connector.label],
      ['from', connector.startLabel],
      ['to', connector.endLabel],
    ] as const
  )
    .filter(([, text]) => text !== '')
    .map(([name, text]) => `${name} ${JSON.stringify(cut(text, 40))}`)
    .join(', ');
}

export function connectorLine(refs: BoardRefs, connector: Connector): string {
  const labels = connectorLabels(connector);
  return `${refs.of('connector', connector.id)}  ${connectorEndLabel(refs, connector.from)} → ${connectorEndLabel(refs, connector.to)}  ${connectorRelation(connector)}${labels === '' ? '' : `  (${labels})`}`;
}

function connectorJson(refs: BoardRefs, connector: Connector) {
  const end = (each: ConnectorEnd) => (each.type === 'external' ? `external:${each.id}` : refs.of(each.type, each.id));
  return {
    ref: refs.of('connector', connector.id),
    id: connector.id,
    from: end(connector.from),
    to: end(connector.to),
    relation: relationOf(connector) ?? null,
    startEnd: connector.startEnd,
    endEnd: connector.endEnd,
    dashed: connector.dashed,
    style: connector.style,
    label: connector.label,
    startLabel: connector.startLabel,
    endLabel: connector.endLabel,
  };
}

/** The zone a connector is listed under: its `from` end's (a zone itself, or what is in it); null for loose. */
function connectorZone(refs: BoardRefs, connector: Connector): string | null {
  const { type, id } = connector.from;
  if (type === 'zone') return id;
  if (type === 'item') return refs.board.items.find((each) => each.id === id)?.zoneId ?? null;
  if (type === 'agent') return refs.board.agents.find((each) => each.sessionId === id)?.zoneId ?? null;
  if (type === 'shell') return refs.board.shells.find((each) => each.id === id)?.zoneId ?? null;
  return null;
}

/** The connectors listed under the zone `zoneId` (null for loose). */
export function connectorsIn(refs: BoardRefs, zoneId: string | null): Connector[] {
  return refs.board.connectors.filter((connector) => connectorZone(refs, connector) === zoneId);
}

export function zoneLine(refs: BoardRefs, zone: Zone): string {
  return `${refs.of('zone', zone.id)}  ${zone.name}  (${zoneWhere(zone)})`;
}

/** `identify`: the caller's tile and zone, or that it is outside any session. */
export function identifyView(refs: BoardRefs, caller: BoardCaller | null, socketPath: string): BoardView {
  if (caller === null) {
    return {
      text: [
        `You are not in an agent-board session (no ${BOARD_TOKEN_ENV}): you act as the user, and set no status.`,
        `daemon  ${socketPath}`,
      ].join('\n'),
      json: { you: null, socket: socketPath },
    };
  }
  const zone = caller.zoneId === null ? undefined : refs.board.zones.find((each) => each.id === caller.zoneId);
  const tile =
    caller.kind === 'agent'
      ? refs.board.agents.find((agent) => agent.sessionId === caller.tileId)
      : refs.board.shells.find((shell) => shell.id === caller.tileId);
  const what = caller.side === 'agent' ? 'an agent' : caller.kind === 'agent' ? "a shell in the agent's window" : 'a shell tile';
  const lines = [`you      ${refs.of(caller.kind, caller.tileId)}  ${caller.name}  (${what})`];
  lines.push(`zone     ${zone === undefined ? 'none: your tile is loose on the board' : zoneLine(refs, zone)}`);
  if (caller.side === 'agent' && tile !== undefined) {
    const agent = tile as Agent;
    lines.push(`state    ${agent.state}`, `status   ${agent.status === null ? 'not set: your tile shows your task' : agentDoing(agent)}`);
    lines.push(`branch   ${branchWords(agent)} in ${tilde(agent.worktree)}`);
    const role = roleLabel(agent);
    if (role !== null) lines.push(`role     ${role}`);
    if (caller.orchestrate !== null) {
      lines.push(`you may  orchestrate in ${orchestrateScopeWords(caller.orchestrate, 'your')}: start, message and close agents (\`agent-board help orchestrate\`)`);
    }
  }
  if (caller.side === 'user') lines.push('you may  act for the user: start, message and close any agent, and turn orchestrating on and off');
  lines.push(`session  ${caller.sessionId}`, `daemon   ${socketPath}`);
  return {
    text: lines.join('\n'),
    json: {
      you: {
        ref: refs.of(caller.kind, caller.tileId),
        kind: caller.kind,
        side: caller.side,
        name: caller.name,
        session: caller.sessionId,
        orchestrate: caller.orchestrate,
        role: caller.side === 'agent' && tile !== undefined ? roleLabel(tile as Agent) : null,
        zone: zone === undefined ? null : zoneJson(refs, zone),
      },
      socket: socketPath,
    },
  };
}

/** `tree`: every zone with its tiles and items, then what is loose on the board. */
export function treeView(refs: BoardRefs, caller: BoardCaller | null): BoardView {
  const { zones, agents, shells, items } = refs.board;
  const sections = [...zones.map((zone) => zone.id), null].map((zoneId) => {
    const inZone = <T extends { zoneId: string | null }>(list: T[]) => list.filter((each) => each.zoneId === zoneId);
    return { zoneId, agents: inZone(agents), shells: inZone(shells), items: inZone(items), connectors: connectorsIn(refs, zoneId) };
  });
  const lines: string[] = [];
  for (const section of sections) {
    const zone = zones.find((each) => each.id === section.zoneId);
    const rows = [
      ...section.agents.map((agent) => agentLine(refs, agent, caller)),
      ...section.shells.map((shell) => shellLine(refs, shell, caller)),
      ...section.items.map((item) => itemLine(refs, item)),
      ...section.connectors.map((connector) => connectorLine(refs, connector)),
    ];
    if (zone === undefined && rows.length === 0) continue;
    lines.push(zone === undefined ? 'loose on the board' : zoneLine(refs, zone));
    lines.push(...(rows.length === 0 ? ['(empty)'] : rows).map((row) => `  ${row}`));
  }
  return {
    text: lines.length === 0 ? 'The board is empty.' : lines.join('\n'),
    json: {
      zones: sections
        .filter((section) => section.zoneId !== null)
        .map((section) => ({
          ...zoneJson(refs, zones.find((zone) => zone.id === section.zoneId)!),
          tiles: [...section.agents.map((agent) => agentJson(refs, agent, caller)), ...section.shells.map((shell) => shellJson(refs, shell, caller))],
          items: section.items.map((item) => itemJson(refs, item)),
          connectors: section.connectors.map((connector) => connectorJson(refs, connector)),
        })),
      loose: {
        tiles: [
          ...sections.at(-1)!.agents.map((agent) => agentJson(refs, agent, caller)),
          ...sections.at(-1)!.shells.map((shell) => shellJson(refs, shell, caller)),
        ],
        items: sections.at(-1)!.items.map((item) => itemJson(refs, item)),
        connectors: sections.at(-1)!.connectors.map((connector) => connectorJson(refs, connector)),
      },
    },
  };
}

export function zonesView(refs: BoardRefs): BoardView {
  const { zones } = refs.board;
  const count = (zoneId: string) =>
    refs.board.agents.filter((agent) => agent.zoneId === zoneId).length + refs.board.shells.filter((shell) => shell.zoneId === zoneId).length;
  return {
    text: zones.length === 0 ? 'No zones.' : zones.map((zone) => `${zoneLine(refs, zone)}  ${plural(count(zone.id), 'tile')}`).join('\n'),
    json: zones.map((zone) => ({ ...zoneJson(refs, zone), tiles: count(zone.id) })),
  };
}

export function agentsView(refs: BoardRefs, caller: BoardCaller | null): BoardView {
  const { agents } = refs.board;
  return {
    text: agents.length === 0 ? 'No agents.' : agents.map((agent) => `${agentLine(refs, agent, caller)}  ${inZone(refs, agent.zoneId)}`).join('\n'),
    json: agents.map((agent) => agentJson(refs, agent, caller)),
  };
}

export function shellsView(refs: BoardRefs, caller: BoardCaller | null): BoardView {
  const { shells } = refs.board;
  return {
    text: shells.length === 0 ? 'No shell tiles.' : shells.map((shell) => `${shellLine(refs, shell, caller)}  ${inZone(refs, shell.zoneId)}`).join('\n'),
    json: shells.map((shell) => shellJson(refs, shell, caller)),
  };
}

export function inZone(refs: BoardRefs, zoneId: string | null): string {
  const zone = zoneId === null ? undefined : refs.board.zones.find((each) => each.id === zoneId);
  return zone === undefined ? '(loose)' : `(in ${refs.of('zone', zone.id)} ${zone.name})`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** An agent as an end of an edge: its ref, name and state. */
function endLabel(refs: BoardRefs, sessionId: string): string {
  const agent = refs.board.agents.find((each) => each.sessionId === sessionId);
  return agent === undefined ? refs.of('agent', sessionId) : `${refs.of('agent', sessionId)} ${agent.name} [${agent.state}]`;
}

/** What the edge carries, and when, of its `from` agent, called `its`, or `your` to that agent. */
function edgeRule(edge: FlowEdge, whose: 'its' | 'your' = 'its'): string {
  const what = edge.payload === 'final-message' ? `${whose} final message` : `${edge.path ?? 'a file'} from ${whose} worktree`;
  const when = edge.trigger === 'auto' ? `when ${whose === 'its' ? 'it hands off' : 'you hand off'}, or else as ${whose} turn ends` : 'when the user presses Send';
  const conditions = edge.conditions.length === 0 ? '' : `, once ${edge.conditions.map(conditionText).join(' and ')}`;
  return `carries ${what} ${when}${conditions}`;
}

function conditionText(condition: FlowCondition): string {
  switch (condition.kind) {
    case 'gate-green':
      return `\`${condition.command}\` passes`;
    case 'pr-checks':
      return 'its pull request checks pass';
    case 'issue-label':
      return `its issue is labelled ${condition.label}`;
    case 'script':
      return `\`${condition.command}\` exits 0`;
  }
}

/** Where the edge stands: paused, holding or queuing a hand-off, and its last delivery. */
function edgeStanding(edge: FlowEdge): string {
  const parts: string[] = [];
  if (edge.paused) parts.push('paused');
  if (edge.held !== null) parts.push(`holding ${edge.held.name}: ${edge.held.reason}`);
  if (edge.queued !== null) parts.push(`queued ${edge.queued.name} until the next agent's turn ends`);
  if (edge.lastDelivery !== null) {
    parts.push(edge.lastDelivery.delivered ? 'last delivered' : `last skipped: ${edge.lastDelivery.reason ?? ''}`.trim());
  } else if (edge.held === null && edge.queued === null) {
    parts.push('never delivered');
  }
  return parts.join('; ');
}

/** Who made the edge, if an agent did: `, made by agent:9c1e lead`. */
function madeBy(refs: BoardRefs, edge: FlowEdge): string {
  if (edge.madeBy === null) return '';
  const agent = refs.board.agents.find((each) => each.sessionId === edge.madeBy);
  return `, made by ${refs.of('agent', edge.madeBy)}${agent === undefined ? '' : ` ${agent.name}`}`;
}

/** What the edge carries and when, how it stands, and who made it, if an agent did: one line. */
function edgeSummary(refs: BoardRefs, edge: FlowEdge, whose: 'its' | 'your' = 'its'): string {
  return `${edgeRule(edge, whose)}; ${edgeStanding(edge)}${madeBy(refs, edge)}`;
}

function edgeLines(refs: BoardRefs, edge: FlowEdge): string[] {
  return [`${refs.of('edge', edge.id)}  ${endLabel(refs, edge.from)} → ${endLabel(refs, edge.to)}`, `  ${edgeSummary(refs, edge)}`];
}

export function edgesView(refs: BoardRefs): BoardView {
  const { edges } = refs.board;
  return {
    text: edges.length === 0 ? 'No edges.' : edges.flatMap((edge) => edgeLines(refs, edge)).join('\n'),
    json: edges.map((edge) => edgeJson(refs, edge)),
  };
}

/**
 * The edges into and out of the caller's agent, from its side: who it hands off to, and who hands off to it, with
 * their states. Outside an agent, every edge.
 */
export function connectionsView(refs: BoardRefs, caller: BoardCaller | null): BoardView {
  if (caller === null || caller.kind !== 'agent') return edgesView(refs);
  const id = caller.tileId;
  const out = refs.board.edges.filter((edge) => edge.from === id);
  const into = refs.board.edges.filter((edge) => edge.to === id);
  const lines: string[] = [];
  lines.push(out.length === 0 ? 'You hand off to no one: no edge leaves your tile.' : 'You hand off to:');
  for (const edge of out) {
    lines.push(`  ${endLabel(refs, edge.to)} by ${refs.of('edge', edge.id)}`, `    ${edgeSummary(refs, edge, 'your')}`);
  }
  if (out.some((edge) => edge.trigger === 'auto')) {
    lines.push('  Hand off with `agent-board handoff` (or the handoff tool) once your work is ready; else your turn\'s end does.');
  }
  lines.push(into.length === 0 ? 'No one hands off to you: no edge comes into your tile.' : 'These hand off to you:');
  for (const edge of into) {
    lines.push(`  ${endLabel(refs, edge.from)} by ${refs.of('edge', edge.id)}`, `    ${edgeSummary(refs, edge)}`);
  }
  return { text: lines.join('\n'), json: { out: out.map((edge) => edgeJson(refs, edge)), in: into.map((edge) => edgeJson(refs, edge)) } };
}

/** `show <ref>`: everything about one object. */
export function showView(refs: BoardRefs, object: BoardObject, caller: BoardCaller | null): BoardView {
  const ref = refs.refOf(object);
  const rows = (pairs: [string, string | undefined | null][]) =>
    pairs.filter((pair): pair is [string, string] => pair[1] !== undefined && pair[1] !== null).map(([key, value]) => `  ${key.padEnd(10)} ${value}`);
  switch (object.kind) {
    case 'zone': {
      const { zone } = object;
      const tiles = [
        ...refs.board.agents.filter((agent) => agent.zoneId === zone.id).map((agent) => agentLine(refs, agent, caller)),
        ...refs.board.shells.filter((shell) => shell.zoneId === zone.id).map((shell) => shellLine(refs, shell, caller)),
      ];
      const items = refs.board.items.filter((item) => item.zoneId === zone.id).map((item) => itemLine(refs, item));
      return {
        text: [
          `${ref}  ${zone.name}`,
          ...rows([
            ['kind', zoneWhere(zone)],
            ['tracker', zone.tracker === null ? undefined : `${zone.tracker.provider} ${zone.tracker.scope}`],
            ['board mcp', zone.boardMcp ? 'on' : 'off'],
            ['agents orchestrate', zone.agentsOrchestrate ? 'on' : 'off'],
          ]),
          '  tiles',
          ...(tiles.length === 0 ? ['    (none)'] : tiles.map((tile) => `    ${tile}`)),
          ...(items.length === 0 ? [] : ['  items', ...items.map((item) => `    ${item}`)]),
        ].join('\n'),
        json: { ...zoneJson(refs, zone), boardMcp: zone.boardMcp, agentsOrchestrate: zone.agentsOrchestrate, tiles: tiles.length, items: items.length },
      };
    }
    case 'agent': {
      const { agent } = object;
      const edges = refs.board.edges.filter((edge) => edge.from === agent.sessionId || edge.to === agent.sessionId);
      return {
        text: [
          `${ref}  ${agent.name}${isCaller(caller, 'agent', agent.sessionId) ? YOU : ''}`,
          ...rows([
            ['state', agent.state],
            ['status', agent.status === null ? 'not set' : agentDoing(agent)],
            ['task', agent.description === '' ? '(none)' : cut(agent.description, 200)],
            ['harness', `${agent.harness}${agent.model === null ? '' : ` (${agent.model})`}`],
            ['role', roleLabel(agent)],
            ['zone', inZone(refs, agent.zoneId)],
            ['repo', tilde(agent.repoRoot)],
            ['branch', agent.reviews === null ? branchWords(agent) : `(none): reviews ${agent.reviews.branch} at ${shortCommit(agent.reviews.head)}, detached`],
            ['worktree', tilde(agent.worktree)],
            ['issue', agent.issue === null ? undefined : `${agent.issue.id} ${agent.issue.title} ${agent.issue.url}`],
            ['pr', agent.pullRequests.length === 0 ? undefined : agent.pullRequests.map((pr) => `#${pr.number} ${pr.state} ${pr.url}`).join(', ')],
            ['last said', agent.lastMessage === null ? undefined : cut(agent.lastMessage, 200)],
            ['orchestrates', agent.orchestrate === null ? undefined : `agents in ${orchestrateScopeWords(agent.orchestrate)}`],
            ['started by', agent.spawnedBy === null ? undefined : endLabel(refs, agent.spawnedBy)],
          ]),
          ...(edges.length === 0 ? [] : ['  edges', ...edges.flatMap((edge) => edgeLines(refs, edge)).map((line) => `    ${line}`)]),
        ].join('\n'),
        json: { ...agentJson(refs, agent, caller), lastMessage: agent.lastMessage, edges: edges.map((edge) => refs.of('edge', edge.id)) },
      };
    }
    case 'shell': {
      const { shell } = object;
      const folders = Object.values(shell.paneFolders);
      return {
        text: [
          `${ref}  ${shell.name}${isCaller(caller, 'shell', shell.id) ? YOU : ''}`,
          ...rows([
            ['zone', inZone(refs, shell.zoneId)],
            ['panes', `${folders.length}: ${folders.map(tilde).join(', ')}`],
          ]),
        ].join('\n'),
        json: { ...shellJson(refs, shell, caller), folders },
      };
    }
    case 'edge':
      return { text: edgeLines(refs, object.edge).join('\n'), json: edgeJson(refs, object.edge) };
    case 'item': {
      const { item } = object;
      const shape = shapeOf(item);
      const joined = refs.board.connectors.filter((connector) => [connector.from, connector.to].some((end) => end.type === 'item' && end.id === item.id));
      return {
        text: [
          `${ref}  ${shape === undefined ? item.kind : `shape ${shape.shape}`}`,
          ...rows([['zone', inZone(refs, item.zoneId)], ['by', writtenBy(refs, item)]]),
          ...itemText(item).split('\n').map((line) => `  ${line}`),
          ...shapeSectionLines(item).map((line) => `  ${line}`),
          ...(joined.length === 0 ? [] : ['  connectors', ...joined.map((connector) => `    ${connectorLine(refs, connector)}`)]),
        ].join('\n'),
        json: { ...itemJson(refs, item), ...(joined.length === 0 ? {} : { connectors: joined.map((connector) => refs.of('connector', connector.id)) }) },
      };
    }
    case 'connector': {
      const { connector } = object;
      return {
        text: [
          `${ref}  connector`,
          ...rows([
            ['from', connectorEndLabel(refs, connector.from)],
            ['to', connectorEndLabel(refs, connector.to)],
            ['relation', connectorRelation(connector)],
            ['style', connector.style],
            ['label', connector.label === '' ? undefined : connector.label],
            ['from label', connector.startLabel === '' ? undefined : connector.startLabel],
            ['to label', connector.endLabel === '' ? undefined : connector.endLabel],
          ]),
        ].join('\n'),
        json: connectorJson(refs, connector),
      };
    }
  }
}

/** Sets the caller's own status. Throws `BoardError` outside an agent-board session. */
export async function setOwnStatus(session: BoardSession, summary: string, progress: number | undefined, done = false): Promise<Agent> {
  if (session.token === undefined || session.caller === null) {
    throw new BoardError(`Only an agent in an agent-board session can set its status: there is no ${BOARD_TOKEN_ENV} here.`);
  }
  return session.client.call('board.setStatus', {
    token: session.token,
    summary,
    ...(progress === undefined ? {} : { progress }),
    ...(done ? { done } : {}),
  });
}

/**
 * Flags the caller for a look (`board.needsYou`): the user, or its orchestrator if one started it. `via`, a ref, names
 * the crew member whose flag an orchestrator passes on. With `reason` undefined, clears its flag instead. Throws
 * `BoardError` outside an agent-board session.
 */
export async function flagOwn(session: BoardSession, reason: string | undefined, via?: string): Promise<Agent> {
  if (session.token === undefined || session.caller === null) {
    throw new BoardError(`Only an agent in an agent-board session can ask for a look: there is no ${BOARD_TOKEN_ENV} here.`);
  }
  if (reason === undefined) return session.client.call('board.needsYou', { token: session.token, clear: true });
  const crew = via === undefined ? undefined : resolveAgent(new BoardRefs(await readBoard(session.client)), via, session.caller);
  return session.client.call('board.needsYou', { token: session.token, reason, ...(crew === undefined ? {} : { via: crew.sessionId }) });
}

/** What flagging (`flagOwn`) did, in a line: who it reaches, or that it was cleared. */
export function flagLine(agent: Agent): string {
  const { flag } = agent;
  if (flag === null) return 'Your flag is cleared.';
  if (flag.to === 'orchestrator') return `Flagged for the agent that started you: "${flag.reason}". It hears it at its prompt, and its reply clears it.`;
  const via = flag.via === null ? '' : ` (passing on ${flag.via})`;
  return `Flagged for the user in Needs you${via}: "${flag.reason}". Opening your session, or \`agent-board needs-you --clear\`, clears it.`;
}

/** `status set --agent`: the line of an agent in the caller's crew, which its tile says the caller set. */
export async function setCrewStatus(session: BoardSession, ref: string, summary: string, progress: number | undefined): Promise<BoardView> {
  const { token, agent } = await orchestratorTarget(session, ref);
  await session.client.call('orchestrator.setStatus', {
    token,
    sessionId: agent.sessionId,
    summary,
    ...(progress === undefined ? {} : { progress }),
  });
  const fresh = await freshAgentLine(session, agent.sessionId);
  return { text: `Set the status of ${fresh.line}`, json: agentJson(fresh.refs, fresh.agent, session.caller) };
}

/** The orchestrator commands' options for a new agent, as typed: refs and names, not ids. */
export interface NewAgentOptions {
  prompt: string;
  /** A zone ref; the caller's zone without. */
  zone?: string;
  harness?: string;
  model?: string;
  role?: string;
  /** Start it without its role's template: its first message is exactly `prompt`. */
  noTemplate?: boolean;
  name?: string;
  /** In a group, the absolute path of the repo (or a folder in one) to cut its worktree from. */
  repo?: string;
  branch?: string;
  /** The branch to cut it from, or an agent ref for that agent's branch. */
  base?: string;
  issue?: string;
}

/** The caller, and the agent `ref` names. */
async function orchestratorTarget(session: BoardSession, ref: string): Promise<{ token: string | undefined; refs: BoardRefs; agent: Agent }> {
  const { caller, token, refs } = await orchestratingCaller(session);
  return { token, refs, agent: resolveAgent(refs, ref, caller) };
}

/**
 * The caller and the board, for an orchestrator command. The daemon decides whether the caller may: an agent
 * the user lets orchestrate, a shell on the board, or the user outside a session, with no token.
 */
async function orchestratingCaller(session: BoardSession): Promise<{ caller: BoardCaller | null; token: string | undefined; refs: BoardRefs }> {
  const { caller, token } = session;
  const refs = new BoardRefs(await readBoard(session.client));
  return { caller, token, refs };
}

/** The agent `text` names, as a ref resolves it. */
export function resolveAgent(refs: BoardRefs, text: string, caller: BoardCaller | null): Agent {
  const object = refs.resolve(text, caller);
  if (object.kind !== 'agent') throw new BoardError(`${text} is a ${object.kind}, not an agent`);
  return object.agent;
}

/** The agent as one line, with its ref read afresh: it may be new since `refs` were. */
async function freshAgentLine(session: BoardSession, sessionId: string): Promise<{ refs: BoardRefs; agent: Agent; line: string }> {
  const refs = new BoardRefs(await readBoard(session.client));
  const agent = refs.board.agents.find((each) => each.sessionId === sessionId);
  if (agent === undefined) throw new BoardError(`agent ${sessionId} is gone`);
  return { refs, agent, line: agentLine(refs, agent, session.caller) };
}

/** An agent's branch for a line of text: a detached HEAD says so, with the last branch it was on. */
function branchWords(agent: Agent): string {
  if (agent.detached) return `(detached, last on ${agent.branch})`;
  return agent.branch || '(none)';
}

/** Where a new agent works: on its branch, or, a reviewer, detached at the tip of the branch it reviews. */
function checkout(agent: Agent): string {
  return agent.reviews === null ? `on ${agent.branch}` : `detached at ${shortCommit(agent.reviews.head)} of ${agent.reviews.branch}`;
}

/** `new`: starts an agent as the caller, an orchestrator. */
export async function newAgent(session: BoardSession, options: NewAgentOptions): Promise<BoardView> {
  const { caller, token, refs } = await orchestratingCaller(session);
  let zoneId: string | undefined;
  if (options.zone !== undefined) {
    const object = refs.resolve(options.zone, caller);
    if (object.kind !== 'zone') throw new BoardError(`${options.zone} is a ${object.kind}, not a zone`);
    zoneId = object.zone.id;
  }
  // An agent's ref names its branch: a reviewer starts from its implementer's tip. A reviewer's names the branch it
  // reviews, so a follow-up can be based on the reviewer before it.
  let baseBranch = options.base;
  let repo = options.repo;
  if (baseBranch !== undefined && /^agent:|^me$/.test(baseBranch)) {
    const agent = resolveAgent(refs, baseBranch, caller);
    if (agent.detached) {
      throw new BoardError(`${options.base} is on a detached HEAD (last on ${agent.branch}): check a branch out there to start from, or name a branch with --base`);
    }
    baseBranch = agent.reviews?.branch ?? agent.branch;
    if (baseBranch === '') throw new BoardError(`${options.base} has no branch to start from: it works outside git, or on a detached HEAD`);
    // In a group, its agents each work in a repo of their own: the branch is the based-on agent's, so is the repo.
    const target = refs.board.zones.find((zone) => zone.id === (zoneId ?? caller?.zoneId));
    if (repo === undefined && target?.repoRoot === null) repo = agent.repoRoot;
  }
  const started = await session.client.call('orchestrator.spawn', {
    token,
    prompt: options.prompt,
    ...(zoneId === undefined ? {} : { zoneId }),
    ...(options.harness === undefined ? {} : { harness: options.harness as Harness }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.role === undefined ? {} : { role: options.role }),
    ...(options.noTemplate === true ? { noTemplate: true } : {}),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(repo === undefined ? {} : { repo }),
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    ...(baseBranch === undefined ? {} : { baseBranch }),
    ...(options.issue === undefined ? {} : { issueId: options.issue }),
  });
  const fresh = await freshAgentLine(session, started.sessionId);
  // Which template its first message began with, so an orchestrator that wrote the whole prompt sees it was prefixed.
  const templateLine =
    started.template !== null
      ? `\n  Its first message begins with ${started.template}; start with --no-template to send your prompt alone.`
      : options.noTemplate === true && options.role !== undefined
        ? '\n  No role template: its first message is your prompt alone.'
        : '';
  return {
    text: `Started ${fresh.line}\n  ${checkout(started)} in ${tilde(started.worktree)}, ${inZone(fresh.refs, started.zoneId)}${templateLine}`,
    json: { ...agentJson(fresh.refs, fresh.agent, session.caller), template: started.template },
  };
}

/** `roles`: the app's default roles, each with the first line of its template. */
export async function defaultRolesView(session: BoardSession): Promise<BoardView> {
  const roles = await session.client.call('orchestrator.roles', { token: session.token });
  const width = Math.max(0, ...roles.map((role) => role.name.length));
  return {
    text:
      roles.length === 0
        ? 'The app has no default roles. `agent-board roles set <name> -- <template>` adds one.'
        : roles.map((role) => `${role.name.padEnd(width)}  ${cut(role.body.split('\n')[0] ?? '', 80) || '(empty)'}`).join('\n'),
    json: roles,
  };
}

/** The zone a `roles` command's `--zone` names, if it names one. */
async function rolesZone(session: BoardSession, ref: string | undefined): Promise<Zone | undefined> {
  if (ref === undefined) return undefined;
  const object = new BoardRefs(await readBoard(session.client)).resolve(ref, session.caller);
  if (object.kind !== 'zone') throw new BoardError(`${ref} is a ${object.kind}, not a zone`);
  return object.zone;
}

/**
 * `roles set`: sets the app's default role `name`, used in any zone that saved no template of its own for it; with
 * `zone`, that zone's template for the name.
 */
export async function setDefaultRole(session: BoardSession, name: string, body: string, zoneRef?: string): Promise<BoardView> {
  const zone = await rolesZone(session, zoneRef);
  const role = await session.client.call('orchestrator.setRole', { token: session.token, name, body, ...(zone === undefined ? {} : { zoneId: zone.id }) });
  return {
    text:
      zone === undefined
        ? `Set the default role ${role.name}: a zone with no template of its own for ${role.name} starts its agents with it.`
        : `Set ${zone.name}'s template for ${role.name}: its agents in that role start with it.`,
    json: role,
  };
}

/** `roles remove`: removes the app's default role `name`, or with `zone` that zone's template for it. */
export async function removeDefaultRole(session: BoardSession, name: string, zoneRef?: string): Promise<BoardView> {
  const zone = await rolesZone(session, zoneRef);
  await session.client.call('orchestrator.removeRole', { token: session.token, name, ...(zone === undefined ? {} : { zoneId: zone.id }) });
  const shown = name.trim();
  return { text: zone === undefined ? `Removed the default role ${shown}.` : `Removed ${zone.name}'s template for ${shown}.`, json: { removed: shown } };
}

/** `send`: the agent's next message, queued until its session is up if it isn't yet. */
export async function sendToAgent(session: BoardSession, ref: string, text: string): Promise<BoardView> {
  const { token, agent } = await orchestratorTarget(session, ref);
  const sent = await session.client.call('orchestrator.send', { token, sessionId: agent.sessionId, text });
  const fresh = await freshAgentLine(session, agent.sessionId);
  const queued = sent.queuedUntilUp > 0;
  return {
    text: queued ? `Queued until it's up, after its first prompt: ${fresh.line}` : `Sent to ${fresh.line}`,
    json: { ...agentJson(fresh.refs, fresh.agent, session.caller), queued },
  };
}

/** `wait`: until the agents' turns end (or `until`'s states), or the timeout. With `crew`, its crew's too. */
export async function waitForAgents(
  session: BoardSession,
  agentRefs: string[],
  options: { until?: WaitState[]; any?: boolean; timeoutMs?: number; crew?: boolean },
): Promise<BoardView & { timedOut: boolean }> {
  const { caller, token, refs } = await orchestratingCaller(session);
  const ids = agentRefs.map((ref) => resolveAgent(refs, ref, caller).sessionId);
  const result = await session.client.call('orchestrator.wait', {
    token,
    sessionIds: ids,
    ...(options.crew ? { crew: true } : {}),
    ...(options.until === undefined ? {} : { states: options.until }),
    ...(options.any ? { any: true } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const lines = result.agents.map((agent) => agentLine(refs, agent, caller));
  const head = result.timedOut
    ? `Timed out: ${options.any ? 'none is' : 'not all are'} there yet. Wait again, or look closer with \`agent-board show <ref>\`.`
    : null;
  return {
    text: [...(head === null ? [] : [head]), ...lines].join('\n'),
    json: { timedOut: result.timedOut, agents: result.agents.map((agent) => agentJson(refs, agent, caller)) },
    timedOut: result.timedOut,
  };
}

/** What `watchCrew` heard: its events' lines, the cursor to hear on from, and whether it heard none in time. */
export interface CrewNews {
  lines: string[];
  json: unknown[];
  cursor: string;
  missed: boolean;
  timedOut: boolean;
}

/**
 * `watch` and the MCP `wait` with `since`: the crew events after `since` of the agents named and, with `crew`, its
 * crew's, as soon as there is one, or none once `timeoutMs` passes.
 */
export async function watchCrew(
  session: BoardSession,
  agentRefs: string[],
  options: { crew?: boolean; since: string; kinds?: CrewEventKind[]; timeoutMs?: number },
): Promise<CrewNews> {
  const { caller, token, refs } = await orchestratingCaller(session);
  const ids = agentRefs.map((ref) => resolveAgent(refs, ref, caller).sessionId);
  const result = await session.client.call('orchestrator.wait', {
    token,
    sessionIds: ids,
    ...(options.crew || ids.length === 0 ? { crew: true } : {}),
    since: options.since,
    ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  // An agent started since the board was read has no ref yet: read it again.
  const fresh = result.events.some((event) => !refs.board.agents.some((agent) => agent.sessionId === event.sessionId))
    ? new BoardRefs(await readBoard(session.client))
    : refs;
  return {
    lines: result.events.map((event) => crewEventLine(fresh, event)),
    json: result.events.map((event) => ({ ...event, agent: fresh.of('agent', event.sessionId) })),
    cursor: result.cursor,
    missed: result.missed,
    timedOut: result.timedOut,
  };
}

/** A crew event as a line: `[<cursor>] <ref> <name>  <kind>: <detail>`. */
function crewEventLine(refs: BoardRefs, event: CrewEvent): string {
  return `[${event.cursor}] ${refs.of('agent', event.sessionId)} ${event.name}  ${event.kind}${event.detail === null ? '' : `: ${event.detail}`}`;
}

/** `read`: the agent's final message, or a file of its worktree. */
export async function readAgent(session: BoardSession, ref: string, path: string | undefined): Promise<BoardView> {
  const { token, agent } = await orchestratorTarget(session, ref);
  const result = await session.client.call('orchestrator.read', { token, sessionId: agent.sessionId, ...(path === undefined ? {} : { path }) });
  return { text: result.text, json: result };
}

/** `interrupt`: ends the agent's turn. */
export async function interruptAgent(session: BoardSession, ref: string): Promise<BoardView> {
  const { token, agent } = await orchestratorTarget(session, ref);
  await session.client.call('orchestrator.interrupt', { token, sessionId: agent.sessionId });
  const fresh = await freshAgentLine(session, agent.sessionId);
  return { text: `Interrupted ${fresh.line}`, json: agentJson(fresh.refs, fresh.agent, session.caller) };
}

/** `continue`: resumes a rate-limited agent's turn on usage credits, as its harness offers. */
export async function continueAgent(session: BoardSession, ref: string): Promise<BoardView> {
  const { token, agent } = await orchestratorTarget(session, ref);
  await session.client.call('orchestrator.continueOnCredits', { token, sessionId: agent.sessionId });
  const fresh = await freshAgentLine(session, agent.sessionId);
  return { text: `Continued on credits ${fresh.line}`, json: agentJson(fresh.refs, fresh.agent, session.caller) };
}

/**
 * `restart`: starts an ended agent again in place, carrying on its conversation; with `fresh`, a new conversation
 * (on `prompt`, if any) in the same tile, worktree and branch.
 */
export async function restartAgent(session: BoardSession, ref: string, anew?: { prompt?: string }): Promise<BoardView> {
  const { token, agent } = await orchestratorTarget(session, ref);
  await session.client.call('orchestrator.restart', {
    token,
    sessionId: agent.sessionId,
    ...(anew === undefined ? {} : { fresh: true, ...(anew.prompt === undefined ? {} : { prompt: anew.prompt }) }),
  });
  const fresh = await freshAgentLine(session, agent.sessionId);
  return { text: `Restarted ${fresh.line}`, json: agentJson(fresh.refs, fresh.agent, session.caller) };
}

/** `pause`: hibernates an idle agent, ending its session to free what it held, its conversation kept for its wake. */
export async function pauseAgent(session: BoardSession, ref: string): Promise<BoardView> {
  const { token, refs, agent } = await orchestratorTarget(session, ref);
  const paused = await session.client.call('orchestrator.pause', { token, sessionId: agent.sessionId });
  return {
    text: `Paused ${refs.of('agent', agent.sessionId)} ${agent.name}: hibernated. \`agent-board wake\`, a message or a hand-off wakes it.`,
    json: agentJson(refs, paused, session.caller),
  };
}

/** `wake`: starts a paused agent again, carrying on its conversation. */
export async function wakeAgent(session: BoardSession, ref: string): Promise<BoardView> {
  const { token, agent } = await orchestratorTarget(session, ref);
  await session.client.call('orchestrator.wake', { token, sessionId: agent.sessionId });
  const fresh = await freshAgentLine(session, agent.sessionId);
  return { text: `Woke ${fresh.line}`, json: agentJson(fresh.refs, fresh.agent, session.caller) };
}

/** `close`: ends the agent's session, or with `remove` deletes it with its worktree and branch. */
export async function closeAgent(session: BoardSession, ref: string, remove: boolean): Promise<BoardView> {
  const { token, refs, agent } = await orchestratorTarget(session, ref);
  const label = `${refs.of('agent', agent.sessionId)} ${agent.name}`;
  const closed = await session.client.call('orchestrator.close', { token, sessionId: agent.sessionId, remove });
  if (closed === null) return { text: `Removed ${label}, its worktree and its branch.`, json: null };
  return { text: `Closed ${label}: its session ended; its tile, worktree and branch stay.`, json: agentJson(refs, closed, session.caller) };
}

/** `orchestrate on|off`: the user lets an agent orchestrate, or stops it. Refused to an agent's own session. */
export async function setOrchestrate(session: BoardSession, ref: string, scope: OrchestrateScope | null): Promise<BoardView> {
  const refs = new BoardRefs(await readBoard(session.client));
  const agent = await session.client.call('agent.setOrchestrate', { sessionId: resolveAgent(refs, ref, session.caller).sessionId, scope });
  const label = `${refs.of('agent', agent.sessionId)} ${agent.name}`;
  return {
    text: scope === null ? `${label} may not orchestrate now.` : `${label} may orchestrate in ${orchestrateScopeWords(scope)} now.`,
    json: agentJson(refs, agent, session.caller),
  };
}


/** `activity`: what orchestrators did and tried, newest first. */
export async function activityView(session: BoardSession, of: string | undefined, limit: number | undefined): Promise<BoardView> {
  const refs = new BoardRefs(await readBoard(session.client));
  const orchestratorId = of === undefined ? undefined : resolveAgent(refs, of, session.caller).sessionId;
  const entries = await session.client.call('orchestrator.activity', {
    ...(orchestratorId === undefined ? {} : { orchestratorId }),
    ...(limit === undefined ? {} : { limit }),
  });
  const line = (entry: OrchestratorActivity) => {
    const target = entry.targetName === null ? '' : ` ${entry.targetName}`;
    const detail = entry.detail === '' ? '' : `: ${cut(entry.detail, 80)}`;
    const outcome = entry.outcome === 'done' ? '' : `  REFUSED: ${entry.reason ?? ''}`;
    return `${entry.at}  ${entry.orchestratorName}  ${entry.action}${target}${detail}${outcome}`;
  };
  return { text: entries.length === 0 ? 'No orchestrator has done anything yet.' : entries.map(line).join('\n'), json: entries };
}

/** `handoff`: the caller hands its work over its own outgoing edges, or with `to` over its edge to that agent alone. */
export async function handOff(session: BoardSession, options: HandoffPayload & { to?: string }): Promise<BoardView> {
  if (session.token === undefined || session.caller === null) {
    throw new BoardError(`Only an agent in an agent-board session can hand off: there is no ${BOARD_TOKEN_ENV} here.`);
  }
  const refs = new BoardRefs(await readBoard(session.client));
  const to = options.to === undefined ? undefined : resolveAgent(refs, options.to, session.caller).sessionId;
  const outcomes = await session.client.call('board.handoff', {
    token: session.token,
    ...(to === undefined ? {} : { to }),
    ...(options.message === undefined ? {} : { message: options.message }),
    ...(options.handoverPath === undefined ? {} : { handoverPath: options.handoverPath }),
    ...(options.json === undefined ? {} : { json: options.json }),
  });
  const line = ({ to: id, outcome, name, reason }: (typeof outcomes)[number]) => {
    const agent = refs.board.agents.find((each) => each.sessionId === id);
    return `  ${refs.of('agent', id)}${agent === undefined ? '' : ` ${agent.name}`}: ${outcome} ${name}${reason === null ? '' : `: ${reason}`}`;
  };
  return {
    text:
      outcomes.length === 0
        ? 'No edge leaves your tile, so nothing was handed on. Your tile shows your work finished.'
        : [`Handed off along ${plural(outcomes.length, 'edge')}:`, ...outcomes.map(line)].join('\n'),
    json: outcomes.map((outcome) => ({ ...outcome, edge: refs.of('edge', outcome.edgeId), to: refs.of('agent', outcome.to) })),
  };
}

/** What `--carries` names, as an edge's payload: `message` is its final message. */
export const EDGE_CARRIES = { message: 'final-message', handover: 'handover', json: 'json' } as const;

/** The condition kinds as typed (`gate:pnpm check:local`, `pr-checks`, `label:ready`, `script:./ready.sh`). */
const CONDITION_WORDS: Record<string, FlowCondition['kind']> = {
  gate: 'gate-green',
  'gate-green': 'gate-green',
  'pr-checks': 'pr-checks',
  label: 'issue-label',
  'issue-label': 'issue-label',
  script: 'script',
};

/**
 * A condition as the CLI types it, `<kind>[:<command or label>]` (`gate:pnpm check:local`), or as the MCP tool takes
 * it, `{kind, command?, label?}`. Throws `BoardError` for one it can't read, or one missing its command or label.
 */
function conditionOf(value: unknown): FlowCondition {
  let word: string;
  let text: string;
  if (typeof value === 'string') {
    const colon = value.indexOf(':');
    word = (colon === -1 ? value : value.slice(0, colon)).trim();
    text = colon === -1 ? '' : value.slice(colon + 1).trim();
  } else if (typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string') {
    const { kind, command, label } = value as { kind: string; command?: unknown; label?: unknown };
    word = kind;
    const given = command ?? label;
    text = typeof given === 'string' ? given.trim() : '';
  } else {
    throw new BoardError(`a condition is gate:<command>, pr-checks, label:<label> or script:<command> (as JSON, {kind: ${FLOW_CONDITION_KINDS.join(' | ')}, command?, label?})`);
  }
  const kind = CONDITION_WORDS[word];
  if (kind === undefined) throw new BoardError(`${JSON.stringify(word)} is not a condition: gate:<command>, pr-checks, label:<label> or script:<command>`);
  if (kind === 'pr-checks') return { kind };
  if (text === '') throw new BoardError(`a ${word} condition needs ${kind === 'issue-label' ? 'a label' : 'a command'}`);
  return kind === 'issue-label' ? { kind, label: text } : { kind, command: text };
}

/** The options of `edge add` (and the `add_edge` tool), as typed: refs, words and conditions not yet checked. */
export interface AddEdgeOptions {
  from: string;
  to: string;
  carries: string | undefined;
  path?: string;
  trigger?: string;
  conditions?: unknown[];
}

/** An edge's rules as typed, checked: what it carries, when, and its conditions. Throws `BoardError` for a bad one. */
export function edgeRules(options: Pick<AddEdgeOptions, 'carries' | 'trigger' | 'conditions'>): {
  payload: FlowEdgePayload;
  trigger?: FlowEdgeTrigger;
  conditions: FlowCondition[];
} {
  const { carries, trigger } = options;
  if (carries === undefined || !Object.hasOwn(EDGE_CARRIES, carries)) {
    throw new BoardError(`carries must be ${Object.keys(EDGE_CARRIES).join(', ')}`);
  }
  if (trigger !== undefined && !(FLOW_EDGE_TRIGGERS as readonly string[]).includes(trigger)) throw new BoardError('the trigger must be auto or manual');
  return {
    payload: EDGE_CARRIES[carries as keyof typeof EDGE_CARRIES],
    ...(trigger === undefined ? {} : { trigger: trigger as FlowEdgeTrigger }),
    conditions: (options.conditions ?? []).map(conditionOf),
  };
}

/** `edge add`: an orchestrator joins two agents of its scope (or itself) with an edge it is marked as making. */
export async function addEdge(session: BoardSession, options: AddEdgeOptions): Promise<BoardView> {
  const { conditions, ...rules } = edgeRules(options);
  const { caller, token, refs } = await orchestratingCaller(session);
  const edge = await session.client.call('orchestrator.addEdge', {
    token,
    from: resolveAgent(refs, options.from, caller).sessionId,
    to: resolveAgent(refs, options.to, caller).sessionId,
    ...rules,
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(conditions.length === 0 ? {} : { conditions }),
  });
  const fresh = new BoardRefs(await readBoard(session.client));
  const waits = edge.conditions.some((condition) => 'command' in condition)
    ? '\nIts gate or script runs nothing until the user approves it in the edge\'s rules.'
    : '';
  return { text: `Added ${edgeLines(fresh, edge).join('\n')}${waits}`, json: edgeJson(fresh, edge) };
}

/** `edge remove`: deletes an edge the caller, an orchestrator, made. */
export async function removeEdge(session: BoardSession, ref: string): Promise<BoardView> {
  const { caller, token, refs } = await orchestratingCaller(session);
  const object = refs.resolve(ref, caller);
  if (object.kind !== 'edge') throw new BoardError(`${ref} is a ${object.kind}, not an edge`);
  await session.client.call('orchestrator.removeEdge', { token, id: object.edge.id });
  return { text: `Removed ${refs.of('edge', object.edge.id)}.`, json: null };
}

/** The caller's board token, for a call only an agent in a session makes: `doing` says what, in the refusal. */
function agentToken(session: BoardSession, doing: string): string {
  if (session.token === undefined || session.caller === null) {
    throw new BoardError(`Only an agent in an agent-board session can ${doing}: there is no ${BOARD_TOKEN_ENV} here.`);
  }
  return session.token;
}

/** `open-pr`: the caller, an agent, opens a pull request of its own branch, always as a draft. */
export async function openOwnPullRequest(session: BoardSession): Promise<BoardView> {
  const pr = await session.client.call('board.openPullRequest', { token: agentToken(session, 'open a pull request') });
  return { text: `Opened #${pr.number} as a draft: ${pr.url}\nMarking it ready, and merging, are the user's.`, json: pr };
}

/**
 * `record`: puts an entry on the caller's sidebar (a pull request it opened, a hand-off doc), or with a doc
 * `forOrchestrator`, on its orchestrator's. A doc's relative path is from `cwd`.
 */
export async function recordEntry(session: BoardSession, params: RecordParams, cwd: string): Promise<BoardView> {
  const token = agentToken(session, 'record an entry on its sidebar');
  const sent = params.kind === 'doc' ? { ...params, path: resolvePath(cwd, params.path) } : params;
  const record = await session.client.call('board.record', { token, ...sent });
  const where = record.kind === 'doc' && record.from !== null ? "your orchestrator's sidebar, and on yours" : 'your sidebar';
  const what = record.kind === 'pr' ? `${record.key}${record.title === null ? '' : ` (${record.title})`}` : record.kind === 'doc' ? record.path : record.key;
  return { text: `Recorded ${what} on ${where}.`, json: record };
}

/**
 * `pin`: puts a file, a link or a labelled note on the caller's sidebar for the user to see, or with `forOrchestrator`,
 * on its orchestrator's. A file's relative path is from `cwd`.
 */
export async function pinEntry(session: BoardSession, params: Extract<RecordParams, { kind: 'pin' }>, cwd: string): Promise<BoardView> {
  const token = agentToken(session, 'pin on its sidebar');
  const sent = params.path === undefined ? params : { ...params, path: resolvePath(cwd, params.path) };
  const record = await session.client.call('board.record', { token, ...sent });
  return { text: `Pinned ${pinName(record)} on ${record.kind === 'pin' && record.from !== null ? "your orchestrator's" : 'your'} sidebar.`, json: record };
}

/** `unpin`: takes a pin off the caller's sidebar, or its orchestrator's: a file by its path (from `cwd`), a link, or a note by its label. */
export async function unpinEntry(session: BoardSession, ref: PinRef, cwd: string): Promise<BoardView> {
  const token = agentToken(session, 'unpin from its sidebar');
  const sent = ref.path === undefined ? ref : { ...ref, path: resolvePath(cwd, ref.path) };
  const record = await session.client.call('board.unpin', { token, ...sent });
  return { text: `Unpinned ${pinName(record)} from ${ref.forOrchestrator === true ? "your orchestrator's" : 'your'} sidebar.`, json: record };
}

/** A pin as a reply names it: a note by its label, a file or link by its label and itself, or itself. */
function pinName(record: AgentRecord): string {
  if (record.kind !== 'pin') return record.key;
  if (record.target.kind === 'note') return `the note ${record.label ?? ''}`;
  const where = record.target.kind === 'file' ? record.target.path : record.target.url;
  return record.label === null ? where : `${record.label} (${where})`;
}

/** What a crew member is told when its question or plan went to its orchestrator instead of the user. */
function sentToLead({ name }: SentToOrchestrator, what: 'question' | 'plan'): string {
  return (
    `You were started by ${name}, so your ${what} went to it, not to the user: it hears it at its prompt. Nothing waits ` +
    `on it. End your turn now: its answer comes as your next message.`
  );
}

/** `ask`: asks the user a question in the needs-you inbox and waits for the answer. */
export async function askUser(
  session: BoardSession,
  question: AskSpec,
): Promise<BoardView> {
  const token = agentToken(session, 'ask the user');
  const result = await session.client.call('board.ask', { token, ...question });
  if ('sentTo' in result) return { text: sentToLead(result, 'question'), json: result };
  const waited = minutes(question.timeoutMs ?? DEFAULT_ASK_WAIT_MS);
  const text =
    result.outcome === 'answered'
      ? `The user answered: ${result.answer}`
      : result.outcome === 'skipped'
        ? 'The user skipped the question without answering. Carry on with your best judgement, and say what you assumed.'
        : `No answer came within ${waited}. Carry on with your best judgement and say what you assumed, or ask again later.`;
  return { text, json: result };
}

/** A plan's body, as the agent gives it: inline Markdown or HTML, or a file in its folder (by its extension). */
export interface PlanSource {
  markdown?: string;
  html?: string;
  path?: string;
}

/** The body and format of a plan from exactly one of its sources; a file is read relative to `cwd`, and its path kept. */
export function readPlanSource(source: PlanSource, cwd: string): { body: string; format: PlanFormat; path?: string } {
  const given = (['markdown', 'html', 'path'] as const).filter((key) => source[key] !== undefined);
  if (given.length !== 1) throw new BoardError('give the plan as exactly one of markdown, html or path');
  if (source.markdown !== undefined) return { body: source.markdown, format: 'markdown' };
  if (source.html !== undefined) return { body: source.html, format: 'html' };
  const path = resolvePath(cwd, source.path!);
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch (error) {
    throw new BoardError(`can't read the plan at ${path}: ${(error as Error).message}`);
  }
  return { body, format: /\.html?$/i.test(path) ? 'html' : 'markdown', path };
}

/**
 * `show_doc` with `plan` (and `present_plan`, kept for agents that call it): shows the user a plan, its next version,
 * and waits for their decision. With `onBoard`, its plan card goes beside the agent's tile.
 */
export async function presentPlan(
  session: BoardSession,
  plan: PlanSpec & { onBoard?: boolean },
): Promise<BoardView> {
  const token = agentToken(session, 'present a plan');
  const result = await session.client.call('board.presentPlan', { token, ...plan });
  if ('sentTo' in result) return { text: sentToLead(result, 'plan'), json: result };
  if ('left' in result) throw new Error('the daemon answered a plan to wait on with one left');
  return { text: planDecisionText(result, plan), json: result };
}

/**
 * `agent-board doc --plan`: shows the user a plan, as `presentPlan` does, but returns at once: a shell command can't
 * wait the hour a user may take. The decision is typed at the agent's prompt later, as a document's edit is.
 */
export async function leavePlan(session: BoardSession, plan: PlanSpec & { onBoard?: boolean }): Promise<BoardView> {
  const token = agentToken(session, 'present a plan');
  const result = await session.client.call('board.presentPlan', { token, ...plan, detached: true });
  if ('sentTo' in result) return { text: sentToLead(result, 'plan'), json: result };
  if (!('left' in result)) throw new Error('the daemon waited on a plan to leave');
  const { version } = result.left;
  const where = plan.onBoard === true ? 'in their Needs you inbox and the Plan tab, and on the board beside your tile' : 'in their Needs you inbox and the Plan tab';
  return {
    text:
      `Plan v${version} shown to the user, ${where}. Nothing waits here: their decision (approved, changes asked for with their comments, or rejected, ` +
      `with any edits of theirs) comes to your prompt as a message, however long it takes. ` +
      'End your turn and wait for it; don\'t start the plan before.',
    json: result.left,
  };
}

/** A document as an agent shows it: one of its files, relative to `cwd`, with a title, on the board too if asked. */
export interface DocSpec {
  path: string;
  title?: string;
  onBoard?: boolean;
}

/** `show_doc`: shows the user one of the agent's Markdown or HTML files as a document, a Document tab in its window. */
export async function showDoc(session: BoardSession, doc: DocSpec, cwd: string): Promise<BoardView> {
  const token = agentToken(session, 'show the user a document');
  const shown = await session.client.call('board.showDoc', {
    token,
    path: resolvePath(cwd, doc.path),
    ...(doc.title === undefined ? {} : { title: doc.title }),
    ...(doc.onBoard === true ? { onBoard: true } : {}),
  });
  const where = doc.onBoard === true ? 'a Document tab in your window and a card beside your tile' : 'a Document tab in your window';
  const editing =
    shown.format === 'markdown'
      ? 'The user may edit it there: their edit is written to the file, and you are told what changed at your prompt.'
      : 'An HTML document is view-only (offline, sandboxed); the user may send you comments on it.';
  return {
    text: `Showing “${shown.title}” (v${shown.version}) to the user as ${where}. It stays live: when you write the file again, they see the new version. ${editing}`,
    json: shown,
  };
}
