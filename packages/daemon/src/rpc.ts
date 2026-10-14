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

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
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

/** Handles one line from a client: the response to write, or undefined for a notification. */
export async function handleRpcLine<
  Methods extends { [M in keyof Methods]: { params: unknown; result: unknown } },
  Context = undefined,
>(line: string, handlers: RpcHandlers<Methods, Context>, context: Context): Promise<RpcResponse | undefined> {
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
      response = rpcError(message.id ?? null, code, (error as Error).message);
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
