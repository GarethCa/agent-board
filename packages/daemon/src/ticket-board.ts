// A free spot on a ticket's own board, for something new the daemon puts there.
import { freeSpotFor, type Size } from './board-layout.ts';
import type { BoardPlace, DaemonCall } from './protocol.ts';

/** The first spot on the ticket chat `ticket`'s own board, from its top left, where something of `size` is clear of what is there. */
export async function spotOnTicketBoard(call: DaemonCall, ticket: string, size: Size): Promise<BoardPlace> {
  const there = await call('item.list', { ticket });
  const spot = freeSpotFor({ x: 0, y: 0 }, size, there);
  return { zoneId: null, ticket, x: spot.x, y: spot.y };
}
