import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { guardIpc, type GuardableIpc, type IpcSender } from './ipc-guard';

type Handler = (event: IpcSender, ...args: unknown[]) => unknown;

/**
 * An `ipcMain` as Electron's dispatch sees it: `handle` keeps one handler a channel, which an invoke calls, and a sent
 * message is emitted to the channel's listeners.
 */
class FakeIpcMain extends EventEmitter {
  readonly handlers = new Map<string, Handler>();
  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler);
  }
  handleOnce(channel: string, handler: Handler): void {
    this.handlers.set(channel, (event, ...args) => {
      this.handlers.delete(channel);
      return handler(event, ...args);
    });
  }
  async invoke(channel: string, event: IpcSender, ...args: unknown[]): Promise<unknown> {
    return this.handlers.get(channel)!(event, ...args);
  }
  send(channel: string, event: IpcSender, ...args: unknown[]): void {
    this.emit(channel, event, ...args);
  }
}

const appWindow = { name: 'board' } as unknown as Electron.WebContents;
const webTab = { name: 'web tab' } as unknown as Electron.WebContents;

const APP_PAGE = 'file:///app/renderer/index.html';

/** An event from `contents`, from its page at `url` or (`subframe`) from a frame inside it. */
function from(contents: Electron.WebContents, { subframe = false, noFrame = false, url = APP_PAGE } = {}): IpcSender {
  const main = { parent: null, url };
  return { sender: contents, senderFrame: noFrame ? null : subframe ? { parent: main, url } : main } as unknown as IpcSender;
}

function guarded() {
  const ipc = new FakeIpcMain();
  const refused: string[] = [];
  guardIpc(ipc as unknown as GuardableIpc, (contents, url) => contents === appWindow && url === APP_PAGE, (channel) => refused.push(channel));
  return { ipc, refused };
}

describe('guardIpc: invoked channels', () => {
  it("answers a call from an app window's page", async () => {
    const { ipc } = guarded();
    ipc.handle('zone:list', (_event, id) => `zones of ${String(id)}`);

    await expect(ipc.invoke('zone:list', from(appWindow), 'b1')).resolves.toBe('zones of b1');
  });

  it('refuses a call from a web contents that is not an app window, without running the handler', async () => {
    const { ipc, refused } = guarded();
    const handler = vi.fn(() => 'answer');
    ipc.handle('agent:decidePermission', handler);

    await expect(ipc.invoke('agent:decidePermission', from(webTab), 'allow')).rejects.toThrow(/app's own windows/);
    expect(handler).not.toHaveBeenCalled();
    expect(refused).toEqual(['agent:decidePermission']);
  });

  it("refuses a call from a frame inside an app window's page, or from a frame that has gone", async () => {
    const { ipc } = guarded();
    const handler = vi.fn();
    ipc.handle('agent:spawn', handler);

    await expect(ipc.invoke('agent:spawn', from(appWindow, { subframe: true }))).rejects.toThrow();
    await expect(ipc.invoke('agent:spawn', from(appWindow, { noFrame: true }))).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a call from an app window showing a page that isn't the app's", async () => {
    const { ipc } = guarded();
    const handler = vi.fn();
    ipc.handle('agent:spawn', handler);

    await expect(ipc.invoke('agent:spawn', from(appWindow, { url: 'https://example.com/' }))).rejects.toThrow(/app's own windows/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('tells of the first refusal of each channel from each sender, however often it is called', async () => {
    const { ipc, refused } = guarded();
    ipc.handle('zone:list', () => []);
    ipc.handle('zone:add', () => undefined);
    const otherTab = { name: 'other tab' } as unknown as Electron.WebContents;

    for (let i = 0; i < 5; i += 1) await expect(ipc.invoke('zone:list', from(webTab))).rejects.toThrow();
    for (let i = 0; i < 5; i += 1) ipc.send('session:write', from(webTab));
    await expect(ipc.invoke('zone:add', from(webTab))).rejects.toThrow();
    await expect(ipc.invoke('zone:list', from(otherTab))).rejects.toThrow();
    expect(refused).toEqual(['zone:list', 'session:write', 'zone:add', 'zone:list']);
  });

  it('checks a handler that answers once, too', async () => {
    const { ipc } = guarded();
    const handler = vi.fn(() => 'once');
    ipc.handleOnce('setup:once', handler);

    await expect(ipc.invoke('setup:once', from(webTab))).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('checks every handler registered after it, with nothing more for the handler to do', async () => {
    const { ipc } = guarded();
    for (const channel of ['a:one', 'b:two', 'c:three']) ipc.handle(channel, () => channel);

    for (const channel of ['a:one', 'b:two', 'c:three']) {
      await expect(ipc.invoke(channel, from(webTab))).rejects.toThrow();
      await expect(ipc.invoke(channel, from(appWindow))).resolves.toBe(channel);
    }
  });
});

describe('guardIpc: sent messages', () => {
  it("hands an app window's message to every listener, and drops another's", () => {
    const { ipc, refused } = guarded();
    const on = vi.fn();
    const once = vi.fn();
    ipc.on('tab-drag:move', on);
    ipc.once('tab-drag:end', once);

    ipc.send('tab-drag:move', from(webTab), 1);
    ipc.send('tab-drag:end', from(webTab));
    ipc.send('tab-drag:move', from(appWindow, { subframe: true }), 2);
    expect(on).not.toHaveBeenCalled();
    expect(once).not.toHaveBeenCalled();
    expect(refused).toEqual(['tab-drag:move', 'tab-drag:end', 'tab-drag:move']);

    ipc.send('tab-drag:move', from(appWindow), 3);
    ipc.send('tab-drag:end', from(appWindow));
    expect(on).toHaveBeenCalledWith(expect.anything(), 3);
    expect(once).toHaveBeenCalledOnce();
  });

  it("keeps the emitter's own bookkeeping events, which no window sends", () => {
    const { ipc } = guarded();
    const added = vi.fn();
    ipc.on('newListener', added);
    ipc.on('zone:changed', () => undefined);

    expect(added).toHaveBeenCalledWith('zone:changed', expect.any(Function));
  });

  it('lets a listener be removed as it was added', () => {
    const { ipc } = guarded();
    const listener = vi.fn();
    ipc.on('view:save', listener);
    ipc.removeListener('view:save', listener);

    ipc.send('view:save', from(appWindow));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('guardIpc: installing', () => {
  it('refuses to start after a listener is already there, which it could not check', () => {
    const ipc = new FakeIpcMain();
    ipc.on('early:bird', () => undefined);

    expect(() => guardIpc(ipc as unknown as GuardableIpc, () => true)).toThrow(/before any/);
  });

  it("starts beside the 'error' listener Electron puts on ipcMain itself, which no window can reach", () => {
    const ipc = new FakeIpcMain();
    ipc.on('error', () => undefined);

    expect(() => guardIpc(ipc as unknown as GuardableIpc, () => true)).not.toThrow();
  });
});
