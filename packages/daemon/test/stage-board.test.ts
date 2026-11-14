import { describe, expect, it } from 'vitest';
import { AGENT_TILE_SIZE, PERCH_ROOM, tileSizeKey } from '../src/board-layout.ts';
import type { Agent } from '../src/protocol.ts';
import { cardHeight } from '../src/shelf-layout.ts';
import {
  DONE_LINE_HEIGHT,
  EMPTY_STAGE_BOARD_SIZE,
  LATER_CARD_HEIGHT,
  layOutStageBoard,
  stageBoardData,
  stageBoardDataProblem,
  stageBoardDrop,
  stageBoardMembers,
  ticketStage,
  type StageBoardInput,
} from '../src/stage-board.ts';

const T0 = '2026-01-05T09:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

/** An agent in zone `z`, started by an orchestrator, idle and never started, with what a test says. */
function agent(sessionId: string, fields: Partial<Agent> = {}): Agent {
  return {
    sessionId,
    name: sessionId,
    zoneId: 'z',
    repoRoot: '/repo',
    branch: `${sessionId}-a1b2c3`,
    reviews: null,
    reviewOf: null,
    role: null,
    roleName: null,
    master: false,
    spawnedBy: 'lead',
    orphanedFrom: null,
    ticket: null,
    ticketChat: false,
    issue: null,
    state: 'idle',
    endedAt: null,
    exitCode: null,
    shellSessionId: null,
    shellHarness: null,
    permissions: [],
    ask: null,
    removeAsk: null,
    plan: null,
    flag: null,
    ledBy: null,
    seen: false,
    pullRequests: [],
    finishedAt: null,
    lastMessage: null,
    createdAt: T0,
    ...fields,
  } as Agent;
}

const lead = agent('lead', { roleName: 'orchestrator', spawnedBy: null, state: 'running' });
const pr = (state: 'open' | 'draft' | 'merged' | 'closed') => ({ number: 7, title: 'Fix it', url: 'https://example.com/pr/7', state, checks: 'none' as const });
const issue = (id: string) => ({ id, title: `${id} title`, url: `https://example.com/${id}` }) as Agent['issue'];

function input(agents: readonly Agent[], fields: Partial<StageBoardInput> = {}): StageBoardInput {
  return {
    agents,
    zoneId: 'z',
    data: { joined: [], left: [], showDone: false },
    links: [],
    shows: 'explicit',
    spacing: 'normal',
    sizeOf: () => AGENT_TILE_SIZE,
    footOf: () => false,
    ...fields,
  };
}

describe('stage board data', () => {
  it('reads what it holds, and nothing for what it lacks', () => {
    expect(stageBoardData({})).toEqual({ joined: [], left: [], showDone: false });
    expect(stageBoardData({ joined: ['a'], left: ['b'], showDone: true })).toEqual({ joined: ['a'], left: ['b'], showDone: true });
    expect(stageBoardData({ joined: 'a', left: [3], showDone: 'yes' })).toEqual({ joined: [], left: [], showDone: false });
  });

  it('names what is wrong with lists that are not of session ids', () => {
    expect(stageBoardDataProblem({ joined: ['a'], left: [] })).toBeNull();
    expect(stageBoardDataProblem({})).toBeNull();
    expect(stageBoardDataProblem({ joined: 'a' })).toMatch(/joined/);
    expect(stageBoardDataProblem({ left: [1] })).toMatch(/left/);
    expect(stageBoardDataProblem({ showDone: true })).toBeNull();
    expect(stageBoardDataProblem({ showDone: 'yes' })).toMatch(/showDone/);
  });
});

describe('stageBoardMembers', () => {
  it('holds the zone agents an agent started, never a lead, nor another zone', () => {
    const agents = [lead, agent('a'), agent('b', { zoneId: 'y' }), agent('m', { master: true, spawnedBy: null })];
    expect(stageBoardMembers(agents, 'z', { joined: [], left: [] })).toEqual(['a']);
  });

  it('leaves out one the user started by hand until it joins', () => {
    const agents = [lead, agent('a'), agent('h', { spawnedBy: null })];
    expect(stageBoardMembers(agents, 'z', { joined: [], left: [] })).toEqual(['a']);
    expect(stageBoardMembers(agents, 'z', { joined: ['h'], left: [] })).toEqual(['a', 'h']);
  });

  it('holds one a worker started, and one a lead in another zone started into this one', () => {
    const agents = [lead, agent('a'), agent('w', { spawnedBy: 'a' }), agent('x', { spawnedBy: 'elsewhere' })];
    expect(stageBoardMembers(agents, 'z', { joined: [], left: [] })).toEqual(['a', 'w', 'x']);
  });

  it('keeps one an orchestrator started that lost its orchestrator', () => {
    const agents = [agent('o', { spawnedBy: null, orphanedFrom: { sessionId: 'gone', name: 'Lead' } })];
    expect(stageBoardMembers(agents, 'z', { joined: [], left: [] })).toEqual(['o']);
  });

  it('leaves out one dragged out of it', () => {
    const agents = [lead, agent('a'), agent('b')];
    expect(stageBoardMembers(agents, 'z', { joined: [], left: ['b'] })).toEqual(['a']);
  });
});

