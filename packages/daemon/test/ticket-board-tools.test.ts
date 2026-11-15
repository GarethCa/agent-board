// The agent tools on a ticket's own board: `map` and `board` read it, `move` takes a note onto it and back off, and the
// tools that place things put them there, a helper's by default, through the CLI and the MCP tools alike.
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { runBoardCommand } from '../src/board-cli.ts';
import { boardMcpHandlers } from '../src/board-mcp.ts';
import { openBoardSession } from '../src/board-ops.ts';
import type { BoardItem } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };
const NOTE = { kind: 'sticky' as const, width: 200, height: 160, data: { text: 'Ask about the API', color: '#ffd966' } };

async function setUp() {
  const daemon = await startTestDaemon({ dataDir: tempDataDir(), worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }) });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = (await client.call('zone.list'))[0] ?? (await client.call('zone.add', { path: tempRepo(), x: 100, y: 50, name: 'web' }));
  const spawn = async (fields: { name: string; zoneId?: string; ticketChat?: boolean; ticket?: string }) => {
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Print your board identity', ...fields, ...SIZE });
    await client.call('session.attach', { sessionId: agent.sessionId });
    await recorder.waitForText(agent.sessionId, ':end\r\n');
    const token = /identity:(.*):end\r\n/.exec(recorder.screenText(agent.sessionId))![1]!;
    return { agent, token };
  };
  // A ticket's chat and a helper beside it, in the zone.
  const chat = await spawn({ name: 'chat', ticketChat: true });
  const helper = await spawn({ name: 'builder', ticket: chat.agent.sessionId });
  return { daemon, client, recorder, zone, spawn, chat, helper };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

/** Runs `agent-board <args>` as the agent whose board token is `token`: what it printed and its exit code. */
async function cli(setup: Setup, token: string, ...args: string[]) {
  let out = '';
  let err = '';
  const env = { AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: token };
  const code = await runBoardCommand(args[0]!, args.slice(1), { out: (text) => (out += text), err: (text) => (err += text), env });
  return { code, out, err };
}

/** Calls the MCP tool `name` as the agent whose board token is `token`: its text, and whether it was refused. */
async function tool(setup: Setup, token: string, name: string, args: Record<string, unknown>) {
  const handlers = boardMcpHandlers({
    openSession: () => openBoardSession({ AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: token }),
    cwd: () => process.cwd(),
  });
  const result = await handlers['tools/call']({ name, arguments: args }, { signal: new AbortController().signal } as never);
  return { text: result.content.map((each) => (each.type === 'text' ? each.text : '')).join(''), isError: result.isError === true };
}

const onTicket = (setup: Setup) => setup.client.call('item.list', { ticket: setup.chat.agent.sessionId });
const onMain = (setup: Setup) => setup.client.call('item.list');
const ids = (items: BoardItem[]) => items.map((item) => item.id);
const ref = (id: string) => `item:${id.slice(0, 4)}`;

