import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv, type FakeScenario } from '@agent-board/fake-harness';
import type { DaemonClient } from '../src/client.ts';
import { RPC_ERROR, type Agent, type AgentUpdatedEvent, type ClockData, type ClockStatus, type ClockUpdatedEvent, type DaemonEvent, type HookEvent } from '../src/protocol.ts';
import { daemonPaths } from '../src/paths.ts';
import { createFakeClock } from './fake-clock.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';
import { pinTimeZone } from './pin-time-zone.ts';

pinTimeZone('Europe/London');

const SIZE = { cols: 100, rows: 30 };
/** A Saturday morning, and the next fire time of `0 8 * * *`. */
const START = new Date(2026, 9, 10, 7, 30);
const EIGHT = new Date(2026, 9, 10, 8, 0);

async function clockDaemon(scenario: FakeScenario = 'output', dataDir = tempDataDir()) {
  const clock = createFakeClock(START);
  const daemon = await startTestDaemon({
    dataDir,
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario, home: tempDataDir(), idleNotifyMs: 200 }),
    clock,
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
  return { daemon, client, recorder, clock, zone, dataDir };
}

/** Waits for an update after the first `after` events the recorder saw in which the agent matches `match`. */
async function untilAgent(recorder: ReturnType<typeof recordEvents>, sessionId: string, match: (agent: Agent) => boolean, after = 0): Promise<Agent> {
  const event = await recorder.waitFor(
    (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent) && recorder.events.indexOf(e) >= after,
  );
  return event.agent;
}

/** Waits for the clock's status to match `match`. */
async function untilStatus(recorder: ReturnType<typeof recordEvents>, clockId: string, match: (status: ClockStatus) => boolean): Promise<ClockStatus> {
  const event = await recorder.waitFor((e: DaemonEvent): e is ClockUpdatedEvent => e.type === 'clock.updated' && e.status.id === clockId && match(e.status));
  return event.status;
}

const freshClock = (client: DaemonClient, zoneId: string, data: Partial<ClockData>) =>
  client.call('clock.add', { place: { zoneId, x: 40, y: 40 }, data: { cron: '0 8 * * *', does: 'fresh', prompt: 'Check the deps', ...data } });

