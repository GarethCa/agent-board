import type { AgentHost } from './agents.ts';
import type { FlowEdgeHost } from './flow-edges.ts';
import { paneIds } from './pane-layout.ts';
import { invalidParams, optionalStringParam, paramsObject, stringParam } from './params.ts';
import {
  BOARD_CALLER_METHODS,
  BOARD_ERROR,
  ORCHESTRATOR_METHODS,
  USER_SIDE_METHODS,
  type Agent,
  type BoardCaller,
  type DaemonMethod,
  type DaemonMethods,
  type HandoffOutcome,
  type OrchestratorAction,
} from './protocol.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import type { SessionHost } from './sessions.ts';
import type { ShellHost } from './shells.ts';

/** The `board.*` methods here; a question and a plan wait on the user, so `asks.ts` has them, and `gate-actions.ts` opening a pull request. */
type BoardMethods = Pick<DaemonMethods, Exclude<Extract<keyof DaemonMethods, `board.${string}`>, 'board.ask' | 'board.presentPlan' | 'board.openPullRequest'>>;

/**
 * A connection, as the board methods see it: the session whose board token it presented, if it has, and a signal
 * that aborts once it closes (a wait it made stops then).
 */
export interface BoardConnection {
  boardSession?: string;
  closed?: AbortSignal;
}

/**
 * `handlers` for connections that may have presented a board token (ADR-0010): once one has, every method outside
 * `BOARD_CALLER_METHODS` refuses it with `BOARD_ERROR.notAllowed`, however it reached the socket (the CLI, its `rpc`,
 * the MCP server), but for `ORCHESTRATOR_METHODS` while `mayOrchestrate` says its session may (ADR-0011), which each
 * of those methods checks again for the token it is given, and for `USER_SIDE_METHODS` while its session is on the
 * user's side: a shell turns an agent's orchestrating on and off, and changes no setting. A connection that
 * never presents one is the user's, and keeps the whole API.
 */
export function guardBoardCallers<Context extends BoardConnection>(
  handlers: RpcHandlers<DaemonMethods, Context>,
  orchestrators: {
    mayOrchestrate(sessionId: string): boolean;
    /** Whether the session acts for the user (`BoardCaller.side`). */
    actsForUser(sessionId: string): boolean;
    /** Why the session may not orchestrate, for the refusal. */
    notOrchestrating(sessionId: string): string;
    /** Hears an orchestrator method refused here, to log the attempt. */
    refused(sessionId: string, method: DaemonMethod, params: unknown, reason: string): void;
  },
): RpcHandlers<DaemonMethods, Context> {
  const guarded: Record<string, (params: unknown, context: Context) => unknown> = {};
  for (const [method, handler] of Object.entries(handlers) as [DaemonMethod, (params: unknown, context: Context) => unknown][]) {
    const orchestrating = ORCHESTRATOR_METHODS.has(method);
    const userSide = USER_SIDE_METHODS.has(method);
    guarded[method] = BOARD_CALLER_METHODS.has(method)
      ? handler
      : (params, context) => {
          const session = context.boardSession;
          if (session === undefined) return handler(params, context);
          if (userSide && orchestrators.actsForUser(session)) return handler(params, context);
          if (!(orchestrating && orchestrators.mayOrchestrate(session))) {
            const reason = orchestrating
              ? `${method} is only for an orchestrator. ${orchestrators.notOrchestrating(session)}`
              : `${method} is not open to a session's board token: an agent may read the board, set its own status, ` +
                'hand off, ask the user a question or present a plan and, if the user lets it orchestrate, use the ' +
                'orchestrator commands; a shell may also turn an agent\'s orchestrating on and off; nothing more';
            if (orchestrating) orchestrators.refused(session, method, params, reason);
            throw new RpcMethodError(BOARD_ERROR.notAllowed, reason);
          }
          return handler(params, context);
        };
  }
  return guarded as RpcHandlers<DaemonMethods, Context>;
}

/** What `boardCaller` needs to know. */
export interface BoardCallerSources {
  sessions: Pick<SessionHost, 'sessionForBoardToken'>;
  agents: Pick<AgentHost, 'get' | 'fallbackOwner'>;
  shells: Pick<ShellHost, 'list'>;
}

/**
 * Who holds `token`, a session's board token; the connection is that session's from then on. Throws
 * `BOARD_ERROR.unknownToken` for a token no live session holds.
 */
export function boardCaller(sources: BoardCallerSources, token: string, connection: BoardConnection): BoardCaller {
  const sessionId = sources.sessions.sessionForBoardToken(token);
  if (sessionId === undefined) {
    throw new RpcMethodError(BOARD_ERROR.unknownToken, 'unknown board token: no live session holds it');
  }
  connection.boardSession = sessionId;
  const caller = sessionCaller(sources, sessionId);
  if (caller === undefined) throw new RpcMethodError(BOARD_ERROR.unknownToken, 'unknown board token: its session has no tile');
  return caller;
}

/**
 * Whether `sessionId` is the agent's own live session, which speaks as the agent (`BoardCaller.side`); any other session
 * that speaks for its tile (its ended pane's shell, a tab in its window) is on the user's side.
 */
export function isOwnLiveSession(agent: Pick<Agent, 'sessionId' | 'endedAt'>, sessionId: string): boolean {
  return agent.sessionId === sessionId && agent.endedAt === null;
}

