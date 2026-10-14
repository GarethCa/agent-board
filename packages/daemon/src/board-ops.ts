// The board as the agent-facing CLI and MCP see it (ADR-0010): one module both call, over the daemon methods the app
// uses (plus `board.identify` and `board.setStatus`). Refs, resolving them, and each view as text and as JSON.
import { homedir } from 'node:os';
import { BOARD_DATA_DIR_ENV, BOARD_SOCKET_ENV, BOARD_TOKEN_ENV } from './board-env.ts';
import { connectDaemon, DaemonRpcError, type DaemonClient } from './client.ts';
import { daemonPaths, defaultDataDir } from './paths.ts';
import {
  BOARD_ERROR,
  type Agent,
  type AgentRole,
  type AgentState,
  type BoardCaller,
  type Harness,
  type OrchestrateScope,
  type OrchestratorActivity,
  notOrchestratingReason,
  orchestrateScopeWords,
  type BoardItem,
  FLOW_CONDITION_KINDS,
  type FlowCondition,
  type FlowEdge,
  FLOW_EDGE_TRIGGERS,
  type FlowEdgePayload,
  type FlowEdgeTrigger,
  type HandoffPayload,
  type Shell,
  statusLine,
  type Zone,
} from './protocol.ts';

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
 * Connects to the daemon of the session's env (`AGENT_BOARD_SOCKET`), else of `$AGENT_BOARD_DATA_DIR`, else of the
 * app's own data dir, and finds out who holds the env's board token. Never starts a daemon. Throws `BoardError` when
 * none answers, or the token is one no live session holds.
 */
export async function openBoardSession(env: NodeJS.ProcessEnv = process.env): Promise<BoardSession> {
  const socketPath = env[BOARD_SOCKET_ENV] || daemonPaths(env[BOARD_DATA_DIR_ENV] || defaultDataDir(env)).socket;
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
}

export async function readBoard(client: DaemonClient): Promise<Board> {
  const [zones, agents, shells, edges, items] = await Promise.all([
    client.call('zone.list'),
    client.call('agent.list'),
    client.call('shell.list'),
    client.call('flowEdge.list'),
    client.call('item.list'),
  ]);
  // An agent's tabs are its own, not shell tiles on the board.
  return { zones, agents, shells: shells.filter((shell) => shell.owner === null), edges, items };
}

export const REF_KINDS = ['zone', 'agent', 'shell', 'edge', 'item'] as const;
export type RefKind = (typeof REF_KINDS)[number];

/** Something a ref names. */
export type BoardObject =
  | { kind: 'zone'; zone: Zone }
  | { kind: 'agent'; agent: Agent }
  | { kind: 'shell'; shell: Shell }
  | { kind: 'edge'; edge: FlowEdge }
  | { kind: 'item'; item: BoardItem };

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
    const { zones, agents, shells, edges, items } = this.board;
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
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= length ? line : `${line.slice(0, length - 1).trimEnd()}…`;
}