describe('clocks', () => {
  it('starts a fresh agent at each fire time, keeps its final message in the history, leaves a note and closes it', async () => {
    const { client, recorder, clock, zone } = await clockDaemon();
    const made = await freshClock(client, zone.id, { result: 'note' });
    expect(made).toMatchObject({ kind: 'clock', zoneId: zone.id, x: 40, y: 40, width: 256, height: 76 });
    expect(await client.call('clock.list')).toEqual([{ id: made.id, nextRunAt: EIGHT.toISOString(), runs: [] }]);

    clock.advanceTo(EIGHT);
    const running = await untilStatus(recorder, made.id, (status) => status.runs[0]?.sessionId != null);
    const [run] = running.runs;
    expect(run).toMatchObject({ outcome: 'running', agentName: 'Check the deps #1', dueAt: EIGHT.toISOString() });
    // Its tile goes under the clock, in its zone.
    expect((await client.call('agent.list')).find((agent) => agent.sessionId === run!.sessionId)).toMatchObject({
      zoneId: zone.id,
      name: 'Check the deps #1',
      position: { x: 40, y: 40 + 76 + 24 },
    });

    const done = await untilStatus(recorder, made.id, (status) => status.runs[0]?.outcome === 'done');
    expect(done.runs[0]).toMatchObject({ result: 'All tests pass.', reason: null, finishedAt: expect.any(String) });
    expect((await client.call('agent.list')).some((agent) => agent.sessionId === run!.sessionId)).toBe(false);
    const notes = (await client.call('item.list')).filter((item) => item.kind === 'agent-note');
    expect(notes).toEqual([
      expect.objectContaining({ zoneId: zone.id, x: 40, y: 140, data: expect.objectContaining({ text: 'All tests pass.', agent: expect.objectContaining({ name: 'Check the deps #1' }) }) }),
    ]);
  });

  it('leaves the agent open, and its result in the history alone, when it is told to', async () => {
    const { client, recorder, clock, zone } = await clockDaemon();
    const made = await freshClock(client, zone.id, { fresh: { harness: 'claude', model: null, role: null, closeWhenDone: false } });
    clock.advanceTo(EIGHT);
    const done = await untilStatus(recorder, made.id, (status) => status.runs[0]?.outcome === 'done');
    expect(done.runs[0]!.result).toBe('All tests pass.');
    expect((await client.call('agent.list')).map((agent) => agent.name)).toEqual(['Check the deps #1']);
    expect((await client.call('item.list')).filter((item) => item.kind === 'agent-note')).toEqual([]);
  });

  it("hands the fresh agent's final message to another agent", async () => {
    const { client, recorder, clock, zone } = await clockDaemon();
    const reader = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Read the reports', ...SIZE });
    await recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.sessionId === reader.sessionId && e.event === 'Stop');
    const made = await freshClock(client, zone.id, { result: 'handoff', handoffTo: reader.sessionId });

    clock.advanceTo(EIGHT);
    await untilStatus(recorder, made.id, (status) => status.runs[0]?.outcome === 'done');
    const handed = await recorder.waitFor(
      (e): e is HookEvent => e.type === 'hook' && e.sessionId === reader.sessionId && e.event === 'UserPromptSubmit' && String(e.payload.prompt).includes('All tests pass.'),
    );
    expect(String(handed.payload.prompt)).toContain('Check the deps #1');
  });

  it('keeps a fresh agent whose turn ends on a question open, waiting for you, and finishes its run once you answer', async () => {
    const { client, recorder, clock, zone } = await clockDaemon('waiting');
    const made = await freshClock(client, zone.id, { cron: '0 * * * *', result: 'note' });
    clock.advanceTo(EIGHT);
    const [run] = (await untilStatus(recorder, made.id, (status) => status.runs[0]?.sessionId != null)).runs;
    const asking = await untilAgent(recorder, run!.sessionId!, (agent) => agent.lastMessage?.endsWith('?') === true);
    expect(asking.state).toBe('waiting');
    expect((await client.call('clock.list'))[0]!.runs[0]).toMatchObject({ outcome: 'running', result: null });

    // 09:00: its question is still unanswered, so no second agent starts.
    clock.advanceTo(new Date(2026, 9, 10, 9, 0));
    await untilStatus(recorder, made.id, (status) => status.runs[0]?.outcome === 'skipped');
    expect((await client.call('agent.list')).map((agent) => agent.name)).toEqual(['Check the deps #1']);

    await client.call('agent.answer', { sessionId: run!.sessionId!, text: 'SQLite' });
    const done = await untilStatus(recorder, made.id, (status) => status.runs.some((each) => each.outcome === 'done'));
    expect(done.runs.find((each) => each.outcome === 'done')).toMatchObject({ result: 'Going with SQLite.' });
    expect(await client.call('agent.list')).toEqual([]);
    const notes = (await client.call('item.list')).filter((item) => item.kind === 'agent-note');
    expect(notes.map((note) => (note.data as { text: string }).text)).toEqual(['Going with SQLite.']);
  });

  it('fails the run of a fresh agent that crashes, and skips no later fire time for it', async () => {
    const { client, recorder, clock, zone } = await clockDaemon('crash');
    const made = await freshClock(client, zone.id, {});
    clock.advanceTo(EIGHT);
    const failed = await untilStatus(recorder, made.id, (status) => status.runs[0]?.outcome === 'failed');
    expect(failed.runs[0]).toMatchObject({ reason: 'Check the deps #1 failed', finishedAt: expect.any(String) });
  });

  it('settles a run the app stopped during, once it is back, keeping a result it already had', async () => {
    const first = await clockDaemon();
    const made = await freshClock(first.client, first.zone.id, {});
    await first.daemon.stop();
    const db = new DatabaseSync(daemonPaths(first.dataDir).database);
    db.prepare("INSERT INTO clock_runs (clock_id, due_at, fired_at, outcome) VALUES (?, 'a', 'b', 'running')").run(made.id);
    db.prepare("INSERT INTO clock_runs (clock_id, due_at, fired_at, outcome, session_id, agent_name) VALUES (?, 'c', 'd', 'running', 'gone', 'Gone #2')").run(made.id);
    db.prepare("INSERT INTO clock_runs (clock_id, due_at, fired_at, outcome, session_id, agent_name, result) VALUES (?, 'e', 'f', 'running', 'closed', 'Closed #3', 'All tests pass.')").run(made.id);
    db.close();

    const { client } = await clockDaemon('output', first.dataDir);
    const [status] = await client.call('clock.list');
    expect(status!.runs.map((run) => [run.outcome, run.reason, run.result])).toEqual([
      ['done', 'the app stopped as it finished', 'All tests pass.'],
      ['failed', 'its agent was removed', null],
      ['failed', 'the app stopped as it started', null],
    ]);
  });

  it('says a run the app stopped during was stopped by it, and closes or keeps its agent as the clock says', async () => {
    const first = await clockDaemon('orchestrate');
    const keep = { harness: 'claude', model: null, role: null, closeWhenDone: false } as const;
    const closing = await freshClock(first.client, first.zone.id, { prompt: 'Work slowly' });
    const keeping = await first.client.call('clock.add', {
      place: { zoneId: first.zone.id, x: 600, y: 40 },
      data: { cron: '0 8 * * *', does: 'fresh', prompt: 'Work slowly', fresh: keep },
    });
    first.clock.advanceTo(EIGHT);
    const started = await Promise.all(
      [closing, keeping].map(async ({ id }) => (await untilStatus(first.recorder, id, (status) => status.runs[0]?.sessionId != null)).runs[0]!.sessionId!),
    );
    await first.daemon.stop();

    const { client } = await clockDaemon('orchestrate', first.dataDir);
    const runs = Object.fromEntries((await client.call('clock.list')).map((status) => [status.id, status.runs]));
    for (const { id } of [closing, keeping]) {
      expect(runs[id]).toEqual([expect.objectContaining({ outcome: 'failed', reason: 'the app stopped during its run', finishedAt: expect.any(String) })]);
    }
    await expect.poll(async () => (await client.call('agent.list')).map((agent) => [agent.sessionId, agent.state])).toEqual([[started[1], 'stopped-by-restart']]);
  });

  it("puts a clock made for an agent on its tile's left, joined to it, as its schedule", async () => {
    const { client, zone } = await clockDaemon();
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Sweep up', position: { x: 400, y: 100 }, ...SIZE });
    const made = await client.call('clock.add', { place: { beside: agent.sessionId }, data: { prompt: 'Sweep again' } });
    expect(made).toMatchObject({ zoneId: zone.id, x: 400 - 60 - 256, y: 100, data: expect.objectContaining({ does: 'message', agent: agent.sessionId, cron: '0 9 * * 1-5' }) });
    await expect.poll(async () => (await client.call('agent.list'))[0]!.schedule).toMatchObject({ clockId: made.id, prompt: 'Sweep again', cron: '0 9 * * 1-5' });
  });

  it('tells clients its agent has no schedule once its clock is deleted, and both agents when it is joined to another', async () => {
    const { client, recorder, zone } = await clockDaemon();
    const first = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Sweep up', ...SIZE });
    const second = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Tidy up', ...SIZE });
    // Settled, so only the clock's changes tell clients of them now.
    for (const { sessionId } of [first, second]) await untilAgent(recorder, sessionId, (agent) => agent.state === 'waiting');
    const made = await client.call('clock.add', { place: { beside: first.sessionId }, data: { prompt: 'Sweep again' } });
    await untilAgent(recorder, first.sessionId, (agent) => agent.schedule?.clockId === made.id);

    const joined = recorder.events.length;
    await client.call('item.update', { id: made.id, data: { agent: second.sessionId } });
    await untilAgent(recorder, first.sessionId, (agent) => agent.schedule === null, joined);
    await untilAgent(recorder, second.sessionId, (agent) => agent.schedule?.clockId === made.id, joined);

    const deleted = recorder.events.length;
    await client.call('item.delete', { id: made.id });
    await untilAgent(recorder, second.sessionId, (agent) => agent.schedule === null, deleted);
  });

  it("starts an orchestrator's fresh agents in its crew, and none once it is gone", async () => {
    const { client, recorder, clock, zone, dataDir } = await clockDaemon();
    const maker = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Lead the work', ...SIZE });
    const made = await freshClock(client, zone.id, { cron: '0 * * * *' });
    const db = new DatabaseSync(daemonPaths(dataDir).database);
    db.prepare('UPDATE board_items SET made_by = ? WHERE id = ?').run(maker.sessionId, made.id);
    db.close();

    clock.advanceTo(EIGHT);
    const [run] = (await untilStatus(recorder, made.id, (status) => status.runs[0]?.outcome === 'done')).runs;
    const crew = (await recorder.waitFor((e): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === run!.sessionId)).agent;
    expect(crew.spawnedBy).toBe(maker.sessionId);

    await client.call('agent.delete', { sessionId: maker.sessionId });
    clock.advanceTo(new Date(2026, 9, 10, 9, 0));
    const skipped = await untilStatus(recorder, made.id, (status) => status.runs.length === 2);
    expect(skipped.runs[0]).toMatchObject({ outcome: 'skipped', reason: 'the orchestrator that made it is gone' });
  });

  it('starts no more fresh agents while three it started are still on the board', async () => {
    const { client, recorder, clock, zone } = await clockDaemon();
    const made = await freshClock(client, zone.id, { cron: '0 * * * *', fresh: { harness: 'claude', model: null, role: null, closeWhenDone: false } });
    for (const hour of [8, 9, 10]) {
      clock.advanceTo(new Date(2026, 9, 10, hour, 0));
      await untilStatus(recorder, made.id, (status) => status.runs.filter((run) => run.outcome === 'done').length === hour - 7);
    }
    clock.advanceTo(new Date(2026, 9, 10, 11, 0));
    const skipped = await untilStatus(recorder, made.id, (status) => status.runs.length === 4);
    expect(skipped.runs[0]).toMatchObject({ outcome: 'skipped', reason: '3 agents it started are still on the board' });
    // Their tiles don't sit on each other.
    const places = (await client.call('agent.list')).map((agent) => `${agent.position!.x},${agent.position!.y}`);
    expect(new Set(places).size).toBe(3);
  });

  it('leaves the clocks of a deleted agent on the board, unjoined and not set', async () => {
    const { client, recorder, zone } = await clockDaemon();
    const messaged = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Sweep up', ...SIZE });
    const reader = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Read the reports', ...SIZE });
    for (const { sessionId } of [messaged, reader]) await untilAgent(recorder, sessionId, (agent) => agent.state === 'waiting');
    const messaging = await client.call('clock.add', { place: { beside: messaged.sessionId }, data: { prompt: 'Sweep again' } });
    const handing = await freshClock(client, zone.id, { result: 'handoff', handoffTo: reader.sessionId });

    await client.call('agent.delete', { sessionId: messaged.sessionId });
    await client.call('agent.delete', { sessionId: reader.sessionId });
    const clockData = async (id: string) => (await client.call('item.list')).find((item) => item.id === id)?.data;
    await expect.poll(() => clockData(messaging.id)).toMatchObject({ agent: null, prompt: 'Sweep again' });
    await expect.poll(() => clockData(handing.id)).toMatchObject({ handoffTo: null, result: 'handoff' });
    // One with no agent to message can't fire; a fresh one still starts its agents, its result kept in its history.
    const next = Object.fromEntries((await client.call('clock.list')).map((status) => [status.id, status.nextRunAt]));
    expect(next).toEqual({ [messaging.id]: null, [handing.id]: EIGHT.toISOString() });
  });

  it("refuses a clock whose cron can't be used, saying why", async () => {
    const { client, zone } = await clockDaemon();
    await expect(freshClock(client, zone.id, { cron: '61 * * * *' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams, message: expect.stringContaining('minute') });
    await expect(client.call('agent.setSchedule', { sessionId: 'nobody', schedule: { cron: '@daily', prompt: 'Sweep' } })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
  });
});
