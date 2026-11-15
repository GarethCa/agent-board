// Who builds a ticket: its chat (the implementer), or a builder helper the chat leads. A ticket keeps one worktree, its
// chat's, and a lead's builder works in it without owning it, so a switch changes only who edits there. It happens
// only at a hand-off, never mid-edit: asked for mid-turn, it waits, on `Agent.chatSwitch`, for the next one.
import type { DatabaseSync } from 'node:sqlite';
import { invalidParams, paramsObject, stringParam } from './params.ts';
import { isMidTurn, type Agent, type DaemonMethods, type SpawnAgentParams, type TicketChatKind } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';
import { builderOf } from './ticket-tiles.ts';

/** What switching a chat reads and does of the agent host. */
export interface TicketChatAgents {
  get(sessionId: string): Agent | undefined;
  list(): Agent[];
  spawn(params: SpawnAgentParams, spawnedBy?: string): Promise<Agent>;
  delete(sessionId: string, why: string, force: boolean, keepWorktree?: boolean): Promise<void>;
  /** Types `text` to the agent as its next turn, or queues it. */
  runScheduled(sessionId: string, text: string): unknown;
  announce(sessionId: string): void;
}

export interface TicketChatHostOptions {
  db: DatabaseSync;
  agents: TicketChatAgents;
  log: (line: string) => void;
}

export interface TicketChatHost {
  /** Makes `chatId`'s chat `kind` now, if it is at a hand-off, else at its next one. Asking for its kind drops a switch that waits. */
  set(chatId: string, kind: TicketChatKind): Promise<Agent>;
  /** `sessionId` handed off: a switch that waited on it happens. */
  handedOff(sessionId: string): void;
  /** `sessionId` is being removed: a lead whose builder it was, waiting to build, takes the branch over. */
  removed(sessionId: string): void;
}

/** The terminal a builder starts in, until its tile is shown and sized. */
const BUILDER_SIZE = { cols: 120, rows: 40 };

const kindOf = (chat: Agent): TicketChatKind => chat.chatKind ?? 'implementer';

/** Whether `agent` is at a hand-off: between turns (at its prompt, its work handed on or not yet begun), or ended. */
const atHandOff = (agent: Agent): boolean => agent.endedAt !== null || !isMidTurn(agent);

const toLeadText = (builder: Agent) =>
  `You are now this ticket's lead, no longer its implementer. ${builder.name} builds it, on your branch in your worktree: ` +
  'send it the work with agent-board send, and leave the files to it. You go on talking to the user.';

const toImplementerText = (builder: Agent | undefined) =>
  `You are now this ticket's implementer: you build it yourself, on your branch in your worktree.` +
  (builder === undefined ? '' : ` ${builder.name} handed off and has closed: read its last work in the worktree.`);

