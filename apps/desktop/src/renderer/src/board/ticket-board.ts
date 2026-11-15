// A ticket's own board, zoomed into from its tile: its chat and helpers as tiles, beside the notes and docs on it.
// Which level the user looks at is saved in the daemon's view state and restored on relaunch; each agent's place on
// the ticket's board is its own (`Agent.ticketPlace`), apart from its tile on the main board. Pure, so the rules are
// unit-tested.
import type { Agent, TicketBoardPlace } from '@agent-board/daemon/protocol';
import { TICKET_MEMBER_SIZE, ticketBlockSlot } from '@agent-board/daemon/ticket-tiles';
import { opensAsBoard, type TicketTilesOpenAs, type TicketViews } from './ticket-view';

/** The board level as saved (view state, read back untyped): a ticket chat's session id, or null for the main board. */
export function boardLevelFrom(saved: unknown): string | null {
  if (typeof saved !== 'object' || saved === null) return null;
  const ticket = (saved as { ticket?: unknown }).ticket;
  return typeof ticket === 'string' && ticket !== '' ? ticket : null;
}

/** The level as saved: what `boardLevelFrom` reads back. */
export const savedLevel = (level: string | null) => (level === null ? null : { ticket: level });

/** The level shown: the ticket's board while its chat is on the board as a ticket's chat, else the main board. */
export function shownLevel(level: string | null, agents: readonly Pick<Agent, 'sessionId' | 'ticketChat'>[]): string | null {
  return level !== null && agents.some((agent) => agent.sessionId === level && agent.ticketChat) ? level : null;
}

/**
 * Whether reaching a helper of `ticket` from elsewhere (⌘K, Needs you) zooms into the ticket's board, `level` open:
 * always from a ticket's board, the helper's own or another; from the main board when the ticket opens as its board
 * (`opensAsBoard`: its tile's switch, else the setting). Else the board flies to the ticket's tile.
 */
export const zoomsInto = (ticket: string, level: string | null, views: TicketViews, openAs: TicketTilesOpenAs): boolean => level !== null || opensAsBoard(ticket, views, openAs);

/** Where a member's node id on its ticket's board starts: the session id follows. */
export const MEMBER_PREFIX = 'member:';

/** A member's node id on its ticket's board. */
export const memberNodeId = (sessionId: string) => `${MEMBER_PREFIX}${sessionId}`;

/** A tile or item to show on `ticket`'s board, by its node id there; a new `nonce` shows it again. */
export interface TicketBoardFocus {
  ticket: string;
  nodeId: string;
  nonce: number;
}

/**
 * What a ticket's board was asked to show, while `level` is open: kept only while it is that ticket's board. Leaving
 * it, or opening another, drops it, so zooming into the ticket again later shows the board as it was, not that again.
 */
export const keptFocus = (focus: TicketBoardFocus | undefined, level: string | null): TicketBoardFocus | undefined =>
  focus !== undefined && focus.ticket === level ? focus : undefined;

/** Who is on the ticket's board: its chat first, then its helpers in the order the board lists them, as its tile does. */
export function ticketMembers<A extends Pick<Agent, 'sessionId' | 'ticket' | 'ticketChat'>>(chatId: string, agents: readonly A[]): A[] {
  const chat = agents.find((agent) => agent.sessionId === chatId && agent.ticketChat);
  return chat === undefined ? [] : [chat, ...agents.filter((agent) => agent.ticket === chatId)];
}

/** The tiles' sizes on a ticket's board, and how far apart the column of unplaced helpers keeps them: the daemon's arrange lays them out the same. */
export const MEMBER_SIZE = TICKET_MEMBER_SIZE;

/** A member dropped on the ticket's board: where, and its place there before, kept until the daemon's place moves on. */
export interface HeldPlace {
  place: TicketBoardPlace;
  from: TicketBoardPlace | undefined;
}

const samePlace = (a: TicketBoardPlace | undefined, b: TicketBoardPlace | undefined) => a?.x === b?.x && a?.y === b?.y;

/** Whether a drop is still waiting on the daemon: the member's saved place is still the one it had before the drop. */
export const stillHeld = (member: Pick<Agent, 'ticketPlace'>, held: HeldPlace) => samePlace(member.ticketPlace, held.from);

type Box = TicketBoardPlace & { width: number; height: number };

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Where each member's tile is: where it was just dropped, until the daemon has saved it (`held`); where it was placed
 * on this board; else the chat at the origin, and each unplaced helper in a column on the chat's right (wherever the chat is), at its own row (the
 * nth helper's, placed or not), or the next row down that no other tile covers. So nothing starts on top of anything
 * else. Placing a helper clear of the column moves no other; put on an unplaced one's row, it moves that one down a row,
 * and so on down the column, each one only as far as the next free row.
 */
export function memberPlaces(members: readonly Pick<Agent, 'sessionId' | 'ticketChat' | 'ticketPlace'>[], held: ReadonlyMap<string, HeldPlace> = new Map()): Map<string, TicketBoardPlace> {
  const places = new Map<string, TicketBoardPlace>();
  const taken: Box[] = [];
  const sizeOf = (member: Pick<Agent, 'ticketChat'>) => (member.ticketChat ? MEMBER_SIZE.chat : MEMBER_SIZE.helper);
  // First the tiles with a place of their own, so the column can keep clear of them.
  for (const member of members) {
    const drop = held.get(member.sessionId);
    const place = drop !== undefined && stillHeld(member, drop) ? drop.place : member.ticketPlace;
    if (place === undefined) continue;
    places.set(member.sessionId, place);
    taken.push({ ...place, ...sizeOf(member) });
  }
  // The column hangs off the chat's place, so a helper added after an arrange joins the arranged block.
  const chat = members.find((member) => member.ticketChat);
  const origin = (chat && places.get(chat.sessionId)) ?? { x: 0, y: 0 };
  const rowHeight = MEMBER_SIZE.helper.height + MEMBER_SIZE.apart;
  let nth = 0;
  for (const member of members) {
    const row = member.ticketChat ? 'chat' : nth++;
    if (places.has(member.sessionId)) continue;
    let slot: Box = { ...ticketBlockSlot(origin, row), ...sizeOf(member) };
    while (!member.ticketChat && taken.some((box) => overlaps(box, slot))) slot = { ...slot, y: slot.y + rowHeight };
    places.set(member.sessionId, { x: slot.x, y: slot.y });
    taken.push(slot);
  }
  return places;
}

/**
 * The level `sessionId`'s agent is found on, looked for from `current`: the ticket's board shown, for its chat or a
 * helper of it; else its ticket's board, for a helper whose ticket `zoomsIn` (reaching it zooms into that board); else
 * the main board (null), for any other agent, a ticket's chat (its tile is there), a helper found on its ticket's tile
 * and an agent not on the board.
 */
export function levelOf(
  sessionId: string,
  agents: readonly Pick<Agent, 'sessionId' | 'ticket' | 'ticketChat'>[],
  current: string | null,
  zoomsIn: (ticketChatId: string) => boolean,
): string | null {
  if (current !== null && ticketMembers(current, agents).some((member) => member.sessionId === sessionId)) return current;
  const ticket = agents.find((agent) => agent.sessionId === sessionId)?.ticket ?? null;
  return ticket !== null && agents.some((agent) => agent.sessionId === ticket && agent.ticketChat) && zoomsIn(ticket) ? ticket : null;
}
