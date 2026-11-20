import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import type { SessionWindows } from '../windows/session-windows';
import { escClosesFromBehind, popUpEnded, popUpHelpers, popUpOpening, popUpPlan, popUpShown, popUpRow, popUpRowOwner, popUpTabOn, popUpTabShown, popUpTarget, windowedTiles } from './agent-popup';
import { expandTile, keptOnBoard, pinnedToOpen, windowedExpanded } from './expanded';

const agent = { sessionId: 'a1' } as Agent;
const windows = (placement: 'shown' | 'docked' | 'popped'): SessionWindows => [{ kind: 'session', id: 'a1', title: 'a1', placement }];

describe('popUpOpening', () => {
  it('opens the pop-up, sending a window shown on the board to the dock', () => {
    expect(popUpOpening([], 'a1')).toBe('open');
    expect(popUpOpening(windows('docked'), 'a1')).toBe('open');
    expect(popUpOpening(windows('shown'), 'a1')).toBe('minimise');
  });

  it('brings a popped-out window forward instead', () => {
    expect(popUpOpening(windows('popped'), 'a1')).toBe('forward');
  });
});

describe('popUpShown', () => {
  it('shows the agent popped up while it is listed', () => {
    expect(popUpShown('a1', [agent], [], [])).toBe(agent);
    expect(popUpShown('a1', [], [], [])).toBeUndefined();
    expect(popUpShown(undefined, [agent], [], [])).toBeUndefined();
  });

  it('gives way to a session window shown on the board', () => {
    expect(popUpShown('a1', [agent], windows('shown'), [])).toBeUndefined();
    expect(popUpShown('a1', [agent], windows('docked'), [])).toBe(agent);
  });

  it('gives way to its tile expanded on the board, so its session is drawn once', () => {
    expect(popUpShown('a1', [agent], [], [{ id: 'agent:a1' }])).toBeUndefined();
    expect(popUpShown('a1', [agent], [], [{ id: 'agent:b2' }])).toBe(agent);
  });
});

describe('popUpEnded', () => {
  it('ends with its agent gone or a session window shown in its place', () => {
    expect(popUpEnded('a1', [], [], [], new Set())).toBe(true);
    expect(popUpEnded('a1', [agent], windows('shown'), [], new Set())).toBe(true);
    expect(popUpEnded('a1', [agent], windows('docked'), [], new Set())).toBe(false);
  });

  it('ends for its tile expanded, but waits for one pinned expanded to be taken off the board', () => {
    expect(popUpEnded('a1', [agent], [], [{ id: 'agent:a1' }], new Set())).toBe(true);
    expect(popUpEnded('a1', [agent], [], [{ id: 'agent:a1' }], new Set(['agent:a1']))).toBe(false);
  });
});

describe('windowedTiles', () => {
  it("counts the agent popped up with the windows' sessions", () => {
    expect(windowedTiles(windows('docked'), undefined)).toEqual(['agent:a1']);
    expect(windowedTiles([], 'b2')).toEqual(['agent:b2']);
  });
});

describe("a pinned tile's pop-up", () => {
  it('takes the tile off the board while it is up, shows once it has, and gives it back pinned at its size when it closes', () => {
    const tile = 'agent:a1';
    const pinned = new Set([tile]);
    const present = new Set([tile]);
    const open = expandTile([], tile, { [tile]: { width: 700, height: 500 } });
    // A double-click asks for the pop-up: no pin keeps the tile on the board.
    expect(keptOnBoard(tile, pinned, open, 'popUp')).toBe(false);
    // The first frame: the tile is still expanded, so the pop-up waits rather than drawing the session twice.
    expect(popUpShown('a1', [agent], [], open)).toBeUndefined();
    expect(popUpEnded('a1', [agent], [], open, pinned)).toBe(false);
    // Up: the tile is taken off, the pin doesn't open it again, and the pop-up shows.
    const up = new Set(windowedTiles([], 'a1'));
    const taken = windowedExpanded(open, [], { open: up, all: up }, present);
    expect(taken.expanded).toEqual([]);
    expect(pinnedToOpen(pinned, taken.expanded, present, new Set([...up, ...taken.hidden.map((entry) => entry.id)]))).toEqual([]);
    expect(popUpShown('a1', [agent], [], taken.expanded)).toBe(agent);
    // Closed (–, Esc, the scrim): back at its size, still pinned.
    const none = new Set(windowedTiles([], undefined));
    const back = windowedExpanded(taken.expanded, taken.hidden, { open: none, all: none }, present);
    expect(back.expanded).toEqual(open);
    expect(back.hidden).toEqual([]);
  });
});

describe('escClosesFromBehind', () => {
  it('closes it on an Esc with the focus on the board behind it', () => {
    expect(escClosesFromBehind({ escape: true, typing: false, inPopUp: false })).toBe(true);
  });

  it('leaves an Esc typed into a field, another key, and one inside it to their own', () => {
    expect(escClosesFromBehind({ escape: true, typing: true, inPopUp: false })).toBe(false);
    expect(escClosesFromBehind({ escape: false, typing: false, inPopUp: false })).toBe(false);
    expect(escClosesFromBehind({ escape: true, typing: false, inPopUp: true })).toBe(false);
  });
});

