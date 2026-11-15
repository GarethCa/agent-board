import type { IpcMain, WebContents, WebFrameMain } from 'electron';

/** What an IPC event says of who sent it: the web contents, and the frame inside it (none once that has gone). */
export interface IpcSender {
  sender: WebContents;
  senderFrame: Pick<WebFrameMain, 'parent' | 'url'> | null;
}

/** The part of `ipcMain` the guard takes over: its handlers, and the emit that hands a sent message to its listeners. */
export type GuardableIpc = Pick<IpcMain, 'handle' | 'handleOnce' | 'emit' | 'eventNames'>;

type Handler = Parameters<IpcMain['handle']>[1];

/** Whether `value` is an IPC event, which a window's message always is, rather than the emitter's own bookkeeping. */
function isIpcEvent(value: unknown): value is IpcSender {
  return typeof value === 'object' && value !== null && 'sender' in value;
}

/**
 * Makes every channel of `ipc` answer only a page `allows` (the app's own page in one of its own windows), and only from
 * that page's own frame: a frame inside it, or a frame that has gone, gets nothing. It takes over `handle` and
 * `handleOnce`, so each invoked handler registered after this is checked before it runs, and a refused call rejects;
 * and `emit`, through which Electron hands every sent message to its listeners (`on`, `once` and the rest), so a
 * refused message reaches none of them. No handler checks its sender itself, and a new one needs nothing to get the
 * check. `refused` hears the first refusal of each channel from each sender, so a page that keeps calling can't flood
 * the log.
 *
 * It must be installed before anything registers. It throws if a listener is already there, other than the `error`
 * listener Electron adds itself (an emitter's errors, never a window's message). It can't see a handler registered
 * before it: that rests on main's entry installing it first (`app-only-ipc.ts`).
 */
export function guardIpc(
  ipc: GuardableIpc,
  allows: (sender: WebContents, url: string) => boolean,
  refused: (channel: string) => void = (channel) => console.warn(`agent-board: refused ${channel}: not one of the app's own windows`),
): void {
  if (ipc.eventNames().some((name) => name !== 'error')) throw new Error('guardIpc must be installed before any IPC listener is added');
  const answers = ({ sender, senderFrame }: IpcSender) => senderFrame !== null && senderFrame.parent === null && allows(sender, senderFrame.url);
  const told = new WeakMap<WebContents, Set<string>>();
  const refuse = (channel: string, { sender }: IpcSender) => {
    const channels = told.get(sender) ?? new Set<string>();
    if (channels.has(channel)) return;
    told.set(sender, channels.add(channel));
    refused(channel);
  };
  const checked =
    (channel: string, handler: Handler): Handler =>
    (event, ...args) => {
      if (answers(event)) return handler(event, ...args);
      refuse(channel, event);
      throw new Error(`${channel} answers only the app's own windows`);
    };

  const handle = ipc.handle.bind(ipc);
  const handleOnce = ipc.handleOnce.bind(ipc);
  const emit = ipc.emit.bind(ipc);
  ipc.handle = (channel, handler) => handle(channel, checked(channel, handler));
  ipc.handleOnce = (channel, handler) => handleOnce(channel, checked(channel, handler));
  ipc.emit = (eventName, ...args) => {
    if (typeof eventName === 'string' && isIpcEvent(args[0]) && !answers(args[0])) {
      refuse(eventName, args[0]);
      return false;
    }
    return emit(eventName, ...args);
  };
}
