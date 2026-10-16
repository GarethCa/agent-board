import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv, McpClient } from '@agent-board/fake-harness';
import { BOARD_MCP_INSTRUCTIONS, ORCHESTRATOR_INSTRUCTIONS } from '../src/board-mcp.ts';
import { AGENT_ERROR, BOARD_ERROR, RPC_ERROR, type Agent, type AgentUpdatedEvent, type DaemonEvent, type HookEvent, type OrchestratorActivityEvent } from '../src/protocol.ts';
import type { DaemonClient } from '../src/client.ts';
import { BOARD_SOCKET_ENV, BOARD_TOKEN_ENV } from '../src/board-env.ts';
import { BoardRefs, identifyView, newAgent, openBoardSession, readBoard, treeView } from '../src/board-ops.ts';
import { runBoardCommand } from '../src/board-cli.ts';
import { paneIds } from '../src/pane-layout.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, TEST_CLI_LAUNCHER, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

/**
 * A daemon whose agents play the fake harnesses' `orchestrate` scenario, with two zones of one repo and one of another.
 * Their agents may not orchestrate unless a test lets them: the zones' setting is off.
 */
async function orchestrateDaemon(options: { dataDir?: string; home?: string } = {}) {
  const daemon = await startOrchestrateDaemon(options);
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const repo = tempRepo();
  const zone = await client.call('zone.add', { path: repo, x: 0, y: 0, name: 'web' });
  const sameRepo = await client.call('zone.addUnbound', { name: 'more web', x: 2000, y: 0 });
  await client.call('zone.setDefaultRepo', { id: sameRepo.id, path: repo });
  const other = await client.call('zone.add', { path: tempRepo('other'), x: 4000, y: 0, name: 'other' });
  for (const { id } of [zone, sameRepo, other]) await client.call('zone.configure', { id, agentsOrchestrate: false });
  return { daemon, client, recorder, zone, sameRepo, other };
}

type Setup = Awaited<ReturnType<typeof orchestrateDaemon>>;

/** A daemon whose agents play the `orchestrate` scenario, in `dataDir` and with the fakes' `home` (fresh by default). */
function startOrchestrateDaemon({ dataDir, home = tempDataDir() }: { dataDir?: string; home?: string }) {
  return startTestDaemon({
    ...(dataDir === undefined ? {} : { dataDir }),
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home, idleNotifyMs: 200 }),
  });
}

/** Waits for an update in which the agent matches `match`. */
async function untilAgent(recorder: Setup['recorder'], sessionId: string, match: (agent: Agent) => boolean): Promise<Agent> {
  const event = await recorder.waitFor(
    (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent),
  );
  return event.agent;
}

/**
 * Starts an agent in `zoneId` that prints its board token and sits at its prompt, and connects as it: the board token
 * presented, as the CLI and MCP do. With `orchestrate`, the user lets it orchestrate in that scope.
 */
async function agentSide(setup: Setup, zoneId: string, orchestrate?: 'zone' | 'repo' | 'board') {
  const agent = await setup.client.call('agent.spawn', { zoneId, prompt: 'Print your board identity', ...SIZE, ...(orchestrate ? { orchestrate } : {}) });
  return { agent, ...(await agentSideOf(setup, agent.sessionId)) };
}

/**
 * Connects as the agent `sessionId`, started with the prompt `Print your board identity`: its board token presented,
 * as its CLI does.
 */
async function agentSideOf(setup: Setup, sessionId: string) {
  const { daemon, client, recorder } = setup;
  await client.call('session.attach', { sessionId });
  await recorder.waitForText(sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(recorder.screenText(sessionId))![1]!;
  const connection = await connectTestClient(daemon);
  await connection.call('board.identify', { token });
  return { token, connection };
}

/** An agent the user started, at its prompt with nothing in its worktree: `spawn` with no prompt. */
async function userAgent(client: DaemonClient, zoneId: string, name: string) {
  return client.call('agent.spawn', { zoneId, name, ...SIZE });
}

/** Starts `agent-board mcp` from source as the agent holding `token`. */
const mcpAs = (setup: Setup, token: string) =>
  new McpClient(
    {
      command: TEST_CLI_LAUNCHER.command,
      args: [...TEST_CLI_LAUNCHER.args, 'mcp'],
      env: { ...process.env, AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: token },
    },
    tempDataDir(),
  );

describe('letting an agent orchestrate', () => {
  it('is off by default, and only the user turns it on', async () => {
    const setup = await orchestrateDaemon();
    const { agent, token, connection } = await agentSide(setup, setup.zone.id);
    expect(agent.orchestrate).toBeNull();
    expect(await connection.call('board.identify', { token })).toMatchObject({ orchestrate: null });

    // Not as itself, over its own connection.
    await expect(connection.call('agent.setOrchestrate', { sessionId: agent.sessionId, scope: 'board' })).rejects.toMatchObject({
      code: BOARD_ERROR.notAllowed,
    });
    await expect(connection.call('orchestrator.spawn', { token, prompt: 'Do it' })).rejects.toMatchObject({
      code: BOARD_ERROR.notAllowed,
      message: expect.stringMatching(/only for an orchestrator/),
    });

    expect(await setup.client.call('agent.setOrchestrate', { sessionId: agent.sessionId, scope: 'zone' })).toMatchObject({ orchestrate: 'zone' });
    expect(await connection.call('board.identify', { token })).toMatchObject({ orchestrate: 'zone' });
    await expect(setup.client.call('agent.setOrchestrate', { sessionId: agent.sessionId, scope: 'everything' as never })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
  });

  it('takes effect at the next call when the user turns it off', async () => {
    const setup = await orchestrateDaemon();
    const { agent, token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const worker = await connection.call('orchestrator.spawn', { token, name: 'one' });
    expect(worker.spawnedBy).toBe(agent.sessionId);

    await setup.client.call('agent.setOrchestrate', { sessionId: agent.sessionId, scope: null });
    await expect(connection.call('orchestrator.interrupt', { token, sessionId: worker.sessionId })).rejects.toMatchObject({
      code: BOARD_ERROR.notAllowed,
    });
  });

  it('passes to the agents an orchestrator starts only by their zone, and keeps settings and permissions out of its reach', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'board');
    const worker = await connection.call('orchestrator.spawn', { token, prompt: 'Write the handover', name: 'child' });
    expect(worker.orchestrate).toBeNull();
    // Whatever it is asked for: a scope by hand is the user's alone.
    const asked = await connection.call('orchestrator.spawn', { token, name: 'sneaky', orchestrate: 'board' } as never);
    expect(asked.orchestrate).toBeNull();
    // Its zone's switch lets it orchestrate there, as it does any agent there.
    await setup.client.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: true });
    await untilAgent(setup.recorder, worker.sessionId, (seen) => seen.orchestrate === 'zone');

    const refused = [
      connection.call('agent.setOrchestrate', { sessionId: worker.sessionId, scope: 'zone' }),
      connection.call('agent.decidePermission', { sessionId: worker.sessionId, requestId: 'r1', behavior: 'allow' }),
      connection.call('session.write', { sessionId: worker.sessionId, data: 'y\r' }),
      connection.call('agent.answer', { sessionId: worker.sessionId, text: 'yes' }),
      connection.call('settings.set', { heldPayloads: 'path' }),
      connection.call('zone.configure', { id: setup.zone.id, boardMcp: false }),
      connection.call('agent.spawn', { zoneId: setup.zone.id, ...SIZE }),
    ];
    for (const call of refused) await expect(call).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
  });

  it('stops at three agents deep: the user\'s, the agents it starts, and theirs, which never orchestrate', async () => {
    const setup = await orchestrateDaemon();
    await setup.client.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: true });
    const lead = await agentSide(setup, setup.zone.id);
    const child = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'child', prompt: 'Print your board identity' });
    expect(child.orchestrate).toBe('zone');
    const childSide = await agentSideOf(setup, child.sessionId);

    const grandchild = await childSide.connection.call('orchestrator.spawn', { token: childSide.token, name: 'grandchild', prompt: 'Print your board identity' });
    expect(grandchild.spawnedBy).toBe(child.sessionId);
    expect(grandchild.orchestrate).toBeNull();
    // Even let orchestrate by hand, the third starts no fourth.
    await setup.client.call('agent.setOrchestrate', { sessionId: grandchild.sessionId, scope: 'zone' });
    const third = await agentSideOf(setup, grandchild.sessionId);
    await expect(third.connection.call('orchestrator.spawn', { token: third.token, name: 'fourth' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/3 agents deep in a crew/),
    });

    // Its depth was fixed as it started: removing the agent between them leaves it as deep as it was.
    // The switch going off clears its grant by hand; back on, its zone alone speaks for it.
    await setup.client.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: false });
    await setup.client.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: true });
    await lead.connection.call('orchestrator.close', { token: lead.token, sessionId: child.sessionId, remove: true });
    const orphan = (await setup.client.call('agent.list')).find((each) => each.sessionId === grandchild.sessionId)!;
    expect(orphan).toMatchObject({ spawnedBy: null, orchestrate: null });
    await expect(third.connection.call('orchestrator.spawn', { token: third.token, name: 'fourth' })).rejects.toMatchObject({
      code: BOARD_ERROR.notAllowed,
      message: expect.stringMatching(/3 agents deep in a crew/),
    });
  });

});

