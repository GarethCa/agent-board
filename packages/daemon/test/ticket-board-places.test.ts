// Where a ticket's chat and helpers sit on the ticket's own board: a second place, apart from their tile on the main
// board, kept across a restart and gone with the ticket.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import type { AgentUpdatedEvent, DaemonEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

async function setUp(dataDir = tempDataDir(), repo = tempRepo()) {
  const daemon = await startTestDaemon({ dataDir, worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }) });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = (await client.call('zone.list'))[0] ?? (await client.call('zone.add', { path: repo, x: 100, y: 50, name: 'web' }));
  return { daemon, dataDir, client, recorder, zone };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

async function ticket(setup: Setup) {
  const chat = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'chat', ticketChat: true, ...SIZE });
  const helper = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'builder', ticket: chat.sessionId, ...SIZE });
  return { chat, helper };
}

describe("a place on a ticket's board", () => {
  it('is a helper’s own, apart from its main-board tile, and told to the app', async () => {
    const setup = await setUp();
    const { helper } = await ticket(setup);
    await setup.client.call('agent.move', { sessionId: helper.sessionId, zoneId: setup.zone.id, x: 300, y: 200 });
    expect(helper.ticketPlace).toBeUndefined();

    const placed = await setup.client.call('agent.placeOnTicket', { sessionId: helper.sessionId, x: 40, y: 60 });
    expect(placed.ticketPlace).toEqual({ x: 40, y: 60 });
    expect(placed.position).toMatchObject({ x: 300, y: 200 });
    const told = await setup.recorder.waitFor(
      (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === helper.sessionId && e.agent.ticketPlace !== undefined,
    );
    expect(told.agent.ticketPlace).toEqual({ x: 40, y: 60 });

    // A move on the main board leaves its ticket-board place where it was.
    const moved = await setup.client.call('agent.move', { sessionId: helper.sessionId, zoneId: setup.zone.id, x: 500, y: 20 });
    expect(moved.ticketPlace).toEqual({ x: 40, y: 60 });
  });

  it('is the chat’s too, on its own board', async () => {
    const setup = await setUp();
    const { chat } = await ticket(setup);
    const placed = await setup.client.call('agent.placeOnTicket', { sessionId: chat.sessionId, x: -20, y: 0 });
    expect(placed.ticketPlace).toEqual({ x: -20, y: 0 });
    expect(placed.position).toEqual(chat.position);
  });

  it('is kept across a restart', async () => {
    const first = await setUp();
    const { helper } = await ticket(first);
    await first.client.call('agent.placeOnTicket', { sessionId: helper.sessionId, x: 12.5, y: 80 });
    await first.daemon.stop();
    const again = await setUp(first.dataDir);
    const agents = await again.client.call('agent.list');
    expect(agents.find((agent) => agent.sessionId === helper.sessionId)?.ticketPlace).toEqual({ x: 12.5, y: 80 });
  });

  it('is refused for an agent in no ticket, and for a place that is not a number', async () => {
    const setup = await setUp();
    const loose = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'loose', ...SIZE });
    await expect(setup.client.call('agent.placeOnTicket', { sessionId: loose.sessionId, x: 1, y: 1 })).rejects.toThrow(/not in a ticket/);
    const { helper } = await ticket(setup);
    await expect(setup.client.call('agent.placeOnTicket', { sessionId: helper.sessionId, x: Number.NaN, y: 1 })).rejects.toThrow();
    await expect(setup.client.call('agent.placeOnTicket', { sessionId: 'no-such-agent', x: 1, y: 1 })).rejects.toThrow();
  });

  it('goes with the ticket: a helper left by its chat has no place on a ticket’s board', async () => {
    const first = await setUp();
    const { chat, helper } = await ticket(first);
    await first.client.call('agent.placeOnTicket', { sessionId: helper.sessionId, x: 40, y: 60 });
    await first.daemon.stop();
    const db = new DatabaseSync(join(first.dataDir, 'agent-board.db'));
    db.prepare('DELETE FROM agents WHERE session_id = ?').run(chat.sessionId);
    db.close();
    const again = await setUp(first.dataDir);
    const left = (await again.client.call('agent.list')).find((agent) => agent.sessionId === helper.sessionId)!;
    expect(left.ticket).toBeNull();
    expect(left.ticketPlace).toBeUndefined();
  });
});
