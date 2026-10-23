import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv, type FakeScenario } from '@agent-board/fake-harness';
import { RPC_ERROR, type Agent, type AgentUpdatedEvent, type DaemonEvent, type Harness, type HookEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };

/** A daemon whose agents run the fakes' `scenario`, over `dataDir` and the fakes' `home` (fresh by default). */
async function pauseDaemon(scenario: FakeScenario, options: { dataDir?: string; home?: string; stepDelayMs?: number } = {}) {
  const home = options.home ?? tempDataDir();
  const dataDir = options.dataDir ?? tempDataDir();
  const daemon = await startTestDaemon({
    dataDir,
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario, home, idleNotifyMs: 200, stepDelayMs: options.stepDelayMs }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
  return { daemon, client, recorder, zone, home, dataDir };
}

type Setup = Awaited<ReturnType<typeof pauseDaemon>>;

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

/** Starts an agent on `Run the tests` and resolves once its turn has ended, at its prompt. */
async function idleAgent(setup: Setup, harness: Harness = 'claude') {
  const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, harness, prompt: 'Run the tests', ...SIZE });
  await hookAfter(setup, agent.sessionId, 'Stop', 0);
  return untilAgent(setup, agent.sessionId, (seen) => seen.state === 'idle' || seen.state === 'waiting');
}

/** The agent as the daemon lists it now. */
const listed = async (setup: Setup, sessionId: string) => (await setup.client.call('agent.list')).find((each) => each.sessionId === sessionId)!;

describe('pausing an agent', () => {
  it('hibernates an idle agent: its session ends, its pane drops into no shell, and it stays paused across a daemon restart', async () => {
    const setup = await pauseDaemon('output');
    const agent = await idleAgent(setup);

    const paused = await setup.client.call('agent.pause', { sessionId: agent.sessionId });

    expect(paused).toMatchObject({ state: 'hibernated', endedAt: expect.any(String), hibernated: { at: expect.any(String), by: null } });
    // Nothing of it runs: no harness, and no shell its pane dropped into.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await setup.client.call('session.list')).toEqual([]);
    expect(await listed(setup, agent.sessionId)).toMatchObject({ state: 'hibernated', shellSessionId: null });

    await setup.daemon.stop();
    const again = await pauseDaemon('output', { dataDir: setup.dataDir, home: setup.home });
    expect(await listed(again, agent.sessionId)).toMatchObject({ state: 'hibernated', hibernated: paused.hibernated });
  });

  it('refuses an agent mid-turn, one already paused or ended, and an unknown one', async () => {
    const setup = await pauseDaemon('output', { stepDelayMs: 300 });
    const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'Run the tests', ...SIZE });
    await untilAgent(setup, agent.sessionId, (seen) => seen.state === 'thinking');

    await expect(setup.client.call('agent.pause', { sessionId: agent.sessionId })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining("can't be paused: it is mid-turn"),
    });
    await hookAfter(setup, agent.sessionId, 'Stop', 0);
    await untilAgent(setup, agent.sessionId, (seen) => seen.state === 'idle' || seen.state === 'waiting');
    await setup.client.call('agent.pause', { sessionId: agent.sessionId });
    await expect(setup.client.call('agent.pause', { sessionId: agent.sessionId })).rejects.toMatchObject({
      message: expect.stringContaining('it is already paused'),
    });
    await expect(setup.client.call('agent.pause', { sessionId: 'nope' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });

    const stopped = await idleAgent(setup);
    await setup.client.call('agent.stop', { sessionId: stopped.sessionId });
    await expect(setup.client.call('agent.pause', { sessionId: stopped.sessionId })).rejects.toMatchObject({
      message: expect.stringContaining('it has ended'),
    });
  }, 15_000);
});

describe('pausing an agent twice at once', () => {
  it('refuses the second pause while the first is under way, and the agent is paused once', async () => {
    const setup = await pauseDaemon('output');
    const agent = await idleAgent(setup);

    const first = setup.client.call('agent.pause', { sessionId: agent.sessionId });
    const second = setup.client.call('agent.pause', { sessionId: agent.sessionId });

    await expect(second).rejects.toMatchObject({ code: RPC_ERROR.invalidParams, message: expect.stringContaining('it is already being paused') });
    expect(await first).toMatchObject({ state: 'hibernated' });
  });
});