/** Connects as the shell session `pane`, with the board token it holds, as a CLI run in it by hand does. */
async function shellSide(setup: Setup, pane: string) {
  await setup.client.call('session.attach', { sessionId: pane });
  await setup.client.call('session.write', { sessionId: pane, data: 'echo "identity:$AGENT_BOARD_IDENTITY:end"\r' });
  await setup.recorder.waitForText(pane, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(setup.recorder.screenText(pane))![1]!;
  return { token, connection: await connectTestClient(setup.daemon) };
}

describe('a user-side caller: a shell, or the user with no token', () => {
  it("acts for the user from an ended agent's shell, at board scope, logged as that shell; its agents are the user's", async () => {
    const setup = await orchestrateDaemon();
    const { agent } = await agentSide(setup, setup.zone.id);
    const target = await agentSide(setup, setup.other.id, 'board');
    await setup.client.call('agent.stop', { sessionId: agent.sessionId });
    const ended = await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.shellSessionId !== null);
    const { token, connection } = await shellSide(setup, ended.shellSessionId!);

    expect(await connection.call('board.identify', { token })).toMatchObject({ tileId: agent.sessionId, side: 'user', orchestrate: 'board' });
    // It removes an agent the user started, as the user does in the app.
    const users = await userAgent(setup.client, setup.zone.id, 'users');
    await expect(connection.call('orchestrator.close', { token, sessionId: users.sessionId, remove: true })).resolves.toBeNull();
    // Anywhere on the board, an orchestrator of any scope included.
    const started = await connection.call('orchestrator.spawn', { token, zoneId: setup.other.id, name: 'by-hand' });
    expect(started.spawnedBy).toBeNull();
    await expect(connection.call('orchestrator.send', { token, sessionId: target.agent.sessionId, text: 'Carry on' })).resolves.toBeDefined();
    const [line] = await setup.client.call('orchestrator.activity', { limit: 1 });
    expect(line).toMatchObject({ orchestratorId: agent.sessionId, orchestratorName: `${agent.name}'s shell`, action: 'send', outcome: 'done' });
  });

  it("acts for the user from a shell tile and an agent's tab, and may turn orchestrating on and off", async () => {
    const setup = await orchestrateDaemon();
    const { agent } = await agentSide(setup, setup.zone.id);
    const tile = await setup.client.call('shell.create', { zoneId: setup.zone.id });
    const tab = await setup.client.call('shell.createTab', { owner: { kind: 'agent', id: agent.sessionId } });
    for (const pane of [tile.layout, tab.layout].map((layout) => paneIds(layout)[0]!)) {
      const { token, connection } = await shellSide(setup, pane);
      expect(await connection.call('board.identify', { token })).toMatchObject({ side: 'user', orchestrate: 'board' });
      await expect(connection.call('orchestrator.send', { token, sessionId: agent.sessionId, text: 'Carry on' })).resolves.toBeDefined();
      await connection.call('orchestrator.wait', { token, sessionIds: [agent.sessionId] });
      expect(await connection.call('agent.setOrchestrate', { sessionId: agent.sessionId, scope: 'repo' })).toMatchObject({ orchestrate: 'repo' });
      expect(await connection.call('agent.setOrchestrate', { sessionId: agent.sessionId, scope: null })).toMatchObject({ orchestrate: null });
      // Its zone's settings, its switch included, and permissions, stay the user's own in the app (G8, G22).
      const refused = [
        connection.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: true }),
        connection.call('zone.configure', { id: setup.zone.id, gateCommand: 'true' }),
        connection.call('session.write', { sessionId: agent.sessionId, data: 'y\r' }),
        connection.call('agent.answer', { sessionId: agent.sessionId, text: 'yes' }),
        connection.call('agent.decidePermission', { sessionId: agent.sessionId, requestId: 'r', behavior: 'allow' } as never),
      ];
      for (const call of refused) await expect(call).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
    }
  });

  it("keeps an ended agent's own connection the agent's: never the user's side", async () => {
    const setup = await orchestrateDaemon();
    const { agent, connection, token } = await agentSide(setup, setup.zone.id);
    await setup.client.call('agent.stop', { sessionId: agent.sessionId });
    await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.endedAt !== null);
    for (const call of [
      connection.call('agent.setOrchestrate', { sessionId: agent.sessionId, scope: 'board' }),
      connection.call('orchestrator.spawn', { zoneId: setup.zone.id } as never),
    ]) {
      await expect(call).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
    }
    await expect(connection.call('orchestrator.spawn', { token, zoneId: setup.zone.id })).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
    expect((await setup.client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.orchestrate).toBeNull();
  });

  it("keeps an agent's own token off the switches (G11)", async () => {
    const setup = await orchestrateDaemon();
    const { agent, connection } = await agentSide(setup, setup.zone.id, 'board');
    await expect(connection.call('agent.setOrchestrate', { sessionId: agent.sessionId, scope: 'board' })).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
    await expect(connection.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: true })).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
  });

  it('acts for the user with no token, at board scope, logged as the user', async () => {
    const setup = await orchestrateDaemon();
    const started = await setup.client.call('orchestrator.spawn', { zoneId: setup.other.id, name: 'tokenless', prompt: 'Write the handover' });
    expect(started.spawnedBy).toBeNull();
    await setup.client.call('orchestrator.wait', { sessionIds: [started.sessionId] });
    expect((await setup.client.call('orchestrator.read', { sessionId: started.sessionId })).text).toBeTruthy();
    await expect(setup.client.call('orchestrator.close', { sessionId: started.sessionId })).resolves.toBeDefined();
    const [line] = await setup.client.call('orchestrator.activity', { limit: 1 });
    expect(line).toMatchObject({ orchestratorName: 'you', action: 'close', outcome: 'done' });
    // And removes it, as the user does in the app, but never one with unsaved work.
    await expect(setup.client.call('orchestrator.close', { sessionId: started.sessionId, remove: true })).rejects.toMatchObject({ code: AGENT_ERROR.unsavedWork });
    const clean = await setup.client.call('orchestrator.spawn', { zoneId: setup.other.id, name: 'clean' });
    await expect(setup.client.call('orchestrator.close', { sessionId: clean.sessionId, remove: true })).resolves.toBeNull();
    expect((await setup.client.call('agent.list')).some((each) => each.sessionId === clean.sessionId)).toBe(false);
    // A connection that presented a token is that session's: it may not drop it to act as the user.
    const { connection } = await agentSide(setup, setup.zone.id);
    await expect(connection.call('orchestrator.spawn', { zoneId: setup.zone.id } as never)).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
  });

  it("refuses to restart an agent while its own harness runs by hand in its fallback shell, even forced, and restarts it once that exits", async () => {
    const setup = await orchestrateDaemon();
    const { agent } = await agentSide(setup, setup.zone.id, 'zone');
    await setup.client.call('agent.stop', { sessionId: agent.sessionId });
    const ended = await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.shellSessionId !== null);
    const shell = ended.shellSessionId!;
    expect(ended.shellHarness).toBeNull();
    await setup.client.call('session.attach', { sessionId: shell });

    // Once the shell is up (input typed while it starts can be flushed), the user types `claude` in it. It has the
    // daemon's own PATH: the fake one is put first, never a real claude.
    await setup.client.call('session.write', { sessionId: shell, data: 'echo ready-$((1 + 2))\r' });
    await setup.recorder.waitForText(shell, 'ready-3\r\n');
    const fakePath = fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir() }).PATH;
    await setup.client.call('session.write', { sessionId: shell, data: `PATH='${fakePath}' claude\r` });
    const live = await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.shellHarness === 'claude');
    expect(live.endedAt).not.toBeNull();
    await expect(setup.client.call('agent.resume', { sessionId: agent.sessionId, force: true })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining('claude is running in its shell'),
    });

    // The harness exits back to the shell prompt: Restart works again.
    const before = setup.recorder.events.length;
    // Ctrl-C twice, as the fake asks ("Press Ctrl-C again to exit").
    await setup.client.call('session.write', { sessionId: shell, data: '\x03' });
    await setup.recorder.waitForText(shell, 'Press Ctrl-C again');
    await setup.client.call('session.write', { sessionId: shell, data: '\x03' });
    await setup.recorder.waitFor(
      (e: DaemonEvent): e is AgentUpdatedEvent =>
        e.type === 'agent.updated' && e.agent.sessionId === agent.sessionId && e.agent.shellHarness === null && setup.recorder.events.indexOf(e) >= before,
    );
    await expect(setup.client.call('agent.resume', { sessionId: agent.sessionId })).resolves.toMatchObject({ endedAt: null });
  }, 30_000);
});