describe("a ticket's pop-up", () => {
  const card = { startup: null, undelivered: [], trustFolder: null, untypedPrompt: null, unsent: null, hooksSilent: false };
  const chat = { ...card, sessionId: 'chat', zoneId: 'z1', ticket: null, ticketChat: true } as unknown as Agent;
  const designer = { ...card, sessionId: 'designer', zoneId: 'z1', ticket: 'chat', ticketChat: false } as unknown as Agent;
  const builder = { ...card, sessionId: 'builder', zoneId: 'z1', ticket: 'chat', ticketChat: false } as unknown as Agent;
  const elsewhere = { ...card, sessionId: 'far', zoneId: 'z2', ticket: 'chat', ticketChat: false } as unknown as Agent;
  const other = { ...card, sessionId: 'other', zoneId: 'z1', ticket: null, ticketChat: false } as unknown as Agent;

  it("holds the helpers its ticket's tile holds, in their order", () => {
    expect(popUpHelpers(chat, [chat, designer, other, builder, elsewhere])).toEqual([designer, builder]);
  });

  it('has no helpers for an agent that is no ticket, nor while its chat draws as an agent', () => {
    expect(popUpHelpers(other, [chat, designer, other])).toBeUndefined();
    const starting = { ...chat, startup: { phase: 'starting' } } as unknown as Agent;
    expect(popUpHelpers(starting, [starting, designer])).toBeUndefined();
  });

  it('puts its Board first, then the chat, then each helper', () => {
    expect(popUpRow(chat, [designer, builder]).map((tab) => [tab.key, tab.kind, tab.agent?.sessionId, tab.chat])).toEqual([
      ['board', 'view', undefined, false],
      ['chat', 'agent', 'chat', true],
      ['designer', 'agent', 'designer', false],
      ['builder', 'agent', 'builder', false],
    ]);
  });

  it("keeps its row's order under its chat's session id", () => {
    expect(popUpRowOwner(chat)).toBe('ticket:chat');
  });

  it('shows its Board on the Board tab, else the agent on, as before', () => {
    expect(popUpTabOn('board', chat, [designer, builder])).toBe('board');
    expect(popUpTabOn('chat', chat, [designer, builder])).toBe(chat);
    expect(popUpTabOn('builder', chat, [designer, builder], ['builder'])).toBe(chat);
    expect(popUpTabOn('designer', chat, [designer, builder])).toBe(designer);
  });

  it('opens on the chat, or on the helper it was opened on while the ticket holds it', () => {
    expect(popUpTabShown(undefined, chat, [designer, builder])).toBe(chat);
    expect(popUpTabShown('builder', chat, [designer, builder])).toBe(builder);
    expect(popUpTabShown('gone', chat, [designer, builder])).toBe(chat);
  });
});

describe('what a pop-up opens on', () => {
  const card = { startup: null, undelivered: [], trustFolder: null, untypedPrompt: null, unsent: null, hooksSilent: false };
  const chat = { ...card, sessionId: 'chat', zoneId: 'z1', ticket: null, ticketChat: true } as unknown as Agent;
  const builder = { ...card, sessionId: 'builder', zoneId: 'z1', ticket: 'chat', ticketChat: false } as unknown as Agent;
  const lone = { ...card, sessionId: 'lone', zoneId: 'z1', ticket: null, ticketChat: false } as unknown as Agent;

  it('opens an agent on itself, and a ticket on the tab it names', () => {
    expect(popUpTarget(lone, undefined, [lone])).toEqual({ agent: lone });
    expect(popUpTarget(chat, 'builder', [chat, builder])).toEqual({ agent: chat, on: 'builder' });
  });

  it("opens a helper its ticket's tile holds as its ticket, on its own tab", () => {
    expect(popUpTarget(builder, undefined, [chat, builder])).toEqual({ agent: chat, on: 'builder' });
  });
});

describe('what popping a ticket up does', () => {
  const card = { startup: null, undelivered: [], trustFolder: null, untypedPrompt: null, unsent: null, hooksSilent: false };
  const chat = { ...card, sessionId: 'chat', zoneId: 'z1', ticket: null, ticketChat: true } as unknown as Agent;
  const builder = { ...card, sessionId: 'builder', zoneId: 'z1', ticket: 'chat', ticketChat: false } as unknown as Agent;
  const agents = [chat, builder];
  const popped = (id: string): SessionWindows => [{ kind: 'session', id, title: id, placement: 'popped' }];
  const shown = (id: string): SessionWindows => [{ kind: 'session', id, title: id, placement: 'shown' }];

  it('pops the ticket up on the tab asked for', () => {
    expect(popUpPlan(chat, undefined, agents, [])).toEqual({ kind: 'pop-up', chat, minimise: [] });
    expect(popUpPlan(chat, 'builder', agents, [])).toEqual({ kind: 'pop-up', chat, on: 'builder', minimise: [] });
  });

  it('brings a helper popped out into its own window forward there, so its session is drawn once', () => {
    expect(popUpPlan(chat, 'builder', agents, popped('builder'))).toEqual({ kind: 'forward', agent: builder });
    expect(popUpPlan(builder, undefined, agents, popped('builder'))).toEqual({ kind: 'forward', agent: builder });
  });

  it('brings a popped-out chat forward, and sends the windows shown on the board to the dock', () => {
    expect(popUpPlan(chat, undefined, agents, popped('chat'))).toEqual({ kind: 'forward', agent: chat });
    expect(popUpPlan(chat, 'builder', agents, shown('builder'))).toEqual({ kind: 'pop-up', chat, on: 'builder', minimise: ['builder'] });
    expect(popUpPlan(chat, undefined, agents, shown('chat'))).toEqual({ kind: 'pop-up', chat, minimise: ['chat'] });
  });

  it('shows no tab of a helper popped out into its own window: its chat instead', () => {
    expect(popUpTabShown('builder', chat, [builder], ['builder'])).toBe(chat);
    expect(popUpTabShown('builder', chat, [builder], [])).toBe(builder);
  });
});
