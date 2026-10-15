import { rmSync, symlinkSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeBinDir, fakeHarnessEnv } from '@agent-board/fake-harness';
import { RPC_ERROR, type DaemonEvent, type HookEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };
const NOT_FOUND = 'claude not found on this Mac: install it, or set its path in Settings';

/**
 * A daemon whose PATH has `node` (the fakes need it) and nothing else: no `claude`, however it is installed.
 * `installed` is a link to the fake claude, in a dir that is on no PATH.
 */
async function daemonWithoutHarnessOnPath() {
  const tools = tempDataDir();
  symlinkSync(process.execPath, join(tools, 'node'));
  const installed = join(tempDataDir(), 'claude');
  symlinkSync(join(fakeBinDir, 'claude'), installed);
  const agentEnv = {
    ...fakeHarnessEnv({ scenario: 'waiting', home: tempDataDir(), idleNotifyMs: 200 }),
    PATH: [tools, '/usr/bin', '/bin'].join(delimiter),
  };
  const daemon = await startTestDaemon({ worktreesDir: tempDataDir(), agentEnv });
  const client = await connectTestClient(daemon);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
  return { client, recorder: recordEvents(client), installed, zone };
}

describe('launching a harness that is on no PATH', () => {
  it('says plainly it was not found, and makes no agent', async () => {
    const { client, zone } = await daemonWithoutHarnessOnPath();
    await expect(client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: NOT_FOUND,
    });
    expect(await client.call('agent.list')).toEqual([]);
  });

  it('starts and restarts it from the path set in Settings, and names that path when it is gone', async () => {
    const { client, installed, zone } = await daemonWithoutHarnessOnPath();
    expect(await client.call('settings.get')).toMatchObject({ claudePath: '', codexPath: '' });
    await expect(client.call('settings.set', { claudePath: 'claude' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await client.call('settings.set', { claudePath: installed });

    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Pick a database', ...SIZE });
    await client.call('agent.stop', { sessionId: agent.sessionId });
    expect(await client.call('agent.resume', { sessionId: agent.sessionId })).toMatchObject({ sessionId: agent.sessionId, endedAt: null });

    await client.call('agent.stop', { sessionId: agent.sessionId });
    rmSync(installed);
    await expect(client.call('agent.resume', { sessionId: agent.sessionId })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining(`claude not found at ${installed}: fix its path in Settings, or clear it`),
    });
  });

  it('passes the model as --model to the harness it found at the Settings path', async () => {
    const { client, installed, recorder, zone } = await daemonWithoutHarnessOnPath();
    await client.call('settings.set', { claudePath: installed });

    const agent = await client.call('agent.spawn', { zoneId: zone.id, model: 'sonnet', prompt: 'Go', ...SIZE });

    const started = await recorder.waitFor(
      (e: DaemonEvent): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'SessionStart',
    );
    expect(started.payload.model).toBe('sonnet');
  });
});
