import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import type { Agent, DaemonEvent, HookEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, sendLogLines, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

/**
 * An orchestrator (the user's agent in a zone that lets agents orchestrate) that starts a worker on the fake harness
 * with `env` and messages it at once (`text`, `Carry on` by default), as a board agent does: the first message to a
 * worker still starting.
 */
async function startedAndMessaged(
  env: { startDelayMs?: number; startScreen?: 'folder-trust'; slowResume?: boolean; text?: string },
  worker: { harness?: 'claude' | 'codex'; prompt?: string },
  log: (message: string) => void = () => {},
) {
  const { text = 'Carry on', ...knobs } = env;
  const daemon = await startTestDaemon({
    log,
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200, ...knobs }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
  const lead = await client.call('agent.spawn', { zoneId: zone.id, name: 'lead', prompt: 'Print your board identity', ...SIZE });
  await client.call('session.attach', { sessionId: lead.sessionId });
  await recorder.waitForText(lead.sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(recorder.screenText(lead.sessionId))![1]!;
  const connection = await connectTestClient(daemon);
  await connection.call('board.identify', { token });
  const started = await connection.call('orchestrator.spawn', { token, name: 'worker', ...worker });
  await client.call('session.attach', { sessionId: started.sessionId });
  const sent = await connection.call('orchestrator.send', { token, sessionId: started.sessionId, text });
  const submitted = (e: DaemonEvent): e is HookEvent => e.type === 'hook' && e.sessionId === started.sessionId && e.event === 'UserPromptSubmit';
  const prompts = () => recorder.events.filter(submitted).map((e) => e.payload.prompt);
  const agent = async (): Promise<Agent> => (await client.call('agent.list')).find((a) => a.sessionId === started.sessionId)!;
  /** Waits until `count` prompts have been submitted. */
  const untilPrompts = (count: number) => recorder.waitFor((e): e is HookEvent => submitted(e) && prompts().length >= count);
  return { client, recorder, sent, started, prompts, agent, submitted, untilPrompts, connection, token };
}

describe("an orchestrator's first message to an agent it just started", () => {
  it.each([
    ['claude with a task', { startDelayMs: 600 }, { prompt: 'Write the handover' }, ['Write the handover', 'Carry on']],
    ['claude with no task', { startDelayMs: 600 }, {}, ['Carry on']],
    ['codex with no task', { startDelayMs: 600 }, { harness: 'codex' as const }, ['Carry on']],
  ])('waits for a slow start, then arrives after any first prompt: %s', async (_name, env, worker, expected) => {
    const { sent, recorder, prompts, agent, submitted, untilPrompts } = await startedAndMessaged(env, worker);
    expect(sent.delivery).toBe('queued-until-up');
    await untilPrompts(expected.length);
    expect(prompts().map((p) => String(p).replace(/^⟨[^⟩]*⟩ /, ''))).toEqual(expected);
    expect(recorder.events.filter(submitted)).toHaveLength(expected.length);
    expect(await agent()).toMatchObject({ unsent: null, queuedUntilUp: 0 });
  });

  it("is held while a Codex agent with no task shows its startup screen, never typed into it, and arrives once it is answered", async () => {
    const { client, recorder, sent, started, prompts, agent, untilPrompts } = await startedAndMessaged({ startScreen: 'folder-trust' }, { harness: 'codex' });
    expect(sent.delivery).toBe('queued-until-up');
    await recorder.waitForText(started.sessionId, 'Trust and continue');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(prompts()).toEqual([]);
    expect(recorder.screenText(started.sessionId)).not.toContain('Carry on');
    expect(await agent()).toMatchObject({ unsent: null, queuedUntilUp: 1 });

    await client.call('session.write', { sessionId: started.sessionId, data: '\r' });
    await untilPrompts(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(prompts().map((p) => String(p).replace(/^⟨[^⟩]*⟩ /, ''))).toEqual(['Carry on']);
    expect(await agent()).toMatchObject({ unsent: null, queuedUntilUp: 0 });
  });

  it('waits for a Codex agent resumed with no new prompt while its conversation is redrawn, then arrives once at its composer', async () => {
    // Its first message spans lines, the second looking like Codex's status line; resumed, Codex leaves that
    // conversation quiet on its screen before drawing its composer, and loses what is typed at it meanwhile.
    const { client, recorder, started, prompts, agent, untilPrompts, connection, token } = await startedAndMessaged(
      { slowResume: true, text: 'Carry on\ntests · then commit' },
      { harness: 'codex' },
    );
    await untilPrompts(1);
    await recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.sessionId === started.sessionId && e.event === 'Stop');
    await client.call('agent.pause', { sessionId: started.sessionId });
    await client.call('agent.resume', { sessionId: started.sessionId });
    await client.call('session.attach', { sessionId: started.sessionId });

    const sent = await connection.call('orchestrator.send', { token, sessionId: started.sessionId, text: 'Carry on again' });
    expect(sent.delivery).toBe('queued-until-up');
    await untilPrompts(2);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(prompts().map((p) => String(p).replace(/^⟨[^⟩]*⟩ /, ''))).toEqual(['Carry on\ntests · then commit', 'Carry on again']);
    // It carried on its conversation (`codex resume`), redrawing it above its composer: that past prompt, after the
    // composer's glyph, was not taken for it.
    expect(recorder.screenText(started.sessionId)).toMatch(/› (⟨[^⟩]*⟩ )?Carry on\r?\ntests · then commit\r?\n/);
    expect(await agent()).toMatchObject({ unsent: null, queuedUntilUp: 0, flag: null });
  });
});

describe("a send to an agent not up yet, in the daemon's log", () => {
  it('to one still starting is logged as queued, then typed and taken up once its session is up', async () => {
    const logs: string[] = [];
    const { started, untilPrompts } = await startedAndMessaged({ startDelayMs: 600 }, {}, (message) => void logs.push(message));
    await untilPrompts(1);

    await expect.poll(() => sendLogLines(logs, started.sessionId)).toEqual([
      ['8: queued until its session is up', '8: typing at its prompt, its session up', '8: turn started on it'],
    ]);
  });

  it('to a paused one is logged as waking it, then typed and taken up once its session is up', async () => {
    const logs: string[] = [];
    const { client, recorder, started, prompts, untilPrompts, connection, token } = await startedAndMessaged({}, {}, (message) => void logs.push(message));
    await untilPrompts(1);
    await recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.sessionId === started.sessionId && e.event === 'Stop');
    await client.call('agent.pause', { sessionId: started.sessionId });

    const sent = await connection.call('orchestrator.send', { token, sessionId: started.sessionId, text: 'Carry on again' });
    expect(sent.delivery).toBe('waking');
    await untilPrompts(2);
    expect(prompts().map((p) => String(p).replace(/^⟨[^⟩]*⟩ /, ''))).toEqual(['Carry on', 'Carry on again']);
    await expect.poll(() => sendLogLines(logs, started.sessionId).at(-1)).toEqual([
      '14: waking it with it, to be typed once its session is up',
      '14: typing at its prompt, its session up',
      '14: turn started on it',
    ]);
  });
});
