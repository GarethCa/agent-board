import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv, McpClient } from '@agent-board/fake-harness';
import { BOARD_MCP_INSTRUCTIONS, ORCHESTRATOR_INSTRUCTIONS } from '../src/board-mcp.ts';
import { AGENT_ERROR, BOARD_ERROR, RPC_ERROR, type Agent, type AgentUpdatedEvent, type DaemonEvent, type OrchestratorActivityEvent } from '../src/protocol.ts';
import type { DaemonClient } from '../src/client.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, TEST_CLI_LAUNCHER, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

/**
 * A daemon whose agents play the fake harnesses' `orchestrate` scenario, with two zones of one repo and one of another.
 * Their agents may not orchestrate unless a test lets them: the zones' setting is off.
 */
async function orchestrateDaemon() {
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }),
  });
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
  const { daemon, client, recorder } = setup;
  const agent = await client.call('agent.spawn', { zoneId, prompt: 'Print your board identity', ...SIZE, ...(orchestrate ? { orchestrate } : {}) });
  await client.call('session.attach', { sessionId: agent.sessionId });
  await recorder.waitForText(agent.sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(recorder.screenText(agent.sessionId))![1]!;
  const connection = await connectTestClient(daemon);
  await connection.call('board.identify', { token });
  return { agent, token, connection };
}

/** An agent the user started, at its prompt with nothing in its worktree: `spawn` with no prompt. */
async function userAgent(client: DaemonClient, zoneId: string, name: string) {
  return client.call('agent.spawn', { zoneId, name, ...SIZE });
}

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

  it('never passes to the agents an orchestrator starts, and keeps settings and permissions out of its reach', async () => {
    const setup = await orchestrateDaemon();
    const { token, connection } = await agentSide(setup, setup.zone.id, 'board');
    const worker = await connection.call('orchestrator.spawn', { token, prompt: 'Write the handover', name: 'child' });
    expect(worker.orchestrate).toBeNull();
    // Whatever it is asked for: orchestrate is the user's spawn's alone.
    const asked = await connection.call('orchestrator.spawn', { token, name: 'sneaky', orchestrate: 'board' } as never);
    expect(asked.orchestrate).toBeNull();

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

  it("never lets an ended orchestrator's shell orchestrate for it", async () => {
    const setup = await orchestrateDaemon();
    const { agent } = await agentSide(setup, setup.zone.id, 'zone');
    await setup.client.call('agent.stop', { sessionId: agent.sessionId });
    const ended = await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.shellSessionId !== null);
    const shell = ended.shellSessionId!;
    await setup.client.call('session.attach', { sessionId: shell });
    await setup.client.call('session.write', { sessionId: shell, data: 'echo "identity:$AGENT_BOARD_IDENTITY:end"\r' });
    await setup.recorder.waitForText(shell, ':end\r\n');
    const token = /identity:(.*):end\r\n/.exec(setup.recorder.screenText(shell))![1]!;

    const connection = await connectTestClient(setup.daemon);
    expect(await connection.call('board.identify', { token })).toMatchObject({ tileId: agent.sessionId, orchestrate: null });
    await expect(connection.call('orchestrator.spawn', { token })).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
  });
});

