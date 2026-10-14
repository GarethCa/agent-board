import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HookReply } from './permissions.ts';
import type { Harness } from './protocol.ts';

/** Largest hook body accepted. Hook payloads are small; transcripts travel by path, not inline. */
const MAX_BODY_BYTES = 1024 * 1024;

/** A new per-session token, handed to the session in its environment. */
export function newHookToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database stores in place of the token. */
export function hashHookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

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
  /** The SHA-256 of the token the global hooks of external sessions post with. */
  externalTokenSha256?: string;
  /** A global hook's call for a session agent-board did not spawn; the payload carries its `session_id`. */
  onExternalHook?(harness: Harness, payload: Record<string, unknown>): void;
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
 *
 * Anything without a valid token is refused before its body is read. The reply is 200 with the handler's JSON, or
 * with no body when it has nothing to say.
 */
export async function startHookIngress(options: HookIngressOptions): Promise<HookIngress> {
  const server = createServer((request, response) => {
    const external = /^\/external\/(claude|codex)$/.exec(request.url ?? '')?.[1] as Harness | undefined;
    if (request.url !== '/hooks' && external === undefined) return reply(response, 404, 'not found');
    if (request.method !== 'POST') return reply(response, 405, 'use POST');
    const token = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
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

  /** An agent's hooks, if `token` is a live session's. */
  const sessionHandler = (token: string): HookHandler | undefined => {
    const sessionId = options.sessionForToken(hashHookToken(token));
    if (sessionId === undefined) return undefined;
    return (payload, signal) => options.onHook(sessionId, payload.hook_event_name, payload, signal);
  };

  /** External sessions' hooks for `harness`, if `token` is the external hook token. */
  const externalHandler = (token: string, harness: Harness): HookHandler | undefined => {
    const { externalTokenSha256: expected, onExternalHook } = options;
    if (expected === undefined || onExternalHook === undefined || !sameHash(hashHookToken(token), expected)) return undefined;
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

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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

function reply(response: ServerResponse, status: number, message?: string): void {
  if (response.headersSent) return;
  if (message === undefined) {
    response.writeHead(status).end();
  } else {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(`${message}\n`);
  }
}
