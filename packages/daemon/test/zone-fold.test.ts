import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { fakeHarnessEnv, type FakeScenario } from '@agent-board/fake-harness';
import { migrate } from '../src/migrate.ts';
import { RPC_ERROR, type Agent, type AgentUpdatedEvent, type DaemonEvent, type HookEvent } from '../src/protocol.ts';
import { zoneFoldHandlers } from '../src/zone-fold.ts';
import { createZoneTable } from '../src/zones.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };

/** A daemon whose agents run the fakes' `scenario`, over `dataDir` and the fakes' `home` (fresh by default). */
async function foldDaemon(scenario: FakeScenario, options: { dataDir?: string; home?: string; stepDelayMs?: number } = {}) {
  const home = options.home ?? tempDataDir();
  const dataDir = options.dataDir ?? tempDataDir();
  const daemon = await startTestDaemon({
    dataDir,
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario, home, idleNotifyMs: 200, stepDelayMs: options.stepDelayMs }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 40, y: 60 });
  return { daemon, client, recorder, zone, home, dataDir };
}

type Setup = Awaited<ReturnType<typeof foldDaemon>>;

const untilAgent = async (setup: Setup, sessionId: string, match: (agent: Agent) => boolean): Promise<Agent> =>
  (await setup.recorder.waitFor((e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent))).agent;

const stopHook = (setup: Setup, sessionId: string) =>
  setup.recorder.waitFor((e: DaemonEvent): e is HookEvent => e.type === 'hook' && e.sessionId === sessionId && e.event === 'Stop');

/** An agent that has finished its turn and sits at its prompt. */
async function idleAgent(setup: Setup, zoneId = setup.zone.id) {
  const agent = await setup.client.call('agent.spawn', { zoneId, prompt: 'Run the tests', ...SIZE });
  await stopHook(setup, agent.sessionId);
  return untilAgent(setup, agent.sessionId, (seen) => seen.state === 'idle' || seen.state === 'waiting');
}

const listed = async (setup: Setup, sessionId: string) => (await setup.client.call('agent.list')).find((each) => each.sessionId === sessionId)!;

describe('folding a zone', () => {
  it('pauses its idle agents, keeps what cannot pause live and says why, and leaves the zone where it was', async () => {
    // A `Keep busy` turn never ends on its own, so the agent is mid-turn whenever the fold comes to it.
    const setup = await foldDaemon('busy');
    const idle = await idleAgent(setup);
    const working = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'Keep busy with the tests', ...SIZE });
    await untilAgent(setup, working.sessionId, (seen) => seen.state === 'thinking' || seen.state === 'running');
    expect(setup.zone.folded).toBe(false);

    const result = await setup.client.call('zone.fold', { id: setup.zone.id });

    expect(result.paused).toEqual([idle.sessionId]);
    // The reason alone: its name is beside it.
    expect(result.kept).toEqual([{ sessionId: working.sessionId, name: working.name, why: 'it is mid-turn: finish its turn first' }]);
    // It keeps its place and size: unfolding puts it back exactly, and an orchestrator sees it folded.
    expect(result.zone).toMatchObject({ id: setup.zone.id, folded: true, x: 40, y: 60, width: setup.zone.width, height: setup.zone.height });
    expect(await listed(setup, idle.sessionId)).toMatchObject({ state: 'hibernated' });
    expect(await listed(setup, working.sessionId)).toMatchObject({ endedAt: null });
    expect((await setup.client.call('zone.list')).find((zone) => zone.id === setup.zone.id)?.folded).toBe(true);
  }, 20_000);

  it('is remembered across a daemon restart, with its agents still paused and still the fold’s to wake', async () => {
    const setup = await foldDaemon('output');
    const agent = await idleAgent(setup);
    await setup.client.call('zone.fold', { id: setup.zone.id });

    await setup.daemon.stop();
    const again = await foldDaemon('output', { dataDir: setup.dataDir, home: setup.home });

    expect((await again.client.call('zone.list')).find((zone) => zone.id === setup.zone.id)?.folded).toBe(true);
    expect(await listed(again, agent.sessionId)).toMatchObject({ state: 'hibernated' });
    expect(await again.client.call('zone.unfold', { id: setup.zone.id, wake: true })).toMatchObject({ woken: [agent.sessionId], asleep: [] });
  });

  it('refuses an unknown zone, and a fold twice does nothing the second time', async () => {
    const setup = await foldDaemon('output');
    await expect(setup.client.call('zone.fold', { id: 'nope' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });

    await setup.client.call('zone.fold', { id: setup.zone.id });
    expect(await setup.client.call('zone.fold', { id: setup.zone.id })).toMatchObject({ paused: [], kept: [], zone: { folded: true } });
  });

  it('makes no agent in a zone that is not folded pause', async () => {
    const setup = await foldDaemon('output');
    const other = await setup.client.call('zone.add', { path: tempRepo(), x: 900, y: 60 });
    const agent = await idleAgent(setup, other.id);

    await setup.client.call('zone.fold', { id: setup.zone.id });

    expect(await listed(setup, agent.sessionId)).toMatchObject({ endedAt: null });
  });
});

