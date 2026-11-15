// How a ticket's tile shows: the clean card, the terminal view (its chat's live terminal with its helpers in a strip
// under it), or the board: its card, which a double-click opens into the ticket's own board. Settings picks the
// default; each tile can be switched, and keeps its own view, saved in the daemon's view state. Pure, so the rules are
// unit-tested.
import type { Agent } from '@agent-board/daemon/protocol';
import type { ExpandedSizes, ExpandedTiles } from './expanded';
import { ticketPr } from './ticket-tile';
import { tileNodeId } from './tiles';

/**
 * A ticket tile's view: the clean card, its chat's live terminal, or the board, which rests as the card and opens into
 * the ticket's own board.
 */
export type TicketView = 'card' | 'terminal' | 'board';

/** What Settings › Board › Ticket tiles open as names: a view. */
export type TicketTilesOpenAs = TicketView;

const isView = (value: unknown): value is TicketView => value === 'card' || value === 'terminal' || value === 'board';

/** The setting as saved (view state, read back untyped): the terminal unless another view was saved. */
export function ticketTilesOpenAsFrom(saved: unknown): TicketTilesOpenAs {
  return isView(saved) ? saved : 'terminal';
}

/** The tiles switched by hand, by node id, and the view each was switched to. */
export type TicketViews = Readonly<Record<string, TicketView>>;

/** The switched tiles as saved (view state, read back untyped): only the entries that name a view. */
export function ticketViewsFrom(saved: unknown): TicketViews {
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return {};
  return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, TicketView] => isView(entry[1])));
}

/**
 * Whether a ticket is over: its chat ended or done, or its pull request merged. An old ticket rests as its card whatever
 * the default, so a board of them doesn't open a live terminal each.
 */
export function ticketOver(chat: Pick<Agent, 'endedAt' | 'state' | 'workFinishedAt' | 'pullRequests'>, helpers: readonly Pick<Agent, 'pullRequests'>[]): boolean {
  return chat.endedAt !== null || chat.state === 'done' || chat.workFinishedAt !== null || ticketPr([chat, ...helpers])?.state === 'merged';
}

/** The tile's view: the one it was switched to, else the default while its ticket is live, else the card. */
export const ticketViewOf = (views: TicketViews, id: string, openAs: TicketTilesOpenAs, over = false): TicketView => views[id] ?? (over ? 'card' : openAs);

/**
 * Whether the ticket whose chat is `ticketChatId` opens as its board: what a way into a ticket from elsewhere (⌘K,
 * Needs you) asks before zooming into its board. `views` are the views the tiles show (`ticketViewsShown`, as
 * `TicketViewsContext` gives them), which already rest an over ticket as its card; else the setting decides.
 */
export function opensAsBoard(ticketChatId: string, views: TicketViews, openAs: TicketTilesOpenAs): boolean {
  return ticketViewOf(views, tileNodeId('agent', ticketChatId), openAs) === 'board';
}

/**
 * The ticket tiles open now that opened while their ticket was live: `held` (the last answer) kept while still open,
 * and every open one not over added. Such a tile keeps its view while it stays open, so a ticket going over (a worker
 * reporting finished, a pull request merging) doesn't swap the terminal under the user; it rests as its card once
 * closed. Returns `held` when nothing changed.
 */
export function liveWhileOpen(held: ReadonlySet<string>, open: readonly string[], over: ReadonlySet<string>): ReadonlySet<string> {
  const next = open.filter((id) => held.has(id) || !over.has(id));
  return next.length === held.size && next.every((id) => held.has(id)) ? held : new Set(next);
}

/** The tiles whose ticket is over and that rest as their card: the over ones, less those still open since they were live. */
export function restingOver(over: ReadonlySet<string>, live: ReadonlySet<string>): ReadonlySet<string> {
  return [...over].some((id) => live.has(id)) ? new Set([...over].filter((id) => !live.has(id))) : over;
}

/** The views the tiles show: the switched ones, and the card for each resting over tile not switched by hand. */
export function shownTicketViews(views: TicketViews, resting: ReadonlySet<string>): TicketViews {
  const added = [...resting].filter((id) => views[id] === undefined);
  return added.length === 0 ? views : { ...views, ...Object.fromEntries(added.map((id) => [id, 'card' as const])) };
}

/** `views` with the tile `id` switched to `view`; the same object when it already was. */
export function withTicketView(views: TicketViews, id: string, view: TicketView): TicketViews {
  return views[id] === view ? views : { ...views, [id]: view };
}

/** Only the switched tiles still on the board. */
export function keepTicketViews(views: TicketViews, present: ReadonlySet<string>): TicketViews {
  const ids = Object.keys(views);
  return ids.every((id) => present.has(id)) ? views : Object.fromEntries(ids.filter((id) => present.has(id)).map((id) => [id, views[id]!]));
}

/** A ticket tile's size as it first shows its terminal: room for an 80-column terminal and its helper strip. */
export const TICKET_TERMINAL_SIZE = { width: 720, height: 520 };

/**
 * The expanded tiles with every ticket tile in the terminal view among them: its terminal is drawn by the expanded
 * tile, which makes room for itself on the board. One its session window has is left to the window (one terminal sizes
 * it), and comes back when that closes. Returns the same array when every one is already open.
 */
export function withTicketTerminals(expanded: ExpandedTiles, terminals: readonly string[], windowed: ReadonlySet<string>, sizes: ExpandedSizes): ExpandedTiles {
  const missing = terminals.filter((id) => !windowed.has(id) && !expanded.some((entry) => entry.id === id));
  return missing.length === 0 ? expanded : [...expanded, ...missing.map((id) => ({ id, ...(sizes[id] ?? TICKET_TERMINAL_SIZE) }))];
}

/**
 * Whether the tile rests in the terminal view: a ticket tile whose view is the terminal. Its tile expanded is how it
 * rests, not a passing look, so a collapse the board makes on its own (another tile opened from ⌘K, a zone shown, a
 * fold) leaves it open; only the user's own way back (the switch, the ⋯ row, Esc) puts it back to its card, and that
 * is a switch by hand, kept.
 */
export function restsInTerminal(tickets: readonly string[], over: ReadonlySet<string>, views: TicketViews, openAs: TicketTilesOpenAs, id: string): boolean {
  return tickets.includes(id) && ticketViewOf(views, id, openAs, over.has(id)) === 'terminal';
}

/** The ticket tiles a change of the default from `before` to `after` takes out of the terminal view: the live ones not switched by hand. */
export function ticketsLeavingTerminal(tickets: readonly string[], over: ReadonlySet<string>, views: TicketViews, before: TicketTilesOpenAs, after: TicketTilesOpenAs): string[] {
  return before === 'terminal' && after !== 'terminal' ? tickets.filter((id) => views[id] === undefined && !over.has(id)) : [];
}

/** The helper a ticket's tile shows in place of its chat: the one picked, while the ticket still holds it; else none, and the chat shows. */
export function shownHelper<Helper extends { sessionId: string }>(picked: string | undefined, helpers: readonly Helper[]): Helper | undefined {
  return picked === undefined ? undefined : helpers.find((helper) => helper.sessionId === picked);
}
