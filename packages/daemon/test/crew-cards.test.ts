// A running crew's card: made beside its builder as the crew starts, kept to what the crew does, and never what a
// client says of it.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { BoardRefs, itemLine, readBoard } from '../src/board-ops.ts';
import { prefabFile } from '../src/crew-prefabs.ts';
import { BOARD_ERROR, CREW_CARD_SIZE, RPC_ERROR, crewCardSize, type BoardItem, type CrewCardData, type CrewPrefab, type DaemonEvent, type ItemUpdatedEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };
/** A prompt the fake agent answers with its board token, handing nothing over. */
const IDENTITY = 'Print your board identity';

/** A pair whose builder has no role, so its prompt reaches it bare: with `IDENTITY` its crew stays at building. */
const QUIET: CrewPrefab = {
  name: 'Quiet pair',
  icon: 'crew',
  purpose: 'One builds, one reviews',
  roundLimit: 2,
  onBoard: 'card',
  members: [
    { id: 'impl', role: null, name: null, harness: 'claude', model: null, effort: null, template: null, starts: 'prompt', subagents: [] },
    { id: 'review', role: 'reviewer', name: null, harness: 'claude', model: null, effort: null, template: null, starts: 'handoff', subagents: [] },
  ],
};

async function crewDaemon(dataDir = tempDataDir()) {
  const daemon = await startTestDaemon({
    dataDir,
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
  return { daemon, dataDir, client, recorder, zone };
}

type Setup = Awaited<ReturnType<typeof crewDaemon>>;

const dataOf = (item: BoardItem) => item.data as unknown as CrewCardData;
const crewCards = async (client: Setup['client']) => (await client.call('item.list')).filter((item) => item.kind === 'crew');

/** The crew's card as first sent with data that matches. */
async function cardOf(setup: Setup, crewId: string | null, match: (data: CrewCardData, item: BoardItem) => boolean = () => true): Promise<BoardItem> {
  const event = await setup.recorder.waitFor(
    (e: DaemonEvent): e is ItemUpdatedEvent => e.type === 'item.updated' && e.item.kind === 'crew' && dataOf(e.item).crewId === crewId && match(dataOf(e.item), e.item),
  );
  return event.item;
}

const start = (setup: Setup, prompt: string, fields: { roundLimit?: number } = {}) =>
  setup.client.call('orchestrator.startPrefab', { name: 'Implementer + reviewer', prompt, zoneId: setup.zone.id, ...fields });

/** Starts a crew that stays at building: nothing of it changes until the test changes it. */
async function startQuiet(setup: Setup) {
  await setup.client.call('orchestrator.savePrefab', { text: prefabFile(QUIET), replace: true });
  const started = await setup.client.call('orchestrator.startPrefab', { name: QUIET.name, prompt: IDENTITY, zoneId: setup.zone.id });
  return { started, crew: started.crew!, made: await cardOf(setup, started.crew) };
}

/** The agent's board token, as it printed it, and a connection that speaks as it. */
async function asAgent(setup: Setup, sessionId: string) {
  await setup.client.call('session.attach', { sessionId });
  await setup.recorder.waitForText(sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(setup.recorder.screenText(sessionId))![1]!;
  const connection = await connectTestClient(setup.daemon);
  await connection.call('board.identify', { token });
  return connection;
}

const sees = async (connection: Setup['client'], card: BoardItem) => (await connection.call('item.list')).some((item) => item.id === card.id);

describe('a crew’s card', () => {
  it('is put in its builder’s zone as the crew starts, and follows what the crew does', async () => {
    const setup = await crewDaemon();
    expect((await setup.client.call('orchestrator.startPrefab', { name: 'Solo agent', prompt: 'Go', zoneId: setup.zone.id })).crew).toBeNull();

    // The fake implementer writes its handover and ends its turn, so its reviewer starts.
    const started = await start(setup, 'Add a footer');
    const impl = started.started[0]!;
    const made = await cardOf(setup, started.crew);

    // A row for each of its two members.
    expect(made).toMatchObject({ kind: 'crew', zoneId: setup.zone.id, ...crewCardSize(2) });
    expect(dataOf(made)).toMatchObject({
      crewId: started.crew,
      title: 'Add a footer',
      icon: 'review',
      tiles: false,
      members: [
        { id: 'impl', name: 'impl', role: 'implementer', starts: 'prompt' },
        { id: 'review', name: 'review', role: 'reviewer', starts: 'handoff' },
      ],
      crew: { id: started.crew, prefab: 'Implementer + reviewer', builder: impl.sessionId, round: 1, roundLimit: 3, stopped: null },
      startFailed: false,
      startError: null,
    });

    const reviewing = await cardOf(setup, started.crew, (data) => data.crew.phase === 'reviewing' && data.crew.reviewers.length === 1);
    expect(reviewing.id).toBe(made.id);
    expect(Date.parse(dataOf(reviewing).phaseAt)).toBeGreaterThanOrEqual(Date.parse(dataOf(made).phaseAt));

    await setup.client.call('orchestrator.stopCrew', { crewId: started.crew! });
    const stopped = await cardOf(setup, started.crew, (data) => data.crew.stopped !== null);
    expect(dataOf(stopped).crew).toMatchObject({ phase: 'stopped', stopped: 'stopped' });
    // One card, and what it says is what `crew show` says.
    const cards = await crewCards(setup.client);
    expect(cards.map((card) => card.id)).toEqual([made.id]);
    expect(dataOf(cards[0]!).crew).toEqual((await setup.client.call('orchestrator.crews', { crewId: started.crew! }))[0]);
    // `agent-board tree` names it by what its crew was asked.
    const refs = new BoardRefs(await readBoard(setup.client));
    expect(itemLine(refs, cards[0]!)).toBe(`${refs.of('item', made.id)}  crew  "Add a footer"`);
  });

  it('says only what its crew did, whatever a client writes: only its place, its size and its tiles are the user’s', async () => {
    const setup = await crewDaemon();
    const { crew, made } = await startQuiet(setup);

    const forged = await setup.client.call('item.update', {
      id: made.id,
      x: made.x + 40,
      y: made.y + 80,
      data: { crewId: 'another', title: 'Merged', tiles: true, startFailed: true, members: [], crew: { ...dataOf(made).crew, phase: 'stopped', stopped: 'ready-to-merge' } },
    });

    expect(forged).toMatchObject({ id: made.id, x: made.x + 40, y: made.y + 80 });
    expect(dataOf(forged)).toEqual({ ...dataOf(made), tiles: true, crew: (await setup.client.call('orchestrator.crews', { crewId: crew }))[0] });
    expect(dataOf(forged).crew).toEqual(dataOf(made).crew);
    // Tiles alone changes, and anything but a yes or no leaves it.
    expect(dataOf(await setup.client.call('item.update', { id: made.id, data: { tiles: 'no' } })).tiles).toBe(true);
    expect(dataOf(await setup.client.call('item.update', { id: made.id, data: { tiles: false } })).tiles).toBe(false);

    const place = { kind: 'crew' as const, zoneId: setup.zone.id, x: 0, y: 900, ...CREW_CARD_SIZE };
    await expect(setup.client.call('item.create', { ...place, data: { crewId: 'nope' } })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining('there is no crew nope for a card to show'),
    });
    await expect(setup.client.call('item.create', { ...place, data: { ...dataOf(made) } })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: `crew:${crew} has its card on the board already`,
    });
    await expect(setup.client.call('item.create', { ...place, data: {} })).rejects.toThrow(/a crew card's crewId must be a string/);
    expect((await crewCards(setup.client)).map((card) => card.id)).toEqual([made.id]);
  });

  it('stays while its crew runs; once the crew is stopped it is the user’s to remove, and to put back as the crew’s own', async () => {
    const setup = await crewDaemon();
    const { crew, made } = await startQuiet(setup);

    await expect(setup.client.call('item.delete', { id: made.id })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: `crew:${crew} is still running, and a running crew keeps its card: stop the crew first (agent-board crew stop crew:${crew})`,
    });

    await setup.client.call('orchestrator.stopCrew', { crewId: crew });
    await cardOf(setup, crew, (data) => data.crew.stopped === 'stopped');
    await setup.client.call('item.delete', { id: made.id });
    expect(await crewCards(setup.client)).toEqual([]);

    // An undo of the removal sends the card as it was when the client last had it: it comes back as its crew is now.
    const back = await setup.client.call('item.create', { ...made, data: { ...dataOf(made), title: 'Old', tiles: true } });
    expect(dataOf(back)).toMatchObject({ title: IDENTITY, tiles: true, crew: { phase: 'stopped', stopped: 'stopped' } });
    await setup.client.call('item.delete', { id: back.id });
    expect(await crewCards(setup.client)).toEqual([]);
  });

  it('comes back, if removed at the round limit, once the crew is given one more round', async () => {
    const setup = await crewDaemon();
    const started = await start(setup, 'Add a footer', { roundLimit: 1 });
    const impl = started.started[0]!;
    const reviewing = await setup.recorder.waitFor(
      (e: DaemonEvent): e is DaemonEvent & { type: 'agent.updated' } =>
        e.type === 'agent.updated' && e.agent.reviews?.branch === impl.branch && e.agent.role === 'reviewer' && e.agent.state === 'idle',
    );
    // The fake reviewer leaves no review of its own: this one asks for changes, and its next update is heard.
    writeFileSync(join(reviewing.agent.worktree, '.agent-board', 'review.md'), '# Not yet\nVerdict: Changes requested\n\n## Blocker\n- **No footer** `a.ts:1`: add it\n');
    await setup.client.call('orchestrator.setStatus', { sessionId: reviewing.agent.sessionId, summary: 'Reviewed' });
    const atLimit = await cardOf(setup, started.crew, (data) => data.crew.stopped === 'round-limit');
    await setup.client.call('item.delete', { id: atLimit.id });

    await setup.client.call('orchestrator.crewRound', { crewId: started.crew! });

    const again = await cardOf(setup, started.crew, (data, item) => item.id !== atLimit.id);
    expect(again.zoneId).toBe(setup.zone.id);
    expect(dataOf(again).crew).toMatchObject({ round: 2, roundLimit: 2, stopped: null });
  });

  it('is listed for an agent only in its scope: its zone, a zone it orchestrates, or its own crew', async () => {
    const setup = await crewDaemon();
    const { started, made } = await startQuiet(setup);
    const builder = await asAgent(setup, started.started[0]!.sessionId);
    const spawn = (zoneId: string) => setup.client.call('agent.spawn', { zoneId, prompt: IDENTITY, ...SIZE });
    const neighbour = await asAgent(setup, (await spawn(setup.zone.id)).sessionId);
    const passing = await spawn(setup.zone.id);
    const left = await asAgent(setup, passing.sessionId);
    const other = await setup.client.call('zone.add', { path: tempRepo('billing'), x: 4000, y: 0, name: 'billing' });
    const stranger = await spawn(other.id);
    const strange = await asAgent(setup, stranger.sessionId);

    expect([await sees(builder, made), await sees(neighbour, made), await sees(strange, made), await sees(setup.client, made)]).toEqual([true, true, false, true]);
    // No agent writes an item, in its scope or out of it: `item.update` is not open to a board token (ADR-0010).
    await expect(builder.call('item.update', { id: made.id, data: { tiles: true } })).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });

    // An agent deleted from under its connection leaves no one to read as: the socket left open lists no card.
    expect(await sees(left, made)).toBe(true);
    await setup.client.call('agent.delete', { sessionId: passing.sessionId, force: true });
    expect(await sees(left, made)).toBe(false);
    expect((await left.call('item.list')).some((item) => item.kind === 'crew')).toBe(false);

    // An orchestrator whose scope reaches the zone lists it too.
    await setup.client.call('agent.setOrchestrate', { sessionId: stranger.sessionId, scope: 'board' });
    expect(await sees(strange, made)).toBe(true);
    await setup.client.call('agent.setOrchestrate', { sessionId: stranger.sessionId, scope: null });
    expect(await sees(strange, made)).toBe(false);

    // Moved to the other zone, it is that zone's agents' to list, and still its own crew's.
    await setup.client.call('item.update', { id: made.id, zoneId: other.id, x: 4100, y: 600 });
    expect([await sees(builder, made), await sees(neighbour, made), await sees(strange, made)]).toEqual([true, false, true]);
  });

  it('is sent as it changes, and as it goes, only to the agents whose scope lists it', async () => {
    const setup = await crewDaemon();
    const { started, made } = await startQuiet(setup);
    const spawn = (zoneId: string) => setup.client.call('agent.spawn', { zoneId, prompt: IDENTITY, ...SIZE });
    const neighbour = await asAgent(setup, started.started[0]!.sessionId);
    const passing = await spawn(setup.zone.id);
    const left = await asAgent(setup, passing.sessionId);
    const other = await setup.client.call('zone.add', { path: tempRepo('billing'), x: 4000, y: 0, name: 'billing' });
    const strange = await asAgent(setup, (await spawn(other.id)).sessionId);
    const [near, far, gone] = [recordEvents(neighbour), recordEvents(strange), recordEvents(left)];
    // A line after an event, from the daemon to every connection alike, shows a stream has gone past the event.
    let fences = 0;
    const fence = async () => {
      const name = `fence-${++fences}`;
      await setup.client.call('zone.add', { path: tempRepo(name), x: 8000 * fences, y: 4000, name });
      for (const recorder of [far, gone]) await recorder.waitFor((e: DaemonEvent): e is DaemonEvent => e.type === 'zone.updated' && e.zone.name === name);
    };
    const ofCard = (e: DaemonEvent) => (e.type === 'item.updated' && e.item.id === made.id) || (e.type === 'item.removed' && e.id === made.id);

    // An agent deleted from under its open connection has no one to hear as.
    await setup.client.call('agent.delete', { sessionId: passing.sessionId, force: true });
    const changed = (e: DaemonEvent): e is ItemUpdatedEvent => e.type === 'item.updated' && e.item.id === made.id && dataOf(e.item).tiles;
    await setup.client.call('item.update', { id: made.id, data: { tiles: true } });
    await near.waitFor(changed);
    await setup.recorder.waitFor(changed);
    await fence();
    expect([far.events.some(ofCard), gone.events.some(ofCard)]).toEqual([false, false]);

    const removed = (e: DaemonEvent): e is DaemonEvent => e.type === 'item.removed' && e.id === made.id;
    await setup.client.call('orchestrator.stopCrew', { crewId: started.crew! });
    await near.waitFor((e: DaemonEvent): e is ItemUpdatedEvent => e.type === 'item.updated' && e.item.id === made.id && dataOf(e.item).crew.stopped !== null);
    await setup.client.call('item.delete', { id: made.id });
    await near.waitFor(removed);
    await setup.recorder.waitFor(removed);
    await fence();
    expect([far.events.some(ofCard), gone.events.some(ofCard)]).toEqual([false, false]);
  });

  it('is brought up to date as the daemon starts: made for a running crew without one, and removed for a crew there isn’t or one that has its card', async () => {
    const setup = await crewDaemon();
    const kept = await startQuiet(setup);
    const lost = await startQuiet(setup);
    await setup.daemon.stop();

    // As a release that knew another crew, or wrote the card otherwise, might have left them.
    const db = new DatabaseSync(join(setup.dataDir, 'agent-board.db'));
    db.prepare("UPDATE board_items SET data = json_set(data, '$.title', 'Stale') WHERE id = ?").run(kept.made.id);
    db.prepare("UPDATE board_items SET data = json_set(data, '$.crewId', 'gone') WHERE id = ?").run(lost.made.id);
    const twin = { ...(db.prepare('SELECT * FROM board_items WHERE id = ?').get(kept.made.id) as Record<string, string | number | null>), id: 'twin' };
    db.prepare(`INSERT INTO board_items (${Object.keys(twin).join(', ')}) VALUES (${Object.keys(twin).map(() => '?').join(', ')})`).run(...Object.values(twin));
    db.close();

    const again = await crewDaemon(setup.dataDir);
    await vi.waitFor(
      async () => {
        const cards = await crewCards(again.client);
        expect(cards.map((card) => [dataOf(card).crewId, dataOf(card).title]).sort()).toEqual([[kept.crew, IDENTITY], [lost.crew, IDENTITY]].sort());
        expect(cards.find((card) => dataOf(card).crewId === kept.crew)!.id).toBe(kept.made.id);
        expect(cards.some((card) => card.id === lost.made.id || card.id === 'twin')).toBe(false);
      },
      { timeout: 10_000, interval: 50 },
    );
  });
});