describe('unfolding a zone', () => {
  it('wakes no agent unless asked, and then they are paused as if by hand: a later unfold wakes none of them', async () => {
    const setup = await foldDaemon('output');
    const agent = await idleAgent(setup);
    await setup.client.call('zone.fold', { id: setup.zone.id });

    const result = await setup.client.call('zone.unfold', { id: setup.zone.id });

    expect(result).toMatchObject({ woken: [], asleep: [], zone: { folded: false, x: 40, y: 60 } });
    expect(await listed(setup, agent.sessionId)).toMatchObject({ state: 'hibernated' });

    await setup.client.call('zone.fold', { id: setup.zone.id });
    expect(await setup.client.call('zone.unfold', { id: setup.zone.id, wake: true })).toMatchObject({ woken: [], asleep: [] });
    expect(await listed(setup, agent.sessionId)).toMatchObject({ state: 'hibernated' });
  });

  it('wakes the agents its fold paused when asked', async () => {
    const setup = await foldDaemon('output');
    const agent = await idleAgent(setup);
    await setup.client.call('zone.fold', { id: setup.zone.id });

    const result = await setup.client.call('zone.unfold', { id: setup.zone.id, wake: true });

    expect(result).toMatchObject({ woken: [agent.sessionId], asleep: [] });
    expect(await untilAgent(setup, agent.sessionId, (seen) => seen.endedAt === null && seen.hibernated === null)).toMatchObject({ endedAt: null, hibernated: null });
  });

  it('wakes the rest when one will not wake, and says which stayed paused and why', async () => {
    const setup = await foldDaemon('output');
    const gone = await idleAgent(setup);
    const fine = await idleAgent(setup);
    await setup.client.call('zone.fold', { id: setup.zone.id });
    rmSync(gone.cwd, { recursive: true, force: true });

    const result = await setup.client.call('zone.unfold', { id: setup.zone.id, wake: true });

    expect(result).toMatchObject({ zone: { folded: false }, woken: [fine.sessionId] });
    expect(result.asleep).toEqual([{ sessionId: gone.sessionId, name: gone.name, why: 'its worktree is gone' }]);
    expect(await listed(setup, gone.sessionId)).toMatchObject({ state: 'hibernated' });
  }, 20_000);

  it('wakes no agent the fold did not pause: one paused by hand before it stays paused', async () => {
    const setup = await foldDaemon('output');
    const byHand = await idleAgent(setup);
    const byFold = await idleAgent(setup);
    await setup.client.call('agent.pause', { sessionId: byHand.sessionId });
    expect(await setup.client.call('zone.fold', { id: setup.zone.id })).toMatchObject({ paused: [byFold.sessionId], kept: [] });

    const result = await setup.client.call('zone.unfold', { id: setup.zone.id, wake: true });

    expect(result).toMatchObject({ woken: [byFold.sessionId], asleep: [] });
    expect(await listed(setup, byHand.sessionId)).toMatchObject({ state: 'hibernated' });
  }, 20_000);

  it('wakes no agent the fold paused once it has woken and been paused by hand', async () => {
    const setup = await foldDaemon('output');
    const agent = await idleAgent(setup);
    await setup.client.call('zone.fold', { id: setup.zone.id });
    const before = setup.recorder.events.length;
    await setup.client.call('agent.resume', { sessionId: agent.sessionId });
    // Up and at its prompt again, as a pause by hand finds it.
    await setup.recorder.waitFor(
      (e: DaemonEvent): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'SessionStart' && setup.recorder.events.indexOf(e) >= before,
    );
    await setup.client.call('agent.pause', { sessionId: agent.sessionId });

    const result = await setup.client.call('zone.unfold', { id: setup.zone.id, wake: true });

    expect(result).toMatchObject({ woken: [], asleep: [] });
    expect(await listed(setup, agent.sessionId)).toMatchObject({ state: 'hibernated' });
  }, 20_000);

  it('does nothing to a zone that is not folded: its paused agents stay paused', async () => {
    const setup = await foldDaemon('output');
    const agent = await idleAgent(setup);
    await setup.client.call('agent.pause', { sessionId: agent.sessionId });

    const result = await setup.client.call('zone.unfold', { id: setup.zone.id, wake: true });

    expect(result).toMatchObject({ woken: [], asleep: [], zone: { folded: false } });
    expect(await listed(setup, agent.sessionId)).toMatchObject({ state: 'hibernated' });
  });

  it('refuses an unknown zone', async () => {
    const setup = await foldDaemon('output');
    await expect(setup.client.call('zone.unfold', { id: 'nope' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
  });
});

describe('a fold and an unfold of one zone', () => {
  it('take turns: an unfold asked for mid-fold wakes every agent the fold goes on to pause', async () => {
    const setup = await foldDaemon('output');
    const agents = [await idleAgent(setup), await idleAgent(setup), await idleAgent(setup)];
    const ids = agents.map((agent) => agent.sessionId);

    const folding = setup.client.call('zone.fold', { id: setup.zone.id });
    const unfolded = await setup.client.call('zone.unfold', { id: setup.zone.id, wake: true });

    expect((await folding).paused.toSorted()).toEqual(ids.toSorted());
    expect(unfolded).toMatchObject({ zone: { folded: false }, asleep: [] });
    expect(unfolded.woken.toSorted()).toEqual(ids.toSorted());
    for (const id of ids) expect(await listed(setup, id)).toMatchObject({ endedAt: null, hibernated: null });
  }, 40_000);

  it('take turns the other way too: a fold asked for mid-unfold leaves every agent paused, or says why not', async () => {
    const setup = await foldDaemon('output');
    const ids = [await idleAgent(setup), await idleAgent(setup)].map((agent) => agent.sessionId);
    await setup.client.call('zone.fold', { id: setup.zone.id });

    const unfolding = setup.client.call('zone.unfold', { id: setup.zone.id, wake: true });
    const folded = await setup.client.call('zone.fold', { id: setup.zone.id });

    expect((await unfolding).woken.toSorted()).toEqual(ids.toSorted());
    expect(folded.zone.folded).toBe(true);
    expect([...folded.paused, ...folded.kept.map((each) => each.sessionId)].toSorted()).toEqual(ids.toSorted());
    for (const id of folded.paused) expect(await listed(setup, id)).toMatchObject({ state: 'hibernated' });
    for (const { sessionId } of folded.kept) expect(await listed(setup, sessionId)).toMatchObject({ endedAt: null });
  }, 40_000);
});

describe('a fold whose pauses take a while', () => {
  /** The fold over zone `z` and agents `a`, `b` and `c` idle in it, each pause held until `finishPause`. */
  function slowFold() {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.exec("INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height) VALUES ('z', '/code/app', '', 'app', '#4c6ef5', 0, 0, 300, 200)");
    const zones = createZoneTable(db, () => {}, () => undefined, '/repos', '/groups');
    const crew = { now: ['a', 'b', 'c'].map((sessionId) => ({ sessionId, name: sessionId, zoneId: 'z', endedAt: null, state: 'idle' }) as Agent) };
    const pausing = new Map<string, () => void>();
    const get = (sessionId: string) => crew.now.find((agent) => agent.sessionId === sessionId);
    const handlers = zoneFoldHandlers<undefined>(db, zones, {
      list: () => crew.now,
      get,
      pause: (sessionId) => new Promise((resolve) => pausing.set(sessionId, () => resolve(get(sessionId)!))),
      resume: () => Promise.reject(new Error('nothing wakes here')),
    });
    const finishPause = (sessionId: string) => pausing.get(sessionId)!();
    return { zones, crew, pausing, finishPause, fold: () => handlers['zone.fold']({ id: 'z' }, undefined) };
  }

  it('pauses no agent moved out of the zone or deleted meanwhile', async () => {
    const { crew, pausing, finishPause, fold } = slowFold();
    const folding = fold();
    await vi.waitFor(() => expect([...pausing.keys()]).toEqual(['a']));

    // While `a` pauses, `b` is dragged out onto the board and `c` is deleted.
    crew.now = [crew.now[0]!, { ...crew.now[1]!, zoneId: null }];
    finishPause('a');

    expect(await folding).toMatchObject({ zone: { folded: true }, paused: ['a'], kept: [] });
    expect([...pausing.keys()]).toEqual(['a']);
  });

  it('stops when its zone is removed meanwhile, and still says what it paused', async () => {
    const { zones, pausing, finishPause, fold } = slowFold();
    const folding = fold();
    await vi.waitFor(() => expect([...pausing.keys()]).toEqual(['a']));

    zones.remove('z');
    finishPause('a');

    expect(await folding).toMatchObject({ zone: { id: 'z', folded: true }, paused: ['a'], kept: [] });
    expect([...pausing.keys()]).toEqual(['a']);
  });
});