function itemText(item: BoardItem): string {
  const data = item.data as Record<string, unknown>;
  if (item.kind === 'link') return String(data.title ?? data.url ?? '');
  if (item.kind === 'issue') return `${String(data.id ?? '')} ${String(data.title ?? '')}`.trim();
  return typeof data.text === 'string' ? data.text : '';
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
    state: agent.state,
    status: agent.status,
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
  return {
    ref: refs.of('item', item.id),
    id: item.id,
    kind: item.kind,
    zone: item.zoneId === null ? null : refs.of('zone', item.zoneId),
    text: itemText(item),
    ...(item.kind === 'link' || item.kind === 'issue' ? { url: (item.data as { url?: string }).url ?? null } : {}),
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
  return `${refs.of('agent', agent.sessionId)}  ${agent.name}  [${agent.state}]  ${agentDoing(agent)}${you}`;
}

function shellLine(refs: BoardRefs, shell: Shell, caller: BoardCaller | null): string {
  const you = isCaller(caller, 'shell', shell.id) ? YOU : '';
  return `${refs.of('shell', shell.id)}  ${shell.name}  [shell]  in ${shellFolder(shell)}${you}`;
}

function itemLine(refs: BoardRefs, item: BoardItem): string {
  const text = itemText(item);
  return `${refs.of('item', item.id)}  ${item.kind}${text === '' ? '' : `  ${JSON.stringify(cut(text, 60))}`}`;
}

function zoneLine(refs: BoardRefs, zone: Zone): string {
  return `${refs.of('zone', zone.id)}  ${zone.name}  (${zoneWhere(zone)})`;
}

/** `identify`: the caller's tile and zone, or that it is outside any session. */
export function identifyView(refs: BoardRefs, caller: BoardCaller | null, socketPath: string): BoardView {
  if (caller === null) {
    return {
      text: [
        `You are not in an agent-board session (no ${BOARD_TOKEN_ENV}): you can read the board but set no status.`,
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
  const lines = [`you      ${refs.of(caller.kind, caller.tileId)}  ${caller.name}  (${caller.kind === 'agent' ? 'an agent' : 'a shell tile'})`];
  lines.push(`zone     ${zone === undefined ? 'none: your tile is loose on the board' : zoneLine(refs, zone)}`);
  if (caller.kind === 'agent' && tile !== undefined) {
    const agent = tile as Agent;
    lines.push(`state    ${agent.state}`, `status   ${agent.status === null ? 'not set: your tile shows your task' : agentDoing(agent)}`);
    lines.push(`branch   ${agent.branch || '(none)'} in ${tilde(agent.worktree)}`);
    if (caller.orchestrate !== null) {
      lines.push(`you may  orchestrate in ${orchestrateScopeWords(caller.orchestrate, 'your')}: start, message and close agents (\`agent-board help orchestrate\`)`);
    }
  }
  lines.push(`session  ${caller.sessionId}`, `daemon   ${socketPath}`);
  return {
    text: lines.join('\n'),
    json: {
      you: {
        ref: refs.of(caller.kind, caller.tileId),
        kind: caller.kind,
        name: caller.name,
        session: caller.sessionId,
        orchestrate: caller.orchestrate,
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
    return { zoneId, agents: inZone(agents), shells: inZone(shells), items: inZone(items) };
  });
  const lines: string[] = [];
  for (const section of sections) {
    const zone = zones.find((each) => each.id === section.zoneId);
    const rows = [
      ...section.agents.map((agent) => agentLine(refs, agent, caller)),
      ...section.shells.map((shell) => shellLine(refs, shell, caller)),
      ...section.items.map((item) => itemLine(refs, item)),
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
        })),
      loose: {
        tiles: [
          ...sections.at(-1)!.agents.map((agent) => agentJson(refs, agent, caller)),
          ...sections.at(-1)!.shells.map((shell) => shellJson(refs, shell, caller)),
        ],
        items: sections.at(-1)!.items.map((item) => itemJson(refs, item)),
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

function inZone(refs: BoardRefs, zoneId: string | null): string {
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
            ['role', agent.role],
            ['zone', inZone(refs, agent.zoneId)],
            ['repo', tilde(agent.repoRoot)],
            ['branch', agent.branch || '(none)'],
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
      return {
        text: [`${ref}  ${item.kind}`, ...rows([['zone', inZone(refs, item.zoneId)]]), ...itemText(item).split('\n').map((line) => `  ${line}`)].join('\n'),
        json: itemJson(refs, item),
      };
    }
  }
}

/** Sets the caller's own status. Throws `BoardError` outside an agent-board session. */
export async function setOwnStatus(session: BoardSession, summary: string, progress: number | undefined): Promise<Agent> {
  if (session.token === undefined || session.caller === null) {
    throw new BoardError(`Only an agent in an agent-board session can set its status: there is no ${BOARD_TOKEN_ENV} here.`);
  }
  return session.client.call('board.setStatus', { token: session.token, summary, ...(progress === undefined ? {} : { progress }) });
}

/** The orchestrator commands' options for a new agent, as typed: refs and names, not ids. */
export interface NewAgentOptions {
  prompt: string;
  /** A zone ref; the caller's zone without. */
  zone?: string;
  harness?: string;
  model?: string;
  role?: string;
  name?: string;
  branch?: string;
  /** The branch to cut it from, or an agent ref for that agent's branch. */
  base?: string;
  issue?: string;
}

/** The caller, if it may orchestrate, and the agent `ref` names. Throws `BoardError` saying why not. */
async function orchestratorTarget(session: BoardSession, ref: string): Promise<{ token: string; refs: BoardRefs; agent: Agent }> {
  const { caller, token, refs } = await orchestratingCaller(session);
  return { token, refs, agent: resolveAgent(refs, ref, caller) };
}

/** The caller, if it may orchestrate, and the board. Throws `BoardError` saying why not. */
async function orchestratingCaller(session: BoardSession): Promise<{ caller: BoardCaller; token: string; refs: BoardRefs }> {
  if (session.token === undefined || session.caller === null) {
    throw new BoardError(`The orchestrator commands work only for an agent in an agent-board session: there is no ${BOARD_TOKEN_ENV} here.`);
  }
  const { caller, token } = session;
  const refs = new BoardRefs(await readBoard(session.client));
  if (caller.orchestrate === null) {
    const agent = caller.kind === 'agent' ? refs.board.agents.find((each) => each.sessionId === caller.tileId) : undefined;
    throw new BoardError(`${notOrchestratingReason(caller, agent, refs.board.zones)}.`);
  }
  return { caller, token, refs };
}

/** The agent `text` names, as a ref resolves it. */
function resolveAgent(refs: BoardRefs, text: string, caller: BoardCaller | null): Agent {
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

/** `new`: starts an agent as the caller, an orchestrator. */
export async function newAgent(session: BoardSession, options: NewAgentOptions): Promise<BoardView> {
  const { caller, token, refs } = await orchestratingCaller(session);
  let zoneId: string | undefined;
  if (options.zone !== undefined) {
    const object = refs.resolve(options.zone, caller);
    if (object.kind !== 'zone') throw new BoardError(`${options.zone} is a ${object.kind}, not a zone`);
    zoneId = object.zone.id;
  }
  // An agent's ref names its branch: a reviewer starts from its implementer's tip.
  let baseBranch = options.base;
  if (baseBranch !== undefined && /^agent:|^me$/.test(baseBranch)) baseBranch = resolveAgent(refs, baseBranch, caller).branch;
  const started = await session.client.call('orchestrator.spawn', {
    token,
    prompt: options.prompt,
    ...(zoneId === undefined ? {} : { zoneId }),
    ...(options.harness === undefined ? {} : { harness: options.harness as Harness }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.role === undefined ? {} : { role: options.role as AgentRole }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    ...(baseBranch === undefined ? {} : { baseBranch }),
    ...(options.issue === undefined ? {} : { issueId: options.issue }),
  });
  const fresh = await freshAgentLine(session, started.sessionId);
  return {
    text: `Started ${fresh.line}\n  on ${started.branch} in ${tilde(started.worktree)}, ${inZone(fresh.refs, started.zoneId)}`,
    json: agentJson(fresh.refs, fresh.agent, session.caller),
  };
}

/** `send`: the agent's next message. */
export async function sendToAgent(session: BoardSession, ref: string, text: string): Promise<BoardView> {
  const { token, agent } = await orchestratorTarget(session, ref);
  await session.client.call('orchestrator.send', { token, sessionId: agent.sessionId, text });
  const fresh = await freshAgentLine(session, agent.sessionId);
  return { text: `Sent to ${fresh.line}`, json: agentJson(fresh.refs, fresh.agent, session.caller) };
}

/** `wait`: until the agents' turns end (or `until`'s states), or the timeout. */
export async function waitForAgents(
  session: BoardSession,
  agentRefs: string[],
  options: { until?: AgentState[]; any?: boolean; timeoutMs?: number },
): Promise<BoardView & { timedOut: boolean }> {
  const { caller, token, refs } = await orchestratingCaller(session);
  const ids = agentRefs.map((ref) => resolveAgent(refs, ref, caller).sessionId);
  const result = await session.client.call('orchestrator.wait', {
    token,
    sessionIds: ids,
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

/** `close`: ends the agent's session, or with `remove` deletes it with its worktree and branch. */
export async function closeAgent(session: BoardSession, ref: string, remove: boolean): Promise<BoardView> {
  const { token, refs, agent } = await orchestratorTarget(session, ref);
  const label = `${refs.of('agent', agent.sessionId)} ${agent.name}`;
  const closed = await session.client.call('orchestrator.close', { token, sessionId: agent.sessionId, remove });
  if (closed === null) return { text: `Removed ${label}, its worktree and its branch.`, json: null };
  return { text: `Closed ${label}: its session ended; its tile, worktree and branch stay.`, json: agentJson(refs, closed, session.caller) };
}

/** `orchestrate on|off`: the user lets an agent orchestrate, or stops it. Refused in a session. */
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
    text: [`Handed off along ${plural(outcomes.length, 'edge')}:`, ...outcomes.map(line)].join('\n'),
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