export function createTicketChatHost({ db, agents, log }: TicketChatHostOptions): TicketChatHost {
  const setKind = db.prepare('UPDATE agents SET ticket_lead = ?, chat_switch = NULL WHERE session_id = ?');
  const setSwitch = db.prepare('UPDATE agents SET chat_switch = ? WHERE session_id = ?');
  /** Chats whose switch is being made, so a second hand-off meanwhile does not make it twice. */
  const switching = new Set<string>();

  const builder = (chat: Agent) => builderOf(agents.list().filter((agent) => agent.endedAt === null), chat);

  const chatOf = (chatId: string): Agent => {
    const chat = agents.get(chatId);
    if (chat === undefined) throw invalidParams(`no agent ${chatId}`);
    if (!chat.ticketChat) throw invalidParams(`${chat.name} is not a ticket's chat`);
    return chat;
  };

  /** Makes a switch, unless one is being made: a hand-off told twice meanwhile makes it once. */
  const once = async (chatId: string, make: () => Promise<void>): Promise<void> => {
    if (switching.has(chatId)) return;
    switching.add(chatId);
    try {
      await make();
    } finally {
      switching.delete(chatId);
    }
  };

  const toLead = (chat: Agent) =>
    once(chat.sessionId, async () => {
      setKind.run(1, chat.sessionId);
      let started: Agent;
      try {
        started = await agents.spawn(
          {
            zoneId: chat.zoneId,
            ...(chat.zoneId === null && chat.position !== null ? { position: { x: chat.position.x + 40, y: chat.position.y + 40 } } : {}),
            name: `${chat.name} builder`,
            harness: chat.harness,
            ...(chat.model === null ? {} : { model: chat.model }),
            ...(chat.effort === null ? {} : { effort: chat.effort }),
            role: 'implementer',
            ticket: chat.sessionId,
            purpose: `Builds ${chat.name}, on its branch`,
            ...BUILDER_SIZE,
          },
          chat.sessionId,
        );
      } catch (error) {
        setKind.run(0, chat.sessionId);
        agents.announce(chat.sessionId);
        throw error;
      }
      if (started.worktree !== chat.worktree) log(`${started.name} did not start in ${chat.name}'s worktree: it builds in ${started.worktree}`);
      agents.announce(chat.sessionId);
      agents.runScheduled(chat.sessionId, toLeadText(started));
    });

  const toImplementer = (chat: Agent, gone: Agent | undefined) =>
    once(chat.sessionId, async () => {
      setKind.run(0, chat.sessionId);
      agents.announce(chat.sessionId);
      // It owns no worktree: closing it leaves the chat's, and the work in it, alone.
      if (gone !== undefined && gone.endedAt === null && agents.get(gone.sessionId) !== undefined) {
        await agents.delete(gone.sessionId, `${chat.name} took its branch back`, false, true);
      }
      agents.runScheduled(chat.sessionId, toImplementerText(gone));
    });

  const pending = (chat: Agent, kind: TicketChatKind | null) => {
    setSwitch.run(kind, chat.sessionId);
    agents.announce(chat.sessionId);
  };

  const fail = (what: string) => (error: unknown) => log(`could not ${what}: ${(error as Error).message}`);

  return {
    async set(chatId, kind) {
      const chat = chatOf(chatId);
      if (chat.plainFolder) throw invalidParams(`${chat.name} works outside git: its ticket has no branch to hand over`);
      if (chat.endedAt !== null) throw invalidParams(`${chat.name} has ended`);
      if (kind !== 'implementer' && kind !== 'lead') throw invalidParams(`unknown ticket chat kind ${String(kind)}`);
      if (switching.has(chatId)) throw invalidParams(`${chat.name}'s switch is under way: pick again once it is made`);
      if (kind === kindOf(chat)) {
        if (chat.chatSwitch !== undefined) pending(chat, null);
      } else if (kind === 'lead') {
        if (atHandOff(chat)) await toLead(chat);
        else pending(chat, 'lead');
      } else {
        const now = builder(chat);
        if (now === undefined || atHandOff(now)) await toImplementer(chat, now);
        else pending(chat, 'implementer');
      }
      return agents.get(chatId)!;
    },
    handedOff(sessionId) {
      const agent = agents.get(sessionId);
      // A hand-off told late, its next turn already begun, is no hand-off now: that turn's own end is.
      if (agent === undefined || !atHandOff(agent)) return;
      if (agent.ticketChat && agent.chatSwitch === 'lead' && kindOf(agent) === 'implementer') {
        void toLead(agent).catch(fail(`make ${agent.name} its ticket's lead`));
        return;
      }
      const chat = agent.ticket === undefined || agent.ticket === null ? undefined : agents.get(agent.ticket);
      if (chat?.chatSwitch !== 'implementer' || builder(chat)?.sessionId !== sessionId) return;
      void toImplementer(chat, agent).catch(fail(`give ${chat.name} its branch back`));
    },
    removed(sessionId) {
      const agent = agents.get(sessionId);
      const chat = agent?.ticket === undefined || agent.ticket === null ? undefined : agents.get(agent.ticket);
      if (agent === undefined || chat?.chatSwitch !== 'implementer' || builderOf(agents.list(), chat)?.sessionId !== sessionId) return;
      // Already going: the chat takes the branch over and tells no one to close it.
      void toImplementer(chat, { ...agent, endedAt: agent.endedAt ?? new Date(0).toISOString() }).catch(fail(`give ${chat.name} its branch back`));
    },
  };
}

type TicketChatMethods = Pick<DaemonMethods, 'ticket.setChat'>;

/** The `ticket.setChat` method: the app's, from a ticket tile's ⋯ menu. */
export function ticketChatHandlers<Context>(chats: Pick<TicketChatHost, 'set'>): RpcHandlers<TicketChatMethods, Context> {
  return {
    'ticket.setChat': async (params) => {
      const p = paramsObject(params);
      return { agent: await chats.set(stringParam(p, 'sessionId'), p.kind as TicketChatKind) };
    },
  };
}
