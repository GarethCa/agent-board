import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { BOARD_ERROR, STICKY_SIZE, type Agent, type AgentUpdatedEvent, type BoardItem, type DaemonEvent, type ItemRemovedEvent, type RemoveAsk } from '../src/protocol.ts';
import { deletedName, openWork } from '../src/item-deletes.ts';
import { itemMaker } from '../src/item-makers.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

/** An agent deletes a board item: its own at once, anyone else's only as the user allows, open work only when forced. */

const SIZE = { cols: 120, rows: 40 };

async function setUp() {
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
  return { daemon, client, recorder, zone };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

/** `agent`, connected as itself with the board token it prints. */
async function identified(setup: Setup, agent: Agent) {
  const { daemon, client, recorder } = setup;
  await client.call('session.attach', { sessionId: agent.sessionId });
  await recorder.waitForText(agent.sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(recorder.screenText(agent.sessionId))![1]!;
  const connection = await connectTestClient(daemon);
  await connection.call('board.identify', { token });
  return { agent, token, connection };
}

/** An agent the user started in the zone, connected as itself. */
const agentIn = async (setup: Setup, name = 'lead') =>
  identified(setup, await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name, prompt: 'Print your board identity', ...SIZE }));

const answered = new Set<string>();
async function askOf(setup: Setup, sessionId: string): Promise<RemoveAsk> {
  const event = await setup.recorder.waitFor(
    (e: DaemonEvent): e is AgentUpdatedEvent =>
      e.type === 'agent.updated' && e.agent.sessionId === sessionId && e.agent.removeAsk != null && !answered.has(e.agent.removeAsk.id),
  );
  const ask = (event.agent as Agent).removeAsk!;
  answered.add(ask.id);
  return ask;
}

const removedEvent = (setup: Setup, id: string) =>
  setup.recorder.waitFor((e: DaemonEvent): e is ItemRemovedEvent => e.type === 'item.removed' && e.id === id);

const onBoard = async (setup: Setup, id: string) => (await setup.client.call('item.list', {})).some((item) => item.id === id);

const userSticky = (setup: Setup, text = 'mine') =>
  setup.client.call('item.create', { kind: 'sticky', zoneId: setup.zone.id, x: 40, y: 40, ...STICKY_SIZE, data: { text, color: '#fff3a3' } });

