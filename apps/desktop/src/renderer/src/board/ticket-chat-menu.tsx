import { DEFAULT_TICKET_CHAT_KIND, type Agent, type TicketChatKind } from '@agent-board/daemon/protocol';
import { LayoutDashboard } from 'lucide-react';
import type { ModelEntry } from './menu-model';

const KINDS: readonly { kind: TicketChatKind; label: string }[] = [
  { kind: 'lead', label: 'Its own lead' },
  { kind: 'implementer', label: 'The implementer' },
];

/** What a switch to `kind` waits for: the builder's hand-off to become the implementer, the chat's own to become its lead. */
const WAITS_FOR: Record<TicketChatKind, string> = { implementer: 'after the builder hands off', lead: 'after the chat hands off' };

/** A ticket tile's ⋯ menu, in order: the rows that switch how it shows, who builds it, then the agent's own rows. */
export function ticketMenuEntries(views: readonly ModelEntry[], kinds: readonly ModelEntry[], own: readonly ModelEntry[]): ModelEntry[] {
  return [...views, 'separator', ...(kinds.length === 0 ? [] : [...kinds, 'separator' as const]), ...own];
}

/** The ⋯ menu row that zooms into the ticket's own board: its helpers as tiles, beside its notes and docs. */
export function boardRow(open: () => void): ModelEntry {
  return { id: 'ticket-board', label: 'Open as board', icon: <LayoutDashboard />, onSelect: open };
}

/**
 * A ticket tile's ⋯ menu rows for who builds the ticket: its chat as the implementer, or its own lead with a builder
 * helper. A pick switches at a hand-off, never mid-edit; while one waits, its row says what for. None for an agent that
 * is no ticket's chat, works outside git (no branch to hand over) or has ended.
 */
export function ticketChatEntries(chat: Agent, set: (kind: TicketChatKind) => void): ModelEntry[] {
  if (!chat.ticketChat || chat.plainFolder || chat.endedAt !== null) return [];
  const now = chat.chatKind ?? DEFAULT_TICKET_CHAT_KIND;
  return [
    { heading: 'Ticket chat' },
    ...KINDS.map(({ kind, label }) => ({
      id: `ticket-chat-${kind}`,
      label,
      checked: kind === now,
      hint: chat.chatSwitch === kind ? WAITS_FOR[kind] : undefined,
      onSelect: () => set(kind),
    })),
  ];
}