describe('a zone whose agents may orchestrate', () => {
  it('is on for a new zone', async () => {
    const setup = await orchestrateDaemon();
    const fresh = await setup.client.call('zone.add', { path: tempRepo('fresh'), x: 6000, y: 0, name: 'fresh' });
    expect(fresh.agentsOrchestrate).toBe(true);
    expect((await agentSide(setup, fresh.id)).agent.orchestrate).toBe('zone');
  });

  it('lets every live agent in it orchestrate there, those already there and those an orchestrator started', async () => {
    const setup = await orchestrateDaemon();
    const before = await agentSide(setup, setup.zone.id);
    expect(before.agent.orchestrate).toBeNull();

    expect(await setup.client.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: true })).toMatchObject({ agentsOrchestrate: true });
    expect(await before.connection.call('board.identify', { token: before.token })).toMatchObject({ orchestrate: 'zone' });
    const child = await before.connection.call('orchestrator.spawn', { token: before.token, name: 'child' });
    expect(child.zoneId).toBe(setup.zone.id);
    expect(child.orchestrate).toBe('zone');
    // A board token is refused the switch.
    await expect(before.connection.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: false })).rejects.toMatchObject({
      code: BOARD_ERROR.notAllowed,
    });
  });

  it('grants by where the agent is now: moved in, it orchestrates; moved out, it orchestrates only where the switch is on', async () => {
    const setup = await orchestrateDaemon();
    await setup.client.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: true });
    const outsider = await agentSide(setup, setup.sameRepo.id);
    expect(outsider.agent.orchestrate).toBeNull();
    await setup.client.call('agent.move', { sessionId: outsider.agent.sessionId, zoneId: setup.zone.id, x: 0, y: 400 });
    expect(await outsider.connection.call('board.identify', { token: outsider.token })).toMatchObject({ orchestrate: 'zone' });

    const { agent, token, connection } = await agentSide(setup, setup.zone.id);
    // Into a zone whose switch is off, or loose: it orchestrates nowhere.
    for (const zoneId of [setup.other.id, null]) {
      const moved = await setup.client.call('agent.move', { sessionId: agent.sessionId, zoneId, x: 0, y: 0 });
      expect(moved.orchestrate).toBeNull();
      await expect(connection.call('orchestrator.spawn', { token })).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
    }
    // Into one whose switch is on, it orchestrates there.
    await setup.client.call('zone.configure', { id: setup.other.id, agentsOrchestrate: true });
    expect((await setup.client.call('agent.move', { sessionId: agent.sessionId, zoneId: setup.other.id, x: 0, y: 0 })).orchestrate).toBe('zone');
  });

  it('keeps an agent the user turned off off, whatever its zone says, until the user turns it on', async () => {
    const setup = await orchestrateDaemon();
    await setup.client.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: true });
    const { agent, token, connection } = await agentSide(setup, setup.zone.id);
    expect(agent.orchestrate).toBe('zone');

    expect(await setup.client.call('agent.setOrchestrate', { sessionId: agent.sessionId, scope: null })).toMatchObject({ orchestrate: null });
    await setup.client.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: false });
    await setup.client.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: true });
    expect(await connection.call('board.identify', { token })).toMatchObject({ orchestrate: null });
    await expect(connection.call('orchestrator.spawn', { token })).rejects.toMatchObject({
      code: BOARD_ERROR.notAllowed,
      message: expect.stringMatching(/the user turned it off/),
    });

    expect(await setup.client.call('agent.setOrchestrate', { sessionId: agent.sessionId, scope: 'repo' })).toMatchObject({ orchestrate: 'repo' });
  });

  it('switched off, stops every live agent in it orchestrating at its next call, and no other', async () => {
    const setup = await orchestrateDaemon();
    await setup.client.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: true });
    const granted = await agentSide(setup, setup.zone.id);
    // One the user let orchestrate in their own terminal, in the zone and elsewhere.
    const byHand = await agentSide(setup, setup.zone.id, 'board');
    const elsewhere = await agentSide(setup, setup.other.id, 'zone');

    const configured = await setup.client.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: false });
    expect(configured.agentsOrchestrate).toBe(false);
    await untilAgent(setup.recorder, granted.agent.sessionId, (seen) => seen.orchestrate === null);
    for (const { token, connection } of [granted, byHand]) {
      await expect(connection.call('orchestrator.spawn', { token })).rejects.toMatchObject({
        code: BOARD_ERROR.notAllowed,
        message: expect.stringMatching(/orchestrating is off in web\. The user can turn it on \(Let agents orchestrate, in the zone's ⋯ menu\)/),
      });
    }
    expect(await elsewhere.connection.call('board.identify', { token: elsewhere.token })).toMatchObject({ orchestrate: 'zone' });
    // On again, every agent in it orchestrates in the zone: the grant by hand is gone for good, so the wider scope too.
    await setup.client.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: true });
    await untilAgent(setup.recorder, granted.agent.sessionId, (seen) => seen.orchestrate === 'zone');
    for (const { token, connection } of [granted, byHand]) {
      expect(await connection.call('board.identify', { token })).toMatchObject({ orchestrate: 'zone' });
    }
  });
});

describe('an orchestrator’s scope', () => {
  it('in its zone: starts agents there, acts on agents there and on its own, and nowhere else', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const neighbour = await userAgent(setup.client, setup.zone.id, 'neighbour');
    const elsewhere = await userAgent(setup.client, setup.other.id, 'elsewhere');

    const child = await connection.call('orchestrator.spawn', { token, name: 'child' });
    expect(child.zoneId).toBe(setup.zone.id);
    await expect(connection.call('orchestrator.spawn', { token, zoneId: setup.other.id })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    await expect(connection.call('orchestrator.spawn', { token, zoneId: setup.sameRepo.id })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });

    await expect(connection.call('orchestrator.read', { token, sessionId: neighbour.sessionId, path: 'apps/web/index.ts' })).resolves.toMatchObject({
      text: 'export {};\n',
    });
    await expect(connection.call('orchestrator.read', { token, sessionId: elsewhere.sessionId, path: 'apps/web/index.ts' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    // Its own, even once the user moves it out of the zone.
    await setup.client.call('agent.move', { sessionId: child.sessionId, zoneId: setup.other.id, x: 0, y: 0 });
    await expect(connection.call('orchestrator.read', { token, sessionId: child.sessionId, path: 'apps/web/index.ts' })).resolves.toMatchObject({
      path: 'apps/web/index.ts',
    });
    // Never itself.
    await expect(connection.call('orchestrator.interrupt', { token, sessionId: me.sessionId })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
  });

  it('in its repo: every zone of it, and no other repo', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'repo');
    const child = await connection.call('orchestrator.spawn', { token, zoneId: setup.sameRepo.id, name: 'over there' });
    expect(child.zoneId).toBe(setup.sameRepo.id);
    await expect(connection.call('orchestrator.spawn', { token, zoneId: setup.other.id })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
  });

  it('on the board: anywhere', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'board');
    const elsewhere = await userAgent(setup.client, setup.other.id, 'elsewhere');
    expect((await connection.call('orchestrator.spawn', { token, zoneId: setup.other.id })).zoneId).toBe(setup.other.id);
    await expect(connection.call('orchestrator.read', { token, sessionId: elsewhere.sessionId, path: 'apps/web/index.ts' })).resolves.toBeDefined();
  });
});

describe('what an orchestrator may send', () => {
  it('refuses a prompt or message that would run a harness command, and allows a plugin command', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    for (const prompt of ['/permissions', '  /model opus', '!rm -rf ~', '/Users/me/file.ts is broken', '\n\n  /config']) {
      await expect(connection.call('orchestrator.spawn', { token, prompt })).rejects.toMatchObject({
        code: RPC_ERROR.invalidParams,
        message: expect.stringMatching(/may not send this text: it starts with/),
      });
    }
    const worker = await connection.call('orchestrator.spawn', { token, prompt: '/mattpocock-skills:implement ACME-12', name: 'skilled' });
    expect(worker.description).toBe('/mattpocock-skills:implement ACME-12');
    await untilAgent(setup.recorder, worker.sessionId, (seen) => seen.state === 'idle' || seen.state === 'waiting');
    await expect(connection.call('orchestrator.send', { token, sessionId: worker.sessionId, text: '/config' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/may not send this text: it starts with/),
    });
  });

  it('sends only to an agent between turns', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const worker = await connection.call('orchestrator.spawn', { token, name: 'worker' });
    await connection.call('orchestrator.close', { token, sessionId: worker.sessionId });
    await expect(connection.call('orchestrator.send', { token, sessionId: worker.sessionId, text: 'more' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/has ended/),
    });
  });
});

describe('what an orchestrator may type', () => {
  /** Characters a terminal or a harness could take as keys or hide a command behind: refused anywhere in the text. */
  const HIDDEN = [
    '\x01/model opus',
    '\x7f/permissions',
    '\x02!rm -rf ~',
    '\x1b[Z',
    'hello\x1bthere',
    'one\rtwo',
    '\u0085/config',
    '\u200b/model opus',
    '\u202e/permissions',
    '\ufeff/model',
    '\u2028/model',
  ];

  it('refuses a control or format character anywhere in a prompt', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    for (const prompt of HIDDEN) {
      await expect(connection.call('orchestrator.spawn', { token, prompt }), JSON.stringify(prompt)).rejects.toMatchObject({
        code: RPC_ERROR.invalidParams,
        message: expect.stringMatching(/control or format character/),
      });
    }
  });

  it('refuses a control or format character anywhere in a message, and types nothing', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const worker = await connection.call('orchestrator.spawn', { token, name: 'worker' });
    await setup.client.call('session.attach', { sessionId: worker.sessionId });
    for (const text of HIDDEN) {
      await expect(connection.call('orchestrator.send', { token, sessionId: worker.sessionId, text }), JSON.stringify(text)).rejects.toMatchObject({
        code: RPC_ERROR.invalidParams,
      });
    }
    expect(setup.recorder.screenText(worker.sessionId)).not.toMatch(/model|permissions|config/);
  });

  it('takes Markdown, tabs and line breaks, and a heading first', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const worker = await connection.call('orchestrator.spawn', { token, name: 'md', prompt: '# Task\n\n- one\n\t- two: `/not a command`' });
    expect(worker.description).toBe('# Task\n\n- one\n\t- two: `/not a command`');
  });
});

