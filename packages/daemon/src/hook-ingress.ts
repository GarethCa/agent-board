import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBoardMcpHttp, type BoardMcpHttp, type McpHttpCaller } from './board-mcp-http.ts';
import type { HookReply } from './permissions.ts';
import type { Harness } from './protocol.ts';
import { hashToken } from './tokens.ts';

/** Largest hook body accepted. Hook payloads are small; transcripts travel by path, not inline. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Largest board MCP message accepted: a plan's HTML or a handoff's JSON travels inline. */
const MAX_MCP_BODY_BYTES = 16 * 1024 * 1024;

/** The hosts a browser page posting to `/mcp` may come from: none but this machine's own (DNS rebinding). */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface HookIngressOptions {
  /** The live session whose token hashes to `tokenSha256`, if any. */
  sessionForToken(tokenSha256: string): string | undefined;
  /**
   * Handles a hook call; what it returns or resolves to is the hook's reply. `signal` aborts if the harness hangs up
   * before then (e.g. its hook timed out).
   */
  onHook(
    sessionId: string,
    event: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): HookReply | Promise<HookReply>;
  /** What Claude Code passed an agent's status line, posted by it (`claudeSettings`): its plan usage, mostly. */
  onStatusLine?(sessionId: string, payload: Record<string, unknown>): void;
  /** The SHA-256 of the token the global hooks of external sessions post with. */
  externalTokenSha256?: string;
  /** A global hook's call for a session agent-board did not spawn; the payload carries its `session_id`. */
  onExternalHook?(harness: Harness, payload: Record<string, unknown>): void;
  /** The board MCP's caller for a session's board token (ADR-0010), if a live session holds it. No `/mcp` without. */
  mcpCallerFor?(boardToken: string): McpHttpCaller | undefined;
}

type HookPayload = Record<string, unknown> & { hook_event_name: string };

/** What a route does with an accepted hook call: its reply. It throws `RefusedHook` for a payload it can't take. */
type HookHandler = (payload: HookPayload, signal: AbortSignal) => HookReply | Promise<HookReply>;

/** A payload a route can't take: answered 400 with the message. */
class RefusedHook extends Error {}

export interface HookIngress {
  port: number;
  close(): Promise<void>;
}

/**
 * The localhost HTTP listener harness hooks post to (ADR-0002), with `Authorization: Bearer <token>` and the hook's
 * JSON payload:
 *
 * - `POST /hooks`: an agent's hooks. The per-session token identifies the session.
 * - `POST /external/<harness>`: the opt-in global hooks of sessions agent-board did not spawn (ADR-0004). One
 *   daemon-wide token; the payload's `session_id` identifies the session. The reply is always empty, so these hooks
 *   never steer their session.
 * - `POST /usage`: what Claude Code passed an agent's status line, with the agent's hook token. The reply is empty.
 * - `POST /mcp`: the board MCP over Streamable HTTP (ADR-0010, `board-mcp-http.ts`). The token is the session's board
 *   token, not its hook token, so the call can do what the session's `agent-board mcp` could and no more.
 *
 * Anything without a valid token is refused before its body is read. A hook's reply is 200 with the handler's JSON,
 * or with no body when it has nothing to say.
 */
