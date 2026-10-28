// Orchestrators (ADR-0011): agents the user lets start, message, watch and close other agents through the
// board CLI and MCP, inside a scope. Every control call names the orchestrator by its board token, is checked against
// its capability and scope at that call, and is logged, done or refused.
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentHost } from './agents.ts';
import { agentTarget, boardCaller, sessionCaller, type ActivityLogger, type BoardCallerSources, type BoardConnection } from './board.ts';
import type { FlowEdgeHost } from './flow-edges.ts';
import { runGit } from './git.ts';
import { checkedBranchName, noBranchWhy } from './worktrees.ts';
import { createCrewEventLog, type LoggedEvent } from './crew-events.ts';
import { refOf } from './crew-flags.ts';
import { createReplyPaths } from './reply-paths.ts';
import { invalidParams, optionalBooleanParam, optionalCountParam, optionalStringParam, paramsObject, stringParam } from './params.ts';
import {
  BOARD_ERROR,
  CREW_EVENT_KINDS,
  DEFAULT_ACTIVITY_LIMIT,
  DEFAULT_ORCHESTRATOR_WAIT_MS,
  HARNESSES,
  isWaitState,
  MAX_ACTIVITY_LIMIT,
  MAX_CREW_DEPTH,
  MAX_ORCHESTRATOR_READ_BYTES,
  MAX_ORCHESTRATOR_WAIT_MS,
  orchestrateScopeWords,
  isOrchestratorRole,
  notOrchestratingReason,
  orchestratorTextRefusal,
  waitsOnUser,
  SETTLED_STATES,
  WAIT_STATES,
  type Agent,
  type AgentState,
  type CrewEvent,
  type CrewEventKind,
  type DaemonEvent,
  type DaemonMethod,
  type DaemonMethods,
  type Harness,
  type OrchestrateScope,
  type OrchestratorAction,
  type OrchestratorActivity,
  type PullRequest,
  type WaitState,
  type Zone,
} from './protocol.ts';
import type { LayoutMethods } from './orchestrator-layout.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';

/** The orchestrator methods but the layout commands, which `orchestrator-layout.ts` handles. */
type OrchestratorMethods = Omit<
  Pick<DaemonMethods, Extract<keyof DaemonMethods, `orchestrator.${string}`>>,
  keyof LayoutMethods | 'orchestrator.roles' | 'orchestrator.setRole' | 'orchestrator.removeRole' | 'orchestrator.addClock' | 'orchestrator.removeClock'
>;

/** The terminal an orchestrator's agent starts in, before any client attaches and resizes it. */
const SPAWN_SIZE = { cols: 120, rows: 40 };

/** Most refused lines one tile logs a minute (`mayLogRefusal`). */
const MAX_REFUSALS_PER_WINDOW = 20;
const REFUSAL_WINDOW_MS = 60_000;

/** Most agents one wait watches. */
const MAX_WAIT_AGENTS = 50;

/** How much of a message or prompt the activity log keeps. */
const MAX_DETAIL_LENGTH = 500;

/**
 * States only a turn under way shows: once an agent sent a message shows one (or has ended), that turn has begun.
 * Any other update (a rename, a status, the state it was sent in) is no sign of it.
 */
const TURN_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['running', 'thinking', 'needs-permission', 'handing-off']);

/**
 * A repo's project config, which sets an agent's permission mode, allowed tools, hooks and MCP servers: an
 * orchestrator may not start an agent from a base whose config differs from the repo's HEAD.
 */
const PROJECT_CONFIG_PATHS = ['.claude', '.mcp.json', '.codex'];

/** The control methods' actions in the log; a wait or a read changes nothing, so neither is logged. */
const LOGGED_METHODS: Partial<Record<DaemonMethod, OrchestratorAction>> = {
  'orchestrator.spawn': 'spawn',
  'orchestrator.send': 'send',
  'orchestrator.setStatus': 'set-status',
  'orchestrator.interrupt': 'interrupt',
  'orchestrator.continueOnCredits': 'continue',
  'orchestrator.restart': 'restart',
  'orchestrator.pause': 'pause',
  'orchestrator.wake': 'wake',
  'orchestrator.close': 'close',
  'orchestrator.addEdge': 'add-edge',
  'orchestrator.removeEdge': 'remove-edge',
  'orchestrator.move': 'move',
  'orchestrator.arrange': 'arrange',
  'orchestrator.arrangeBoard': 'arrange-board',
  'orchestrator.addZone': 'add-zone',
  'orchestrator.changeZone': 'change-zone',
  'orchestrator.removeZone': 'remove-zone',
  'orchestrator.addNote': 'add-note',
  'orchestrator.editNote': 'edit-note',
  'orchestrator.removeNote': 'remove-note',
  'orchestrator.addShape': 'add-shape',
  'orchestrator.addDiagram': 'add-diagram',
  'orchestrator.editShape': 'edit-shape',
  'orchestrator.removeShape': 'remove-shape',
  'orchestrator.connect': 'connect',
  'orchestrator.editConnector': 'edit-connector',
  'orchestrator.removeConnector': 'remove-connector',
  'orchestrator.addClock': 'add-clock',
  'orchestrator.removeClock': 'remove-clock',
  'orchestrator.setRole': 'set-role',
  'orchestrator.removeRole': 'remove-role',
};

/**
 * Who acts through an orchestrator method: an orchestrator agent, or the user's side, a shell or the user
 * with no token, at board scope.
 */
export interface Orchestrator extends Pick<Agent, 'sessionId' | 'name' | 'zoneId' | 'repoRoot'> {
  orchestrate: OrchestrateScope;
  /** The orchestrator agent; null on the user's side, whose agents and edges are the user's own. */
  agent: Agent | null;
}

/** The user with no token, as the log keeps it. */
/**
 * The one agent whose branch `reviewer` reviews: in the same repo (two repos may share a branch name), on that branch,
 * and no reviewer itself. Undefined when none, or several, own it.
 */
export function reviewedAgent(all: readonly Agent[], reviewer: Agent): Agent | undefined {
  if (reviewer.reviews === null) return undefined;
  const { branch } = reviewer.reviews;
  const owners = all.filter(
    (each) => each.sessionId !== reviewer.sessionId && each.repoRoot === reviewer.repoRoot && each.reviews === null && each.reviewOf === null && each.branch === branch,
  );
  return owners.length === 1 ? owners[0] : undefined;
}