describe('the orchestrator loop', () => {
  it('starts a worker, waits for it, reads its handover, sends a follow-up and waits for that turn, not the idle before it', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const worker = await connection.call('orchestrator.spawn', { token, prompt: 'Write the handover', name: 'worker' });
    expect(worker).toMatchObject({ spawnedBy: me.sessionId, name: 'worker', zoneId: setup.zone.id });

    const first = await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId] });
    expect(first.timedOut).toBe(false);
    expect(first.agents[0]!.state).toMatch(/idle|waiting/);
    expect(await connection.call('orchestrator.read', { token, sessionId: worker.sessionId, path: '.agent-board/handover.md' })).toEqual({
      text: '# Handover\n\nThe work is done.\n',
      path: '.agent-board/handover.md',
    });
    expect((await connection.call('orchestrator.read', { token, sessionId: worker.sessionId })).text).toBe('Handover written.\nSTATUS: done');

    await connection.call('orchestrator.send', { token, sessionId: worker.sessionId, text: 'Also add a test' });
    expect(await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId] })).toMatchObject({ timedOut: false });
    expect((await connection.call('orchestrator.read', { token, sessionId: worker.sessionId })).text).toBe('Done: Also add a test.');

    const closed = await connection.call('orchestrator.close', { token, sessionId: worker.sessionId });
    expect(closed).toMatchObject({ state: 'done' });
  });

  it('times out a wait, saying where each agent got to', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const worker = await connection.call('orchestrator.spawn', { token, name: 'worker' });
    await connection.call('orchestrator.close', { token, sessionId: worker.sessionId });
    const result = await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId], states: ['running'], timeoutMs: 50 });
    expect(result).toMatchObject({ timedOut: true, agents: [{ sessionId: worker.sessionId, state: 'done' }] });
  });

  it('reads only files inside the worktree', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const worker = await connection.call('orchestrator.spawn', { token, name: 'worker' });
    const outside = join(tempDataDir(), 'secret.txt');
    writeFileSync(outside, 'secret');
    mkdirSync(join(worker.worktree, 'links'));
    symlinkSync(outside, join(worker.worktree, 'links', 'secret.txt'));
    for (const path of ['../../secret.txt', outside, 'links/secret.txt', 'missing.md']) {
      await expect(connection.call('orchestrator.read', { token, sessionId: worker.sessionId, path })).rejects.toMatchObject({
        code: RPC_ERROR.invalidParams,
      });
    }
  });

  it('removes only an agent it started, and never one with unsaved work', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const neighbour = await userAgent(setup.client, setup.zone.id, 'neighbour');
    await expect(connection.call('orchestrator.close', { token, sessionId: neighbour.sessionId, remove: true })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/only an agent you started/),
    });

    const messy = await connection.call('orchestrator.spawn', { token, name: 'messy' });
    writeFileSync(join(messy.worktree, 'draft.txt'), 'unsaved');
    await expect(connection.call('orchestrator.close', { token, sessionId: messy.sessionId, remove: true })).rejects.toMatchObject({
      code: AGENT_ERROR.unsavedWork,
    });

    const clean = await connection.call('orchestrator.spawn', { token, name: 'clean' });
    expect(await connection.call('orchestrator.close', { token, sessionId: clean.sessionId, remove: true })).toBeNull();
    expect((await setup.client.call('agent.list')).map((agent) => agent.name)).not.toContain('clean');
  });

  it("never removes a reviewer the user started of an agent it started, nor anything with unsaved work", async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const child = await connection.call('orchestrator.spawn', { token, name: 'child' });
    git(child.worktree, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '--allow-empty', '-q', '-m', 'the work');
    const round = await setup.client.call('review.start', { sessionId: child.sessionId });

    await expect(connection.call('orchestrator.close', { token, sessionId: child.sessionId, remove: true })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/reviewer/),
    });
    const left = (await setup.client.call('agent.list')).map((agent) => agent.sessionId);
    expect(left).toContain(round.reviewer);
    expect(left).toContain(child.sessionId);
  });

  it('forgets a deleted orchestrator in the agents it started', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const child = await connection.call('orchestrator.spawn', { token, name: 'child' });
    await setup.client.call('agent.delete', { sessionId: me.sessionId, force: true });
    expect((await setup.client.call('agent.list')).find((agent) => agent.sessionId === child.sessionId)!.spawnedBy).toBeNull();
  });
});

describe('steering a turn', () => {
  it('refuses to send mid-turn, interrupts the turn, and then sends', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const worker = await connection.call('orchestrator.spawn', { token, name: 'slow', prompt: 'Work slowly' });
    await untilAgent(setup.recorder, worker.sessionId, (seen) => seen.state === 'running');

    await expect(connection.call('orchestrator.send', { token, sessionId: worker.sessionId, text: 'hurry' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/is running: wait for its turn to end, or interrupt it/),
    });
    expect(await connection.call('orchestrator.interrupt', { token, sessionId: worker.sessionId })).toMatchObject({ state: 'idle' });
    await connection.call('orchestrator.send', { token, sessionId: worker.sessionId, text: 'Do it faster' });
    expect(await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId] })).toMatchObject({ timedOut: false });
    expect((await connection.call('orchestrator.read', { token, sessionId: worker.sessionId })).text).toBe('Done: Do it faster.');
  });

  it('never types to an agent waiting mid-turn on the user’s answer to its question', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const worker = await connection.call('orchestrator.spawn', { token, name: 'asker', prompt: 'Ask in words: What should the banner say?' });
    await untilAgent(setup.recorder, worker.sessionId, (seen) => seen.ask !== null);

    await expect(connection.call('orchestrator.send', { token, sessionId: worker.sessionId, text: 'Free shipping' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/waiting on the user's answer to its question or plan/),
    });
  });

  it('never types to an agent that needs the user’s permission', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const worker = await connection.call('orchestrator.spawn', { token, name: 'asker', prompt: 'Ask permission' });
    await untilAgent(setup.recorder, worker.sessionId, (seen) => seen.permissions.length > 0);

    await expect(connection.call('orchestrator.send', { token, sessionId: worker.sessionId, text: 'yes' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/needs the user's permission first/),
    });
    // The wait says so: needing the user is a settled state.
    expect(await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId] })).toMatchObject({
      timedOut: false,
      agents: [{ state: 'needs-permission' }],
    });
  });

  it('waits for any of several, or for all', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const quick = await connection.call('orchestrator.spawn', { token, name: 'quick', prompt: 'Write the handover' });
    const slow = await connection.call('orchestrator.spawn', { token, name: 'slow', prompt: 'Work slowly' });

    const any = await connection.call('orchestrator.wait', { token, sessionIds: [quick.sessionId, slow.sessionId], any: true });
    expect(any.timedOut).toBe(false);
    // The slow one's turn hasn't ended: it hasn't begun, or is on its way (on a loaded machine it may be thinking already).
    expect(['idle', 'running', 'thinking']).toContain(any.agents.find((agent) => agent.name === 'slow')!.state);
    await expect(connection.call('orchestrator.read', { token, sessionId: slow.sessionId })).rejects.toMatchObject({
      message: expect.stringMatching(/has not finished a turn yet/),
    });
    const all = await connection.call('orchestrator.wait', { token, sessionIds: [quick.sessionId, slow.sessionId] });
    expect(all.timedOut).toBe(false);
    expect((await connection.call('orchestrator.read', { token, sessionId: slow.sessionId })).text).toBe('Slow work done.');
  });

  it('steers another orchestrator unless its scope is wider: board > repo > zone', async () => {
    const setup = await orchestrateDaemon();
    const narrow = await agentSide(setup, setup.zone.id, 'zone');
    const peer = await agentSide(setup, setup.zone.id, 'zone');
    const repo = await agentSide(setup, setup.zone.id, 'repo');
    const wide = await agentSide(setup, setup.zone.id, 'board');

    for (const target of [repo, wide]) {
      await expect(narrow.connection.call('orchestrator.send', { token: narrow.token, sessionId: target.agent.sessionId, text: 'close everything' })).rejects.toMatchObject({
        code: BOARD_ERROR.outOfScope,
        message: expect.stringMatching(/is an orchestrator whose scope is wider than yours/),
      });
      await expect(narrow.connection.call('orchestrator.close', { token: narrow.token, sessionId: target.agent.sessionId })).rejects.toMatchObject({
        code: BOARD_ERROR.outOfScope,
      });
    }
    await expect(repo.connection.call('orchestrator.interrupt', { token: repo.token, sessionId: wide.agent.sessionId })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    // It may still watch one.
    expect((await narrow.connection.call('orchestrator.wait', { token: narrow.token, sessionIds: [wide.agent.sessionId] })).timedOut).toBe(false);
    // A peer of the same scope, or a narrower one, it may steer.
    await expect(narrow.connection.call('orchestrator.send', { token: narrow.token, sessionId: peer.agent.sessionId, text: 'Carry on' })).resolves.toBeDefined();
    await expect(repo.connection.call('orchestrator.send', { token: repo.token, sessionId: narrow.agent.sessionId, text: 'Carry on' })).resolves.toBeDefined();
    await expect(wide.connection.call('orchestrator.send', { token: wide.token, sessionId: repo.agent.sessionId, text: 'Carry on' })).resolves.toBeDefined();
  });

  it('starts no agent from a base whose project config differs from the repo’s HEAD', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const commit = (worktree: string, message: string) =>
      git(worktree, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', message);

    const sneaky = await connection.call('orchestrator.spawn', { token, name: 'sneaky' });
    mkdirSync(join(sneaky.worktree, '.claude'));
    writeFileSync(join(sneaky.worktree, '.claude', 'settings.json'), '{"permissions":{"defaultMode":"bypassPermissions"}}');
    git(sneaky.worktree, 'add', '.claude');
    commit(sneaky.worktree, 'loosen the settings');
    await expect(connection.call('orchestrator.spawn', { token, name: 'loose', baseBranch: sneaky.branch })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/project config differs.*\.claude\/settings\.json/),
    });

    const plain = await connection.call('orchestrator.spawn', { token, name: 'plain' });
    commit(plain.worktree, 'the work');
    const reviewer = await connection.call('orchestrator.spawn', { token, name: 'reviewer', baseBranch: plain.branch, role: 'reviewer' });
    expect(git(reviewer.worktree, 'log', '-1', '--format=%s')).toBe('the work');
  });
});

