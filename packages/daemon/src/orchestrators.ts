// Orchestrators (ADR-0011): agents the user lets start, message, watch and close other agents through the
// board CLI and MCP, inside a scope. Every control call names the orchestrator by its board token, is checked against
// its capability and scope at that call, and is logged, done or refused.
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentHost } from './agents.ts';
import { boardCaller, sessionCaller, type ActivityLogger, type BoardCallerSources, type BoardConnection } from './board.ts';
import type { FlowEdgeHost } from './flow-edges.ts';
import { runGit } from './git.ts';
import { checkedBranchName } from './worktrees.ts';
import { invalidParams, optionalBooleanParam, optionalCountParam, optionalStringParam, paramsObject, stringParam } from './params.ts';
import {
  AGENT_ROLES,
  AGENT_STATES,
  BOARD_ERROR,
  DEFAULT_ACTIVITY_LIMIT,
  DEFAULT_ORCHESTRATOR_WAIT_MS,
  HARNESSES,
  isAgentState,
  MAX_ACTIVITY_LIMIT,
  MAX_CREW_DEPTH,
  MAX_ORCHESTRATOR_READ_BYTES,
  MAX_ORCHESTRATOR_WAIT_MS,
  orchestrateScopeWords,
  notOrchestratingReason,
  orchestratorTextRefusal,
  waitsOnUser,
  SETTLED_STATES,
  type Agent,
  type AgentRole,
  type AgentState,
  type DaemonEvent,
  type DaemonMethod,
  type DaemonMethods,
  type Harness,
  type OrchestrateScope,
  type OrchestratorAction,
  type OrchestratorActivity,
  type Zone,
} from './protocol.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';

type OrchestratorMethods = Pick<DaemonMethods, Extract<keyof DaemonMethods, `orchestrator.${string}`>>;

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
  'orchestrator.interrupt': 'interrupt',
  'orchestrator.close': 'close',
  'orchestrator.addEdge': 'add-edge',
  'orchestrator.removeEdge': 'remove-edge',
};

/**
 * Who acts through an orchestrator method: an orchestrator agent, or the user's side, a shell or the user
 * with no token, at board scope.
 */
interface Orchestrator extends Pick<Agent, 'sessionId' | 'name' | 'zoneId' | 'repoRoot'> {
  orchestrate: OrchestrateScope;
  /** The orchestrator agent; null on the user's side, whose agents and edges are the user's own. */
  agent: Agent | null;
}

/** The user with no token, as the log keeps it. */
const THE_USER: Orchestrator = { sessionId: 'user', name: 'you', zoneId: null, repoRoot: '', orchestrate: 'board', agent: null };

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

/** States an agent takes a message in: between turns, at its prompt (after a failed or rate-limited turn too). */
const SENDABLE_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['idle', 'waiting', 'scheduled', 'failed', 'rate-limited']);

export interface OrchestratorHostOptions extends BoardCallerSources {
  db: DatabaseSync;
  agents: Pick<AgentHost, 'get' | 'list' | 'fallbackOwner' | 'spawn' | 'answer' | 'interrupt' | 'stop' | 'finalMessage' | 'orchestrateFacts'>;
  zones: () => Zone[];
  flowEdges: Pick<FlowEdgeHost, 'create' | 'get' | 'remove'>;
  /** Deletes the agent with its worktree and branch, as `agent.delete` without `force` does. */
  deleteAgent(sessionId: string): Promise<void>;
  broadcast(event: DaemonEvent): void;
  log(message: string): void;
}

export interface OrchestratorHost {
  /** Writes a line of the activity log as `actor`, done or refused: a hand-off is any agent's. */
  logActivity: ActivityLogger;
  /** Whether the session may orchestrate: an agent's own, live, with `orchestrate` on, or one on the user's side. */
  mayOrchestrate(sessionId: string): boolean;
  /** Whether the session acts for the user (`BoardCaller.side`). */
  actsForUser(sessionId: string): boolean;
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
  /** Each wait's check, run on every agent update. */
  const waiters = new Set<{ check(): void; finish(timedOut: boolean): void }>();

  const mayOrchestrate = (sessionId: string): boolean => sessionCaller(options, sessionId)?.orchestrate != null;
  const actsForUser = (sessionId: string): boolean => sessionCaller(options, sessionId)?.side === 'user';

  /** Who acted, as the log keeps it: an orchestrator, or a tile that tried to be one. */
  type Actor = Pick<Agent, 'sessionId' | 'name'>;

