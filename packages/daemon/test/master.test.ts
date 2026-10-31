// The Captain (ADR-0019): one agent per board, started only by the user, at board scope, in a folder of its own.
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { daemonPaths } from '../src/paths.ts';
import { masterPosition } from '../src/master.ts';
import { BOARD_ERROR, RPC_ERROR, TILE_SLOT, type Agent } from '../src/protocol.ts';
import { connectTestClient, insertFakeSession, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };

/** A daemon whose agents play the `orchestrate` scenario for every message, so the master can be told to print its token. */
async function masterDaemon() {
  const dataDir = tempDataDir();
  const daemon = await startTestDaemon({
    dataDir,
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200, repeat: true }),
  });
  const client = await connectTestClient(daemon);
  return { daemon, client, recorder: recordEvents(client), dataDir };
}

type Setup = Awaited<ReturnType<typeof masterDaemon>>;

/** The agent once `match` holds for it, as the daemon lists it. */
async function until(client: Setup['client'], sessionId: string, match: (agent: Agent) => boolean): Promise<Agent> {
  for (let tries = 0; tries < 200; tries++) {
    const agent = (await client.call('agent.list')).find((each) => each.sessionId === sessionId);
    if (agent !== undefined && match(agent)) return agent;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`agent ${sessionId} never matched`);
}

const atPrompt = (agent: Agent) => agent.state === 'idle' || agent.state === 'waiting';