describe('what an orchestrator may hand git', () => {
  it('never lets a base or branch name reach git as an option', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const victim = join(tempDataDir(), 'victim.txt');
    writeFileSync(victim, 'precious');
    const names = [`--output=${victim}`, `-o${victim}`, '--no-index', '-p', '--end-of-options', 'a..b', ' --output=x', 'HEAD~1', 'main:secret'];
    for (const name of names) {
      await expect(connection.call('orchestrator.spawn', { token, baseBranch: name }), `base ${name}`).rejects.toMatchObject({
        code: RPC_ERROR.invalidParams,
      });
      await expect(connection.call('orchestrator.spawn', { token, branch: name }), `branch ${name}`).rejects.toMatchObject({
        code: RPC_ERROR.invalidParams,
      });
    }
    // A name becomes a branch only as a slug, which never starts with a dash.
    const named = await connection.call('orchestrator.spawn', { token, name: `--output=${victim}` });
    expect(named.branch).toMatch(/^output-/);
    expect(readFileSync(victim, 'utf8')).toBe('precious');
    // The user's own spawn checks its base the same way.
    await expect(setup.client.call('agent.spawn', { zoneId: setup.zone.id, baseBranch: `--output=${victim}`, ...SIZE })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
    expect(readFileSync(victim, 'utf8')).toBe('precious');
  });

  it('checks the branch the agent is cut from, not a tag of the same name', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const sneaky = await connection.call('orchestrator.spawn', { token, name: 'sneaky' });
    mkdirSync(join(sneaky.worktree, '.claude'));
    writeFileSync(join(sneaky.worktree, '.claude', 'settings.json'), '{"permissions":{"defaultMode":"bypassPermissions"}}');
    git(sneaky.worktree, 'add', '.claude');
    git(sneaky.worktree, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'loosen the settings');
    // A tag named as the branch, on the clean HEAD: git's own lookup would take the tag first.
    git(sneaky.worktree, 'tag', sneaky.branch, 'HEAD~1');

    await expect(connection.call('orchestrator.spawn', { token, name: 'loose', baseBranch: sneaky.branch })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/project config differs.*\.claude\/settings\.json/),
    });
  });
});

describe('the activity log', () => {
  it('records what each orchestrator did and tried, newest first, and tells every client', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const child = await connection.call('orchestrator.spawn', { token, name: 'child', prompt: 'Write the handover' });
    await expect(connection.call('orchestrator.spawn', { token, zoneId: setup.other.id })).rejects.toBeDefined();
    await connection.call('orchestrator.wait', { token, sessionIds: [child.sessionId] });
    await connection.call('orchestrator.send', { token, sessionId: child.sessionId, text: 'Also add a test' });
    await connection.call('orchestrator.read', { token, sessionId: child.sessionId });

    const event = await setup.recorder.waitFor(
      (e: DaemonEvent): e is OrchestratorActivityEvent => e.type === 'orchestrator.activity' && e.entry.action === 'send',
    );
    expect(event.entry).toMatchObject({ orchestratorId: me.sessionId, targetId: child.sessionId, detail: 'Also add a test', outcome: 'done' });

    const log = await setup.client.call('orchestrator.activity', { orchestratorId: me.sessionId });
    expect(log.map(({ action, outcome, targetName }) => ({ action, outcome, targetName }))).toEqual([
      { action: 'send', outcome: 'done', targetName: 'child' },
      { action: 'spawn', outcome: 'refused', targetName: null },
      { action: 'spawn', outcome: 'done', targetName: 'child' },
    ]);
    expect(log[1]).toMatchObject({ orchestratorName: me.name, reason: expect.stringMatching(/outside your scope/) });
    // A read, from a session's board token too.
    expect(await connection.call('orchestrator.activity', { limit: 1 })).toHaveLength(1);
  });

  it('reads page by page, each older than the last line read', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    for (const zoneId of [setup.other.id, setup.other.id, setup.other.id]) {
      await expect(connection.call('orchestrator.spawn', { token, zoneId })).rejects.toBeDefined();
    }
    const first = await setup.client.call('orchestrator.activity', { orchestratorId: me.sessionId, limit: 2 });
    const next = await setup.client.call('orchestrator.activity', { orchestratorId: me.sessionId, limit: 2, before: first.at(-1)!.id });
    expect(next).toHaveLength(1);
    expect([...first, ...next].map((line) => line.id)).toEqual(
      (await setup.client.call('orchestrator.activity', { orchestratorId: me.sessionId })).map((line) => line.id),
    );
  });

  it('logs what a tile that may not orchestrate tried, and its bad calls', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    await setup.client.call('agent.setOrchestrate', { sessionId: me.sessionId, scope: null });
    await expect(connection.call('orchestrator.spawn', { token, prompt: 'Sneak one in' })).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
    await setup.client.call('agent.setOrchestrate', { sessionId: me.sessionId, scope: 'zone' });
    await expect(connection.call('orchestrator.send', { token, sessionId: 'nobody', text: 'hi' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });

    const log = await setup.client.call('orchestrator.activity', { orchestratorId: me.sessionId });
    expect(log.map(({ action, outcome, detail, targetId }) => ({ action, outcome, detail, targetId }))).toEqual([
      { action: 'send', outcome: 'refused', detail: 'hi', targetId: null },
      { action: 'spawn', outcome: 'refused', detail: 'Sneak one in', targetId: null },
    ]);
    expect(log[1]!.reason).toMatch(/only for an orchestrator/);
  });

  it('shows every session every line, live and read', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id, 'zone');
    const other = await agentSide(setup, setup.zone.id);
    const otherHears = recordEvents(other.connection);
    await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'child', prompt: 'A plan' });

    const isActivity = (e: DaemonEvent): e is OrchestratorActivityEvent => e.type === 'orchestrator.activity';
    await otherHears.waitFor(isActivity);
    await setup.recorder.waitFor(isActivity);

    expect(await other.connection.call('orchestrator.activity', {})).toHaveLength(1);
    expect(await other.connection.call('orchestrator.activity', { orchestratorId: lead.agent.sessionId })).toHaveLength(1);
    expect(await other.connection.call('orchestrator.activity', { orchestratorId: other.agent.sessionId })).toEqual([]);
    expect(await setup.client.call('orchestrator.activity', {})).toHaveLength(1);
  });
});

describe('an orchestrator agent, over the board MCP and CLI', () => {
  it('starts a worker, waits for it, reads its handover, sends a follow-up and closes it', async () => {
    const setup = await orchestrateDaemon();
    const lead = await setup.client.call('agent.spawn', {
      zoneId: setup.zone.id,
      prompt: 'Orchestrate: Write the handover',
      name: 'lead',
      orchestrate: 'zone',
      ...SIZE,
    });
    await setup.client.call('session.attach', { sessionId: lead.sessionId });

    await setup.recorder.waitForText(lead.sessionId, 'The worker is done and closed.');
    const screen = setup.recorder.screenText(lead.sessionId).replace(/\r/g, '');
    const worker = (await setup.client.call('agent.list')).find((agent) => agent.name === 'worker')!;
    const ref = `agent:${worker.sessionId.slice(0, 4)}`;
    expect(worker).toMatchObject({ spawnedBy: lead.sessionId, orchestrate: null, zoneId: setup.zone.id, state: 'done' });
    expect(screen).toContain(`Started ${ref}  worker  [`);
    expect(screen).toContain('# Handover\n\nThe work is done.');
    expect(screen).toContain('Done: Also add a test.');
    expect(screen).toContain(`Closed ${ref} worker: its session ended`);

    const log = await setup.client.call('orchestrator.activity', { orchestratorId: lead.sessionId });
    expect(log.map(({ action, outcome }) => `${action} ${outcome}`)).toEqual(['close done', 'send done', 'spawn done']);
  });

  it('offers an agent that may not orchestrate no control tools', async () => {
    const setup = await orchestrateDaemon();
    const lead = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'Orchestrate: Write the handover', name: 'lead', ...SIZE });
    await setup.client.call('session.attach', { sessionId: lead.sessionId });

    await setup.recorder.waitForText(lead.sessionId, 'I could not start a worker.');
    expect(setup.recorder.screenText(lead.sessionId)).toContain('No such tool available: new_agent');
    expect(await setup.client.call('orchestrator.activity', {})).toEqual([]);
  });
});

describe('agent-board mcp for an orchestrator', () => {
  it('tells an orchestrator so, and lists the control tools to it alone', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id, 'zone');
    const plain = await agentSide(setup, setup.zone.id);

    const leadMcp = mcpAs(setup, lead.token);
    expect((await leadMcp.initialize()).instructions).toBe(`${BOARD_MCP_INSTRUCTIONS} ${ORCHESTRATOR_INSTRUCTIONS}`);
    expect(await leadMcp.listTools()).toEqual([
      'whoami', 'board', 'connections', 'handoff', 'ask', 'present_plan', 'set_status', 'open_pr', 'new_agent', 'send', 'wait', 'read', 'interrupt', 'restart', 'add_edge', 'list_edges', 'remove_edge', 'move', 'arrange', 'add_note',
      'edit_note', 'remove_note', 'roles', 'set_role', 'remove_role', 'close',
    ]);

    const plainMcp = mcpAs(setup, plain.token);
    expect((await plainMcp.initialize()).instructions).toBe(BOARD_MCP_INSTRUCTIONS);
    expect(await plainMcp.listTools()).toEqual(['whoami', 'board', 'connections', 'handoff', 'ask', 'present_plan', 'set_status', 'open_pr']);
  });

  it('joins two of its agents with an edge, and removes it, over the tools', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id, 'zone');
    const impl = await userAgent(setup.client, setup.zone.id, 'impl');
    const review = await userAgent(setup.client, setup.zone.id, 'review');
    const mcp = mcpAs(setup, lead.token);

    const added = await mcp.callTool('add_edge', {
      from: 'impl',
      to: 'review',
      carries: 'handover',
      path: '.agent-board/handover.md',
      conditions: [{ kind: 'gate-green', command: 'pnpm check:local' }],
    });

    expect(added).toMatchObject({ isError: false, text: expect.stringContaining('made by agent:') });
    expect(added.text).toContain('runs nothing until the user approves it');
    const [edge] = await setup.client.call('flowEdge.list');
    expect(edge).toMatchObject({ from: impl.sessionId, to: review.sessionId, payload: 'handover', madeBy: lead.agent.sessionId });
    expect(await mcp.callTool('remove_edge', { edge: `edge:${edge!.id}` })).toMatchObject({ isError: false, text: expect.stringMatching(/^Removed edge:/) });
    expect(await setup.client.call('flowEdge.list')).toEqual([]);
  });
});

