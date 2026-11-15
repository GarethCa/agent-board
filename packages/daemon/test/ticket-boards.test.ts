// A ticket's board: board items that sit on a ticket tile's own board, not the main board. Listed per level, moved in
// and out, read by the ticket's agents, and gone with the ticket's chat.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { runBoardCommand } from '../src/board-cli.ts';
import type { BoardItem, DaemonEvent, ItemRemovedEvent, ItemUpdatedEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };
const NOTE = { kind: 'sticky' as const, width: 200, height: 160, data: { text: 'Ask about the API', color: '#ffd966' } };

async function setUp(dataDir = tempDataDir()) {
  const daemon = await startTestDaemon({ dataDir, worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }) });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = (await client.call('zone.list'))[0] ?? (await client.call('zone.add', { path: tempRepo(), x: 100, y: 50, name: 'web' }));
  return { daemon, dataDir, client, recorder, zone };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

/** A ticket's chat, as the app starts one, and a helper in its ticket. */
async function ticket(setup: Setup, prompt?: string) {
  const chat = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'chat', ticketChat: true, ...(prompt === undefined ? {} : { prompt }), ...SIZE });
  const helper = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'builder', ticket: chat.sessionId, ...SIZE });
  return { chat, helper };
}

/** The board token `agent` printed, its first prompt having been `Print your board identity`. */
async function tokenOf(setup: Setup, sessionId: string): Promise<string> {
  await setup.client.call('session.attach', { sessionId });
  await setup.recorder.waitForText(sessionId, ':end\r\n');
  return /identity:(.*):end\r\n/.exec(setup.recorder.screenText(sessionId))![1]!;
}

const ids = (items: BoardItem[]) => items.map((item) => item.id);

/** Runs `agent-board <args>` as the agent whose board token is `token`: what it printed and its exit code. */
async function cli(setup: Setup, token: string, ...args: string[]) {
  let out = '';
  let err = '';
  const env = { AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: token };
  const code = await runBoardCommand(args[0]!, args.slice(1), { out: (text) => (out += text), err: (text) => (err += text), env });
  return { code, out, err };
}

