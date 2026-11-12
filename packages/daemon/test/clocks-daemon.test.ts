import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv, type FakeScenario } from '@agent-board/fake-harness';
import type { DaemonClient } from '../src/client.ts';
import { MAX_CLOCK_TEMPLATES, MAX_CLOCK_TEMPLATES_PER_AGENT, RPC_ERROR, type Agent, type AgentUpdatedEvent, type ClockData, type ClockStatus, type ClockUpdatedEvent, type DaemonEvent, type Harness, type HookEvent } from '../src/protocol.ts';
import { daemonPaths } from '../src/paths.ts';
import { runBoardCommand } from '../src/board-cli.ts';
import { createFakeClock } from './fake-clock.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';
import { pinTimeZone } from './pin-time-zone.ts';

pinTimeZone('Europe/London');

const SIZE = { cols: 100, rows: 30 };
/** A Saturday morning, and the next fire time of `0 8 * * *`. */
const START = new Date(2026, 9, 10, 7, 30);
const EIGHT = new Date(2026, 9, 10, 8, 0);

async function clockDaemon(scenario: FakeScenario = 'output', dataDir = tempDataDir(), repeat = false) {
  const clock = createFakeClock(START);
  const daemon = await startTestDaemon({
    dataDir,
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario, home: tempDataDir(), idleNotifyMs: 200, repeat }),
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
    expect(await client.call('clock.list')).toEqual([{ id: made.id, nextRunAt: EIGHT.toISOString(), runs: [], skips: null, changes: [] }]);

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
    await expect.poll(async () => (await client.call('agent.list')).map((agent) => [agent.sessionId, agent.state]), { timeout: 10_000 }).toEqual([[started[1], 'stopped-by-restart']]);
  });

  it('flags an agent whose turn looks stuck, three check-ins skipped in a row as it was mid-turn, until its turn ends', async () => {
    // A `Keep busy` turn never ends on its own: the agent stays mid-turn until it is interrupted.
    const { client, recorder, clock, zone } = await clockDaemon('busy');
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Keep busy with the tests', ...SIZE });
    await untilAgent(recorder, agent.sessionId, (seen) => seen.state === 'thinking' || seen.state === 'running');
    const made = await client.call('clock.add', { place: { beside: agent.sessionId }, data: { cron: '*/1 * * * *', prompt: 'Check in' } });

    clock.advanceTo(new Date(2026, 9, 10, 7, 32));
    await untilStatus(recorder, made.id, (status) => status.skips?.count === 2);
    expect((await client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.flag).toBeNull();

    clock.advanceTo(new Date(2026, 9, 10, 7, 33));
    const flagged = await untilAgent(recorder, agent.sessionId, (seen) => seen.flag !== null);
    expect(flagged.flag).toMatchObject({
      reason: `${agent.name} has been working for at least 2m without a turn ending; its check-ins are being skipped (×3 since 07:31)`,
      to: 'user',
    });
    const status = await untilStatus(recorder, made.id, (each) => each.skips?.count === 3);
    expect(status.skips).toEqual({ count: 3, since: new Date(2026, 9, 10, 7, 31).toISOString(), reasons: ['it was still working'] });

    // Raised once: a fourth skip doesn't raise it again, as a new flag would be news again.
    clock.advanceTo(new Date(2026, 9, 10, 7, 34));
    await untilStatus(recorder, made.id, (each) => each.skips?.count === 4);
    expect((await client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.flag?.id).toBe(flagged.flag!.id);

    // The turn ending takes it down at once, not at the clock's next fire.
    await client.call('agent.interrupt', { sessionId: agent.sessionId });
    await untilAgent(recorder, agent.sessionId, (seen) => seen.flag === null);
    clock.advanceTo(new Date(2026, 9, 10, 7, 35));
    await untilStatus(recorder, made.id, (each) => each.runs[0]?.outcome === 'started');
  }, 20_000);

  it("leaves a flag the agent already has, doesn't raise one the user has looked at again, and takes its own down with the clock", async () => {
    const { client, recorder, clock, zone } = await clockDaemon('busy');
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Keep busy with the tests', ...SIZE });
    await untilAgent(recorder, agent.sessionId, (seen) => seen.state === 'thinking' || seen.state === 'running');
    const flagOf = async () => (await client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.flag;
    const first = await client.call('clock.add', { place: { beside: agent.sessionId }, data: { cron: '*/1 * * * *', prompt: 'Check in' } });
    clock.advanceTo(new Date(2026, 9, 10, 7, 33));
    const raised = (await untilAgent(recorder, agent.sessionId, (seen) => seen.flag !== null)).flag!;

    // A second clock's run of skips finds the first one's flag, and leaves it as it is.
    const second = await client.call('clock.add', { place: { beside: agent.sessionId }, data: { cron: '*/1 * * * *', prompt: 'Look up' } });
    clock.advanceTo(new Date(2026, 9, 10, 7, 36));
    await untilStatus(recorder, second.id, (status) => status.skips?.count === 3);
    expect((await flagOf())?.id).toBe(raised.id);

    // Once the user has looked, neither clock raises it again for the same run of skips.
    await client.call('agent.markSeen', { sessionId: agent.sessionId });
    expect(await flagOf()).toBeNull();
    clock.advanceTo(new Date(2026, 9, 10, 7, 37));
    await untilStatus(recorder, second.id, (status) => status.skips?.count === 4);
    await untilStatus(recorder, first.id, (status) => status.skips?.count === 7);
    expect(await flagOf()).toBeNull();

    // A clock that is deleted takes down the flag it raised.
    const third = await client.call('clock.add', { place: { beside: agent.sessionId }, data: { cron: '*/1 * * * *', prompt: 'Report' } });
    const added = recorder.events.length;
    clock.advanceTo(new Date(2026, 9, 10, 7, 40));
    const again = (await untilAgent(recorder, agent.sessionId, (seen) => seen.flag !== null, added)).flag!;
    expect(again.reason).toContain('(×3 since 07:38)');
    const deleting = recorder.events.length;
    await client.call('item.delete', { id: third.id });
    await untilAgent(recorder, agent.sessionId, (seen) => seen.flag === null, deleting);
  }, 20_000);

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

describe('what a clock does with its agent after each run', () => {
  /** A daemon whose agents play every prompt as `ask-plan` does: `Flag: …` flags you, and anything else runs the tests. */
  const watchDaemon = () => clockDaemon('ask-plan', tempDataDir(), true);
  type Setup = Awaited<ReturnType<typeof watchDaemon>>;

  /** An agent that has run the tests and is at its prompt, with an hourly clock beside it that hibernates it or not. */
  async function watched(setup: Setup, data: Partial<ClockData>, harness: Harness = 'claude') {
    const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, harness, prompt: 'Run the tests', ...SIZE });
    await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.state === 'idle' || seen.state === 'waiting');
    const made = await setup.client.call('clock.add', { place: { beside: agent.sessionId }, data: { cron: '0 * * * *', prompt: 'Check Slack', ...data } });
    return { agent, made };
  }
  const listed = async (setup: Setup, sessionId: string) => (await setup.client.call('agent.list')).find((each) => each.sessionId === sessionId);
  /** Waits for the agent's session to exit after the first `after` events: a paused agent is woken once it has. */
  const exited = (setup: Setup, sessionId: string, after: number) =>
    setup.recorder.waitFor((e): e is DaemonEvent => e.type === 'session.exited' && e.sessionId === sessionId && setup.recorder.events.indexOf(e) >= after);
  const hookAfter = (setup: Setup, sessionId: string, event: string, after: number) =>
    setup.recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.sessionId === sessionId && e.event === event && setup.recorder.events.indexOf(e) >= after);

  it('leaves the agent at its prompt when idle, its turn\'s final message the result once that turn ends', async () => {
    const setup = await watchDaemon();
    const { agent, made } = await watched(setup, { hibernate: false });
    setup.clock.advanceTo(EIGHT);
    const done = await untilStatus(setup.recorder, made.id, (status) => status.runs[0]?.finishedAt != null);
    expect(done.runs[0]).toMatchObject({ outcome: 'done', awaitsTurn: true, result: 'All tests pass.', flag: null, reason: null, sessionId: agent.sessionId });
    expect((await listed(setup, agent.sessionId))!.hibernated).toBeNull();
  });

  it('hibernates the agent after each run, and wakes it in its own conversation for the next', async () => {
    const setup = await watchDaemon();
    const { agent, made } = await watched(setup, { hibernate: true });
    expect((await listed(setup, agent.sessionId))!.schedule).toMatchObject({ clockId: made.id, hibernates: true });
    const firing = setup.recorder.events.length;
    setup.clock.advanceTo(EIGHT);
    await untilStatus(setup.recorder, made.id, (status) => status.runs[0]?.outcome === 'done');
    const paused = await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.state === 'hibernated');
    expect(paused.hibernated).toMatchObject({ by: null });
    await exited(setup, agent.sessionId, firing);

    const waking = setup.recorder.events.length;
    setup.clock.advanceTo(new Date(2026, 9, 10, 9, 0));
    const started = await hookAfter(setup, agent.sessionId, 'SessionStart', waking);
    expect(started.payload.source).toBe('resume');
    const second = await untilStatus(setup.recorder, made.id, (status) => status.runs.length === 2 && status.runs[0]!.outcome === 'done');
    expect(second.runs[0]).toMatchObject({ result: 'All tests pass.', reason: null });
    await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.state === 'hibernated', waking);
  }, 20_000);

  it('hibernates a Codex agent too, and wakes it for the next run', async () => {
    const setup = await watchDaemon();
    const { agent, made } = await watched(setup, { hibernate: true }, 'codex');
    const firing = setup.recorder.events.length;
    setup.clock.advanceTo(EIGHT);
    await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.state === 'hibernated');
    await exited(setup, agent.sessionId, firing);
    const waking = setup.recorder.events.length;
    setup.clock.advanceTo(new Date(2026, 9, 10, 9, 0));
    const second = await untilStatus(setup.recorder, made.id, (status) => status.runs.length === 2 && status.runs[0]!.outcome === 'done');
    expect(second.runs[0]).toMatchObject({ result: 'All tests pass.', reason: null });
    await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.state === 'hibernated', waking);
  }, 20_000);

  it('keeps a run whose agent flags you, and leaves that agent up for you, not hibernated', async () => {
    const setup = await watchDaemon();
    const { agent, made } = await watched(setup, { hibernate: true, prompt: 'Flag: Sam asked about the release in Slack' });
    setup.clock.advanceTo(EIGHT);
    const done = await untilStatus(setup.recorder, made.id, (status) => status.runs[0]?.outcome === 'done');
    expect(done.runs[0]).toMatchObject({ flag: 'Sam asked about the release in Slack', reason: 'not paused: it flagged you' });
    const kept = (await listed(setup, agent.sessionId))!;
    expect(kept.hibernated).toBeNull();
    expect(kept.flag).toMatchObject({ reason: 'Sam asked about the release in Slack', to: 'user' });
  });

  it("doesn't count a flag from before the run as the run's", async () => {
    const setup = await watchDaemon();
    const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'Flag: the deploy needs a look', ...SIZE });
    await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.flag !== null && (seen.state === 'idle' || seen.state === 'waiting'));
    const made = await setup.client.call('clock.add', { place: { beside: agent.sessionId }, data: { cron: '0 * * * *', prompt: 'Check Slack', hibernate: false } });
    setup.clock.advanceTo(EIGHT);
    const done = await untilStatus(setup.recorder, made.id, (status) => status.runs[0]?.outcome === 'done');
    expect(done.runs[0]).toMatchObject({ flag: null, result: 'All tests pass.' });
  });

  it('keeps a fresh agent that flags you on the board, and says so in its run', async () => {
    const setup = await watchDaemon();
    const made = await freshClock(setup.client, setup.zone.id, { prompt: 'Flag: two PRs wait on your approval' });
    setup.clock.advanceTo(EIGHT);
    const done = await untilStatus(setup.recorder, made.id, (status) => status.runs[0]?.outcome === 'done');
    expect(done.runs[0]).toMatchObject({ flag: 'two PRs wait on your approval', reason: expect.stringContaining('kept: it flagged you') });
    expect((await setup.client.call('agent.list')).map((each) => each.name)).toEqual([done.runs[0]!.agentName]);
  });

  it('keeps a run open while its turn ends on a question, and settles it once you answer', async () => {
    const setup = await clockDaemon('waiting', tempDataDir(), true);
    const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'Pick a database', ...SIZE });
    await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.lastMessage?.endsWith('?') === true);
    await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'SQLite' });
    await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.lastMessage === 'Going with SQLite.');
    const made = await setup.client.call('clock.add', { place: { beside: agent.sessionId }, data: { cron: '0 * * * *', prompt: 'Pick again', hibernate: true } });

    const asking = setup.recorder.events.length;
    setup.clock.advanceTo(EIGHT);
    await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.lastMessage?.endsWith('?') === true, asking);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await setup.client.call('clock.list'))[0]!.runs[0]).toMatchObject({ outcome: 'started', awaitsTurn: true, finishedAt: null });
    expect((await listed(setup, agent.sessionId))!.hibernated).toBeNull();

    await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Postgres' });
    const done = await untilStatus(setup.recorder, made.id, (status) => status.runs[0]?.outcome === 'done');
    expect(done.runs[0]!.result).toBe('Going with Postgres.');
    await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.state === 'hibernated', asking);
  }, 20_000);

  /** An agent playing `orchestrate`, at its prompt with its board token on its screen, beside an hourly clock that hibernates it. */
  async function orchestrated(prompt: string, harness: Harness = 'claude') {
    const setup = await clockDaemon('orchestrate', tempDataDir(), true);
    const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, harness, prompt: 'Print your board identity', ...SIZE });
    await setup.client.call('session.attach', { sessionId: agent.sessionId });
    await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.state === 'idle' || seen.state === 'waiting');
    const token = /identity:(.*):end\r\n/.exec(setup.recorder.screenText(agent.sessionId))?.[1];
    const made = await setup.client.call('clock.add', { place: { beside: agent.sessionId }, data: { cron: '0 * * * *', prompt, hibernate: true } });
    return { ...setup, agent, token, made };
  }

  it("records why it couldn't hibernate the agent, and the agent's turn still ends", async () => {
    const setup = await clockDaemon('background', tempDataDir(), true);
    const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'true', ...SIZE });
    await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.lastMessage === 'The command finished.' && (seen.state === 'idle' || seen.state === 'waiting'));
    // A command it leaves running in the background, which a pause would end.
    const made = await setup.client.call('clock.add', { place: { beside: agent.sessionId }, data: { cron: '0 * * * *', prompt: 'sleep 20', hibernate: true } });
    setup.clock.advanceTo(EIGHT);
    const done = await untilStatus(setup.recorder, made.id, (status) => status.runs[0]?.reason?.startsWith('not paused') === true);
    expect(done.runs[0]).toMatchObject({ outcome: 'done', result: 'The command is running in the background.', reason: 'not paused: a command it left running still runs' });
    const kept = (await listed(setup, agent.sessionId))!;
    expect(kept.hibernated).toBeNull();
    expect(['idle', 'waiting', 'on-command']).toContain(kept.state);
  }, 20_000);

  it('skips a fire while the last run is still being typed, which keeps its own turn', async () => {
    const setup = await watchDaemon();
    const { made } = await watched(setup, { hibernate: false });
    setup.clock.advanceTo(EIGHT);
    setup.clock.advanceTo(new Date(2026, 9, 10, 9, 0));
    const done = await untilStatus(setup.recorder, made.id, (status) => status.runs[1]?.outcome === 'done');
    expect(done.runs[0]).toMatchObject({ outcome: 'skipped', reason: 'a message is being sent to it' });
    expect(done.runs[1]).toMatchObject({ result: 'All tests pass.', reason: null });
  });

  it("counts a flag raised mid-run as the run's though a later fire skips, and leaves the agent up", async () => {
    const setup = await orchestrated('Work slowly');
    setup.clock.advanceTo(EIGHT);
    await untilAgent(setup.recorder, setup.agent.sessionId, (seen) => seen.state === 'thinking' || seen.state === 'running');
    await setup.client.call('board.needsYou', { token: setup.token!, reason: 'the release needs your sign-off' });
    // A fire while its turn goes on skips, and is no run of its own.
    setup.clock.advanceTo(new Date(2026, 9, 10, 9, 0));
    await untilStatus(setup.recorder, setup.made.id, (status) => status.runs[0]?.outcome === 'skipped');
    const done = await untilStatus(setup.recorder, setup.made.id, (status) => status.runs[1]?.outcome === 'done');
    expect(done.runs[1]).toMatchObject({ flag: 'the release needs your sign-off', reason: 'not paused: it flagged you', result: 'Slow work done.' });
    expect((await listed(setup, setup.agent.sessionId))!.hibernated).toBeNull();
  }, 20_000);

  it.each<Harness>(['claude', 'codex'])("fails a run whose %s turn is interrupted, and doesn't hibernate the agent after your next turn", async (harness) => {
    const setup = await orchestrated('Work until interrupted', harness);
    setup.clock.advanceTo(EIGHT);
    await setup.recorder.waitForText(setup.agent.sessionId, 'Working until interrupted.');
    await setup.client.call('agent.interrupt', { sessionId: setup.agent.sessionId });
    const failed = await untilStatus(setup.recorder, setup.made.id, (status) => status.runs[0]?.outcome === 'failed');
    expect(failed.runs[0]).toMatchObject({ reason: 'its turn was interrupted', awaitsTurn: true });

    const yours = setup.recorder.events.length;
    await setup.client.call('agent.answer', { sessionId: setup.agent.sessionId, text: 'Print your board identity' });
    await hookAfter(setup, setup.agent.sessionId, 'Stop', yours);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await listed(setup, setup.agent.sessionId))!.hibernated).toBeNull();
    expect((await setup.client.call('clock.list'))[0]!.runs[0]).toMatchObject({ outcome: 'failed', reason: 'its turn was interrupted' });
  }, 20_000);
});


