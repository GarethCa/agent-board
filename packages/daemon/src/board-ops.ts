// The board as the agent-facing CLI and MCP see it (ADR-0010): one module both call, over the daemon methods the app
// uses (plus `board.identify` and `board.setStatus`). Refs, resolving them, and each view as text and as JSON.
import { homedir } from 'node:os';
import { BOARD_DATA_DIR_ENV, BOARD_SOCKET_ENV, BOARD_TOKEN_ENV } from './board-env.ts';
import { connectDaemon, DaemonRpcError, type DaemonClient } from './client.ts';
import { daemonPaths, defaultDataDir } from './paths.ts';
import {
  BOARD_ERROR,
  type Agent,
  type BoardCaller,
  type BoardItem,
  type FlowCondition,
  type FlowEdge,
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
  return { zones, agents, shells, edges, items };
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
  const when = edge.trigger === 'auto' ? `when ${whose} turn ends` : 'when the user presses Send';
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

function edgeLines(refs: BoardRefs, edge: FlowEdge): string[] {
  return [
    `${refs.of('edge', edge.id)}  ${endLabel(refs, edge.from)} → ${endLabel(refs, edge.to)}`,
    `  ${edgeRule(edge)}; ${edgeStanding(edge)}`,
  ];
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
    lines.push(`  ${endLabel(refs, edge.to)} by ${refs.of('edge', edge.id)}`, `    ${edgeRule(edge, 'your')}; ${edgeStanding(edge)}`);
  }
  lines.push(into.length === 0 ? 'No one hands off to you: no edge comes into your tile.' : 'These hand off to you:');
  for (const edge of into) {
    lines.push(`  ${endLabel(refs, edge.from)} by ${refs.of('edge', edge.id)}`, `    ${edgeRule(edge)}; ${edgeStanding(edge)}`);
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
          ]),
          '  tiles',
          ...(tiles.length === 0 ? ['    (none)'] : tiles.map((tile) => `    ${tile}`)),
          ...(items.length === 0 ? [] : ['  items', ...items.map((item) => `    ${item}`)]),
        ].join('\n'),
        json: { ...zoneJson(refs, zone), boardMcp: zone.boardMcp, tiles: tiles.length, items: items.length },
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
