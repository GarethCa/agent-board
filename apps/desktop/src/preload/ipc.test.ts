import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { IpcRenderer } from 'electron';
import { ipcCalls } from './ipc';

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
