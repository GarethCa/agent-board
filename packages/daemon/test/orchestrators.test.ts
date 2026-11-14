import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fakeHarnessEnv, McpClient } from '@agent-board/fake-harness';
import { BOARD_MCP_INSTRUCTIONS, ORCHESTRATOR_INSTRUCTIONS } from '../src/board-mcp.ts';
import { AGENT_ERROR, BOARD_ERROR, MAX_ROLE_NAME_LENGTH, RPC_ERROR, SETTLED_STATES, type Agent, type OrchestratorSpawnParams, type AgentUpdatedEvent, type DaemonEvent, type HookEvent, type OrchestratorActivityEvent } from '../src/protocol.ts';
import type { DaemonClient } from '../src/client.ts';
import type { Clock } from '../src/clock.ts';
import { CHARACTER_EXPIRY_MS } from '../src/character.ts';
import { QUIET_TURN_MS, readTranscriptTail, turnEndedInTranscript } from '../src/quiet-turns.ts';
import { createFakeClock } from './fake-clock.ts';
import { BOARD_SOCKET_ENV, BOARD_TOKEN_ENV } from '../src/board-env.ts';
import { reviewedAgent } from '../src/orchestrators.ts';
import { isLead } from '../src/work-units.ts';
import { BoardRefs, identifyView, newAgent, openBoardSession, readBoard, treeView } from '../src/board-ops.ts';
import { runBoardCommand } from '../src/board-cli.ts';
import { paneIds } from '../src/pane-layout.ts';
import { refOf } from '../src/crew-flags.ts';
import { markSender } from '../src/sender-marker.ts';
import { connectTestClient, git, recordEvents, sendLogLines, startTestDaemon, TEST_CLI_LAUNCHER, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

/** A daemon whose agents play the fake harnesses' `orchestrate` scenario, with two zones of one repo and one of another. */
async function orchestrateDaemon(
  options: Parameters<typeof startOrchestrateDaemon>[0] = {},
) {
  const daemon = await startOrchestrateDaemon(options);
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const repo = tempRepo();
  const zone = await client.call('zone.add', { path: repo, x: 0, y: 0, name: 'web' });
  const sameRepo = await client.call('zone.addUnbound', { name: 'more web', x: 2000, y: 0 });
  await client.call('zone.setDefaultRepo', { id: sameRepo.id, path: repo });
  const other = await client.call('zone.add', { path: tempRepo('other'), x: 4000, y: 0, name: 'other' });
  return { daemon, client, recorder, zone, sameRepo, other };
}

type Setup = Awaited<ReturnType<typeof orchestrateDaemon>>;

/**
 * A daemon whose agents play the `orchestrate` scenario, in `dataDir` and with the fakes' `home` (fresh by default);
 * with `repeat`, each later message too, and with `fakes`, what else its fakes do.
 */
function startOrchestrateDaemon({
  dataDir,
  home = tempDataDir(),
  log,
  replyWindowMs,
  repeat,
  clock,
  fakes,
}: {
  dataDir?: string;
  home?: string;
  log?: (message: string) => void;
  replyWindowMs?: number;
  repeat?: boolean;
  clock?: Clock;
  fakes?: Partial<Parameters<typeof fakeHarnessEnv>[0]>;
}) {
  return startTestDaemon({
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(clock === undefined ? {} : { clock }),
    ...(log === undefined ? {} : { log }),
    ...(replyWindowMs === undefined ? {} : { replyWindowMs }),
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home, idleNotifyMs: 200, ...(repeat === undefined ? {} : { repeat }), ...fakes }),
  });
}

/** Waits for an update in which the agent matches `match`. */
async function untilAgent(recorder: Setup['recorder'], sessionId: string, match: (agent: Agent) => boolean): Promise<Agent> {
  const event = await recorder.waitFor(
    (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent),
  );
  return event.agent;
}

/** `text` as a regular expression matching it literally. */
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `text` as an agent sent it by `send`: headed with its sender mark. */
const sentBy = (from: Pick<Agent, 'sessionId' | 'name'>, text: string) => markSender('send', from.name, refOf(from), text);

/**
 * Starts an agent in `zoneId` that prints its board token and sits at its prompt, and connects as it: the board token
 * presented, as the CLI and MCP do.
 */
async function agentSide(setup: Setup, zoneId: string) {
  const agent = await setup.client.call('agent.spawn', { zoneId, prompt: 'Print your board identity', ...SIZE });
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

/** An agent's side of the board: its token, and a connection that presented it. */
type Side = { token: string; connection: DaemonClient };

/**
 * Starts an agent as another agent does (`orchestrator.spawn`), so any agent may act on it, as on none the user
 * started by hand. `by` starts it; else a new agent the user starts in its zone.
 */
async function crewAgent(setup: Setup, params: OrchestratorSpawnParams = {}, by?: Side) {
  const starter = by ?? (await agentSide(setup, params.zoneId ?? setup.zone.id));
  return starter.connection.call('orchestrator.spawn', { token: starter.token, ...params });
}

/** `crewAgent` printing its board identity in `zoneId`, connected as it (`agentSideOf`). */
async function crewSide(setup: Setup, zoneId: string, options: { name?: string; by?: Side } = {}) {
  const agent = await crewAgent(setup, { zoneId, prompt: 'Print your board identity', ...(options.name === undefined ? {} : { name: options.name }) }, options.by);
  return { agent, ...(await agentSideOf(setup, agent.sessionId)) };
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

describe('every agent orchestrating', () => {
  it('lets every live agent act on the board, with no role, in any zone or none: there is no switch to turn on', async () => {
    const setup = await orchestrateDaemon();
    const { agent, token, connection } = await agentSide(setup, setup.other.id);
    expect(agent.role).toBeNull();
    expect(await connection.call('board.identify', { token })).toMatchObject({ side: 'agent', orchestrates: true });
    // Loose on the board, it still starts, moves, messages and closes an agent another agent started.
    await setup.client.call('agent.move', { sessionId: agent.sessionId, zoneId: null, x: 9000, y: 0 });
    const worker = await connection.call('orchestrator.spawn', { token, zoneId: setup.zone.id, name: 'worker', prompt: 'Print your board identity' });
    expect(worker.spawnedBy).toBe(agent.sessionId);
    const lead = await agentSide(setup, setup.zone.id);
    const theirs = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'theirs', prompt: 'Print your board identity' });
    await expect(connection.call('orchestrator.wait', { token, sessionIds: [theirs.sessionId], timeoutMs: 10_000 })).resolves.toMatchObject({ timedOut: false });
    await expect(connection.call('orchestrator.move', { token, target: { kind: 'agent', id: theirs.sessionId }, zoneId: setup.other.id })).resolves.toBeDefined();
    await expect(connection.call('orchestrator.send', { token, sessionId: theirs.sessionId, text: 'One more thing' })).resolves.toMatchObject({ delivery: 'started' });
    await connection.call('orchestrator.close', { token, sessionId: theirs.sessionId });
    await untilAgent(setup.recorder, theirs.sessionId, (seen) => seen.endedAt !== null);
    // The switch the app once had is gone, and so is the method that set a scope.
    const call = setup.client.call.bind(setup.client) as (method: string, params: unknown) => Promise<unknown>;
    await expect(call('agent.setOrchestrate', { sessionId: agent.sessionId, scope: 'board' })).rejects.toMatchObject({
      code: RPC_ERROR.methodNotFound,
    });
  });

  it('keeps settings and permissions out of its reach', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
    const worker = await connection.call('orchestrator.spawn', { token, prompt: 'Write the handover', name: 'child' });
    const refused = [
      connection.call('agent.decidePermission', { sessionId: worker.sessionId, requestId: 'r1', behavior: 'allow' }),
      connection.call('session.write', { sessionId: worker.sessionId, data: 'y\r' }),
      connection.call('agent.answer', { sessionId: worker.sessionId, text: 'yes' }),
      connection.call('settings.set', { heldPayloads: 'path' }),
      connection.call('zone.configure', { id: setup.zone.id, boardMcp: false }),
      connection.call('agent.spawn', { zoneId: setup.zone.id, ...SIZE }),
    ];
    for (const call of refused) await expect(call).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
  });

  it('goes any depth: each agent an agent starts starts its own crew', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    // Six deep: the user's agent, and five below it, each started by the one above.
    let above = lead;
    const crew: Agent[] = [];
    for (const name of ['two', 'three', 'four', 'five', 'six']) {
      const next = await above.connection.call('orchestrator.spawn', { token: above.token, name, prompt: 'Print your board identity' });
      expect(next.spawnedBy).toBe(above.agent.sessionId);
      crew.push(next);
      above = { agent: next, ...(await agentSideOf(setup, next.sessionId)) };
    }
    expect(await above.connection.call('board.identify', { token: above.token })).toMatchObject({ orchestrates: true });

    // The deepest is still the lead's own crew: its status is the lead's to set.
    const deepest = crew.at(-1)!;
    await expect(
      lead.connection.call('orchestrator.setStatus', { token: lead.token, sessionId: deepest.sessionId, summary: 'six deep' }),
    ).resolves.toMatchObject({ status: expect.objectContaining({ summary: 'six deep' }) });
    // And the lead hears what happens to it.
    const since = (await lead.connection.call('orchestrator.wait', { token: lead.token, crew: true, since: 'now', timeoutMs: 1 })).cursor;
    await lead.connection.call('orchestrator.close', { token: lead.token, sessionId: deepest.sessionId });
    await expect(lead.connection.call('orchestrator.wait', { token: lead.token, crew: true, since, kinds: ['ended'], timeoutMs: 10_000 })).resolves.toMatchObject({
      timedOut: false,
      events: [expect.objectContaining({ sessionId: deepest.sessionId, kind: 'ended' })],
    });
  });
});

/** Connects as the shell session `pane`, with the board token it holds, as a CLI run in it by hand does. */
async function shellSide(setup: Setup, pane: string) {
  await setup.client.call('session.attach', { sessionId: pane });
  // A marker of its own, so an ended agent's pane, which still shows the agent printing its identity, never answers.
  // Its halves are quoted apart, so the joined form is only in the echo's output, never in the typed command.
  const marker = `shell-${randomUUID()}`;
  await setup.client.call('session.write', { sessionId: pane, data: `echo "${marker}""-id:$AGENT_BOARD_IDENTITY:${marker}""-end"\r` });
  await setup.recorder.waitForText(pane, `${marker}-end`);
  const token = new RegExp(`${marker}-id:(.*):${marker}-end`).exec(setup.recorder.screenText(pane))![1]!;
  return { token, connection: await connectTestClient(setup.daemon) };
}

describe('a user-side caller: a shell, or the user with no token', () => {
  it("acts for the user from an ended agent's shell, logged as that shell; its agents are the user's", async () => {
    const setup = await orchestrateDaemon();
    const { agent } = await agentSide(setup, setup.zone.id);
    const target = await agentSide(setup, setup.other.id);
    await setup.client.call('agent.stop', { sessionId: agent.sessionId });
    const ended = await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.shellSessionId !== null);
    const { token, connection } = await shellSide(setup, ended.shellSessionId!);

    expect(await connection.call('board.identify', { token })).toMatchObject({ tileId: agent.sessionId, side: 'user' });
    // It removes an agent the user started, as the user does in the app.
    const users = await userAgent(setup.client, setup.zone.id, 'users');
    await expect(connection.call('orchestrator.close', { token, sessionId: users.sessionId, remove: true })).resolves.toBeNull();
    // Anywhere on the board, the user's own agents included.
    const started = await connection.call('orchestrator.spawn', { token, zoneId: setup.other.id, name: 'by-hand' });
    expect(started.spawnedBy).toBeNull();
    await expect(connection.call('orchestrator.send', { token, sessionId: target.agent.sessionId, text: 'Carry on' })).resolves.toBeDefined();
    const [line] = await setup.client.call('orchestrator.activity', { limit: 1 });
    expect(line).toMatchObject({ orchestratorId: agent.sessionId, orchestratorName: `${agent.name}'s shell`, action: 'send', outcome: 'done' });
  });

  it("acts for the user from a shell tile and an agent's tab, but never changes a setting", async () => {
    const setup = await orchestrateDaemon();
    const { agent } = await agentSide(setup, setup.zone.id);
    const tile = await setup.client.call('shell.create', { zoneId: setup.zone.id });
    const tab = await setup.client.call('shell.createTab', { owner: { kind: 'agent', id: agent.sessionId } });
    for (const pane of [tile.layout, tab.layout].map((layout) => paneIds(layout)[0]!)) {
      const { token, connection } = await shellSide(setup, pane);
      expect(await connection.call('board.identify', { token })).toMatchObject({ side: 'user' });
      await expect(connection.call('orchestrator.send', { token, sessionId: agent.sessionId, text: 'Carry on' })).resolves.toBeDefined();
      await connection.call('orchestrator.wait', { token, sessionIds: [agent.sessionId] });
      // Its zone's settings and permissions stay the user's own in the app (G8, G22).
      const refused = [
        connection.call('zone.configure', { id: setup.zone.id, gateCommand: 'true' }),
        connection.call('session.write', { sessionId: agent.sessionId, data: 'y\r' }),
        connection.call('agent.answer', { sessionId: agent.sessionId, text: 'yes' }),
        connection.call('agent.decidePermission', { sessionId: agent.sessionId, requestId: 'r', behavior: 'allow' } as never),
      ];
      for (const call of refused) await expect(call).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
    }
  });

  it("keeps an ended agent's own connection the agent's: never the user's side, and orchestrating no more, its token held by no live session", async () => {
    const setup = await orchestrateDaemon();
    const { agent, connection, token } = await agentSide(setup, setup.zone.id);
    await setup.client.call('agent.stop', { sessionId: agent.sessionId });
    await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.endedAt !== null);
    await expect(connection.call('orchestrator.spawn', { zoneId: setup.zone.id } as never)).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
    await expect(connection.call('orchestrator.spawn', { token, zoneId: setup.zone.id })).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
    await expect(connection.call('board.identify', { token })).rejects.toMatchObject({ code: BOARD_ERROR.unknownToken });
  });

  it("keeps an agent's own token off a zone's settings (G11)", async () => {
    const setup = await orchestrateDaemon();
    const { connection } = await agentSide(setup, setup.zone.id);
    await expect(connection.call('zone.configure', { id: setup.zone.id, gateCommand: 'true' })).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
  });

  it('acts for the user with no token, logged as the user', async () => {
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
    const { agent } = await agentSide(setup, setup.zone.id);
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

describe('whom an agent acts on', () => {
  it('any agent an agent started, in any zone and repo, its own moved anywhere; never itself, nor one the user started by hand, and logs each refusal', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id);
    const neighbour = await userAgent(setup.client, setup.zone.id, 'neighbour');
    const elsewhere = await userAgent(setup.client, setup.other.id, 'elsewhere');

    const child = await connection.call('orchestrator.spawn', { token, name: 'child' });
    expect(child.zoneId).toBe(setup.zone.id);
    // A zone is only a group: where a tile sits is no permission.
    expect((await connection.call('orchestrator.spawn', { token, zoneId: setup.other.id })).zoneId).toBe(setup.other.id);
    expect((await connection.call('orchestrator.spawn', { token, zoneId: setup.sameRepo.id })).zoneId).toBe(setup.sameRepo.id);

    // Its own, even once the user moves it out of the zone.
    await setup.client.call('agent.move', { sessionId: child.sessionId, zoneId: setup.other.id, x: 0, y: 0 });
    await expect(connection.call('orchestrator.read', { token, sessionId: child.sessionId, path: 'apps/web/index.ts' })).resolves.toMatchObject({
      path: 'apps/web/index.ts',
    });
    // The user's own, in its zone or another, never.
    for (const users of [neighbour, elsewhere]) {
      await expect(connection.call('orchestrator.read', { token, sessionId: users.sessionId, path: 'apps/web/index.ts' })).rejects.toMatchObject({
        code: BOARD_ERROR.outOfScope,
        message: `${users.name} is one the user started by hand: agents never act on the user's own agents`,
      });
    }
    // Never itself.
    await expect(connection.call('orchestrator.interrupt', { token, sessionId: me.sessionId })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    // Nor continues one of the user's on credits, and the user sees it tried.
    await expect(connection.call('orchestrator.continueOnCredits', { token, sessionId: elsewhere.sessionId })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    const [line] = await setup.client.call('orchestrator.activity', { limit: 1 });
    expect(line).toMatchObject({ orchestratorId: me.sessionId, action: 'continue', outcome: 'refused', targetName: 'elsewhere' });
    // No refusal speaks of a scope, a rank or a switch.
    for (const each of await setup.client.call('orchestrator.activity', { limit: 50 })) {
      expect(each.reason ?? '').not.toMatch(/scope|rank|orchestrat/i);
    }
  });

  it('starts an agent in any zone with any repo, and reaches it there as its own', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
    const loose = tempRepo('loose');
    const group = await setup.client.call('zone.addUnbound', { name: 'scratch', x: 6000, y: 0 });

    // Another repo's zone, with this zone's repo; this zone with a repo no zone is bound to; a group with no repo of its own.
    const across = await connection.call('orchestrator.spawn', { token, zoneId: setup.other.id, repo: setup.zone.repoRoot!, name: 'across' });
    const unbound = await connection.call('orchestrator.spawn', { token, repo: loose, name: 'unbound' });
    const grouped = await connection.call('orchestrator.spawn', { token, zoneId: group.id, repo: setup.other.repoRoot!, name: 'grouped' });

    expect(across).toMatchObject({ zoneId: setup.other.id, repoRoot: setup.zone.repoRoot, ownsWorktree: true });
    expect(unbound).toMatchObject({ zoneId: setup.zone.id, repoRoot: loose, ownsWorktree: true });
    expect(grouped).toMatchObject({ zoneId: group.id, repoRoot: setup.other.repoRoot, ownsWorktree: true });
    // Out of its zone, each is still its own to steer.
    for (const agent of [across, unbound, grouped]) {
      await expect(connection.call('orchestrator.read', { token, sessionId: agent.sessionId, path: 'apps/web/index.ts' })).resolves.toBeDefined();
    }
  });

  it('watches, reads, messages and closes the crew of another agent in another zone, but asks before removing it', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
    // Another agent, in a zone of another repo, and the agents it starts there.
    const lead = await agentSide(setup, setup.other.id);
    const far = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'far', prompt: 'Print your board identity' });
    const kept = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'kept', prompt: 'Print your board identity' });
    const stranger = await userAgent(setup.client, setup.other.id, 'stranger');

    await expect(connection.call('orchestrator.wait', { token, sessionIds: [far.sessionId, kept.sessionId], timeoutMs: 10_000 })).resolves.toMatchObject({
      timedOut: false,
    });
    await expect(connection.call('orchestrator.read', { token, sessionId: far.sessionId })).resolves.toMatchObject({ path: null });
    await expect(connection.call('orchestrator.send', { token, sessionId: far.sessionId, text: 'One more thing' })).resolves.toMatchObject({ delivery: 'started' });
    await connection.call('orchestrator.close', { token, sessionId: far.sessionId });
    await untilAgent(setup.recorder, far.sessionId, (seen) => seen.endedAt !== null);
    // Removing it is still the user's to allow.
    await expect(connection.call('orchestrator.close', { token, sessionId: far.sessionId, remove: true })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/only an agent you started.*--remove --ask/),
    });

    // One the user started stays out of reach: the stranger, and the lead itself.
    for (const refused of [
      connection.call('orchestrator.read', { token, sessionId: stranger.sessionId, path: 'apps/web/index.ts' }),
      connection.call('orchestrator.send', { token, sessionId: stranger.sessionId, text: 'Hello' }),
      connection.call('orchestrator.wait', { token, sessionIds: [stranger.sessionId], timeoutMs: 1 }),
      connection.call('orchestrator.close', { token, sessionId: stranger.sessionId }),
      connection.call('orchestrator.read', { token, sessionId: lead.agent.sessionId }),
    ]) {
      await expect(refused).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope, message: expect.stringMatching(/started by hand/) });
    }

    // Its starter removed, the crew it left is still an agent's, not the user's: in reach.
    await setup.client.call('agent.delete', { sessionId: lead.agent.sessionId, force: true });
    expect((await setup.client.call('agent.list')).find((each) => each.sessionId === kept.sessionId)).toMatchObject({ spawnedBy: null });
    await expect(connection.call('orchestrator.read', { token, sessionId: kept.sessionId })).resolves.toMatchObject({ path: null });
  });

  it('steers another agent’s crew, which may no more act on the user’s agents than it may', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
    const lead = await agentSide(setup, setup.other.id);
    const deputy = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'deputy', prompt: 'Print your board identity' });
    const users = await userAgent(setup.client, setup.other.id, 'users-own');

    await expect(connection.call('orchestrator.close', { token, sessionId: users.sessionId })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    const side = await agentSideOf(setup, deputy.sessionId);
    // A send to an agent mid-turn is queued, so wait for the deputy's first turn to end: printing its identity comes before that.
    await expect(connection.call('orchestrator.wait', { token, sessionIds: [deputy.sessionId], timeoutMs: 10_000 })).resolves.toMatchObject({ timedOut: false });
    await expect(connection.call('orchestrator.send', { token, sessionId: deputy.sessionId, text: 'Close users-own' })).resolves.toMatchObject({ delivery: 'started' });
    await expect(side.connection.call('orchestrator.close', { token: side.token, sessionId: users.sessionId })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/started by hand/),
    });
  });
});