describe('a pause racing a message', () => {
  it('refuses to pause an agent while a message is being sent to it, and the message lands', async () => {
    const setup = await pauseDaemon('output');
    const agent = await idleAgent(setup);
    const before = setup.recorder.events.length;

    const answered = setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Now run the linter' });
    const paused = setup.client.call('agent.pause', { sessionId: agent.sessionId });

    await expect(paused).rejects.toMatchObject({ code: RPC_ERROR.invalidParams, message: expect.stringContaining('a message is being sent to it') });
    await answered;
    expect((await hookAfter(setup, agent.sessionId, 'UserPromptSubmit', before)).payload).toMatchObject({ prompt: 'Now run the linter' });
    expect(await listed(setup, agent.sessionId)).toMatchObject({ endedAt: null, hibernated: null });
  });

  it('holds a message sent while the agent is being paused, and wakes it with the message once paused', async () => {
    const setup = await pauseDaemon('output');
    const agent = await idleAgent(setup);
    const before = setup.recorder.events.length;

    const paused = setup.client.call('agent.pause', { sessionId: agent.sessionId });
    const answered = setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Now run the linter' });

    expect(await paused).toMatchObject({ state: 'hibernated' });
    await answered;
    expect((await hookAfter(setup, agent.sessionId, 'SessionStart', before)).payload).toMatchObject({ source: 'resume' });
    expect((await hookAfter(setup, agent.sessionId, 'UserPromptSubmit', before)).payload).toMatchObject({ prompt: 'Now run the linter' });
    expect(await listed(setup, agent.sessionId)).toMatchObject({ endedAt: null, hibernated: null });
  });
});

describe('closing a paused agent', () => {
  it('leaves it ended, no longer paused, without waking it', async () => {
    const setup = await pauseDaemon('output');
    const agent = await idleAgent(setup);
    await setup.client.call('agent.pause', { sessionId: agent.sessionId });
    const before = setup.recorder.events.length;

    const closed = await setup.client.call('agent.stop', { sessionId: agent.sessionId });

    expect(closed).toMatchObject({ state: 'done', endedAt: expect.any(String), hibernated: null, shellSessionId: null });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await setup.client.call('session.list')).toEqual([]);
    expect(setup.recorder.events.slice(before).some((e) => e.type === 'hook' && e.sessionId === agent.sessionId)).toBe(false);
  });
});

describe.each<Harness>(['claude', 'codex'])('waking a paused %s agent', (harness) => {
  it('carries on its conversation when woken', async () => {
    const setup = await pauseDaemon('output');
    const agent = await idleAgent(setup, harness);
    const conversation = (await hookAfter(setup, agent.sessionId, 'SessionStart', 0)).payload.session_id;
    await setup.client.call('agent.pause', { sessionId: agent.sessionId });
    const before = setup.recorder.events.length;

    const woken = await setup.client.call('agent.resume', { sessionId: agent.sessionId });

    expect(woken).toMatchObject({ endedAt: null, state: 'idle', hibernated: null });
    expect((await hookAfter(setup, agent.sessionId, 'SessionStart', before)).payload).toMatchObject({ session_id: conversation });
    // At its prompt, not mid-turn: it takes a message, or a pause, again.
    expect(await listed(setup, agent.sessionId)).toMatchObject({ state: 'idle' });
    expect(await setup.client.call('agent.pause', { sessionId: agent.sessionId })).toMatchObject({ state: 'hibernated' });
  });

  it('wakes with a message as its first, in its own conversation', async () => {
    const setup = await pauseDaemon('output');
    const agent = await idleAgent(setup, harness);
    const conversation = (await hookAfter(setup, agent.sessionId, 'SessionStart', 0)).payload.session_id;
    await setup.client.call('agent.pause', { sessionId: agent.sessionId });
    const before = setup.recorder.events.length;

    await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Now run the linter' });

    expect((await hookAfter(setup, agent.sessionId, 'SessionStart', before)).payload).toMatchObject({ session_id: conversation });
    expect((await hookAfter(setup, agent.sessionId, 'UserPromptSubmit', before)).payload).toMatchObject({ prompt: 'Now run the linter' });
    expect(await listed(setup, agent.sessionId)).toMatchObject({ endedAt: null, hibernated: null });
  });
});
