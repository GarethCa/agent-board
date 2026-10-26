// Pictures of zones for orchestrators: the daemon draws nothing itself, so it asks the app, which takes the picture in a
// hidden window of its own and hands it back. One connection serves captures at a time (the app's, as it connects); a
// request waits on it for at most a timeout, and fails at once with no app to ask.
import { randomUUID } from 'node:crypto';
import { systemClock, type Clock } from './clock.ts';
import { invalidParams, paramsObject, stringParam } from './params.ts';
import { MAX_CAPTURE_PNG_BYTES, MAX_CAPTURE_SIDE, type CaptureDelivery, type CaptureRequestedEvent, type DaemonMethods } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';
import type { BoardConnection } from './board.ts';
import type { SessionSubscriber } from './sessions.ts';

/** How long a picture is waited for by default: well under the minute a harness gives a tool call. */
const DEFAULT_CAPTURE_TIMEOUT_MS = 15_000;

/** The biggest picture handed back, as base64: `MAX_CAPTURE_PNG_BYTES` of PNG. */
const MAX_PNG_BASE64 = Math.ceil(MAX_CAPTURE_PNG_BYTES / 3) * 4;

/** A picture's side, px: a whole number up to `MAX_CAPTURE_SIDE`. */
function sideParam(params: Record<string, unknown>, name: string): number {
  const value = params[name];
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_CAPTURE_SIDE) {
    throw invalidParams(`${name} must be a whole number from 1 to ${MAX_CAPTURE_SIDE}`);
  }
  return value as number;
}

type CaptureMethods = Pick<DaemonMethods, 'capture.serve' | 'capture.deliver' | 'capture.fail'>;

/** A picture as the app handed it back. */
export type Captured = Omit<CaptureDelivery, 'id'>;

export interface CaptureHost {
  handlers: RpcHandlers<CaptureMethods, SessionSubscriber & BoardConnection>;
  /** Whether `connection` is the one that takes pictures: the app's. */
  serves(connection: BoardConnection): boolean;
  /** Asks the app for a picture and waits for it. Rejects at once with no app to ask, and after the timeout. */
  request(job: Omit<CaptureRequestedEvent, 'type' | 'id' | 'deadline'>): Promise<Captured>;
}

interface Pending {
  resolve(captured: Captured): void;
  reject(error: Error): void;
}

export function createCaptureHost({ timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS, clock = systemClock }: { timeoutMs?: number; clock?: Clock } = {}): CaptureHost {
  /** The connection that takes pictures, while it is open. */
  let server: (SessionSubscriber & BoardConnection) | undefined;
  const pending = new Map<string, Pending>();

  const settle = (id: string, how: (waiting: Pending) => void) => {
    const waiting = pending.get(id);
    if (waiting === undefined) return;
    pending.delete(id);
    how(waiting);
  };
  /** Every request the closing connection was asked fails: it will hand nothing back. */
  const lost = (connection: SessionSubscriber & BoardConnection) => {
    if (server !== connection) return;
    server = undefined;
    for (const id of [...pending.keys()]) settle(id, (waiting) => waiting.reject(new Error('the app closed before it took the picture')));
  };

  return {
    handlers: {
      'capture.serve': (_params, connection) => {
        server = connection;
        connection.closed?.addEventListener('abort', () => lost(connection), { once: true });
        return null;
      },
      'capture.deliver': (params) => {
        const p = paramsObject(params);
        const png = stringParam(p, 'png');
        if (png.length > MAX_PNG_BASE64) throw invalidParams(`the picture must be at most ${MAX_CAPTURE_PNG_BYTES} bytes of PNG`);
        const captured = { png, width: sideParam(p, 'width'), height: sideParam(p, 'height') };
        settle(stringParam(p, 'id'), (waiting) => waiting.resolve(captured));
        return null;
      },
      'capture.fail': (params) => {
        const p = paramsObject(params);
        const message = stringParam(p, 'message');
        settle(stringParam(p, 'id'), (waiting) => waiting.reject(new Error(`the app couldn't take the picture: ${message}`)));
        return null;
      },
    },
    serves: (connection) => connection === server,
    request(job) {
      const to = server;
      if (to === undefined) return Promise.reject(new Error("the app isn't open: a picture of a zone needs its window"));
      const id = randomUUID();
      return new Promise<Captured>((resolve, reject) => {
        const cancel = clock.setTimer(
          () => settle(id, (waiting) => waiting.reject(new Error(`the app didn't hand the picture back within ${timeoutMs / 1000} s`))),
          timeoutMs,
        );
        pending.set(id, {
          resolve: (captured) => (cancel(), resolve(captured)),
          reject: (error) => (cancel(), reject(error)),
        });
        to.send({ type: 'capture.requested', id, ...job, deadline: clock.now() + timeoutMs });
      });
    },
  };
}