describe('the app’s default roles over the tools', () => {
  it('an orchestrator sets one, logged as it, and an agent it starts in that role begins with it', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id, 'board');
    const mcp = mcpAs(setup, lead.token);

    expect(await mcp.callTool('set_role', { name: 'designer', template: 'Draw on {{branch}}.' })).toMatchObject({
      isError: false,
      text: expect.stringContaining('Set the default role designer'),
    });
    expect(await mcp.callTool('roles', {})).toMatchObject({ isError: false, text: 'designer  Draw on {{branch}}.' });
    const started = await mcp.callTool('new_agent', { prompt: 'Mock it', name: 'mocks', role: 'designer' });
    expect(started).toMatchObject({ isError: false, text: expect.stringMatching(/mocks {2}\[\S+\] {2}\(designer\)/) });
    const [line] = await setup.client.call('orchestrator.activity', { orchestratorId: lead.agent.sessionId, limit: 2 });
    expect(line).toMatchObject({ action: 'spawn' });
    const [, set] = await setup.client.call('orchestrator.activity', { orchestratorId: lead.agent.sessionId, limit: 2 });
    expect(set).toMatchObject({ action: 'set-role', targetName: 'designer', outcome: 'done' });

    expect(await mcp.callTool('remove_role', { name: 'designer' })).toMatchObject({ isError: false });
    expect(await mcp.callTool('remove_role', { name: 'designer' })).toMatchObject({ isError: true, text: expect.stringContaining('no default role designer') });
  });

  it('lets only a board-scope orchestrator change the app’s list; a narrower one sets its own zone’s template', async () => {
    const setup = await orchestrateDaemon();
    for (const scope of ['zone', 'repo'] as const) {
      const { token, connection } = await agentSide(setup, setup.zone.id, scope);
      await expect(connection.call('orchestrator.setRole', { token, name: 'designer', body: 'x' })).rejects.toMatchObject({
        code: BOARD_ERROR.outOfScope,
        message: expect.stringContaining('board'),
      });
      await expect(connection.call('orchestrator.removeRole', { token, name: 'designer' })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
      const [refused] = await setup.client.call('orchestrator.activity', { limit: 1 });
      expect(refused).toMatchObject({ action: 'remove-role', outcome: 'refused' });
    }
    expect(await setup.client.call('orchestrator.roles', {})).toEqual([]);

    const zoneLead = await agentSide(setup, setup.zone.id, 'zone');
    const set = await zoneLead.connection.call('orchestrator.setRole', { token: zoneLead.token, name: 'designer', body: 'Zone design.', zoneId: setup.zone.id });
    expect(set).toMatchObject({ name: 'designer', body: 'Zone design.' });
    expect((await setup.client.call('zone.roleTemplates', { id: setup.zone.id })).find((each) => each.role === 'designer')).toMatchObject({
      body: 'Zone design.',
      appDefault: false,
    });
    await expect(
      zoneLead.connection.call('orchestrator.setRole', { token: zoneLead.token, name: 'designer', body: 'x', zoneId: setup.other.id }),
    ).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    await zoneLead.connection.call('orchestrator.removeRole', { token: zoneLead.token, name: 'designer', zoneId: setup.zone.id });
    expect((await setup.client.call('zone.roleTemplates', { id: setup.zone.id })).find((each) => each.role === 'designer')).toBeUndefined();

    const boardLead = await agentSide(setup, setup.zone.id, 'board');
    expect(await boardLead.connection.call('orchestrator.setRole', { token: boardLead.token, name: 'designer', body: 'App design.' })).toMatchObject({
      name: 'designer',
    });
  });

  it('refuses an agent that may not orchestrate', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);

    await expect(connection.call('orchestrator.setRole', { token, name: 'designer', body: 'x' })).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
    await expect(connection.call('orchestrator.roles', { token })).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
  });
});