/** Connects as the agent `sessionId`, told `Print your board identity`: its board token presented, as its CLI does. */
async function sideOf({ daemon, client, recorder }: Setup, sessionId: string) {
  await client.call('session.attach', { sessionId });
  await recorder.waitForText(sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(recorder.screenText(sessionId))![1]!;
  const connection = await connectTestClient(daemon);
  await connection.call('board.identify', { token });
  return { token, connection };
}

/** Starts the master, lets its first turn end, then has it print its board token, and connects as it. */
async function masterSide(setup: Setup) {
  const master = await setup.client.call('master.start', SIZE);
  await until(setup.client, master.sessionId, atPrompt);
  await setup.client.call('agent.answer', { sessionId: master.sessionId, text: 'Print your board identity' });
  return { master, ...(await sideOf(setup, master.sessionId)) };
}

describe('the Captain', () => {
  it('starts loose on the board left of the zones, at board scope, in a folder of its own with no repo or branch', async () => {
    const { client, dataDir } = await masterDaemon();
    await client.call('zone.add', { path: tempRepo(), x: 400, y: 200, name: 'web' });
    await client.call('zone.addUnbound', { name: 'docs', x: 1200, y: -100 });

    const master = await client.call('master.start', SIZE);

    expect(master).toMatchObject({
      master: true,
      zoneId: null,
      orchestrate: 'board',
      spawnedBy: null,
      ownsWorktree: false,
      branch: '',
      harness: 'claude',
      model: 'opus',
      name: 'Captain',
    });
    expect(master.position).toMatchObject({ x: 400 - TILE_SLOT.width - 80, y: -100 });
    expect(realpathSync(master.cwd)).toBe(realpathSync(join(dataDir, 'master')));
    expect(existsSync(join(dataDir, 'master', '.git'))).toBe(false);
  });

  it('loads a master tile still named from before the Captain as the same Captain, and leaves a name the user chose', async () => {
    const dataDir = tempDataDir();
    const rename = (sessionId: string, name: string) => {
      const db = new DatabaseSync(daemonPaths(dataDir).database);
      db.prepare('UPDATE agents SET name = ? WHERE session_id = ?').run(name, sessionId);
      db.close();
    };
    const first = await startTestDaemon({ dataDir, worktreesDir: tempDataDir() });
    const master = await (await connectTestClient(first)).call('master.start', SIZE);
    await first.stop();
    rename(master.sessionId, 'Board master');

    const second = await startTestDaemon({ dataDir, worktreesDir: tempDataDir() });
    const client = await connectTestClient(second);
    const renamed = (await client.call('agent.list')).filter((agent) => agent.master);
    expect(renamed.map((agent) => [agent.sessionId, agent.name])).toEqual([[master.sessionId, 'Captain']]);
    expect((await client.call('master.start', SIZE)).sessionId).toBe(master.sessionId);
    await second.stop();
    rename(master.sessionId, 'Chief');

    const third = await startTestDaemon({ dataDir, worktreesDir: tempDataDir() });
    const kept = (await (await connectTestClient(third)).call('agent.list')).find((agent) => agent.master);
    expect(kept).toMatchObject({ sessionId: master.sessionId, name: 'Chief' });
  });

  it('is one per board: starting it again, or twice at once, gives the same agent', async () => {
    const { client } = await masterDaemon();

    const [first, second] = await Promise.all([client.call('master.start', SIZE), client.call('master.start', SIZE)]);
    const again = await client.call('master.start', { ...SIZE, harness: 'codex' });

    expect(second.sessionId).toBe(first.sessionId);
    expect(again).toMatchObject({ sessionId: first.sessionId, harness: 'claude' });
    expect((await client.call('agent.list')).filter((agent) => agent.master)).toHaveLength(1);
  });

  it('is started anew once the old one is deleted', async () => {
    const { client } = await masterDaemon();
    const first = await client.call('master.start', SIZE);

    await client.call('agent.delete', { sessionId: first.sessionId, force: true });
    const next = await client.call('master.start', SIZE);

    expect(next.sessionId).not.toBe(first.sessionId);
    expect(next.master).toBe(true);
  });

  it("is the user's to start: a board token's connection is refused it", async () => {
    const { daemon, client, recorder } = await masterDaemon();
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Print your board identity', orchestrate: 'board', ...SIZE });
    await client.call('session.attach', { sessionId: agent.sessionId });
    await recorder.waitForText(agent.sessionId, ':end\r\n');
    const token = /identity:(.*):end\r\n/.exec(recorder.screenText(agent.sessionId))![1]!;
    const connection = await connectTestClient(daemon);
    await connection.call('board.identify', { token });

    await expect(connection.call('master.start', SIZE)).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
    expect((await client.call('agent.list')).some((each) => each.master)).toBe(false);
  });

  it("keeps board scope when moved into a zone whose switch then goes off", async () => {
    const { client } = await masterDaemon();
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
    const master = await client.call('master.start', SIZE);

    await client.call('agent.move', { sessionId: master.sessionId, zoneId: zone.id, x: 40, y: 40 });
    await client.call('zone.configure', { id: zone.id, agentsOrchestrate: false });

    expect((await client.call('agent.list')).find((agent) => agent.master)).toMatchObject({ zoneId: zone.id, orchestrate: 'board' });
  });

  it("routes a request to a zone's orchestrator: sends it to the live one, and starts one in a zone with none", async () => {
    const setup = await masterDaemon();
    const { client } = setup;
    const web = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
    const docs = await client.call('zone.add', { path: tempRepo('docs'), x: 2000, y: 0, name: 'docs' });
    const lead = await client.call('agent.spawn', { zoneId: web.id, role: 'orchestrator', orchestrate: 'zone', name: 'web lead', ...SIZE });
    await until(client, lead.sessionId, atPrompt);
    const { master, token, connection } = await masterSide(setup);

    // A zone with an orchestrator: the request goes to it.
    await client.call('session.attach', { sessionId: lead.sessionId });
    await connection.call('orchestrator.send', { token, sessionId: lead.sessionId, text: 'Fix the flaky merge-gate test' });
    await setup.recorder.waitForText(lead.sessionId, 'Fix the flaky merge-gate test');

    // A zone with none: it starts one there, its own lead, which orchestrates by the zone.
    const started = await connection.call('orchestrator.spawn', { token, zoneId: docs.id, role: 'orchestrator', prompt: 'Print your board identity' });
    expect(started).toMatchObject({ zoneId: docs.id, roleName: 'orchestrator', spawnedBy: master.sessionId, orchestrate: 'zone' });
  });

  it("won't start an orchestrator in a zone that doesn't let its agents orchestrate: the user is the one to hear of it", async () => {
    const setup = await masterDaemon();
    const { client } = setup;
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
    await client.call('zone.configure', { id: zone.id, agentsOrchestrate: false });
    const { token, connection } = await masterSide(setup);

    await expect(connection.call('orchestrator.spawn', { token, zoneId: zone.id, role: 'orchestrator', prompt: 'Fix it' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining('needs-you'),
    });
    expect((await client.call('agent.list')).filter((agent) => agent.zoneId === zone.id)).toEqual([]);
  });

  it('paces work by usage only once the user lets it: holds a zone past the thresholds, which then starts no agent', async () => {
    const setup = await masterDaemon();
    const { client, daemon, dataDir } = setup;
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
    await client.call('zone.configure', { id: zone.id, priority: 'low' });
    const { token, connection } = await masterSide(setup);
    // A Claude agent's status line posts the reading.
    insertFakeSession(dataDir, { id: 'reader', hookToken: 'reader-token' });
    const posted = await fetch(`http://127.0.0.1:${daemon.hookPort}/usage`, {
      method: 'POST',
      headers: { authorization: 'Bearer reader-token' },
      body: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 86, resets_at: Date.now() / 1000 + 3600 } } }),
    });
    expect(posted.status).toBe(200);
    expect(await connection.call('usage.get', { token })).toMatchObject({ fiveHour: { usedPercent: 86 }, stale: false });

    await expect(connection.call('orchestrator.hold', { token, zoneId: zone.id })).rejects.toMatchObject({
      code: BOARD_ERROR.notAllowed,
      message: expect.stringContaining('Settings › Usage'),
    });
    await expect(connection.call('settings.set', { token, usagePacing: true } as never)).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
    await client.call('settings.set', { usagePacing: true });

    const held = await connection.call('orchestrator.hold', { token, zoneId: zone.id });

    expect(held.usageHold).toMatchObject({ reason: '5h at 86%, zone low priority' });
    await expect(connection.call('orchestrator.spawn', { token, zoneId: zone.id, prompt: 'Fix it' })).rejects.toMatchObject({
      code: BOARD_ERROR.notAllowed,
      message: expect.stringContaining('held for usage (5h at 86%, zone low priority)'),
    });
    expect((await client.call('agent.list')).filter((agent) => agent.zoneId === zone.id)).toEqual([]);
    expect((await client.call('orchestrator.release', { zoneId: zone.id })).usageHold).toBeNull();
  });

  it("keeps its usage holds from the zone's own lead: no other agent lifts a zone's hold, or wakes or messages an agent it paused", async () => {
    const setup = await masterDaemon();
    const { client, daemon, dataDir } = setup;
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
    await client.call('zone.configure', { id: zone.id, priority: 'low' });
    const lead = await client.call('agent.spawn', { zoneId: zone.id, role: 'orchestrator', orchestrate: 'zone', name: 'web lead', ...SIZE });
    const worker = await client.call('agent.spawn', { zoneId: zone.id, name: 'worker', ...SIZE });
    for (const agent of [lead, worker]) await until(client, agent.sessionId, atPrompt);
    const { token, connection } = await masterSide(setup);
    await client.call('agent.answer', { sessionId: lead.sessionId, text: 'Print your board identity' });
    const leadSide = await sideOf(setup, lead.sessionId);
    await client.call('settings.set', { usagePacing: true });
    insertFakeSession(dataDir, { id: 'reader', hookToken: 'reader-token' });
    await fetch(`http://127.0.0.1:${daemon.hookPort}/usage`, {
      method: 'POST',
      headers: { authorization: 'Bearer reader-token' },
      body: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 96, resets_at: Date.now() / 1000 + 3600 } } }),
    });

    await connection.call('orchestrator.hold', { token, zoneId: zone.id });
    await connection.call('orchestrator.usagePause', { token, sessionId: worker.sessionId });
    await until(client, worker.sessionId, (agent) => agent.state === 'hibernated');

    const refused = { code: BOARD_ERROR.notAllowed, message: expect.stringContaining('only the Captain') };
    await expect(leadSide.connection.call('orchestrator.release', { token: leadSide.token, zoneId: zone.id })).rejects.toMatchObject(refused);
    await expect(leadSide.connection.call('orchestrator.wake', { token: leadSide.token, sessionId: worker.sessionId })).rejects.toMatchObject(refused);
    await expect(leadSide.connection.call('orchestrator.restart', { token: leadSide.token, sessionId: worker.sessionId })).rejects.toMatchObject(refused);
    await expect(leadSide.connection.call('orchestrator.send', { token: leadSide.token, sessionId: worker.sessionId, text: 'carry on' })).rejects.toMatchObject(refused);
    expect((await client.call('agent.list')).find((agent) => agent.sessionId === worker.sessionId)).toMatchObject({
      state: 'hibernated',
      hibernated: { reason: '5h at 96%, zone low priority' },
    });

    // The Captain lifts what it placed.
    await connection.call('orchestrator.wake', { token, sessionId: worker.sessionId });
    expect((await connection.call('orchestrator.release', { token, zoneId: zone.id })).usageHold).toBeNull();
  });

  it('leaves the questions and plans of the leads it starts to the user: it can neither answer nor approve them', async () => {
    const setup = await masterDaemon();
    const { client } = setup;
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
    const { token, connection } = await masterSide(setup);
    const startLead = async (name: string) => {
      const agent = await connection.call('orchestrator.spawn', { token, zoneId: zone.id, role: 'orchestrator', name, noTemplate: true, prompt: 'Print your board identity' });
      return { agent, ...(await sideOf(setup, agent.sessionId)) };
    };
    const asker = await startLead('asker');
    const planner = await startLead('planner');

    // Held for the user, as a top-level agent's are: not a flag to the master.
    void asker.connection.call('board.ask', { token: asker.token, question: 'Rewrite the merge gate?', options: ['Yes', 'No'] }).catch(() => {});
    const asking = await until(client, asker.agent.sessionId, (agent) => agent.ask !== null);
    expect(asking.flag).toBeNull();
    void planner.connection.call('board.presentPlan', { token: planner.token, title: 'Drop the old gate', body: '1. Delete it.', format: 'markdown' }).catch(() => {});
    const planning = await until(client, planner.agent.sessionId, (agent) => agent.plan !== null);
    expect(planning.flag).toBeNull();

    // The master can't settle either: not by a message, nor by the user's own answer and decision.
    for (const lead of [asking, planning]) {
      await expect(connection.call('orchestrator.send', { token, sessionId: lead.sessionId, text: 'Go ahead' })).rejects.toMatchObject({
        message: expect.stringContaining('waiting on the user'),
      });
    }
    await expect(connection.call('ask.answer', { sessionId: asking.sessionId, askId: asking.ask!.id, answer: { option: 0 } })).rejects.toMatchObject({
      code: BOARD_ERROR.notAllowed,
    });
    await expect(connection.call('plan.decide', { sessionId: planning.sessionId, planId: planning.plan!.id, outcome: 'approved' })).rejects.toMatchObject({
      code: BOARD_ERROR.notAllowed,
    });
  });

  it("isn't made by a role: an agent started with the role master is an ordinary agent", async () => {
    const { client } = await masterDaemon();
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });

    const agent = await client.call('agent.spawn', { zoneId: zone.id, role: 'master', ...SIZE });

    expect(agent).toMatchObject({ master: false, roleName: 'master' });
  });

  it('goes to the origin on a board with no zones', () => {
    expect(masterPosition([])).toEqual({ x: 0, y: 0 });
  });
});

