// Arranging a ticket's own board: its chat and helpers laid out beside the notes and cards there, by the user or by an
// agent's `arrange ticket`. It moves nothing on the main board, and an arrange of a zone or of the main board moves
// nothing on a ticket's board.
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { runBoardCommand } from '../src/board-cli.ts';
import { arrangeTicketBoard, TICKET_MEMBER_SIZE } from '../src/ticket-tiles.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };
const NOTE = { kind: 'sticky' as const, width: 200, height: 160, data: { text: 'Ask about the API', color: '#ffd966' } };
const { chat: CHAT, helper: HELPER, apart: APART, fromItems: FROM_ITEMS } = TICKET_MEMBER_SIZE;

describe('arrangeTicketBoard', () => {
  const chat = { sessionId: 'c', ticketChat: true };
  const helpers = [
    { sessionId: 'h1', ticketChat: false },
    { sessionId: 'h2', ticketChat: false },
  ];

  it('puts the chat at the origin and its helpers in a column on its right, with nothing else there', () => {
    const places = arrangeTicketBoard([chat, ...helpers], []);
    expect(Object.fromEntries(places)).toEqual({
      c: { x: 0, y: 0 },
      h1: { x: CHAT.width + APART, y: 0 },
      h2: { x: CHAT.width + APART, y: HELPER.height + APART },
    });
  });

  it('puts the block a gap left of the items, its top level with theirs, so no tile covers one', () => {
    const items = [
      { x: 400, y: 120, width: 200, height: 160 },
      { x: 700, y: 60, width: 100, height: 100 },
    ];
    const places = arrangeTicketBoard([chat, ...helpers], items);
    const left = 400 - FROM_ITEMS - (CHAT.width + APART + HELPER.width);
    expect(places.get('c')).toEqual({ x: left, y: 60 });
    expect(places.get('h2')).toEqual({ x: left + CHAT.width + APART, y: 60 + HELPER.height + APART });
    for (const [id, at] of places) {
      const size = id === 'c' ? CHAT : HELPER;
      expect(at.x + size.width).toBeLessThanOrEqual(400 - FROM_ITEMS);
    }
  });

  it('keeps a chat alone a gap from the items too', () => {
    expect(arrangeTicketBoard([chat], [{ x: 0, y: 0, width: 10, height: 10 }]).get('c')).toEqual({ x: -FROM_ITEMS - CHAT.width, y: 0 });
  });
});

async function setUp() {
  const daemon = await startTestDaemon({ dataDir: tempDataDir(), worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }) });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = (await client.call('zone.list'))[0] ?? (await client.call('zone.add', { path: tempRepo(), x: 100, y: 50, name: 'web' }));
  const spawn = async (fields: { name: string; ticketChat?: boolean; ticket?: string }) => {
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Print your board identity', ...fields, ...SIZE });
    await client.call('session.attach', { sessionId: agent.sessionId });
    await recorder.waitForText(agent.sessionId, ':end\r\n');
    const token = /identity:(.*):end\r\n/.exec(recorder.screenText(agent.sessionId))![1]!;
    return { agent, token };
  };
  const chat = await spawn({ name: 'chat', ticketChat: true });
  const builder = await spawn({ name: 'builder', ticket: chat.agent.sessionId });
  const reviewer = await spawn({ name: 'reviewer', ticket: chat.agent.sessionId });
  // A loose agent on the main board, and a note in the zone and one loose there, for the main board's arranges to move.
  const loose = await client.call('agent.spawn', { zoneId: null, repo: { path: tempRepo() }, position: { x: 5000, y: 5000 }, prompt: 'hi', name: 'loose', ...SIZE });
  const zoneNote = await client.call('item.create', { ...NOTE, zoneId: zone.id, x: 900, y: 900 });
  const looseNote = await client.call('item.create', { ...NOTE, zoneId: null, x: 7000, y: 7000 });
  return { daemon, client, zone, chat, builder, reviewer, loose, zoneNote, looseNote };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

async function cli(setup: Setup, token: string, ...args: string[]) {
  let out = '';
  let err = '';
  const env = { AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: token };
  const code = await runBoardCommand(args[0]!, args.slice(1), { out: (text) => (out += text), err: (text) => (err += text), env });
  return { code, out, err };
}

/** Where everything on the main board is, and everything on the ticket's own board: what an arrange may move. */
async function places(setup: Setup) {
  const agents = await setup.client.call('agent.list');
  const ticket = setup.chat.agent.sessionId;
  return {
    main: {
      agents: Object.fromEntries(agents.map((agent) => [agent.sessionId, { zoneId: agent.zoneId, position: agent.position }])),
      items: Object.fromEntries((await setup.client.call('item.list')).map((item) => [item.id, { zoneId: item.zoneId, x: item.x, y: item.y }])),
      zones: (await setup.client.call('zone.list')).map((zone) => ({ id: zone.id, x: zone.x, y: zone.y, width: zone.width, height: zone.height })),
    },
    ticket: {
      agents: Object.fromEntries(agents.map((agent) => [agent.sessionId, agent.ticketPlace])),
      items: Object.fromEntries((await setup.client.call('item.list', { ticket })).map((item) => [item.id, { x: item.x, y: item.y }])),
    },
  };
}

