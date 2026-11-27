import { describe, expect, it, vi } from 'vitest';
import { DaemonRpcError, type DaemonLink } from '@agent-board/daemon/client';
import { AGENT_ERROR } from '@agent-board/daemon/protocol';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: { isPackaged: true, on: () => {} },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
  BrowserWindow: class {},
}));

const { registerAgentIpc, wakeOnce } = await import('./agents');

const busy = () => new DaemonRpcError(AGENT_ERROR.shellBusy, 'its shell is running something');

/** A daemon whose `agent.resume` waits until `land` or `fail` is called, counting its calls. */
function slowDaemon() {
  let land: (agent: unknown) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const call = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
    () =>
      new Promise((resolve, reject) => {
        land = resolve;
        fail = reject;
      }),
  );
  const daemon = { call, onEvent: () => () => undefined, onConnected: () => () => undefined } as unknown as DaemonLink;
  return { daemon, call, land: (agent: unknown) => land(agent), fail: (error: unknown) => fail(error) };
}

describe('waking an agent from any window', () => {
  it('starts it once while a wake is going: a second press gets the same answer', async () => {
    const { daemon, call, land } = slowDaemon();
    const wake = wakeOnce(daemon);
    const first = wake('coder', false);
    const second = wake('coder', false);
    land({ sessionId: 'coder' });
    expect(await first).toEqual({ status: 'restarted', agent: { sessionId: 'coder' } });
    expect(await second).toEqual(await first);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('agent.resume', { sessionId: 'coder', force: false });
  });

  it('wakes it again once the last wake has landed, and another agent at any time', async () => {
    const { daemon, call, land } = slowDaemon();
    const wake = wakeOnce(daemon);
    const coder = wake('coder', false);
    land({ sessionId: 'coder' });
    await coder;
    void wake('coder', true);
    void wake('builder', false);
    expect(call).toHaveBeenCalledTimes(3);
    expect(call).toHaveBeenNthCalledWith(2, 'agent.resume', { sessionId: 'coder', force: true });
  });

  it('goes on with a forced wake asked for during an unforced one, only once that one finds the shell busy', async () => {
    const { daemon, call, land, fail } = slowDaemon();
    const wake = wakeOnce(daemon);
    const first = wake('coder', false);
    const anyway = wake('coder', true);
    expect(wake('coder', false)).toBe(anyway);
    fail(busy());
    expect(await first).toEqual({ status: 'busy', message: 'its shell is running something' });
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call).toHaveBeenLastCalledWith('agent.resume', { sessionId: 'coder', force: true });
    land({ sessionId: 'coder' });
    expect(await anyway).toEqual({ status: 'restarted', agent: { sessionId: 'coder' } });

    const woken = wake('coder', false);
    const forced = wake('coder', true);
    land({ sessionId: 'coder' });
    expect(await forced).toEqual(await woken);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('answers a busy shell as busy, to ask about, and passes any other failure on', async () => {
    const { daemon, fail } = slowDaemon();
    const wake = wakeOnce(daemon);
    const asked = wake('coder', false);
    fail(busy());
    expect(await asked).toEqual({ status: 'busy', message: 'its shell is running something' });
    const broken = wake('coder', false);
    fail(new Error('gone'));
    await expect(broken).rejects.toThrow('gone');
  });

  it('restarts with launch settings only after a wake going for that agent lands, and a wake asked for meanwhile gets its answer', async () => {
    const { daemon, call, land } = slowDaemon();
    const wake = wakeOnce(daemon);
    const woken = wake('coder', false);
    const relaunched = wake('coder', false, { launchSettings: { env: { DISABLE_TELEMETRY: '1' } }, keepEnv: ['FOO'] });
    expect(wake('coder', false)).toBe(relaunched);
    expect(call).toHaveBeenCalledTimes(1);
    land({ sessionId: 'coder' });
    expect(await woken).toEqual({ status: 'restarted', agent: { sessionId: 'coder' } });
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call).toHaveBeenLastCalledWith('agent.restartWith', { sessionId: 'coder', launchSettings: { env: { DISABLE_TELEMETRY: '1' } }, keepEnv: ['FOO'] });
    land({ sessionId: 'coder', launchSettings: { env: ['DISABLE_TELEMETRY', 'FOO'] } });
    expect(await relaunched).toEqual({ status: 'restarted', agent: { sessionId: 'coder', launchSettings: { env: ['DISABLE_TELEMETRY', 'FOO'] } } });
  });

  it('restarts with launch settings even after a wake that failed, and a busy shell then is busy, to ask about', async () => {
    const { daemon, call, fail } = slowDaemon();
    const wake = wakeOnce(daemon);
    const broken = wake('coder', false);
    const relaunched = wake('coder', false, { launchSettings: {} });
    fail(new Error('gone'));
    await expect(broken).rejects.toThrow('gone');
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call).toHaveBeenLastCalledWith('agent.restartWith', { sessionId: 'coder', launchSettings: {} });
    fail(busy());
    expect(await relaunched).toEqual({ status: 'busy', message: 'its shell is running something' });
  });

  it('shares one wake between Restart and Restart with…, which passes its settings and a forced wake on', async () => {
    const { daemon, call, land } = slowDaemon();
    handlers.clear();
    registerAgentIpc(daemon, '/data');
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) as Promise<unknown>;
    const relaunched = invoke('agent:restartWith', 'coder', { env: { A: '1' } }, undefined, true);
    const restarted = invoke('agent:restart', 'coder', false);
    land({ sessionId: 'coder' });
    expect(await restarted).toEqual(await relaunched);
    expect(call.mock.calls).toEqual([['agent.restartWith', { sessionId: 'coder', launchSettings: { env: { A: '1' } }, force: true }]]);
  });

  it('shares one wake between Resume and Restart, and Resume fails on a busy shell in its words', async () => {
    const { daemon, call, fail } = slowDaemon();
    handlers.clear();
    registerAgentIpc(daemon, '/data');
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) as Promise<unknown>;
    const resumed = invoke('agent:resume', 'coder');
    const restarted = invoke('agent:restart', 'coder', false);
    fail(busy());
    await expect(resumed).rejects.toThrow('its shell is running something');
    expect(await restarted).toEqual({ status: 'busy', message: 'its shell is running something' });
    expect(call.mock.calls.filter(([method]) => method === 'agent.resume')).toHaveLength(1);
  });
});