describe('a message to the Captain', () => {
  it('comes from any orchestrator, whatever its scope, and waits for a busy Captain’s turn to end; steering it stays out of scope', async () => {
    const setup = await masterDaemon();
    const { client } = setup;
    const master = await client.call('master.start', SIZE);
    await until(client, master.sessionId, atPrompt);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 400, y: 200, name: 'kobo' });
    // A zone's lead the user started: the Captain never messaged it, so it has no reply path to answer by.
    const lead = await client.call('agent.spawn', { zoneId: zone.id, name: 'kobo lead', prompt: 'Print your board identity', orchestrate: 'zone', ...SIZE });
    const { token, connection } = await sideOf(setup, lead.sessionId);
    await until(client, lead.sessionId, atPrompt);

    await client.call('session.attach', { sessionId: master.sessionId });
    await client.call('agent.answer', { sessionId: master.sessionId, text: 'Work slowly' });
    await until(client, master.sessionId, (agent) => agent.state === 'running' || agent.state === 'thinking');
    expect(await connection.call('orchestrator.send', { token, sessionId: master.sessionId, text: 'Morning summary' })).toMatchObject({
      delivery: 'queued-after-turn',
      messagesWaiting: 1,
    });
    await until(client, master.sessionId, (agent) => atPrompt(agent) && agent.messagesWaiting === 0 && /Slow work done\.[\s\S]*Morning summary/.test(setup.recorder.screenText(master.sessionId)));

    // The Captain is told who it is from: it hears from leads all over the board.
    expect(setup.recorder.screenText(master.sessionId)).toContain(`[agent-board] From kobo lead (agent:${lead.sessionId.slice(0, 8)}).`);
    expect(await connection.call('orchestrator.send', { token, sessionId: master.sessionId, text: 'One more thing' })).toMatchObject({ delivery: 'started' });
    await until(client, master.sessionId, atPrompt);
    const id = { token, sessionId: master.sessionId };
    for (const steer of [
      () => connection.call('orchestrator.interrupt', id),
      () => connection.call('orchestrator.send', { ...id, submit: true }),
      () => connection.call('orchestrator.send', { ...id, clear: true }),
      () => connection.call('orchestrator.read', id),
      () => connection.call('orchestrator.wait', { token, sessionIds: [master.sessionId], timeoutMs: 1_000 }),
      () => connection.call('orchestrator.pause', id),
      () => connection.call('orchestrator.close', id),
    ]) {
      await expect(steer()).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    }

    // Paused by the user, a message would wake it: that is steering too.
    await client.call('agent.pause', { sessionId: master.sessionId });
    await until(client, master.sessionId, (agent) => agent.state === 'hibernated');
    await expect(connection.call('orchestrator.send', { ...id, text: 'Wake up' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/is paused: only the user, or an orchestrator that may steer it, wakes it/),
    });
  }, 60_000);
});