describe('what an orchestrator may send', () => {
  it('refuses a prompt or message that would run a harness command, and allows a plugin command', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
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
    const { token, connection } = await agentSide(setup, setup.zone.id);
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
    const { token, connection } = await agentSide(setup, setup.zone.id);
    for (const prompt of HIDDEN) {
      await expect(connection.call('orchestrator.spawn', { token, prompt }), JSON.stringify(prompt)).rejects.toMatchObject({
        code: RPC_ERROR.invalidParams,
        message: expect.stringMatching(/control or format character/),
      });
    }
  });

  it('refuses a control or format character anywhere in a message, and types nothing', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
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
    const { token, connection } = await agentSide(setup, setup.zone.id);
    const worker = await connection.call('orchestrator.spawn', { token, name: 'md', prompt: '# Task\n\n- one\n\t- two: `/not a command`' });
    expect(worker.description).toBe('# Task\n\n- one\n\t- two: `/not a command`');
  });
});

describe('the orchestrator loop', () => {
  it('starts a worker, waits for it, reads its handover, sends a follow-up and waits for that turn, not the idle before it', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id);
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
    expect((await connection.call('orchestrator.read', { token, sessionId: worker.sessionId })).text).toBe(`Done: ${sentBy(me, 'Also add a test')}.`);
    // Its chat shows the message as from its orchestrator, not the user.
    const prompts = (await setup.client.call('agent.transcript', { sessionId: worker.sessionId })).entries.filter((entry) => entry.kind === 'user');
    expect(prompts.at(-1)).toMatchObject({ text: 'Also add a test', from: { ref: refOf(me), name: me.name, kind: 'send' } });
    expect(prompts[0]).not.toHaveProperty('from');

    const closed = await connection.call('orchestrator.close', { token, sessionId: worker.sessionId });
    expect(closed).toMatchObject({ state: 'done' });
  });

  it('times out a wait, saying where each agent got to', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
    const worker = await connection.call('orchestrator.spawn', { token, name: 'worker' });
    await connection.call('orchestrator.close', { token, sessionId: worker.sessionId });
    const result = await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId], states: ['running'], timeoutMs: 50 });
    expect(result).toMatchObject({ timedOut: true, agents: [{ sessionId: worker.sessionId, state: 'done' }] });
  });

  it('says over the wait tool whether it timed out, as a field and in its text', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const worker = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'worker' });
    await lead.connection.call('orchestrator.close', { token: lead.token, sessionId: worker.sessionId });
    const mcp = mcpAs(setup, lead.token);

    expect(await mcp.callTool('wait', { agents: ['worker'], until: ['running'], timeout_seconds: 0 })).toMatchObject({
      isError: false,
      text: expect.stringContaining('Timed out'),
      structured: { timedOut: true },
    });
    expect(await mcp.callTool('wait', { agents: ['worker'], timeout_seconds: 5 })).toMatchObject({ structured: { timedOut: false } });
    expect(await mcp.callTool('wait', { agents: ['worker'], since: 'now', timeout_seconds: 0 })).toMatchObject({ structured: { timedOut: true } });
  });

  it('reads only files inside the worktree', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
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
    const { token, connection } = await agentSide(setup, setup.zone.id);
    // Another agent's, which it may steer but not remove, and the user's own, which it may not touch.
    const neighbour = await crewAgent(setup, { zoneId: setup.zone.id, name: 'neighbour' });
    await expect(connection.call('orchestrator.close', { token, sessionId: neighbour.sessionId, remove: true })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/only an agent you started/),
    });
    const mine = await userAgent(setup.client, setup.zone.id, 'mine');
    await expect(connection.call('orchestrator.close', { token, sessionId: mine.sessionId, remove: true })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/started by hand/),
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
    const { token, connection } = await agentSide(setup, setup.zone.id);
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
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id);
    const child = await connection.call('orchestrator.spawn', { token, name: 'child' });
    await setup.client.call('agent.delete', { sessionId: me.sessionId, force: true });
    expect((await setup.client.call('agent.list')).find((agent) => agent.sessionId === child.sessionId)!.spawnedBy).toBeNull();
  });
});

describe('steering a turn', () => {
  it('interrupts a turn, and then sends', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id);
    const worker = await connection.call('orchestrator.spawn', { token, name: 'slow', prompt: 'Work slowly' });
    await untilAgent(setup.recorder, worker.sessionId, (seen) => seen.state === 'running');

    expect(await connection.call('orchestrator.interrupt', { token, sessionId: worker.sessionId })).toMatchObject({ state: 'idle' });
    await connection.call('orchestrator.send', { token, sessionId: worker.sessionId, text: 'Do it faster' });
    expect(await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId] })).toMatchObject({ timedOut: false });
    expect((await connection.call('orchestrator.read', { token, sessionId: worker.sessionId })).text).toBe(`Done: ${sentBy(me, 'Do it faster')}.`);
  });

  it('changes a crew agent’s reasoning effort between turns, and refuses one the user started by hand', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id);
    const worker = await connection.call('orchestrator.spawn', { token, name: 'slow', prompt: 'Work slowly' });
    await untilAgent(setup.recorder, worker.sessionId, (seen) => seen.state === 'running');

    // Mid-turn it waits for the turn to end, as the tile's menu does.
    const midTurn = await connection.call('orchestrator.setEffort', { token, sessionId: worker.sessionId, effort: 'low' });
    expect(midTurn).toMatchObject({ applies: 'after-turn', agent: { effort: 'low', effortPending: 'after-turn' } });
    await untilAgent(setup.recorder, worker.sessionId, (seen) => seen.state === 'idle' && seen.effortPending === null);
    const idle = await connection.call('orchestrator.setEffort', { token, sessionId: worker.sessionId, effort: 'max' });
    expect(idle).toMatchObject({ applies: 'now', agent: { effort: 'max' } });
    await expect(connection.call('orchestrator.setEffort', { token, sessionId: worker.sessionId, effort: 'extreme' as never })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });

    // Codex has no command for it: it takes the level when next started, and takes no max.
    const codex = await crewAgent(setup, { zoneId: setup.zone.id, harness: 'codex', name: 'codex' });
    await expect(connection.call('orchestrator.setEffort', { token, sessionId: codex.sessionId, effort: 'max' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
    expect(await connection.call('orchestrator.setEffort', { token, sessionId: codex.sessionId, effort: 'low' })).toMatchObject({
      applies: 'restart',
      agent: { effort: 'low', effortPending: 'restart' },
    });

    // Never itself, nor one the user started by hand, in any zone; the user sees it tried.
    await expect(connection.call('orchestrator.setEffort', { token, sessionId: me.sessionId, effort: 'low' })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    const elsewhere = await setup.client.call('agent.spawn', { zoneId: setup.other.id, name: 'elsewhere', ...SIZE });
    await expect(connection.call('orchestrator.setEffort', { token, sessionId: elsewhere.sessionId, effort: 'low' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    const [line] = await setup.client.call('orchestrator.activity', { limit: 1 });
    expect(line).toMatchObject({ action: 'effort', outcome: 'refused', targetName: 'elsewhere' });
  });

  it('gives a running agent a role, changes it and takes it away, without restarting it or sending it anything', async () => {
    const setup = await orchestrateDaemon();
    // One an agent started, so an agent may give it a role at the end.
    const worker = await crewAgent(setup, { zoneId: setup.zone.id, name: 'worker' });
    const screen = setup.recorder.screenText(worker.sessionId);

    expect(await setup.client.call('agent.setRole', { sessionId: worker.sessionId, role: 'Reviewer' })).toMatchObject({ role: 'reviewer', roleName: null });
    const named = await setup.client.call('agent.setRole', { sessionId: worker.sessionId, role: ' release  prep ' });
    expect(named).toMatchObject({ sessionId: worker.sessionId, role: 'custom', roleName: 'release prep', state: worker.state });
    await untilAgent(setup.recorder, worker.sessionId, (seen) => seen.roleName === 'release prep');
    expect(await setup.client.call('agent.setRole', { sessionId: worker.sessionId, role: null })).toMatchObject({ role: null, roleName: null });
    // An orchestrator is a role like any other: it changes nothing an agent may do.
    expect(await setup.client.call('agent.setRole', { sessionId: worker.sessionId, role: 'Orchestrator' })).toMatchObject({ roleName: 'Orchestrator' });
    // Only the role changed: nothing was typed at it.
    expect(setup.recorder.screenText(worker.sessionId)).toBe(screen);

    await expect(setup.client.call('agent.setRole', { sessionId: worker.sessionId, role: 'x'.repeat(MAX_ROLE_NAME_LENGTH + 1) })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: `a role name is at most ${MAX_ROLE_NAME_LENGTH} characters`,
    });
    await expect(setup.client.call('agent.setRole', { sessionId: 'nobody', role: 'reviewer' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });

    // The user's method alone: an agent's board token, an orchestrator's too, goes through orchestrator.giveRole.
    const { connection, token } = await agentSide(setup, setup.zone.id);
    await expect(connection.call('agent.setRole', { sessionId: worker.sessionId, role: 'reviewer' })).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
    expect(await connection.call('orchestrator.giveRole', { token, sessionId: worker.sessionId, role: 'designer' })).toMatchObject({ roleName: 'designer' });
  });

  it('lets an agent make itself its zone’s orchestrator, and give any role to an agent an agent started, never to the user’s own', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id);

    // Its own tile, by its session.
    expect(await connection.call('orchestrator.giveRole', { token, sessionId: me.sessionId, role: 'orchestrator' })).toMatchObject({ role: 'custom', roleName: 'orchestrator' });
    const lead = await untilAgent(setup.recorder, me.sessionId, (seen) => seen.roleName === 'orchestrator');
    expect(isLead(lead, [lead])).toBe(true);

    // One it started: any role, an orchestrator among them.
    const worker = await connection.call('orchestrator.spawn', { token, name: 'worker', prompt: 'Print your board identity' });
    expect(await connection.call('orchestrator.giveRole', { token, sessionId: worker.sessionId, role: 'implementer' })).toMatchObject({ role: 'implementer' });
    expect(await connection.call('orchestrator.giveRole', { token, sessionId: worker.sessionId, role: 'Orchestrator' })).toMatchObject({ roleName: 'Orchestrator' });
    expect(await connection.call('orchestrator.giveRole', { token, sessionId: worker.sessionId, role: null })).toMatchObject({ role: null, roleName: null });

    // The user may give any agent any role.
    const elsewhere = await userAgent(setup.client, setup.other.id, 'elsewhere');
    expect(await setup.client.call('orchestrator.giveRole', { sessionId: elsewhere.sessionId, role: 'orchestrator' })).toMatchObject({ roleName: 'orchestrator' });

    // One the user started, refused in plain words, and the user sees it tried.
    await expect(connection.call('orchestrator.giveRole', { token, sessionId: elsewhere.sessionId, role: 'reviewer' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringContaining('elsewhere is one the user started by hand'),
    });
    const [line] = await setup.client.call('orchestrator.activity', { limit: 1 });
    expect(line).toMatchObject({ action: 'role', outcome: 'refused', targetName: 'elsewhere', detail: 'reviewer' });
  });

  it('never types to an agent waiting mid-turn on the user’s answer to its question', async () => {
    // Each later message plays the scenario too, so the user can have the agent ask once its starter has ended.
    const setup = await orchestrateDaemon({ repeat: true });
    const starter = await agentSide(setup, setup.zone.id);
    const { token, connection } = await agentSide(setup, setup.zone.id);
    // One an agent started, whose starter has ended: a live starter would have taken its question, not the user.
    const worker = await crewAgent(setup, { zoneId: setup.zone.id, name: 'asker' }, starter);
    await setup.client.call('agent.stop', { sessionId: starter.agent.sessionId });
    await untilAgent(setup.recorder, starter.agent.sessionId, (seen) => seen.endedAt !== null);
    await setup.client.call('agent.answer', { sessionId: worker.sessionId, text: 'Ask in words: What should the banner say?' });
    await untilAgent(setup.recorder, worker.sessionId, (seen) => seen.ask !== null);

    await expect(connection.call('orchestrator.send', { token, sessionId: worker.sessionId, text: 'Free shipping' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/waiting on the user's answer to its question or plan/),
    });
  });

  it('never types to an agent that needs the user’s permission', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
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
    const { token, connection } = await agentSide(setup, setup.zone.id);
    const quick = await connection.call('orchestrator.spawn', { token, name: 'quick', prompt: 'Write the handover' });
    const slow = await connection.call('orchestrator.spawn', { token, name: 'slow', prompt: 'Work slowly' });

    const any = await connection.call('orchestrator.wait', { token, sessionIds: [quick.sessionId, slow.sessionId], any: true });
    expect(any.timedOut).toBe(false);
    // The slow one's turn hasn't ended: it hasn't begun, or is on its way (on a loaded machine it may be thinking already).
    expect(['starting', 'idle', 'running', 'thinking']).toContain(any.agents.find((agent) => agent.name === 'slow')!.state);
    await expect(connection.call('orchestrator.read', { token, sessionId: slow.sessionId })).rejects.toMatchObject({
      message: expect.stringMatching(/has not finished a turn yet/),
    });
    const all = await connection.call('orchestrator.wait', { token, sessionIds: [quick.sessionId, slow.sessionId] });
    expect(all.timedOut).toBe(false);
    expect((await connection.call('orchestrator.read', { token, sessionId: slow.sessionId })).text).toBe('Slow work done.');
  });

  it('steers an agent in the orchestrator role as any other: no agent outranks another', async () => {
    const setup = await orchestrateDaemon();
    const starter = await agentSide(setup, setup.zone.id);
    const zone = await crewSide(setup, setup.zone.id, { name: 'zone lead', by: starter });
    const board = await crewSide(setup, setup.other.id, { name: 'board lead', by: starter });
    const plain = await crewSide(setup, setup.zone.id, { name: 'plain', by: starter });
    for (const lead of [zone, board]) await setup.client.call('agent.setRole', { sessionId: lead.agent.sessionId, role: 'orchestrator' });
    await setup.client.call('orchestrator.wait', { sessionIds: [zone.agent.sessionId, board.agent.sessionId, plain.agent.sessionId] });

    // Each reaches the others, its role and zone aside.
    await expect(plain.connection.call('orchestrator.send', { token: plain.token, sessionId: board.agent.sessionId, text: 'Carry on' })).resolves.toBeDefined();
    await expect(zone.connection.call('orchestrator.send', { token: zone.token, sessionId: board.agent.sessionId, text: 'Carry on' })).resolves.toBeDefined();
    await expect(board.connection.call('orchestrator.send', { token: board.token, sessionId: zone.agent.sessionId, text: 'Carry on' })).resolves.toBeDefined();
    expect((await plain.connection.call('orchestrator.wait', { token: plain.token, sessionIds: [zone.agent.sessionId, board.agent.sessionId] })).timedOut).toBe(false);
    await expect(plain.connection.call('orchestrator.close', { token: plain.token, sessionId: zone.agent.sessionId })).resolves.toMatchObject({ sessionId: zone.agent.sessionId });
    // But none the user started by hand, the one that started them among them.
    await expect(board.connection.call('orchestrator.interrupt', { token: board.token, sessionId: starter.agent.sessionId })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/started by hand/),
    });
  });

  it('starts no agent from a base whose project config differs from the repo’s HEAD', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
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

describe('a send to an agent mid-turn', () => {
  it('is queued, then delivered in order once its turn ends, each as a turn of its own, and a wait sees the last', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id);
    const busy = await connection.call('orchestrator.spawn', { token, zoneId: setup.zone.id, name: 'busy lead', prompt: 'Work slowly' });
    await setup.client.call('session.attach', { sessionId: busy.sessionId });
    await untilAgent(setup.recorder, busy.sessionId, (seen) => seen.state === 'running');

    expect(await connection.call('orchestrator.send', { token, sessionId: busy.sessionId, text: 'First report' })).toMatchObject({
      delivery: 'queued-after-turn',
      messagesWaiting: 1,
    });
    expect(await connection.call('orchestrator.send', { token, sessionId: busy.sessionId, text: 'Second report' })).toMatchObject({
      delivery: 'queued-after-turn',
      messagesWaiting: 2,
    });

    expect(await connection.call('orchestrator.wait', { token, sessionIds: [busy.sessionId] })).toMatchObject({
      timedOut: false,
      agents: [{ state: expect.stringMatching(/idle|waiting/), messagesWaiting: 0 }],
    });
    expect((await connection.call('orchestrator.read', { token, sessionId: busy.sessionId })).text).toBe(`Done: ${sentBy(me, 'Second report')}.`);
    const screen = setup.recorder.screenText(busy.sessionId);
    expect(screen.indexOf('Slow work done.')).toBeLessThan(screen.indexOf(`Done: ${sentBy(me, 'First report')}.`));
    expect(screen.indexOf(`Done: ${sentBy(me, 'First report')}.`)).toBeLessThan(screen.indexOf(`Done: ${sentBy(me, 'Second report')}.`));
  });

  it('is typed only as each of its back-to-back turns ends, in order, and the log says when each was queued, typed and taken up', async () => {
    const logs: string[] = [];
    const setup = await orchestrateDaemon({ log: (message) => void logs.push(message) });
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id);
    const busy = await connection.call('orchestrator.spawn', { token, zoneId: setup.zone.id, name: 'busy lead', prompt: 'Work slowly' });
    await setup.client.call('session.attach', { sessionId: busy.sessionId });
    await untilAgent(setup.recorder, busy.sessionId, (seen) => seen.state === 'running');

    // The first starts a turn as this one ends; the second waits for that turn to end too.
    for (const text of ['Wind down at 08:15', 'Stop starting workers']) {
      expect(await connection.call('orchestrator.send', { token, sessionId: busy.sessionId, text })).toMatchObject({ delivery: 'queued-after-turn' });
    }

    const prompts = () =>
      setup.recorder.events.flatMap((event) =>
        event.type === 'hook' && event.sessionId === busy.sessionId && event.event === 'UserPromptSubmit' ? [event.payload.prompt] : [],
      );
    // The daemon logs a turn's start as it hears the hook; this client hears the same hook a moment later.
    await vi.waitFor(
      () => {
        expect(sendLogLines(logs, busy.sessionId).map((lines) => lines.at(-1))).toEqual(['18: turn started on it', '21: turn started on it']);
        expect(prompts()).toHaveLength(3);
      },
      { timeout: 30_000 },
    );
    expect(sendLogLines(logs, busy.sessionId)).toEqual([
      ['18: queued until its turn ends (1 waiting)', '18: typing at its prompt, its turn ended', '18: turn started on it'],
      ['21: queued until its turn ends (2 waiting)', '21: typing at its prompt, its turn ended', '21: turn started on it'],
    ]);
    expect(prompts()).toEqual(['Work slowly', sentBy(me, 'Wind down at 08:15'), sentBy(me, 'Stop starting workers')]);
    // What a message says may be secret: the log keeps only its length.
    expect(logs.filter((message) => message.includes('Wind down') || message.includes('starting workers'))).toEqual([]);
  }, 60_000);

  it('puts a send behind the messages still waiting, from whichever sender, so each starts a turn of its own in the order sent', async () => {
    const setup = await orchestrateDaemon();
    const one = await agentSide(setup, setup.zone.id);
    // One an agent started, which the busy one may answer anyway: so it is sent no hint how.
    const two = await crewSide(setup, setup.zone.id);
    const busy = await one.connection.call('orchestrator.spawn', { token: one.token, zoneId: setup.zone.id, name: 'busy lead', prompt: 'Work slowly' });
    await setup.client.call('session.attach', { sessionId: busy.sessionId });
    await untilAgent(setup.recorder, busy.sessionId, (seen) => seen.state === 'running');
    for (const text of ['First report', 'Second report']) await one.connection.call('orchestrator.send', { token: one.token, sessionId: busy.sessionId, text });

    // Its turn has ended and the first is going up: the next send goes to the back of the line, never into that turn.
    await untilAgent(setup.recorder, busy.sessionId, (seen) => (seen.state === 'idle' || seen.state === 'waiting') && seen.messagesWaiting > 0);
    expect(await two.connection.call('orchestrator.send', { token: two.token, sessionId: busy.sessionId, text: 'Third report' })).toMatchObject({
      delivery: 'queued-after-turn',
    });
    await vi.waitFor(() => expect(setup.recorder.screenText(busy.sessionId)).toContain(`Done: ${sentBy(two.agent, 'Third report')}.`), { timeout: 30_000 });
    const prompts = setup.recorder.events.flatMap((event) =>
      event.type === 'hook' && event.sessionId === busy.sessionId && event.event === 'UserPromptSubmit' ? [event.payload.prompt] : [],
    );
    expect(prompts).toEqual(['Work slowly', sentBy(one.agent, 'First report'), sentBy(one.agent, 'Second report'), sentBy(two.agent, 'Third report')]);
  }, 60_000);

  it('is queued as a reply too, to an agent the user started by hand that messaged it', async () => {
    // Each later message plays the scenario too, so the busy one can be set to work slowly after it has sent.
    const setup = await orchestrateDaemon({ repeat: true });
    const captain = await agentSide(setup, setup.zone.id);
    const lead = await crewSide(setup, setup.other.id);
    await captain.connection.call('orchestrator.send', { token: captain.token, sessionId: lead.agent.sessionId, text: 'Report back tonight' });
    await captain.connection.call('orchestrator.wait', { token: captain.token, sessionIds: [lead.agent.sessionId] });
    await setup.client.call('agent.answer', { sessionId: captain.agent.sessionId, text: 'Work slowly' });
    await untilAgent(setup.recorder, captain.agent.sessionId, (seen) => seen.state === 'running');

    expect(await lead.connection.call('orchestrator.send', { token: lead.token, sessionId: captain.agent.sessionId, text: 'Nightly report' })).toMatchObject({
      delivery: 'queued-after-turn',
      messagesWaiting: 1,
    });
    await vi.waitFor(() => expect(setup.recorder.screenText(captain.agent.sessionId)).toMatch(/Slow work done\.[\s\S]*Nightly report/), { timeout: 30_000 });
    await vi.waitFor(async () =>
      expect((await setup.client.call('agent.list')).find((one) => one.sessionId === captain.agent.sessionId)).toMatchObject({ messagesWaiting: 0 }),
    );
  }, 60_000);

  it('still refuses one that needs the user’s permission', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
    const asking = await crewAgent(setup, { zoneId: setup.zone.id, name: 'asking lead', prompt: 'Ask permission' });
    await untilAgent(setup.recorder, asking.sessionId, (seen) => seen.permissions.length > 0);
    await expect(connection.call('orchestrator.send', { token, sessionId: asking.sessionId, text: 'yes' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/needs the user's permission first/),
    });
  });

  it('is kept as not delivered, for Resend, when the daemon shuts down before its turn ends', async () => {
    const dataDir = tempDataDir();
    const setup = await orchestrateDaemon({ dataDir });
    const { token, connection } = await agentSide(setup, setup.zone.id);
    const busy = await crewAgent(setup, { zoneId: setup.zone.id, name: 'busy lead', prompt: 'Work slowly' });
    await untilAgent(setup.recorder, busy.sessionId, (seen) => seen.state === 'running');
    await connection.call('orchestrator.send', { token, sessionId: busy.sessionId, text: 'Morning report' });
    await setup.daemon.stop();

    const again = await startOrchestrateDaemon({ dataDir });
    const client = await connectTestClient(again);
    expect((await client.call('agent.list')).find((agent) => agent.sessionId === busy.sessionId)).toMatchObject({
      messagesWaiting: 0,
      undelivered: [{ what: 'A message', text: expect.stringMatching(/^⟨send from .*⟩ Morning report/), reason: 'the daemon shut down before its turn ended' }],
      flag: { to: 'user', reason: expect.stringMatching(/^A message was not delivered .*Resend/) },
    });
  });
});

