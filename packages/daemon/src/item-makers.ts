// Who made a board item, as far as the board knows: the `made_by` mark the daemon puts on what an agent makes through it,
// and the maker that the data of a card the daemon makes for an agent names.
import type { BoardItem } from './protocol.ts';

/** The session in `who` (`{ sessionId }`), if it names one. */
function sessionIn(who: unknown): string | undefined {
  return typeof who === 'object' && who !== null && typeof (who as { sessionId?: unknown }).sessionId === 'string' ? (who as { sessionId: string }).sessionId : undefined;
}

/**
 * The agent an item's own data names as its maker: the agent an agent note is about or was written by, the agent whose
 * document or plan card it is, the agent that made a queue or steps card, the agent whose to-do list it is. Undefined
 * when its data names none, and then the item's `made_by` says, if anything does.
 */
export function agentOfItem({ kind, data }: BoardItem): string | undefined {
  if (kind === 'agent-note' && typeof data.about === 'string') return data.about;
  if (kind === 'agent-note' || kind === 'document' || kind === 'plan') return sessionIn(data.agent);
  const who = (kind === 'todo' ? data.owner : data.madeBy) as { kind?: unknown } | undefined;
  return who?.kind === 'agent' ? sessionIn(who) : undefined;
}

/**
 * The agent session that made `item`, or null when the board knows of none (the user, or an item nobody marked): its
 * `made_by` mark, else the agent its data names as maker (`agentOfItem`). An agent note's data names the agent it is
 * about, not its writer, so only its mark counts. A copy the user pastes or duplicates names the user (the board's paste
 * makes it so), never the agent the original names.
 */
export function itemMaker(item: BoardItem, madeBy: string | null): string | null {
  if (madeBy !== null) return madeBy;
  return item.kind === 'agent-note' ? null : (agentOfItem(item) ?? null);
}
