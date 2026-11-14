import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv, type FakeScenario } from '@agent-board/fake-harness';
import type { Daemon } from '../src/daemon.ts';
import type { Agent, AgentUpdatedEvent, DaemonEvent, SessionExitedEvent, SessionOutputEvent, SessionSnapshotEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };
const RESUME_LINE = 'Resume this session with:';
/** The conversation the screen showed, then under it, once, how to resume the session, which its harness printed last. */
const CONVERSATION_THEN_RESUME = /Run the tests[\s\S]*All tests pass\.[\s\S]*Resume this session with:/;

const count = (text: string, within: string) => within.split(text).length - 1;

/** A daemon whose agents run the fake Claude full-screen, as Claude Code's TUI runs, in the alternate screen. */
async function fullscreenDaemon(scenario: FakeScenario, dataDir = tempDataDir(), home = tempDataDir()) {
  const daemon = await startTestDaemon({
    dataDir,
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario, home, idleNotifyMs: 200, fullscreen: true }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  return { daemon, client, recorder, dataDir, home };
}

type Setup = Awaited<ReturnType<typeof fullscreenDaemon>>;

/** Starts an agent on `Run the tests`, attached, and resolves once its screen shows `text`. */
async function agentShowing({ client, recorder }: Setup, text: string): Promise<Agent> {
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
  const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Run the tests', ...SIZE });
  await client.call('session.attach', { sessionId: agent.sessionId });
  await recorder.waitForText(agent.sessionId, text);
  return agent;
}

const untilAgent = ({ recorder }: Setup, sessionId: string, match: (agent: Agent) => boolean) =>
  recorder
    .waitFor((e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent))
    .then((event) => event.agent);

/** What a client attaching to the session afresh is shown first: its snapshot. */
async function freshSnapshot(daemon: Daemon, sessionId: string): Promise<string> {
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  await client.call('session.attach', { sessionId });
  return (await recorder.waitFor((e: DaemonEvent): e is SessionSnapshotEvent => e.type === 'session.snapshot' && e.sessionId === sessionId)).data;
}

describe("a full-screen agent's last screen", () => {
  it('is the screen it showed when paused, with what its harness printed as it left that screen under it, after a restart too', async () => {
    const setup = await fullscreenDaemon('output');
    const agent = await agentShowing(setup, 'All tests pass.');
    await untilAgent(setup, agent.sessionId, (seen) => seen.state === 'idle' || seen.state === 'waiting');

    await setup.client.call('agent.pause', { sessionId: agent.sessionId });

    const paused = await freshSnapshot(setup.daemon, agent.sessionId);
    expect(paused).toMatch(CONVERSATION_THEN_RESUME);
    expect(count(RESUME_LINE, paused)).toBe(1);
    await setup.daemon.stop();
    const again = await fullscreenDaemon('output', setup.dataDir, setup.home);
    expect(await freshSnapshot(again.daemon, agent.sessionId)).toBe(paused);
  });

  it('is shown again to a client attached as it is paused, after what its harness printed, before it is told the session ended', async () => {
    const setup = await fullscreenDaemon('output');
    const agent = await agentShowing(setup, 'All tests pass.');
    await untilAgent(setup, agent.sessionId, (seen) => seen.state === 'idle' || seen.state === 'waiting');

    await setup.client.call('agent.pause', { sessionId: agent.sessionId });
    await setup.recorder.waitFor((e: DaemonEvent): e is SessionExitedEvent => e.type === 'session.exited' && e.sessionId === agent.sessionId);

    const ofSession = setup.recorder.events.filter(
      (e): e is SessionSnapshotEvent | SessionOutputEvent | SessionExitedEvent =>
        (e.type === 'session.snapshot' || e.type === 'session.output' || e.type === 'session.exited') && e.sessionId === agent.sessionId,
    );
    const last = ofSession.findLastIndex((e) => e.type === 'session.snapshot');
    const shown = ofSession.slice(last, -1).map((e) => (e.type === 'session.exited' ? '' : e.data)).join('');
    expect(ofSession.at(-1)!.type).toBe('session.exited');
    expect(last).toBeGreaterThan(0);
    expect(shown).toMatch(CONVERSATION_THEN_RESUME);
    expect(shown).toBe(await freshSnapshot(setup.daemon, agent.sessionId));
  });

  it('is the screen it showed when stopped', async () => {
    const setup = await fullscreenDaemon('output');
    const agent = await agentShowing(setup, 'All tests pass.');
    await untilAgent(setup, agent.sessionId, (seen) => seen.state === 'idle' || seen.state === 'waiting');

    await setup.client.call('agent.stop', { sessionId: agent.sessionId });

    const stopped = await freshSnapshot(setup.daemon, agent.sessionId);
    expect(stopped).toMatch(CONVERSATION_THEN_RESUME);
    expect(count(RESUME_LINE, stopped)).toBe(1);
  });

  it('is the screen it showed as its harness crashed, with the error it printed after leaving that screen under it, under the shell its pane drops into too', async () => {
    const setup = await fullscreenDaemon('crash');
    const agent = await agentShowing(setup, 'Starting work on');
    const ended = await untilAgent(setup, agent.sessionId, (seen) => seen.endedAt !== null && seen.shellSessionId != null);

    const crashed = await freshSnapshot(setup.daemon, agent.sessionId);
    expect(crashed).toMatch(/Starting work on[\s\S]*fatal: simulated crash/);
    expect(crashed).not.toContain(RESUME_LINE);
    expect(await freshSnapshot(setup.daemon, ended.shellSessionId!)).toMatch(/Starting work on[\s\S]*fatal: simulated crash/);
  });
});