describe("the daemon's log of an orchestrator ending or interrupting an agent", () => {
  /** An orchestrator in the first zone, on a daemon whose log is kept. */
  async function loggedLead() {
    const logs: string[] = [];
    const setup = await orchestrateDaemon({ log: (message) => void logs.push(message) });
    const lead = await agentSide(setup, setup.zone.id);
    /** Waits for a line of the log matching `pattern`, and returns it. */
    const logged = async (pattern: RegExp): Promise<string> => {
      let line: string | undefined;
      await vi.waitFor(() => {
        line = logs.find((message) => pattern.test(message));
        expect(line).toBeDefined();
      }, { timeout: 5_000 });
      return line!;
    };
    return { setup, lead, logged };
  }

  it('names the orchestrator that interrupted a turn', async () => {
    const { setup, lead, logged } = await loggedLead();
    const worker = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'slow', prompt: 'Work slowly' });
    await untilAgent(setup.recorder, worker.sessionId, (seen) => seen.state === 'running');

    await lead.connection.call('orchestrator.interrupt', { token: lead.token, sessionId: worker.sessionId });

    expect(await logged(/^interrupting agent /)).toBe(
      `interrupting agent ${worker.sessionId} for orchestrator ${lead.agent.name}'s interrupt (agent:${lead.agent.sessionId})`,
    );
  });

  it('names the orchestrator that closed an agent', async () => {
    const { lead, logged } = await loggedLead();
    const worker = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'quick', prompt: 'Write the handover' });
    await lead.connection.call('orchestrator.wait', { token: lead.token, sessionIds: [worker.sessionId] });

    await lead.connection.call('orchestrator.close', { token: lead.token, sessionId: worker.sessionId });

    expect(await logged(new RegExp(`^claude session ${worker.sessionId} .* exited `))).toMatch(
      new RegExp(`, ended by the daemon for orchestrator ${lead.agent.name}'s close \\(agent:${lead.agent.sessionId}\\)$`),
    );
  });

  it('names the user who removed an agent, and the delete its session ended for', async () => {
    const { setup, logged } = await loggedLead();
    const agent = await userAgent(setup.client, setup.zone.id, 'clean');

    await setup.client.call('orchestrator.close', { sessionId: agent.sessionId, remove: true });

    expect(await logged(new RegExp(`^claude session ${agent.sessionId} .* exited `))).toMatch(
      /, ended by the daemon for its delete for the user's remove$/,
    );
    expect(await logged(new RegExp(`^deleted agent ${agent.sessionId} `))).toMatch(/ for the user's remove$/);
  });
});

describe('what an orchestrator may hand git', () => {
  it('never lets a base or branch name reach git as an option', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
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
    const { token, connection } = await agentSide(setup, setup.zone.id);
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

describe('a base branch on a remote', () => {
  /** A repo whose `origin` has `feature`, `config` (loosened project config) and nothing local of either. */
  function withRemote(repoRoot: string) {
    const upstream = tempRepo('upstream');
    git(upstream, 'checkout', '-q', '-b', 'feature');
    git(upstream, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'feature');
    git(upstream, 'checkout', '-q', '-b', 'config');
    mkdirSync(join(upstream, '.claude'));
    writeFileSync(join(upstream, '.claude', 'settings.json'), '{"permissions":{"defaultMode":"bypassPermissions"}}');
    git(upstream, 'add', '.claude');
    git(upstream, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'loosen the settings');
    git(repoRoot, 'remote', 'add', 'origin', upstream);
    return upstream;
  }

  it("starts an agent from origin/<branch>, fetched and made the repo's own branch", async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
    const upstream = withRemote(setup.zone.repoRoot!);

    const agent = await connection.call('orchestrator.spawn', { token, name: 'remote', baseBranch: 'origin/feature' });

    const tip = git(upstream, 'rev-parse', 'feature');
    expect(git(setup.zone.repoRoot!, 'rev-parse', 'refs/heads/feature')).toBe(tip);
    expect(git(agent.worktree, 'rev-parse', 'HEAD')).toBe(tip);
    // A reviewer of it, named as the remote's, reviews the same branch.
    const reviewer = await connection.call('orchestrator.spawn', { token, name: 'review', role: 'reviewer', baseBranch: 'origin/feature' });
    expect(reviewer.reviews).toMatchObject({ branch: 'feature', head: tip });
  });

  it("checks a remote branch's project config as a local one's", async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
    withRemote(setup.zone.repoRoot!);

    await expect(connection.call('orchestrator.spawn', { token, name: 'loose', baseBranch: 'origin/config' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/project config differs.*\.claude\/settings\.json/),
    });
    // Refused before the branch is made, so the repo is left as it was.
    expect(git(setup.zone.repoRoot!, 'branch', '--list', 'config')).toBe('');
    await expect(connection.call('orchestrator.spawn', { token, name: 'none', baseBranch: 'origin/nope' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining('has no branch origin/nope'),
    });
  });
});

describe('the activity log', () => {
  it('records what each orchestrator did and tried, newest first, and tells every client', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id);
    const child = await connection.call('orchestrator.spawn', { token, name: 'child', prompt: 'Write the handover' });
    await expect(connection.call('orchestrator.spawn', { token, zoneId: 'nowhere' })).rejects.toBeDefined();
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
    expect(log[1]).toMatchObject({ orchestratorName: me.name, reason: 'no zone nowhere' });
    // A read, from a session's board token too.
    expect(await connection.call('orchestrator.activity', { limit: 1 })).toHaveLength(1);
  });

  it('reads page by page, each older than the last line read', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id);
    for (const zoneId of ['nowhere', 'nowhere', 'nowhere']) {
      await expect(connection.call('orchestrator.spawn', { token, zoneId })).rejects.toBeDefined();
    }
    const first = await setup.client.call('orchestrator.activity', { orchestratorId: me.sessionId, limit: 2 });
    const next = await setup.client.call('orchestrator.activity', { orchestratorId: me.sessionId, limit: 2, before: first.at(-1)!.id });
    expect(next).toHaveLength(1);
    expect([...first, ...next].map((line) => line.id)).toEqual(
      (await setup.client.call('orchestrator.activity', { orchestratorId: me.sessionId })).map((line) => line.id),
    );
  });

  it('logs its bad calls', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id);
    await expect(connection.call('orchestrator.spawn', { token, prompt: 'Sneak one in', zoneId: 'nowhere' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await expect(connection.call('orchestrator.send', { token, sessionId: 'nobody', text: 'hi' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });

    const log = await setup.client.call('orchestrator.activity', { orchestratorId: me.sessionId });
    expect(log.map(({ action, outcome, detail, targetId }) => ({ action, outcome, detail, targetId }))).toEqual([
      { action: 'send', outcome: 'refused', detail: 'hi', targetId: null },
      { action: 'spawn', outcome: 'refused', detail: 'Sneak one in', targetId: null },
    ]);
    expect(log[1]!.reason).toMatch(/nowhere/);
  });

  it('shows every session every line, live and read', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
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
      ...SIZE,
    });
    await setup.client.call('session.attach', { sessionId: lead.sessionId });

    await setup.recorder.waitForText(lead.sessionId, 'The worker is done and closed.');
    const screen = setup.recorder.screenText(lead.sessionId).replace(/\r/g, '');
    const worker = (await setup.client.call('agent.list')).find((agent) => agent.name === 'worker')!;
    const ref = `agent:${worker.sessionId.slice(0, 4)}`;
    expect(worker).toMatchObject({ spawnedBy: lead.sessionId, zoneId: setup.zone.id, state: 'done' });
    expect(screen).toContain(`Started ${ref}  worker  [`);
    expect(screen).toContain('# Handover\n\nThe work is done.');
    expect(screen).toContain(`Done: ${sentBy(lead, 'Also add a test')}.`);
    expect(screen).toContain(`Closed ${ref} worker: its session ended`);

    const log = await setup.client.call('orchestrator.activity', { orchestratorId: lead.sessionId });
    expect(log.map(({ action, outcome }) => `${action} ${outcome}`)).toEqual(['close done', 'send done', 'spawn done']);
  });
});

