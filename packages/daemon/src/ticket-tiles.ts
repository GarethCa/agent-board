// Ticket tiles: one agent, the ticket's chat (`Agent.ticketChat`), and its helpers (`Agent.ticket`), the agents that chat
// starts, and theirs. The chat runs the ticket's loop; a helper's questions and flags go to it, whoever started the helper.
// Pure, for the app's window too.
import { isOrchestratorRole, REVIEWER_ROLES, TICKET_CHAT_KINDS, type Agent, type BoxRect, type CrewPrefab, type PrefabMember, type TicketChatKind } from './protocol.ts';

/** Whether `agent` is a helper of a ticket tile. */
export const isHelper = (agent: Pick<Agent, 'ticket'>): boolean => typeof agent.ticket === 'string';

/**
 * Whether `agent` is a helper its ticket holds where it is: its chat in the same zone. An arrange or a stage board
 * leaves those to the ticket, and lays out a helper elsewhere, away from its chat, as any agent.
 */
export const heldByTicket = (agent: Pick<Agent, 'ticket' | 'zoneId'>, agents: readonly Pick<Agent, 'sessionId' | 'zoneId'>[]): boolean =>
  isHelper(agent) && agents.some((chat) => chat.sessionId === agent.ticket && chat.zoneId === agent.zoneId);

/**
 * The ticket whose own board `agent`'s notes, clocks and cards go on when it names no place: its ticket's, for a helper
 * its ticket holds; none (the main board) for any other agent, among them a ticket's chat, whose tile is the ticket on
 * the main board, and a helper away from its chat, whose tile is on the main board too.
 */
export const ownTicketBoard = (agent: Pick<Agent, 'ticket' | 'zoneId'>, agents: readonly Pick<Agent, 'sessionId' | 'zoneId'>[]): string | null =>
  heldByTicket(agent, agents) ? agent.ticket : null;

/** The helpers of the ticket whose chat is `chatId`, in the order given. */
export const helpersOf = <A extends Pick<Agent, 'ticket'>>(agents: readonly A[], chatId: string): A[] =>
  agents.filter((agent) => agent.ticket === chatId);

/** Who `agent`'s flags and questions go to before the user: its ticket's chat, else the agent that started it, else none. */
export const flagLeadOf = (agent: Pick<Agent, 'ticket' | 'spawnedBy'>): string | null => agent.ticket ?? agent.spawnedBy;

/** Whether `value` names a kind of ticket chat. */
export const isTicketChatKind = (value: unknown): value is TicketChatKind => TICKET_CHAT_KINDS.includes(value as never);

/** Whether `agent` is a ticket's chat that writes the ticket's code itself: the implementer (its tile's "builds" mark). */
export const chatBuilds = (agent: Pick<Agent, 'ticketChat' | 'chatKind'>): boolean => agent.ticketChat && agent.chatKind !== 'lead';

/**
 * The builder of the ticket whose chat is `chat`: the helper that works on the chat's branch, in its worktree, which it
 * does not own. A lead's builder; none while the chat is the implementer, or before its builder starts.
 */
export const builderOf = <A extends Pick<Agent, 'sessionId' | 'ticket' | 'worktree' | 'ownsWorktree'>>(
  agents: readonly A[],
  chat: Pick<Agent, 'sessionId' | 'worktree'>,
): A | undefined => agents.find((agent) => agent.ticket === chat.sessionId && agent.sessionId !== chat.sessionId && !agent.ownsWorktree && agent.worktree === chat.worktree);

/**
 * `prefab`, a ticket's, with a chat of `kind`. The implementer builds: the first builder member the chat would start goes, and
 * a chat set to lead builds instead. A lead leaves the code to a builder: its chat leads, and starts one if it has none.
 */
export function withTicketChat(prefab: CrewPrefab, kind: TicketChatKind): CrewPrefab {
  if (prefab.onBoard !== 'ticket') return prefab;
  const chat = prefab.members.find((each) => each.starts === 'prompt')!;
  const builds = (each: PrefabMember) => each.starts === 'lead' && each.role === 'implementer';
  if (kind === 'implementer') {
    const asChat = isOrchestratorRole(chat.role) ? { ...chat, role: 'implementer' } : chat;
    // The chat takes its first builder's place; any other builder stays a helper.
    const first = prefab.members.find(builds);
    return { ...prefab, ticketChat: kind, members: prefab.members.filter((each) => each !== first).map((each) => (each === chat ? asChat : each)) };
  }
  const asLead = chat.role === 'implementer' || chat.role === null ? { ...chat, role: 'orchestrator' } : chat;
  const members = prefab.members.map((each) => (each === chat ? asLead : each));
  if (!members.some(builds)) {
    const at = members.findIndex((each) => REVIEWER_ROLES.includes(each.role as never));
    const builder: PrefabMember = { id: 'build', role: 'implementer', name: 'builder', harness: chat.harness, model: chat.model, effort: chat.effort, template: null, subagents: [], starts: 'lead' };
    members.splice(at === -1 ? members.length : at, 0, builder);
  }
  return { ...prefab, ticketChat: kind, members };
}

/** The tiles' sizes on a ticket's own board, the gap between them, and the wider gap they keep from its notes and cards. */
export const TICKET_MEMBER_SIZE = {
  chat: { width: 280, height: 176 },
  helper: { width: 240, height: 64 },
  apart: 24,
  fromItems: 48,
} as const;

/**
 * Where a tile goes in a ticket's block, from the chat's place (`origin`): the chat there, and its nth helper (`row`) in
 * the column on its right, a row of its own each. The arrange lays the whole block out this way, and the board draws a
 * helper with no place of its own at its row of the same column.
 */
export function ticketBlockSlot(origin: { x: number; y: number }, row: number | 'chat'): { x: number; y: number } {
  const { chat, helper, apart } = TICKET_MEMBER_SIZE;
  return row === 'chat' ? { ...origin } : { x: origin.x + chat.width + apart, y: origin.y + row * (helper.height + apart) };
}

/**
 * Where an arrange of a ticket's own board puts its chat and helpers (`members`, the chat first), by session id: the
 * chat, with its helpers in a column on its right in the order given (`ticketBlockSlot`), the whole block a gap to the
 * left of the notes and cards on the board (`items`), its top level with theirs; at the board's origin with none. The
 * items stay put, and nothing on the main board moves. The same board arranges the same way.
 */
export function arrangeTicketBoard(members: readonly Pick<Agent, 'sessionId' | 'ticketChat'>[], items: readonly BoxRect[]): Map<string, { x: number; y: number }> {
  const { chat, helper, apart, fromItems } = TICKET_MEMBER_SIZE;
  const hasHelpers = members.some((member) => !member.ticketChat);
  const width = hasHelpers ? chat.width + apart + helper.width : chat.width;
  const origin = items.length === 0 ? { x: 0, y: 0 } : { x: Math.min(...items.map((item) => item.x)) - fromItems - width, y: Math.min(...items.map((item) => item.y)) };
  const places = new Map<string, { x: number; y: number }>();
  let row = 0;
  for (const member of members) places.set(member.sessionId, ticketBlockSlot(origin, member.ticketChat ? 'chat' : row++));
  return places;
}