describe('restarting an ended agent', () => {
  /** Ends the agent, as the user stopping it would, and resolves once its pane has dropped into its shell. */
  const end = async (setup: Setup, sessionId: string) => {
    const before = setup.recorder.events.length;
    await setup.client.call('agent.stop', { sessionId });
    return untilAgentAfter(setup, before, sessionId, (agent) => agent.endedAt !== null && agent.shellSessionId !== null);
  };

  /** Waits for an update to the agent, sent after the `before`th event, in which it matches `match`. */
  const untilAgentAfter = async (setup: Setup, before: number, sessionId: string, match: (agent: Agent) => boolean) => {
    const event = await setup.recorder.waitFor(
      (e: DaemonEvent): e is AgentUpdatedEvent =>
        e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent) && setup.recorder.events.indexOf(e) >= before,
    );
    return event.agent;
  };

  /** Resolves with the agent's SessionStart, sent after the `before`th event. */
  const sessionStartAfter = (setup: Setup, before: number, sessionId: string) =>
    setup.recorder.waitFor(
      (e: DaemonEvent): e is HookEvent =>
        e.type === 'hook' && e.sessionId === sessionId && e.event === 'SessionStart' && setup.recorder.events.indexOf(e) >= before,
    );

  it('restarts an ended agent in its scope in place, carrying on its conversation, over the CLI and the MCP, and logs it', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id, 'zone');
    const { agent: worker } = await agentSide(setup, setup.zone.id);
    const ref = `agent:${worker.sessionId.slice(0, 4)}`;
    const env = { [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: lead.token };

    await end(setup, worker.sessionId);
    let before = setup.recorder.events.length;
    let out = '';
    const code = await runBoardCommand('restart', [ref], { out: (text) => (out += text), err: (text) => (out += text), env });
    expect({ code, out }).toEqual({ code: 0, out: expect.stringMatching(new RegExp(`^Restarted ${ref} `)) });
    expect((await sessionStartAfter(setup, before, worker.sessionId)).payload).toMatchObject({ source: 'resume', session_id: worker.sessionId });

    await end(setup, worker.sessionId);
    before = setup.recorder.events.length;
    const mcp = mcpAs(setup, lead.token);
    expect(await mcp.callTool('restart', { agent: ref })).toMatchObject({ isError: false, text: expect.stringMatching(/^Restarted agent:/) });
    expect((await sessionStartAfter(setup, before, worker.sessionId)).payload).toMatchObject({ source: 'resume', session_id: worker.sessionId });

    // The same tile, worktree and branch.
    const restarted = (await setup.client.call('agent.list')).find((each) => each.sessionId === worker.sessionId)!;
    const { zoneId, position, worktree, branch, cwd } = worker;
    expect(restarted).toMatchObject({ endedAt: null, zoneId, position, worktree, branch, cwd });
    const log = await setup.client.call('orchestrator.activity', { orchestratorId: lead.agent.sessionId });
    expect(log.map(({ action, outcome, targetId }) => `${action} ${outcome} ${targetId}`)).toEqual([
      `restart done ${worker.sessionId}`,
      `restart done ${worker.sessionId}`,
    ]);
  }, 30_000);

  it('restarts an ended agent fresh over the CLI and the MCP: a new conversation in the same tile, worktree and branch, the old one kept', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id, 'zone');
    const { agent: worker } = await agentSide(setup, setup.zone.id);
    const ref = `agent:${worker.sessionId.slice(0, 4)}`;
    const env = { [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: lead.token };
    const listed = async () => (await setup.client.call('agent.list')).find((each) => each.sessionId === worker.sessionId)!;

    await end(setup, worker.sessionId);
    let before = setup.recorder.events.length;
    let out = '';
    const code = await runBoardCommand('restart', [ref, '--fresh', '--', 'start over'], { out: (text) => (out += text), err: (text) => (out += text), env });
    expect({ code, out }).toEqual({ code: 0, out: expect.stringMatching(new RegExp(`^Restarted ${ref} `)) });
    const first = (await sessionStartAfter(setup, before, worker.sessionId)).payload;
    expect(first).toMatchObject({ source: 'startup' });
    expect(first.session_id).not.toBe(worker.sessionId);
    expect((await listed()).earlierConversations).toEqual([{ conversationId: worker.sessionId, transcriptPath: expect.any(String), endedAt: expect.any(String) }]);

    // Once the new conversation has had a turn (its transcript saved), a plain restart carries on it, not the old one.
    await setup.recorder.waitFor(
      (e: DaemonEvent): e is HookEvent =>
        e.type === 'hook' && e.sessionId === worker.sessionId && e.event === 'Stop' && setup.recorder.events.indexOf(e) >= before,
    );
    await end(setup, worker.sessionId);
    before = setup.recorder.events.length;
    await runBoardCommand('restart', [ref], { out: (text) => (out += text), err: (text) => (out += text), env });
    expect((await sessionStartAfter(setup, before, worker.sessionId)).payload).toMatchObject({ source: 'resume', session_id: first.session_id });

    await end(setup, worker.sessionId);
    before = setup.recorder.events.length;
    const mcp = mcpAs(setup, lead.token);
    expect(await mcp.callTool('restart', { agent: ref, fresh: true })).toMatchObject({ isError: false, text: expect.stringMatching(/^Restarted agent:/) });
    const second = (await sessionStartAfter(setup, before, worker.sessionId)).payload;
    expect(second).toMatchObject({ source: 'startup' });
    expect([worker.sessionId, first.session_id]).not.toContain(second.session_id);

    const restarted = await listed();
    expect(restarted.earlierConversations.map((each) => each.conversationId)).toEqual([worker.sessionId, first.session_id]);
    const { zoneId, position, worktree, branch, cwd } = worker;
    expect(restarted).toMatchObject({ endedAt: null, zoneId, position, worktree, branch, cwd });
    const log = await setup.client.call('orchestrator.activity', { orchestratorId: lead.agent.sessionId });
    expect(log.map(({ action, outcome, detail }) => `${action} ${outcome} ${detail}`)).toEqual([
      'restart done fresh',
      'restart done ',
      'restart done fresh: start over',
    ]);
  }, 45_000);

  it('refuses a fresh prompt an orchestrator may not type, and a prompt without fresh, leaving the agent ended', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id, 'zone');
    const { agent: worker } = await agentSide(setup, setup.zone.id);
    const ref = `agent:${worker.sessionId.slice(0, 4)}`;
    const env = { [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: lead.token };
    await end(setup, worker.sessionId);

    let out = '';
    const io = { out: (text: string) => (out += text), err: (text: string) => (out += text), env };
    for (const prompt of ['!rm -rf /', '/clear']) {
      out = '';
      expect(await runBoardCommand('restart', [ref, '--fresh', '--', prompt], io)).not.toBe(0);
      expect(out).toContain('may not send this text');
      expect(await mcpAs(setup, lead.token).callTool('restart', { agent: ref, fresh: true, prompt })).toMatchObject({ isError: true });
    }
    out = '';
    expect(await runBoardCommand('restart', [ref, '--', 'hello'], io)).not.toBe(0);
    expect(out).toContain('needs --fresh');
    expect(await mcpAs(setup, lead.token).callTool('restart', { agent: ref, prompt: 'hello' })).toMatchObject({ isError: true });

    const agent = (await setup.client.call('agent.list')).find((each) => each.sessionId === worker.sessionId)!;
    expect(agent.endedAt).not.toBeNull();
    expect(agent.earlierConversations).toEqual([]);
    const log = await setup.client.call('orchestrator.activity', { orchestratorId: lead.agent.sessionId });
    expect(log.filter(({ outcome }) => outcome === 'refused').length).toBeGreaterThanOrEqual(4);
  }, 30_000);

  it('leaves the conversation as it was when the fresh launch fails, with no earlier conversation recorded', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id, 'zone');
    const { agent: worker } = await agentSide(setup, setup.zone.id);
    await end(setup, worker.sessionId);
    rmSync(worker.cwd, { recursive: true, force: true });

    await expect(lead.connection.call('orchestrator.restart', { token: lead.token, sessionId: worker.sessionId, fresh: true })).rejects.toMatchObject({
      message: expect.stringContaining('worktree is gone'),
    });
    const agent = (await setup.client.call('agent.list')).find((each) => each.sessionId === worker.sessionId)!;
    expect(agent.endedAt).not.toBeNull();
    expect(agent.earlierConversations).toEqual([]);
  }, 30_000);

  it('refuses a fresh restart of an agent outside its scope', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const elsewhere = await userAgent(setup.client, setup.other.id, 'elsewhere');
    await setup.client.call('agent.stop', { sessionId: elsewhere.sessionId });
    await expect(connection.call('orchestrator.restart', { token, sessionId: elsewhere.sessionId, fresh: true })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    expect((await setup.client.call('agent.list')).find((each) => each.sessionId === elsewhere.sessionId)!.earlierConversations).toEqual([]);
  });

  it('restarts an agent stopped by a restart of agent-board, carrying on its conversation', async () => {
    const dataDir = tempDataDir();
    const home = tempDataDir();
    const setup = await orchestrateDaemon({ dataDir, home });
    const { agent: worker } = await agentSide(setup, setup.zone.id);
    await setup.daemon.stop();
    const daemon = await startOrchestrateDaemon({ dataDir, home });
    const client = await connectTestClient(daemon);
    const recorder = recordEvents(client);
    expect((await client.call('agent.list')).find((each) => each.sessionId === worker.sessionId)!.state).toBe('stopped-by-restart');

    // The user's side, with no token: every orchestrator agent was stopped by the restart too.
    const restarted = await client.call('orchestrator.restart', { sessionId: worker.sessionId });

    const { zoneId, position, worktree, branch } = worker;
    expect(restarted).toMatchObject({ endedAt: null, zoneId, position, worktree, branch });
    const sessionStart = await recorder.waitFor(
      (e: DaemonEvent): e is HookEvent => e.type === 'hook' && e.sessionId === worker.sessionId && e.event === 'SessionStart',
    );
    expect(sessionStart.payload).toMatchObject({ source: 'resume', session_id: worker.sessionId });
    const [line] = await client.call('orchestrator.activity', {});
    expect(line).toMatchObject({ orchestratorName: 'you', action: 'restart', outcome: 'done', targetId: worker.sessionId });
  }, 30_000);

  it('never forces: while the shell its pane dropped into runs something, the restart is refused and the shell runs on', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const { agent: worker } = await agentSide(setup, setup.zone.id);
    const shell = (await end(setup, worker.sessionId)).shellSessionId!;
    await setup.client.call('session.attach', { sessionId: shell });
    // A subshell: it is in the foreground before it says so. Typed, the word is split, so only its output matches.
    await setup.client.call('session.write', { sessionId: shell, data: '(echo bu""sy; sleep 30)\r' });
    await setup.recorder.waitForText(shell, 'busy');

    // Even asked to: the method takes no force.
    await expect(connection.call('orchestrator.restart', { token, sessionId: worker.sessionId, force: true } as never)).rejects.toMatchObject({
      code: AGENT_ERROR.shellBusy,
    });

    expect((await setup.client.call('session.list')).map((session) => session.id)).toContain(shell);
    expect((await setup.client.call('agent.list')).find((each) => each.sessionId === worker.sessionId)!.endedAt).not.toBeNull();
    const [line] = await setup.client.call('orchestrator.activity', { orchestratorId: me.sessionId });
    expect(line).toMatchObject({ action: 'restart', outcome: 'refused' });
  }, 30_000);

  it('refuses an agent outside its scope, a running one and itself, and logs each refusal', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const elsewhere = await userAgent(setup.client, setup.other.id, 'elsewhere');
    const running = await userAgent(setup.client, setup.zone.id, 'running');
    await setup.client.call('agent.stop', { sessionId: elsewhere.sessionId });

    await expect(connection.call('orchestrator.restart', { token, sessionId: elsewhere.sessionId })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    await expect(connection.call('orchestrator.restart', { token, sessionId: running.sessionId })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining('still running'),
    });
    await expect(connection.call('orchestrator.restart', { token, sessionId: me.sessionId })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });

    expect((await setup.client.call('agent.list')).find((each) => each.sessionId === elsewhere.sessionId)!.endedAt).not.toBeNull();
    const log = await setup.client.call('orchestrator.activity', { orchestratorId: me.sessionId });
    expect(log.map(({ action, outcome, targetName }) => `${action} ${outcome} ${targetName}`)).toEqual([
      `restart refused ${me.name}`,
      'restart refused running',
      'restart refused elsewhere',
    ]);
  });
});

