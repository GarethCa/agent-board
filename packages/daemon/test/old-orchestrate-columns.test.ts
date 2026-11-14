import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { daemonPaths } from '../src/paths.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

/**
 * A board saved under the earlier model, with a zone's switch off and an agent's orchestrating set or turned off, still
 * loads, and those columns no longer stop any agent: every agent's own live session acts on the agents an agent started.
 */

const SIZE = { cols: 120, rows: 40 };

describe('a board saved with the old orchestrate columns', () => {
  it('loads, lists no such fields, and lets an agent started in a zone whose switch was off start and close agents', async () => {
    const dataDir = tempDataDir();
    const agentEnv = fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 });
    const first = await startTestDaemon({ dataDir, agentEnv, worktreesDir: tempDataDir() });
    const before = await connectTestClient(first);
    const zone = await before.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
    const old = await before.call('agent.spawn', { zoneId: zone.id, name: 'old', ...SIZE });
    await before.call('agent.stop', { sessionId: old.sessionId });
    before.close();
    await first.stop();

    const db = new DatabaseSync(daemonPaths(dataDir).database);
    try {
      db.prepare('UPDATE zones SET agents_orchestrate = 0').run();
      db.prepare("UPDATE agents SET orchestrate = 'board', orchestrate_off = 1").run();
    } finally {
      db.close();
    }

    const daemon = await startTestDaemon({ dataDir, agentEnv, worktreesDir: tempDataDir() });
    const client = await connectTestClient(daemon);
    const recorder = recordEvents(client);
    const [listed] = await client.call('agent.list');
    expect(listed).toMatchObject({ sessionId: old.sessionId, name: 'old' });
    expect(listed).not.toHaveProperty('orchestrate');
    const [web] = await client.call('zone.list');
    expect(web).toMatchObject({ id: zone.id });
    expect(web).not.toHaveProperty('agentsOrchestrate');

    const lead = await client.call('agent.spawn', { zoneId: zone.id, name: 'lead', prompt: 'Print your board identity', ...SIZE });
    await client.call('session.attach', { sessionId: lead.sessionId });
    await recorder.waitForText(lead.sessionId, ':end\r\n');
    const token = /identity:(.*):end\r\n/.exec(recorder.screenText(lead.sessionId))![1]!;
    const connection = await connectTestClient(daemon);
    await connection.call('board.identify', { token });

    const worker = await connection.call('orchestrator.spawn', { token, name: 'worker' });
    expect(worker).toMatchObject({ spawnedBy: lead.sessionId, zoneId: zone.id });
    await connection.call('orchestrator.close', { token, sessionId: worker.sessionId });
  }, 40_000);
});
