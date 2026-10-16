// The board MCP over Streamable HTTP (ADR-0010), served by the daemon on its hook listener at `/mcp`, so an agent's
// harness posts to the daemon instead of starting an `agent-board mcp` process of its own. The handlers are the stdio
// server's (`board-mcp.ts`); this is only the transport. Stateless: each POST carries its session's board token, which
// the hook listener checks before it gets here, and no `Mcp-Session-Id` is handed out.
import type { ServerResponse } from 'node:http';
import type { McpCall, McpMethods } from './board-mcp.ts';
import { RPC_ERROR } from './protocol.ts';
import { handleRpcLine, type RpcHandlers } from './rpc.ts';

/** How often a tool call's event stream says it is still alive: well inside a client's idle timeout (Claude's is 5 min). */
const KEEP_ALIVE_MS = 15_000;

/** Whom a POST is from, once its token is checked: its session, and the MCP handlers acting as it. */
export interface McpHttpCaller {
  sessionId: string;
  handlers: RpcHandlers<McpMethods, McpCall>;
}

export interface BoardMcpHttp {
  /** Answers one POSTed JSON-RPC message, `body`, from `caller`. */
  serve(body: string, response: ServerResponse, caller: McpHttpCaller): void;
}

/**
 * One JSON-RPC message per POST (no batches, as in revision 2025-06-18). A notification is answered 202 with no body. A
 * request is answered with its JSON, but a tool call with an event stream: its headers at once and a comment line
 * every `keepAliveMs`, since `ask`, `present_plan` and `wait` hold it for minutes and a client gives up on a request
 * that says nothing that long. A call ends, and hears no answer, when its client hangs up or posts
 * `notifications/cancelled`; either closes its daemon connection, which ends what it waits on.
 */
export function createBoardMcpHttp({ keepAliveMs = KEEP_ALIVE_MS }: { keepAliveMs?: number } = {}): BoardMcpHttp {
  /** The calls under way, by session and request id, so a client can cancel one. */
  const calls = new Map<string, AbortController>();
  const callKey = (sessionId: string, id: unknown) => `${sessionId} ${JSON.stringify(id)}`;

  return {
    serve(body, response, { sessionId, handlers }) {
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        return replyJson(response, 400, rpcError(RPC_ERROR.parse, 'parse error'));
      }
      if (typeof message !== 'object' || message === null || Array.isArray(message)) {
        return replyJson(response, 400, rpcError(RPC_ERROR.invalidRequest, 'one JSON-RPC message per request'));
      }
      const { id, method, params } = message as { id?: unknown; method?: unknown; params?: { requestId?: unknown } };
      // A notification, or a response to a request this server never makes: nothing to answer.
      if (id === undefined) {
        if (method === 'notifications/cancelled') calls.get(callKey(sessionId, params?.requestId))?.abort();
        response.writeHead(202).end();
        return;
      }

      const key = callKey(sessionId, id);
      const controller = new AbortController();
      calls.set(key, controller);
      const stream = method === 'tools/call';
      let keepAlive: NodeJS.Timeout | undefined;
      if (stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        response.flushHeaders();
        keepAlive = setInterval(() => response.write(': keep-alive\n\n'), keepAliveMs);
      }
      response.once('close', () => {
        clearInterval(keepAlive);
        if (!response.writableFinished) controller.abort();
      });

      void handleRpcLine(body, handlers, { signal: controller.signal }).then((reply) => {
        clearInterval(keepAlive);
        if (calls.get(key) === controller) calls.delete(key);
        if (response.destroyed) return;
        if (controller.signal.aborted) {
          response.end();
          return;
        }
        if (stream) response.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
        else replyJson(response, 200, reply);
      });
    },
  };
}

function rpcError(code: number, message: string) {
  return { jsonrpc: '2.0', id: null, error: { code, message } };
}

function replyJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
