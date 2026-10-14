import { createConnection, type Socket } from 'node:net';
import { EVENT_METHOD, MAX_LINE_LENGTH, lineSplitter, type DaemonEvent, type DaemonMethod, type DaemonMethods } from './protocol.ts';
import type { RpcResponse } from './rpc.ts';

export class DaemonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export interface DaemonClient {
  call<M extends DaemonMethod>(
    method: M,
    ...params: DaemonMethods[M]['params'] extends undefined ? [] : [DaemonMethods[M]['params']]
  ): Promise<DaemonMethods[M]['result']>;
  /** Subscribes to the daemon's event stream. Returns the unsubscribe function. */
  onEvent(listener: (event: DaemonEvent) => void): () => void;
  close(): void;
  /** Resolves when the connection ends, from either side. */
  closed: Promise<void>;
}

/** Connects to a daemon's socket. Rejects if nothing is listening. */
export async function connectDaemon(socketPath: string): Promise<DaemonClient> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });

  const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  const listeners = new Set<(event: DaemonEvent) => void>();
  let nextId = 1;

  const feed = lineSplitter((line) => {
    let message: RpcResponse | { method: string; params: DaemonEvent };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if ('method' in message) {
      if (message.method === EVENT_METHOD) for (const listener of listeners) listener(message.params);
      return;
    }
    const call = typeof message.id === 'number' ? pending.get(message.id) : undefined;
    if (call === undefined) return;
    pending.delete(message.id as number);
    if ('error' in message) call.reject(new DaemonRpcError(message.error.code, message.error.message, message.error.data));
    else call.resolve(message.result);
  });

  /** Why we dropped the connection, if we did. */
  let failure: Error | undefined;
  const closed = new Promise<void>((resolve) => {
    socket.on('close', () => {
      for (const call of pending.values()) call.reject(failure ?? new Error('daemon connection closed'));
      pending.clear();
      resolve();
    });
  });
  socket.on('error', () => socket.destroy());
  socket.setEncoding('utf8').on('data', (chunk: string) => {
    if (feed(chunk)) return;
    failure = new Error(`daemon connection closed: the daemon sent a message longer than ${MAX_LINE_LENGTH} characters`);
    socket.destroy();
  });

  return {
    call(method, ...params) {
      if (socket.destroyed) return Promise.reject(failure ?? new Error('daemon connection closed'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: params[0] })}\n`);
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => socket.end(),
    closed,
  };
}

export interface EnsureDaemonOptions {
  socketPath: string;
  /**
   * Starts a daemon, e.g. with `spawnDetachedDaemon`. Called at most once per `ensureDaemon`. It may return a promise
   * that settles when the started process exits: a rejection (the daemon died at startup) fails `ensureDaemon` at once
   * with that reason instead of after `timeoutMs`. Exiting cleanly is fine: it means another daemon won the start race.
   */
  start: () => void | Promise<void>;
  /** How long to wait for a started daemon to accept connections. */
  timeoutMs?: number;
}

/**
 * Connects to the daemon, starting it first if none is listening. Several callers racing here may each start one;
 * the data dir's lock lets exactly one of those daemons run, and every caller connects to it.
 */
export async function ensureDaemon(options: EnsureDaemonOptions): Promise<DaemonClient> {
  try {
    return await connectDaemon(options.socketPath);
  } catch {
    // Not running (or a stale socket): start one below.
  }
  let startFailure: unknown;
  let wake = () => {};
  Promise.resolve()
    .then(options.start)
    .catch((error: unknown) => {
      startFailure = error;
      wake();
    });
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  for (let delay = 10; ; delay = Math.min(delay * 2, 200)) {
    if (startFailure !== undefined) {
      throw new Error(`the agent-board daemon failed to start: ${(startFailure as Error).message ?? startFailure}`, {
        cause: startFailure,
      });
    }
    try {
      return await connectDaemon(options.socketPath);
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`the agent-board daemon did not start listening on ${options.socketPath}`, { cause: error });
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

/** A long-lived link to the daemon: `call` connects on demand, and reconnects (restarting the daemon) after a drop. */
export interface DaemonLink {
  call: DaemonClient['call'];
  /**
   * Subscribes to the event stream of whichever connection is current, across reconnects. Events pushed while
   * disconnected are missed. Returns the unsubscribe function.
   */
  onEvent(listener: (event: DaemonEvent) => void): () => void;
  /**
   * Calls `listener` each time a new connection is made, once its events reach `onEvent` listeners and before any
   * call goes over it: a call made from `listener` sees every event since. Returns the unsubscribe function.
   */
  onConnected(listener: () => void): () => void;
  /** Calls `listener` each time a connection drops, but not when `close` ends it. Returns the unsubscribe function. */
  onDisconnected(listener: () => void): () => void;
  /** Closes the connection; later calls fail. */
  close(): void;
}

/** Adds `listener` to `listeners`, returning the function that removes it. */
function subscribe<T>(listeners: Set<T>, listener: T): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function createDaemonLink(options: EnsureDaemonOptions): DaemonLink {
  let client: Promise<DaemonClient> | undefined;
  let closed = false;
  const listeners = new Set<(event: DaemonEvent) => void>();
  const connectedListeners = new Set<() => void>();
  const disconnectedListeners = new Set<() => void>();

  const connect = (): Promise<DaemonClient> => {
    if (closed) return Promise.reject(new Error('the daemon link is closed'));
    client ??= ensureDaemon(options).then(
      (connected) => {
        connected.onEvent((event) => {
          for (const listener of listeners) listener(event);
        });
        void connected.closed.then(() => {
          client = undefined;
          if (!closed) for (const listener of disconnectedListeners) listener();
        });
        for (const listener of connectedListeners) listener();
        return connected;
      },
      (error: unknown) => {
        client = undefined;
        throw error;
      },
    );
    return client;
  };

  return {
    call: async (method, ...params) => (await connect()).call(method, ...params),
    onEvent: (listener) => subscribe(listeners, listener),
    onConnected: (listener) => subscribe(connectedListeners, listener),
    onDisconnected: (listener) => subscribe(disconnectedListeners, listener),
    close() {
      closed = true;
      void client?.then(
        (connected) => connected.close(),
        () => {},
      );
    },
  };
}
