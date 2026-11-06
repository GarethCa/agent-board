import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import type { Agent, DaemonEvent, HookEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

/**
 * An orchestrator (the user's agent in a zone that lets agents orchestrate) that starts a worker on the fake harness
 * with `env` and messages it at once, as a board agent does: the first message to a worker still starting.
 */
async function startedAndMessaged(env: { startDelayMs?: number; startScreen?: 'folder-trust' }, worker: { harness?: 'claude' | 'codex'; prompt?: string }) {
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200, ...env }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
  const lead = await client.call('agent.spawn', { zoneId: zone.id, name: 'lead', prompt: 'Print your board identity', orchestrate: 'zone', ...SIZE });
  await client.call('session.attach', { sessionId: lead.sessionId });
  await recorder.waitForText(lead.sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(recorder.screenText(lead.sessionId))![1]!;
  const connection = await connectTestClient(daemon);
  await connection.call('board.identify', { token });
  const started = await connection.call('orchestrator.spawn', { token, name: 'worker', ...worker });
  await client.call('session.attach', { sessionId: started.sessionId });
  const sent = await connection.call('orchestrator.send', { token, sessionId: started.sessionId, text: 'Carry on' });
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

  it('waits for a Codex agent resumed with no new prompt, then arrives once', async () => {
    const { client, recorder, started, prompts, agent, untilPrompts, connection, token } = await startedAndMessaged({}, { harness: 'codex' });
    await untilPrompts(1);
    await recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.sessionId === started.sessionId && e.event === 'Stop');
    await client.call('agent.pause', { sessionId: started.sessionId });
    await client.call('agent.resume', { sessionId: started.sessionId });

    const sent = await connection.call('orchestrator.send', { token, sessionId: started.sessionId, text: 'Carry on again' });
    expect(sent.delivery).toBe('queued-until-up');
    await untilPrompts(2);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(prompts().map((p) => String(p).replace(/^⟨[^⟩]*⟩ /, ''))).toEqual(['Carry on', 'Carry on again']);
    expect(await agent()).toMatchObject({ unsent: null, queuedUntilUp: 0, flag: null });
  });
});