describe('a zone whose agents may orchestrate', () => {
  it('is on for a new zone', async () => {
    const setup = await orchestrateDaemon();
    const fresh = await setup.client.call('zone.add', { path: tempRepo('fresh'), x: 6000, y: 0, name: 'fresh' });
    expect(fresh.agentsOrchestrate).toBe(true);
    expect((await agentSide(setup, fresh.id)).agent.orchestrate).toBe('zone');
  });

  it('lets the agents the user starts there orchestrate in it, not those already there', async () => {
    const setup = await orchestrateDaemon();
    const before = await agentSide(setup, setup.zone.id);
    expect(before.agent.orchestrate).toBeNull();

    expect(await setup.client.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: true })).toMatchObject({ agentsOrchestrate: true });
    expect(await before.connection.call('board.identify', { token: before.token })).toMatchObject({ orchestrate: null });
    const { agent, token, connection } = await agentSide(setup, setup.zone.id);
    expect(agent.orchestrate).toBe('zone');
    const child = await connection.call('orchestrator.spawn', { token, name: 'child' });
    expect(child.zoneId).toBe(setup.zone.id);
    // Started in the zone, but by an orchestrator: it never orchestrates.
    expect(child.orchestrate).toBeNull();
    // A board token is refused the switch.
    await expect(connection.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: false })).rejects.toMatchObject({
      code: BOARD_ERROR.notAllowed,
    });
  });

  it('grants nothing to an agent outside it: one moved in, or one the zone let orchestrate moved out', async () => {
    const setup = await orchestrateDaemon();
    await setup.client.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: true });
    await setup.client.call('zone.configure', { id: setup.other.id, agentsOrchestrate: true });
    const outsider = await agentSide(setup, setup.sameRepo.id);
    await setup.client.call('agent.move', { sessionId: outsider.agent.sessionId, zoneId: setup.zone.id, x: 0, y: 400 });
    expect(await outsider.connection.call('board.identify', { token: outsider.token })).toMatchObject({ orchestrate: null });

    const { agent, token, connection } = await agentSide(setup, setup.zone.id);
    // Into another zone, even one whose agents may orchestrate, or loose: the zone's grant stays behind.
    for (const zoneId of [setup.other.id, null]) {
      const moved = await setup.client.call('agent.move', { sessionId: agent.sessionId, zoneId, x: 0, y: 0 });
      expect(moved.orchestrate).toBeNull();
      await expect(connection.call('orchestrator.spawn', { token })).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
    }
    // Back in the zone that granted it, it orchestrates there again.
    expect((await setup.client.call('agent.move', { sessionId: agent.sessionId, zoneId: setup.zone.id, x: 0, y: 0 })).orchestrate).toBe('zone');
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
    // On again, the agents it let orchestrate do again; the grant by hand is gone for good, and says so truly.
    await setup.client.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: true });
    await untilAgent(setup.recorder, granted.agent.sessionId, (seen) => seen.orchestrate === 'zone');
    expect(await granted.connection.call('board.identify', { token: granted.token })).toMatchObject({ orchestrate: 'zone' });
    await expect(byHand.connection.call('orchestrator.spawn', { token: byHand.token })).rejects.toMatchObject({
      message: expect.stringMatching(/the user didn't start it in web while orchestrating was on there\. The agents the user starts there now may/),
    });
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
    // The slow one's turn hasn't ended: it is still on its way, or hasn't begun.
    expect(['idle', 'running']).toContain(any.agents.find((agent) => agent.name === 'slow')!.state);
    await expect(connection.call('orchestrator.read', { token, sessionId: slow.sessionId })).rejects.toMatchObject({
      message: expect.stringMatching(/has not finished a turn yet/),
    });
    const all = await connection.call('orchestrator.wait', { token, sessionIds: [quick.sessionId, slow.sessionId] });
    expect(all.timedOut).toBe(false);
    expect((await connection.call('orchestrator.read', { token, sessionId: slow.sessionId })).text).toBe('Slow work done.');
  });

  it('steers another orchestrator only with the whole board as its scope', async () => {
    const setup = await orchestrateDaemon();
    const narrow = await agentSide(setup, setup.zone.id, 'zone');
    const wide = await agentSide(setup, setup.zone.id, 'board');

    await expect(narrow.connection.call('orchestrator.send', { token: narrow.token, sessionId: wide.agent.sessionId, text: 'close everything' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/is an orchestrator/),
    });
    await expect(narrow.connection.call('orchestrator.close', { token: narrow.token, sessionId: wide.agent.sessionId })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    // It may still watch it.
    expect((await narrow.connection.call('orchestrator.wait', { token: narrow.token, sessionIds: [wide.agent.sessionId] })).timedOut).toBe(false);
    await expect(wide.connection.call('orchestrator.send', { token: wide.token, sessionId: narrow.agent.sessionId, text: 'Carry on' })).resolves.toBeDefined();
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

  it('shows a session only its own tile’s lines', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id, 'zone');
    const other = await agentSide(setup, setup.zone.id);
    const leadHears = recordEvents(lead.connection);
    const otherHears = recordEvents(other.connection);
    await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'child', prompt: 'A secret plan' });

    // Live too: the event reaches the user and the lead, never another session.
    const isActivity = (e: DaemonEvent): e is OrchestratorActivityEvent => e.type === 'orchestrator.activity';
    await leadHears.waitFor(isActivity);
    await setup.recorder.waitFor(isActivity);
    expect(otherHears.events.filter(isActivity)).toEqual([]);

    expect(await other.connection.call('orchestrator.activity', {})).toEqual([]);
    expect(await other.connection.call('orchestrator.activity', { orchestratorId: lead.agent.sessionId })).toEqual([]);
    expect(await lead.connection.call('orchestrator.activity', {})).toHaveLength(1);
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

  it('tells an orchestrator so, and lists the control tools to it alone', async () => {
    const setup = await orchestrateDaemon();
    const lead = await agentSide(setup, setup.zone.id, 'zone');
    const plain = await agentSide(setup, setup.zone.id);

    const leadMcp = mcpAs(setup, lead.token);
    expect((await leadMcp.initialize()).instructions).toBe(`${BOARD_MCP_INSTRUCTIONS} ${ORCHESTRATOR_INSTRUCTIONS}`);
    expect(await leadMcp.listTools()).toEqual([
      'whoami', 'board', 'connections', 'handoff', 'set_status', 'new_agent', 'send', 'wait', 'read', 'interrupt', 'add_edge', 'list_edges', 'remove_edge', 'close',
    ]);

    const plainMcp = mcpAs(setup, plain.token);
    expect((await plainMcp.initialize()).instructions).toBe(BOARD_MCP_INSTRUCTIONS);
    expect(await plainMcp.listTools()).toEqual(['whoami', 'board', 'connections', 'handoff', 'set_status']);
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

  it('refuses an end outside its scope, or another orchestrator to send to unless its scope is the whole board, and logs it', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const mine = await userAgent(setup.client, setup.zone.id, 'mine');
    const elsewhere = await userAgent(setup.client, setup.other.id, 'elsewhere');
    const peer = await agentSide(setup, setup.zone.id, 'board');

    for (const [from, to] of [
      [mine.sessionId, elsewhere.sessionId],
      [elsewhere.sessionId, mine.sessionId],
      [mine.sessionId, peer.agent.sessionId],
    ] as const) {
      await expect(connection.call('orchestrator.addEdge', { token, from, to })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    }
    // Reading one is fine: an edge out of another orchestrator carries what it hands off, and steers no one.
    await connection.call('orchestrator.addEdge', { token, from: peer.agent.sessionId, to: mine.sessionId });
    // A whole-board orchestrator may wire into another.
    await peer.connection.call('orchestrator.addEdge', { token: peer.token, from: elsewhere.sessionId, to: me.sessionId });

    const log = await setup.client.call('orchestrator.activity', { orchestratorId: me.sessionId });
    expect(log.map(({ outcome }) => outcome)).toEqual(['done', 'refused', 'refused', 'refused']);
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

  it('never joins an edge into an agent the user ended, nor starts one again along an edge it made', async () => {
    const setup = await orchestrateDaemon();
    const { agent: me, token, connection } = await agentSide(setup, setup.zone.id, 'zone');
    const worker = await connection.call('orchestrator.spawn', { token, name: 'worker' });
    const edge = await connection.call('orchestrator.addEdge', { token, from: me.sessionId, to: worker.sessionId });
    await setup.client.call('agent.stop', { sessionId: worker.sessionId });
    await untilAgent(setup.recorder, worker.sessionId, (seen) => seen.endedAt !== null);

    const other = await connection.call('orchestrator.spawn', { token, name: 'other' });
    await setup.client.call('agent.stop', { sessionId: other.sessionId });
    await untilAgent(setup.recorder, other.sessionId, (seen) => seen.endedAt !== null);
    await expect(connection.call('orchestrator.addEdge', { token, from: me.sessionId, to: other.sessionId })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/has ended/),
    });

    // Its hand-off along the edge it made is skipped, saying why: the worker stays ended.
    expect(await connection.call('board.handoff', { token, message: 'Start again' })).toEqual([
      { edgeId: edge.id, to: worker.sessionId, outcome: 'skipped', name: 'message', reason: expect.stringMatching(/^worker has ended, and an edge an agent made never starts it again/) },
    ]);
    expect((await setup.client.call('agent.list')).find((agent) => agent.sessionId === worker.sessionId)!.endedAt).not.toBeNull();
  });

  it('removes only an edge it made', async () => {
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
        message: expect.stringMatching(/only edges it made/),
      });
    }
    expect(await setup.client.call('flowEdge.list')).toHaveLength(2);
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