describe('an agent changing its own clock', () => {
  /** A daemon whose agents play every prompt as `ask-plan` does: `Clock: <json>` calls `clock_set` with it. */
  const watchDaemon = () => clockDaemon('ask-plan', tempDataDir(), true);
  type Setup = Awaited<ReturnType<typeof watchDaemon>>;

  const clockSet = (args: Record<string, unknown>) => `Clock: ${JSON.stringify(args)}`;
  const dataOf = async (setup: Setup, id: string) => (await setup.client.call('item.list')).find((item) => item.id === id)!.data as unknown as ClockData;
  const listed = async (setup: Setup, sessionId: string) => (await setup.client.call('agent.list')).find((each) => each.sessionId === sessionId);
  /** An agent at its prompt, its board token read from its screen. */
  async function agentAt(setup: Setup, prompt: string) {
    const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt, ...SIZE });
    await setup.client.call('session.attach', { sessionId: agent.sessionId });
    await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.state === 'idle' || seen.state === 'waiting');
    const token = /identity:(.*):end\r\n/.exec(setup.recorder.screenText(agent.sessionId))?.[1];
    return { agent, token };
  }

  it("sets its clock's mode from its run, marked as its doing, until the user sets the mode again", async () => {
    const setup = await watchDaemon();
    const { agent } = await agentAt(setup, 'Run the tests');
    const made = await setup.client.call('clock.add', { place: { beside: agent.sessionId }, data: { cron: '0 * * * *', hibernate: true, prompt: clockSet({ after: 'idle', why: 'Nothing to watch until Monday' }) } });
    setup.clock.advanceTo(EIGHT);
    const done = await untilStatus(setup.recorder, made.id, (status) => status.runs[0]?.outcome === 'done');
    expect(done.runs[0]!.result).toBe('Your clock now leaves you idle after each run. Its next run is at 09:00.');
    expect(done.changes).toEqual([
      { id: expect.any(Number), runId: done.runs[0]!.id, at: EIGHT.toISOString(), sessionId: agent.sessionId, agentName: agent.name, change: 'mode', value: 'idle', why: 'Nothing to watch until Monday' },
    ]);
    expect(await dataOf(setup, made.id)).toMatchObject({ does: 'message', hibernate: false, agent: agent.sessionId, modeSetBy: { sessionId: agent.sessionId, name: agent.name, why: 'Nothing to watch until Monday' } });
    // The mode is read as the turn ends: idle now, so not paused.
    expect((await listed(setup, agent.sessionId))!.hibernated).toBeNull();

    // A change that leaves the mode be keeps the mark; the user setting the mode clears it.
    await setup.client.call('item.update', { id: made.id, data: { cron: '0 9 * * *' } });
    expect((await dataOf(setup, made.id)).modeSetBy).not.toBeNull();
    await setup.client.call('item.update', { id: made.id, data: { hibernate: true } });
    expect((await dataOf(setup, made.id)).modeSetBy).toBeNull();
  }, 20_000);

  it('turns its clock off, saying why, until the user turns it on again', async () => {
    const setup = await watchDaemon();
    const { agent } = await agentAt(setup, 'Run the tests');
    const made = await setup.client.call('clock.add', { place: { beside: agent.sessionId }, data: { cron: '0 * * * *', prompt: clockSet({ stop: true, why: 'Every PR is merged' }) } });
    setup.clock.advanceTo(EIGHT);
    const done = await untilStatus(setup.recorder, made.id, (status) => status.runs[0]?.outcome === 'done' && status.nextRunAt === null);
    expect(done.runs[0]!.result).toBe('Your clock is off. Turn it on again from the board.');
    expect(done.changes[0]).toMatchObject({ change: 'stop', value: null, why: 'Every PR is merged', runId: done.runs[0]!.id });
    expect(await dataOf(setup, made.id)).toMatchObject({ enabled: false, stoppedBy: { name: agent.name, why: 'Every PR is merged' } });
    await setup.client.call('item.update', { id: made.id, data: { enabled: true } });
    expect(await dataOf(setup, made.id)).toMatchObject({ enabled: true, stoppedBy: null });
  }, 20_000);

  it("adds a clock of its own, and is refused another agent's clock and a clock it doesn't have", async () => {
    const setup = await watchDaemon();
    const { agent, token } = await agentAt(setup, clockSet({ stop: true, why: 'No reason' }));
    expect((await listed(setup, agent.sessionId))!.lastMessage).toContain('you have no clock: add one with `agent-board schedule add --self`');
    const other = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'Watcher', prompt: 'Run the tests', ...SIZE });
    const theirs = await setup.client.call('clock.add', { place: { beside: other.sessionId }, data: { cron: '0 * * * *', prompt: 'Check Slack' } });

    const agentClient = await connectTestClient(setup.daemon);
    const mine = await agentClient.call('clock.addSelf', { token, cron: '0 9 * * 1-5', prompt: 'Check the PRs', after: 'hibernate' });
    expect(mine.data).toMatchObject({ does: 'message', agent: agent.sessionId, hibernate: true, prompt: 'Check the PRs' });
    expect((await listed(setup, agent.sessionId))!.schedule).toMatchObject({ clockId: mine.id, hibernates: true });

    await expect(agentClient.call('clock.self', { token, clock: theirs.id, stop: true, why: 'Mine now' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams, message: 'that clock runs Watcher, not you' });
    await expect(agentClient.call('clock.self', { token, after: 'idle', stop: true, why: 'Both' })).rejects.toMatchObject({ message: 'give one of after or stop' });
    const set = await agentClient.call('clock.self', { token, after: 'close', why: 'A fresh look each morning' });
    expect(set.said).toMatch(/^Your clock now starts a fresh agent for each run, and closes it after\. \S+ 09:00 starts a fresh agent\.$/);
    // It stays named, though a fresh clock messages no one: setting the mode back joins it again.
    expect(set.clock.data).toMatchObject({ does: 'fresh', agent: agent.sessionId, modeSetBy: { name: agent.name, why: 'A fresh look each morning' } });
    expect((await listed(setup, agent.sessionId))!.schedule).toBeNull();
    // Between runs nothing closes it.
    expect((await listed(setup, agent.sessionId))!.endedAt).toBeNull();
    expect((await dataOf(setup, theirs.id)).enabled).toBe(true);
  }, 20_000);

  it("closes an agent that set its clock to close during the run as the run ends, and the next run starts a fresh one", async () => {
    const setup = await watchDaemon();
    const { agent } = await agentAt(setup, 'Run the tests');
    const made = await setup.client.call('clock.add', { place: { beside: agent.sessionId }, data: { cron: '0 * * * *', prompt: clockSet({ after: 'close', why: 'Start clean each hour' }) } });
    setup.clock.advanceTo(EIGHT);
    const done = await untilStatus(setup.recorder, made.id, (status) => status.runs[0]?.outcome === 'done');
    expect(done.runs[0]!.result).toBe('Your clock now closes you after this run. 09:00 starts a fresh agent.');
    await setup.recorder.waitFor((e): e is DaemonEvent => e.type === 'agent.removed' && e.sessionId === agent.sessionId);
    setup.clock.advanceTo(new Date(2026, 9, 10, 9, 0));
    const second = await untilStatus(setup.recorder, made.id, (status) => status.runs.length === 2 && status.runs[0]!.sessionId !== null);
    expect(second.runs[0]!.sessionId).not.toBe(agent.sessionId);
  }, 20_000);

  it("starts the user's fresh agents from a clock it added for itself and set to close, once it is closed", async () => {
    const setup = await watchDaemon();
    // Refused, having no clock yet: the prompt that puts its token on its screen.
    const { agent, token } = await agentAt(setup, clockSet({ stop: true, why: 'No reason' }));
    const agentClient = await connectTestClient(setup.daemon);
    const mine = await agentClient.call('clock.addSelf', { token, cron: '0 * * * *', prompt: clockSet({ after: 'close', why: 'Start clean each hour' }) });
    setup.clock.advanceTo(EIGHT);
    await untilStatus(setup.recorder, mine.id, (status) => status.runs[0]?.outcome === 'done');
    await setup.recorder.waitFor((e): e is DaemonEvent => e.type === 'agent.removed' && e.sessionId === agent.sessionId);

    setup.clock.advanceTo(new Date(2026, 9, 10, 9, 0));
    const second = await untilStatus(setup.recorder, mine.id, (status) => status.runs.length === 2 && (status.runs[0]!.outcome === 'skipped' || status.runs[0]!.sessionId !== null));
    expect(second.runs[0]).toMatchObject({ outcome: expect.not.stringMatching(/skipped/), reason: null });
    // No one's crew: the agent that added it was no orchestrator, and has gone.
    expect((await listed(setup, second.runs[0]!.sessionId!))!.spawnedBy).toBeNull();
  }, 20_000);

  it("keeps an agent that set its clock to close during the run, when the clock keeps each run's agent", async () => {
    const setup = await watchDaemon();
    const { agent } = await agentAt(setup, 'Run the tests');
    const keep = { harness: 'claude', model: null, role: null, closeWhenDone: false } as const;
    const made = await setup.client.call('clock.add', { place: { beside: agent.sessionId }, data: { cron: '0 * * * *', fresh: keep, prompt: clockSet({ after: 'close', why: 'Start clean each hour' }) } });
    setup.clock.advanceTo(EIGHT);
    const done = await untilStatus(setup.recorder, made.id, (status) => status.runs[0]?.outcome === 'done');
    expect(done.runs[0]!.reason).toBeNull();
    // The next run's fresh agent starts while the first is still on the board.
    setup.clock.advanceTo(new Date(2026, 9, 10, 9, 0));
    const second = await untilStatus(setup.recorder, made.id, (status) => status.runs.length === 2 && status.runs[0]!.sessionId !== null);
    expect(second.runs[0]!.sessionId).not.toBe(agent.sessionId);
    expect((await listed(setup, agent.sessionId))!.endedAt).toBeNull();
  }, 20_000);

  it('joins its clock as the fresh agent a run started, setting hibernate, and is paused, not closed', async () => {
    const setup = await watchDaemon();
    const made = await freshClock(setup.client, setup.zone.id, { prompt: clockSet({ after: 'hibernate', why: 'The same conversation each morning' }) });
    setup.clock.advanceTo(EIGHT);
    const done = await untilStatus(setup.recorder, made.id, (status) => status.runs[0]?.outcome === 'done');
    const sessionId = done.runs[0]!.sessionId!;
    expect(done.runs[0]).toMatchObject({ result: 'Your clock now hibernates you after each run. Its next run is at 2026-10-11 08:00.', reason: null });
    expect(await dataOf(setup, made.id)).toMatchObject({ does: 'message', hibernate: true, agent: sessionId });
    await untilAgent(setup.recorder, sessionId, (seen) => seen.state === 'hibernated');
    expect((await listed(setup, sessionId))!.schedule).toMatchObject({ clockId: made.id, hibernates: true });
  }, 20_000);

  it('adds, sets and stops its own clock from the command line', async () => {
    const setup = await watchDaemon();
    // Refused, having no clock yet: the prompt that puts its token on its screen.
    const { agent, token } = await agentAt(setup, clockSet({ stop: true, why: 'No reason' }));
    const env = { AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: token };
    const schedule = async (...args: string[]) => {
      let out = '';
      let err = '';
      const code = await runBoardCommand('schedule', args, { out: (text) => (out += text), err: (text) => (err += text), env });
      return { code, out, err };
    };
    const added = await schedule('add', '0 9 * * 1-5', '--self', '--after', 'hibernate', '--', 'Check the PRs');
    expect(added).toMatchObject({ code: 0, out: expect.stringMatching(/^Added item:\S+ {2}Weekdays 09:00 \(0 9 \* \* 1-5\) {2}messages agent:\S+ .+, hibernating it after each run/) });
    expect(await schedule('set', '--after', 'idle', '--why', 'Nothing to watch until Monday')).toMatchObject({ code: 0, out: expect.stringContaining('Your clock now leaves you idle after each run.') });
    expect(await schedule('stop', '--why', 'Every PR is merged')).toMatchObject({ code: 0, out: expect.stringContaining('Your clock is off.') });
    const [clock] = (await setup.client.call('item.list')).filter((item) => item.kind === 'clock');
    expect(clock!.data).toMatchObject({ agent: agent.sessionId, hibernate: false, enabled: false, prompt: 'Check the PRs', stoppedBy: { why: 'Every PR is merged' } });
    expect((await setup.client.call('clock.list'))[0]!.changes.map((change) => [change.change, change.value])).toEqual([['stop', null], ['mode', 'idle']]);
  }, 20_000);

  it('stops its own clock as the fresh agent a run started, and is still closed as the run ends', async () => {
    const setup = await watchDaemon();
    const made = await freshClock(setup.client, setup.zone.id, { prompt: clockSet({ stop: true, why: 'Nothing left to check' }) });
    setup.clock.advanceTo(EIGHT);
    const done = await untilStatus(setup.recorder, made.id, (status) => status.runs[0]?.outcome === 'done');
    expect(done.runs[0]!.result).toBe('Your clock is off. Turn it on again from the board.');
    expect(done.changes[0]).toMatchObject({ change: 'stop', agentName: done.runs[0]!.agentName, runId: done.runs[0]!.id });
    expect((await dataOf(setup, made.id)).enabled).toBe(false);
    await setup.recorder.waitFor((e): e is DaemonEvent => e.type === 'agent.removed' && e.sessionId === done.runs[0]!.sessionId);
  }, 20_000);
});