describe('agent-board mcp for an orchestrator', () => {
  /** What the board MCP offers an agent's live session: every tool, the control tools among them. */
  const ALL_TOOLS = [
    'whoami', 'board', 'usage', 'connections', 'handoff', 'ask', 'present_plan', 'show_doc', 'set_status', 'needs_you', 'open_pr', 'record_pr', 'record_doc', 'pin', 'unpin', 'steps_new', 'steps_read', 'steps_update', 'memory_new', 'memory_read', 'memory_update', 'queue_new', 'queue_read', 'queue_update', 'remind', 'remind_read', 'remind_update', 'set_page', 'clock_add', 'clock_set', 'save_clock_template', 'list_clock_templates', 'remove_clock_template', 'new_agent', 'send', 'wait', 'read', 'interrupt', 'set_effort', 'give_role', 'continue_on_credits', 'restart', 'pause', 'wake', 'add_edge', 'list_edges', 'remove_edge', 'move', 'arrange', 'zone_layout', 'map', 'zone_screenshot', 'add_note',
    'edit_note', 'remove_note', 'add_shape', 'add_diagram', 'export_diagram', 'edit_shape', 'remove_shape', 'connect', 'edit_connector', 'remove_connector', 'add_schedule', 'list_schedules', 'remove_schedule', 'prefabs', 'roles', 'set_role', 'remove_role', 'close', 'ask_to_remove', 'handover',
  ];

  it('tells every live agent it may act on the board, and lists the control tools to each', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const plain = await crewSide(setup, setup.other.id);

    for (const { token } of [lead, plain]) {
      const mcp = mcpAs(setup, token);
      expect((await mcp.initialize()).instructions).toBe(`${BOARD_MCP_INSTRUCTIONS} ${ORCHESTRATOR_INSTRUCTIONS}`);
      expect(await mcp.listTools()).toEqual(ALL_TOOLS);
    }
  });

  it('joins two of its agents with an edge, and removes it, over the tools', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const impl = await crewAgent(setup, { zoneId: setup.zone.id, name: 'impl' }, lead);
    const review = await crewAgent(setup, { zoneId: setup.zone.id, name: 'review' }, lead);
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
    const lead = await agentSide(setup, setup.zone.id);
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

  it('lets any agent change the app’s list, and any zone’s template', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    for (const zoneId of [setup.zone.id, setup.other.id]) {
      const set = await lead.connection.call('orchestrator.setRole', { token: lead.token, name: 'designer', body: 'Zone design.', zoneId });
      expect(set).toMatchObject({ name: 'designer', body: 'Zone design.' });
      expect((await setup.client.call('zone.roleTemplates', { id: zoneId })).find((each) => each.role === 'designer')).toMatchObject({
        body: 'Zone design.',
        appDefault: false,
      });
      await lead.connection.call('orchestrator.removeRole', { token: lead.token, name: 'designer', zoneId });
      expect((await setup.client.call('zone.roleTemplates', { id: zoneId })).find((each) => each.role === 'designer')).toBeUndefined();
    }
    expect(await lead.connection.call('orchestrator.setRole', { token: lead.token, name: 'designer', body: 'App design.' })).toMatchObject({ name: 'designer' });
    expect(await setup.client.call('orchestrator.roles', {})).toEqual([expect.objectContaining({ name: 'designer', body: 'App design.' })]);
  });

  it('refuses an agent whose session has ended', async () => {
    const setup = await orchestrateDaemon();
    const { agent, token, connection } = await agentSide(setup, setup.zone.id);
    await setup.client.call('agent.stop', { sessionId: agent.sessionId });
    await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.endedAt !== null);

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

  it('restarts an ended agent another agent started in place, carrying on its conversation, over the CLI and the MCP, and logs it', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const { agent: worker } = await crewSide(setup, setup.zone.id);
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
    const lead = await agentSide(setup, setup.zone.id);
    const { agent: worker } = await crewSide(setup, setup.zone.id);
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
    const lead = await agentSide(setup, setup.zone.id);
    const { agent: worker } = await crewSide(setup, setup.zone.id);
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
    const lead = await agentSide(setup, setup.zone.id);
    const { agent: worker } = await crewSide(setup, setup.zone.id);
    await end(setup, worker.sessionId);
    rmSync(worker.cwd, { recursive: true, force: true });

    await expect(lead.connection.call('orchestrator.restart', { token: lead.token, sessionId: worker.sessionId, fresh: true })).rejects.toMatchObject({
      message: expect.stringContaining('worktree is gone'),
    });
    const agent = (await setup.client.call('agent.list')).find((each) => each.sessionId === worker.sessionId)!;
    expect(agent.endedAt).not.toBeNull();
    expect(agent.earlierConversations).toEqual([]);
  }, 30_000);

  it('refuses a fresh restart of an agent the user started by hand', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
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
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id);
    const { agent: worker } = await crewSide(setup, setup.zone.id);
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

  it('refuses an agent the user started by hand, a running one and itself, and logs each refusal', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id);
    const elsewhere = await userAgent(setup.client, setup.other.id, 'elsewhere');
    const running = await crewAgent(setup, { zoneId: setup.zone.id, name: 'running' });
    await setup.client.call('agent.stop', { sessionId: elsewhere.sessionId });

    await expect(connection.call('orchestrator.restart', { token, sessionId: elsewhere.sessionId })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/started by hand/),
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

describe('pausing and waking an agent', () => {
  /** Waits for an update to the agent, sent after the `before`th event, in which it matches `match`. */
  const untilAgentAfter = async (setup: Setup, before: number, sessionId: string, match: (agent: Agent) => boolean) => {
    const event = await setup.recorder.waitFor(
      (e: DaemonEvent): e is AgentUpdatedEvent =>
        e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent) && setup.recorder.events.indexOf(e) >= before,
    );
    return event.agent;
  };

  /** Resolves with the agent's `event` hook, sent after the `before`th event. */
  const hookAfter = (setup: Setup, before: number, sessionId: string, event: string) =>
    setup.recorder.waitFor(
      (e: DaemonEvent): e is HookEvent => e.type === 'hook' && e.sessionId === sessionId && e.event === event && setup.recorder.events.indexOf(e) >= before,
    );

  it('pauses an idle agent another agent started as paused by it, and wakes it by wake or a message, over the CLI and the MCP, and logs it', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const { agent: worker } = await crewSide(setup, setup.zone.id);
    await untilAgentAfter(setup, 0, worker.sessionId, (agent) => agent.state === 'idle' || agent.state === 'waiting');
    const ref = `agent:${worker.sessionId.slice(0, 4)}`;
    const env = { [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: lead.token };
    let out = '';
    const io = { out: (text: string) => (out += text), err: (text: string) => (out += text), env };

    expect(await runBoardCommand('pause', [ref], io)).toBe(0);
    expect(out).toMatch(new RegExp(`^Paused ${ref} `));
    expect((await setup.client.call('agent.list')).find((each) => each.sessionId === worker.sessionId)).toMatchObject({
      state: 'hibernated',
      hibernated: { by: lead.agent.name },
    });
    let before = setup.recorder.events.length;
    out = '';
    expect(await runBoardCommand('wake', [ref], io)).toBe(0);
    expect(out).toMatch(new RegExp(`^Woke ${ref} `));
    expect((await hookAfter(setup, before, worker.sessionId, 'SessionStart')).payload).toMatchObject({ source: 'resume', session_id: worker.sessionId });
    await untilAgentAfter(setup, before, worker.sessionId, (agent) => agent.endedAt === null && agent.hibernated === null);

    const mcp = mcpAs(setup, lead.token);
    expect(await mcp.callTool('pause', { agent: ref })).toMatchObject({ isError: false, text: expect.stringMatching(/^Paused agent:/) });
    before = setup.recorder.events.length;
    expect(await mcp.callTool('send', { agent: ref, text: 'Also add a test' })).toMatchObject({ isError: false });
    // The lead is one the user started by hand, which it may not message unprompted: so it is told it may answer it.
    expect((await hookAfter(setup, before, worker.sessionId, 'UserPromptSubmit')).payload).toMatchObject({
      prompt: `${markSender('send', lead.agent.name, refOf(lead.agent), 'Also add a test')}\n\n[agent-board] From ${lead.agent.name} (agent:${lead.agent.sessionId.slice(0, 8)}), who you may answer with \`agent-board send agent:${lead.agent.sessionId.slice(0, 8)} -- '…'\`.`,
    });

    const log = await setup.client.call('orchestrator.activity', { orchestratorId: lead.agent.sessionId });
    expect(log.map(({ action, outcome, targetId }) => `${action} ${outcome} ${targetId}`).reverse()).toEqual([
      `pause done ${worker.sessionId}`,
      `wake done ${worker.sessionId}`,
      `pause done ${worker.sessionId}`,
      `send done ${worker.sessionId}`,
    ]);
  }, 30_000);

  it("tells its orchestrator it was paused and by whom, not that it ended, and logs a restart that wakes it as a wake", async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const { agent: worker } = await crewSide(setup, setup.zone.id, { by: lead });
    await untilAgentAfter(setup, 0, worker.sessionId, (agent) => agent.state === 'idle' || agent.state === 'waiting');
    const { cursor } = await lead.connection.call('orchestrator.wait', { token: lead.token, sessionIds: [worker.sessionId], since: 'now', timeoutMs: 0 });

    const paused = await lead.connection.call('orchestrator.pause', { token: lead.token, sessionId: worker.sessionId });
    expect(paused.hibernated).toMatchObject({ by: lead.agent.name, byId: lead.agent.sessionId });
    const heard = await lead.connection.call('orchestrator.wait', { token: lead.token, sessionIds: [worker.sessionId], since: cursor });
    expect(heard.events.map(({ kind, detail }) => `${kind}: ${detail}`)).toEqual([`paused: by ${lead.agent.name}`]);

    await lead.connection.call('orchestrator.restart', { token: lead.token, sessionId: worker.sessionId });
    const log = await setup.client.call('orchestrator.activity', { orchestratorId: lead.agent.sessionId });
    expect(log.map(({ action, outcome }) => `${action} ${outcome}`)).toEqual(['wake done', 'pause done', 'spawn done']);
  }, 30_000);

  it('tells its orchestrator once a paused agent is closed as it is, or removed', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const closed = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'closed', prompt: 'Run the tests' });
    const removed = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'removed', prompt: 'Run the tests' });
    for (const each of [closed, removed]) {
      await untilAgentAfter(setup, 0, each.sessionId, (agent) => agent.state === 'idle' || agent.state === 'waiting');
      await lead.connection.call('orchestrator.pause', { token: lead.token, sessionId: each.sessionId });
    }
    // Its crew, as a removed agent can't be named.
    const { cursor } = await lead.connection.call('orchestrator.wait', { token: lead.token, crew: true, since: 'now', timeoutMs: 0 });

    await setup.client.call('agent.stop', { sessionId: closed.sessionId });
    await setup.client.call('agent.delete', { sessionId: removed.sessionId, force: true });
    const heard = await lead.connection.call('orchestrator.wait', { token: lead.token, crew: true, since: cursor, timeoutMs: 2_000 });

    expect(heard.events.map(({ name, kind, detail }) => `${name} ${kind}: ${detail}`)).toEqual([
      `${closed.name} ended: closed`,
      `${removed.name} ended: removed`,
    ]);
  }, 30_000);

  it('refuses to wake an agent that is not paused, or to pause one the user started by hand', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const worker = await crewAgent(setup, { zoneId: setup.zone.id, name: 'worker' });
    const elsewhere = await userAgent(setup.client, setup.other.id, 'elsewhere');

    await expect(lead.connection.call('orchestrator.wake', { token: lead.token, sessionId: worker.sessionId })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: 'worker is not paused',
    });
    await expect(lead.connection.call('orchestrator.pause', { token: lead.token, sessionId: elsewhere.sessionId })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/started by hand/),
    });
  });
});

describe('a crew member and the agent that started it', () => {
  it('messages it, though the user started it, and does nothing more to it or to another the user started', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const other = await userAgent(setup.client, setup.zone.id, 'other');
    const member = await crewSide(setup, setup.zone.id, { name: 'member', by: lead });

    await member.connection.call('orchestrator.send', { token: member.token, sessionId: lead.agent.sessionId, text: 'The menu scrolls now' });
    await setup.recorder.waitForText(lead.agent.sessionId, 'The menu scrolls now');
    for (const call of [
      { sessionId: lead.agent.sessionId, submit: true },
      { sessionId: lead.agent.sessionId, clear: true },
      { sessionId: other.sessionId, text: 'Hello' },
    ]) {
      await expect(member.connection.call('orchestrator.send', { token: member.token, ...call })).rejects.toMatchObject({
        code: BOARD_ERROR.outOfScope,
        message: expect.stringMatching(/started by hand/),
      });
    }
    await expect(member.connection.call('orchestrator.interrupt', { token: member.token, sessionId: lead.agent.sessionId })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
  });
});

describe('handing a crew over', () => {
  const refTo = (agent: Agent) => `agent:${agent.sessionId.slice(0, 8)}`;

  it('is a tool an orchestrator lists, and tells the app who made each edge it moves', async () => {
    const setup = await orchestrateDaemon();
    const first = await agentSide(setup, setup.zone.id);
    const second = await crewSide(setup, setup.zone.id, { name: 'second' });
    const worker = await first.connection.call('orchestrator.spawn', { token: first.token, name: 'one' });
    const edge = await first.connection.call('orchestrator.addEdge', { token: first.token, from: worker.sessionId, to: first.agent.sessionId, trigger: 'manual' });

    const mcp = mcpAs(setup, first.token);
    expect(await mcp.listTools()).toContain('handover');
    const before = setup.recorder.events.length;
    expect(await mcp.callTool('handover', { from: refTo(first.agent), to: refTo(second.agent) })).toMatchObject({
      isError: false,
      text: expect.stringMatching(/crew to agent:\w+ .*: agent:\w+ one, and 1 thing on the board\.$/),
    });
    expect((await setup.client.call('agent.list')).find((each) => each.sessionId === worker.sessionId)?.spawnedBy).toBe(second.agent.sessionId);
    await setup.recorder.waitFor(
      (e: DaemonEvent): e is DaemonEvent =>
        e.type === 'flowEdge.updated' && e.edge.id === edge.id && e.edge.madeBy === second.agent.sessionId && setup.recorder.events.indexOf(e) >= before,
    );
  });

  it('carries a crew to an agent an agent started in any zone, and the taker may then remove it as its own', async () => {
    const setup = await orchestrateDaemon();
    const boss = await agentSide(setup, setup.zone.id);
    const small = await crewSide(setup, setup.other.id, { name: 'small' });
    const far = await boss.connection.call('orchestrator.spawn', { token: boss.token, zoneId: setup.other.id, name: 'far' });

    // Until it is handed over, it may steer far but not remove it.
    await expect(small.connection.call('orchestrator.close', { token: small.token, sessionId: far.sessionId, remove: true })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringContaining('was not started by you'),
    });
    const handed = await boss.connection.call('orchestrator.handover', { token: boss.token, from: boss.agent.sessionId, to: small.agent.sessionId });
    expect(handed.crew.map((agent) => agent.name)).toEqual(['far']);
    expect((await setup.client.call('agent.list')).find((each) => each.sessionId === far.sessionId)?.spawnedBy).toBe(small.agent.sessionId);
    expect(await small.connection.call('orchestrator.close', { token: small.token, sessionId: far.sessionId, remove: true })).toBeNull();
    expect((await setup.client.call('agent.list')).map((each) => each.name)).not.toContain('far');
  });

  it('never hands a crew to an agent the user started by hand, whose prompt its needs-you would reach', async () => {
    const setup = await orchestrateDaemon();
    const boss = await agentSide(setup, setup.zone.id);
    const mine = await userAgent(setup.client, setup.zone.id, 'mine');
    const deputy = await crewSide(setup, setup.zone.id, { name: 'deputy', by: boss });
    await boss.connection.call('orchestrator.spawn', { token: boss.token, name: 'one' });
    await deputy.connection.call('orchestrator.spawn', { token: deputy.token, name: 'two' });

    // A hand-started agent may not hand its crew to another, and nor may one an agent started.
    for (const [side, from] of [[boss, boss.agent], [deputy, deputy.agent]] as const) {
      await expect(side.connection.call('orchestrator.handover', { token: side.token, from: from.sessionId, to: mine.sessionId })).rejects.toMatchObject({
        code: BOARD_ERROR.outOfScope,
        message: expect.stringContaining('mine is one the user started by hand'),
      });
    }
    const crewOf = async () => Object.fromEntries((await setup.client.call('agent.list')).map((each) => [each.name, each.spawnedBy]));
    expect(await crewOf()).toMatchObject({ one: boss.agent.sessionId, two: deputy.agent.sessionId });
    // The user may.
    expect((await setup.client.call('orchestrator.handover', { from: boss.agent.sessionId, to: mine.sessionId })).crew.map((each) => each.name)).toContain('one');
  });

  it('never hands a crew to an agent in it, which would then lead the agent that leads it', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const child = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'child', prompt: 'Print your board identity' });
    const childSide = await agentSideOf(setup, child.sessionId);
    const grandchild = await childSide.connection.call('orchestrator.spawn', { token: childSide.token, name: 'grandchild' });
    const sibling = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'sibling' });
    const crewOf = async () => Object.fromEntries((await setup.client.call('agent.list')).map((each) => [each.name, each.spawnedBy]));

    await expect(setup.client.call('orchestrator.handover', { from: lead.agent.sessionId, to: grandchild.sessionId })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining(`grandchild is in ${lead.agent.name}'s crew`),
    });
    // An agent the lead started takes the rest of it: it leads its siblings, and no one leads it but the lead.
    expect((await setup.client.call('orchestrator.handover', { from: lead.agent.sessionId, to: child.sessionId })).crew.map((each) => each.name)).toEqual(['sibling']);
    expect(await crewOf()).toMatchObject({ child: lead.agent.sessionId, grandchild: child.sessionId, sibling: child.sessionId });

    // The same of a removed orchestrator's crew: the agent it left would be led by the one it leads.
    await setup.client.call('agent.delete', { sessionId: lead.agent.sessionId, force: true });
    await expect(setup.client.call('orchestrator.handover', { from: lead.agent.sessionId, to: grandchild.sessionId })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining(`grandchild is in ${lead.agent.name}'s crew`),
    });
    expect(await crewOf()).toMatchObject({ child: null, grandchild: child.sessionId, sibling: child.sessionId });
    expect(sibling.spawnedBy).toBe(lead.agent.sessionId);
  });

  describe('from an orchestrator since removed', () => {
    const listed = async (setup: Setup, sessionId: string) => (await setup.client.call('agent.list')).find((each) => each.sessionId === sessionId);

    it('keeps its crew apart from the user\'s, and hands it to an orchestrator that may then remove it', async () => {
      const setup = await orchestrateDaemon();
      const gone = await agentSide(setup, setup.zone.id);
      const taker = await agentSide(setup, setup.zone.id);
      const left = await gone.connection.call('orchestrator.spawn', { token: gone.token, name: 'left' });
      const mine = await userAgent(setup.client, setup.zone.id, 'mine');
      await setup.client.call('agent.delete', { sessionId: gone.agent.sessionId, force: true });

      expect(await listed(setup, left.sessionId)).toMatchObject({ spawnedBy: null, orphanedFrom: { sessionId: gone.agent.sessionId, name: gone.agent.name } });
      expect(await listed(setup, mine.sessionId)).toMatchObject({ spawnedBy: null, orphanedFrom: null });
      await expect(taker.connection.call('orchestrator.close', { token: taker.token, sessionId: left.sessionId, remove: true })).rejects.toMatchObject({
        code: BOARD_ERROR.outOfScope,
        message: expect.stringContaining('was not started by you'),
      });

      // By the ref it had, as `orchestrate handover` names it.
      const mcp = mcpAs(setup, taker.token);
      expect(await mcp.callTool('handover', { from: refTo(gone.agent), to: refTo(taker.agent) })).toMatchObject({
        isError: false,
        text: expect.stringContaining('left, and 0 things on the board.'),
      });
      expect(await listed(setup, left.sessionId)).toMatchObject({ spawnedBy: taker.agent.sessionId, orphanedFrom: null });

      await taker.connection.call('orchestrator.close', { token: taker.token, sessionId: left.sessionId, remove: true });
      expect(await listed(setup, left.sessionId)).toBeUndefined();
      // The user's own agent stays out of its reach.
      await expect(taker.connection.call('orchestrator.close', { token: taker.token, sessionId: mine.sessionId, remove: true })).rejects.toMatchObject({
        code: BOARD_ERROR.outOfScope,
        message: expect.stringContaining('started by hand'),
      });
      // Nothing of it is left to hand over.
      await expect(taker.connection.call('orchestrator.handover', { token: taker.token, from: gone.agent.sessionId, to: taker.agent.sessionId })).rejects.toMatchObject({
        code: RPC_ERROR.invalidParams,
        message: expect.stringContaining('no removed orchestrator'),
      });
    });

    it('refuses the crew of a live orchestrator, and a crew it neither leads nor takes itself', async () => {
      const setup = await orchestrateDaemon();
      const live = await agentSide(setup, setup.zone.id);
      const boss = await agentSide(setup, setup.zone.id);
      const taker = await agentSide(setup, setup.zone.id);
      const bystander = await agentSide(setup, setup.other.id);
      const theirs = await live.connection.call('orchestrator.spawn', { token: live.token, name: 'theirs' });
      const near = await boss.connection.call('orchestrator.spawn', { token: boss.token, name: 'near' });
      await setup.client.call('agent.delete', { sessionId: boss.agent.sessionId, force: true });

      await expect(taker.connection.call('orchestrator.handover', { token: taker.token, from: live.agent.sessionId, to: taker.agent.sessionId })).rejects.toMatchObject({
        code: BOARD_ERROR.outOfScope,
        message: expect.stringContaining('is still running'),
      });
      await expect(taker.connection.call('orchestrator.close', { token: taker.token, sessionId: theirs.sessionId, remove: true })).rejects.toMatchObject({
        code: BOARD_ERROR.outOfScope,
        message: expect.stringContaining('was not started by you'),
      });
      // A removed one's crew goes only to the agent that takes it itself.
      await expect(bystander.connection.call('orchestrator.handover', { token: bystander.token, from: boss.agent.sessionId, to: taker.agent.sessionId })).rejects.toMatchObject({
        code: BOARD_ERROR.outOfScope,
        message: expect.stringContaining('an agent hands over only its own crew'),
      });
      expect(await listed(setup, near.sessionId)).toMatchObject({ spawnedBy: null, orphanedFrom: { sessionId: boss.agent.sessionId } });

      // The user's side may hand it over all the same.
      const handed = await setup.client.call('orchestrator.handover', { from: boss.agent.sessionId, to: taker.agent.sessionId });
      expect(handed.crew.map((agent) => agent.name)).toEqual(['near']);
    });

    it('hands its crew to an orchestrator in another zone, as to any other', async () => {
      const setup = await orchestrateDaemon();
      const gone = await agentSide(setup, setup.zone.id);
      const taker = await agentSide(setup, setup.other.id);
      const left = await gone.connection.call('orchestrator.spawn', { token: gone.token, name: 'left' });
      await setup.client.call('agent.delete', { sessionId: gone.agent.sessionId, force: true });

      const handed = await taker.connection.call('orchestrator.handover', { token: taker.token, from: gone.agent.sessionId, to: taker.agent.sessionId });
      expect(handed.crew.map((agent) => agent.name)).toEqual(['left']);
      expect(await listed(setup, left.sessionId)).toMatchObject({ spawnedBy: taker.agent.sessionId, orphanedFrom: null });
    });

    it('asks for its whole id when a tile on the board shares the name it is named by', async () => {
      const setup = await orchestrateDaemon();
      const gone = await agentSide(setup, setup.zone.id);
      const taker = await agentSide(setup, setup.zone.id);
      const left = await gone.connection.call('orchestrator.spawn', { token: gone.token, name: 'left' });
      await setup.client.call('agent.delete', { sessionId: gone.agent.sessionId, force: true });
      await userAgent(setup.client, setup.zone.id, gone.agent.name);

      const mcp = mcpAs(setup, taker.token);
      expect(await mcp.callTool('handover', { from: gone.agent.name, to: refTo(taker.agent) })).toMatchObject({
        isError: true,
        text: expect.stringMatching(/could be any of \d things[\s\S]*\(removed orchestrator\)/),
      });
      expect(await listed(setup, left.sessionId)).toMatchObject({ spawnedBy: null, orphanedFrom: { sessionId: gone.agent.sessionId } });

      expect(await mcp.callTool('handover', { from: gone.agent.sessionId, to: refTo(taker.agent) })).toMatchObject({ isError: false });
      expect(await listed(setup, left.sessionId)).toMatchObject({ spawnedBy: taker.agent.sessionId, orphanedFrom: null });
    });
  });
});

