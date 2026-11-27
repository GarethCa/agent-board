import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv, type FakeScenario } from '@agent-board/fake-harness';
import { RPC_ERROR, type Agent, type AgentUpdatedEvent, type DaemonEvent, type HookEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

/** A daemon whose agents play the fakes' `scenario`, with one zone. */
async function restDaemon(scenario: FakeScenario = 'orchestrate') {
  // Every prompt plays the scenario, not only the first: a later `Ask permission` asks.
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario, home: tempDataDir(), idleNotifyMs: 200, repeat: true }),
    backgroundPollMs: 200,
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
  return { daemon, client, recorder, zone };
}

type Setup = Awaited<ReturnType<typeof restDaemon>>;

/** Waits for an update to the agent, after the first `after` events, in which it matches `match`. */
async function untilAgent(setup: Setup, sessionId: string, match: (agent: Agent) => boolean, after = 0): Promise<Agent> {
  const event = await setup.recorder.waitFor(
    (e: DaemonEvent): e is AgentUpdatedEvent =>
      e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent) && setup.recorder.events.indexOf(e) >= after,
  );
  return event.agent;
}

/** Waits for the agent's `event` hook after the first `after` events. */
const hookAfter = (setup: Setup, sessionId: string, event: string, after: number) =>
  setup.recorder.waitFor(
    (e: DaemonEvent): e is HookEvent => e.type === 'hook' && e.sessionId === sessionId && e.event === event && setup.recorder.events.indexOf(e) >= after,
  );

/** Connects as the agent `sessionId`, whose first prompt was `Print your board identity`, once it is at its prompt. */
async function agentSideOf(setup: Setup, sessionId: string) {
  await setup.client.call('session.attach', { sessionId });
  await setup.recorder.waitForText(sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(setup.recorder.screenText(sessionId))![1]!;
  await untilAgent(setup, sessionId, (seen) => seen.state === 'idle' || seen.state === 'waiting');
  const connection = await connectTestClient(setup.daemon);
  await connection.call('board.identify', { token });
  return { token, connection };
}

/** Starts an agent the user owns that prints its board token, and connects as it. */
async function restingAgent(setup: Setup) {
  const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'Print your board identity', ...SIZE });
  return { agent, ...(await agentSideOf(setup, agent.sessionId)) };
}

const listed = async (setup: Setup, sessionId: string) => (await setup.client.call('agent.list')).find((each) => each.sessionId === sessionId)!;

