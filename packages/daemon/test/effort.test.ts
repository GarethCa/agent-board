// Changing a running agent's reasoning effort: typed at its prompt as the user would, only between turns, or kept for
// its next start when its harness can't change it live.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { RPC_ERROR, type Agent, type AgentUpdatedEvent, type DaemonEvent, type Harness, type HookEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };

async function effortDaemon(stepDelayMs = 0, env: Record<string, string> = {}) {
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: { ...fakeHarnessEnv({ scenario: 'output', home: tempDataDir(), idleNotifyMs: 200, stepDelayMs }), ...env },
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
  return { client, recorder, zone };
}

type Setup = Awaited<ReturnType<typeof effortDaemon>>;

const hook = (setup: Setup, sessionId: string, event: string) =>
  setup.recorder.waitFor((e: DaemonEvent): e is HookEvent => e.type === 'hook' && e.sessionId === sessionId && e.event === event);

const untilAgent = async (setup: Setup, sessionId: string, match: (agent: Agent) => boolean) =>
  (await setup.recorder.waitFor((e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent))).agent;

/** Starts an agent on `Run the tests` and resolves once its turn has ended, at its prompt. */
async function idleAgent(setup: Setup, harness: Harness = 'claude') {
  const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, harness, prompt: 'Run the tests', ...SIZE });
  await setup.client.call('session.attach', { sessionId: agent.sessionId });
  await hook(setup, agent.sessionId, 'Stop');
  return untilAgent(setup, agent.sessionId, (seen) => seen.state === 'idle' || seen.state === 'waiting');
}

/** The command line of the agent's session now. */
async function commandOf(setup: Setup, sessionId: string): Promise<string> {
  const session = (await setup.client.call('session.list')).find((each) => each.id === sessionId)!;
  return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(session.pid)], { encoding: 'utf8' });
}

/** Stops the agent and starts it again, as Restart does. */
async function restart(setup: Setup, sessionId: string) {
  await setup.client.call('agent.stop', { sessionId });
  return setup.client.call('agent.resume', { sessionId });
}