describe('edges an orchestrator makes', () => {
  it('joins agents another agent started, or itself, marked as made by it and logged; the user can delete one like any other', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id);
    const starter = await agentSide(setup, setup.zone.id);
    const impl = await crewAgent(setup, { zoneId: setup.zone.id, name: 'impl' }, starter);
    const review = await crewAgent(setup, { zoneId: setup.zone.id, name: 'review' }, starter);

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

  it('refuses an end the user started by hand, either way, and logs it', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id);
    const mine = await userAgent(setup.client, setup.zone.id, 'mine');
    const starter = await agentSide(setup, setup.other.id);
    const near = await crewAgent(setup, { zoneId: setup.zone.id, name: 'near' }, starter);
    const far = await crewAgent(setup, { zoneId: setup.other.id, name: 'far' }, starter);

    for (const [from, to] of [
      [mine.sessionId, near.sessionId],
      [near.sessionId, mine.sessionId],
    ] as const) {
      await expect(connection.call('orchestrator.addEdge', { token, from, to })).rejects.toMatchObject({
        code: BOARD_ERROR.outOfScope,
        message: expect.stringMatching(/started by hand/),
      });
    }
    // Agents another agent started, in any zone, and itself, it may join.
    await connection.call('orchestrator.addEdge', { token, from: near.sessionId, to: far.sessionId });
    await connection.call('orchestrator.addEdge', { token, from: far.sessionId, to: me.sessionId });

    const log = await setup.client.call('orchestrator.activity', { orchestratorId: me.sessionId });
    expect(log.map(({ outcome }) => outcome)).toEqual(['done', 'done', 'refused', 'refused']);
  });

  it('never approves a gate or script it puts on an edge, nor sends, drops or changes an edge', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
    const starter = await agentSide(setup, setup.zone.id);
    const impl = await crewAgent(setup, { zoneId: setup.zone.id, name: 'impl' }, starter);
    const review = await crewAgent(setup, { zoneId: setup.zone.id, name: 'review' }, starter);

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
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id);
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
    const { token, connection } = await agentSide(setup, setup.zone.id);
    const other = await agentSide(setup, setup.zone.id);
    const impl = await crewAgent(setup, { zoneId: setup.zone.id, name: 'impl' }, other);
    const review = await crewAgent(setup, { zoneId: setup.zone.id, name: 'review' }, other);
    const users = await setup.client.call('flowEdge.create', { from: impl.sessionId, to: review.sessionId });
    const others = await other.connection.call('orchestrator.addEdge', { token: other.token, from: review.sessionId, to: impl.sessionId, trigger: 'manual' });

    for (const id of [users.id, others.id]) {
      await expect(connection.call('orchestrator.removeEdge', { token, id })).rejects.toMatchObject({
        code: BOARD_ERROR.outOfScope,
        message: expect.stringMatching(/only edges its crew made/),
      });
    }
    expect(await setup.client.call('flowEdge.list')).toHaveLength(2);

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

  it('is refused an agent whose session has ended', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id);
    const impl = await connection.call('orchestrator.spawn', { token, name: 'impl' });
    const review = await connection.call('orchestrator.spawn', { token, name: 'review' });
    await setup.client.call('agent.stop', { sessionId: me.sessionId });
    await untilAgent(setup.recorder, me.sessionId, (seen) => seen.endedAt !== null);
    await expect(connection.call('orchestrator.addEdge', { token, from: impl.sessionId, to: review.sessionId })).rejects.toMatchObject({
      code: BOARD_ERROR.notAllowed,
    });
    expect(await setup.client.call('flowEdge.list')).toEqual([]);
  });
});

