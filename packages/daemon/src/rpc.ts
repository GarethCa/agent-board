import { randomBytes } from 'node:crypto';
import { RPC_ERROR } from './protocol.ts';

export type RpcId = string | number | null;

export interface RpcRequest {
  jsonrpc: '2.0';
  id?: RpcId;
  method: string;
  params?: unknown;
}

export type RpcResponse =
  | { jsonrpc: '2.0'; id: RpcId; result: unknown }
  | { jsonrpc: '2.0'; id: RpcId; error: { code: number; message: string; data?: unknown } };

/** Thrown by a handler to answer with a specific JSON-RPC error code; any other error becomes `internal`. */
export class RpcMethodError extends Error {
  readonly code: number;
  /**
   * For a refusal that names what it refuses ("Alpha can't be paused: it is mid-turn"), the reason alone ("it is
   * mid-turn"), for a caller in the daemon that shows the name itself. Not sent to the client.
   */
  readonly reason: string | undefined;

  constructor(code: number, message: string, reason?: string) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

/**
 * A method table: each method's handler takes its params and the calling connection's context, and returns (or
 * resolves to) its result.
 */
export type RpcHandlers<Methods extends { [M in keyof Methods]: { params: unknown; result: unknown } }, Context = undefined> = {
  [M in keyof Methods]: (
    params: Methods[M]['params'],
    context: Context,
  ) => Methods[M]['result'] | Promise<Methods[M]['result']>;
};

/** The built-in errors a bug throws (reading a property of undefined, a bad `JSON.parse`), never one a method means. */
const BUG_ERRORS = [TypeError, RangeError, ReferenceError, SyntaxError, EvalError, URIError];

/**
 * Whether `error` is a bug or a failure of the runtime's own (a database error, a Node `ERR_` code), not something a
 * method threw for its caller to read: a built-in error type, a Node error code, or not an `Error` at all. A plain
 * `Error`, or a class of the daemon's own (`RpcMethodError`, a tracker's error), says what went wrong in words.
 */
function isInternal(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  if (error instanceof RpcMethodError) return false;
  if (BUG_ERRORS.some((type) => error instanceof type)) return true;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('ERR_');
}

export interface RpcLineOptions {
  /**
   * Writes a line to the daemon's log. Given, every error but an `RpcMethodError` is logged there whole, with its stack
   * and an id. A bug's (`isInternal`) is then told plainly: the client hears only that something went wrong in the
   * method, with the id that finds the line. Any other keeps its own words.
   */
  log?(line: string): void;
  /** Where the daemon's log is, for the plain message to say. */
  logPath?: string;
}

/** What the client hears of `error`, thrown by `method`: logged, and a bug's told plainly, when there is a log. */
function errorMessage(method: string, error: unknown, options: RpcLineOptions): string {
  const own = error instanceof Error ? error.message : String(error);
  if (options.log === undefined || error instanceof RpcMethodError) return own;
  const id = randomBytes(3).toString('hex');
  const internal = isInternal(error);
  // A bug's whole stack; an error worded on purpose (git's stderr, say) only its first line, which says what failed.
  const detail = !internal ? (own.split('\n', 1)[0] ?? '') : error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : own;
  options.log(`rpc ${method} failed (error ${id}): ${withoutCredentials(detail)}`);
  if (!internal) return own;
  const where = options.logPath === undefined ? 'the daemon log' : `the daemon log (${options.logPath})`;
  return `Something went wrong in ${method} (error ${id}). Details are in ${where}.`;
}

/** `text` with the user and password of any URL in it (`https://user:token@host`) replaced by `***`. */
export function withoutCredentials(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
}

/** Handles one line from a client: the response to write, or undefined for a notification. */
export async function handleRpcLine<
  Methods extends { [M in keyof Methods]: { params: unknown; result: unknown } },
  Context = undefined,
>(line: string, handlers: RpcHandlers<Methods, Context>, context: Context, options: RpcLineOptions = {}): Promise<RpcResponse | undefined> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return rpcError(null, RPC_ERROR.parse, 'parse error');
  }
  if (!isRequest(message)) {
    const id = (message as { id?: unknown } | null)?.id;
    return rpcError(isId(id) ? id : null, RPC_ERROR.invalidRequest, 'invalid request');
  }
  // Params arrive untyped off the wire; each handler is responsible for its own.
  const handler = Object.hasOwn(handlers, message.method)
    ? (handlers[message.method as keyof Methods] as (params: unknown, context: Context) => unknown)
    : undefined;
  let response: RpcResponse;
  if (handler === undefined) {
    response = rpcError(message.id ?? null, RPC_ERROR.methodNotFound, `method not found: ${message.method}`);
  } else {
    try {
      response = { jsonrpc: '2.0', id: message.id ?? null, result: (await handler(message.params, context)) ?? null };
    } catch (error) {
      const code = error instanceof RpcMethodError ? error.code : RPC_ERROR.internal;
      response = rpcError(message.id ?? null, code, errorMessage(message.method, error, options));
    }
  }
  return message.id === undefined ? undefined : response;
}

function rpcError(id: RpcId, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isId(value: unknown): value is RpcId {
  return value === null || typeof value === 'string' || typeof value === 'number';
}

function isRequest(value: unknown): value is RpcRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return message.jsonrpc === '2.0' && typeof message.method === 'string' && (message.id === undefined || isId(message.id));
}