describe('stageBoardDrop', () => {
  const none = { joined: [], left: [], showDone: false };
  it('takes in one the user started, dropped on the block, and lets it go dropped off it', () => {
    const mine = agent('h', { spawnedBy: null });
    expect(stageBoardDrop(mine, none, 'on')).toEqual({ ...none, joined: ['h'] });
    expect(stageBoardDrop(mine, { ...none, joined: ['h'] }, 'off')).toEqual(none);
  });

  it('lets go of one an agent started, dropped off the block, and takes it back dropped on it', () => {
    const worker = agent('a');
    expect(stageBoardDrop(worker, none, 'off')).toEqual({ ...none, left: ['a'] });
    expect(stageBoardDrop(worker, { ...none, left: ['a'] }, 'on')).toEqual(none);
  });

  it('changes nothing for a drop that leaves it where it was, nor for a lead', () => {
    expect(stageBoardDrop(agent('a'), none, 'on')).toBeUndefined();
    expect(stageBoardDrop(agent('h', { spawnedBy: null }), none, 'off')).toBeUndefined();
    expect(stageBoardDrop(lead, none, 'on')).toBeUndefined();
    expect(stageBoardDrop(agent('m', { master: true, spawnedBy: null }), none, 'on')).toBeUndefined();
  });

  it('forgets one dropped away into another zone, so it is a member again by who started it if it comes back', () => {
    expect(stageBoardDrop(agent('a'), none, 'away')).toBeUndefined();
    expect(stageBoardDrop(agent('a'), { ...none, left: ['a'] }, 'away')).toEqual(none);
    expect(stageBoardDrop(agent('h', { spawnedBy: null }), { ...none, joined: ['h'] }, 'away')).toEqual(none);
  });

  it('keeps the rest of what it holds', () => {
    expect(stageBoardDrop(agent('h', { spawnedBy: null }), { joined: ['g'], left: ['b'], showDone: true }, 'on')).toEqual({ joined: ['g', 'h'], left: ['b'], showDone: true });
  });
});

describe('ticketStage', () => {
  it('waits for review once its pull request is open and its implementer has stopped, whatever its reviewers do', () => {
    const made = agent('a', { pullRequests: [pr('open')], finishedAt: at(5) });
    const reviewer = agent('r', { state: 'running', role: 'reviewer' });
    expect(ticketStage([made, reviewer], new Set(['r']), 'explicit')).toBe('waiting');
  });

  it('stays on Doing while its implementer still works, a pull request open or not', () => {
    expect(ticketStage([agent('a', { state: 'running', pullRequests: [pr('open')] })], new Set(), 'explicit')).toBe('doing');
    expect(ticketStage([agent('a', { state: 'failed', exitCode: 1, endedAt: at(5), pullRequests: [pr('open')] })], new Set(), 'explicit')).toBe('doing');
  });

  it('comes back to Doing when one of its agents needs the user, a reviewer too', () => {
    const made = agent('a', { pullRequests: [pr('open')], finishedAt: at(5) });
    expect(ticketStage([made, agent('r', { state: 'needs-permission' })], new Set(['r']), 'explicit')).toBe('doing');
  });

  it('is To do until it starts, and Done once merged', () => {
    expect(ticketStage([agent('a')], new Set(), 'explicit')).toBe('todo');
    expect(ticketStage([agent('a', { pullRequests: [pr('merged')], finishedAt: at(5) })], new Set(), 'explicit')).toBe('done');
  });
});