describe('a reviewer an orchestrator starts', () => {
  it('works on a detached checkout of its implementer’s branch, `new` says so, and a follow-up can be based on it', async () => {
    const setup = await orchestrateDaemon();
    const { token } = await agentSide(setup, setup.zone.id);
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

describe('a reviewer started from a branch an agent owns', () => {
  const pair = (edges: { from: string; to: string; trigger: string; madeBy: string | null }[], a: string, b: string) =>
    edges.filter((edge) => [a, b].includes(edge.from) && [a, b].includes(edge.to));

  it('is joined to nothing by default: it and its implementer talk through send, so no Send button appears', async () => {
    const setup = await orchestrateDaemon();
    const { token } = await agentSide(setup, setup.zone.id);
    const implementer = await userAgent(setup.client, setup.zone.id, 'impl');
    const session = await openBoardSession({ [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: token });
    try {
      await newAgent(session, { prompt: 'Review it', name: 'review', role: 'reviewer', base: implementer.branch });
      await newAgent(session, { prompt: 'Check the fixes', name: 'recheck', role: 'follow-up-reviewer', base: 'agent:review' });
      expect(await setup.client.call('flowEdge.list')).toEqual([]);
    } finally {
      session.close();
    }
  });

  it('with --edges manual, is joined to that agent both ways by manual edges, named by its branch or as agent:<ref>, and never to the orchestrator', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token } = await agentSide(setup, setup.zone.id);
    const implementer = await crewAgent(setup, { zoneId: setup.zone.id, name: 'impl' });
    const session = await openBoardSession({ [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: token });
    try {
      const byBranch = await newAgent(session, { prompt: 'Review it', name: 'review', role: 'reviewer', base: implementer.branch, edges: 'manual' });
      const reviewer = (byBranch.json as { id: string }).id;
      let edges = await setup.client.call('flowEdge.list');
      expect(pair(edges, implementer.sessionId, reviewer).map(({ from, to, trigger }) => `${from === reviewer ? 'reviewer' : 'impl'}->${to === reviewer ? 'reviewer' : 'impl'} ${trigger}`).sort()).toEqual([
        'impl->reviewer manual',
        'reviewer->impl manual',
      ]);
      expect(edges.every((edge) => edge.madeBy === me.sessionId)).toBe(true);
      expect(edges.some((edge) => edge.from === me.sessionId || edge.to === me.sessionId)).toBe(false);

      // Named as `agent:<ref>`, the same; a follow-up reviewer is joined to the implementer too, one edge each way.
      const followUp = await newAgent(session, { prompt: 'Check the fixes', name: 'recheck', role: 'follow-up-reviewer', base: 'agent:review', edges: 'manual' });
      edges = await setup.client.call('flowEdge.list');
      expect(pair(edges, implementer.sessionId, (followUp.json as { id: string }).id)).toHaveLength(2);
      expect(edges).toHaveLength(4);
    } finally {
      session.close();
    }
  });

  it('with --edges auto, hands its findings back by itself and leaves the way back manual', async () => {
    const setup = await orchestrateDaemon();
    const { token } = await agentSide(setup, setup.zone.id);
    const implementer = await crewAgent(setup, { zoneId: setup.zone.id, name: 'impl' });
    const session = await openBoardSession({ [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: token });
    try {
      const started = await newAgent(session, { prompt: 'Review it', name: 'review', role: 'reviewer', base: implementer.branch, edges: 'auto' });
      const reviewer = (started.json as { id: string }).id;
      const edges = await setup.client.call('flowEdge.list');
      expect(edges.map(({ from, to, trigger }) => `${from === reviewer ? 'reviewer' : 'impl'}->${to === reviewer ? 'reviewer' : 'impl'} ${trigger}`).sort()).toEqual([
        'impl->reviewer manual',
        'reviewer->impl auto',
      ]);
    } finally {
      session.close();
    }
  });

  it('goes with the reviewer when it is removed, leaving the implementer and its other edges', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
    const implementer = await crewAgent(setup, { zoneId: setup.zone.id, name: 'impl' });
    const session = await openBoardSession({ [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: token });
    try {
      const started = await newAgent(session, { prompt: 'Review it', name: 'review', role: 'reviewer', base: implementer.branch, edges: 'manual' });
      expect(await setup.client.call('flowEdge.list')).toHaveLength(2);
      await connection.call('orchestrator.close', { token, sessionId: (started.json as { id: string }).id, remove: true });
      expect(await setup.client.call('flowEdge.list')).toEqual([]);
      expect((await setup.client.call('agent.list')).some((each) => each.sessionId === implementer.sessionId)).toBe(true);
    } finally {
      session.close();
    }
  });

  it('is left unlinked when no agent owns the branch', async () => {
    const setup = await orchestrateDaemon();
    const { token } = await agentSide(setup, setup.zone.id);
    const session = await openBoardSession({ [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: token });
    try {
      // The repo's own checked-out branch belongs to no agent.
      const loose = await newAgent(session, { prompt: 'Review the checkout', name: 'loose', role: 'reviewer' });
      expect(loose.json).toMatchObject({ reviews: { branch: expect.any(String) } });
      expect(await setup.client.call('flowEdge.list')).toEqual([]);
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
    const { token } = await agentSide(setup, setup.zone.id);
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
    const lead = await agentSide(setup, setup.zone.id);
    const mcp = mcpAs(setup, lead.token);

    const templated = await mcp.callTool('new_agent', { prompt: 'Do it', name: 'templated', role: 'implementer' });
    expect(templated).toMatchObject({ isError: false, text: expect.stringContaining("begins with the zone's saved implementer template") });
    const bare = await mcp.callTool('new_agent', { prompt: 'Only this', name: 'bare', role: 'implementer', template: false });
    expect(bare).toMatchObject({ isError: false, text: expect.stringContaining('No role template') });
    const agent = (await setup.client.call('agent.list')).find((each) => each.name === 'bare')!;
    expect(await firstMessage(setup, agent.sessionId)).toBe('Only this');
  });
});

describe('an agent an orchestrator starts with a prompt', () => {
  it('is starting, never idle, until its first turn begins, in `new`, `tree` and the agent', async () => {
    const setup = await orchestrateDaemon();
    const { token } = await agentSide(setup, setup.zone.id);
    const session = await openBoardSession({ [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: token });
    try {
      const started = await newAgent(session, { prompt: 'Print your board identity', name: 'fresh' });

      expect(started.text).toMatch(/^Started agent:\S+ {2}fresh {2}\[starting\]/);
      expect(started.text).not.toContain('[idle]');
      const refs = new BoardRefs(await readBoard(setup.client));
      expect(refs.board.agents.find((agent) => agent.name === 'fresh')!.state).toBe('starting');
      expect(treeView(refs, null).text).toMatch(/fresh {2}\[starting\]/);
    } finally {
      session.close();
    }
  });
});

describe('an agent still starting', () => {
  it("is not a settled state, so a default wait on an agent another agent started doesn't return for it", async () => {
    expect(SETTLED_STATES).not.toContain('starting');
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
    const started = await crewAgent(setup, { zoneId: setup.zone.id, name: 'theirs', prompt: 'Write the handover' });
    expect(started.state).toBe('starting');

    const waited = await connection.call('orchestrator.wait', { token, sessionIds: [started.sessionId] });
    expect(waited.timedOut).toBe(false);
    expect(waited.agents[0]!.state).not.toBe('starting');
  });

  it('queues a message until its session is up, typing it after its first prompt', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id);
    const worker = await connection.call('orchestrator.spawn', { token, name: 'eager', prompt: 'Write the handover' });
    expect(worker.state).toBe('starting');

    await setup.client.call('session.attach', { sessionId: worker.sessionId });
    const sent = await connection.call('orchestrator.send', { token, sessionId: worker.sessionId, text: 'Carry on' });
    expect(sent.queuedUntilUp).toBe(1);
    await setup.recorder.waitForText(worker.sessionId, `> ${sentBy(me, 'Carry on')}`);
    const screen = setup.recorder.screenText(worker.sessionId);
    expect(screen.indexOf('Write the handover')).toBeLessThan(screen.indexOf(`> ${sentBy(me, 'Carry on')}`));
  });
});

describe('an agent an orchestrator starts in a named role', () => {
  it('carries the name, which `new`, `tree` and its own `whoami` show', async () => {
    const setup = await orchestrateDaemon();
    const { token } = await agentSide(setup, setup.zone.id);
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
    const { token } = await agentSide(setup, setup.zone.id);
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

describe('reviewedAgent', () => {
  const agent = (fields: Partial<Agent>) => ({ sessionId: 'x', repoRoot: '/repo', branch: 'b', reviews: null, reviewOf: null, ...fields }) as Agent;
  const reviewer = agent({ sessionId: 'r', branch: '', reviews: { branch: 'b', head: 'abc' } });

  it('is the one agent in the same repo on the branch', () => {
    const owner = agent({ sessionId: 'owner' });
    expect(reviewedAgent([owner, reviewer, agent({ sessionId: 'other', branch: 'c' })], reviewer)).toBe(owner);
  });

  it('ignores a branch of that name in another repo, and another reviewer', () => {
    const owner = agent({ sessionId: 'owner' });
    const elsewhere = agent({ sessionId: 'elsewhere', repoRoot: '/other' });
    const earlier = agent({ sessionId: 'earlier', branch: 'b', reviews: { branch: 'b', head: 'abc' } });
    expect(reviewedAgent([elsewhere, earlier, reviewer], reviewer)).toBeUndefined();
    expect(reviewedAgent([elsewhere, owner, reviewer], reviewer)).toBe(owner);
  });

  it('is none when several agents own the branch, or when it reviews nothing', () => {
    expect(reviewedAgent([agent({ sessionId: 'a' }), agent({ sessionId: 'b' }), reviewer], reviewer)).toBeUndefined();
    expect(reviewedAgent([agent({ sessionId: 'a' })], agent({ sessionId: 'plain' }))).toBeUndefined();
  });
});

describe('an orchestrator setting its crew’s status lines', () => {
  it('sets the line of an agent it started, says who set it, and the latest write wins', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const worker = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'worker', prompt: 'Print your board identity' });

    const set = await lead.connection.call('orchestrator.setStatus', { token: lead.token, sessionId: worker.sessionId, summary: 'Retry fix in' });
    expect(set.status).toMatchObject({ summary: 'Retry fix in', setBy: lead.agent.name });
    expect((await setup.client.call('agent.list')).find((agent) => agent.sessionId === worker.sessionId)!.status).toMatchObject({ setBy: lead.agent.name });

    // The agent's own line replaces it, and is its own again.
    const workerSide = await agentSideOf(setup, worker.sessionId);
    const own = await workerSide.connection.call('board.setStatus', { token: workerSide.token, summary: 'Writing the test' });
    expect(own.status).toMatchObject({ summary: 'Writing the test', setBy: null });

    const again = await lead.connection.call('orchestrator.setStatus', { token: lead.token, sessionId: worker.sessionId, summary: 'In review' });
    expect(again.status).toMatchObject({ summary: 'In review', progress: null, setBy: lead.agent.name });

    const log = await setup.client.call('orchestrator.activity', { orchestratorId: lead.agent.sessionId });
    expect(log.map(({ action, outcome }) => `${action} ${outcome}`)).toEqual(['set-status done', 'set-status done', 'spawn done']);
  });

  it('sets the line of an agent its crew started, which is in its crew too', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const worker = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'worker', prompt: 'Print your board identity' });
    const sub = await agentSideOf(setup, worker.sessionId);
    const helper = await sub.connection.call('orchestrator.spawn', { token: sub.token, name: 'helper' });
    expect(helper.spawnedBy).toBe(worker.sessionId);

    expect(await lead.connection.call('orchestrator.setStatus', { token: lead.token, sessionId: helper.sessionId, summary: 'Helping' })).toMatchObject({
      status: { summary: 'Helping', setBy: lead.agent.name },
    });
  });

  it('refuses an agent outside its crew, itself, and one the user started by hand', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    // In its zone, and one it may steer, but another agent started it: not its crew.
    const outsider = await crewAgent(setup, { zoneId: setup.zone.id, name: 'outsider' });
    const mine = await userAgent(setup.client, setup.zone.id, 'mine');

    await expect(lead.connection.call('orchestrator.setStatus', { token: lead.token, sessionId: outsider.sessionId, summary: 'Mine now' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/not in your crew/),
    });
    await expect(lead.connection.call('orchestrator.setStatus', { token: lead.token, sessionId: lead.agent.sessionId, summary: 'Me' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    await expect(lead.connection.call('orchestrator.setStatus', { token: lead.token, sessionId: mine.sessionId, summary: 'No' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/started by hand/),
    });
    for (const each of [outsider, mine]) expect((await setup.client.call('agent.list')).find((agent) => agent.sessionId === each.sessionId)!.status).toBeNull();

    const log = await setup.client.call('orchestrator.activity', { orchestratorId: lead.agent.sessionId });
    expect(log.map(({ action, outcome }) => `${action} ${outcome}`)).toEqual(['set-status refused', 'set-status refused', 'set-status refused']);
  });

  it('records no orchestrator when the user’s side sets the line', async () => {
    const setup = await orchestrateDaemon();
    const worker = await userAgent(setup.client, setup.zone.id, 'worker');

    const set = await setup.client.call('orchestrator.setStatus', { sessionId: worker.sessionId, summary: 'Set by hand' });
    expect(set.status).toMatchObject({ summary: 'Set by hand', setBy: null });
  });

  it('is `status set --agent` over the CLI and `set_status` with agent over the MCP, refusing outside the crew', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const worker = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'worker' });
    const outsider = await crewAgent(setup, { zoneId: setup.zone.id, name: 'outsider' });
    const ref = (agent: Agent) => `agent:${agent.sessionId.slice(0, 4)}`;
    const env = { [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: lead.token };
    const run = async (args: string[]) => {
      let out = '';
      const code = await runBoardCommand('status', args, { out: (text) => (out += text), err: (text) => (out += text), env });
      return { code, out };
    };

    expect(await run(['set', 'Wiring it', '--agent', ref(worker), '--progress', '30'])).toEqual({ code: 0, out: expect.stringMatching(/^Set the status of agent:/) });
    expect((await setup.client.call('agent.list')).find((agent) => agent.sessionId === worker.sessionId)!.status).toMatchObject({
      summary: 'Wiring it',
      setBy: lead.agent.name,
    });
    expect(await run(['set', 'Nope', '--agent', ref(outsider)])).toEqual({ code: 1, out: expect.stringMatching(/not in your crew/) });
    expect(await run(['set', 'Done', '--agent', ref(worker), '--done'])).toEqual({ code: 2, out: expect.stringMatching(/--done is for your own status/) });

    const mcp = mcpAs(setup, lead.token);
    expect(await mcp.callTool('set_status', { summary: 'From the MCP', agent: ref(worker) })).toMatchObject({ isError: false, text: expect.stringMatching(/^Set the status of agent:/) });
    expect(await mcp.callTool('set_status', { summary: 'Not yours', agent: ref(outsider) })).toMatchObject({ isError: true, text: expect.stringMatching(/not in your crew/) });
    expect((await setup.client.call('agent.list')).find((agent) => agent.sessionId === outsider.sessionId)!.status).toBeNull();
  });
});

describe('agents setting their characters’ poses', () => {
  const AT_WORK: readonly string[] = ['running', 'thinking'];
  const listed = async (setup: Setup, sessionId: string) => (await setup.client.call('agent.list')).find((agent) => agent.sessionId === sessionId)!;

  /** The first update of the agent after the event at `since`, that matches. */
  const updateAfter = (setup: Setup, since: number, sessionId: string, match: (agent: Agent) => boolean = () => true) =>
    setup.recorder
      .waitFor(
        (e: DaemonEvent): e is AgentUpdatedEvent =>
          e.type === 'agent.updated' && e.agent.sessionId === sessionId && setup.recorder.events.indexOf(e) >= since && match(e.agent),
      )
      .then((event) => event.agent);

  /** The index of the agent's own hook `event` seen after `since`, once it comes. */
  const hookAfter = async (setup: Setup, since: number, sessionId: string, event: string) => {
    const hook = await setup.recorder.waitFor(
      (e: DaemonEvent): e is HookEvent => e.type === 'hook' && e.sessionId === sessionId && e.event === event && setup.recorder.events.indexOf(e) >= since,
    );
    return setup.recorder.events.indexOf(hook);
  };

  /** An agent from `agentSide`, once its first turn has ended: that turn's end would take a working pose off. */
  const settled = async (setup: Setup) => {
    const side = await agentSide(setup, setup.zone.id);
    await hookAfter(setup, 0, side.agent.sessionId, 'Stop');
    return side;
  };

  it('sets its own pose with a line or without, keeps each when the other is set, and takes it off with none', async () => {
    const setup = await orchestrateDaemon();
    const { agent, token, connection } = await settled(setup);

    const since = setup.recorder.events.length;
    const posed = await connection.call('board.setStatus', { token, character: { pose: 'testing', prop: 'flask' } });
    expect(posed).toMatchObject({ status: null, character: { pose: 'testing', face: null, prop: 'flask', setBy: null } });
    expect(await updateAfter(setup, since, agent.sessionId)).toMatchObject({ character: { pose: 'testing' } });

    // A line alone leaves the pose, and a pose alone the line.
    expect(await connection.call('board.setStatus', { token, summary: 'Running the suite' })).toMatchObject({
      status: { summary: 'Running the suite' },
      character: { pose: 'testing', prop: 'flask' },
    });
    expect(await connection.call('board.setStatus', { token, character: { pose: 'reading', face: 'focused' } })).toMatchObject({
      status: { summary: 'Running the suite' },
      character: { pose: 'reading', face: 'focused', prop: null },
    });
    expect(await connection.call('board.setStatus', { token, character: { pose: 'none' } })).toMatchObject({ status: { summary: 'Running the suite' }, character: null });
    expect((await listed(setup, agent.sessionId)).character).toBeNull();
  });

  it('refuses a word outside the lists by naming them, a set of nothing, and progress with no line', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);

    await expect(connection.call('board.setStatus', { token, character: { pose: 'dancing' } } as never)).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/unknown pose 'dancing'; poses: thinking, running-a-tool, reading, writing, testing, waiting-on-review, none/),
    });
    await expect(connection.call('board.setStatus', { token, character: { pose: 'testing', prop: 'hammer' } } as never)).rejects.toMatchObject({
      message: expect.stringMatching(/unknown prop 'hammer'; props: dots/),
    });
    await expect(connection.call('board.setStatus', { token })).rejects.toMatchObject({ message: expect.stringMatching(/a status summary, a character pose, a category, a description, or more/) });
    await expect(connection.call('board.setStatus', { token, progress: 40, character: { pose: 'testing' } })).rejects.toMatchObject({
      message: expect.stringMatching(/progress goes with a status summary/),
    });
  });

  it("keeps a working pose through its turn's start and takes it off at its end; keeps a resting one to its next turn's start", async () => {
    const setup = await orchestrateDaemon({ repeat: true });
    const { agent, token, connection } = await settled(setup);
    await connection.call('board.setStatus', { token, character: { pose: 'testing' } });

    let since = setup.recorder.events.length;
    await setup.client.call('session.write', { sessionId: agent.sessionId, data: 'Ask permission\r' });
    const asking = await updateAfter(setup, since, agent.sessionId, (seen) => seen.permissions.length > 0);
    // The board draws its ask over the pose, which waits under it.
    expect(asking.character).toMatchObject({ pose: 'testing' });

    // Its work put up for review as its turn ends: the turn's end leaves it.
    await connection.call('board.setStatus', { token, character: { pose: 'waiting-on-review' } });
    since = setup.recorder.events.length;
    await setup.client.call('agent.decidePermission', { sessionId: agent.sessionId, requestId: asking.permissions[0]!.id, behavior: 'allow' });
    await updateAfter(setup, await hookAfter(setup, since, agent.sessionId, 'Stop'), agent.sessionId);
    expect((await listed(setup, agent.sessionId)).character).toMatchObject({ pose: 'waiting-on-review' });

    // Its next turn's start takes it off.
    since = setup.recorder.events.length;
    await setup.client.call('session.write', { sessionId: agent.sessionId, data: 'Print your board identity\r' });
    expect(await updateAfter(setup, await hookAfter(setup, since, agent.sessionId, 'UserPromptSubmit'), agent.sessionId)).toMatchObject({ character: null });

    // A working pose its turn ends.
    await connection.call('board.setStatus', { token, character: { pose: 'writing' } });
    since = setup.recorder.events.length;
    await setup.client.call('session.write', { sessionId: agent.sessionId, data: 'Print your board identity\r' });
    await hookAfter(setup, since, agent.sessionId, 'Stop');
    expect(await updateAfter(setup, since, agent.sessionId, (seen) => seen.character === null)).toMatchObject({ character: null });

    // Its session's end takes a resting pose off too.
    await connection.call('board.setStatus', { token, character: { pose: 'waiting-on-review' } });
    await setup.client.call('agent.stop', { sessionId: agent.sessionId });
    expect(await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.endedAt !== null)).toMatchObject({ character: null });
  });

  it('takes a working pose off a turn the app interrupts, which sends no hook, and leaves a resting one', async () => {
    const setup = await orchestrateDaemon({ repeat: true });
    const { agent, token, connection } = await settled(setup);

    for (const [pose, left] of [
      ['testing', null],
      ['waiting-on-review', { pose: 'waiting-on-review' }],
    ] as const) {
      const since = setup.recorder.events.length;
      await setup.client.call('session.write', { sessionId: agent.sessionId, data: 'Ask permission\r' });
      await updateAfter(setup, since, agent.sessionId, (seen) => seen.permissions.length > 0);
      expect(await connection.call('board.setStatus', { token, character: { pose } })).toMatchObject({ state: 'needs-permission', character: { pose } });

      const interrupted = await setup.client.call('agent.interrupt', { sessionId: agent.sessionId });
      expect(interrupted.state).toBe('idle');
      expect(interrupted.character).toEqual(left === null ? null : expect.objectContaining(left));
      expect((await listed(setup, agent.sessionId)).character).toEqual(interrupted.character);
    }
  });

  it('takes a working pose off a turn whose Stop never came, as it is moved to idle', async () => {
    const clock = createFakeClock(new Date());
    // No idle prompt either: every hook after a turn's work is lost, its first turn's and the next's.
    const setup = await orchestrateDaemon({ clock, repeat: true, fakes: { loseStopHooks: 2, promptBox: true, idleNotifyMs: 600_000 } });
    const { agent, token, connection } = await agentSide(setup, setup.zone.id);
    // A turn that ends on words, as the net reads a turn's end in its transcript.
    await setup.client.call('session.write', { sessionId: agent.sessionId, data: 'Ask back: All done?\r' });
    await setup.recorder.waitForText(agent.sessionId, 'All done?');
    expect(await connection.call('board.setStatus', { token, character: { pose: 'testing' } })).toMatchObject({ character: { pose: 'testing' } });
    expect(AT_WORK).toContain((await listed(setup, agent.sessionId)).state);

    // The net moves it once its transcript says its turn ended and its screen shows its prompt.
    const start = await setup.recorder.waitFor((e: DaemonEvent): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'SessionStart');
    await vi.waitFor(async () => expect(turnEndedInTranscript(await readTranscriptTail(String(start.payload.transcript_path)))).toBe(true), { timeout: 10_000 });
    await vi.waitFor(() => expect(setup.recorder.screenText(agent.sessionId)).toContain('❯'));
    const since = setup.recorder.events.length;
    clock.advance(QUIET_TURN_MS);
    expect(await updateAfter(setup, since, agent.sessionId, (seen) => seen.state === 'idle')).toMatchObject({ character: null });
  });

  it('takes a working pose off a turn whose Stop never came as its idle prompt comes, so the next turn is drawn without it', async () => {
    // Its idle prompt still comes, soon after each turn's work: it finds the agent at work and leaves it waiting.
    const setup = await orchestrateDaemon({ repeat: true, fakes: { loseStopHooks: 2 } });
    const { agent, token, connection } = await agentSide(setup, setup.zone.id);
    await updateAfter(setup, 0, agent.sessionId, (seen) => seen.state === 'waiting');

    let since = setup.recorder.events.length;
    await setup.client.call('session.write', { sessionId: agent.sessionId, data: 'Work slowly\r' });
    await updateAfter(setup, since, agent.sessionId, (seen) => AT_WORK.includes(seen.state));
    expect(await connection.call('board.setStatus', { token, character: { pose: 'testing' } })).toMatchObject({ character: { pose: 'testing' } });
    expect(await updateAfter(setup, since, agent.sessionId, (seen) => seen.state === 'waiting')).toMatchObject({ character: null });
    expect(setup.recorder.events.some((e) => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'Stop')).toBe(false);

    since = setup.recorder.events.length;
    await setup.client.call('session.write', { sessionId: agent.sessionId, data: 'Print your board identity\r' });
    expect(await updateAfter(setup, since, agent.sessionId, (seen) => AT_WORK.includes(seen.state))).toMatchObject({ character: null });
  });

  it('takes a resting pose off as a turn starts with no UserPromptSubmit, at its first sign of work', async () => {
    // Its first prompt is typed at it too, and loses its hook as the next does.
    const setup = await orchestrateDaemon({ repeat: true, fakes: { losePromptHooks: 2 } });
    const { agent, token, connection } = await settled(setup);
    await connection.call('board.setStatus', { token, character: { pose: 'waiting-on-review' } });

    const since = setup.recorder.events.length;
    await setup.client.call('session.write', { sessionId: agent.sessionId, data: 'Work slowly\r' });
    expect(await updateAfter(setup, since, agent.sessionId, (seen) => AT_WORK.includes(seen.state))).toMatchObject({ character: null });
    expect(setup.recorder.events.some((e) => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'UserPromptSubmit')).toBe(false);
  });

  it('takes a working pose off on a Codex turn’s end too', async () => {
    const setup = await orchestrateDaemon({ repeat: true });
    const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, harness: 'codex', prompt: 'Print your board identity', ...SIZE });
    const { token, connection } = await agentSideOf(setup, agent.sessionId);
    await connection.call('board.setStatus', { token, character: { pose: 'thinking', face: 'puzzled' } });

    const since = setup.recorder.events.length;
    await setup.client.call('session.write', { sessionId: agent.sessionId, data: 'Print your board identity\r' });
    await hookAfter(setup, since, agent.sessionId, 'Stop');
    expect(await updateAfter(setup, since, agent.sessionId, (seen) => seen.character === null)).toMatchObject({ character: null });
  });

  it('lapses a working pose 20 minutes after its last set, redrawing its tile, and keeps a resting one', async () => {
    const clock = createFakeClock(new Date());
    const setup = await orchestrateDaemon({ clock });
    const { agent, token, connection } = await settled(setup);

    await connection.call('board.setStatus', { token, character: { pose: 'running-a-tool' } });
    clock.advance(CHARACTER_EXPIRY_MS / 2);
    // A new set starts its 20 minutes again.
    await connection.call('board.setStatus', { token, character: { pose: 'running-a-tool', prop: 'gear' } });
    clock.advance(CHARACTER_EXPIRY_MS / 2);
    expect((await listed(setup, agent.sessionId)).character).toMatchObject({ pose: 'running-a-tool', prop: 'gear' });
    const since = setup.recorder.events.length;
    clock.advance(CHARACTER_EXPIRY_MS / 2);
    expect(await updateAfter(setup, since, agent.sessionId)).toMatchObject({ character: null });

    await connection.call('board.setStatus', { token, character: { pose: 'waiting-on-review' } });
    clock.advance(2 * CHARACTER_EXPIRY_MS);
    expect((await listed(setup, agent.sessionId)).character).toMatchObject({ pose: 'waiting-on-review' });
  });

  it('sets the pose of an agent in its crew, saying who set it, and refuses one outside it', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const worker = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'worker', prompt: 'Print your board identity' });
    const outsider = await userAgent(setup.client, setup.zone.id, 'outsider');

    expect(await lead.connection.call('orchestrator.setStatus', { token: lead.token, sessionId: worker.sessionId, character: { pose: 'waiting-on-review' } })).toMatchObject({
      status: null,
      character: { pose: 'waiting-on-review', setBy: lead.agent.name },
    });
    await expect(lead.connection.call('orchestrator.setStatus', { token: lead.token, sessionId: outsider.sessionId, character: { pose: 'testing' } })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    await expect(lead.connection.call('orchestrator.setStatus', { token: lead.token, sessionId: worker.sessionId, character: { pose: 'sulking' } } as never)).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/unknown pose 'sulking'/),
    });
    expect((await listed(setup, outsider.sessionId)).character).toBeNull();

    // The agent's own set replaces it, and is its own.
    const workerSide = await agentSideOf(setup, worker.sessionId);
    expect(await workerSide.connection.call('board.setStatus', { token: workerSide.token, character: { pose: 'writing' } })).toMatchObject({
      character: { pose: 'writing', setBy: null },
    });
  });

  it('is `status set --pose` and `status poses` over the CLI, `set_status` with character over the MCP, and in identify', async () => {
    const setup = await orchestrateDaemon({ repeat: true });
    const lead = await agentSide(setup, setup.zone.id);
    const worker = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'worker' });
    // In a turn, as an agent that runs its CLI is: the board draws a working pose only then.
    const since = setup.recorder.events.length;
    await setup.client.call('session.write', { sessionId: lead.agent.sessionId, data: 'Work until interrupted\r' });
    await updateAfter(setup, since, lead.agent.sessionId, (seen) => AT_WORK.includes(seen.state));
    await setup.recorder.waitForText(lead.agent.sessionId, 'Working until interrupted.');
    const env = { [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: lead.token };
    const run = async (command: string, args: string[]) => {
      let out = '';
      const code = await runBoardCommand(command, args, { out: (text) => (out += text), err: (text) => (out += text), env });
      return { code, out };
    };

    expect(await run('status', ['poses'])).toEqual({ code: 0, out: expect.stringMatching(/^poses: thinking, running-a-tool, .*, none\nfaces: .*\nprops: /) });
    expect(await run('status', ['set', '--pose', 'testing', '--prop', 'flask'])).toEqual({
      code: 0,
      out: expect.stringMatching(/^Your character: testing, yours; it goes at turn end, or 20 minutes after this set\.\n?$/),
    });
    expect(await run('status', ['set', 'Running the suite', '--pose', 'none'])).toEqual({
      code: 0,
      out: expect.stringMatching(/^status set: Running the suite\nYour character: .*, the board's \(set one with `agent-board status set --pose`\)\.\n?$/),
    });
    expect(await run('status', ['set', '--pose', 'dancing'])).toEqual({ code: 2, out: expect.stringMatching(/unknown pose 'dancing'; poses: thinking/) });
    expect(await run('status', ['set', '--face', 'happy'])).toEqual({ code: 2, out: expect.stringMatching(/--face and --prop go with a --pose/) });
    expect(await run('status', ['set', '--pose', 'testing', '--progress', '40'])).toEqual({ code: 2, out: expect.stringMatching(/--progress goes with a summary/) });
    expect(await run('send', ['agent:x', 'hi', '--pose', 'testing'])).toEqual({ code: 2, out: expect.stringMatching(/--pose is only for `status set`/) });
    expect(await run('status', ['set', '--agent', `agent:${worker.sessionId.slice(0, 4)}`, '--pose', 'waiting-on-review'])).toEqual({
      code: 0,
      out: expect.stringMatching(/\nIts character: waiting-on-review, set by .+; it goes when its next turn starts\.\n?$/),
    });

    await run('status', ['set', '--pose', 'writing']);
    expect(await run('identify', [])).toMatchObject({ code: 0, out: expect.stringMatching(/\npose {5}writing, yours; it goes at turn end/) });
    const whoami = JSON.parse((await run('identify', ['--json'])).out) as { you: { character: unknown } };
    expect(whoami.you.character).toEqual({ shown: 'writing', yours: 'writing', setBy: 'you', expires: 'at turn end, or 20 minutes after this set' });

    const mcp = mcpAs(setup, lead.token);
    const answer = await mcp.callTool('set_status', { character: { pose: 'reading', face: 'focused', prop: 'book' } });
    expect(answer).toMatchObject({ isError: false });
    expect(answer.text.split('\n').at(-1)).toBe(JSON.stringify({ ok: true, shown: 'reading', yours: 'reading', expires: 'at turn end, or 20 minutes after this set' }));
    expect(await mcp.callTool('set_status', { character: { pose: 'dancing' } })).toMatchObject({ isError: true, text: expect.stringMatching(/unknown pose 'dancing'/) });
    expect(await mcp.callTool('set_status', {})).toMatchObject({ isError: true, text: expect.stringMatching(/a summary, a character, a category, a description, or more/) });
  });
});

describe('agents saying what they are for', () => {
  const listed = async (setup: Setup, sessionId: string) => (await setup.client.call('agent.list')).find((agent) => agent.sessionId === sessionId)!;

  it('sets its own over MCP, keeps it as its line changes, refuses a long one, and clears it with an empty one', async () => {
    const setup = await orchestrateDaemon();
    const { agent, token, connection } = await agentSide(setup, setup.zone.id);
    const mcp = mcpAs(setup, token);

    expect(await mcp.callTool('set_status', { description: '  Builds the morning\noverview window ' })).toEqual({
      text: 'Your description: "Builds the morning overview window". It stays until another is set.',
      isError: false,
    });
    expect(await listed(setup, agent.sessionId)).toMatchObject({ purpose: 'Builds the morning overview window', status: null });
    expect(await connection.call('board.setStatus', { token, summary: 'Wiring the columns' })).toMatchObject({ purpose: 'Builds the morning overview window' });

    await expect(connection.call('board.setStatus', { token, description: 'x'.repeat(81) })).rejects.toThrow('the description is 81 characters; at most 80');
    expect(await mcp.callTool('set_status', { description: '' })).toMatchObject({ text: 'Your description is cleared.' });
    expect((await listed(setup, agent.sessionId)).purpose).toBeNull();
  });

  it('is set by its orchestrator for an agent it started', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const worker = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'worker', prompt: 'Print your board identity' });

    const set = await lead.connection.call('orchestrator.setStatus', { token: lead.token, sessionId: worker.sessionId, description: 'Reviews the pairing screen' });
    expect(set).toMatchObject({ purpose: 'Reviews the pairing screen', status: null });
  });

  it('keeps it across a restart of the daemon', async () => {
    const dataDir = tempDataDir();
    const setup = await orchestrateDaemon({ dataDir });
    const { agent, token, connection } = await agentSide(setup, setup.zone.id);
    await connection.call('board.setStatus', { token, description: 'Turns remind-me into calendar events' });
    await setup.daemon.stop();

    const again = await startOrchestrateDaemon({ dataDir });
    const client = await connectTestClient(again);
    expect((await client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)?.purpose).toBe('Turns remind-me into calendar events');
  });
});