const THE_USER: Orchestrator = { sessionId: 'user', name: 'you', zoneId: null, repoRoot: '', orchestrate: 'board', agent: null };

/**
 * Who had the daemon act, and how, for its log: the orchestrator agent by name and ref, or the user, from the shell
 * whose token they used if any.
 */
const actedBy = (me: Orchestrator, how: string): string => {
  if (me.agent !== null) return `orchestrator ${me.name}'s ${how} (agent:${me.sessionId})`;
  return me === THE_USER ? `the user's ${how}` : `the user's ${how} from ${me.name} (${me.sessionId})`;
};

/** Where each scope reaches: the agents it may act on (besides its own), and the zones it may start agents in. */
const SCOPES: Record<OrchestrateScope, { agent(me: Orchestrator, target: Agent): boolean; zone(me: Orchestrator, zone: Zone): boolean }> = {
  zone: {
    agent: (me, target) => me.zoneId !== null && target.zoneId === me.zoneId,
    zone: (me, zone) => zone.id === me.zoneId,
  },
  repo: {
    agent: (me, target) => target.repoRoot === me.repoRoot,
    zone: (me, zone) => (zone.repoRoot ?? zone.defaultRepo) === me.repoRoot,
  },
  board: { agent: () => true, zone: () => true },
};

/** How far each scope reaches, to compare two: an orchestrator never steers one whose scope is wider than its own. */
const SCOPE_RANK: Record<OrchestrateScope, number> = { zone: 0, repo: 1, board: 2 };

/**
 * States an agent takes a message in: between turns, at its prompt (after a failed or rate-limited turn too, or with a
 * command still running), `starting` (a Codex agent's message queues behind its first prompt in the terminal; a Claude
 * agent's is refused, saying so, until its session is up and its first prompt typed), or `hibernated` (it wakes with it).
 */
const SENDABLE_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['starting', 'idle', 'waiting', 'scheduled', 'on-command', 'failed', 'rate-limited', 'hibernated']);

export interface OrchestratorHostOptions extends BoardCallerSources {
  db: DatabaseSync;
  agents: Pick<
    AgentHost,
    'get' | 'list' | 'fallbackOwner' | 'spawn' | 'answer' | 'interrupt' | 'continueOnCredits' | 'resume' | 'stop' | 'pause' | 'finalMessage' | 'orchestrateFacts' | 'idlePrompted' | 'setStatus' | 'clearFlag'
  >;
  zones: () => Zone[];
  flowEdges: Pick<FlowEdgeHost, 'create' | 'get' | 'link' | 'remove'>;
  /** Deletes the agent with its worktree and branch, as `agent.delete` without `force` does. */
  deleteAgent(sessionId: string, why: string): Promise<void>;
  /** How long an agent may answer a message from another: an hour by default. */
  replyWindowMs?: number;
  broadcast(event: DaemonEvent): void;
  log(message: string): void;
}

/** What a log line says beyond who and what: what it acted on (an agent, or a tile, zone or note), and what was asked. */
export interface ActivityEntry {
  /** An agent's session id, or a tile's, zone's or note's id; its name as it is now. */
  on?: { id: string; name: string };
  detail: string;
}

/**
 * What the layout commands (`orchestrator-layout.ts`) act through: who calls, what its scope reaches, and the log, as
 * every orchestrator method has them.
 */
export interface OrchestratorAccess {
  /** Who calls `method`: as every orchestrator method finds it, refusing (and logging) a session that may not. */
  caller(method: DaemonMethod, params: Record<string, unknown>, connection: BoardConnection): Orchestrator;
  /** Runs `act` as `me` doing `action`, logging it done or refused with what `entry` holds by then. */
  logged<T>(me: Orchestrator, action: OrchestratorAction, entry: ActivityEntry, act: () => Promise<T> | T): Promise<T>;
  /** Whether `me` may act on `agent`: itself, one it started, or one in its scope. */
  reachesAgent(me: Orchestrator, agent: Agent): boolean;
  /** Whether `zone` is in `me`'s scope: its own zone, a zone of its repo, or any, as its scope says. */
  reachesZone(me: Orchestrator, zone: Zone): boolean;
  /** Whether `me` made what `madeBy` names, or an agent of its crew did; the user's side made everything. */
  madeByCrew(me: Orchestrator, madeBy: string | null): boolean;
  /** Whether `agent`, in `zone`, would orchestrate where it can't now: by the zone's switch, as no hand-made scope does. */
  wouldGainOrchestrating(agent: Agent, zone: Zone | undefined): boolean;
  /** `me`'s scope in words, for a refusal. */
  scopeText(me: Orchestrator): string;
}

export interface OrchestratorHost {
  /** What the layout commands act through. */
  access: OrchestratorAccess;
  /** Writes a line of the activity log as `actor`, done or refused: a hand-off is any agent's. */
  logActivity: ActivityLogger;
  /** Whether the session may orchestrate: an agent's own, live, with `orchestrate` on, or one on the user's side. */
  mayOrchestrate(sessionId: string): boolean;
  /** Whether the session acts for the user (`BoardCaller.side`). */
  actsForUser(sessionId: string): boolean;
  /** Whether the agent `sessionId` may send to `to` as a reply: `to` messaged it, within the window (`reply-paths.ts`). */
  repliesTo(sessionId: string, to: unknown): boolean;
  /**
   * Throws `outOfScope` unless the agent `from` may name `to` in a hand-off with no edge: an agent in its scope
   * (its zone, unless the user let it orchestrate wider) or one it started, not itself, and not an orchestrator whose
   * scope is wider than its own, as for `send`.
   */
  checkHandoffTarget(from: string, to: string): void;
  /** Why the session may not orchestrate, and what would change that (`notOrchestratingReason`). */
  notOrchestrating(sessionId: string): string;
  /** Logs a control method the guard refused the session (`guardBoardCallers`), as the tile it speaks for. */
  refused(sessionId: string, method: DaemonMethod, params: unknown, reason: string): void;
  /** Hears an agent's own pull requests read (`PullRequestWatcherOptions.onRead`): a new open one is a crew event. */
  onPullRequestsRead(sessionId: string, own: readonly PullRequest[], first: boolean): void;
  /** Hears every event the daemon broadcasts: agents' updates move waits on. */
  onEvent(event: DaemonEvent): void;
  handlers<Context extends BoardConnection>(): RpcHandlers<OrchestratorMethods, Context>;
  /** Answers every wait as timed out. */
  close(): void;
}

