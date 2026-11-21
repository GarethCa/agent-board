import { fakeHarnessEnv, type FakeScenario } from '@agent-board/fake-harness';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { CONTINUE_LINE } from '../src/agent-lifecycle.ts';
import type { DaemonOptions } from '../src/daemon.ts';
import { migrate } from '../src/migrate.ts';
import { paneIds } from '../src/pane-layout.ts';
import { daemonPaths } from '../src/paths.ts';
import type { Agent, AgentUpdatedEvent, DaemonEvent, HookEvent, Shell } from '../src/protocol.ts';
import { NOTHING_AFTER_RESTART, resumeAfterRestart } from '../src/resume-after-restart.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };

/** A daemon on `dataDir` whose agents run the fake claude's `scenario`, its start bringing back what a restart stopped. */
function daemonOptions(dataDir: string, home: string, scenario: FakeScenario, extra: Partial<DaemonOptions> = {}): Partial<DaemonOptions> {
  return {
    dataDir,
    worktreesDir: home,
    resumeAfterRestart: true,
    agentEnv: fakeHarnessEnv({ scenario, home, idleNotifyMs: 200, hangTool: scenario === 'output' }),
    ...extra,
  };
}

async function untilState(recorder: ReturnType<typeof recordEvents>, sessionId: string, state: string) {
  await recorder.waitFor(
    (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && e.agent.state === state,
  );
}

/** The sessions marked for the next start to bring back, by id. */
function marked(dataDir: string): string[] {
  const db = new DatabaseSync(daemonPaths(dataDir).database);
  try {
    return (db.prepare('SELECT id FROM sessions WHERE resume_at_start = 1 ORDER BY id').all() as { id: string }[]).map((row) => row.id);
  } finally {
    db.close();
  }
}

describe("the daemon's start after a restart", () => {
  it('brings back each agent and shell pane the restart stopped as it was, and leaves paused and done agents be', async () => {
    const [dataDir, home] = [tempDataDir(), tempDataDir()];
    const first = await startTestDaemon(daemonOptions(dataDir, home, 'waiting'));
    const client = await connectTestClient(first);
    const recorder = recordEvents(client);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const live = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Pick a database', name: 'Live', ...SIZE });
    const paused = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Wait for me', name: 'Paused', ...SIZE });
    const done = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Finish up', name: 'Done', ...SIZE });
    for (const { sessionId } of [live, paused, done]) await untilState(recorder, sessionId, 'waiting');
    await client.call('agent.pause', { sessionId: paused.sessionId });
    await client.call('agent.stop', { sessionId: done.sessionId });
    const shell = await client.call('shell.create', { zoneId: zone.id });
    await first.stop();
    // Marked as the daemon shut down: what it stopped, among them the shell the done agent's pane dropped into.
    expect(marked(dataDir)).toEqual(expect.arrayContaining([live.sessionId, ...paneIds(shell.layout)]));
    expect(marked(dataDir)).not.toContain(paused.sessionId);
    expect(marked(dataDir)).not.toContain(done.sessionId);

    const second = await connectTestClient(await startTestDaemon(daemonOptions(dataDir, home, 'waiting')));

    await expect(second.call('daemon.afterRestart')).resolves.toEqual({ agents: ['Live'], cutOff: [], panes: 1, notResumed: [] });
    const agents = Object.fromEntries((await second.call('agent.list')).map((agent) => [agent.name, agent]));
    expect(agents['Live']).toMatchObject({ endedAt: null, backAfterRestart: true, comingBackAfterRestart: false });
    expect(agents['Paused']).toMatchObject({ state: 'hibernated', backAfterRestart: false });
    expect(agents['Done']).toMatchObject({ state: 'done', backAfterRestart: false });
    const [restored] = await second.call('shell.list');
    expect(restored!.stoppedPanes).toEqual([]);
    // Each mark is spent: a start after this one brings back only what this one's own stop ends.
    expect(marked(dataDir)).toEqual([]);
  });

  it('never brings back an agent an earlier restart stopped, which a start that brought nothing back left stopped', async () => {
    const [dataDir, home] = [tempDataDir(), tempDataDir()];
    const first = await startTestDaemon(daemonOptions(dataDir, home, 'waiting'));
    const client = await connectTestClient(first);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Pick a database', name: 'Left stopped', ...SIZE });
    await untilState(recordEvents(client), agent.sessionId, 'waiting');
    await first.stop();
    // As the e2e suite starts one, or an older build's daemon.
    const quiet = await startTestDaemon(daemonOptions(dataDir, home, 'waiting', { resumeAfterRestart: false }));
    expect(marked(dataDir)).toEqual([]);
    await quiet.stop();

    const third = await connectTestClient(await startTestDaemon(daemonOptions(dataDir, home, 'waiting')));

    await expect(third.call('daemon.afterRestart')).resolves.toEqual(NOTHING_AFTER_RESTART);
    expect((await third.call('agent.list'))[0]).toMatchObject({ state: 'stopped-by-restart', backAfterRestart: false });
  });

  it('brings one cut off mid-turn back at its prompt, typing it nothing, until the user asks it to carry on', async () => {
    const [dataDir, home] = [tempDataDir(), tempDataDir()];
    const first = await startTestDaemon(daemonOptions(dataDir, home, 'output'));
    const client = await connectTestClient(first);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Run the tests', name: 'Tester', ...SIZE });
    await untilState(recordEvents(client), agent.sessionId, 'running');
    await first.stop();

    const second = await connectTestClient(await startTestDaemon(daemonOptions(dataDir, home, 'output')));
    const recorder = recordEvents(second);

    await expect(second.call('daemon.afterRestart')).resolves.toMatchObject({ agents: ['Tester'], cutOff: ['Tester'] });
    // A turn begun would clear its cut-off turn: none does.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await second.call('agent.list'))[0]).toMatchObject({ endedAt: null, cutOffMidTurn: true, backAfterRestart: true });

    await second.call('agent.carryOn', { sessionId: agent.sessionId });

    const told = await recorder.waitFor(
      (e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'UserPromptSubmit',
    );
    expect(told.payload.prompt).toBe(CONTINUE_LINE);
    await vi.waitFor(async () => expect((await second.call('agent.list'))[0]).toMatchObject({ cutOffMidTurn: false }));
    // Told once: no longer cut off, it is told no more.
    await expect(second.call('agent.carryOn', { sessionId: agent.sessionId })).rejects.toMatchObject({
      message: expect.stringContaining('was not cut off mid-turn'),
    });
  });

  it('tells one still loading its conversation to carry on once it is up, when Carry on is pressed as the banner shows', async () => {
    const [dataDir, home] = [tempDataDir(), tempDataDir()];
    const first = await startTestDaemon(daemonOptions(dataDir, home, 'output'));
    const client = await connectTestClient(first);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Run the tests', name: 'Tester', ...SIZE });
    await untilState(recordEvents(client), agent.sessionId, 'running');
    await first.stop();
    const slow = fakeHarnessEnv({ scenario: 'output', home, idleNotifyMs: 200, hangTool: true, startDelayMs: 1500 });
    const second = await connectTestClient(await startTestDaemon(daemonOptions(dataDir, home, 'output', { agentEnv: slow })));
    const recorder = recordEvents(second);

    await expect(second.call('daemon.afterRestart')).resolves.toMatchObject({ cutOff: ['Tester'] });
    await second.call('agent.carryOn', { sessionId: agent.sessionId });

    const told = await recorder.waitFor(
      (e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'UserPromptSubmit',
    );
    expect(told.payload.prompt).toBe(CONTINUE_LINE);
  });

  it('refuses to tell an agent that has ended to carry on', async () => {
    const [dataDir, home] = [tempDataDir(), tempDataDir()];
    const first = await startTestDaemon(daemonOptions(dataDir, home, 'output'));
    const client = await connectTestClient(first);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Run the tests', name: 'Tester', ...SIZE });
    await untilState(recordEvents(client), agent.sessionId, 'running');
    await first.stop();
    const second = await connectTestClient(await startTestDaemon(daemonOptions(dataDir, home, 'output', { resumeAfterRestart: false })));

    await expect(second.call('agent.carryOn', { sessionId: agent.sessionId })).rejects.toMatchObject({
      message: expect.stringContaining('has ended'),
    });
  });
});

describe('resumeAfterRestart', () => {
  /** A pass over a database with sessions `ids` marked, its agents faked: each starts stopped by restart. */
  function setup(ids: string[], resume: (sessionId: string) => Promise<void> = async () => {}) {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    onTestFinished(() => db.close());
    const insert = db.prepare(
      "INSERT INTO sessions (id, hook_token_sha256, ended_at, stopped_by_restart, resume_at_start) VALUES (?1, ?1, '2026-11-20', 1, 1)",
    );
    for (const id of ids) insert.run(id);
    const agents = new Map<string, Agent>(
      ids.map((id) => [id, { sessionId: id, name: `agent ${id}`, state: 'stopped-by-restart', endedAt: '2026-11-20' } as Agent]),
    );
    const resumed: string[] = [];
    const broughtBack: string[] = [];
    /** What `comingBackAfterRestart` marks, as each resume starts. */
    const coming = new Set<string>();
    const comingAtResume: string[][] = [];
    const pass = (
      shells: () => Shell[] = () => [],
      leftToClocks = new Set<string>(),
      resumePane: (shellId: string, sessionId: string) => Promise<unknown> = async () => {},
      stopping?: () => boolean,
    ) =>
      resumeAfterRestart({
        db,
        agents: {
          get: (id) => agents.get(id),
          async resume(id) {
            resumed.push(id);
            comingAtResume.push([...coming]);
            await resume(id);
            const back = { ...agents.get(id)!, state: 'idle', endedAt: null } as Agent;
            agents.set(id, back);
            return back;
          },
          broughtBack: (id) => void broughtBack.push(id),
          comingBack: (ids) => ids.forEach((id) => coming.add(id)),
          restartPassDone: () => coming.clear(),
        },
        shells: { list: () => shells(), resumePane },
        leftToClocks,
        stopping,
        log: () => {},
      });
    const markedIds = () => (db.prepare('SELECT id FROM sessions WHERE resume_at_start = 1').all() as { id: string }[]).map((row) => row.id);
    /** As a relaunch does: the session's upsert clears its mark. */
    const relaunched = (id: string) => db.prepare('UPDATE sessions SET resume_at_start = 0 WHERE id = ?').run(id);
    return { agents, resumed, broughtBack, coming, comingAtResume, pass, markedIds, relaunched };
  }

  it('tries each agent once: one that fails stays stopped, is named, and is not tried at the next start', async () => {
    const { resumed, pass, markedIds } = setup(['a', 'b'], async (id) => {
      if (id === 'a') throw new Error('its worktree is gone');
    });

    await expect(pass()).resolves.toEqual({ agents: ['agent b'], cutOff: [], panes: 0, notResumed: [{ name: 'agent a', message: 'its worktree is gone' }] });
    expect(markedIds()).toEqual([]);
    await expect(pass()).resolves.toEqual(NOTHING_AFTER_RESTART);
    expect(resumed).toEqual(['a', 'b']);
  });

  it("counts one the user woke as the pass ran as back, and launches it no second time", async () => {
    const { agents, resumed, broughtBack, pass } = setup(['a', 'b'], async (id) => {
      // Woken by its tile's Wake while the one before it came back.
      if (id === 'a') agents.set('b', { ...agents.get('b')!, state: 'idle', endedAt: null });
    });

    await expect(pass()).resolves.toMatchObject({ agents: ['agent a', 'agent b'], notResumed: [] });
    expect(resumed).toEqual(['a']);
    expect(broughtBack).toEqual(['a', 'b']);
  });

  it.each([
    ['paused', 'hibernated'],
    ['ended as done', 'done'],
    ['exited', 'exited'],
  ])('leaves one the user woke as the pass ran, and then %s, as it is', async (_, state) => {
    const { agents, resumed, broughtBack, pass, relaunched } = setup(['a', 'b'], async (id) => {
      if (id !== 'a') return;
      relaunched('b');
      agents.set('b', { ...agents.get('b')!, state, endedAt: '2026-11-20T18:01:00.000Z' } as Agent);
    });

    await expect(pass()).resolves.toEqual({ agents: ['agent a'], cutOff: [], panes: 0, notResumed: [] });
    expect(resumed).toEqual(['a']);
    expect(broughtBack).toEqual(['a']);
  });

  it('resumes nothing more once the daemon is shutting down, and leaves the untried their marks for the next start', async () => {
    let stopping = false;
    const { resumed, pass, markedIds } = setup(['a', 'b'], async () => {
      stopping = true;
    });

    await expect(pass(undefined, undefined, undefined, () => stopping)).resolves.toMatchObject({ agents: ['agent a'] });
    expect(resumed).toEqual(['a']);
    expect(markedIds()).toEqual(['b']);
  });

  it('leaves out of the cut-off ones one cut off on a permission prompt, as the banner offers it no Carry on', async () => {
    const { agents, pass } = setup(['a', 'b']);
    agents.set('a', { ...agents.get('a')!, cutOffMidTurn: true, cutOffAsking: true });
    agents.set('b', { ...agents.get('b')!, cutOffMidTurn: true });

    await expect(pass()).resolves.toMatchObject({ agents: ['agent a', 'agent b'], cutOff: ['agent b'] });
  });

  it('leaves the agents of clock runs to their clocks, and paused ones as they are', async () => {
    const { agents, resumed, pass, markedIds } = setup(['a', 'b', 'c']);
    agents.set('b', { ...agents.get('b')!, state: 'hibernated' });

    await expect(pass(undefined, new Set(['c']))).resolves.toMatchObject({ agents: ['agent a'] });
    expect(resumed).toEqual(['a']);
    expect(markedIds()).toEqual([]);
  });

  it('names a cut-off agent it brought back, which it resumes quietly', async () => {
    const { agents, pass } = setup(['a']);
    agents.set('a', { ...agents.get('a')!, cutOffMidTurn: true });

    await expect(pass()).resolves.toMatchObject({ agents: ['agent a'], cutOff: ['agent a'] });
  });

  it('marks the agents it is bringing back while it runs, for the banner to wait on, and drops the marks after', async () => {
    const { agents, coming, comingAtResume, pass } = setup(['a', 'b', 'c'], async (id) => {
      if (id === 'b') throw new Error('its worktree is gone');
    });
    agents.set('c', { ...agents.get('c')!, state: 'hibernated' });

    await pass();
    expect(comingAtResume).toEqual([
      ['a', 'b'],
      ['a', 'b'],
    ]);
    expect(coming.size).toBe(0);
  });

  it('counts a pane the user reopened as the pass ran as back', async () => {
    const shell = { id: 'shell', name: 'Shell', stoppedPanes: ['p'], endedPanes: ['p'] } as unknown as Shell;
    const { agents, pass } = setup(['p']);
    // A pane, not an agent.
    agents.delete('p');
    const open = { ...shell, stoppedPanes: [], endedPanes: [] } as unknown as Shell;
    let reopened = false;

    const result = await pass(
      () => [reopened ? open : shell],
      undefined,
      async () => {
        reopened = true;
        throw new Error('that pane is still running');
      },
    );

    expect(result).toEqual({ agents: [], cutOff: [], panes: 1, notResumed: [] });
  });
});
