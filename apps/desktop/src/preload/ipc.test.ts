import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { IpcRenderer } from 'electron';
import { ipcCalls, readOnlyIpc } from './ipc';

/** An ipcRenderer stand-in: `on`/`off` on an emitter, and `invoke` answered by `answer`. */
function fakeIpc(answer: (channel: string, ...args: unknown[]) => Promise<unknown>) {
  const emitter = new EventEmitter();
  const ipc: Parameters<typeof ipcCalls>[0] = {
    invoke: answer,
    on: (channel, listener) => {
      emitter.on(channel, listener);
      return ipc as IpcRenderer;
    },
    off: (channel, listener) => {
      emitter.off(channel, listener);
      return ipc as IpcRenderer;
    },
  };
  return { emitter, ipc };
}

describe('invoke', () => {
  it("resolves to main's answer", async () => {
    const { ipc } = fakeIpc(async (channel, ...args) => [channel, ...args]);
    await expect(ipcCalls(ipc).invoke('zones:list', 1, 'a')).resolves.toEqual(['zones:list', 1, 'a']);
  });

  it("fails with just the daemon's message, without the wrapping IPC adds", async () => {
    const { ipc } = fakeIpc(async () => {
      throw new Error("Error invoking remote method 'zones:add': Error: not a git repository");
    });
    await expect(ipcCalls(ipc).invoke('zones:add')).rejects.toThrow(/^not a git repository$/);
  });
});

describe('keyed', () => {
  it('shares one listener on the channel between every key, and routes each message by its id', () => {
    const { ipc, emitter } = fakeIpc(async () => undefined);
    const listen = ipcCalls(ipc).keyed<[string]>('session:event');
    const heard: string[] = [];
    const stops = ['a', 'b', 'c'].map((id) => listen(id, (message) => heard.push(`${id}:${message}`)));

    expect(emitter.listenerCount('session:event')).toBe(1);
    emitter.emit('session:event', {}, 'b', 'hi');
    emitter.emit('session:event', {}, 'zzz', 'nobody');
    stops[1]!();
    emitter.emit('session:event', {}, 'b', 'again');
    emitter.emit('session:event', {}, 'a', 'there');

    expect(heard).toEqual(['b:hi', 'a:there']);
    stops[0]!();
    stops[2]!();
    expect(emitter.listenerCount('session:event')).toBe(0);
  });

  it('listens again after the last one went', () => {
    const { ipc, emitter } = fakeIpc(async () => undefined);
    const listen = ipcCalls(ipc).keyed<[string]>('session:event');
    listen('a', () => {})();
    const heard: string[] = [];
    listen('a', (message) => heard.push(message));
    emitter.emit('session:event', {}, 'a', 'hello');
    expect(heard).toEqual(['hello']);
  });
});

describe('subscribe', () => {
  it('passes each message on the channel to the listener, without the IPC event, until unsubscribed', () => {
    const { ipc, emitter } = fakeIpc(async () => undefined);
    const heard: unknown[][] = [];
    const unsubscribe = ipcCalls(ipc).subscribe('windows:returned', (...args: unknown[]) => heard.push(args));

    emitter.emit('windows:returned', { sender: 'main' }, 'agent:a1', 'closed');
    emitter.emit('zones:changed', { sender: 'main' }, 'other');
    unsubscribe();
    emitter.emit('windows:returned', { sender: 'main' }, 'agent:a2', 'closed');

    expect(heard).toEqual([['agent:a1', 'closed']]);
    expect(emitter.listenerCount('windows:returned')).toBe(0);
  });
});

describe('readOnlyIpc', () => {
  it('passes on the calls that only read, and refuses every other without reaching main', async () => {
    const reached: string[] = [];
    const sent: string[] = [];
    const { ipc } = fakeIpc(async (channel) => (reached.push(channel), channel));
    const guarded = readOnlyIpc({ ...ipc, send: (channel: string) => void sent.push(channel) }, new Set(['zone:list']));

    await expect(guarded.invoke('zone:list')).resolves.toBe('zone:list');
    await expect(guarded.invoke('view:set', 'viewport', {})).rejects.toThrow('a capture window only reads the board: view:set');
    guarded.send('session:write', 'id', 'rm -rf');

    expect(reached).toEqual(['zone:list']);
    expect(sent).toEqual([]);
  });

  it("still hears what main sends", () => {
    const { ipc, emitter } = fakeIpc(async () => undefined);
    const heard: unknown[] = [];
    ipcCalls(readOnlyIpc({ ...ipc, send: () => {} }, new Set())).subscribe('zone:changed', (zone: unknown) => heard.push(zone));
    emitter.emit('zone:changed', {}, 'z1');
    expect(heard).toEqual(['z1']);
  });
});
