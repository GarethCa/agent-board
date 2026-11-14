// Ticket tiles: one agent, the ticket's chat (`Agent.ticketChat`), and its helpers (`Agent.ticket`), the agents that chat
// starts, and theirs. The chat runs the ticket's loop; a helper's questions and flags go to it, whoever started the helper.
// Pure, for the app's window too.
import type { Agent } from './protocol.ts';

/** Whether `agent` is a helper of a ticket tile. */
export const isHelper = (agent: Pick<Agent, 'ticket'>): boolean => typeof agent.ticket === 'string';

/**
 * Whether `agent` is a helper its ticket holds where it is: its chat in the same zone. An arrange or a stage board
 * leaves those to the ticket, and lays out a helper elsewhere, away from its chat, as any agent.
 */
export const heldByTicket = (agent: Pick<Agent, 'ticket' | 'zoneId'>, agents: readonly Pick<Agent, 'sessionId' | 'zoneId'>[]): boolean =>
  isHelper(agent) && agents.some((chat) => chat.sessionId === agent.ticket && chat.zoneId === agent.zoneId);

/** The helpers of the ticket whose chat is `chatId`, in the order given. */
export const helpersOf = <A extends Pick<Agent, 'ticket'>>(agents: readonly A[], chatId: string): A[] =>
  agents.filter((agent) => agent.ticket === chatId);

/** Who `agent`'s flags and questions go to before the user: its ticket's chat, else the agent that started it, else none. */
export const flagLeadOf = (agent: Pick<Agent, 'ticket' | 'spawnedBy'>): string | null => agent.ticket ?? agent.spawnedBy;