describe("move, onto a ticket's board and back off", () => {
  it('takes a note from the zone onto the ticket chat’s board at a place, and back to the zone', async () => {
    const setup = await setUp();
    const note = await setup.client.call('item.create', { ...NOTE, zoneId: setup.zone.id, x: 40, y: 900 });

    const on = await cli(setup, setup.chat.token, 'move', note.id, '--to', `agent:${setup.chat.agent.sessionId}`, '--at', '30,20');
    expect(on.err).toBe('');
    expect(on.out).toMatch(/on agent:\w+ chat's ticket board/);
    expect(ids(await onTicket(setup))).toEqual([note.id]);
    expect(ids(await onMain(setup))).not.toContain(note.id);
    expect((await onTicket(setup))[0]).toMatchObject({ zoneId: null, ticket: setup.chat.agent.sessionId });

    const off = await cli(setup, setup.chat.token, 'move', note.id, '--to', setup.zone.id, '--at', '0,700');
    expect(off.err).toBe('');
    expect(off.out).toMatch(/in zone:\w+ /);
    expect(await onTicket(setup)).toEqual([]);
    expect((await onMain(setup)).find((item) => item.id === note.id)).toMatchObject({ zoneId: setup.zone.id, ticket: null });
  });

  it('moves a note about on the ticket’s board, and `--to ticket` is the caller’s own', async () => {
    const setup = await setUp();
    const note = await setup.client.call('item.create', { ...NOTE, zoneId: null, ticket: setup.chat.agent.sessionId, x: 0, y: 0 });
    const moved = await cli(setup, setup.helper.token, 'move', note.id, '--at', '500,300');
    expect(moved.err).toBe('');
    expect((await onTicket(setup))[0]).toMatchObject({ ticket: setup.chat.agent.sessionId, zoneId: null });

    const out = await setup.client.call('item.create', { ...NOTE, zoneId: setup.zone.id, x: 40, y: 900 });
    const back = await cli(setup, setup.helper.token, 'move', out.id, '--to', 'ticket', '--near', ref(note.id));
    expect(back.err).toBe('');
    expect(ids(await onTicket(setup)).sort()).toEqual([note.id, out.id].sort());
  });

  it('is refused across boards without a place, for a tile, and to an agent that is no ticket’s chat', async () => {
    const setup = await setUp();
    const note = await setup.client.call('item.create', { ...NOTE, zoneId: setup.zone.id, x: 40, y: 900 });
    const chatRef = `agent:${setup.chat.agent.sessionId}`;

    const bare = await cli(setup, setup.chat.token, 'move', note.id, '--to', chatRef);
    expect(bare.code).not.toBe(0);
    expect(bare.err).toMatch(/moving to another board takes a place on it/);
    const backBare = await setup.client.call('item.create', { ...NOTE, zoneId: null, ticket: setup.chat.agent.sessionId, x: 0, y: 0 });
    expect((await cli(setup, setup.chat.token, 'move', backBare.id, '--to', 'board')).err).toMatch(/moving to another board takes a place on it/);

    const tile = await cli(setup, setup.chat.token, 'move', `agent:${setup.helper.agent.sessionId}`, '--to', chatRef, '--at', '0,0');
    expect(tile.err).toMatch(/a tile stays on the main board/);

    const plain = await cli(setup, setup.chat.token, 'move', note.id, '--to', `agent:${setup.helper.agent.sessionId}`, '--at', '0,0');
    expect(plain.err).toMatch(/is no ticket's chat/);

    const elsewhere = await cli(setup, setup.chat.token, 'move', note.id, '--to', setup.zone.id, '--near', ref(backBare.id));
    expect(elsewhere.err).toMatch(/on another board than the one named/);

    // Nothing moved.
    expect((await onMain(setup)).find((item) => item.id === note.id)).toMatchObject({ zoneId: setup.zone.id });
    expect(ids(await onTicket(setup))).toEqual([backBare.id]);
  });

  it('refuses an agent not on the ticket a card it doesn’t read there, so it can’t move it out to read it', async () => {
    const setup = await setUp();
    expect((await tool(setup, setup.helper.token, 'memory_new', { title: 'Secret builder notes' })).isError).toBe(false);
    const [memory] = await onTicket(setup);
    expect(memory).toMatchObject({ kind: 'memory' });
    const other = await setup.spawn({ name: 'other' });
    expect((await tool(setup, other.token, 'memory_read', {})).text).not.toContain('Secret builder notes');

    // Its own connection: one that has called with a board token speaks for that agent from then on.
    const outsider = await connectTestClient(setup.daemon);
    const move = outsider.call('orchestrator.move', { token: other.token, target: { kind: 'item', id: memory!.id }, zoneId: setup.zone.id, at: { x: 0, y: 900 } });
    await expect(move).rejects.toThrow("that memory is on a ticket's board you are not on");
    // Nor may it go near the card, which would say where the card is.
    const note = await setup.client.call('item.create', { ...NOTE, zoneId: setup.zone.id, x: 40, y: 900 });
    const near = outsider.call('orchestrator.move', { token: other.token, target: { kind: 'item', id: note.id }, near: { kind: 'item', id: memory!.id } });
    await expect(near).rejects.toThrow("that memory is on a ticket's board you are not on");

    expect(ids(await onTicket(setup))).toEqual([memory!.id]);
    expect((await tool(setup, other.token, 'memory_read', {})).text).not.toContain('Secret builder notes');
    // The ticket's own agents still move it.
    expect((await cli(setup, setup.chat.token, 'move', ref(memory!.id), '--at', '300,0')).err).toBe('');
  });

  it('works the same through the MCP move tool, refused without a place', async () => {
    const setup = await setUp();
    const note = await setup.client.call('item.create', { ...NOTE, zoneId: setup.zone.id, x: 40, y: 900 });
    const chatRef = `agent:${setup.chat.agent.sessionId}`;
    const refused = await tool(setup, setup.chat.token, 'move', { tile: note.id, to: chatRef });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toMatch(/moving to another board takes a place on it/);

    const on = await tool(setup, setup.chat.token, 'move', { tile: note.id, to: chatRef, at: '10,10' });
    expect(on.isError).toBe(false);
    expect(on.text).toMatch(/ticket board/);
    expect(ids(await onTicket(setup))).toEqual([note.id]);

    const off = await tool(setup, setup.chat.token, 'move', { tile: note.id, to: 'board', at: '4000,4000' });
    expect(off.isError).toBe(false);
    expect((await onMain(setup)).find((item) => item.id === note.id)).toMatchObject({ zoneId: null, ticket: null });
  });
});

describe("the tools that place things, on a ticket's board", () => {
  it('put a helper’s note and shape on its ticket’s board by default, and a chat’s in its zone', async () => {
    const setup = await setUp();
    expect((await cli(setup, setup.helper.token, 'note', 'add', 'Found the bug')).err).toBe('');
    const shape = await tool(setup, setup.helper.token, 'add_shape', { shape: 'rectangle', text: 'Login' });
    expect(shape.isError).toBe(false);
    expect(shape.text).toMatch(/ticket board/);
    expect((await onTicket(setup)).map((item) => item.kind).sort()).toEqual(['agent-note', 'shape']);

    expect((await cli(setup, setup.chat.token, 'note', 'add', 'Plan')).err).toBe('');
    const chatNote = (await onMain(setup)).find((item) => item.kind === 'agent-note');
    expect(chatNote).toMatchObject({ zoneId: setup.zone.id, ticket: null });
    expect(await onTicket(setup)).toHaveLength(2);
  });

  it('put a chat’s note on its ticket’s board when it names it, and a helper’s in the zone when it names that', async () => {
    const setup = await setUp();
    const named = await tool(setup, setup.chat.token, 'add_note', { text: 'Done so far', to: 'ticket' });
    expect(named.isError).toBe(false);
    expect(await onTicket(setup)).toHaveLength(1);
    expect((await cli(setup, setup.helper.token, 'note', 'add', '--to', setup.zone.id, 'For everyone')).err).toBe('');
    expect((await onMain(setup)).filter((item) => item.kind === 'agent-note')).toHaveLength(1);
    expect(await onTicket(setup)).toHaveLength(1);
  });

  it('put a helper’s note in its own zone when it is away from its ticket', async () => {
    const setup = await setUp();
    const other = await setup.client.call('zone.add', { path: tempRepo(), x: 3000, y: 50, name: 'api' });
    await setup.client.call('agent.move', { sessionId: setup.helper.agent.sessionId, zoneId: other.id, x: 3100, y: 200 });
    expect((await cli(setup, setup.helper.token, 'note', 'add', 'Over here')).err).toBe('');
    expect(await onTicket(setup)).toEqual([]);
    expect((await onMain(setup)).find((item) => item.kind === 'agent-note')).toMatchObject({ zoneId: other.id });
  });

  it('edit and remove a note on the ticket’s board by its ref', async () => {
    const setup = await setUp();
    await cli(setup, setup.helper.token, 'note', 'add', 'First go');
    const [note] = await onTicket(setup);
    expect((await cli(setup, setup.helper.token, 'note', 'edit', ref(note!.id), '--text', 'Second go')).err).toBe('');
    expect(JSON.stringify((await onTicket(setup))[0]!.data)).toContain('Second go');
    expect((await tool(setup, setup.helper.token, 'remove_note', { note: ref(note!.id) })).isError).toBe(false);
    expect(await onTicket(setup)).toEqual([]);
  });

  it('draw a helper’s diagram on its ticket’s board, connectors too, and export it by default', async () => {
    const setup = await setUp();
    const drawn = await tool(setup, setup.helper.token, 'add_diagram', { mermaid: 'flowchart LR\n  A[Login] --> B[Home]' });
    expect(drawn.isError).toBe(false);
    expect(drawn.text).toMatch(/Drew 2 shapes and 1 connector \(on agent:\w+ chat's ticket board\)/);
    const shapes = await onTicket(setup);
    expect(shapes.map((item) => item.kind)).toEqual(['shape', 'shape']);
    const connectors = await setup.client.call('connector.list');
    expect(connectors).toHaveLength(1);

    const exported = await cli(setup, setup.helper.token, 'diagram', 'export');
    expect(exported.err).toBe('');
    expect(exported.out).toContain('["Login"]');
    expect(exported.out).toContain('["Home"]');
    expect(exported.out).toContain('n1 --> n2');

    // The tree and the map list the connector on the ticket's board, not loose on the main board.
    const tree = (await cli(setup, setup.helper.token, 'tree')).out;
    expect(tree.slice(tree.indexOf("chat's ticket board"))).toContain(`connector:${connectors[0]!.id.slice(0, 4)}`);
    expect(tree).not.toContain('loose on the board');
    expect((await cli(setup, setup.helper.token, 'zone', 'map')).out).toContain(`connector:${connectors[0]!.id.slice(0, 4)}`);
  });

  it('edit, connect and remove a helper’s shapes on its ticket’s board, and refuse a connector across boards', async () => {
    const setup = await setUp();
    expect((await cli(setup, setup.helper.token, 'shape', 'add', 'rectangle', '--text', 'A')).err).toBe('');
    expect((await tool(setup, setup.helper.token, 'add_shape', { shape: 'rectangle', text: 'B' })).isError).toBe(false);
    const [a, b] = await onTicket(setup);

    const connected = await cli(setup, setup.helper.token, 'connect', ref(a!.id), ref(b!.id));
    expect(connected.err).toBe('');
    expect(await setup.client.call('connector.list')).toHaveLength(1);
    const [connector] = await setup.client.call('connector.list');
    expect((await tool(setup, setup.helper.token, 'edit_connector', { connector: `connector:${connector!.id.slice(0, 4)}`, label: 'then' })).isError).toBe(false);
    expect((await tool(setup, setup.helper.token, 'remove_connector', { connector: `connector:${connector!.id.slice(0, 4)}` })).isError).toBe(false);
    expect((await tool(setup, setup.helper.token, 'connect', { from: ref(a!.id), to: ref(b!.id) })).isError).toBe(false);

    expect((await cli(setup, setup.chat.token, 'shape', 'add', 'rectangle', '--text', 'C')).err).toBe('');
    const main = (await onMain(setup)).find((item) => item.kind === 'shape')!;
    const across = await cli(setup, setup.helper.token, 'connect', ref(a!.id), ref(main.id));
    expect(across.err).toMatch(/same board/);
    expect(await setup.client.call('connector.list')).toHaveLength(1);

    expect((await cli(setup, setup.helper.token, 'shape', 'edit', ref(a!.id), '--text', 'A2')).err).toBe('');
    expect((await onTicket(setup)).find((item) => item.id === a!.id)!.data).toMatchObject({ text: 'A2' });
    expect((await tool(setup, setup.helper.token, 'remove_shape', { item: ref(b!.id) })).isError).toBe(false);
    expect(ids(await onTicket(setup))).toEqual([a!.id]);
  });

  it('put a helper’s queue and steps card on its ticket’s board', async () => {
    const setup = await setUp();
    expect((await tool(setup, setup.helper.token, 'queue_new', { title: 'Next up' })).isError).toBe(false);
    expect((await tool(setup, setup.helper.token, 'steps_new', { title: 'Plan', steps: '- [ ] Read the code\n- [ ] Fix it' })).isError).toBe(false);
    expect((await onTicket(setup)).map((item) => item.kind).sort()).toEqual(['queue', 'steps']);
    expect((await onMain(setup)).filter((item) => item.kind === 'queue' || item.kind === 'steps')).toEqual([]);
  });

  it('put a helper’s clock and memory on its ticket’s board, and a chat’s on the main board', async () => {
    const setup = await setUp();
    const clock = await tool(setup, setup.helper.token, 'clock_add', { cron: '*/30 * * * *', prompt: 'Check the build' });
    expect(clock.isError).toBe(false);
    const memory = await tool(setup, setup.helper.token, 'memory_new', { title: 'Builder notes' });
    expect(memory.isError).toBe(false);
    expect((await onTicket(setup)).map((item) => item.kind).sort()).toEqual(['clock', 'memory']);

    expect((await tool(setup, setup.chat.token, 'clock_add', { cron: '*/30 * * * *', prompt: 'Check the helper' })).isError).toBe(false);
    expect((await onMain(setup)).filter((item) => item.kind === 'clock')).toHaveLength(1);
  });
});

describe("map and board, on a ticket's board", () => {
  it('map reads a helper’s ticket board by default, a chat’s when named, and the zone when named', async () => {
    const setup = await setUp();
    const a = await setup.client.call('item.create', { ...NOTE, zoneId: null, ticket: setup.chat.agent.sessionId, x: 0, y: 0 });
    const b = await setup.client.call('item.create', { ...NOTE, zoneId: null, ticket: setup.chat.agent.sessionId, x: 100, y: 50 });

    const mine = await cli(setup, setup.helper.token, 'zone', 'map');
    expect(mine.err).toBe('');
    expect(mine.out).toMatch(/chat's ticket board {2}2 items/);
    expect(mine.out).toContain(`${ref(a.id)}`);
    expect(mine.out).toMatch(/at 100,50 200×160/);
    expect(mine.out).toContain(`overlapping (${ref(a.id)} / ${ref(b.id)})`);

    const named = await tool(setup, setup.chat.token, 'map', { zone: 'ticket' });
    expect(named.text).toMatch(/chat's ticket board {2}2 items/);
    const zone = await tool(setup, setup.helper.token, 'map', { zone: setup.zone.id });
    expect(zone.text).not.toMatch(/ticket board/);
    expect((await tool(setup, setup.chat.token, 'map', { zone: `agent:${setup.helper.agent.sessionId}` })).text).toMatch(/is no ticket's chat/);
    expect((await cli(setup, setup.chat.token, 'arrange', 'ticket')).out).toMatch(/^Arranged agent:\w+ chat's ticket board:/);
    expect((await cli(setup, setup.chat.token, 'arrange', `agent:${setup.helper.agent.sessionId}`)).err).toMatch(/is no ticket's chat/);
  });

  it('board and tree list the caller’s ticket board, and no other agent’s', async () => {
    const setup = await setUp();
    const note = await setup.client.call('item.create', { ...NOTE, zoneId: null, ticket: setup.chat.agent.sessionId, x: 0, y: 0 });
    const loose = await setup.client.call('item.create', { ...NOTE, zoneId: null, x: 4000, y: 4000 });

    const board = await tool(setup, setup.helper.token, 'board', {});
    const section = board.text.slice(board.text.indexOf("chat's ticket board"));
    expect(section).toContain(ref(note.id));
    expect(board.text.slice(board.text.indexOf('loose on the board'), board.text.indexOf("chat's ticket board"))).not.toContain(ref(note.id));
    expect(board.text).toContain(ref(loose.id));
    expect((await cli(setup, setup.chat.token, 'tree')).out).toContain(ref(note.id));

    const other = await setup.spawn({ name: 'other' });
    expect((await cli(setup, other.token, 'tree')).out).not.toContain("ticket board");
  });
});