describe('layOutStageBoard', () => {
  const BLOCK_PAD = 14;
  const HEADER = 34;
  const FIRST = HEADER + 36 + 8;

  it('draws four stages left to right, each at least a card wide, with nothing in them', () => {
    const laid = layOutStageBoard(input([lead]));
    expect(laid.columns.map((column) => column.stage)).toEqual(['todo', 'doing', 'waiting', 'done']);
    expect(laid.columns.map((column) => column.x)).toEqual([BLOCK_PAD, BLOCK_PAD + 280, BLOCK_PAD + 560, BLOCK_PAD + 840]);
    expect(laid.columns.every((column) => column.width === 256 && column.count === 0)).toBe(true);
    expect(laid.size).toEqual({ width: BLOCK_PAD + 4 * 256 + 3 * 24 + BLOCK_PAD, height: FIRST + BLOCK_PAD });
    expect(laid.tickets).toEqual([]);
    expect(laid.size).toEqual(EMPTY_STAGE_BOARD_SIZE);
  });

  it('puts a quiet card at its natural size in To do, Waiting and Done, the tile hidden', () => {
    const agents = [lead, agent('t'), agent('w', { pullRequests: [pr('open')], finishedAt: at(5) }), agent('d', { pullRequests: [pr('merged')], finishedAt: at(5) })];
    const laid = layOutStageBoard(input(agents, { footOf: (members) => members.includes('w') }));
    const card = (id: string) => laid.tickets.find((ticket) => ticket.members.includes(id))!;
    expect(card('t')).toMatchObject({ stage: 'todo', x: BLOCK_PAD, y: FIRST, width: 256, height: cardHeight(1, false), live: false });
    expect(card('w')).toMatchObject({ stage: 'waiting', x: BLOCK_PAD + 560, width: 256, height: cardHeight(1, true) });
    expect(card('d')).toMatchObject({ stage: 'done', x: BLOCK_PAD + 840 });
    expect(laid.tiles.size).toBe(0);
  });

  it('stacks the cards of one stage a card gap apart', () => {
    const laid = layOutStageBoard(input([lead, agent('a'), agent('b', { createdAt: at(1) })]));
    expect(laid.tickets.map((ticket) => [ticket.members[0], ticket.y])).toEqual([
      ['a', FIRST],
      ['b', FIRST + cardHeight(1, false) + 12],
    ]);
    expect(laid.columns[0]!.count).toBe(2);
  });

  it('draws Doing as a band per ticket, its implementer then its reviewers, the stage as wide as its widest band', () => {
    const made = agent('a', { state: 'running', issue: issue('T-1') });
    const reviewer = agent('r', { state: 'running', role: 'reviewer', reviewOf: 'a', issue: issue('T-1'), createdAt: at(1) });
    const laid = layOutStageBoard(input([lead, made, reviewer]));
    const doing = laid.columns[1]!;
    const band = laid.tickets[0]!;
    expect(band).toMatchObject({ stage: 'doing', ticket: 'T-1', live: true, members: ['a', 'r'], x: doing.x, y: FIRST });
    expect(band.width).toBe(8 + 256 + 16 + 256 + 8);
    expect(band.height).toBe(PERCH_ROOM + 136 + 8);
    expect(doing.width).toBe(band.width);
    expect(laid.tiles.get(tileSizeKey('agent', 'a'))).toEqual({ x: doing.x + 8, y: FIRST + PERCH_ROOM });
    expect(laid.tiles.get(tileSizeKey('agent', 'r'))).toEqual({ x: doing.x + 8 + 256 + 16, y: FIRST + PERCH_ROOM });
    expect(laid.columns[2]!.x).toBe(doing.x + band.width + 24);
  });

  it('puts a Doing ticket’s notes in its band, a row under its tiles, the band as big as they take', () => {
    const made = agent('a', { state: 'running' });
    const notes = [
      { key: 'item:n1', size: { width: 200, height: 80 } },
      { key: 'item:n2', size: { width: 400, height: 60 } },
    ];
    const laid = layOutStageBoard(input([lead, made], { notesOf: (id) => (id === 'a' ? notes : []) }));
    const doing = laid.columns[1]!;
    const band = laid.tickets[0]!;
    const under = FIRST + PERCH_ROOM + 136 + 16;
    expect(laid.tiles.get('item:n1')).toEqual({ x: doing.x + 8, y: under });
    expect(laid.tiles.get('item:n2')).toEqual({ x: doing.x + 8 + 200 + 16, y: under });
    expect(band.height).toBe(PERCH_ROOM + 136 + 16 + 80 + 8);
    expect(band.width).toBe(8 + 200 + 16 + 400 + 8);
    expect(laid.size.height).toBe(FIRST + band.height + BLOCK_PAD);
  });

  it('leaves a quiet ticket’s notes out of the layout, behind its card', () => {
    const laid = layOutStageBoard(input([lead, agent('t')], { notesOf: () => [{ key: 'item:n1', size: { width: 200, height: 80 } }] }));
    expect(laid.tiles.has('item:n1')).toBe(false);
  });

  it('lists what needs the user first on Doing, and counts it on the heading', () => {
    const laid = layOutStageBoard(input([lead, agent('a', { state: 'running' }), agent('b', { state: 'needs-permission', createdAt: at(1) })]));
    expect(laid.tickets.map((ticket) => ticket.members[0])).toEqual(['b', 'a']);
    expect(laid.columns[1]).toMatchObject({ count: 2, needYou: 1 });
    expect(laid.tickets[0]!.needsYou).toBe(true);
  });

  it('starts a second Doing column past eight tickets', () => {
    const agents = [lead, ...Array.from({ length: 9 }, (_, index) => agent(`a${index}`, { state: 'running', createdAt: at(index) }))];
    const laid = layOutStageBoard(input(agents));
    const doing = laid.columns[1]!;
    const band = PERCH_ROOM + 136 + 8;
    const ninth = laid.tickets.find((ticket) => ticket.members[0] === 'a8')!;
    const eighth = laid.tickets.find((ticket) => ticket.members[0] === 'a7')!;
    expect(eighth).toMatchObject({ x: doing.x, y: FIRST + 7 * (band + 20) });
    expect(ninth).toMatchObject({ x: doing.x + 8 + 256 + 8 + 24, y: FIRST });
    expect(doing.width).toBe(2 * (8 + 256 + 8) + 24);
    expect(laid.size.height).toBe(FIRST + 8 * band + 7 * 20 + BLOCK_PAD);
  });

  it('puts what is for later at the foot of To do, under its tickets, and counts it apart on the heading', () => {
    const later = [
      { id: 'j1', text: 'Tray icon is blurry' },
      { id: 'j2', text: 'Export a zone as a picture' },
    ];
    const laid = layOutStageBoard(input([lead, agent('t')], { later }));
    const under = FIRST + cardHeight(1, false) + 12;
    expect(laid.later).toEqual([
      { id: 'j1', text: 'Tray icon is blurry', x: BLOCK_PAD, y: under, width: 256, height: LATER_CARD_HEIGHT },
      { id: 'j2', text: 'Export a zone as a picture', x: BLOCK_PAD, y: under + LATER_CARD_HEIGHT + 12, width: 256, height: LATER_CARD_HEIGHT },
    ]);
    expect(laid.columns[0]).toMatchObject({ count: 1, later: 2 });
    expect(laid.size.height).toBe(under + 2 * LATER_CARD_HEIGHT + 12 + BLOCK_PAD);
  });

  it('starts To do with what is for later when it has no tickets', () => {
    const laid = layOutStageBoard(input([lead], { later: [{ id: 'j1', text: 'Later' }] }));
    expect(laid.later[0]).toMatchObject({ x: BLOCK_PAD, y: FIRST });
    expect(input([lead]).later).toBeUndefined();
    expect(layOutStageBoard(input([lead])).later).toEqual([]);
  });

  it('folds Done to one line that counts its tickets, their cards hidden behind it', () => {
    const done = (id: string, minutes: number) => agent(id, { pullRequests: [pr('merged')], finishedAt: at(5), createdAt: at(minutes) });
    const laid = layOutStageBoard(input([lead, done('d1', 0), done('d2', 1)]));
    expect(laid.fold).toEqual({ x: BLOCK_PAD + 840, y: FIRST, width: 256, height: DONE_LINE_HEIGHT, count: 2, shown: false });
    const cards = laid.tickets.filter((ticket) => ticket.stage === 'done');
    expect(cards.map((ticket) => ticket.folded)).toEqual([true, true]);
    expect(laid.columns[3]!.count).toBe(2);
    expect(laid.size.height).toBe(FIRST + DONE_LINE_HEIGHT + BLOCK_PAD);
  });

  it('shows Done’s cards under its line once shown', () => {
    const done = (id: string, minutes: number) => agent(id, { pullRequests: [pr('merged')], finishedAt: at(5), createdAt: at(minutes) });
    const laid = layOutStageBoard(input([lead, done('d1', 0), done('d2', 1)], { data: { joined: [], left: [], showDone: true } }));
    expect(laid.fold).toMatchObject({ y: FIRST, count: 2, shown: true });
    const cards = laid.tickets.filter((ticket) => ticket.stage === 'done');
    expect(cards.map((ticket) => [ticket.folded, ticket.y])).toEqual([
      [false, FIRST + DONE_LINE_HEIGHT + 12],
      [false, FIRST + DONE_LINE_HEIGHT + 12 + cardHeight(1, false) + 12],
    ]);
  });

  it('draws no Done line with nothing done, and folds no other stage', () => {
    const laid = layOutStageBoard(input([lead, agent('t')]));
    expect(laid.fold).toBeNull();
    expect(laid.tickets[0]!.folded).toBe(false);
  });

  it('holds none of the agents the user started by hand, nor its zone’s leads', () => {
    const laid = layOutStageBoard(input([lead, agent('h', { spawnedBy: null, state: 'running' })]));
    expect(laid.tickets).toEqual([]);
    expect(laid.members).toEqual([]);
  });
});