describe("arranging a ticket's board", () => {
  it('lays out its chat and helpers beside its items, and moves nothing on the main board', async () => {
    const setup = await setUp();
    const ticket = setup.chat.agent.sessionId;
    const note = await setup.client.call('item.create', { ...NOTE, zoneId: null, ticket, x: 600, y: 40 });
    // The builder dropped on top of the note.
    await setup.client.call('agent.placeOnTicket', { sessionId: setup.builder.agent.sessionId, x: 620, y: 60 });
    const before = await places(setup);

    const result = await setup.client.call('orchestrator.arrangeTicket', { ticket });

    const after = await places(setup);
    expect(after.main).toEqual(before.main);
    expect(after.ticket.items).toEqual({ [note.id]: { x: 600, y: 40 } });
    const left = 600 - FROM_ITEMS - (CHAT.width + APART + HELPER.width);
    expect(after.ticket.agents[ticket]).toEqual({ x: left, y: 40 });
    expect(after.ticket.agents[setup.builder.agent.sessionId]).toEqual({ x: left + CHAT.width + APART, y: 40 });
    expect(after.ticket.agents[setup.reviewer.agent.sessionId]).toEqual({ x: left + CHAT.width + APART, y: 40 + HELPER.height + APART });
    expect(after.ticket.agents[setup.loose.sessionId]).toBeUndefined();
    expect(result.moved.map((each) => each.sessionId).sort()).toEqual([ticket, setup.builder.agent.sessionId, setup.reviewer.agent.sessionId].sort());

    // The same board arranges the same way.
    expect((await setup.client.call('orchestrator.arrangeTicket', { ticket })).moved).toEqual([]);
  });

  it('is refused for an agent that is no ticket’s chat', async () => {
    const setup = await setUp();
    await expect(setup.client.call('orchestrator.arrangeTicket', { ticket: setup.builder.agent.sessionId })).rejects.toThrow(/is no ticket's chat/);
    await expect(setup.client.call('orchestrator.arrangeTicket', { ticket: setup.loose.sessionId })).rejects.toThrow(/is no ticket's chat/);
  });

  it('an agent’s `arrange ticket` arranges its own ticket’s board, and prints what moved and its map', async () => {
    const setup = await setUp();
    const ticket = setup.chat.agent.sessionId;
    await setup.client.call('item.create', { ...NOTE, zoneId: null, ticket, x: 0, y: 0 });
    const before = await places(setup);

    const run = await cli(setup, setup.builder.token, 'arrange', 'ticket');
    expect(run.err).toBe('');
    expect(run.code).toBe(0);
    expect(run.out).toMatch(/^Arranged agent:\w+ chat's ticket board:/);
    expect(run.out).toMatch(/agent:\w+ reviewer at -/);
    const after = await places(setup);
    expect(after.main).toEqual(before.main);
    expect(after.ticket.agents[ticket]).toEqual({ x: -FROM_ITEMS - (CHAT.width + APART + HELPER.width), y: 0 });

    const again = await cli(setup, setup.chat.token, 'arrange', `agent:${ticket}`);
    expect(again.out).toMatch(/was arranged already: nothing moved/);
    expect((await cli(setup, setup.chat.token, 'arrange', 'ticket', '--by', 'role')).err).toMatch(/takes no --by, --layout, --auto, --place, --once or --all/);
  });
});

describe("arranging the main board leaves a ticket's board alone", () => {
  it('a zone’s arrange and the whole board’s move nothing on the ticket’s board', async () => {
    const setup = await setUp();
    const ticket = setup.chat.agent.sessionId;
    await setup.client.call('item.create', { ...NOTE, zoneId: null, ticket, x: 30, y: 30 });
    await setup.client.call('agent.placeOnTicket', { sessionId: setup.builder.agent.sessionId, x: 40, y: 50 });
    await setup.client.call('agent.placeOnTicket', { sessionId: ticket, x: 400, y: 10 });
    const before = await places(setup);

    await setup.client.call('orchestrator.arrange', { zoneId: setup.zone.id });
    await setup.client.call('orchestrator.arrangeBoard', {});

    const after = await places(setup);
    expect(after.ticket).toEqual(before.ticket);
    // The main board's arranges did move something there, so they ran.
    expect(after.main).not.toEqual(before.main);
  });
});