describe('an agent resting', () => {
  it('shows its line, is paused by itself as its turn ends, and a message wakes it in its own conversation', async () => {
    const setup = await restDaemon();
    const { agent } = await restingAgent(setup);
    const conversation = (await hookAfter(setup, agent.sessionId, 'SessionStart', 0)).payload.session_id;

    await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Rest:   waiting for the review of PR #12' });
    const paused = await untilAgent(setup, agent.sessionId, (seen) => seen.hibernated !== null);
    expect(paused).toMatchObject({ hibernated: { byId: agent.sessionId }, status: expect.objectContaining({ summary: 'Resting · waiting for the review of PR #12' }) });
    await untilAgent(setup, agent.sessionId, (seen) => seen.state === 'hibernated');

    // Woken, it rests no more: its line drops "Resting", and its next turn ending leaves it running.
    const before = setup.recorder.events.length;
    await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Ask back: The review is in.' });
    expect((await hookAfter(setup, agent.sessionId, 'SessionStart', before)).payload).toMatchObject({ session_id: conversation });
    expect((await hookAfter(setup, agent.sessionId, 'UserPromptSubmit', before)).payload).toMatchObject({ prompt: 'Ask back: The review is in.' });
    await untilAgent(setup, agent.sessionId, (seen) => seen.status?.summary === 'waiting for the review of PR #12', before);
    await hookAfter(setup, agent.sessionId, 'Stop', before);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await listed(setup, agent.sessionId)).toMatchObject({ endedAt: null, hibernated: null });
  }, 20_000);

  it('rests by the CLI as by the MCP tool', async () => {
    const setup = await restDaemon();
    const { agent } = await restingAgent(setup);
    await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: "Rest by CLI: waiting for Sam's answer" });
    expect(await untilAgent(setup, agent.sessionId, (seen) => seen.hibernated !== null)).toMatchObject({
      hibernated: { byId: agent.sessionId },
      status: expect.objectContaining({ summary: "Resting · waiting for Sam's answer" }),
    });
  }, 20_000);

  it('asked at its prompt, between turns, pauses at once', async () => {
    const setup = await restDaemon();
    const { agent, token, connection } = await restingAgent(setup);
    const rested = await connection.call('board.rest', { token, line: 'waiting for the review' });
    expect(rested).toMatchObject({ pauses: true, agent: { status: expect.objectContaining({ summary: 'Resting · waiting for the review' }) } });
    expect(await untilAgent(setup, agent.sessionId, (seen) => seen.hibernated !== null)).toMatchObject({ hibernated: { byId: agent.sessionId } });
  }, 20_000);

  it('is left running, its line without "Resting", when it flags the user later in the turn it rested in', async () => {
    const setup = await restDaemon();
    const { agent } = await restingAgent(setup);
    const before = setup.recorder.events.length;
    await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Rest, then flag: waiting for the review' });
    await hookAfter(setup, agent.sessionId, 'Stop', before);
    await untilAgent(setup, agent.sessionId, (seen) => seen.status?.summary === 'waiting for the review', before);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await listed(setup, agent.sessionId)).toMatchObject({ endedAt: null, hibernated: null, flag: expect.objectContaining({ reason: 'Decision needed on the cache' }) });
  }, 20_000);

  it('rests on Codex too', async () => {
    const setup = await restDaemon();
    const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, harness: 'codex', prompt: 'Rest: waiting for the review', ...SIZE });
    expect(await untilAgent(setup, agent.sessionId, (seen) => seen.hibernated !== null, 0)).toMatchObject({
      hibernated: { byId: agent.sessionId },
      status: expect.objectContaining({ summary: 'Resting · waiting for the review' }),
    });
  }, 20_000);

  it('only sets its line with resting turned off in Settings', async () => {
    const setup = await restDaemon();
    await setup.client.call('settings.set', { agentsRest: false });
    const { agent, token, connection } = await restingAgent(setup);

    const rested = await connection.call('board.rest', { token, line: 'waiting for the review' });
    expect(rested).toMatchObject({ pauses: false, agent: { status: expect.objectContaining({ summary: 'waiting for the review' }) } });

    const before = setup.recorder.events.length;
    await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Rest: waiting for the linter' });
    await hookAfter(setup, agent.sessionId, 'Stop', before);
    await untilAgent(setup, agent.sessionId, (seen) => seen.status?.summary === 'waiting for the linter', before);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await listed(setup, agent.sessionId)).toMatchObject({ endedAt: null, hibernated: null });
  }, 20_000);

  it('refuses an empty or a too-long line, and an agent with its needs-you flag up, setting nothing', async () => {
    const setup = await restDaemon();
    const { agent, token, connection } = await restingAgent(setup);
    const before = (await listed(setup, agent.sessionId)).status;

    await expect(connection.call('board.rest', { token, line: '  ' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await expect(connection.call('board.rest', { token, line: 'x'.repeat(200) })).rejects.toMatchObject({ message: expect.stringContaining('Shorten it') });
    await connection.call('board.needsYou', { token, reason: 'Decision needed on the cache' });
    await expect(connection.call('board.rest', { token, line: 'waiting for a decision' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining('your needs_you flag is up'),
    });
    expect((await listed(setup, agent.sessionId)).status).toEqual(before);
  });

  it("refuses while the user's answer to a permission prompt is pending", async () => {
    const setup = await restDaemon();
    const { agent, token, connection } = await restingAgent(setup);
    await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Ask permission' });
    await untilAgent(setup, agent.sessionId, (seen) => seen.permissions.length > 0);

    await expect(connection.call('board.rest', { token, line: 'waiting for the review' })).rejects.toMatchObject({
      message: expect.stringContaining("the user's answer to your permission prompt, question or plan is pending"),
    });
  }, 20_000);

  it('refuses while a message waits for its turn to end', async () => {
    const setup = await restDaemon();
    const lead = await restingAgent(setup);
    const member = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'builder', prompt: 'Print your board identity' });
    const side = await agentSideOf(setup, member.sessionId);
    await lead.connection.call('orchestrator.send', { token: lead.token, sessionId: member.sessionId, text: 'Work slowly' });
    await untilAgent(setup, member.sessionId, (seen) => seen.state === 'running');
    expect(await lead.connection.call('orchestrator.send', { token: lead.token, sessionId: member.sessionId, text: 'Ask back: Now the linter.' })).toMatchObject({
      delivery: 'queued-after-turn',
    });

    await expect(side.connection.call('board.rest', { token: side.token, line: 'waiting for the review' })).rejects.toMatchObject({
      message: expect.stringContaining('a message waits at your prompt'),
    });
  }, 20_000);

  it('refuses while a command it started in the background still runs', async () => {
    const setup = await restDaemon('background');
    const gate = 'echo "$AGENT_BOARD_IDENTITY" > .token; for i in $(seq 1 300); do [ -e done ] && exit 0; sleep 0.1; done';
    const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt: gate, ...SIZE });
    await untilAgent(setup, agent.sessionId, (seen) => seen.state === 'on-command');
    const tokenFile = join(agent.worktree, '.token');
    await expect.poll(() => existsSync(tokenFile) && readFileSync(tokenFile, 'utf8').trim() !== '', { timeout: 10_000 }).toBe(true);
    const token = readFileSync(tokenFile, 'utf8').trim();
    const connection = await connectTestClient(setup.daemon);
    await connection.call('board.identify', { token });

    await expect(connection.call('board.rest', { token, line: 'waiting for the gate' })).rejects.toMatchObject({
      message: expect.stringContaining('a command you started in the background still runs'),
    });
    writeFileSync(join(agent.worktree, 'done'), '');
  }, 20_000);
});

describe('a lead watching its crew', () => {
  it('hears a crew member resting, with the line it rested with', async () => {
    const setup = await restDaemon();
    const lead = await restingAgent(setup);
    const member = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'builder', prompt: 'Print your board identity' });
    await agentSideOf(setup, member.sessionId);
    const since = (await lead.connection.call('orchestrator.wait', { token: lead.token, crew: true, since: 'now', timeoutMs: 1 })).cursor;

    // Its tile line changes after it rests: the lead hears what it rested with.
    await setup.client.call('agent.answer', { sessionId: member.sessionId, text: 'Rest, then status: waiting for the review' });

    await expect(lead.connection.call('orchestrator.wait', { token: lead.token, crew: true, since, kinds: ['resting'], timeoutMs: 10_000 })).resolves.toMatchObject({
      timedOut: false,
      events: [expect.objectContaining({ sessionId: member.sessionId, kind: 'resting', detail: 'waiting for the review' })],
    });
  }, 20_000);
});