interface ActivityRow {
  id: number;
  at: string;
  orchestrator_id: string;
  orchestrator_name: string;
  action: OrchestratorAction;
  target_id: string | null;
  target_name: string | null;
  detail: string;
  outcome: 'done' | 'refused';
  reason: string | null;
}

const toActivity = (row: ActivityRow): OrchestratorActivity => ({
  id: row.id,
  at: row.at,
  orchestratorId: row.orchestrator_id,
  orchestratorName: row.orchestrator_name,
  action: row.action,
  targetId: row.target_id,
  targetName: row.target_name,
  detail: row.detail,
  outcome: row.outcome,
  reason: row.reason,
});

const outOfScope = (message: string) => new RpcMethodError(BOARD_ERROR.outOfScope, message);

export function createOrchestratorHost(options: OrchestratorHostOptions): OrchestratorHost {
  const { db, agents } = options;
  const insertActivity = db.prepare(
    `INSERT INTO orchestrator_activity (at, orchestrator_id, orchestrator_name, action, target_id, target_name, detail, outcome, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  );
  const selectActivity = db.prepare('SELECT * FROM orchestrator_activity WHERE id < ? ORDER BY id DESC LIMIT ?');
  const selectActivityOf = db.prepare('SELECT * FROM orchestrator_activity WHERE orchestrator_id = ? AND id < ? ORDER BY id DESC LIMIT ?');

  /**
   * Agents an orchestrator has sent a message, or started with a prompt, whose turn on it hasn't begun yet: a wait
   * doesn't take their state until it has.
   */
  const awaitingTurn = new Set<string>();
  /** What happened to each agent, once each: what a wait with `since` answers with. */
  const crewEvents = createCrewEventLog({
    seed: agents.list(),
    idlePrompted: (sessionId) => agents.idlePrompted(sessionId),
    agent: (sessionId) => agents.get(sessionId),
    leads(agent) {
      const leads: string[] = [];
      for (let at = agent.spawnedBy; at !== null && leads.length < MAX_CREW_DEPTH; at = agents.get(at)?.spawnedBy ?? null) leads.push(at);
      return leads;
    },
  });
  /** Each wait's check, run on every agent update. */
  const waiters = new Set<{ check(): void; finish(timedOut: boolean): void }>();
  /**
   * Per agent, the agents that sent it a message by their own scope: it may send back to each for a while, and do
   * nothing else to it its scope doesn't allow. Kept in memory: a daemon restart forgets them.
   */
  const replies = createReplyPaths({
    ...(options.replyWindowMs === undefined ? {} : { windowMs: options.replyWindowMs }),
    scopeOf: (sessionId) => agents.get(sessionId)?.orchestrate,
  });
  const repliesTo = (sessionId: string, to: unknown): boolean => replies.has(sessionId, to);

  const mayOrchestrate = (sessionId: string): boolean => sessionCaller(options, sessionId)?.orchestrate != null;
  const actsForUser = (sessionId: string): boolean => sessionCaller(options, sessionId)?.side === 'user';

  /** Who acted, as the log keeps it: an orchestrator, or a tile that tried to be one. */
  type Actor = Pick<Agent, 'sessionId' | 'name'>;

  /** What a log line says, filled in as it is known. */
  type Entry = ActivityEntry;

  /** Per tile, how many refused lines it has logged in the current window, and when that window began. */
  const refusals = new Map<string, { since: number; count: number }>();

  /**
   * Whether `actor` may log another refused line now: at most `MAX_REFUSALS_PER_WINDOW` a minute, so a tile that loops
   * on refused calls can't grow the log, or flood every client, without bound. Done lines are never held back.
   */
  const mayLogRefusal = (actor: Actor): boolean => {
    const now = Date.now();
    const seen = refusals.get(actor.sessionId);
    if (seen === undefined || now - seen.since >= REFUSAL_WINDOW_MS) {
      refusals.set(actor.sessionId, { since: now, count: 1 });
      return true;
    }
    seen.count++;
    if (seen.count === MAX_REFUSALS_PER_WINDOW + 1) {
      options.log(`${actor.name} keeps making refused orchestrator calls: logging no more of them for a minute`);
    }
    return seen.count <= MAX_REFUSALS_PER_WINDOW;
  };

  const record = (actor: Actor, action: OrchestratorAction, entry: Entry, refused?: string) => {
    if (refused !== undefined && !mayLogRefusal(actor)) return;
    try {
      const row = insertActivity.get(
        new Date().toISOString(),
        actor.sessionId,
        actor.name,
        action,
        entry.on?.id ?? null,
        entry.on?.name ?? null,
        entry.detail.slice(0, MAX_DETAIL_LENGTH),
        refused === undefined ? 'done' : 'refused',
        refused ?? null,
      ) as unknown as ActivityRow;
      options.broadcast({ type: 'orchestrator.activity', entry: toActivity(row) });
    } catch (error) {
      // What was done stays done: a log line that can't be written never turns it into a refusal.
      options.log(`could not log ${actor.name}'s ${action}: ${(error as Error).message}`);
    }
  };

  /** A string param a control call names as what it asks, for its log line. */
  const askedText = (params: unknown): string => {
    const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
    const text = p.text ?? p.prompt ?? p.summary;
    return typeof text === 'string' ? text : '';
  };

  /** An end of an edge `me` makes: itself, or an agent it may look at (`from`) or steer (`to`, which its edge sends to). */
  const edgeEnd = (me: Orchestrator, sessionId: string, end: 'from' | 'to'): Agent => {
    const agent = agentNamed(sessionId);
    if (agent.sessionId === me.agent?.sessionId) return agent;
    if (end === 'from') checkTarget(me, agent);
    else checkSteerable(me, agent);
    return agent;
  };

  /**
   * A reviewer started on a branch is joined to the one agent that owns the branch, both ways, as manual edges (never
   * to the orchestrator that started it): the findings back, and the next round. Another agent in scope, none, or
   * several owning the branch, leaves it unlinked, and an edge already there is kept as it is.
   */
  const linkReviewer = (me: Orchestrator, reviewer: Agent) => {
    if (reviewer.reviews === null) return;
    const owner = reviewedAgent(agents.list(), reviewer);
    if (owner === undefined || owner.sessionId === me.agent?.sessionId) return;
    try {
      edgeEnd(me, reviewer.sessionId, 'from');
      edgeEnd(me, owner.sessionId, 'to');
    } catch {
      return;
    }
    // The reviewer is running by now: failing to join it must not fail its start.
    try {
      for (const [from, to] of [[reviewer, owner], [owner, reviewer]] as const) {
        options.flowEdges.link(from.sessionId, to.sessionId, me.agent?.sessionId);
      }
    } catch (error) {
      options.log(`could not link reviewer ${reviewer.name} to ${owner.name}: ${(error as Error).message}`);
    }
  };

  /**
   * Who acts: the orchestrator agent or user-side session holding the token in `params`, or the user, on a connection
   * that never presented one, with none. Throws `notAllowed` for any other session, logging the attempt as the tile it
   * speaks for.
   */
  const orchestrator = (method: DaemonMethod, params: Record<string, unknown>, connection: BoardConnection): Orchestrator => {
    const token = optionalStringParam(params, 'token');
    if (token === undefined) {
      if (connection.boardSession === undefined) return THE_USER;
      throw new RpcMethodError(BOARD_ERROR.notAllowed, 'this connection presented a board token: give it with each call');
    }
    const caller = boardCaller(options, token, connection);
    if (caller.orchestrate === null) {
      const reason = notOrchestrating(caller.sessionId);
      const action = LOGGED_METHODS[method];
      if (action !== undefined) record({ sessionId: caller.tileId, name: caller.name }, action, { detail: askedText(params) }, reason);
      throw new RpcMethodError(BOARD_ERROR.notAllowed, reason);
    }
    if (caller.side === 'user') {
      // Logged as the shell; an agent's ended pane or tab is its tile's shell.
      const name = caller.kind === 'shell' ? caller.name : `${caller.name}'s shell`;
      return { sessionId: caller.tileId, name, zoneId: caller.zoneId, repoRoot: '', orchestrate: 'board', agent: null };
    }
    const agent = agents.get(caller.tileId)!;
    return { sessionId: agent.sessionId, name: agent.name, zoneId: agent.zoneId, repoRoot: agent.repoRoot, orchestrate: caller.orchestrate, agent };
  };

  /**
   * The agent answering, on a `send` to an agent that messaged it (`repliesTo`) and that its own scope, if it has one,
   * doesn't reach; else undefined, and the send is an orchestrator's as any other. It has no scope to act at: only the
   * send itself, checked as every send is but for the scope.
   */
  const replier = (params: Record<string, unknown>, connection: BoardConnection): Actor | undefined => {
    const token = optionalStringParam(params, 'token');
    if (token === undefined) return undefined;
    const caller = boardCaller(options, token, connection);
    if (caller.side !== 'agent' || !repliesTo(caller.tileId, params.sessionId)) return undefined;
    const agent = agents.get(caller.tileId)!;
    const to = agents.get(params.sessionId as string);
    if (to !== undefined && maySteer(agent, to)) return undefined;
    return { sessionId: agent.sessionId, name: agent.name };
  };

  /** Whether `agent` may send to `to` without a reply path: it orchestrates, and may steer `to`. */
  const maySteer = (agent: Agent, to: Agent): boolean => {
    if (agent.orchestrate === null) return false;
    try {
      checkSteerable({ sessionId: agent.sessionId, name: agent.name, zoneId: agent.zoneId, repoRoot: agent.repoRoot, orchestrate: agent.orchestrate, agent }, to);
      return true;
    } catch {
      return false;
    }
  };

  /** Whether `me` started `agent` (the user's side starts the user's own agents, so none). */
  const startedBy = (me: Orchestrator, agent: Agent): boolean => me.agent !== null && agent.spawnedBy === me.agent.sessionId;

  /**
   * Whether `sessionId` is `lead` or an agent in its crew: one it started, or one of theirs, up the
   * `spawnedBy` chain (at most `MAX_CREW_DEPTH` long).
   */
  const inCrewOf = (lead: Agent, sessionId: string | null): boolean => {
    let at = sessionId;
    for (let step = 0; at !== null && step < MAX_CREW_DEPTH; step++) {
      if (at === lead.sessionId) return true;
      at = agents.get(at)?.spawnedBy ?? null;
    }
    return false;
  };

  /** `me`'s crew: the agents it started, and theirs; for the user's side, every agent. */
  const crewOf = (me: Orchestrator): Agent[] =>
    agents.list().filter((agent) => agent.sessionId !== me.agent?.sessionId && (me.agent === null || inCrewOf(me.agent, agent.spawnedBy)));

  const scopeText = (me: Orchestrator): string => orchestrateScopeWords(me.orchestrate, 'your');

  const agentNamed = (sessionId: string): Agent => {
    const agent = agents.get(sessionId);
    if (agent === undefined) throw invalidParams(`no agent ${sessionId}`);
    return agent;
  };

  /** Throws unless `me` may look at `agent`: in its scope or started by it, and not itself. */
  const checkTarget = (me: Orchestrator, agent: Agent) => {
    if (agent.sessionId === me.agent?.sessionId) throw outOfScope('that is you: an orchestrator acts on other agents, never itself');
    if (!startedBy(me, agent) && !SCOPES[me.orchestrate].agent(me, agent)) {
      throw outOfScope(`${agent.name} is outside your scope (${scopeText(me)}), and you did not start it`);
    }
  };

  /**
   * Throws unless `me` may steer `agent` (send to it, interrupt, restart or close it, or wire an edge into it): as
   * `checkTarget`, and not an orchestrator whose scope is wider than `me`'s (`SCOPE_RANK`), so no orchestrator reaches
   * past its own scope through another's.
   */
  const checkSteerable = (me: Orchestrator, agent: Agent) => {
    checkTarget(me, agent);
    if (agent.orchestrate !== null && SCOPE_RANK[agent.orchestrate] > SCOPE_RANK[me.orchestrate]) {
      throw outOfScope(`${agent.name} is an orchestrator whose scope is wider than yours (${orchestrateScopeWords(agent.orchestrate)}): you may watch it, not steer it`);
    }
  };

  /** The agent `sessionId` names, which `me` may look at. */
  const target = (me: Orchestrator, sessionId: string): Agent => {
    const agent = agentNamed(sessionId);
    checkTarget(me, agent);
    return agent;
  };

  /**
   * Runs `act` as `me` doing `action`, and logs it done or refused, with what `entry` holds by then (a spawn's agent
   * is its result).
   */
  const logged = async <T,>(me: Actor, action: OrchestratorAction, entry: Entry, act: () => Promise<T> | T): Promise<T> => {
    let result: T;
    try {
      result = await act();
    } catch (error) {
      record(me, action, entry, (error as Error).message);
      throw error;
    }
    record(me, action, entry);
    return result;
  };

  /** A spawn's or send's text, refused unless an orchestrator may type it (`orchestratorTextRefusal`). */
  const checkText = (text: string) => {
    const why = orchestratorTextRefusal(text);
    if (why !== undefined) throw invalidParams(`an orchestrator may not send this text: ${why}`);
  };

  /**
   * Throws unless `base` names a branch of the repo whose project config is the repo's HEAD's: an agent cut from it
   * would otherwise run under settings the orchestrator chose. It is checked as `addWorktree` cuts it, by
   * `refs/heads/<base>` alone (never a tag or another ref of that name), and reaches git only as a checked branch name
   * after `--end-of-options`, so no name is ever read as an option. Anything git can't answer refuses the spawn.
   */
  const checkBaseConfig = async (repoRoot: string, base: string) => {
    const name = await checkedBranchName(base).catch(() => {
      throw invalidParams(`${JSON.stringify(base)} is not a branch name`);
    });
    const ref = `refs/heads/${name}`;
    if (!(await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok) throw invalidParams(await noBranchWhy(repoRoot, name));
    // A repo with no commits yet has no HEAD to compare with: against the empty tree, any project config differs.
    const head = (await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).ok
      ? 'HEAD'
      : (await runGit(repoRoot, ['hash-object', '-t', 'tree', '/dev/null'])).stdout;
    const diff = await runGit(repoRoot, ['diff', '--name-only', '--end-of-options', head, ref, '--', ...PROJECT_CONFIG_PATHS]);
    if (!diff.ok) throw invalidParams(`could not compare ${name} with the repo's HEAD: ${diff.stderr.trim()}`);
    if (diff.stdout.trim() !== '') {
      throw outOfScope(
        `${name}'s project config differs from the repo's HEAD (${diff.stdout.trim().split('\n').join(', ')}): an agent ` +
          'started from it would run under settings you chose. Ask the user to start it.',
      );
    }
  };

  const notifyWaiters = () => {
    for (const waiter of waiters) waiter.check();
  };

  /** The file `path` in the agent's worktree, read as text, refusing one outside it once links are followed. */
  const readWorktreeFile = (agent: Agent, path: string): { text: string; path: string } => {
    const root = realpathSync(agent.worktree);
    let real: string;
    try {
      real = realpathSync(isAbsolute(path) ? path : resolve(root, path));
    } catch {
      throw invalidParams(`${agent.name} has no file ${path}`);
    }
    if (real !== root && !real.startsWith(`${root}${sep}`)) throw invalidParams(`${path} is outside ${agent.name}'s worktree`);
    const stats = statSync(real);
    if (!stats.isFile()) throw invalidParams(`${path} is not a file`);
    if (stats.size > MAX_ORCHESTRATOR_READ_BYTES) {
      throw invalidParams(`${path} is ${stats.size} bytes; at most ${MAX_ORCHESTRATOR_READ_BYTES} are read`);
    }
    const buffer = Buffer.alloc(stats.size);
    const fd = openSync(real, 'r');
    try {
      readSync(fd, buffer, 0, stats.size, 0);
    } finally {
      closeSync(fd);
    }
    return { text: buffer.toString('utf8'), path: relative(root, real) };
  };

  const notOrchestrating = (sessionId: string): string => {
    const caller = sessionCaller(options, sessionId);
    const agent = caller?.kind === 'agent' ? agents.get(caller.tileId) : undefined;
    const facts = agent === undefined ? undefined : { ...agent, ...agents.orchestrateFacts(agent.sessionId) };
    return notOrchestratingReason({ sessionId, name: caller?.name ?? 'This session' }, facts, options.zones());
  };

  return {
    access: {
      caller: orchestrator,
      logged,
      reachesAgent: (me, agent) => agent.sessionId === me.agent?.sessionId || startedBy(me, agent) || SCOPES[me.orchestrate].agent(me, agent),
      reachesZone: (me, zone) => SCOPES[me.orchestrate].zone(me, zone),
      madeByCrew: (me, madeBy) => me.agent === null || inCrewOf(me.agent, madeBy),
      wouldGainOrchestrating(agent, zone) {
        if (agent.orchestrate !== null || agent.endedAt !== null || zone === undefined || !zone.agentsOrchestrate) return false;
        const facts = agents.orchestrateFacts(agent.sessionId);
        return !facts.off && facts.depth < MAX_CREW_DEPTH - 1;
      },
      scopeText,
    },
    logActivity: record,
    mayOrchestrate,
    actsForUser,
    repliesTo,

    checkHandoffTarget(from, to) {
      const agent = agentNamed(from);
      const me: Orchestrator = { sessionId: agent.sessionId, name: agent.name, zoneId: agent.zoneId, repoRoot: agent.repoRoot, orchestrate: agent.orchestrate ?? 'zone', agent };
      checkSteerable(me, agentNamed(to));
    },
    notOrchestrating,

    refused(sessionId, method, params, reason) {
      const action = LOGGED_METHODS[method];
      const caller = sessionCaller(options, sessionId);
      if (action === undefined || caller === undefined) return;
      record({ sessionId: caller.tileId, name: caller.name }, action, { detail: askedText(params) }, reason);
    },

    onPullRequestsRead(sessionId, own, first) {
      crewEvents.pullRequestsRead(sessionId, own, first);
      notifyWaiters();
    },

    onEvent(event) {
      if (event.type === 'agent.updated') {
        if (awaitingTurn.has(event.agent.sessionId) && (event.agent.endedAt !== null || TURN_STATES.has(event.agent.state))) {
          awaitingTurn.delete(event.agent.sessionId);
        }
        crewEvents.observe(event.agent);
        notifyWaiters();
      } else if (event.type === 'agent.removed') {
        awaitingTurn.delete(event.sessionId);
        replies.forget(event.sessionId);
        crewEvents.forget(event.sessionId);
        notifyWaiters();
      }
    },

    close() {
      for (const waiter of waiters) waiter.finish(true);
    },

    handlers<Context extends BoardConnection>(): RpcHandlers<OrchestratorMethods, Context> {
      return {
        'orchestrator.spawn': async (params, connection) => {
          const p = paramsObject(params);
          const me = orchestrator('orchestrator.spawn', p, connection);
          const entry: Entry = { detail: askedText(p) };
          return logged(me, 'spawn', entry, async () => {
            const prompt = optionalStringParam(p, 'prompt') ?? '';
            const harness = optionalStringParam(p, 'harness') ?? 'claude';
            if (!HARNESSES.includes(harness as Harness)) throw invalidParams(`harness must be ${HARNESSES.join(' or ')}`);
            const zoneId = optionalStringParam(p, 'zoneId') ?? me.zoneId;
            if (zoneId === null) throw invalidParams(`${me.agent === null ? 'you have' : 'your tile is in'} no zone: name the zone to start the agent in`);
            const zone = options.zones().find((each) => each.id === zoneId);
            if (zone === undefined) throw invalidParams(`no zone ${zoneId}`);
            entry.detail = `${harness} in ${zone.name}${prompt.trim() === '' ? '' : `: ${prompt.trim()}`}`;
            if (me.agent !== null && agents.orchestrateFacts(me.agent.sessionId).depth >= MAX_CREW_DEPTH - 1) {
              throw outOfScope(`you are ${MAX_CREW_DEPTH} agents deep in a crew, as deep as a crew goes: ask the agent that started you to start it`);
            }
            if (!SCOPES[me.orchestrate].zone(me, zone)) throw outOfScope(`${zone.name} is outside your scope (${scopeText(me)})`);
            // The Captain's lead in a zone whose switch is off could start no one: the user hears of it instead (ADR-0019).
            if (me.agent?.master === true && !zone.agentsOrchestrate && isOrchestratorRole(optionalStringParam(p, 'role') ?? null)) {
              throw invalidParams(
                `${zone.name} doesn't let its agents orchestrate, so an orchestrator started there could start no one: tell the user with agent-board needs-you, who can turn its Let agents orchestrate on or start its orchestrator`,
              );
            }
            checkText(prompt);
            // A group's agent works in the repo it is given; a bound zone's, in the zone's own.
            const repo = optionalStringParam(p, 'repo');
            if (repo !== undefined && !isAbsolute(repo)) throw invalidParams(`repo path must be absolute, got ${repo}`);
            if (repo !== undefined && zone.repoRoot !== null) throw invalidParams(`${zone.name} is bound to its own repo: its agents work there`);
            const baseBranch = optionalStringParam(p, 'baseBranch');
            const repoRoot = repo ?? zone.repoRoot ?? zone.defaultRepo;
            if (baseBranch !== undefined) {
              if (repoRoot === null) throw invalidParams(`${zone.name} has no repo to cut a branch from`);
              await checkBaseConfig(repoRoot, baseBranch);
            }
            const used: { template: string | null } = { template: null };
            const agent = await agents.spawn(
              {
                zoneId,
                harness: harness as Harness,
                model: optionalStringParam(p, 'model'),
                role: optionalStringParam(p, 'role'),
                noTemplate: optionalBooleanParam(p, 'noTemplate'),
                name: optionalStringParam(p, 'name'),
                ...(repo === undefined ? {} : { repo: { path: repo } }),
                branch: optionalStringParam(p, 'branch'),
                baseBranch,
                issueId: optionalStringParam(p, 'issueId'),
                prompt,
                ...SPAWN_SIZE,
              },
              me.agent?.sessionId,
              undefined,
              used,
            );
            if (agent.description !== '') awaitingTurn.add(agent.sessionId);
            entry.on = agentTarget(agent);
            linkReviewer(me, agent);
            return { ...agent, template: used.template };
          });
        },

        'orchestrator.send': async (params, connection) => {
          const p = paramsObject(params);
          // An answer to an agent that messaged it passes scope (and needs no orchestrating), as nothing else does.
          const reply = replier(p, connection);
          const me = reply === undefined ? orchestrator('orchestrator.send', p, connection) : undefined;
          const entry: Entry = { detail: askedText(p) };
          return logged(me ?? reply!, 'send', entry, async () => {
            const text = stringParam(p, 'text');
            const to = agentNamed(stringParam(p, 'sessionId'));
            entry.on = agentTarget(to);
            if (me !== undefined) checkSteerable(me, to);
            checkText(text);
            if (to.endedAt !== null && to.state !== 'hibernated') throw invalidParams(`${to.name} has ended`);
            if (to.permissions.length > 0 || to.state === 'needs-permission') {
              throw invalidParams(`${to.name} needs the user's permission first`);
            }
            // Waiting on the user mid-turn: what was typed would be queued into that turn, not answer it.
            if (waitsOnUser(to)) throw invalidParams(`${to.name} is waiting on the user's answer to its question or plan`);
            if (!SENDABLE_STATES.has(to.state)) {
              throw invalidParams(`${to.name} is ${to.state}: wait for its turn to end, or interrupt it, before sending`);
            }
            // A message an agent sent by its own scope lets the receiver answer it (an answer opens nothing back), and
            // one that couldn't otherwise is told how. Not its own crew, which answers in its turn's last message.
            const sender = me?.agent ?? null;
            const opens = sender !== null && !inCrewOf(sender, to.spawnedBy);
            const hint =
              sender !== null && opens && !maySteer(to, sender)
                ? `\n\n[agent-board] From ${sender.name} (${refOf(sender)}), who you may answer with \`agent-board send ${refOf(sender)} -- '…'\`.`
                : '';
            awaitingTurn.add(to.sessionId);
            let queued: boolean;
            try {
              ({ queued } = await agents.answer(to.sessionId, `${text}${hint}`));
            } catch (error) {
              awaitingTurn.delete(to.sessionId);
              throw error;
            }
            if (sender !== null && opens) replies.open(to.sessionId, sender.sessionId, me!.orchestrate);
            // Its orchestrator answered it: its flag is seen to. Not by a message queued until it is up, which answers
            // nothing yet.
            if (!queued && to.flag !== null && to.spawnedBy === sender?.sessionId) return agents.clearFlag(to.sessionId);
            return agents.get(to.sessionId)!;
          });
        },

        'orchestrator.wait': async (params, connection) => {
          const p = paramsObject(params);
          const me = orchestrator('orchestrator.wait', p, connection);
          const ids = p.sessionIds ?? [];
          if (!Array.isArray(ids) || ids.length > MAX_WAIT_AGENTS || !ids.every((id) => typeof id === 'string')) {
            throw invalidParams(`sessionIds must be up to ${MAX_WAIT_AGENTS} agent ids`);
          }
          const crew = optionalBooleanParam(p, 'crew') ?? false;
          if (ids.length === 0 && !crew) throw invalidParams('name the agents to wait on, or wait on your crew');
          for (const id of ids) target(me, id);
          const states = p.states === undefined ? SETTLED_STATES : p.states;
          if (!Array.isArray(states) || states.length === 0 || !states.every(isWaitState)) {
            throw invalidParams(`states must be some of ${WAIT_STATES.join(', ')}`);
          }
          const asked = optionalStringParam(p, 'since');
          const kinds = p.kinds ?? CREW_EVENT_KINDS;
          if (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every((kind) => CREW_EVENT_KINDS.includes(kind as CrewEventKind))) {
            throw invalidParams(`kinds must be some of ${CREW_EVENT_KINDS.join(', ')}`);
          }
          if (asked === undefined && crew && ids.length === 0 && crewOf(me).length === 0) throw invalidParams('you have no crew to wait on yet');
          // `now` is as the wait began: what comes while it waits is news.
          const since = asked === 'now' ? crewEvents.cursor() : asked;
          /** The events it hears: its named agents', and its crew's as it was when each happened. */
          const keep = (event: LoggedEvent) =>
            kinds.includes(event.kind) &&
            (ids.includes(event.sessionId) || (crew && (me.agent === null || event.leads.includes(me.agent.sessionId))));
          if (since !== undefined) {
            try {
              crewEvents.after(since, keep);
            } catch (error) {
              throw invalidParams((error as Error).message);
            }
          }
          const any = optionalBooleanParam(p, 'any') ?? false;
          const timeoutMs = Math.min(optionalCountParam(p, 'timeoutMs') ?? DEFAULT_ORCHESTRATOR_WAIT_MS, MAX_ORCHESTRATOR_WAIT_MS);
          return new Promise((resolveWait, rejectWait) => {
            const current = (): Agent[] => {
              const named = (ids as string[]).flatMap((id) => {
                const agent = agents.get(id);
                // Listening for events, a deleted agent's end is the news: it is no failure.
                if (agent === undefined && since !== undefined) return [];
                if (agent === undefined) throw invalidParams(`agent ${id} was deleted`);
                return [agent];
              });
              return crew ? [...named, ...crewOf(me).filter((agent) => !ids.includes(agent.sessionId))] : named;
            };
            const there = (agent: Agent) => {
              if (awaitingTurn.has(agent.sessionId)) return false;
              const wanted = states as WaitState[];
              return wanted.includes(crewEvents.waitState(agent)) || (wanted.includes('finished') && agent.workFinishedAt !== null);
            };
            /** The events after `since` it hears. */
            const news = () => {
              const read = crewEvents.after(since!, keep);
              // As clients see them: without the crew each was heard in.
              const events = read.events.map(({ cursor, at, sessionId, name, kind, detail }): CrewEvent => ({ cursor, at, sessionId, name, kind, detail }));
              return { events, cursor: read.cursor, missed: read.missed };
            };
            const answer = (timedOut: boolean) => {
              const heard = since === undefined ? { events: [], cursor: crewEvents.cursor(), missed: false } : news();
              return { agents: current(), timedOut, ...heard };
            };
            const waiter = {
              check() {
                try {
                  if (since !== undefined) {
                    if (news().events.length > 0) waiter.finish(false);
                    return;
                  }
                  const list = current();
                  if (any ? list.some(there) : list.every(there)) waiter.finish(false);
                } catch (error) {
                  waiters.delete(waiter);
                  clearTimeout(timer);
                  rejectWait(error);
                }
              },
              finish(timedOut: boolean) {
                if (!waiters.delete(waiter)) return;
                clearTimeout(timer);
                try {
                  resolveWait(answer(timedOut));
                } catch (error) {
                  rejectWait(error);
                }
              },
            };
            const timer = setTimeout(() => waiter.finish(true), timeoutMs);
            waiters.add(waiter);
            // No one hears a wait whose connection has gone (a CLI its harness stopped): it ends with it.
            connection.closed?.addEventListener('abort', () => waiter.finish(true), { once: true });
            waiter.check();
          });
        },

        'orchestrator.read': (params, connection) => {
          const p = paramsObject(params);
          const me = orchestrator('orchestrator.read', p, connection);
          const agent = target(me, stringParam(p, 'sessionId'));
          const path = optionalStringParam(p, 'path');
          if (path !== undefined) return readWorktreeFile(agent, path);
          const text = agents.finalMessage(agent.sessionId) ?? agent.lastMessage;
          if (text === undefined || text === null) throw invalidParams(`${agent.name} has not finished a turn yet`);
          return { text, path: null };
        },

        'orchestrator.setStatus': (params, connection) => {
          const p = paramsObject(params);
          const me = orchestrator('orchestrator.setStatus', p, connection);
          const entry: Entry = { detail: askedText(p) };
          return logged(me, 'set-status', entry, () => {
            const agent = agentNamed(stringParam(p, 'sessionId'));
            entry.on = agentTarget(agent);
            checkSteerable(me, agent);
            // Only its own crew's line (the agents it started, and theirs): a wider scope reaches the board, not a status.
            if (me.agent !== null && !inCrewOf(me.agent, agent.spawnedBy)) {
              throw outOfScope(`${agent.name} is not in your crew, and you did not start it: only its own agent, or the orchestrator that started it, sets its status`);
            }
            return agents.setStatus(agent.sessionId, stringParam(p, 'summary'), p.progress === undefined ? null : (p.progress as number), false, me.agent === null ? null : me.name);
          });
        },

        'orchestrator.interrupt': (params, connection) => {
          const p = paramsObject(params);
          const me = orchestrator('orchestrator.interrupt', p, connection);
          const entry: Entry = { detail: '' };
          return logged(me, 'interrupt', entry, () => {
            const agent = agentNamed(stringParam(p, 'sessionId'));
            entry.on = agentTarget(agent);
            checkSteerable(me, agent);
            return agents.interrupt(agent.sessionId, actedBy(me, 'interrupt'));
          });
        },

        'orchestrator.continueOnCredits': (params, connection) => {
          const p = paramsObject(params);
          const me = orchestrator('orchestrator.continueOnCredits', p, connection);
          const entry: Entry = { detail: '' };
          return logged(me, 'continue', entry, () => {
            const agent = agentNamed(stringParam(p, 'sessionId'));
            entry.on = agentTarget(agent);
            checkSteerable(me, agent);
            return agents.continueOnCredits(agent.sessionId, actedBy(me, 'continue'));
          });
        },

        'orchestrator.restart': (params, connection) => {
          const p = paramsObject(params);
          const me = orchestrator('orchestrator.restart', p, connection);
          const entry: Entry = { detail: '' };
          // A plain restart of a paused agent wakes it: logged as what it did.
          const paused = typeof p.sessionId === 'string' && agents.get(p.sessionId)?.state === 'hibernated' && p.fresh !== true;
          return logged(me, paused ? 'wake' : 'restart', entry, () => {
            const agent = agentNamed(stringParam(p, 'sessionId'));
            entry.on = agentTarget(agent);
            checkSteerable(me, agent);
            const fresh = optionalBooleanParam(p, 'fresh') === true;
            const prompt = optionalStringParam(p, 'prompt');
            if (prompt !== undefined && !fresh) throw invalidParams('a prompt needs fresh: a restart that carries on its conversation takes none');
            if (fresh) {
              entry.detail = `fresh${prompt === undefined || prompt.trim() === '' ? '' : `: ${prompt.trim()}`}`;
              if (prompt !== undefined) checkText(prompt);
            }
            // Never forced: a busy shell is the user's to end.
            return agents.resume(agent.sessionId, actedBy(me, 'restart'), false, fresh ? { prompt: prompt === undefined || prompt.trim() === '' ? undefined : prompt } : undefined);
          });
        },

        'orchestrator.pause': (params, connection) => {
          const p = paramsObject(params);
          const me = orchestrator('orchestrator.pause', p, connection);
          const entry: Entry = { detail: '' };
          return logged(me, 'pause', entry, () => {
            const agent = agentNamed(stringParam(p, 'sessionId'));
            entry.on = agentTarget(agent);
            checkSteerable(me, agent);
            return agents.pause(agent.sessionId, me.agent === null ? null : me.sessionId, actedBy(me, 'pause'));
          });
        },

        'orchestrator.wake': (params, connection) => {
          const p = paramsObject(params);
          const me = orchestrator('orchestrator.wake', p, connection);
          const entry: Entry = { detail: '' };
          return logged(me, 'wake', entry, () => {
            const agent = agentNamed(stringParam(p, 'sessionId'));
            entry.on = agentTarget(agent);
            checkSteerable(me, agent);
            if (agent.state !== 'hibernated') throw invalidParams(`${agent.name} is not paused`);
            // Never forced: a paused agent's pane drops into no shell.
            return agents.resume(agent.sessionId, actedBy(me, 'wake'), false);
          });
        },

        'orchestrator.close': (params, connection) => {
          const p = paramsObject(params);
          const me = orchestrator('orchestrator.close', p, connection);
          const entry: Entry = { detail: '' };
          const remove = p.remove === true;
          return logged(me, remove ? 'remove' : 'close', entry, async () => {
            optionalBooleanParam(p, 'remove');
            const agent = agentNamed(stringParam(p, 'sessionId'));
            entry.on = agentTarget(agent);
            checkSteerable(me, agent);
            if (!remove) return agents.stop(agent.sessionId, actedBy(me, 'close'));
            // The user's side removes any agent, as the user does in the app; never forced, so unsaved work stands.
            if (me.agent === null) {
              await options.deleteAgent(agent.sessionId, actedBy(me, 'remove'));
              return null;
            }
            if (!startedBy(me, agent)) {
              throw outOfScope(`${agent.name} was not started by you: an orchestrator removes only an agent you started`);
            }
            // Removing an agent removes its reviewers first, unasked: never one the user started.
            const reviewers = agents.list().filter((each) => each.reviewOf === agent.sessionId && !startedBy(me, each));
            if (reviewers.length > 0) {
              throw outOfScope(
                `${agent.name} has a reviewer you did not start (${reviewers.map((each) => each.name).join(', ')}): ` +
                  'removing it would remove that too. Close it instead, and leave removing it to the user.',
              );
            }
            await options.deleteAgent(agent.sessionId, actedBy(me, 'remove'));
            return null;
          });
        },

        'orchestrator.addEdge': (params, connection) => {
          const p = paramsObject(params);
          const me = orchestrator('orchestrator.addEdge', p, connection);
          const entry: Entry = { detail: '' };
          return logged(me, 'add-edge', entry, () => {
            const from = edgeEnd(me, stringParam(p, 'from'), 'from');
            const to = agentNamed(stringParam(p, 'to'));
            entry.on = agentTarget(to);
            entry.detail = `from ${from.name}, carrying ${typeof p.payload === 'string' ? p.payload : 'final-message'}`;
            edgeEnd(me, to.sessionId, 'to');
            // Made as the user makes one, but never paused, and never approved: a gate or script waits for the user.
            const { payload, path, trigger, conditions, deliverAs } = p;
            const edge = options.flowEdges.create(
              { from: from.sessionId, to: to.sessionId, payload, path, trigger, conditions, deliverAs, paused: false },
              me.agent?.sessionId,
            );
            entry.detail = `${entry.detail} (edge ${edge.id})`;
            return edge;
          });
        },

        'orchestrator.removeEdge': (params, connection) => {
          const p = paramsObject(params);
          const me = orchestrator('orchestrator.removeEdge', p, connection);
          const entry: Entry = { detail: '' };
          return logged(me, 'remove-edge', entry, () => {
            const id = stringParam(p, 'id');
            const edge = options.flowEdges.get(id);
            if (edge === undefined) throw invalidParams(`no flow edge ${id}`);
            const to = agents.get(edge.to);
            entry.on = agentTarget(to);
            entry.detail = `from ${agents.get(edge.from)?.name ?? 'an agent'} (edge ${edge.id})`;
            if (me.agent !== null && !inCrewOf(me.agent, edge.madeBy)) {
              throw outOfScope('neither you nor an agent you started made that edge: an orchestrator removes only edges its crew made');
            }
            options.flowEdges.remove(id);
            return null;
          });
        },

        'orchestrator.activity': (params) => {
          const p = params === undefined ? {} : paramsObject(params);
          const limit = Math.min(optionalCountParam(p, 'limit') ?? DEFAULT_ACTIVITY_LIMIT, MAX_ACTIVITY_LIMIT);
          const of = optionalStringParam(p, 'orchestratorId');
          const before = optionalCountParam(p, 'before') ?? Number.MAX_SAFE_INTEGER;
          const rows = (of === undefined ? selectActivity.all(before, limit) : selectActivityOf.all(of, before, limit)) as unknown as ActivityRow[];
          return rows.map(toActivity);
        },
      };
    },
  };
}