describe('edges an orchestrator makes', () => {
  it('joins agents in its scope, or itself, marked as made by it and logged; the user can delete one like any other', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const impl = await userAgent(setup.client, setup.zone.id, 'impl');
    const review = await userAgent(setup.client, setup.zone.id, 'review');

    const edge = await connection.call('orchestrator.addEdge', { token, from: impl.sessionId, to: review.sessionId, payload: 'handover' });
    expect(edge).toMatchObject({ from: impl.sessionId, to: review.sessionId, payload: 'handover', path: 'handover.md', trigger: 'auto', madeBy: me.sessionId });
    const back = await connection.call('orchestrator.addEdge', { token, from: review.sessionId, to: me.sessionId, trigger: 'manual' });
    expect(back.madeBy).toBe(me.sessionId);

    const log = await setup.client.call('orchestrator.activity', { orchestratorId: me.sessionId });
    expect(log.map(({ action, outcome, targetName }) => `${action} ${outcome} ${targetName}`)).toEqual([
      `add-edge done ${me.name}`,
      'add-edge done review',
    ]);
    expect(log[1]!.detail).toBe(`from impl, carrying handover (edge ${edge.id})`);

    await setup.client.call('flowEdge.delete', { id: edge.id });
    expect((await setup.client.call('flowEdge.list')).map(({ id }) => id)).toEqual([back.id]);
  });

  it('refuses an end outside its scope, or into an orchestrator with a wider scope, and logs it', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const mine = await userAgent(setup.client, setup.zone.id, 'mine');
    const elsewhere = await userAgent(setup.client, setup.other.id, 'elsewhere');
    const wide = await agentSide(setup, setup.zone.id, 'board');
    const peer = await agentSide(setup, setup.zone.id, 'zone');

    for (const [from, to] of [
      [mine.sessionId, elsewhere.sessionId],
      [elsewhere.sessionId, mine.sessionId],
      [mine.sessionId, wide.agent.sessionId],
    ] as const) {
      await expect(connection.call('orchestrator.addEdge', { token, from, to })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    }
    // Out of a wider one is fine: an edge out of it carries what it hands off, and steers no one.
    await connection.call('orchestrator.addEdge', { token, from: wide.agent.sessionId, to: mine.sessionId });
    // Into a peer of the same scope is fine.
    await connection.call('orchestrator.addEdge', { token, from: mine.sessionId, to: peer.agent.sessionId });
    // A whole-board orchestrator may wire into any.
    await wide.connection.call('orchestrator.addEdge', { token: wide.token, from: elsewhere.sessionId, to: me.sessionId });

    const log = await setup.client.call('orchestrator.activity', { orchestratorId: me.sessionId });
    expect(log.map(({ outcome }) => outcome)).toEqual(['done', 'done', 'refused', 'refused', 'refused']);
  });

  it('never approves a gate or script it puts on an edge, nor sends, drops or changes an edge', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const impl = await userAgent(setup.client, setup.zone.id, 'impl');
    const review = await userAgent(setup.client, setup.zone.id, 'review');

    const edge = await connection.call('orchestrator.addEdge', {
      token,
      from: impl.sessionId,
      to: review.sessionId,
      conditions: [{ kind: 'script', command: 'true' }],
      approvals: { true: 'forged' },
      paused: true,
    } as never);
    expect(edge.paused).toBe(false);
    expect(await setup.client.call('flowEdge.commands', { id: edge.id })).toEqual([expect.objectContaining({ command: 'true', approval: 'unapproved' })]);

    const [plan] = await setup.client.call('flowEdge.commands', { id: edge.id });
    for (const call of [
      connection.call('flowEdge.approve', { id: edge.id, command: 'true', fingerprint: plan!.fingerprint }),
      connection.call('flowEdge.update', { id: edge.id, conditions: [] }),
      connection.call('flowEdge.send', { id: edge.id }),
      connection.call('flowEdge.drop', { id: edge.id }),
      connection.call('flowEdge.delete', { id: edge.id }),
      connection.call('flowEdge.create', { from: impl.sessionId, to: review.sessionId }),
      connection.call('flowEdge.lastPayload', { id: edge.id }),
    ]) {
      await expect(call).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
    }
  });

  it('joins an edge into an agent that has ended, and starts it again along it, as the user\'s edges do', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const worker = await connection.call('orchestrator.spawn', { token, name: 'worker' });
    await setup.client.call('agent.stop', { sessionId: worker.sessionId });
    await untilAgent(setup.recorder, worker.sessionId, (seen) => seen.endedAt !== null);

    const edge = await connection.call('orchestrator.addEdge', { token, from: me.sessionId, to: worker.sessionId });
    expect(await connection.call('board.handoff', { token, message: 'Start again' })).toEqual([
      { edgeId: edge.id, to: worker.sessionId, outcome: 'delivered', name: 'message', reason: null },
    ]);
    await untilAgent(setup.recorder, worker.sessionId, (seen) => seen.endedAt === null);
  });

  it('removes only an edge its crew made: itself, or an agent it started, or theirs', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'board');
    const impl = await userAgent(setup.client, setup.zone.id, 'impl');
    const review = await userAgent(setup.client, setup.zone.id, 'review');
    const users = await setup.client.call('flowEdge.create', { from: impl.sessionId, to: review.sessionId });
    const other = await agentSide(setup, setup.zone.id, 'board');
    const others = await other.connection.call('orchestrator.addEdge', { token: other.token, from: review.sessionId, to: impl.sessionId, trigger: 'manual' });

    for (const id of [users.id, others.id]) {
      await expect(connection.call('orchestrator.removeEdge', { token, id })).rejects.toMatchObject({
        code: BOARD_ERROR.outOfScope,
        message: expect.stringMatching(/only edges its crew made/),
      });
    }
    expect(await setup.client.call('flowEdge.list')).toHaveLength(2);

    await setup.client.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: true });
    const child = await connection.call('orchestrator.spawn', { token, name: 'child', prompt: 'Print your board identity' });
    const childSide = await agentSideOf(setup, child.sessionId);
    const childs = await childSide.connection.call('orchestrator.addEdge', { token: childSide.token, from: child.sessionId, to: impl.sessionId, trigger: 'manual' });
    expect(childs.madeBy).toBe(child.sessionId);
    await expect(connection.call('orchestrator.removeEdge', { token, id: childs.id })).resolves.toBeNull();

    // The user's side removes any, as the user does in the app.
    const tile = await setup.client.call('shell.create', { zoneId: setup.zone.id });
    const shell = await shellSide(setup, paneIds(tile.layout)[0]!);
    for (const id of [users.id, others.id]) await shell.connection.call('orchestrator.removeEdge', { token: shell.token, id });
    expect(await setup.client.call('flowEdge.list')).toEqual([]);
  });

  it('is refused an agent that may not orchestrate', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
    const impl = await userAgent(setup.client, setup.zone.id, 'impl');
    const review = await userAgent(setup.client, setup.zone.id, 'review');
    await expect(connection.call('orchestrator.addEdge', { token, from: impl.sessionId, to: review.sessionId })).rejects.toMatchObject({
      code: BOARD_ERROR.notAllowed,
    });
    expect(await setup.client.call('flowEdge.list')).toEqual([]);
  });
});

describe('a reviewer an orchestrator starts', () => {
  it('works on a detached checkout of its implementer’s branch, `new` says so, and a follow-up can be based on it', async () => {
    const setup = await orchestrateDaemon();
    const { token } = await agentSide(setup, setup.zone.id, 'zone');
    const implementer = await userAgent(setup.client, setup.zone.id, 'impl');
    const tip = git(implementer.worktree, 'rev-parse', 'HEAD').slice(0, 7);
    const session = await openBoardSession({ [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: token });
    try {
      const started = await newAgent(session, { prompt: 'Review it', name: 'review', role: 'reviewer', base: 'agent:impl' });

      expect(started.text).toContain(`\n  detached at ${tip} of ${implementer.branch} in `);
      expect(started.json).toMatchObject({ role: 'reviewer', reviews: { branch: implementer.branch } });

      // A follow-up based on that reviewer reviews the same branch.
      const followUp = await newAgent(session, { prompt: 'Check the fixes', name: 'recheck', role: 'follow-up-reviewer', base: 'agent:review' });
      expect(followUp.json).toMatchObject({ role: 'follow-up-reviewer', reviews: { branch: implementer.branch } });
    } finally {
      session.close();
    }
  });
});

describe('an agent an orchestrator starts with or without its role’s template', () => {
  /** The first message the agent got, as its harness's UserPromptSubmit hook reported it. */
  const firstMessage = async (setup: Setup, sessionId: string) =>
    String(
      (
        await setup.recorder.waitFor(
          (e: DaemonEvent): e is HookEvent => e.type === 'hook' && e.sessionId === sessionId && e.event === 'UserPromptSubmit',
        )
      ).payload.prompt,
    );

  it('begins with the template and says which one; --no-template sends the prompt alone', async () => {
    const setup = await orchestrateDaemon();
    await setup.client.call('zone.setRoleTemplate', { id: setup.zone.id, role: 'implementer', body: 'Template for {{branch}}.' });
    const { token } = await agentSide(setup, setup.zone.id, 'zone');
    const session = await openBoardSession({ [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: token });
    try {
      const templated = await newAgent(session, { prompt: 'Do it', name: 'templated', role: 'implementer' });
      expect(templated.text).toContain("Its first message begins with the zone's saved implementer template");
      expect(templated.json).toMatchObject({ template: "the zone's saved implementer template" });
      const idOf = async (name: string) => (await setup.client.call('agent.list')).find((each) => each.name === name)!.sessionId;
      expect(await firstMessage(setup, await idOf('templated'))).toMatch(/^Template for \S+\.\n\nDo it$/);

      const bare = await newAgent(session, { prompt: 'Only this', name: 'bare', role: 'implementer', noTemplate: true });
      expect(bare.text).toContain('No role template: its first message is your prompt alone.');
      expect(bare.json).toMatchObject({ template: null });
      expect(await firstMessage(setup, await idOf('bare'))).toBe('Only this');

      const none = await newAgent(session, { prompt: 'No role', name: 'plain' });
      expect(none.text).not.toContain('template');
      expect(none.json).toMatchObject({ template: null });
    } finally {
      session.close();
    }
  });

  it('is `template: false` of new_agent over the tools, which names the template it applied', async () => {
    const setup = await orchestrateDaemon();
    await setup.client.call('zone.setRoleTemplate', { id: setup.zone.id, role: 'implementer', body: 'Template.' });
    const lead = await agentSide(setup, setup.zone.id, 'zone');
    const mcp = mcpAs(setup, lead.token);

    const templated = await mcp.callTool('new_agent', { prompt: 'Do it', name: 'templated', role: 'implementer' });
    expect(templated).toMatchObject({ isError: false, text: expect.stringContaining("begins with the zone's saved implementer template") });
    const bare = await mcp.callTool('new_agent', { prompt: 'Only this', name: 'bare', role: 'implementer', template: false });
    expect(bare).toMatchObject({ isError: false, text: expect.stringContaining('No role template') });
    const agent = (await setup.client.call('agent.list')).find((each) => each.name === 'bare')!;
    expect(await firstMessage(setup, agent.sessionId)).toBe('Only this');
  });
});

describe('an agent an orchestrator starts in a named role', () => {
  it('carries the name, which `new`, `tree` and its own `whoami` show', async () => {
    const setup = await orchestrateDaemon();
    const { token } = await agentSide(setup, setup.zone.id, 'zone');
    const session = await openBoardSession({ [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: token });
    try {
      const started = await newAgent(session, { prompt: 'Print your board identity', name: 'mocks', role: 'designer' });

      expect(started.text).toMatch(/^Started agent:\S+ {2}mocks {2}\[\S+\] {2}\(designer\)/);
      expect(started.json).toMatchObject({ role: 'custom', roleName: 'designer' });
      const refs = new BoardRefs(await readBoard(setup.client));
      expect(treeView(refs, null).text).toMatch(/mocks {2}\[\S+\] {2}\(designer\)/);

      const designer = refs.board.agents.find((agent) => agent.name === 'mocks')!;
      const side = await agentSideOf(setup, designer.sessionId);
      const caller = await side.connection.call('board.identify', { token: side.token });
      const whoami = identifyView(refs, caller, setup.daemon.socketPath);
      expect(whoami.text).toContain('\nrole     designer\n');
      expect(whoami.json).toMatchObject({ you: { role: 'designer' } });
    } finally {
      session.close();
    }
  });

  it('shows an unnamed custom role as custom', async () => {
    const setup = await orchestrateDaemon();
    const { token } = await agentSide(setup, setup.zone.id, 'zone');
    const session = await openBoardSession({ [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: token });
    try {
      const started = await newAgent(session, { prompt: 'Go', name: 'odd job', role: 'custom' });

      expect(started.text).toMatch(/odd job {2}\[\S+\] {2}\(custom\)/);
      expect(started.json).toMatchObject({ role: 'custom', roleName: null });
    } finally {
      session.close();
    }
  });
});
