// Crew flags: a crew member's "please look" (`board.needsYou`), or the question or plan it would have put to the user,
// goes to the orchestrator that started it, not to the user. It is typed at that orchestrator's prompt as a hand-off
// is, through the same queue and only once the orchestrator is ready for its next message, as one message for every
// flag still to tell.
import type { Agent, AgentState } from './protocol.ts';
import type { RunStart } from './schedules.ts';

/** States of a live agent at its prompt: only these are worth asking the deliveries about. */
const AT_PROMPT: ReadonlySet<AgentState> = new Set<AgentState>(['idle', 'waiting']);

export interface CrewFlagOptions {
  /** The agent as it is now, if it is. */
  agent(sessionId: string): Agent | undefined;
  /** The agents `sessionId` started. */
  crewOf(sessionId: string): Agent[];
  /**
   * Types `text` at the agent's prompt once it is ready for its next message, as a hand-off is (`AgentHost.tell`):
   * not started, and tried again later, while it works, asks something, or the user is typing there.
   */
  tell(sessionId: string, text: string): Promise<RunStart>;
  log(message: string): void;
}

export interface CrewFlags {
  /** Hears an agent changed: a crew member's new flag, or its orchestrator back at its prompt. */
  observe(agent: Agent): void;
}

/** The ref an agent's message names it by: the start of its id, as `BoardRefs` resolves it. */
const refOf = (agent: Pick<Agent, 'sessionId'>): string => `agent:${agent.sessionId.slice(0, 8)}`;

/** What the orchestrator reads of its crew's flags. */
function crewFlagMessage(flagged: readonly Agent[]): string {
  const lines = flagged.map((agent) => `[agent-board] ${agent.name} (${refOf(agent)}) needs you: ${agent.flag!.reason}`);
  const [one] = flagged;
  const ref = flagged.length === 1 ? refOf(one!) : '<ref>';
  return [
    ...lines,
    `Reply with \`agent-board send ${ref} -- '…'\`, which clears its flag, or pass it on to the user with \`agent-board needs-you --via ${ref} -- '…'\`.`,
  ].join('\n');
}

export function createCrewFlags(options: CrewFlagOptions): CrewFlags {
  /** Per crew member, the flag (by id) already typed to its orchestrator. */
  const told = new Map<string, number>();
  /** Per crew member with a flag not yet typed, its orchestrator: an orchestrator with none is never looked at. */
  const pending = new Map<string, string>();
  /** The orchestrators being typed to now. */
  const typing = new Set<string>();

  /** Types the lead's crew's flags it hasn't been told of yet, if it is ready for them; else leaves them pending. */
  const tell = (leadId: string) => {
    if (typing.has(leadId) || ![...pending.values()].includes(leadId)) return;
    const lead = options.agent(leadId);
    if (lead === undefined || lead.endedAt !== null || !AT_PROMPT.has(lead.state)) return;
    const flagged = options.crewOf(leadId).filter((crew) => crew.flag?.to === 'orchestrator' && told.get(crew.sessionId) !== crew.flag.id);
    if (flagged.length === 0) return;
    typing.add(leadId);
    options
      .tell(leadId, crewFlagMessage(flagged))
      .then(
        (start) => {
          if (!start.started) return;
          for (const crew of flagged) {
            told.set(crew.sessionId, crew.flag!.id);
            // A newer flag raised meanwhile is still to tell.
            if (options.agent(crew.sessionId)?.flag?.id === crew.flag!.id) pending.delete(crew.sessionId);
          }
        },
        (error: unknown) => options.log(`could not tell ${lead.name} of its crew's flags: ${(error as Error).message}`),
      )
      .finally(() => typing.delete(leadId));
  };

  return {
    observe(agent) {
      const { flag, spawnedBy } = agent;
      if (flag?.to === 'orchestrator' && spawnedBy !== null && told.get(agent.sessionId) !== flag.id) pending.set(agent.sessionId, spawnedBy);
      else pending.delete(agent.sessionId);
      if (flag === null) told.delete(agent.sessionId);
      if (spawnedBy !== null && pending.has(agent.sessionId)) tell(spawnedBy);
      tell(agent.sessionId);
    },
  };
}
