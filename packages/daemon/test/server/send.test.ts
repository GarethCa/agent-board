/**
 * A message sent to an agent, through the socket as the app and the agents send it, against a real daemon and fake
 * agents: delivered once when it is free, kept until it is when it is busy or not up yet, and never lost, a draft at
 * its prompt and a daemon restart included.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import type { Agent, AgentUpdatedEvent, DaemonEvent, HookEvent } from '../../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from '../helpers.ts';

const SIZE = { cols: 120, rows: 40 };

async function sendingDaemon(options: { dataDir?: string; home?: string; noSessionStart?: boolean; queueMidTurn?: boolean } = {}) {
  const daemon = await startTestDaemon({
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({
      scenario: 'orchestrate',
      home: options.home ?? tempDataDir(),
      idleNotifyMs: 200,
      repeat: true,
      ...(options.noSessionStart === true ? { noSessionStart: true } : {}),
      ...(options.queueMidTurn === true ? { queueMidTurn: true } : {}),
    }),
    submitConfirmMs: 100,
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  return { daemon, client, recorder };
}

type Setup = Awaited<ReturnType<typeof sendingDaemon>>;

async function untilAgent(recorder: Setup['recorder'], sessionId: string, match: (agent: Agent) => boolean): Promise<Agent> {
  const event = await recorder.waitFor(
    (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent),
  );
  return event.agent;
}

/** Every prompt the agent's harness has taken as a turn, in order. */
function prompts(recorder: Setup['recorder'], sessionId: string): string[] {
  return recorder.events.flatMap((event) =>
    event.type === 'hook' && event.sessionId === sessionId && event.event === 'UserPromptSubmit' ? [String(event.payload.prompt)] : [],
  );
}

async function untilPrompt(recorder: Setup['recorder'], sessionId: string, prompt: string) {
  await recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.sessionId === sessionId && e.event === 'UserPromptSubmit' && e.payload.prompt === prompt);
}