describe('agents setting their work categories', () => {
  const listed = async (setup: Setup, sessionId: string) => (await setup.client.call('agent.list')).find((agent) => agent.sessionId === sessionId)!;
  const WAITING = { category: 'waiting-on-others', label: 'With Legal', waitingOn: { who: 'Northwind Pay support', ref: '#48213' } } as const;

  it('sets its own with a label and who it waits on, keeps it when its line changes, and clears it with none', async () => {
    const setup = await orchestrateDaemon();
    const { agent, token, connection } = await agentSide(setup, setup.zone.id);

    const set = await connection.call('board.setStatus', { token, ...WAITING });
    expect(set).toMatchObject({
      status: null,
      workCategory: { category: 'waiting-on-others', label: 'With Legal', waitingOn: { who: 'Northwind Pay support', ref: '#48213' }, setAt: expect.any(String), setBy: null },
    });
    expect(await connection.call('board.setStatus', { token, summary: 'Chasing the refund' })).toMatchObject({
      status: { summary: 'Chasing the refund' },
      workCategory: { category: 'waiting-on-others', label: 'With Legal' },
    });
    // A new set replaces all of it: a label or who it waits on left out goes.
    expect(await connection.call('board.setStatus', { token, category: 'blocked' })).toMatchObject({ workCategory: { category: 'blocked', label: null, waitingOn: null } });
    expect(await connection.call('board.setStatus', { token, category: 'none' })).toMatchObject({ status: { summary: 'Chasing the refund' }, workCategory: null });
    expect((await listed(setup, agent.sessionId)).workCategory).toBeNull();
  });

  it('keeps what it set across a restart of the daemon', async () => {
    const dataDir = tempDataDir();
    const setup = await orchestrateDaemon({ dataDir });
    const { agent, token, connection } = await agentSide(setup, setup.zone.id);
    await connection.call('board.setStatus', { token, ...WAITING });
    await setup.daemon.stop();

    const again = await startOrchestrateDaemon({ dataDir });
    const client = await connectTestClient(again);
    expect((await client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)?.workCategory).toMatchObject({
      category: 'waiting-on-others',
      label: 'With Legal',
      waitingOn: { who: 'Northwind Pay support', ref: '#48213' },
    });
  });

  it('is Done when it says its work is done, unless it names another, and a Done goes with its next prompt', async () => {
    const setup = await orchestrateDaemon({ repeat: true });
    const { agent, token, connection } = await agentSide(setup, setup.zone.id);

    expect(await connection.call('board.setStatus', { token, summary: 'PR open', done: true, category: 'ready-for-review' })).toMatchObject({
      workCategory: { category: 'ready-for-review' },
    });
    expect(await connection.call('board.setStatus', { token, summary: 'Merged', done: true })).toMatchObject({ workCategory: { category: 'done' } });

    const since = setup.recorder.events.length;
    await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Also add a test' });
    await setup.recorder.waitFor(
      (e: DaemonEvent): e is AgentUpdatedEvent =>
        e.type === 'agent.updated' && e.agent.sessionId === agent.sessionId && e.agent.workFinishedAt === null && setup.recorder.events.indexOf(e) >= since,
    );
    expect((await listed(setup, agent.sessionId)).workCategory).toBeNull();

    // One that is not Done stays through its prompts.
    await connection.call('board.setStatus', { token, ...WAITING });
    const again = setup.recorder.events.length;
    await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Any news?' });
    await setup.recorder.waitFor(
      (e: DaemonEvent): e is HookEvent =>
        e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'UserPromptSubmit' && setup.recorder.events.indexOf(e) >= again,
    );
    expect((await listed(setup, agent.sessionId)).workCategory).toMatchObject({ category: 'waiting-on-others' });
  });

  it('refuses an unknown category by naming them, a label or a who with none, too long, or a who for a category not waiting on others', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
    const refused = (params: Record<string, unknown>, message: RegExp) =>
      expect(connection.call('board.setStatus', { token, ...params } as never)).rejects.toMatchObject({ code: RPC_ERROR.invalidParams, message: expect.stringMatching(message) });

    await refused({ category: 'stuck' }, /unknown category 'stuck'; categories: needs-help, ready-for-review, blocked, waiting-on-others, in-review, working, done, none/);
    await refused({ label: 'With Legal' }, /a label goes with a category/);
    await refused({ category: 'none', label: 'With Legal' }, /category none takes no label or waitingOn/);
    await refused({ category: 'blocked', label: 'x'.repeat(41) }, /the label is 41 characters; at most 40/);
    await refused({ category: 'blocked', label: '  ' }, /the label must not be blank/);
    await refused({ category: 'blocked', waitingOn: { who: 'Legal' } }, /waitingOn is only for waiting-on-others and in-review/);
    await refused({ category: 'in-review', waitingOn: { ref: '#1' } }, /waitingOn needs a who/);
    await refused({ category: 'in-review', waitingOn: { who: 'y'.repeat(81) } }, /who is 81 characters; at most 80/);
    await refused({}, /a status summary, a character pose, a category, a description, or more/);
  });

  it('sets the category of an agent in its crew, saying who set it, and refuses one outside it', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const worker = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'worker', prompt: 'Print your board identity' });
    const outsider = await userAgent(setup.client, setup.zone.id, 'outsider');

    expect(await lead.connection.call('orchestrator.setStatus', { token: lead.token, sessionId: worker.sessionId, category: 'in-review', waitingOn: { who: 'reviewer' } })).toMatchObject({
      workCategory: { category: 'in-review', waitingOn: { who: 'reviewer', ref: null }, setBy: lead.agent.name },
    });
    await expect(lead.connection.call('orchestrator.setStatus', { token: lead.token, sessionId: outsider.sessionId, category: 'blocked' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    expect((await listed(setup, outsider.sessionId)).workCategory).toBeNull();
  });

  it('is `status set --category --label --on` over the CLI, `set_status` with category over the MCP, and in identify and show', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const worker = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'worker' });
    const env = { [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: lead.token };
    const run = async (command: string, args: string[]) => {
      let out = '';
      const code = await runBoardCommand(command, args, { out: (text) => (out += text), err: (text) => (out += text), env });
      return { code, out };
    };

    expect(await run('status', ['set', '--category', 'waiting-on-others', '--label', 'With Legal', '--on', 'Northwind Pay support · #48213'])).toEqual({
      code: 0,
      out: 'Your category: Waiting on others "With Legal", waiting on Northwind Pay support · #48213, yours; it stays until another is set, or none.\n',
    });
    expect((await listed(setup, lead.agent.sessionId)).workCategory).toMatchObject({ waitingOn: { who: 'Northwind Pay support', ref: '#48213' } });
    expect(await run('identify', [])).toMatchObject({ code: 0, out: expect.stringMatching(/\ncategory Waiting on others "With Legal", waiting on Northwind Pay support · #48213, yours;/) });
    expect(await run('status', ['set', 'Merged', '--done'])).toEqual({
      code: 0,
      out: 'status set: Merged (finished)\nYour category: Done, yours; it goes with the next prompt.\n',
    });
    expect(await run('status', ['set', '--category', 'none'])).toEqual({ code: 0, out: expect.stringMatching(/^Your category: none set: the board guesses one/) });
    // Identify says what the board guesses, and why.
    expect(await run('identify', [])).toMatchObject({
      code: 0,
      out: expect.stringMatching(/\ncategory none set: the board guesses (Working|Done|Needs help)( \(.+\))?; set one with `agent-board status set --category`\n/),
    });
    expect(await run('status', ['set', '--label', 'With Legal'])).toEqual({ code: 2, out: expect.stringMatching(/--label and --on go with a --category/) });
    expect(await run('status', ['set', '--category', 'stuck'])).toEqual({ code: 2, out: expect.stringMatching(/unknown category 'stuck'; categories: needs-help/) });
    expect(await run('status', ['set', '--category', 'blocked', '--on', 'Legal'])).toEqual({ code: 2, out: expect.stringMatching(/--on is only for waiting-on-others and in-review/) });
    expect(await run('send', ['agent:x', 'hi', '--category', 'done'])).toEqual({ code: 2, out: expect.stringMatching(/--category is only for `status set`/) });
    expect(await run('status', ['set', '--agent', `agent:${worker.sessionId.slice(0, 4)}`, '--category', 'in-review', '--on', 'reviewer'])).toEqual({
      code: 0,
      out: expect.stringMatching(/\nIts category: In review, waiting on reviewer, set by .+; it stays until another is set, or none\.\n?$/),
    });
    expect(await run('show', [`agent:${worker.sessionId.slice(0, 4)}`])).toMatchObject({ code: 0, out: expect.stringMatching(/\n {2}category +In review, waiting on reviewer, set by /) });

    const mcp = mcpAs(setup, lead.token);
    expect(await mcp.callTool('set_status', { category: 'in-review', waiting_on: { who: 'Ada', ref: 'PR #12' } })).toEqual({
      isError: false,
      text: 'Your category: In review, waiting on Ada · PR #12, yours; it stays until another is set, or none.',
    });
    expect(await mcp.callTool('set_status', { category: 'working', waiting_on: { who: 'Ada' } })).toMatchObject({
      isError: true,
      text: expect.stringMatching(/waiting_on is only for waiting-on-others and in-review/),
    });
    expect(await mcp.callTool('set_status', {})).toMatchObject({ isError: true, text: expect.stringMatching(/a summary, a character, a category, a description, or more/) });
    const json = JSON.parse((await run('show', ['--json', `agent:${lead.agent.sessionId.slice(0, 4)}`])).out) as { workCategory: unknown };
    expect(json.workCategory).toMatchObject({ category: 'in-review', waitingOn: { who: 'Ada', ref: 'PR #12' }, setBy: null });
  });
});