export async function startHookIngress(options: HookIngressOptions): Promise<HookIngress> {
  const mcp = options.mcpCallerFor === undefined ? undefined : createBoardMcpHttp();
  const server = createServer((request, response) => {
    if (request.url === '/mcp' && mcp !== undefined) return mcpRequest(request, response, mcp);
    if (request.url === '/usage' && options.onStatusLine !== undefined) return statusLineRequest(request, response, options.onStatusLine);
    const external = /^\/external\/(claude|codex)$/.exec(request.url ?? '')?.[1] as Harness | undefined;
    if (request.url !== '/hooks' && external === undefined) return reply(response, 404, 'not found');
    if (request.method !== 'POST') return reply(response, 405, 'use POST');
    const token = bearerToken(request);
    const handler = token === undefined ? undefined : external === undefined ? sessionHandler(token) : externalHandler(token, external);
    if (handler === undefined) return reply(response, 401, `missing or unknown ${external ? 'external hook' : 'session'} token`);

    readBody(request).then(
      (body) => {
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          return reply(response, 400, 'hook body must be JSON');
        }
        if (!isHookPayload(payload)) return reply(response, 400, 'hook body must be an object with hook_event_name');
        const hungUp = new AbortController();
        response.once('close', () => {
          if (!response.writableFinished) hungUp.abort();
        });
        new Promise<HookReply>((resolve) => resolve(handler(payload, hungUp.signal))).then(
          (body) => (body === undefined ? reply(response, 200) : replyJson(response, body)),
          (error: Error) => reply(response, error instanceof RefusedHook ? 400 : 500, error.message),
        );
      },
      (error: Error) => reply(response, error.message === 'too large' ? 413 : 400, error.message),
    );
  });

  /** A board MCP message, from a live session holding the board token it carries and from no web page. */
  const mcpRequest = (request: IncomingMessage, response: ServerResponse, transport: BoardMcpHttp) => {
    // No GET: the server never starts a stream of its own, and a client then makes do with POSTs.
    if (request.method !== 'POST') return reply(response, 405, 'use POST', { allow: 'POST' });
    if (!localOrigin(request.headers.origin)) return reply(response, 403, 'the board MCP takes no requests from web pages');
    const token = bearerToken(request);
    const caller = token === undefined ? undefined : options.mcpCallerFor!(token);
    if (caller === undefined) return reply(response, 401, 'missing or unknown board token');
    readBody(request, MAX_MCP_BODY_BYTES).then(
      (body) => transport.serve(body, response, caller),
      (error: Error) => reply(response, error.message === 'too large' ? 413 : 400, error.message),
    );
  };

  /** An agent's status line input, from a live session holding the hook token it carries. */
  const statusLineRequest = (request: IncomingMessage, response: ServerResponse, onStatusLine: NonNullable<HookIngressOptions['onStatusLine']>) => {
    if (request.method !== 'POST') return reply(response, 405, 'use POST');
    const token = bearerToken(request);
    const sessionId = token === undefined ? undefined : options.sessionForToken(hashToken(token));
    if (sessionId === undefined) return reply(response, 401, 'missing or unknown session token');
    readBody(request).then(
      (body) => {
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          return reply(response, 400, 'status line body must be JSON');
        }
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return reply(response, 400, 'status line body must be an object');
        onStatusLine(sessionId, payload as Record<string, unknown>);
        reply(response, 200);
      },
      (error: Error) => reply(response, error.message === 'too large' ? 413 : 400, error.message),
    );
  };

  /** An agent's hooks, if `token` is a live session's. */
  const sessionHandler = (token: string): HookHandler | undefined => {
    const sessionId = options.sessionForToken(hashToken(token));
    if (sessionId === undefined) return undefined;
    return (payload, signal) => options.onHook(sessionId, payload.hook_event_name, payload, signal);
  };

  /** External sessions' hooks for `harness`, if `token` is the external hook token. */
  const externalHandler = (token: string, harness: Harness): HookHandler | undefined => {
    const { externalTokenSha256: expected, onExternalHook } = options;
    if (expected === undefined || onExternalHook === undefined || !sameHash(hashToken(token), expected)) return undefined;
    return (payload) => {
      if (typeof payload.session_id !== 'string') throw new RefusedHook('hook body must have a session_id');
      onExternalHook(harness, payload);
      return undefined;
    };
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function bearerToken(request: IncomingMessage): string | undefined {
  return /^Bearer (\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
}

/** Whether a request's `Origin`, if it has one, is a page of this machine's. Harnesses send none. */
function localOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function sameHash(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function isHookPayload(value: unknown): value is HookPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { hook_event_name?: unknown }).hook_event_name === 'string'
  );
}

function readBody(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('too large'));
        request.removeAllListeners('data');
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
    // An aborted upload emits close without end; settle so nothing is left pending.
    request.on('close', () => {
      if (!request.complete) reject(new Error('aborted'));
    });
  });
}

function replyJson(response: ServerResponse, body: Record<string, unknown>): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function reply(response: ServerResponse, status: number, message?: string, headers: Record<string, string> = {}): void {
  if (response.headersSent) return;
  if (message === undefined) {
    response.writeHead(status, headers).end();
  } else {
    response.writeHead(status, { ...headers, 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(`${message}\n`);
  }
}