describe("changing a running agent's reasoning effort", () => {
  it('types /effort at a Claude agent between turns, as the user would, and starts it at that effort again', async () => {
    const setup = await effortDaemon();
    const agent = await idleAgent(setup);

    const changed = await setup.client.call('agent.setEffort', { sessionId: agent.sessionId, effort: 'max' });

    expect(changed).toMatchObject({ applies: 'now', agent: { effort: 'max', effortPending: null } });
    await setup.recorder.waitForText(agent.sessionId, 'Set effort level to max');
    await restart(setup, agent.sessionId);
    expect(await commandOf(setup, agent.sessionId)).toContain('--effort max');
  });

  it('stays at its prompt should Claude fire UserPromptSubmit for the /effort it was typed, as it starts no turn', async () => {
    // Claude's idle_prompt comes a minute after: nothing else puts its state right meanwhile.
    const setup = await effortDaemon(0, { FAKE_HARNESS_LOCAL_COMMAND_HOOK: '1', FAKE_HARNESS_IDLE_NOTIFY_MS: '60000' });
    const agent = await idleAgent(setup);

    await setup.client.call('agent.setEffort', { sessionId: agent.sessionId, effort: 'high' });
    await setup.recorder.waitForText(agent.sessionId, 'Set effort level to high');
    await hook(setup, agent.sessionId, 'UserPromptSubmit');
    await new Promise((resolve) => setTimeout(resolve, 500));

    const now = (await setup.client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!;
    expect(now.state === 'idle' || now.state === 'waiting').toBe(true);
  });

  it('never types into a turn: one under way gets it once that turn ends', async () => {
    const setup = await effortDaemon(400);
    const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'Run the tests', ...SIZE });
    await setup.client.call('session.attach', { sessionId: agent.sessionId });
    await hook(setup, agent.sessionId, 'UserPromptSubmit');

    const changed = await setup.client.call('agent.setEffort', { sessionId: agent.sessionId, effort: 'low' });

    expect(changed).toMatchObject({ applies: 'after-turn', agent: { effort: 'low', effortPending: 'after-turn' } });
    expect(setup.recorder.screenText(agent.sessionId)).not.toContain('/effort');
    await setup.recorder.waitForText(agent.sessionId, 'Set effort level to low');
    const screen = setup.recorder.screenText(agent.sessionId);
    expect(screen.indexOf('Done: Run the tests')).toBeLessThan(screen.indexOf('Set effort level to low'));
    await untilAgent(setup, agent.sessionId, (seen) => seen.effortPending === null);
  });

  it('keeps a Codex agent’s for its next start, typing nothing, as Codex has no command to change it', async () => {
    const setup = await effortDaemon();
    const agent = await idleAgent(setup, 'codex');

    const changed = await setup.client.call('agent.setEffort', { sessionId: agent.sessionId, effort: 'xhigh' });

    expect(changed).toMatchObject({ applies: 'restart', agent: { effort: 'xhigh', effortPending: 'restart' } });
    expect(setup.recorder.screenText(agent.sessionId)).not.toContain('/effort');
    const restarted = await restart(setup, agent.sessionId);
    expect(restarted.effortPending).toBeNull();
    expect(await commandOf(setup, agent.sessionId)).toContain('model_reasoning_effort="xhigh"');
  });

  it('keeps an ended agent’s for its next start', async () => {
    const setup = await effortDaemon();
    const agent = await idleAgent(setup);
    await setup.client.call('agent.stop', { sessionId: agent.sessionId });

    const changed = await setup.client.call('agent.setEffort', { sessionId: agent.sessionId, effort: 'high' });

    expect(changed).toMatchObject({ applies: 'restart', agent: { effort: 'high', effortPending: null } });
    await setup.client.call('agent.resume', { sessionId: agent.sessionId });
    expect(await commandOf(setup, agent.sessionId)).toContain('--effort high');
  });

  it('goes back to the harness’s own when it next starts, as no command sets that live', async () => {
    const setup = await effortDaemon();
    const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'Run the tests', effort: 'max', ...SIZE });
    await setup.client.call('session.attach', { sessionId: agent.sessionId });
    await hook(setup, agent.sessionId, 'Stop');

    const changed = await setup.client.call('agent.setEffort', { sessionId: agent.sessionId, effort: null });

    expect(changed).toMatchObject({ applies: 'restart', agent: { effort: null, effortPending: 'restart' } });
    expect(setup.recorder.screenText(agent.sessionId)).not.toContain('/effort');
    expect((await restart(setup, agent.sessionId)).effortPending).toBeNull();
    expect(await commandOf(setup, agent.sessionId)).not.toContain('--effort');
  });

  it('start at their role’s level from Settings, whatever case the role is typed in', async () => {
    const setup = await effortDaemon();
    await setup.client.call('settings.set', { roleEfforts: { designer: 'high' } });

    const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'Draw it', role: 'Designer', ...SIZE });

    expect(agent.effort).toBe('high');
    expect(await commandOf(setup, agent.sessionId)).toContain('--effort high');
  });

  it('changes nothing when set to its harness’s own while it is already', async () => {
    const setup = await effortDaemon();
    const agent = await idleAgent(setup);
    expect(await setup.client.call('agent.setEffort', { sessionId: agent.sessionId, effort: null })).toMatchObject({ applies: 'now', agent: { effort: null, effortPending: null } });
  });

  it('refuses a level its harness does not take, changing nothing', async () => {
    const setup = await effortDaemon();
    const agent = await idleAgent(setup, 'codex');

    await expect(setup.client.call('agent.setEffort', { sessionId: agent.sessionId, effort: 'max' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: 'Codex takes a reasoning effort of low, medium, high or xhigh',
    });
    expect((await setup.client.call('agent.list'))[0]!.effort).toBeNull();
  });
});
