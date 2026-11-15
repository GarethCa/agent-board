import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { boardLevelFrom, keptFocus, levelOf as levelAt, MEMBER_SIZE, memberPlaces, shownLevel, ticketMembers, zoomsInto } from './ticket-board';

type Fields = Pick<Agent, 'sessionId' | 'ticket' | 'ticketChat'> & Partial<Pick<Agent, 'ticketPlace'>>;
const agent = (fields: Fields) => fields as Agent;

const chat = agent({ sessionId: 'chat', ticket: null, ticketChat: true });
const builder = agent({ sessionId: 'builder', ticket: 'chat', ticketChat: false });
const reviewer = agent({ sessionId: 'reviewer', ticket: 'chat', ticketChat: false });
const loose = agent({ sessionId: 'loose', ticket: null, ticketChat: false });

describe('the board level the user looks at', () => {
  it('is read back as saved: a ticket chat’s session id, else the main board', () => {
    expect(boardLevelFrom({ ticket: 'chat' })).toBe('chat');
    expect(boardLevelFrom(null)).toBeNull();
    expect(boardLevelFrom({ ticket: 3 })).toBeNull();
    expect(boardLevelFrom('chat')).toBeNull();
    expect(boardLevelFrom({ ticket: '' })).toBeNull();
  });

  it('is shown only while its chat is on the board as a ticket’s chat; else the main board', () => {
    expect(shownLevel('chat', [chat, builder])).toBe('chat');
    expect(shownLevel('builder', [chat, builder])).toBeNull();
    expect(shownLevel('gone', [chat])).toBeNull();
    expect(shownLevel(null, [chat])).toBeNull();
  });
});

describe('the level an agent is found on', () => {
  const agents = [chat, builder, reviewer, loose];
  // Reaching a helper zooms into its ticket's board from a ticket's board, as the board asks today.
  const fromBoard = (current: string | null) => () => current !== null;
  const levelOf = (sessionId: string, known: Parameters<typeof levelAt>[1], current: string | null) => levelAt(sessionId, known, current, fromBoard(current));

  it('is its ticket’s board for a helper looked for from a ticket’s board, its own or another', () => {
    expect(levelOf('builder', agents, 'chat')).toBe('chat');
    expect(levelOf('builder', agents, 'other')).toBe('chat');
  });

  it('is the main board for a helper looked for from there: it is found on its ticket’s tile', () => {
    expect(levelOf('builder', agents, null)).toBeNull();
  });

  it('is the main board for an agent of no ticket, and for a ticket’s chat looked for from the main board', () => {
    expect(levelOf('loose', agents, null)).toBeNull();
    expect(levelOf('loose', agents, 'chat')).toBeNull();
    expect(levelOf('chat', agents, null)).toBeNull();
  });

  it('is the ticket’s board shown, for its chat: it is a tile there too', () => {
    expect(levelOf('chat', agents, 'chat')).toBe('chat');
  });

  it('is its ticket’s board for a helper from the main board when its ticket zooms in, and asks of its own ticket', () => {
    const asked: string[] = [];
    expect(levelAt('builder', agents, null, (ticket) => (asked.push(ticket), true))).toBe('chat');
    expect(asked).toEqual(['chat']);
  });

  it('is the main board for a helper whose chat is gone, or no longer a ticket’s chat, and for an agent not on the board', () => {
    expect(levelOf('builder', [builder], 'other')).toBeNull();
    expect(levelOf('builder', [{ ...chat, ticketChat: false }, builder], 'other')).toBeNull();
    expect(levelOf('gone', agents, 'chat')).toBeNull();
  });
});

