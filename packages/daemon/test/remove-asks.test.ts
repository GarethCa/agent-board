import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fakeHarnessEnv, McpClient } from '@agent-board/fake-harness';
import { BOARD_ERROR, needsYouKind, RPC_ERROR, type Agent, type AgentUpdatedEvent, type DaemonEvent, type RemoveAsk } from '../src/protocol.ts';
import type { DaemonClient } from '../src/client.ts';
import { BOARD_SOCKET_ENV, BOARD_TOKEN_ENV } from '../src/board-env.ts';
import { runBoardCommand } from '../src/board-cli.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, TEST_CLI_LAUNCHER, tempDataDir, tempRepo } from './helpers.ts';

/**
 * An orchestrator asks the user to remove tiles it did not start: one prompt for the batch, and nothing goes
 * until the user presses Allow.
 */

const SIZE = { cols: 120, rows: 40 };

/** A daemon whose agents play the fake `orchestrate` scenario, with a zone `web` and a zone `other` of another repo. */
async function setUp() {
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
  const other = await client.call('zone.add', { path: tempRepo('other'), x: 4000, y: 0, name: 'other' });
  return { daemon, client, recorder, zone, other };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

/** Waits for an update in which the agent matches `match`. */
async function untilAgent(setup: Setup, sessionId: string, match: (agent: Agent) => boolean): Promise<Agent> {
  const event = await setup.recorder.waitFor(
    (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent),
  );
  return event.agent;
}

/** An orchestrator in `zoneId`, connected as itself: its board token presented, as its CLI does. */
async function orchestratorIn(setup: Setup, zoneId: string) {
  const { daemon, client, recorder } = setup;
  const agent = await client.call('agent.spawn', { zoneId, name: 'master', prompt: 'Print your board identity', ...SIZE });
  await client.call('session.attach', { sessionId: agent.sessionId });
  await recorder.waitForText(agent.sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(recorder.screenText(agent.sessionId))![1]!;
  const connection = await connectTestClient(daemon);
  await connection.call('board.identify', { token });
  return { agent, token, connection };
}

/** A tile the user started in `zoneId`, at its prompt with nothing in its worktree. */
const userAgent = (client: DaemonClient, zoneId: string, name: string) => client.call('agent.spawn', { zoneId, name, ...SIZE });

/** A finished tile the user started: its session ended, its tile, worktree and branch kept. */
async function finishedAgent(setup: Setup, zoneId: string, name: string): Promise<Agent> {
  const agent = await userAgent(setup.client, zoneId, name);
  await setup.client.call('agent.stop', { sessionId: agent.sessionId });
  return untilAgent(setup, agent.sessionId, (seen) => seen.endedAt !== null && seen.shellSessionId !== null);
}

/** The names of the tiles on the board. */
const names = async (setup: Setup) => (await setup.client.call('agent.list')).map((agent) => agent.name);

/** The remove ask the orchestrator `sessionId` waits on, once the board shows it: a new one, not one already answered. */
const answered = new Set<string>();
async function askOf(setup: Setup, sessionId: string): Promise<RemoveAsk> {
  const ask = (await untilAgent(setup, sessionId, (seen) => seen.removeAsk !== null && !answered.has(seen.removeAsk.id))).removeAsk!;
  answered.add(ask.id);
  return ask;
}

/** A finished tile the user started, with a commit to review, and the reviewer the user started on it. */
async function reviewed(setup: Setup, zoneId: string): Promise<{ impl: Agent; reviewer: Agent }> {
  const impl = await finishedAgent(setup, zoneId, 'impl');
  git(impl.worktree, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '--allow-empty', '-q', '-m', 'the work');
  const round = await setup.client.call('review.start', { sessionId: impl.sessionId, ...SIZE });
  const reviewer = (await setup.client.call('agent.list')).find((agent) => agent.sessionId === round.reviewer)!;
  return { impl, reviewer };
}

/** Ends `agent`'s session, leaving `draft.txt` unsaved in its worktree. */
async function endedWithUnsavedWork(setup: Setup, agent: Agent): Promise<void> {
  await setup.client.call('agent.stop', { sessionId: agent.sessionId });
  await untilAgent(setup, agent.sessionId, (seen) => seen.endedAt !== null);
  writeFileSync(join(agent.worktree, 'draft.txt'), 'unsaved');
}

describe('asking the user to remove tiles', () => {
  it('shows one prompt for the batch, and removes each tile with its worktree only once the user allows it', async () => {
    const setup = await setUp();
    const { agent: me, token, connection } = await orchestratorIn(setup, setup.zone.id);
    const [a, b] = [await finishedAgent(setup, setup.zone.id, 'old-a'), await finishedAgent(setup, setup.zone.id, 'old-b')];

    const answer = connection.call('orchestrator.askRemove', { token, sessionIds: [a.sessionId, b.sessionId] });
    const ask = await askOf(setup, me.sessionId);
    expect(ask.tiles).toEqual([
      { sessionId: a.sessionId, name: 'old-a', held: null },
      { sessionId: b.sessionId, name: 'old-b', held: null },
    ]);
    const asking = (await setup.client.call('agent.list')).find((agent) => agent.sessionId === me.sessionId)!;
    expect(asking.state).toBe('waiting');
    expect(needsYouKind(asking, 'explicit')).toBe('asks');
    // Nothing is gone while the user hasn't answered.
    expect(await names(setup)).toEqual(expect.arrayContaining(['old-a', 'old-b']));

    const decided = await setup.client.call('removeAsk.decide', { sessionId: me.sessionId, askId: ask.id, allow: true });
    const told = await answer;
    expect(told).toEqual(decided);
    expect(told).toEqual({
      outcome: 'allowed',
      removed: [
        { sessionId: a.sessionId, name: 'old-a' },
        { sessionId: b.sessionId, name: 'old-b' },
      ],
      kept: [],
    });
    expect(await names(setup)).not.toEqual(expect.arrayContaining(['old-a']));
    expect(await names(setup)).not.toContain('old-b');
    expect((await setup.client.call('agent.list')).find((agent) => agent.sessionId === me.sessionId)!.removeAsk).toBeNull();

    const log = await setup.client.call('orchestrator.activity', { orchestratorId: me.sessionId });
    expect(log.map(({ action, outcome, targetName }) => `${action} ${outcome} ${targetName ?? ''}`.trim()).sort()).toEqual(['ask-remove done', 'remove done old-a', 'remove done old-b']);
  });

  it('removes nothing when the user denies it, and tells the orchestrator so', async () => {
    const setup = await setUp();
    const { agent: me, token, connection } = await orchestratorIn(setup, setup.zone.id);
    const a = await finishedAgent(setup, setup.zone.id, 'old-a');

    const answer = connection.call('orchestrator.askRemove', { token, sessionIds: [a.sessionId] });
    const ask = await askOf(setup, me.sessionId);
    await setup.client.call('removeAsk.decide', { sessionId: me.sessionId, askId: ask.id, allow: false });
    expect(await answer).toEqual({ outcome: 'denied', removed: [], kept: [{ sessionId: a.sessionId, name: 'old-a', why: 'the user denied it' }] });
    expect(await names(setup)).toContain('old-a');
    // Answered once: a second press finds no ask.
    await expect(setup.client.call('removeAsk.decide', { sessionId: me.sessionId, askId: ask.id, allow: true })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    expect(await names(setup)).toContain('old-a');
  });

  it('holds back a tile still running, or with a live agent it started, unless the user ticks it', async () => {
    const setup = await setUp();
    const { agent: me, token, connection } = await orchestratorIn(setup, setup.zone.id);
    const done = await finishedAgent(setup, setup.zone.id, 'done');
    const live = await userAgent(setup.client, setup.zone.id, 'live');
    const lead = await orchestratorIn(setup, setup.zone.id);
    const child = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'child' });
    await setup.client.call('agent.stop', { sessionId: lead.agent.sessionId });
    await untilAgent(setup, lead.agent.sessionId, (seen) => seen.endedAt !== null);

    const answer = connection.call('orchestrator.askRemove', { token, sessionIds: [done.sessionId, live.sessionId, lead.agent.sessionId] });
    const ask = await askOf(setup, me.sessionId);
    expect(ask.tiles).toEqual([
      { sessionId: done.sessionId, name: 'done', held: null },
      { sessionId: live.sessionId, name: 'live', held: expect.stringMatching(/^still running/) },
      { sessionId: lead.agent.sessionId, name: lead.agent.name, held: `${child.name}, an agent it started, is still running` },
    ]);
    // Only a tile in the ask may be ticked.
    await expect(setup.client.call('removeAsk.decide', { sessionId: me.sessionId, askId: ask.id, allow: true, include: [me.sessionId] })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });

    await setup.client.call('removeAsk.decide', { sessionId: me.sessionId, askId: ask.id, allow: true, include: [live.sessionId] });
    const told = await answer;
    expect(told.removed.map((tile) => tile.name)).toEqual(['done', 'live']);
    expect(told.kept).toEqual([{ sessionId: lead.agent.sessionId, name: lead.agent.name, why: expect.stringMatching(/^held back: .*is still running$/) }]);
    expect(await names(setup)).toEqual(expect.arrayContaining([lead.agent.name, child.name]));
    expect(await names(setup)).not.toContain('live');
  });

  it("keeps a tile with unsaved work, as the user's own Delete does, and removes the rest", async () => {
    const setup = await setUp();
    const { agent: me, token, connection } = await orchestratorIn(setup, setup.zone.id);
    const messy = await finishedAgent(setup, setup.zone.id, 'messy');
    writeFileSync(join(messy.worktree, 'draft.txt'), 'unsaved');
    const clean = await finishedAgent(setup, setup.zone.id, 'clean');

    const answer = connection.call('orchestrator.askRemove', { token, sessionIds: [messy.sessionId, clean.sessionId] });
    await setup.client.call('removeAsk.decide', { sessionId: me.sessionId, askId: (await askOf(setup, me.sessionId)).id, allow: true });
    const told = await answer;
    expect(told.removed).toEqual([{ sessionId: clean.sessionId, name: 'clean' }]);
    expect(told.kept).toEqual([{ sessionId: messy.sessionId, name: 'messy', why: expect.stringMatching(/unsaved|uncommitted/i) }]);
    expect(await names(setup)).toContain('messy');
  });

  it('keeps a tile whose reviewer in the ask is held back and not ticked, and its reviewer with it', async () => {
    const setup = await setUp();
    const { agent: me, token, connection } = await orchestratorIn(setup, setup.zone.id);
    const { impl, reviewer } = await reviewed(setup, setup.zone.id);

    const answer = connection.call('orchestrator.askRemove', { token, sessionIds: [impl.sessionId, reviewer.sessionId] });
    const ask = await askOf(setup, me.sessionId);
    expect(ask.tiles).toEqual([
      { sessionId: impl.sessionId, name: 'impl', held: `its reviewer ${reviewer.name} is held back` },
      { sessionId: reviewer.sessionId, name: reviewer.name, held: expect.stringMatching(/^still running/) },
    ]);
    // The user ticks the implementer and leaves its running reviewer out: a Delete of one would take the other.
    await setup.client.call('removeAsk.decide', { sessionId: me.sessionId, askId: ask.id, allow: true, include: [impl.sessionId] });
    const told = await answer;
    expect(told.removed).toEqual([]);
    expect(told.kept).toEqual([
      { sessionId: impl.sessionId, name: 'impl', why: `its reviewer ${reviewer.name} stays, and its Delete would take it` },
      { sessionId: reviewer.sessionId, name: reviewer.name, why: expect.stringMatching(/^held back: still running/) },
    ]);
    expect(await names(setup)).toEqual(expect.arrayContaining(['impl', reviewer.name]));
  });

  it('keeps a tile whose reviewer in the ask has unsaved work, never forcing the reviewer', async () => {
    const setup = await setUp();
    const { agent: me, token, connection } = await orchestratorIn(setup, setup.zone.id);
    const { impl, reviewer } = await reviewed(setup, setup.zone.id);
    await endedWithUnsavedWork(setup, reviewer);

    const answer = connection.call('orchestrator.askRemove', { token, sessionIds: [impl.sessionId, reviewer.sessionId] });
    const ask = await askOf(setup, me.sessionId);
    expect(ask.tiles.map((tile) => tile.held)).toEqual([null, null]);
    await setup.client.call('removeAsk.decide', { sessionId: me.sessionId, askId: ask.id, allow: true });
    const told = await answer;
    expect(told.removed).toEqual([]);
    expect(told.kept).toEqual([
      { sessionId: impl.sessionId, name: 'impl', why: `its reviewer ${reviewer.name} stays, and its Delete would take it` },
      { sessionId: reviewer.sessionId, name: reviewer.name, why: expect.stringMatching(/unsaved|uncommitted/i) },
    ]);
    expect(await names(setup)).toEqual(expect.arrayContaining(['impl', reviewer.name]));
  });

  it('holds back a tile whose reviewer the ask leaves out; ticked, the reviewer goes too unless it has unsaved work', async () => {
    const setup = await setUp();
    const { agent: me, token, connection } = await orchestratorIn(setup, setup.zone.id);
    const { impl, reviewer } = await reviewed(setup, setup.zone.id);
    await endedWithUnsavedWork(setup, reviewer);

    const first = connection.call('orchestrator.askRemove', { token, sessionIds: [impl.sessionId] });
    const ask = await askOf(setup, me.sessionId);
    expect(ask.tiles).toEqual([{ sessionId: impl.sessionId, name: 'impl', held: `its reviewer ${reviewer.name} would go with it` }]);
    await setup.client.call('removeAsk.decide', { sessionId: me.sessionId, askId: ask.id, allow: true });
    expect(await first).toEqual({ outcome: 'allowed', removed: [], kept: [{ sessionId: impl.sessionId, name: 'impl', why: `held back: its reviewer ${reviewer.name} would go with it` }] });

    // Ticked, its reviewer with unsaved work refuses the Delete, so both stay.
    const second = connection.call('orchestrator.askRemove', { token, sessionIds: [impl.sessionId] });
    const again = await askOf(setup, me.sessionId);
    await setup.client.call('removeAsk.decide', { sessionId: me.sessionId, askId: again.id, allow: true, include: [impl.sessionId] });
    expect((await second).kept).toEqual([{ sessionId: impl.sessionId, name: 'impl', why: expect.stringMatching(/unsaved|uncommitted/i) }]);
    expect(await names(setup)).toEqual(expect.arrayContaining(['impl', reviewer.name]));

    // With its work gone, ticked, both go, and the orchestrator is told of the reviewer too.
    git(reviewer.worktree, 'clean', '-fdq');
    git(impl.worktree, 'branch', 'keeps-the-work');
    const third = connection.call('orchestrator.askRemove', { token, sessionIds: [impl.sessionId] });
    const last = await askOf(setup, me.sessionId);
    await setup.client.call('removeAsk.decide', { sessionId: me.sessionId, askId: last.id, allow: true, include: [impl.sessionId] });
    expect(await third).toEqual({
      outcome: 'allowed',
      removed: [
        { sessionId: impl.sessionId, name: 'impl' },
        { sessionId: reviewer.sessionId, name: reviewer.name },
      ],
      kept: [],
    });
    expect(await names(setup)).not.toEqual(expect.arrayContaining(['impl']));
    expect(await names(setup)).not.toContain(reviewer.name);
  });

  it('refuses the whole ask when any tile is itself, and asks nothing', async () => {
    const setup = await setUp();
    const { agent: me, token, connection } = await orchestratorIn(setup, setup.zone.id);
    const mine = await finishedAgent(setup, setup.zone.id, 'mine');
    const far = await finishedAgent(setup, setup.other.id, 'far');

    for (const sessionIds of [[me.sessionId], [mine.sessionId, far.sessionId, me.sessionId]]) {
      await expect(connection.call('orchestrator.askRemove', { token, sessionIds })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    }
    for (const sessionIds of [[], [mine.sessionId, mine.sessionId], 'mine']) {
      await expect(connection.call('orchestrator.askRemove', { token, sessionIds: sessionIds as string[] })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    }
    // The user removes tiles themselves: there is no one else to ask.
    await expect(setup.client.call('orchestrator.askRemove', { sessionIds: [mine.sessionId] })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    expect((await setup.client.call('agent.list')).find((agent) => agent.sessionId === me.sessionId)!.removeAsk).toBeNull();
    expect(await names(setup)).toEqual(expect.arrayContaining(['mine', 'far']));
  });

  it('asks for a tile another orchestrator started in another zone, as for any tile it did not start', async () => {
    const setup = await setUp();
    const { agent: me, token, connection } = await orchestratorIn(setup, setup.zone.id);
    const lead = await orchestratorIn(setup, setup.other.id);
    const far = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'far' });
    await setup.client.call('agent.stop', { sessionId: far.sessionId });
    await untilAgent(setup, far.sessionId, (seen) => seen.endedAt !== null);

    await expect(connection.call('orchestrator.close', { token, sessionId: far.sessionId, remove: true })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/--remove --ask/),
    });
    expect(await names(setup)).toContain('far');
    const answer = connection.call('orchestrator.askRemove', { token, sessionIds: [far.sessionId] });
    const ask = await askOf(setup, me.sessionId);
    expect(ask.tiles).toEqual([{ sessionId: far.sessionId, name: 'far', held: null }]);
    expect(await names(setup)).toContain('far');
    await setup.client.call('removeAsk.decide', { sessionId: me.sessionId, askId: ask.id, allow: true });
    expect(await answer).toEqual({ outcome: 'allowed', removed: [{ sessionId: far.sessionId, name: 'far' }], kept: [] });
    expect(await names(setup)).not.toContain('far');
  });

  it('never lets an orchestrator, or any board token, answer an ask', async () => {
    const setup = await setUp();
    const { agent: me, token, connection } = await orchestratorIn(setup, setup.zone.id);
    const a = await finishedAgent(setup, setup.zone.id, 'old-a');
    const answer = connection.call('orchestrator.askRemove', { token, sessionIds: [a.sessionId], timeoutMs: 2_000 });
    const ask = await askOf(setup, me.sessionId);

    await expect(connection.call('removeAsk.decide', { sessionId: me.sessionId, askId: ask.id, allow: true })).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
    const other = await orchestratorIn(setup, setup.zone.id);
    await expect(other.connection.call('removeAsk.decide', { sessionId: me.sessionId, askId: ask.id, allow: true })).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
    // A second ask waits for the first.
    await expect(connection.call('orchestrator.askRemove', { token, sessionIds: [a.sessionId] })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });

    expect(await answer).toEqual({ outcome: 'timed-out', removed: [], kept: [{ sessionId: a.sessionId, name: 'old-a', why: 'no answer came' }] });
    expect(await names(setup)).toContain('old-a');
  });

  it('withdraws the ask, removing nothing, when the orchestrator stops waiting', async () => {
    const setup = await setUp();
    const { agent: me, token, connection } = await orchestratorIn(setup, setup.zone.id);
    const a = await finishedAgent(setup, setup.zone.id, 'old-a');
    void connection.call('orchestrator.askRemove', { token, sessionIds: [a.sessionId] }).catch(() => undefined);
    const ask = await askOf(setup, me.sessionId);

    connection.close();
    await vi.waitFor(async () => expect((await setup.client.call('agent.list')).find((agent) => agent.sessionId === me.sessionId)!.removeAsk).toBeNull(), { timeout: 5_000 });
    await expect(setup.client.call('removeAsk.decide', { sessionId: me.sessionId, askId: ask.id, allow: true })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    expect(await names(setup)).toContain('old-a');
  });

  it("withdraws the ask, removing nothing, once the orchestrator's next turn begins, and says that is why", async () => {
    const setup = await setUp();
    const { agent: me, token, connection } = await orchestratorIn(setup, setup.zone.id);
    const a = await finishedAgent(setup, setup.zone.id, 'old-a');
    const answer = connection.call('orchestrator.askRemove', { token, sessionIds: [a.sessionId] });
    const ask = await askOf(setup, me.sessionId);

    await setup.client.call('session.write', { sessionId: me.sessionId, data: 'Print your board identity\r' });
    expect(await answer).toEqual({ outcome: 'denied', removed: [], kept: [{ sessionId: a.sessionId, name: 'old-a', why: expect.stringMatching(/your next turn began/) }] });
    await expect(setup.client.call('removeAsk.decide', { sessionId: me.sessionId, askId: ask.id, allow: true })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    expect(await names(setup)).toContain('old-a');
  });
});