describe('a clock that starts its own agent', () => {
  it('starts an agent on its first run as a fresh one starts, joins it, then hibernates and wakes it as its own', async () => {
    const setup = await clockDaemon('ask-plan', tempDataDir(), true);
    const made = await setup.client.call('clock.add', {
      place: { zoneId: setup.zone.id, x: 40, y: 40 },
      data: { cron: '0 * * * *', does: 'message', agent: null, startsAgent: true, hibernate: true, prompt: 'Check Slack' },
    });
    // An unjoined clock that doesn't start its own agent isn't set.
    const unset = await setup.client.call('clock.add', { place: { zoneId: setup.zone.id, x: 400, y: 40 }, data: { cron: '0 * * * *', does: 'message', agent: null, prompt: 'Check Slack' } });
    expect((await setup.client.call('clock.list')).find((each) => each.id === unset.id)!.nextRunAt).toBeNull();

    setup.clock.advanceTo(EIGHT);
    const done = await untilStatus(setup.recorder, made.id, (status) => status.runs[0]?.outcome === 'done');
    const sessionId = done.runs[0]!.sessionId!;
    expect(done.runs[0]).toMatchObject({ result: 'All tests pass.', reason: null });
    const data = (await setup.client.call('item.list')).find((item) => item.id === made.id)!.data;
    expect(data).toMatchObject({ agent: sessionId, startsAgent: false, does: 'message' });
    await untilAgent(setup.recorder, sessionId, (seen) => seen.state === 'hibernated');
    await setup.recorder.waitFor((e): e is DaemonEvent => e.type === 'session.exited' && e.sessionId === sessionId);

    const waking = setup.recorder.events.length;
    setup.clock.advanceTo(new Date(2026, 9, 10, 9, 0));
    const second = await untilStatus(setup.recorder, made.id, (status) => status.runs.length === 2 && status.runs[0]!.outcome === 'done');
    expect(second.runs[0]!.sessionId).toBe(sessionId);
    await untilAgent(setup.recorder, sessionId, (seen) => seen.state === 'hibernated', waking);
  }, 20_000);

  /** A clock in the zone that starts its own agent with `prompt`, and the agent its first run started, joined. */
  async function startedAgent(setup: Awaited<ReturnType<typeof clockDaemon>>, prompt: string) {
    const made = await setup.client.call('clock.add', {
      place: { zoneId: setup.zone.id, x: 40, y: 40 },
      data: { cron: '0 * * * *', does: 'message', agent: null, startsAgent: true, prompt },
    });
    setup.clock.advanceTo(EIGHT);
    const sessionId = (await untilStatus(setup.recorder, made.id, (status) => status.runs[0]?.sessionId != null)).runs[0]!.sessionId!;
    await expect.poll(async () => (await setup.client.call('item.list')).find((item) => item.id === made.id)!.data.agent).toBe(sessionId);
    return { made, sessionId };
  }

  it("settles its first run as the clock's own though the clock no longer names the agent, never closing it", async () => {
    const setup = await clockDaemon('orchestrate');
    const { made, sessionId } = await startedAgent(setup, 'Work slowly');
    // The run, not the clock as it is now, says whose agent it is.
    await setup.client.call('item.update', { id: made.id, data: { agent: null } });
    const done = await untilStatus(setup.recorder, made.id, (status) => status.runs[0]?.outcome === 'done');
    expect(done.runs[0]!.reason).toBeNull();
    expect((await setup.client.call('agent.list')).find((agent) => agent.sessionId === sessionId)!.endedAt).toBeNull();
  }, 20_000);

  it('keeps the agent its first run started when the app stops during that run, though the join was never written', async () => {
    const first = await clockDaemon('orchestrate');
    const { made, sessionId } = await startedAgent(first, 'Work slowly');
    await first.daemon.stop();
    const db = new DatabaseSync(daemonPaths(first.dataDir).database);
    db.prepare("UPDATE board_items SET data = json_set(data, '$.agent', NULL, '$.startsAgent', json('true')) WHERE id = ?").run(made.id);
    db.close();

    const { client } = await clockDaemon('orchestrate', first.dataDir);
    const [status] = await client.call('clock.list');
    expect(status!.runs).toEqual([expect.objectContaining({ outcome: 'failed', reason: 'the app stopped during its run', sessionId })]);
    await expect.poll(async () => (await client.call('agent.list')).map((agent) => [agent.sessionId, agent.state])).toEqual([[sessionId, 'stopped-by-restart']]);
  }, 20_000);
});