/** An agent in the zone that prints its board token, connected as it: the token presented, as its CLI does. */
async function leadOf(setup: Setup, zoneId: string) {
  const agent = await setup.client.call('agent.spawn', { zoneId, name: 'lead', prompt: 'Print your board identity', ...SIZE });
  await setup.client.call('session.attach', { sessionId: agent.sessionId });
  await setup.recorder.waitForText(agent.sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(setup.recorder.screenText(agent.sessionId))![1]!;
  const connection = await connectTestClient(setup.daemon);
  await connection.call('board.identify', { token });
  return { agent, token, connection };
}

const idle = (agent: Agent) => agent.state === 'idle' || agent.state === 'waiting';

/** An agent the host started with `prompt`, its screen attached, once its first turn is over. */
async function agentAtPrompt(setup: Setup, prompt = 'Say hello') {
  const zone = await setup.client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
  const agent = await setup.client.call('agent.spawn', { zoneId: zone.id, name: 'builder', prompt, ...SIZE });
  await setup.client.call('session.attach', { sessionId: agent.sessionId });
  await untilPrompt(setup.recorder, agent.sessionId, prompt);
  await untilAgent(setup.recorder, agent.sessionId, idle);
  return agent;
}

describe('a message sent to an agent', () => {
  it('at its prompt, is typed and taken as its next turn, once', async () => {
    const setup = await sendingDaemon();
    const agent = await agentAtPrompt(setup);

    expect(await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Add a test' })).toMatchObject({ queued: false });
    await untilPrompt(setup.recorder, agent.sessionId, 'Add a test');
    await untilAgent(setup.recorder, agent.sessionId, idle);
    expect(prompts(setup.recorder, agent.sessionId)).toEqual(['Say hello', 'Add a test']);
  });

  it('before its session is up, is queued and typed once it is, after its task', async () => {
    const setup = await sendingDaemon();
    const zone = await setup.client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
    const agent = await setup.client.call('agent.spawn', { zoneId: zone.id, name: 'builder', prompt: 'Say hello', ...SIZE });

    expect(await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Also lint' })).toEqual({ queued: true });
    await untilPrompt(setup.recorder, agent.sessionId, 'Also lint');
    await untilAgent(setup.recorder, agent.sessionId, idle);
    expect(prompts(setup.recorder, agent.sessionId)).toEqual(['Say hello', 'Also lint']);
  });

  it('mid-turn, is taken as a turn of its own after the current one', async () => {
    const setup = await sendingDaemon();
    const agent = await agentAtPrompt(setup);
    await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Work slowly' });
    await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.state === 'running');

    await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Then add a test' });
    await untilPrompt(setup.recorder, agent.sessionId, 'Then add a test');
    await untilAgent(setup.recorder, agent.sessionId, idle);
    expect(prompts(setup.recorder, agent.sessionId)).toEqual(['Say hello', 'Work slowly', 'Then add a test']);
    const screen = setup.recorder.screenText(agent.sessionId);
    expect(screen.indexOf('Slow work done.')).toBeGreaterThan(-1);
  }, 30_000);

  it('while the user has a line half typed at its prompt, never sends it as a turn, and keeps the message as unsent', async () => {
    const setup = await sendingDaemon();
    const agent = await agentAtPrompt(setup);
    await setup.client.call('session.write', { sessionId: agent.sessionId, data: 'my own dra' });
    await setup.recorder.waitForText(agent.sessionId, 'my own dra');

    await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Add a test' });
    // The user's half line is theirs to finish: no turn starts on it, and the message is flagged as typed but not sent.
    await vi.waitFor(async () => expect((await setup.client.call('agent.list'))[0]).toMatchObject({ unsent: 'A message' }));
    expect(prompts(setup.recorder, agent.sessionId)).toEqual(['Say hello']);
    expect(setup.recorder.screenText(agent.sessionId)).toContain('my own dra');
  });

  it('queued when the daemon stops, is kept for the user to send again after it starts, not lost', async () => {
    const dataDir = tempDataDir();
    const home = tempDataDir();
    const first = await sendingDaemon({ dataDir, home, noSessionStart: true });
    const zone = await first.client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
    const agent = await first.client.call('agent.spawn', { zoneId: zone.id, name: 'builder', ...SIZE });
    expect(await first.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Also lint' })).toEqual({ queued: true });
    await first.daemon.stop();

    const second = await sendingDaemon({ dataDir, home });
    expect((await second.client.call('agent.list'))[0]).toMatchObject({ undelivered: [{ what: 'A message', text: 'Also lint' }] });
    await second.client.call('session.attach', { sessionId: agent.sessionId });
    await second.client.call('agent.resendUndelivered', { sessionId: agent.sessionId });
    await untilPrompt(second.recorder, agent.sessionId, 'Also lint');
    await vi.waitFor(async () => expect((await second.client.call('agent.list'))[0]).toMatchObject({ undelivered: [] }));
  });

  it('from another agent mid-turn, waits in the database across a daemon restart, not lost', async () => {
    const dataDir = tempDataDir();
    const home = tempDataDir();
    const first = await sendingDaemon({ dataDir, home });
    const busy = await agentAtPrompt(first);
    const lead = await leadOf(first, busy.zoneId!);
    await first.client.call('agent.answer', { sessionId: busy.sessionId, text: 'Work slowly' });
    await untilAgent(first.recorder, busy.sessionId, (seen) => seen.state === 'running');
    expect(await lead.connection.call('orchestrator.send', { token: lead.token, sessionId: busy.sessionId, text: 'Then add a test' })).toMatchObject({
      delivery: 'queued-after-turn',
    });
    await first.daemon.stop();

    const second = await sendingDaemon({ dataDir, home });
    expect((await second.client.call('agent.list')).find((one) => one.sessionId === busy.sessionId)).toMatchObject({ state: 'stopped-by-restart' });
    await second.client.call('session.attach', { sessionId: busy.sessionId });
    await second.client.call('agent.resume', { sessionId: busy.sessionId });
    await second.recorder.waitFor(
      (e): e is HookEvent =>
        e.type === 'hook' && e.sessionId === busy.sessionId && e.event === 'UserPromptSubmit' && String(e.payload.prompt).endsWith('Then add a test'),
    );
    expect(prompts(second.recorder, busy.sessionId).filter((prompt) => prompt.includes('Then add a test'))).toHaveLength(1);
  }, 30_000);

  it('from the user mid-turn, is kept or flagged across a daemon restart, not lost', async () => {
    const dataDir = tempDataDir();
    const home = tempDataDir();
    const first = await sendingDaemon({ dataDir, home });
    const busy = await agentAtPrompt(first);
    await first.client.call('agent.answer', { sessionId: busy.sessionId, text: 'Work slowly' });
    await untilAgent(first.recorder, busy.sessionId, (seen) => seen.state === 'running');
    expect(await first.client.call('agent.answer', { sessionId: busy.sessionId, text: 'Then add a test' })).toMatchObject({ queued: false });
    await first.daemon.stop();

    // Its harness held it in its own queue, which went with it: handed back, for the user to send again.
    const second = await sendingDaemon({ dataDir, home });
    const after = (await second.client.call('agent.list')).find((one) => one.sessionId === busy.sessionId);
    expect(after).toMatchObject({ state: 'stopped-by-restart', undelivered: [{ what: 'A message', text: 'Then add a test' }] });
    await second.client.call('session.attach', { sessionId: busy.sessionId });
    await second.client.call('agent.resume', { sessionId: busy.sessionId });
    await untilAgent(second.recorder, busy.sessionId, idle);
    await second.client.call('agent.resendUndelivered', { sessionId: busy.sessionId });
    await untilPrompt(second.recorder, busy.sessionId, 'Then add a test');
    expect(prompts(second.recorder, busy.sessionId).filter((prompt) => prompt === 'Then add a test')).toHaveLength(1);
  }, 30_000);

  it('from the user mid-turn, taken at a step of that turn, is not handed back when the daemon stops before it ends', async () => {
    const dataDir = tempDataDir();
    const home = tempDataDir();
    // Claude takes what is typed mid-turn at its next step, writing it to its transcript with no prompt of its own.
    const first = await sendingDaemon({ dataDir, home, queueMidTurn: true });
    const busy = await agentAtPrompt(first);
    await first.client.call('agent.answer', { sessionId: busy.sessionId, text: 'Work slowly in two steps' });
    await untilAgent(first.recorder, busy.sessionId, (seen) => seen.state === 'running');
    await first.client.call('agent.answer', { sessionId: busy.sessionId, text: 'Then add a test' });
    // Its first step's end, where it takes the message; its second runs on as the daemon stops.
    const step = await first.recorder.waitFor(
      (e): e is HookEvent => e.type === 'hook' && e.sessionId === busy.sessionId && e.event === 'PostToolUse' && JSON.stringify(e.payload.tool_input).includes('sleep 3'),
    );
    const transcript = String(step.payload.transcript_path);
    const taken = () => readFileSync(transcript, 'utf8').split('\n').filter((line) => line.includes('Then add a test'));
    await vi.waitFor(() => expect(taken()).toHaveLength(1));
    await first.daemon.stop();

    const next = await sendingDaemon({ dataDir, home, queueMidTurn: true });
    expect((await next.client.call('agent.list')).find((one) => one.sessionId === busy.sessionId)).toMatchObject({ state: 'stopped-by-restart', undelivered: [] });
    await next.client.call('session.attach', { sessionId: busy.sessionId });
    await next.client.call('agent.resume', { sessionId: busy.sessionId });
    await untilAgent(next.recorder, busy.sessionId, idle);
    expect(taken()).toHaveLength(1);
    expect(prompts(next.recorder, busy.sessionId)).not.toContain('Then add a test');
  }, 40_000);
});