  /** What a log line says beyond who and what: the agent acted on, and what was asked. Filled in as it is known. */
  interface Entry {
    on?: Pick<Agent, 'sessionId' | 'name'>;
    detail: string;
  }

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
        entry.on?.sessionId ?? null,
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
    const text = p.text ?? p.prompt;
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
   * Throws unless `me` may steer `agent` (send to it, interrupt or close it, or wire an edge into it): as
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
  const logged = async <T,>(me: Orchestrator, action: OrchestratorAction, entry: Entry, act: () => Promise<T> | T): Promise<T> => {
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
    if (!(await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok) throw invalidParams(`there is no branch ${name}`);
    const diff = await runGit(repoRoot, ['diff', '--name-only', '--end-of-options', 'HEAD', ref, '--', ...PROJECT_CONFIG_PATHS]);
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
    logActivity: record,
    mayOrchestrate,
    actsForUser,

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

    onEvent(event) {
      if (event.type === 'agent.updated') {
        if (awaitingTurn.has(event.agent.sessionId) && (event.agent.endedAt !== null || TURN_STATES.has(event.agent.state))) {
          awaitingTurn.delete(event.agent.sessionId);
        }
        notifyWaiters();
      } else if (event.type === 'agent.removed') {
        awaitingTurn.delete(event.sessionId);
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
            const role = optionalStringParam(p, 'role');
            if (role !== undefined && !AGENT_ROLES.includes(role as AgentRole)) throw invalidParams(`role must be ${AGENT_ROLES.join(', ')}`);
            const zoneId = optionalStringParam(p, 'zoneId') ?? me.zoneId;
            if (zoneId === null) throw invalidParams(`${me.agent === null ? 'you have' : 'your tile is in'} no zone: name the zone to start the agent in`);
            const zone = options.zones().find((each) => each.id === zoneId);
            if (zone === undefined) throw invalidParams(`no zone ${zoneId}`);
            entry.detail = `${harness} in ${zone.name}${prompt.trim() === '' ? '' : `: ${prompt.trim()}`}`;
            if (me.agent !== null && agents.orchestrateFacts(me.agent.sessionId).depth >= MAX_CREW_DEPTH - 1) {
              throw outOfScope(`you are ${MAX_CREW_DEPTH} agents deep in a crew, as deep as a crew goes: ask the agent that started you to start it`);
            }
            if (!SCOPES[me.orchestrate].zone(me, zone)) throw outOfScope(`${zone.name} is outside your scope (${scopeText(me)})`);
            checkText(prompt);
            const baseBranch = optionalStringParam(p, 'baseBranch');
            const repoRoot = zone.repoRoot ?? zone.defaultRepo;
            if (baseBranch !== undefined) {
              if (repoRoot === null) throw invalidParams(`${zone.name} has no repo to cut a branch from`);
              await checkBaseConfig(repoRoot, baseBranch);
            }
            const agent = await agents.spawn(
              {
                zoneId,
                harness: harness as Harness,
                model: optionalStringParam(p, 'model'),
                role: role as AgentRole | undefined,
                name: optionalStringParam(p, 'name'),
                branch: optionalStringParam(p, 'branch'),
                baseBranch,
                issueId: optionalStringParam(p, 'issueId'),
                prompt,
                ...SPAWN_SIZE,
              },
              me.agent?.sessionId,
            );
            if (agent.description !== '') awaitingTurn.add(agent.sessionId);
            entry.on = agent;
            return agent;
          });
        },

        'orchestrator.send': async (params, connection) => {
          const p = paramsObject(params);
          const me = orchestrator('orchestrator.send', p, connection);
          const entry: Entry = { detail: askedText(p) };
          return logged(me, 'send', entry, async () => {
            const text = stringParam(p, 'text');
            const to = agentNamed(stringParam(p, 'sessionId'));
            entry.on = to;
            checkSteerable(me, to);
            checkText(text);
            if (to.endedAt !== null) throw invalidParams(`${to.name} has ended`);
            if (to.permissions.length > 0 || to.state === 'needs-permission') {
              throw invalidParams(`${to.name} needs the user's permission first`);
            }
            // Waiting on the user mid-turn: what was typed would be queued into that turn, not answer it.
            if (waitsOnUser(to)) throw invalidParams(`${to.name} is waiting on the user's answer to its question or plan`);
            if (!SENDABLE_STATES.has(to.state)) {
              throw invalidParams(`${to.name} is ${to.state}: wait for its turn to end, or interrupt it, before sending`);
            }
            awaitingTurn.add(to.sessionId);
            try {
              await agents.answer(to.sessionId, text);
            } catch (error) {
              awaitingTurn.delete(to.sessionId);
              throw error;
            }
            return agents.get(to.sessionId)!;
          });
        },

        'orchestrator.wait': async (params, connection) => {
          const p = paramsObject(params);
          const me = orchestrator('orchestrator.wait', p, connection);
          const ids = p.sessionIds;
          if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_WAIT_AGENTS || !ids.every((id) => typeof id === 'string')) {
            throw invalidParams(`sessionIds must be 1 to ${MAX_WAIT_AGENTS} agent ids`);
          }
          for (const id of ids) target(me, id);
          const states = p.states === undefined ? SETTLED_STATES : p.states;
          if (!Array.isArray(states) || states.length === 0 || !states.every(isAgentState)) {
            throw invalidParams(`states must be some of ${AGENT_STATES.join(', ')}`);
          }
          const any = optionalBooleanParam(p, 'any') ?? false;
          const timeoutMs = Math.min(optionalCountParam(p, 'timeoutMs') ?? DEFAULT_ORCHESTRATOR_WAIT_MS, MAX_ORCHESTRATOR_WAIT_MS);
          return new Promise((resolveWait, rejectWait) => {
            const current = (): Agent[] =>
              (ids as string[]).map((id) => {
                const agent = agents.get(id);
                if (agent === undefined) throw invalidParams(`agent ${id} was deleted`);
                return agent;
              });
            const there = (agent: Agent) => !awaitingTurn.has(agent.sessionId) && (states as AgentState[]).includes(agent.state);
            const waiter = {
              check() {
                try {
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
                  resolveWait({ agents: current(), timedOut });
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

        'orchestrator.interrupt': (params, connection) => {
          const p = paramsObject(params);
          const me = orchestrator('orchestrator.interrupt', p, connection);
          const entry: Entry = { detail: '' };
          return logged(me, 'interrupt', entry, () => {
            const agent = agentNamed(stringParam(p, 'sessionId'));
            entry.on = agent;
            checkSteerable(me, agent);
            return agents.interrupt(agent.sessionId);
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
            entry.on = agent;
            checkSteerable(me, agent);
            if (!remove) return agents.stop(agent.sessionId);
            // The user's side removes any agent, as the user does in the app; never forced, so unsaved work stands.
            if (me.agent === null) {
              await options.deleteAgent(agent.sessionId);
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
            await options.deleteAgent(agent.sessionId);
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
            entry.on = to;
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
            entry.on = to;
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
