import { useContext, useState, type ReactNode } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import type { ModelEntry } from './menu-model';
import { TileActionsContext } from './tile';
import { tileMenuEntries } from './ticket-chat-menu';
import { TicketWatchesPopover } from './TicketWatches';

/**
 * An agent tile's ⋯ menu, wired to the tile's actions: a ticket's chat's (`ticketChatMenu`), with the Watches sheet its
 * Watches… opens for the tile to draw, or a plain agent's own menu as it is (`helpers` undefined), with no sheet. A tile
 * with its own way into the sheet (the opened ticket's eye) passes `withWatches: false`, and its menu has no Watches….
 */
export function useTicketChatMenu(
  chat: Agent,
  helpers: readonly Agent[] | undefined,
  views: readonly ModelEntry[],
  own: ModelEntry[],
  name: string,
  { withWatches = true }: { withWatches?: boolean } = {},
): { entries: ModelEntry[]; watches: ReactNode } {
  const { openTicketBoard, openPullRequest, setTicketChat, closeTicket } = useContext(TileActionsContext);
  const [watching, setWatching] = useState(false);
  const entries = tileMenuEntries({
    chat,
    helpers,
    views,
    own,
    actions: {
      openBoard: () => openTicketBoard(chat.sessionId),
      openWatches: withWatches ? () => setWatching(true) : undefined,
      openPullRequest,
      setChatKind: (kind) => setTicketChat(chat.sessionId, kind),
      closeTicket: () => closeTicket(chat.sessionId),
    },
  });
  const watches = helpers === undefined || !withWatches ? null : <TicketWatchesPopover chat={chat} name={name} open={watching} onOpenChange={setWatching} />;
  return { entries, watches };
}