describe("a ticket's board", () => {
  it('holds its chat first, then its helpers in the board’s order, and no other agent', () => {
    expect(ticketMembers('chat', [builder, loose, chat, reviewer]).map((member) => member.sessionId)).toEqual(['chat', 'builder', 'reviewer']);
    expect(ticketMembers('gone', [chat, builder])).toEqual([]);
  });

  it('puts each where it was placed there, and the rest in a calm column beside the chat, clear of each other', () => {
    const placed = agent({ ...builder, ticketPlace: { x: 900, y: 40 } });
    const places = memberPlaces([chat, placed, reviewer]);
    expect(places.get('chat')).toEqual({ x: 0, y: 0 });
    expect(places.get('builder')).toEqual({ x: 900, y: 40 });
    const right = MEMBER_SIZE.chat.width + MEMBER_SIZE.apart;
    const row = MEMBER_SIZE.helper.height + MEMBER_SIZE.apart;
    // Its slot is its place among the helpers, kept whether the ones before it are placed or not.
    expect(places.get('reviewer')).toEqual({ x: right, y: row });
    // A second unplaced helper goes under the first, not over it.
    const designer = agent({ sessionId: 'designer', ticket: 'chat', ticketChat: false });
    expect(memberPlaces([chat, reviewer, designer]).get('designer')).toEqual({ x: right, y: row });
  });

  it('never moves an unplaced helper when another helper is placed', () => {
    const designer = agent({ sessionId: 'designer', ticket: 'chat', ticketChat: false });
    const before = memberPlaces([chat, builder, reviewer, designer]);
    const after = memberPlaces([chat, agent({ ...builder, ticketPlace: { x: 900, y: 40 } }), reviewer, designer]);
    expect(after.get('reviewer')).toEqual(before.get('reviewer'));
    expect(after.get('designer')).toEqual(before.get('designer'));
  });

  it('moves an unplaced helper down to the next free row when a placed one covers its own, so no two overlap', () => {
    const designer = agent({ sessionId: 'designer', ticket: 'chat', ticketChat: false });
    const right = MEMBER_SIZE.chat.width + MEMBER_SIZE.apart;
    const row = MEMBER_SIZE.helper.height + MEMBER_SIZE.apart;
    // The builder put by hand across the reviewer's own row (the third): the reviewer takes the fourth.
    const placed = agent({ ...builder, ticketPlace: { x: right + 26, y: 2 * row - 20 } });
    const places = memberPlaces([chat, designer, placed, reviewer]);
    expect(places.get('designer')).toEqual({ x: right, y: 0 });
    expect(places.get('builder')).toEqual({ x: right + 26, y: 2 * row - 20 });
    expect(places.get('reviewer')).toEqual({ x: right, y: 3 * row });
    // No two tiles share any ground.
    const boxes = [...places].map(([id, place]) => ({ ...place, ...(id === 'chat' ? MEMBER_SIZE.chat : MEMBER_SIZE.helper) }));
    for (const [i, a] of boxes.entries())
      for (const b of boxes.slice(i + 1)) expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).toBe(false);
  });

  it('skips a dropped tile not yet saved as it skips a placed one', () => {
    const right = MEMBER_SIZE.chat.width + MEMBER_SIZE.apart;
    const held = new Map([['builder', { place: { x: right, y: 0 }, from: undefined }]]);
    expect(memberPlaces([chat, reviewer, builder], held).get('reviewer')).toEqual({ x: right, y: MEMBER_SIZE.helper.height + MEMBER_SIZE.apart });
  });

  it('keeps a placed chat where it was put', () => {
    const moved = agent({ ...chat, ticketPlace: { x: -40, y: 12 } });
    expect(memberPlaces([moved]).get('chat')).toEqual({ x: -40, y: 12 });
  });

  it('hangs the column of unplaced helpers off a placed chat, so one added after an arrange joins the block', () => {
    const arranged = agent({ ...chat, ticketPlace: { x: -600, y: 40 } });
    const placed = agent({ ...builder, ticketPlace: { x: -600 + MEMBER_SIZE.chat.width + MEMBER_SIZE.apart, y: 40 } });
    expect(memberPlaces([arranged, placed, reviewer]).get('reviewer')).toEqual({ x: -600 + MEMBER_SIZE.chat.width + MEMBER_SIZE.apart, y: 40 + MEMBER_SIZE.helper.height + MEMBER_SIZE.apart });
  });

  it('keeps a dropped tile where it was dropped until its saved place moves on, then follows the saved place', () => {
    const held = new Map([['builder', { place: { x: 500, y: 300 }, from: undefined }]]);
    // Not saved yet: the drop holds, whatever else changes on the board.
    expect(memberPlaces([chat, builder], held).get('builder')).toEqual({ x: 500, y: 300 });
    // Saved: the saved place.
    expect(memberPlaces([chat, agent({ ...builder, ticketPlace: { x: 500, y: 300 } })], held).get('builder')).toEqual({ x: 500, y: 300 });
    // Moved on since (by an agent's move, say): the newer place, not the old drop.
    const placed = agent({ ...builder, ticketPlace: { x: 900, y: 40 } });
    expect(memberPlaces([chat, placed], new Map([['builder', { place: { x: 500, y: 300 }, from: { x: 10, y: 10 } }]])).get('builder')).toEqual({ x: 900, y: 40 });
  });
});

describe('what a ticket board was asked to show', () => {
  const focus = { ticket: 'chat', nodeId: 'member:builder', nonce: 1 };

  it('stays while its own ticket board is open, so it is shown once that board is drawn', () => {
    expect(keptFocus(focus, 'chat')).toBe(focus);
  });

  it('is dropped once the user leaves that board or opens another, so zooming in again later does not show it again', () => {
    expect(keptFocus(focus, null)).toBeUndefined();
    expect(keptFocus(focus, 'other')).toBeUndefined();
    expect(keptFocus(undefined, 'chat')).toBeUndefined();
  });
});

describe('whether reaching a helper zooms into its ticket’s board', () => {
  it('does from any ticket’s board, whatever the ticket’s tile opens as', () => {
    expect(zoomsInto('chat', 'chat', {}, 'card')).toBe(true);
    expect(zoomsInto('chat', 'other', { 'agent:chat': 'terminal' }, 'card')).toBe(true);
  });

  it('does from the main board only when the ticket opens as its board: its tile’s switch, else the setting', () => {
    expect(zoomsInto('chat', null, {}, 'card')).toBe(false);
    expect(zoomsInto('chat', null, {}, 'board')).toBe(true);
    expect(zoomsInto('chat', null, { 'agent:chat': 'board' }, 'card')).toBe(true);
    expect(zoomsInto('chat', null, { 'agent:chat': 'terminal' }, 'board')).toBe(false);
  });
});