describe("a ticket's board", () => {
  it('holds an item made on it, listed on its own level and left out of the main board', async () => {
    const setup = await setUp();
    const { chat } = await ticket(setup);
    const loose = await setup.client.call('item.create', { ...NOTE, zoneId: setup.zone.id, x: 10, y: 10 });
    const nested = await setup.client.call('item.create', { ...NOTE, zoneId: null, ticket: chat.sessionId, x: 40, y: 30 });
    expect(nested).toMatchObject({ ticket: chat.sessionId, zoneId: null, x: 40, y: 30 });
    expect(loose.ticket).toBeNull();

    expect(ids(await setup.client.call('item.list'))).toEqual([loose.id]);
    expect(ids(await setup.client.call('item.list', { ticket: chat.sessionId }))).toEqual([nested.id]);
    const event = await setup.recorder.waitFor((e: DaemonEvent): e is ItemUpdatedEvent => e.type === 'item.updated' && e.item.id === nested.id);
    expect(event.item.ticket).toBe(chat.sessionId);
  });

  it('moves an item out to the zone and back in, each level listing it only where it is', async () => {
    const setup = await setUp();
    const { chat } = await ticket(setup);
    const nested = await setup.client.call('item.create', { ...NOTE, zoneId: null, ticket: chat.sessionId, x: 40, y: 30 });

    const out = await setup.client.call('item.update', { id: nested.id, ticket: null, zoneId: setup.zone.id, x: 300, y: 200 });
    expect(out).toMatchObject({ ticket: null, zoneId: setup.zone.id, x: 300, y: 200 });
    expect(ids(await setup.client.call('item.list'))).toEqual([nested.id]);
    expect(await setup.client.call('item.list', { ticket: chat.sessionId })).toEqual([]);

    const back = await setup.client.call('item.update', { id: nested.id, ticket: chat.sessionId, x: 5, y: 6 });
    expect(back).toMatchObject({ ticket: chat.sessionId, zoneId: null, x: 5, y: 6 });
    expect(await setup.client.call('item.list')).toEqual([]);
    expect(ids(await setup.client.call('item.list', { ticket: chat.sessionId }))).toEqual([nested.id]);

    // Moved about on its own board, it stays there.
    expect(await setup.client.call('item.update', { id: nested.id, x: 70 })).toMatchObject({ ticket: chat.sessionId, zoneId: null, x: 70, y: 6 });
  });

  it('is only a ticket chat’s, never in a zone, and a move between levels says where it lands', async () => {
    const setup = await setUp();
    const { chat, helper } = await ticket(setup);
    const plain = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'plain', ...SIZE });
    for (const sessionId of [helper.sessionId, plain.sessionId, 'nobody']) {
      await expect(setup.client.call('item.create', { ...NOTE, zoneId: null, ticket: sessionId, x: 0, y: 0 })).rejects.toThrow(/is no ticket's chat/);
    }
    await expect(setup.client.call('item.create', { ...NOTE, zoneId: setup.zone.id, ticket: chat.sessionId, x: 0, y: 0 })).rejects.toThrow(
      /an item on a ticket's board is in no zone/,
    );
    await expect(
      setup.client.call('item.create', { kind: 'stages', zoneId: null, ticket: chat.sessionId, x: 0, y: 0, width: 600, height: 92, data: { joined: [], left: [] } }),
    ).rejects.toThrow(/a stage board belongs in a zone/);

    const loose = await setup.client.call('item.create', { ...NOTE, zoneId: null, x: 0, y: 0 });
    await expect(setup.client.call('item.update', { id: loose.id, ticket: chat.sessionId })).rejects.toThrow(/x and y/);
    await expect(setup.client.call('item.update', { id: loose.id, ticket: chat.sessionId, x: 1 })).rejects.toThrow(/x and y/);
    await expect(setup.client.call('item.update', { id: loose.id, ticket: chat.sessionId, zoneId: setup.zone.id, x: 1, y: 1 })).rejects.toThrow(/in no zone/);
    await expect(setup.client.call('item.update', { id: loose.id, ticket: helper.sessionId, x: 1, y: 1 })).rejects.toThrow(/is no ticket's chat/);
    const nested = await setup.client.call('item.create', { ...NOTE, zoneId: null, ticket: chat.sessionId, x: 0, y: 0 });
    await expect(setup.client.call('item.update', { id: nested.id, zoneId: setup.zone.id })).rejects.toThrow(/in no zone/);
    expect(await setup.client.call('item.list', { ticket: chat.sessionId })).toEqual([nested]);
  });

  it('lists every level for the daemon alone', async () => {
    const setup = await setUp();
    await expect(setup.client.call('item.list', { allBoards: true })).rejects.toThrow(/allBoards is the daemon's own/);
    await expect(setup.client.call('item.list', { ticket: 7 } as never)).rejects.toThrow(/ticket must be a string/);
    // No params, sent as null as some JSON-RPC clients do, list the main board.
    expect(await setup.client.call('item.list', null as never)).toEqual(await setup.client.call('item.list'));
  });

  it('joins a connector only to objects on the same level', async () => {
    const setup = await setUp();
    const { chat } = await ticket(setup);
    const top = await setup.client.call('item.create', { ...NOTE, zoneId: null, x: 0, y: 0 });
    const a = await setup.client.call('item.create', { ...NOTE, zoneId: null, ticket: chat.sessionId, x: 0, y: 0 });
    const b = await setup.client.call('item.create', { ...NOTE, zoneId: null, ticket: chat.sessionId, x: 300, y: 0 });
    const end = (id: string) => ({ type: 'item' as const, id, side: 'right' as const });
    await expect(setup.client.call('connector.create', { from: end(top.id), to: end(a.id) })).rejects.toThrow(/on the same board/);
    await expect(setup.client.call('connector.create', { from: { type: 'agent', id: chat.sessionId, side: 'left' }, to: end(a.id) })).rejects.toThrow(/on the same board/);
    const inside = await setup.client.call('connector.create', { from: end(a.id), to: end(b.id) });
    await expect(setup.client.call('connector.update', { id: inside.id, to: end(top.id) })).rejects.toThrow(/on the same board/);
    // An item joined to another on its board stays on it.
    await expect(setup.client.call('item.update', { id: a.id, ticket: null, zoneId: null, x: 0, y: 0 })).rejects.toThrow(/joined by a connector/);
    expect((await setup.client.call('item.list', { ticket: chat.sessionId })).map((item) => item.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("who reads a ticket's board", () => {
  it('is its chat and its helpers: a memory and a queue on it are found by them, and by no other agent in the zone', async () => {
    const setup = await setUp();
    const spawn = async (fields: { name: string; ticketChat?: boolean; ticket?: string }) => {
      const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'Print your board identity', ...fields, ...SIZE });
      return { agent, token: await tokenOf(setup, agent.sessionId) };
    };
    const chat = await spawn({ name: 'chat', ticketChat: true });
    const helper = await spawn({ name: 'builder', ticket: chat.agent.sessionId });
    const other = await spawn({ name: 'other' });
    const madeBy = { kind: 'user' };
    const memory = await setup.client.call('item.create', {
      kind: 'memory',
      zoneId: null,
      ticket: chat.agent.sessionId,
      x: 0,
      y: 0,
      width: 340,
      height: 220,
      data: { title: 'Ticket notes', madeBy, noAgents: false, count: 0 },
    });
    const queue = await setup.client.call('item.create', {
      kind: 'queue',
      zoneId: null,
      ticket: chat.agent.sessionId,
      x: 400,
      y: 0,
      width: 340,
      height: 244,
      data: { title: 'Ticket jobs', madeBy, noAgents: false, count: 0, audience: 'agents' },
    });
    await setup.client.call('memory.change', { id: memory.id, change: { action: 'add', key: 'api', text: 'v2' } });
    await setup.client.call('queue.change', { id: queue.id, change: { action: 'add', text: 'Write the migration' } });

    for (const { token } of [chat, helper]) {
      const as = await connectTestClient(setup.daemon);
      expect((await as.call('board.listMemories', { token })).map((item) => item.id)).toEqual([memory.id]);
      expect((await as.call('board.readMemory', { token, id: memory.id })).entries.map((entry) => entry.text)).toEqual(['v2']);
      expect((await as.call('board.listQueues', { token })).map((item) => item.id)).toEqual([queue.id]);
      expect((await as.call('board.readQueue', { token, id: queue.id })).jobs.map((job) => job.text)).toEqual(['Write the migration']);
    }
    // The commands find them by title or ref for the ticket's agents, and say where they are.
    const ref = `item:${memory.id}`;
    for (const { token } of [chat, helper]) {
      const listed = await cli(setup, token, 'memory', 'ls');
      expect(listed.code).toBe(0);
      expect(listed.out).toMatch(/“Ticket notes”.*\(on agent:\S+ chat's ticket board\)/);
      expect(listed.out).not.toContain('(loose)');
      for (const named of ['Ticket notes', ref]) {
        const read = await cli(setup, token, 'memory', 'read', named);
        expect(read.err).toBe('');
        expect(read.out).toContain('v2');
      }
      expect((await cli(setup, token, 'queue', 'read', 'Ticket jobs')).out).toContain('Write the migration');
      expect((await cli(setup, token, 'show', ref)).out).toMatch(/zone\s+\(on agent:\S+ chat's ticket board\)/);
    }
    for (const named of ['Ticket notes', ref]) {
      const refused = await cli(setup, other.token, 'memory', 'read', named);
      expect(refused.code).not.toBe(0);
      expect(refused.out).not.toContain('v2');
    }
    const { token } = other;
    const as = await connectTestClient(setup.daemon);
    expect(await as.call('board.listMemories', { token })).toEqual([]);
    await expect(as.call('board.readMemory', { token, id: memory.id })).rejects.toThrow(/on a ticket's board you are not on/);
    await expect(as.call('board.readQueue', { token, id: queue.id })).rejects.toThrow(/on a ticket's board you are not on/);
  });
});

describe("a ticket's board when its chat goes", () => {
  const gone = (setup: Setup, id: string) => setup.recorder.waitFor((e: DaemonEvent): e is ItemRemovedEvent => e.type === 'item.removed' && e.id === id);

  it('goes with its chat when the app deletes it, each item told as removed from its level', async () => {
    const setup = await setUp();
    const { chat } = await ticket(setup);
    const top = await setup.client.call('item.create', { ...NOTE, zoneId: null, x: 0, y: 0 });
    const nested = await setup.client.call('item.create', { ...NOTE, zoneId: null, ticket: chat.sessionId, x: 0, y: 0 });
    await setup.client.call('agent.delete', { sessionId: chat.sessionId });
    expect((await gone(setup, nested.id)).ticket).toBe(chat.sessionId);
    expect(ids(await setup.client.call('item.list'))).toEqual([top.id]);
    expect(await setup.client.call('item.list', { ticket: chat.sessionId })).toEqual([]);
  });

  it('goes when its ticket is closed, and stays when the close is refused', async () => {
    const setup = await setUp();
    const lead = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'lead', prompt: 'Print your board identity', ...SIZE });
    const leadToken = await tokenOf(setup, lead.sessionId);
    const asLead = await connectTestClient(setup.daemon);
    const chat = await asLead.call('orchestrator.spawn', { token: leadToken, zoneId: setup.zone.id, name: 'chat', ticketChat: true });
    // A helper the lead did not start holds the close back.
    await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'builder', ticket: chat.sessionId, ...SIZE });
    const nested = await setup.client.call('item.create', { ...NOTE, zoneId: null, ticket: chat.sessionId, x: 0, y: 0 });
    await expect(asLead.call('orchestrator.close', { token: leadToken, sessionId: chat.sessionId, remove: true })).rejects.toThrow(/a helper you did not start/);
    expect(ids(await setup.client.call('item.list', { ticket: chat.sessionId }))).toEqual([nested.id]);

    await setup.client.call('orchestrator.close', { sessionId: chat.sessionId });
    await gone(setup, nested.id);
    expect(await setup.client.call('item.list', { ticket: chat.sessionId })).toEqual([]);
  });

  it('goes at start when its chat went while the daemon was down', async () => {
    const first = await setUp();
    const { chat } = await ticket(first);
    const nested = await first.client.call('item.create', { ...NOTE, zoneId: null, ticket: chat.sessionId, x: 0, y: 0 });
    const kept = await first.client.call('item.create', { ...NOTE, zoneId: null, x: 0, y: 0 });
    await first.daemon.stop();
    const db = new DatabaseSync(join(first.dataDir, 'agent-board.db'));
    db.prepare('DELETE FROM agents WHERE session_id = ? OR ticket = ?').run(chat.sessionId, chat.sessionId);
    db.close();
    const again = await setUp(first.dataDir);
    expect(ids(await again.client.call('item.list'))).toEqual([kept.id]);
    expect(await again.client.call('item.list', { ticket: chat.sessionId })).toEqual([]);
    const db2 = new DatabaseSync(join(first.dataDir, 'agent-board.db'));
    expect(db2.prepare('SELECT id FROM board_items WHERE id = ?').get(nested.id)).toBeUndefined();
    db2.close();
  });
});
