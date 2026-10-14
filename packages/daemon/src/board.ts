import type { AgentHost } from './agents.ts';
import { paneIds } from './pane-layout.ts';
import { invalidParams, paramsObject, stringParam } from './params.ts';
import { BOARD_CALLER_METHODS, BOARD_ERROR, type BoardCaller, type DaemonMethod, type DaemonMethods } from './protocol.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import type { SessionHost } from './sessions.ts';
import type { ShellHost } from './shells.ts';

type BoardMethods = Pick<DaemonMethods, Extract<keyof DaemonMethods, `board.${string}`>>;

/** A connection, as the board methods see it: the session whose board token it presented, if it has. */
export interface BoardConnection {
  boardSession?: string;
}

/**
 * `handlers` for connections that may have presented a board token (ADR-0010): once one has, every method outside
 * `BOARD_CALLER_METHODS` refuses it with `BOARD_ERROR.notAllowed`, however it reached the socket (the CLI, its `rpc`,
 * the MCP server). A connection that never presents one is the user's, and keeps the whole API.
 */
export function guardBoardCallers<Context extends BoardConnection>(
  handlers: RpcHandlers<DaemonMethods, Context>,
): RpcHandlers<DaemonMethods, Context> {
  const guarded: Record<string, (params: unknown, context: Context) => unknown> = {};
  for (const [method, handler] of Object.entries(handlers) as [DaemonMethod, (params: unknown, context: Context) => unknown][]) {
    guarded[method] = BOARD_CALLER_METHODS.has(method)
      ? handler
      : (params, context) => {
          if (context.boardSession !== undefined) {
            throw new RpcMethodError(
              BOARD_ERROR.notAllowed,
              `${method} is not open to a session's board token: an agent may read the board and set its own status, nothing more`,
            );
          }
          return handler(params, context);
        };
  }
  return guarded as RpcHandlers<DaemonMethods, Context>;
}

/**
 * The `board.*` RPC handlers (ADR-0010): what the agent-facing CLI and MCP add to the methods the app uses. Each takes
 * the caller's board token and acts as the session holding it, so an agent can set only its own status.
 */
export function boardHandlers<Context extends BoardConnection>(options: {
  sessions: Pick<SessionHost, 'sessionForBoardToken'>;
  agents: Pick<AgentHost, 'get' | 'setStatus' | 'fallbackOwner'>;
  shells: Pick<ShellHost, 'list'>;
}): RpcHandlers<BoardMethods, Context> {
  const { sessions, agents, shells } = options;

  /** Who holds the token in `params`; the connection is that session's from then on. */
  const caller = (params: Record<string, unknown>, connection: Context): BoardCaller => {
    const sessionId = sessions.sessionForBoardToken(stringParam(params, 'token'));
    if (sessionId === undefined) {
      throw new RpcMethodError(BOARD_ERROR.unknownToken, 'unknown board token: no live session holds it');
    }
    connection.boardSession = sessionId;
    // An ended agent's pane drops into a shell: that shell speaks for its agent's tile.
    const agent = agents.get(agents.fallbackOwner(sessionId) ?? sessionId);
    if (agent !== undefined) {
      return { sessionId, kind: 'agent', tileId: agent.sessionId, name: agent.name, zoneId: agent.zoneId };
    }
    const shell = shells.list().find((candidate) => paneIds(candidate.layout).includes(sessionId));
    if (shell !== undefined) return { sessionId, kind: 'shell', tileId: shell.id, name: shell.name, zoneId: shell.zoneId };
    throw new RpcMethodError(BOARD_ERROR.unknownToken, 'unknown board token: its session has no tile');
  };

  return {
    'board.identify': (params, connection) => caller(paramsObject(params), connection),
    'board.setStatus': (params, connection) => {
      const p = paramsObject(params);
      const who = caller(p, connection);
      if (who.kind !== 'agent') throw invalidParams('only an agent has a status; this is a shell tile');
      return agents.setStatus(who.tileId, stringParam(p, 'summary'), p.progress === undefined ? null : (p.progress as number));
    },
  };
}
