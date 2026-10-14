import { ipcMain } from 'electron';
import type { DaemonLink } from '@agent-board/daemon/client';
import type { DaemonMethod, DaemonMethods } from '@agent-board/daemon/protocol';

type Params<M extends DaemonMethod> = DaemonMethods[M]['params'];

/**
 * Answers `channel` with the daemon's `method`, called with the params `toParams` makes from the renderer's positional
 * arguments (none, for a method without params). The handlers with logic of their own stay beside their domain.
 */
export function passthrough<M extends DaemonMethod, A extends unknown[] = []>(
  daemon: DaemonLink,
  channel: string,
  method: M,
  toParams?: (...args: A) => Params<M>,
): void {
  ipcMain.handle(channel, (_event, ...args: unknown[]) => call(daemon, method, toParams, args as A));
}

/** Like `passthrough`, for an API that resolves with nothing: the daemon's answer is dropped. */
export function passthroughVoid<M extends DaemonMethod, A extends unknown[] = []>(
  daemon: DaemonLink,
  channel: string,
  method: M,
  toParams?: (...args: A) => Params<M>,
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    await call(daemon, method, toParams, args as A);
  });
}

function call<M extends DaemonMethod, A extends unknown[]>(
  daemon: DaemonLink,
  method: M,
  toParams: ((...args: A) => Params<M>) | undefined,
  args: A,
): Promise<DaemonMethods[M]['result']> {
  const params = toParams?.(...args);
  return (daemon.call as (method: M, ...params: unknown[]) => Promise<DaemonMethods[M]['result']>)(method, ...(params === undefined ? [] : [params]));
}