/**
 * The tile the live session `sessionId` speaks for, as `boardCaller` says; undefined for a session with none. Only an
 * agent's own live session acts as the agent; every other acts for the user, at board scope.
 */
export function sessionCaller(sources: Omit<BoardCallerSources, 'sessions'>, sessionId: string): BoardCaller | undefined {
  const { agents, shells } = sources;
  const user = { side: 'user', orchestrate: 'board' } as const;
  // An ended agent's pane drops into a shell: that shell speaks for its agent's tile, on the user's side. The agent's
  // own session is the agent's, ended or not: a connection it identified on never turns into the user's.
  const agent = agents.get(agents.fallbackOwner(sessionId) ?? sessionId);
  if (agent !== undefined) {
    const own = sessionId === agent.sessionId;
    const side = own ? ({ side: 'agent', orchestrate: isOwnLiveSession(agent, sessionId) ? agent.orchestrate : null } as const) : user;
    return { sessionId, kind: 'agent', tileId: agent.sessionId, name: agent.name, zoneId: agent.zoneId, ...side };
  }
  const all = shells.list();
  const holder = all.find((candidate) => paneIds(candidate.layout).includes(sessionId));
  // A pane in a tab speaks for the tab's owner: a shell tile's tile, or an agent's.
  const owner = holder?.owner;
  if (owner?.kind === 'agent') {
    const tabOf = agents.get(owner.id);
    return tabOf === undefined ? undefined : { sessionId, kind: 'agent', tileId: tabOf.sessionId, name: tabOf.name, zoneId: tabOf.zoneId, ...user };
  }
  const shell = owner?.kind === 'shell' ? all.find((candidate) => candidate.id === owner.id) : holder;
  if (shell !== undefined) return { sessionId, kind: 'shell', tileId: shell.id, name: shell.name, zoneId: shell.zoneId, ...user };
  return undefined;
}

/** Writes a line of the activity log (`orchestrator.activity`): who did, or tried (`refused` why), what to whom. */
export type ActivityLogger = (
  actor: Pick<Agent, 'sessionId' | 'name'>,
  action: OrchestratorAction,
  entry: { on?: Pick<Agent, 'sessionId' | 'name'>; detail: string },
  refused?: string,
) => void;

/**
 * The `board.*` RPC handlers (ADR-0010): what the agent-facing CLI and MCP add to the methods the app uses. Each takes
 * the caller's board token and acts as the session holding it, so an agent can set only its own status, and hand off
 * only along its own edges, or to an agent it names in its scope over a one-off edge, each hand-off
 * logged.
 */
export function boardHandlers<Context extends BoardConnection>(
  options: BoardCallerSources & {
    agents: Pick<AgentHost, 'setStatus' | 'get'>;
    flowEdges: Pick<FlowEdgeHost, 'handOffExplicitly'>;
    logActivity: ActivityLogger;
    /** Throws unless the agent may name `to` in a hand-off with no edge to it (`OrchestratorHost.checkHandoffTarget`). */
    checkHandoffTarget(from: string, to: string): void;
  },
): RpcHandlers<BoardMethods, Context> {
  const { agents } = options;
  const caller = (params: Record<string, unknown>, connection: Context): BoardCaller =>
    boardCaller(options, stringParam(params, 'token'), connection);

  return {
    'board.identify': (params, connection) => caller(paramsObject(params), connection),
    'board.setStatus': (params, connection) => {
      const p = paramsObject(params);
      const who = caller(p, connection);
      if (who.kind !== 'agent') throw invalidParams('only an agent has a status; this is a shell tile');
      return agents.setStatus(who.tileId, stringParam(p, 'summary'), p.progress === undefined ? null : (p.progress as number));
    },
    'board.handoff': async (params, connection) => {
      const p = paramsObject(params);
      const who = caller(p, connection);
      const actor = { sessionId: who.tileId, name: who.name };
      const to = optionalStringParam(p, 'to');
      const target = to === undefined ? undefined : agents.get(to);
      const logOutcome = (outcome: HandoffOutcome) => {
        const reason = outcome.reason === null ? '' : ` (${outcome.reason})`;
        options.logActivity(actor, 'handoff', { on: agents.get(outcome.to), detail: `${outcome.name}: ${outcome.outcome}${reason}` });
      };
      let outcomes;
      try {
        const me = who.kind === 'agent' ? agents.get(who.tileId) : undefined;
        // Its own session's alone: never a shell tile's, an ended agent's shell's, or a tab's in its window.
        if (me === undefined || !isOwnLiveSession(me, who.sessionId)) {
          throw invalidParams('only a live agent hands off, from its own session: not a shell, nor an ended agent\'s shell');
        }
        outcomes = await options.flowEdges.handOffExplicitly(
          me.sessionId,
          {
            message: optionalStringParam(p, 'message'),
            handoverPath: optionalStringParam(p, 'handoverPath'),
            json: p.json,
          },
          to,
          // One still being checked as it answered is logged again once it is delivered, held, queued or skipped.
          logOutcome,
          // A named agent it has no edge to gets a one-off edge, in its scope.
          (target) => options.checkHandoffTarget(me.sessionId, target),
        );
      } catch (error) {
        options.logActivity(actor, 'handoff', { on: target, detail: '' }, (error as Error).message);
        throw error;
      }
      for (const outcome of outcomes) logOutcome(outcome);
      return outcomes;
    },
  };
}