describe('an agent deleting a board item', () => {
  it('deletes an empty queue it made at once, and the board hears what an undo puts back, its connectors too', async () => {
    const setup = await setUp();
    const { token, connection } = await agentIn(setup);
    const queue = await connection.call('board.newQueue', { token, title: 'Stray' });
    const note = await userSticky(setup);
    const line = await setup.client.call('connector.create', { from: { type: 'item', id: queue.id, side: 'right' }, to: { type: 'item', id: note.id, side: 'left' } });

    const removed = removedEvent(setup, queue.id);
    const told = await connection.call('orchestrator.deleteItem', { token, id: queue.id });
    expect(told).toEqual({ outcome: 'deleted', id: queue.id, name: 'queue “Stray”', why: null });
    expect(await onBoard(setup, queue.id)).toBe(false);
    const event = await removed;
    expect(event.undo?.item).toMatchObject({ id: queue.id, kind: 'queue', data: { title: 'Stray' } });
    expect(event.undo?.connectors.map((each) => each.id)).toEqual([line.id]);

    // Undoing makes it again under its id, as the board's undo does for the user's own Delete.
    await setup.client.call('item.create', { ...event.undo!.item });
    expect(await onBoard(setup, queue.id)).toBe(true);
    expect((await setup.client.call('queue.read', { id: queue.id })).item.id).toBe(queue.id);
  });

  it("refuses a queue with open jobs, saying how many, until forced", async () => {
    const setup = await setUp();
    const { token, connection } = await agentIn(setup);
    const queue = await connection.call('board.newQueue', { token, title: 'Work' });
    for (const text of ['one', 'two']) await connection.call('board.changeQueue', { token, id: queue.id, change: { action: 'add', text } });

    await expect(connection.call('orchestrator.deleteItem', { token, id: queue.id })).rejects.toThrow(/has 2 open jobs.*--force/);
    expect(await onBoard(setup, queue.id)).toBe(true);
    expect((await connection.call('orchestrator.deleteItem', { token, id: queue.id, force: true })).outcome).toBe('deleted');
    expect(await onBoard(setup, queue.id)).toBe(false);
  });

  it('refuses a to-do list with open lines until forced', async () => {
    const setup = await setUp();
    const { token, connection } = await agentIn(setup);
    const { item } = await connection.call('board.remind', { token, text: ['approve the pull request'] });
    await expect(connection.call('orchestrator.deleteItem', { token, id: item.id })).rejects.toThrow(/has 1 open line:/);
    expect((await connection.call('orchestrator.deleteItem', { token, id: item.id, force: true })).outcome).toBe('deleted');
  });

  it("refuses the user's item without --ask, and with it deletes it only once the user allows", async () => {
    const setup = await setUp();
    const { agent, token, connection } = await agentIn(setup);
    const note = await userSticky(setup, 'keep me?');

    const refused = connection.call('orchestrator.deleteItem', { token, id: note.id });
    await expect(refused).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    await expect(refused).rejects.toThrow(/not marked as made by you or your crew: add --ask/);

    const denied = connection.call('orchestrator.deleteItem', { token, id: note.id, ask: true });
    const first = await askOf(setup, agent.sessionId);
    expect(first).toMatchObject({ items: true, tiles: [{ sessionId: note.id, name: 'sticky “keep me?”', held: null }] });
    await setup.client.call('removeAsk.decide', { sessionId: agent.sessionId, askId: first.id, allow: false });
    expect(await denied).toMatchObject({ outcome: 'denied', why: 'the user said no' });
    expect(await onBoard(setup, note.id)).toBe(true);

    const allowed = connection.call('orchestrator.deleteItem', { token, id: note.id, ask: true });
    const second = await askOf(setup, agent.sessionId);
    // As the inbox row sends it: an item is never held back, so nothing is ticked.
    await setup.client.call('removeAsk.decide', { sessionId: agent.sessionId, askId: second.id, allow: true, include: [] });
    expect(await allowed).toEqual({ outcome: 'deleted', id: note.id, name: 'sticky “keep me?”', why: null });
    expect(await onBoard(setup, note.id)).toBe(false);
  });

  it("asks for another agent's queue, and on Allow keeps it if a job opened on it while the ask waited", async () => {
    const setup = await setUp();
    const lead = await agentIn(setup);
    const other = await agentIn(setup, 'other');
    const queue = await other.connection.call('board.newQueue', { token: other.token, title: 'Theirs' });

    await expect(lead.connection.call('orchestrator.deleteItem', { token: lead.token, id: queue.id })).rejects.toThrow(/made by another agent: add --ask/);

    const waiting = lead.connection.call('orchestrator.deleteItem', { token: lead.token, id: queue.id, ask: true });
    const ask = await askOf(setup, lead.agent.sessionId);
    await other.connection.call('board.changeQueue', { token: other.token, id: queue.id, change: { action: 'add', text: 'late' } });
    await setup.client.call('removeAsk.decide', { sessionId: lead.agent.sessionId, askId: ask.id, allow: true });
    expect(await waiting).toMatchObject({ outcome: 'kept', why: expect.stringMatching(/has 1 open job now: add --force/) });
    expect(await onBoard(setup, queue.id)).toBe(true);

    const forced = lead.connection.call('orchestrator.deleteItem', { token: lead.token, id: queue.id, ask: true, force: true });
    const again = await askOf(setup, lead.agent.sessionId);
    await setup.client.call('removeAsk.decide', { sessionId: lead.agent.sessionId, askId: again.id, allow: true });
    expect((await forced).outcome).toBe('deleted');
    expect(await onBoard(setup, queue.id)).toBe(false);
  });

  it('deletes a queue an agent it started made at once', async () => {
    const setup = await setUp();
    const lead = await agentIn(setup);
    const crew = await identified(setup, await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'crew', prompt: 'Print your board identity' }));
    const queue = await crew.connection.call('board.newQueue', { token: crew.token, title: 'Crew work' });
    expect((await lead.connection.call('orchestrator.deleteItem', { token: lead.token, id: queue.id })).outcome).toBe('deleted');
  });

  it('keeps the item when the user does not answer in time', async () => {
    const setup = await setUp();
    const { agent, token, connection } = await agentIn(setup);
    const note = await userSticky(setup);
    const waiting = connection.call('orchestrator.deleteItem', { token, id: note.id, ask: true, timeoutMs: 300 });
    await askOf(setup, agent.sessionId);
    expect(await waiting).toMatchObject({ outcome: 'timed-out' });
    expect(await onBoard(setup, note.id)).toBe(true);
  });

  it("names an item that isn't there", async () => {
    const setup = await setUp();
    const { token, connection } = await agentIn(setup);
    await expect(connection.call('orchestrator.deleteItem', { token, id: 'nope' })).rejects.toThrow(/no board item nope/);
  });
});

describe('what a delete reads of an item', () => {
  const item = (kind: BoardItem['kind'], data: Record<string, unknown>): BoardItem =>
    ({ id: 'i', kind, zoneId: null, ticket: null, x: 0, y: 0, width: 1, height: 1, z: 1, rotation: 0, data, createdAt: '', updatedAt: '' }) as BoardItem;
  const who = { kind: 'agent', sessionId: 's1', name: 'a' };

  it('finds its maker in its made_by mark, else in the data of a card made for an agent, else no one', () => {
    expect(itemMaker(item('sticky', {}), 's9')).toBe('s9');
    expect(itemMaker(item('queue', { madeBy: who }), null)).toBe('s1');
    expect(itemMaker(item('todo', { owner: who }), null)).toBe('s1');
    expect(itemMaker(item('sticky', { madeBy: { kind: 'user' } }), null)).toBeNull();
    expect(itemMaker(item('document', { agent: who }), null)).toBe('s1');
    // An agent note's data names whom it is about, not who wrote it: only its mark counts.
    expect(itemMaker(item('agent-note', { about: 's1' }), null)).toBeNull();
  });

  it("counts a steps card's open steps until it is closed, and nothing on other kinds", () => {
    const steps = [
      { kind: 'todo', done: null, answer: null },
      { kind: 'todo', done: { by: who, at: '' }, answer: null },
      { kind: 'one', done: null, answer: null },
    ];
    expect(openWork(item('steps', { steps, closedAt: null }), 0)).toEqual({ count: 2, what: 'open step' });
    expect(openWork(item('steps', { steps, closedAt: 'x' }), 0)).toBeNull();
    expect(openWork(item('sticky', { count: 5 }), 0)).toBeNull();
    expect(openWork(item('queue', {}), 3)).toEqual({ count: 3, what: 'open job' });
  });

  it('names it by kind and its words', () => {
    expect(deletedName(item('todo', { lines: [] }))).toBe('to-do list');
    expect(deletedName(item('queue', { title: 'Notes' }))).toBe('queue “Notes”');
  });
});