describe('clock templates', () => {
  async function agentAt(setup: Awaited<ReturnType<typeof clockDaemon>>, name: string) {
    // `Clock:` puts its board token on its screen; it has no clock to set yet.
    const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name, prompt: 'Clock: {"after":"idle","why":"Nothing yet"}', ...SIZE });
    await setup.client.call('session.attach', { sessionId: agent.sessionId });
    await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.state === 'idle' || seen.state === 'waiting');
    const token = /identity:(.*):end\r\n/.exec(setup.recorder.screenText(agent.sessionId))?.[1];
    return { agent, token, client: await connectTestClient(setup.daemon) };
  }

  it('saves a template from its data or a clock, lists it by name, replaces it by name whatever its case and removes it, telling clients', async () => {
    const setup = await clockDaemon();
    const saved = await setup.client.call('clockTemplate.save', { name: 'Slack watch', data: { cron: '*/30 9-17 * * 1-5', prompt: 'Check Slack', hibernate: true, agent: 'someone' } as never });
    expect(saved).toMatchObject({ name: 'Slack watch', madeBy: null, data: { cron: '*/30 9-17 * * 1-5', prompt: 'Check Slack', does: 'message', hibernate: true } });
    // Never the agent it messages, nor a run's state.
    expect(Object.keys(saved.data).sort()).toEqual(['cron', 'does', 'fresh', 'hibernate', 'prompt', 'result']);
    // Only the template saved goes to clients, not every one.
    await setup.recorder.waitFor((e): e is DaemonEvent => e.type === 'clockTemplate.updated' && e.template.id === saved.id);

    const clock = await freshClock(setup.client, setup.zone.id, { fresh: { harness: 'codex', model: null, role: 'reviewer', closeWhenDone: true }, result: 'note' });
    const fromClock = await setup.client.call('clockTemplate.save', { name: 'Deps', fromClock: clock.id });
    expect(fromClock.data).toMatchObject({ cron: '0 8 * * *', does: 'fresh', prompt: 'Check the deps', result: 'note', fresh: { harness: 'codex', role: 'reviewer' } });
    expect((await setup.client.call('clockTemplate.list', {})).map((each) => each.name)).toEqual(['Deps', 'Slack watch']);

    const replaced = await setup.client.call('clockTemplate.save', { name: 'slack WATCH', data: { cron: '@hourly', prompt: 'Check Slack and email' } });
    expect(replaced).toMatchObject({ id: saved.id, name: 'slack WATCH', data: { cron: '@hourly', prompt: 'Check Slack and email' } });
    expect(await setup.client.call('clockTemplate.list', {})).toHaveLength(2);

    await setup.client.call('clockTemplate.remove', { template: 'deps' });
    await setup.recorder.waitFor((e): e is DaemonEvent => e.type === 'clockTemplate.removed' && e.id === fromClock.id);
    expect((await setup.client.call('clockTemplate.list', {})).map((each) => each.name)).toEqual(['slack WATCH']);
  });

  it('refuses a template with no name, too long a name, no prompt, a hand-off, a bad cron, a clock that is not there or one that hands off', async () => {
    const { client, zone } = await clockDaemon();
    const refused = (params: Parameters<DaemonClient['call']>[1], message: string | RegExp) =>
      expect(client.call('clockTemplate.save', params as never)).rejects.toMatchObject({ code: RPC_ERROR.invalidParams, message: expect.stringMatching(message) });
    await refused({ name: ' ', data: { cron: '@daily', prompt: 'Go' } }, 'give the template a name');
    await refused({ name: 'x'.repeat(61), data: { cron: '@daily', prompt: 'Go' } }, 'over 60 characters');
    await refused({ name: 'Empty', data: { cron: '@daily', prompt: ' ' } }, 'give the template its prompt');
    await refused({ name: 'Hand', data: { cron: '@daily', prompt: 'Go', does: 'fresh', result: 'handoff' } }, "can't name the agent a hand-off goes to");
    await refused({ name: 'Bad', data: { cron: '61 * * * *', prompt: 'Go' } }, /minute/);
    await refused({ name: 'Gone', fromClock: 'nope' }, 'no clock nope');
    const handsOff = await freshClock(client, zone.id, { result: 'handoff', handoffTo: 'someone' });
    await refused({ name: 'Hands off', fromClock: handsOff.id }, 'that clock hands its result to an agent, which a template never names: save it with its cron and prompt and --result history|note');
    await expect(client.call('clockTemplate.remove', { template: 'Nope' })).rejects.toMatchObject({ message: 'no clock template Nope' });
  });

  it('starts a clock from a template, what is given over its own', async () => {
    const setup = await clockDaemon();
    await setup.client.call('clockTemplate.save', { name: 'Slack watch', data: { cron: '*/30 9-17 * * 1-5', prompt: 'Check Slack', hibernate: true, startsAgent: true } });
    const item = await setup.client.call('clock.add', { place: { zoneId: setup.zone.id, x: 40, y: 40 }, data: { cron: '@hourly' }, template: 'slack watch' });
    expect(item.data).toMatchObject({ cron: '@hourly', prompt: 'Check Slack', does: 'message', hibernate: true, startsAgent: true, agent: null });
    // A clock that starts its own agent is set as soon as it is made.
    expect((await setup.client.call('clock.list')).find((each) => each.id === item.id)!.nextRunAt).not.toBeNull();
    await expect(setup.client.call('clock.add', { place: { zoneId: setup.zone.id, x: 40, y: 400 }, data: {}, template: 'Nope' })).rejects.toMatchObject({ message: 'no clock template Nope' });
  });

  it("saves an agent's templates as its own: another agent can't replace or remove them, the user can", async () => {
    const setup = await clockDaemon('ask-plan', tempDataDir(), true);
    const watcher = await agentAt(setup, 'Watcher');
    const other = await agentAt(setup, 'Other');
    const mine = await watcher.client.call('clockTemplate.save', { token: watcher.token, name: 'PR approvals', data: { cron: '@hourly', prompt: 'Check the PRs', hibernate: true } });
    expect(mine.madeBy).toBe(watcher.agent.sessionId);

    await expect(other.client.call('clockTemplate.save', { token: other.token, name: 'pr approvals', data: { cron: '@daily', prompt: 'Mine now' } })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: "the template PR approvals isn't one you saved: save yours under another name",
    });
    await expect(other.client.call('clockTemplate.remove', { token: other.token, template: 'PR approvals' })).rejects.toMatchObject({ message: expect.stringContaining("isn't one you saved") });
    await expect(other.client.call('clockTemplate.save', { token: 'not-a-token', name: 'Sneaky', data: { cron: '@daily', prompt: 'Go' } })).rejects.toMatchObject({ message: expect.stringContaining('unknown board token') });

    // Its own clock from it: hibernating, as the template does, beside its tile.
    const own = await watcher.client.call('clock.addSelf', { token: watcher.token, template: 'PR approvals' });
    expect(own.data).toMatchObject({ cron: '@hourly', prompt: 'Check the PRs', does: 'message', hibernate: true, agent: watcher.agent.sessionId, startsAgent: false });

    await watcher.client.call('clockTemplate.save', { token: watcher.token, name: 'PR approvals', data: { cron: '@daily', prompt: 'Check the PRs' } });
    await setup.client.call('clockTemplate.save', { name: 'PR approvals', data: { cron: '@daily', prompt: 'Check the PRs, as the user' } });
    expect((await setup.client.call('clockTemplate.list', {}))[0]).toMatchObject({ madeBy: null, data: { prompt: 'Check the PRs, as the user' } });
    await setup.client.call('clockTemplate.remove', { template: 'PR approvals' });
    expect(await setup.client.call('clockTemplate.list', {})).toEqual([]);

    // An agent's saves and removals, and what it was refused, are in the activity log; the user's aren't.
    const log = await setup.client.call('orchestrator.activity', { limit: 10 });
    expect(log.map(({ action, orchestratorName, targetName, outcome }) => [action, orchestratorName, targetName, outcome])).toEqual([
      ['save-clock-template', 'Watcher', 'PR approvals', 'done'],
      ['remove-clock-template', 'Other', 'PR approvals', 'refused'],
      ['save-clock-template', 'Other', 'pr approvals', 'refused'],
      ['save-clock-template', 'Watcher', 'PR approvals', 'done'],
    ]);
  }, 20_000);

  it('saves a template and starts a clock of its own from it, from the command line', async () => {
    const setup = await clockDaemon('ask-plan', tempDataDir(), true);
    const watcher = await agentAt(setup, 'Watcher');
    const env = { AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: watcher.token! };
    const schedule = async (...args: string[]) => {
      let out = '';
      let err = '';
      const code = await runBoardCommand('schedule', args, { out: (text) => (out += text), err: (text) => (err += text), env });
      return { code, out, err };
    };
    expect(await schedule('template', 'save', 'PR watch', '0 9 * * 1-5', '--after', 'hibernate', '--', 'Check the PRs')).toMatchObject({
      code: 0,
      out: expect.stringContaining('"PR watch"  Weekdays 09:00 (0 9 * * 1-5)  hibernates its agent after each run  saved by Watcher'),
    });
    const added = await schedule('add', '--template', 'pr WATCH', '--self');
    expect(added).toMatchObject({ code: 0, err: '' });
    const [clock] = (await setup.client.call('item.list')).filter((item) => item.kind === 'clock');
    expect(clock!.data).toMatchObject({ cron: '0 9 * * 1-5', prompt: 'Check the PRs', does: 'message', hibernate: true, agent: watcher.agent.sessionId });
    expect(await schedule('template', 'remove', 'PR watch')).toMatchObject({ code: 0 });
    expect(await setup.client.call('clockTemplate.list', {})).toEqual([]);
  }, 20_000);

  it('caps the templates an agent saves, and all there are, saying how to remove one; saving over one is never refused', async () => {
    const setup = await clockDaemon('ask-plan', tempDataDir(), true);
    const watcher = await agentAt(setup, 'Watcher');
    const save = (name: string, client = watcher.client, token: string | null = watcher.token!) =>
      client.call('clockTemplate.save', { ...(token === null ? {} : { token }), name, data: { cron: '@daily', prompt: 'Go' } });
    for (let n = 0; n < MAX_CLOCK_TEMPLATES_PER_AGENT; n += 1) await save(`Mine ${n}`);
    await expect(save('One more')).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: `you have saved ${MAX_CLOCK_TEMPLATES_PER_AGENT} clock templates, the most an agent may: remove one with \`agent-board schedule template remove <name>\`, or save over one of yours`,
    });
    await save('Mine 0');

    for (let n = MAX_CLOCK_TEMPLATES_PER_AGENT; n < MAX_CLOCK_TEMPLATES; n += 1) await save(`User's ${n}`, setup.client, null);
    await expect(save('One more', setup.client, null)).rejects.toMatchObject({ message: expect.stringContaining(`there are ${MAX_CLOCK_TEMPLATES} clock templates, the most the board keeps`) });
    await watcher.client.call('clockTemplate.remove', { token: watcher.token, template: 'Mine 1' });
    await save('One more', setup.client, null);
  }, 30_000);

  it("refuses an ended agent's session, whether it gives its token or its connection holds it", async () => {
    const setup = await clockDaemon('ask-plan', tempDataDir(), true);
    const watcher = await agentAt(setup, 'Watcher');
    // The connection is the agent's from its first call with its token.
    await watcher.client.call('clockTemplate.save', { token: watcher.token, name: 'Early', data: { cron: '@daily', prompt: 'Go' } });
    await setup.client.call('agent.stop', { sessionId: watcher.agent.sessionId });
    const ended = { message: "an ended agent's session can't save or remove templates" };
    await expect(watcher.client.call('clockTemplate.save', { name: 'Late', data: { cron: '@daily', prompt: 'Go' } })).rejects.toMatchObject(ended);
    await expect(watcher.client.call('clockTemplate.remove', { template: 'Early' })).rejects.toMatchObject(ended);
    await expect(watcher.client.call('clockTemplate.save', { token: watcher.token, name: 'Late', data: { cron: '@daily', prompt: 'Go' } })).rejects.toMatchObject({
      message: expect.stringContaining('unknown board token'),
    });
    expect((await setup.client.call('clockTemplate.list', {})).map((each) => each.name)).toEqual(['Early']);
  }, 20_000);
});
