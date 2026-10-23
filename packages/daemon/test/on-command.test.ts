import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { waitsForYou, type Agent, type AgentUpdatedEvent, type DaemonEvent, type Harness, type HookEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };

/** A command that runs until `done` appears in its folder, or 30 s pass, so it never outlives a test. */
const GATE = 'for i in $(seq 1 300); do [ -e done ] && exit 0; sleep 0.1; done';

/**
 * A daemon whose agents play the fake harnesses' `background` scenario, looking at the process table every 200 ms.
 * Claude's idle prompt lands a second after its turn ends, as real Claude's does a minute after: long after the first
 * look found the command.
 */
async function backgroundDaemon() {
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'background', home: tempDataDir(), idleNotifyMs: 1_000 }),
    backgroundPollMs: 200,
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
  const spawn = (harness: Harness) => client.call('agent.spawn', { zoneId: zone.id, harness, prompt: GATE, ...SIZE });
  const untilAgent = async (sessionId: string, match: (agent: Agent) => boolean, after = 0) =>
    (
      await recorder.waitFor(
        (e): e is AgentUpdatedEvent =>
          e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent) && recorder.events.indexOf(e) >= after,
      )
    ).agent;
  return { client, recorder, spawn, untilAgent };
}

/** The states an agent went through, as clients heard them, without repeats. */
function statesOf(events: DaemonEvent[], sessionId: string) {
  const states: string[] = [];
  for (const event of events) {
    if (event.type === 'agent.updated' && event.agent.sessionId === sessionId && states.at(-1) !== event.agent.state) states.push(event.agent.state);
  }
  return states;
}

describe('an agent on a command it left running in the background', () => {
  it("shows Claude's command and when it started, out of Needs you, until the command ends and its next turn starts", async () => {
    const { recorder, spawn, untilAgent } = await backgroundDaemon();
    const before = Date.now();
    const agent = await spawn('claude');

    const onCommand = await untilAgent(agent.sessionId, (a) => a.state === 'on-command');
    expect(onCommand.commands).toEqual([{ command: GATE, startedAt: expect.any(String) }]);
    expect(Date.parse(onCommand.commands[0]!.startedAt)).toBeGreaterThanOrEqual(before - 1_000);
    expect(waitsForYou(onCommand, 'turns')).toBe(false);

    // Its idle prompt fired after its turn: it still doesn't wait for you while the command runs.
    const idlePrompt = await recorder.waitFor(
      (e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'Notification',
    );
    const after = recorder.events.indexOf(idlePrompt);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(statesOf(recorder.events.slice(after), agent.sessionId).filter((state) => state !== 'on-command')).toEqual([]);

    // The command ends a second before Claude's turn reporting it sends a hook: idle meanwhile, never waiting for you.
    writeFileSync(join(agent.worktree, 'done'), '');
    const next = await untilAgent(agent.sessionId, (a) => a.lastMessage === 'The command finished.');
    expect(next).toMatchObject({ state: 'idle', commands: [] });
    expect(statesOf(recorder.events, agent.sessionId)).toEqual(['starting', 'running', 'thinking', 'running', 'thinking', 'on-command', 'idle']);
  });

  it("finds a Codex agent's command from its process tree, and falls back to idle once nothing runs, its turn long over", async () => {
    const { recorder, spawn, untilAgent } = await backgroundDaemon();
    const agent = await spawn('codex');

    const onCommand = await untilAgent(agent.sessionId, (a) => a.state === 'on-command');
    expect(onCommand.commands).toEqual([{ command: GATE, startedAt: expect.any(String) }]);

    const mark = recorder.events.length;
    writeFileSync(join(agent.worktree, 'done'), '');
    // No turn follows: the command's end alone takes it off.
    const idle = await untilAgent(agent.sessionId, (a) => a.state === 'idle', mark);
    expect(idle.commands).toEqual([]);
    expect(recorder.events.slice(mark).some((e) => e.type === 'hook' && e.sessionId === agent.sessionId)).toBe(false);
  });
});