describe('agents recording their own sidebar', () => {
  it('records a pull request on its own sidebar at once, by any of its URLs, and refuses a URL that names none', async () => {
    const setup = await orchestrateDaemon();
    const { agent, token, connection } = await agentSide(setup, setup.zone.id);
    const since = setup.recorder.events.length;
    const recorded = await connection.call('board.record', { token, kind: 'pr', url: 'https://github.com/acme/other/pull/12/files', title: 'Bump the pin' });
    expect(recorded).toMatchObject({ kind: 'pr', key: 'acme/other#12', url: 'https://github.com/acme/other/pull/12', title: 'Bump the pin', deletedAt: null });
    expect(setup.recorder.events.slice(since)).toContainEqual(
      expect.objectContaining({ type: 'agent.updated', agent: expect.objectContaining({ sessionId: agent.sessionId, records: [recorded] }) }),
    );

    // The same pull request again, in any case, is one record; with no title, it keeps the one it had.
    await connection.call('board.record', { token, kind: 'pr', url: 'https://github.com/Acme/Other/pull/12' });
    expect((await setup.client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.records).toEqual([
      expect.objectContaining({ key: 'acme/other#12', title: 'Bump the pin' }),
    ]);
    await connection.call('board.record', { token, kind: 'pr', url: 'https://github.com/acme/other/pull/12', title: 'Bump the pin to 4.1' });
    expect((await setup.client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.records).toEqual([
      expect.objectContaining({ title: 'Bump the pin to 4.1' }),
    ]);

    await expect(connection.call('board.record', { token, kind: 'pr', url: 'https://example.com/pull/1' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/not a GitHub pull request URL/),
    });
  });

  it('records a hand-off doc on itself, or on the orchestrator that started it, saying who wrote it', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const worker = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'worker', prompt: 'Print your board identity' });
    const workerSide = await agentSideOf(setup, worker.sessionId);
    mkdirSync(join(worker.worktree, 'notes'));
    writeFileSync(join(worker.worktree, 'notes', 'findings.md'), '# Findings\n');
    const path = realpathSync(join(worker.worktree, 'notes', 'findings.md'));

    // Relative to where its session started.
    expect(await workerSide.connection.call('board.record', { token: workerSide.token, kind: 'doc', path: 'notes/findings.md' })).toMatchObject({ kind: 'doc', key: path, path, from: null });
    const forLead = await workerSide.connection.call('board.record', { token: workerSide.token, kind: 'doc', path, forOrchestrator: true });
    expect(forLead).toMatchObject({ path, from: { sessionId: worker.sessionId, name: 'worker' } });
    const listed = await setup.client.call('agent.list');
    expect(listed.find((each) => each.sessionId === lead.agent.sessionId)!.records).toEqual([
      expect.objectContaining({ kind: 'crew', key: worker.sessionId }),
      forLead,
    ]);
    // The CLI says it is on both.
    let out = '';
    const env = { [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: workerSide.token };
    expect(await runBoardCommand('record', ['doc', path, '--for', 'orchestrator'], { out: (text) => (out += text), err: (text) => (out += text), env })).toBe(0);
    expect(out).toBe(`Recorded ${path} on your orchestrator's sidebar, and on yours.\n`);
    // One for its orchestrator is on its own sidebar too.
    expect(listed.find((each) => each.sessionId === worker.sessionId)!.records).toEqual([expect.objectContaining({ key: path, from: null })]);

    await expect(workerSide.connection.call('board.record', { token: workerSide.token, kind: 'doc', path: 'notes/missing.md' })).rejects.toMatchObject({
      message: expect.stringMatching(/notes\/missing.md is not a file/),
    });
    // The user started the lead: no orchestrator to record for.
    writeFileSync(join(lead.agent.worktree, 'plan.md'), 'plan');
    await expect(lead.connection.call('board.record', { token: lead.token, kind: 'doc', path: 'plan.md', forOrchestrator: true })).rejects.toMatchObject({
      message: expect.stringMatching(/no orchestrator started you/),
    });
  });

  it('lets the user delete a record and bring it back, which the agent recording it again does too', async () => {
    const setup = await orchestrateDaemon();
    const { agent, token, connection } = await agentSide(setup, setup.zone.id);
    await connection.call('board.record', { token, kind: 'pr', url: 'https://github.com/acme/web/pull/7' });
    const records = async () => (await setup.client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.records;
    const remove = (deleted: boolean) => setup.client.call('agent.setRecordDeleted', { sessionId: agent.sessionId, kind: 'pr', key: 'acme/web#7', deleted });

    const deleted = (await remove(true)).records[0]!;
    expect(deleted.deletedAt).toEqual(expect.any(String));
    // Deleting again keeps when it was first deleted.
    expect((await remove(true)).records[0]!.deletedAt).toBe(deleted.deletedAt);
    expect((await remove(false)).records[0]!.deletedAt).toBeNull();

    await remove(true);
    await connection.call('board.record', { token, kind: 'pr', url: 'https://github.com/acme/web/pull/7' });
    expect(await records()).toEqual([expect.objectContaining({ key: 'acme/web#7', deletedAt: null })]);

    await expect(setup.client.call('agent.setRecordDeleted', { sessionId: agent.sessionId, kind: 'pr', key: 'acme/web#8', deleted: true })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
    // Never the agent's own.
    await expect(connection.call('agent.setRecordDeleted', { sessionId: agent.sessionId, kind: 'pr', key: 'acme/web#7', deleted: true })).rejects.toMatchObject({
      code: BOARD_ERROR.notAllowed,
    });
  });

  it('reads a recorded or guessed hand-off doc for its tab, and no other file', async () => {
    const setup = await orchestrateDaemon();
    const { agent, token, connection } = await agentSide(setup, setup.zone.id);
    writeFileSync(join(agent.worktree, 'design.md'), '# Design\n');
    const design = realpathSync(join(agent.worktree, 'design.md'));
    const read = (path: string) => setup.client.call('agent.readDoc', { sessionId: agent.sessionId, path });

    await expect(read(design)).rejects.toMatchObject({ message: expect.stringMatching(/is not one of .*hand-off docs/) });
    await connection.call('board.record', { token, kind: 'doc', path: 'design.md' });
    expect(await read(design)).toEqual({ path: design, text: '# Design\n' });
    await setup.client.call('agent.setRecordDeleted', { sessionId: agent.sessionId, kind: 'doc', key: design, deleted: true });
    await expect(read(design)).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });

    // Its worktree's handover is guessed while it is there.
    mkdirSync(join(agent.worktree, '.agent-board'), { recursive: true });
    writeFileSync(join(agent.worktree, '.agent-board', 'handover.md'), 'Done.\n');
    const guessed = (await setup.client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.guessedDoc;
    expect(guessed).toBe(realpathSync(join(agent.worktree, '.agent-board', 'handover.md')));
    expect(await read(guessed!)).toMatchObject({ text: 'Done.\n' });
  });

  it('pins a file, a link and a labelled note on its own sidebar, each again replacing it, and unpins them', async () => {
    const setup = await orchestrateDaemon();
    const { agent, token, connection } = await agentSide(setup, setup.zone.id);
    writeFileSync(join(agent.worktree, 'shot.png'), 'png');
    const shot = realpathSync(join(agent.worktree, 'shot.png'));
    const records = async () => (await setup.client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.records;

    expect(await connection.call('board.record', { token, kind: 'pin', path: 'shot.png' })).toMatchObject({
      kind: 'pin',
      key: shot,
      target: { kind: 'file', path: shot },
      label: null,
      from: null,
    });
    expect(await connection.call('board.record', { token, kind: 'pin', url: 'http://localhost:5173/app', label: 'Preview' })).toMatchObject({
      key: 'http://localhost:5173/app',
      target: { kind: 'link', url: 'http://localhost:5173/app' },
      label: 'Preview',
    });
    expect(await connection.call('board.record', { token, kind: 'pin', note: 'Seeded 3 users: ann, bob, cy', label: 'Test logins' })).toMatchObject({
      key: 'note:Test logins',
      target: { kind: 'note', text: 'Seeded 3 users: ann, bob, cy' },
      label: 'Test logins',
    });
    // A note with the same label is the same pin, its text replaced.
    await connection.call('board.record', { token, kind: 'pin', note: 'Seeded 4 users', label: 'Test logins' });
    expect((await records()).map((record) => record.kind === 'pin' && record.target)).toEqual([
      { kind: 'file', path: shot },
      { kind: 'link', url: 'http://localhost:5173/app' },
      { kind: 'note', text: 'Seeded 4 users' },
    ]);

    // Unpinning takes it off, row and all: nothing for the sidebar to bring back.
    await connection.call('board.unpin', { token, url: 'http://localhost:5173/app' });
    await connection.call('board.unpin', { token, label: 'Test logins' });
    // A file gone since, named through a link to its folder, is still the pin it was.
    symlinkSync(agent.worktree, join(agent.worktree, 'via'));
    rmSync(shot);
    await connection.call('board.unpin', { token, path: 'via/shot.png' });
    expect(await records()).toEqual([]);
    await expect(connection.call('board.unpin', { token, label: 'Test logins' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/no pin Test logins/),
    });
  });

  it('refuses a pin of no file, a link that is not http, a note with no label, or two things at once', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id);
    const pin = (params: Record<string, unknown>) => connection.call('board.record', { token, kind: 'pin', ...params } as never);
    await expect(pin({ path: 'missing.png' })).rejects.toMatchObject({ message: expect.stringMatching(/missing.png is not a file/) });
    // Only links a web tab opens: https anywhere, http on this machine, never a name or password.
    for (const url of ['file:///etc/passwd', 'not a url', 'http://evil.example/', 'http://0.0.0.0:3000', 'https://user:pass@example.com/', 'javascript:alert(1)']) {
      await expect(pin({ url })).rejects.toMatchObject({ message: expect.stringMatching(/not a link a web tab opens\. A web tab shows https pages/) });
    }
    await expect(pin({ url: `https://example.com/${'a'.repeat(2048)}` })).rejects.toMatchObject({ message: expect.stringMatching(/at most 2048 characters/) });
    expect(await pin({ url: 'http://127.0.0.1:5173/' })).toMatchObject({ target: { kind: 'link', url: 'http://127.0.0.1:5173/' } });
    await expect(pin({ note: 'Seeded' })).rejects.toMatchObject({ message: expect.stringMatching(/a note needs a label/) });
    await expect(pin({ note: 'x'.repeat(2001), label: 'Long' })).rejects.toMatchObject({ message: expect.stringMatching(/at most 2000 characters/) });
    await expect(pin({ path: 'a.md', url: 'https://example.com' })).rejects.toMatchObject({ message: expect.stringMatching(/pin one of path, url or note/) });
    await expect(pin({})).rejects.toMatchObject({ message: expect.stringMatching(/pin one of path, url or note/) });
  });

  it('keeps a label as one line, so a label with line breaks in it is the same note as on one', async () => {
    const setup = await orchestrateDaemon();
    const { agent, token, connection } = await agentSide(setup, setup.zone.id);
    expect(await connection.call('board.record', { token, kind: 'pin', note: 'ann / pw', label: '  Test\n\tlogins ' })).toMatchObject({ key: 'note:Test logins', label: 'Test logins' });
    await connection.call('board.unpin', { token, label: 'Test   logins' });
    expect((await setup.client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.records).toEqual([]);
  });

  it("lets a crew member pin and unpin for its orchestrator only among its own pins there, never the orchestrator's own or another crew member's", async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const sides = [];
    for (const name of ['impl', 'review']) {
      const worker = await lead.connection.call('orchestrator.spawn', { token: lead.token, name, prompt: 'Print your board identity' });
      sides.push({ worker, ...(await agentSideOf(setup, worker.sessionId)) });
    }
    const [impl, review] = sides as [(typeof sides)[number], (typeof sides)[number]];
    const pins = async () =>
      (await setup.client.call('agent.list'))
        .find((each) => each.sessionId === lead.agent.sessionId)!
        .records.flatMap((record) => (record.kind === 'pin' ? [[record.from?.name ?? 'lead', record.target.kind === 'note' ? record.target.text : record.key]] : []));

    await lead.connection.call('board.record', { token: lead.token, kind: 'pin', note: "The lead's logins", label: 'Logins' });
    await lead.connection.call('board.record', { token: lead.token, kind: 'pin', url: 'https://example.com/x' });
    // The same label and link from each crew member stand beside the lead's own, each saying whose it is.
    for (const each of [impl, review]) {
      await each.connection.call('board.record', { token: each.token, kind: 'pin', note: `${each.worker.name}'s logins`, label: 'Logins', forOrchestrator: true });
      await each.connection.call('board.record', { token: each.token, kind: 'pin', url: 'https://example.com/x', forOrchestrator: true });
    }
    expect(await pins()).toEqual([
      ['lead', "The lead's logins"],
      ['lead', 'https://example.com/x'],
      ['impl', "impl's logins"],
      ['impl', `from:${impl.worker.sessionId}:https://example.com/x`],
      ['review', "review's logins"],
      ['review', `from:${review.worker.sessionId}:https://example.com/x`],
    ]);

    // Unpinning for the orchestrator takes off the crew member's own alone.
    await impl.connection.call('board.unpin', { token: impl.token, label: 'Logins', forOrchestrator: true });
    await impl.connection.call('board.unpin', { token: impl.token, url: 'https://example.com/x', forOrchestrator: true });
    await expect(impl.connection.call('board.unpin', { token: impl.token, url: 'https://example.com/x', forOrchestrator: true })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/no pin https:\/\/example.com\/x on your orchestrator's sidebar that you pinned there/),
    });
    expect(await pins()).toEqual([
      ['lead', "The lead's logins"],
      ['lead', 'https://example.com/x'],
      ['review', "review's logins"],
      ['review', `from:${review.worker.sessionId}:https://example.com/x`],
    ]);
  });

  it('pins for the orchestrator that started it, on that sidebar only, saying who pinned it', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const worker = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'worker', prompt: 'Print your board identity' });
    const workerSide = await agentSideOf(setup, worker.sessionId);
    const records = async (sessionId: string) => (await setup.client.call('agent.list')).find((each) => each.sessionId === sessionId)!.records;

    const pinned = await workerSide.connection.call('board.record', { token: workerSide.token, kind: 'pin', url: 'https://example.com/report', forOrchestrator: true });
    expect(pinned).toMatchObject({ kind: 'pin', from: { sessionId: worker.sessionId, name: 'worker' } });
    expect(await records(lead.agent.sessionId)).toContainEqual(pinned);
    expect(await records(worker.sessionId)).toEqual([]);
    await workerSide.connection.call('board.unpin', { token: workerSide.token, url: 'https://example.com/report', forOrchestrator: true });
    expect((await records(lead.agent.sessionId)).filter((record) => record.kind === 'pin')).toEqual([]);
    await expect(lead.connection.call('board.record', { token: lead.token, kind: 'pin', url: 'https://example.com', forOrchestrator: true })).rejects.toMatchObject({
      message: expect.stringMatching(/no orchestrator started you/),
    });
  });

  it('reads a pinned Markdown or HTML file for its Doc tab, and lets the user delete a pin with Undo', async () => {
    const setup = await orchestrateDaemon();
    const { agent, token, connection } = await agentSide(setup, setup.zone.id);
    writeFileSync(join(agent.worktree, 'report.html'), '<h1>Report</h1>');
    const report = realpathSync(join(agent.worktree, 'report.html'));
    const read = () => setup.client.call('agent.readDoc', { sessionId: agent.sessionId, path: report });

    await expect(read()).rejects.toMatchObject({ message: expect.stringMatching(/is not one of .*docs, pins or page's links/) });
    await connection.call('board.record', { token, kind: 'pin', path: 'report.html' });
    expect(await read()).toEqual({ path: report, text: '<h1>Report</h1>' });
    const remove = (deleted: boolean) => setup.client.call('agent.setRecordDeleted', { sessionId: agent.sessionId, kind: 'pin', key: report, deleted });
    expect((await remove(true)).records[0]!.deletedAt).toEqual(expect.any(String));
    await expect(read()).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    expect((await remove(false)).records[0]!.deletedAt).toBeNull();
    expect(await read()).toMatchObject({ text: '<h1>Report</h1>' });

    // Made a link since it was pinned, it is not read through to where the link leads.
    writeFileSync(join(agent.worktree, 'other.txt'), 'secret');
    rmSync(report);
    symlinkSync(join(agent.worktree, 'other.txt'), report);
    await expect(read()).rejects.toMatchObject({ message: expect.stringMatching(/is a link now/) });
  });

  it('is `pin` and `unpin` over the CLI and the MCP', async () => {
    const setup = await orchestrateDaemon();
    const { agent, token } = await agentSide(setup, setup.zone.id);
    const env = { [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: token };
    const run = async (command: string, args: string[]) => {
      let out = '';
      const code = await runBoardCommand(command, args, { out: (text) => (out += text), err: (text) => (out += text), env });
      return { code, out };
    };
    writeFileSync(join(agent.worktree, 'notes.md'), 'notes');
    const notes = realpathSync(join(agent.worktree, 'notes.md'));
    expect(await run('pin', [join(agent.worktree, 'notes.md'), '--label', 'Notes'])).toEqual({ code: 0, out: `Pinned Notes (${notes}) on your sidebar.\n` });
    expect(await run('pin', ['https://example.com/a'])).toEqual({ code: 0, out: 'Pinned https://example.com/a on your sidebar.\n' });
    expect(await run('pin', ['--note', 'Use port 5174', '--label', 'Port'])).toEqual({ code: 0, out: 'Pinned the note Port on your sidebar.\n' });
    expect(await run('pin', ['--note', 'No label'])).toEqual({ code: 2, out: expect.stringMatching(/a note needs --label/) });
    expect(await run('pin', ['a.md', '--note', 'Both'])).toEqual({ code: 2, out: expect.stringMatching(/pin a file, a link or --note/) });
    expect(await run('pin', ['a.md', '--for', 'lead'])).toEqual({ code: 2, out: expect.stringMatching(/--for takes only orchestrator/) });
    expect(await run('unpin', ['https://example.com/a'])).toEqual({ code: 0, out: 'Unpinned https://example.com/a from your sidebar.\n' });
    expect(await run('unpin', ['--label', 'Port'])).toEqual({ code: 0, out: 'Unpinned the note Port from your sidebar.\n' });

    const mcp = mcpAs(setup, token);
    expect(await mcp.callTool('pin', { url: 'https://example.com/b', label: 'B' })).toMatchObject({ isError: false, text: 'Pinned B (https://example.com/b) on your sidebar.' });
    expect(await mcp.callTool('pin', { note: 'Hi' })).toMatchObject({ isError: true, text: expect.stringMatching(/a note needs a label/) });
    expect(await mcp.callTool('unpin', { path: notes })).toMatchObject({ isError: false, text: `Unpinned Notes (${notes}) from your sidebar.` });
    expect((await setup.client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.records.map((record) => record.key)).toEqual([
      'https://example.com/b',
    ]);
  });

  it('is `record pr|doc` over the CLI and record_pr and record_doc over the MCP', async () => {
    const setup = await orchestrateDaemon();
    const { agent, token } = await agentSide(setup, setup.zone.id);
    const env = { [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: token };
    const run = async (args: string[]) => {
      let out = '';
      const code = await runBoardCommand('record', args, { out: (text) => (out += text), err: (text) => (out += text), env });
      return { code, out };
    };
    expect(await run(['pr', 'https://github.com/acme/web/pull/3', '--title', 'Fix it'])).toEqual({ code: 0, out: 'Recorded acme/web#3 (Fix it) on your sidebar.\n' });
    expect(await run(['pr', 'https://github.com/acme/web/pull/3', '--for', 'orchestrator'])).toEqual({ code: 2, out: expect.stringMatching(/--for is only for `record doc`/) });
    expect(await run(['doc', 'a.md', '--for', 'lead'])).toEqual({ code: 2, out: expect.stringMatching(/--for takes only orchestrator/) });
    expect(await run(['issue', 'x'])).toEqual({ code: 2, out: expect.stringMatching(/record what/) });

    writeFileSync(join(agent.worktree, 'notes.md'), 'notes');
    const mcp = mcpAs(setup, token);
    expect(await mcp.callTool('record_pr', { url: 'https://github.com/acme/web/pull/4' })).toMatchObject({ isError: false, text: 'Recorded acme/web#4 on your sidebar.' });
    expect(await mcp.callTool('record_doc', { path: join(agent.worktree, 'notes.md') })).toMatchObject({ isError: false, text: expect.stringMatching(/^Recorded .*notes.md on your sidebar/) });
    expect(await mcp.callTool('record_doc', { path: join(agent.worktree, 'notes.md'), for_orchestrator: true })).toMatchObject({ isError: true, text: expect.stringMatching(/no orchestrator started you/) });
    expect((await setup.client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.records.map((record) => record.key)).toEqual([
      'acme/web#3',
      'acme/web#4',
      realpathSync(join(agent.worktree, 'notes.md')),
    ]);
  });
});

describe('replying to an agent that messaged it', () => {
  /** Waits, as the user, until each agent's turn has ended: a message is sent only between turns. */
  const settled = (setup: Setup, ...sessionIds: string[]) => setup.client.call('orchestrator.wait', { sessionIds });

  it('lets an agent answer one the user started by hand only once that one messaged it, with send alone', async () => {
    const setup = await orchestrateDaemon();
    // The captain and the bystander are the user's own: no agent steers them.
    const captain = await agentSide(setup, setup.other.id);
    const lead = await crewSide(setup, setup.zone.id);
    const bystander = await agentSide(setup, setup.other.id);
    await settled(setup, captain.agent.sessionId, lead.agent.sessionId, bystander.agent.sessionId);
    const reply = () => lead.connection.call('orchestrator.send', { token: lead.token, sessionId: captain.agent.sessionId, text: 'The zone is green' });

    await expect(reply()).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope, message: expect.stringMatching(/started by hand/) });

    const asked = await captain.connection.call('orchestrator.send', { token: captain.token, sessionId: lead.agent.sessionId, text: 'How is the zone?' });
    // The message says who sent it, and how to answer.
    expect(asked.typed).toMatch(new RegExp(`^${escaped(sentBy(captain.agent, 'How is the zone?'))}\n\n\\[agent-board\\] From `));
    await setup.recorder.waitForText(lead.agent.sessionId, `agent-board send ${refOf(captain.agent)}`);

    // Its answer is marked as a reply.
    await expect(reply()).resolves.toMatchObject({
      sessionId: captain.agent.sessionId,
      typed: expect.stringMatching(new RegExp(`^${escaped(markSender('reply', lead.agent.name, refOf(lead.agent), 'The zone is green'))}`)),
    });
    const [line] = await setup.client.call('orchestrator.activity', { limit: 1 });
    expect(line).toMatchObject({ orchestratorId: lead.agent.sessionId, action: 'send', outcome: 'done', targetId: captain.agent.sessionId });

    // Only to the agent that messaged it.
    await expect(lead.connection.call('orchestrator.send', { token: lead.token, sessionId: bystander.agent.sessionId, text: 'Hello' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    // And only a message: nothing else reaches it.
    const others = [
      lead.connection.call('orchestrator.interrupt', { token: lead.token, sessionId: captain.agent.sessionId }),
      lead.connection.call('orchestrator.restart', { token: lead.token, sessionId: captain.agent.sessionId }),
      lead.connection.call('orchestrator.close', { token: lead.token, sessionId: captain.agent.sessionId }),
      lead.connection.call('orchestrator.read', { token: lead.token, sessionId: captain.agent.sessionId }),
      lead.connection.call('orchestrator.wait', { token: lead.token, sessionIds: [captain.agent.sessionId] }),
      lead.connection.call('orchestrator.addEdge', { token: lead.token, from: lead.agent.sessionId, to: captain.agent.sessionId }),
      // Nor what sits at its prompt.
      lead.connection.call('orchestrator.send', { token: lead.token, sessionId: captain.agent.sessionId, submit: true }),
      lead.connection.call('orchestrator.send', { token: lead.token, sessionId: captain.agent.sessionId, clear: true }),
    ];
    for (const call of others) await expect(call).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
  });

  it('answers with the CLI, as the hint says, and reaches no other agent the user started', async () => {
    const setup = await orchestrateDaemon();
    const captain = await agentSide(setup, setup.other.id);
    const plain = await crewSide(setup, setup.zone.id);
    const neighbour = await userAgent(setup.client, setup.zone.id, 'neighbour');
    await settled(setup, captain.agent.sessionId, plain.agent.sessionId, neighbour.sessionId);

    await captain.connection.call('orchestrator.send', { token: captain.token, sessionId: plain.agent.sessionId, text: 'Report back' });
    await setup.recorder.waitForText(plain.agent.sessionId, `agent-board send ${refOf(captain.agent)}`);
    await settled(setup, captain.agent.sessionId);
    let out = '';
    const io = { out: (text: string) => (out += text), err: (text: string) => (out += text), env: { [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: plain.token } };
    expect(await runBoardCommand('send', [refOf(captain.agent), '--', 'And the tests pass'], io)).toBe(0);
    expect(out).toMatch(/^Sent to /);
    await expect(plain.connection.call('orchestrator.send', { token: plain.token, sessionId: neighbour.sessionId, text: 'Hello' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/started by hand/),
    });
    await expect(plain.connection.call('orchestrator.interrupt', { token: plain.token, sessionId: captain.agent.sessionId })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    for (const draft of [{ submit: true }, { clear: true }]) {
      await expect(plain.connection.call('orchestrator.send', { token: plain.token, sessionId: captain.agent.sessionId, ...draft })).rejects.toMatchObject({
        code: BOARD_ERROR.outOfScope,
      });
    }
  });

  it('grants nothing for a message that was refused', async () => {
    const setup = await orchestrateDaemon();
    const captain = await agentSide(setup, setup.other.id);
    const lead = await crewSide(setup, setup.zone.id);
    await settled(setup, captain.agent.sessionId, lead.agent.sessionId);
    await expect(captain.connection.call('orchestrator.send', { token: captain.token, sessionId: lead.agent.sessionId, text: '/config' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
    await expect(lead.connection.call('orchestrator.send', { token: lead.token, sessionId: captain.agent.sessionId, text: 'Yes?' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
  });

  it('answers over the MCP as over the CLI', async () => {
    const setup = await orchestrateDaemon();
    const captain = await agentSide(setup, setup.other.id);
    const lead = await crewSide(setup, setup.zone.id);
    await settled(setup, captain.agent.sessionId, lead.agent.sessionId);
    const mcp = mcpAs(setup, lead.token);
    expect(await mcp.callTool('send', { agent: refOf(captain.agent), text: 'The zone is green' })).toMatchObject({ isError: true });

    await captain.connection.call('orchestrator.send', { token: captain.token, sessionId: lead.agent.sessionId, text: 'How is the zone?' });
    await setup.recorder.waitForText(lead.agent.sessionId, `agent-board send ${refOf(captain.agent)}`);
    expect(await mcp.callTool('send', { agent: refOf(captain.agent), text: 'The zone is green' })).toMatchObject({ isError: false });
  });

  it("opens none to the sender's own crew, which answers in its turn's last message", async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id);
    const worker = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'worker', prompt: 'Print your board identity' });
    const workerSide = await agentSideOf(setup, worker.sessionId);
    await settled(setup, worker.sessionId, lead.agent.sessionId);
    await lead.connection.call('orchestrator.send', { token: lead.token, sessionId: worker.sessionId, text: 'Also add a test' });
    await setup.recorder.waitForText(worker.sessionId, `Done: ${sentBy(lead.agent, 'Also add a test')}.`);
    expect(setup.recorder.screenText(worker.sessionId)).not.toContain('agent-board send');
    await settled(setup, lead.agent.sessionId);
    // It may still message the agent that started it, as any crew member may, but nothing more.
    await expect(workerSide.connection.call('orchestrator.send', { token: workerSide.token, sessionId: lead.agent.sessionId, submit: true })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/started by hand/),
    });
  });

  it('lasts only its window from the message', async () => {
    const setup = await orchestrateDaemon({ replyWindowMs: 1000 });
    const captain = await agentSide(setup, setup.other.id);
    const lead = await crewSide(setup, setup.zone.id);
    await settled(setup, captain.agent.sessionId, lead.agent.sessionId);
    await captain.connection.call('orchestrator.send', { token: captain.token, sessionId: lead.agent.sessionId, text: 'How is the zone?' });
    await settled(setup, lead.agent.sessionId);
    await new Promise((done) => setTimeout(done, 1100));
    await expect(lead.connection.call('orchestrator.send', { token: lead.token, sessionId: captain.agent.sessionId, text: 'Green' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
  });

  it('adds no reply hint to a message the agent could answer anyway', async () => {
    const setup = await orchestrateDaemon();
    // Each may steer the other, as another agent started both.
    const lead = await crewSide(setup, setup.zone.id);
    const peer = await crewSide(setup, setup.zone.id);
    await settled(setup, peer.agent.sessionId);
    await lead.connection.call('orchestrator.send', { token: lead.token, sessionId: peer.agent.sessionId, text: 'Carry on' });
    await setup.recorder.waitForText(peer.agent.sessionId, `Done: ${sentBy(lead.agent, 'Carry on')}.`);
    expect(setup.recorder.screenText(peer.agent.sessionId)).not.toContain('agent-board send');
  });
});