describe('the ask from the CLI and the MCP', () => {
  it('asks with close --remove --ask for several refs, and with ask_to_remove, and says what the user decided', async () => {
    const setup = await setUp();
    const { agent: me, token } = await orchestratorIn(setup, setup.zone.id);
    const [a, b] = [await finishedAgent(setup, setup.zone.id, 'old-a'), await finishedAgent(setup, setup.zone.id, 'old-b')];
    const env = { [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: token };

    let out = '';
    const io = { out: (text: string) => (out += text), err: (text: string) => (out += text), env };
    // Several refs only with --ask.
    expect(await runBoardCommand('close', ['old-a', 'old-b', '--remove'], io)).toBe(2);
    out = '';
    const command = runBoardCommand('close', ['old-a', 'old-b', '--remove', '--ask'], io);
    let ask = await askOf(setup, me.sessionId);
    await setup.client.call('removeAsk.decide', { sessionId: me.sessionId, askId: ask.id, allow: false });
    expect(await command).toBe(0);
    expect(out).toMatch(/^The user denied removing old-a and old-b: nothing was removed\./);

    const mcp = new McpClient(
      { command: TEST_CLI_LAUNCHER.command, args: [...TEST_CLI_LAUNCHER.args, 'mcp'], env: { ...process.env, AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: token } },
      tempDataDir(),
    );
    const tool = mcp.callTool('ask_to_remove', { agents: ['old-a', 'old-b'] });
    ask = await askOf(setup, me.sessionId);
    expect(ask.tiles.map((tile) => tile.sessionId)).toEqual([a.sessionId, b.sessionId]);
    await setup.client.call('removeAsk.decide', { sessionId: me.sessionId, askId: ask.id, allow: true });
    expect(await tool).toMatchObject({ isError: false, text: expect.stringMatching(/^The user allowed it\. Removed old-a and old-b, with their worktrees and branches\./) });
    expect(await names(setup)).not.toContain('old-a');
  });
});
