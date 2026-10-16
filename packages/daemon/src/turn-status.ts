import { MAX_STATUS_LENGTH, isMidTurn, type Agent, type AgentState, type AgentStatus } from './protocol.ts';
import { oneLine } from './terminal-input.ts';

/** States an agent is mid-turn in, or about to be again, beyond those `isMidTurn` knows: its progress is of work under way. */
const ALSO_WORKING: ReadonlySet<AgentState> = new Set<AgentState>(['rate-limited', 'handing-off']);

/** Whether the live agent is part-way through a turn, a call that waits on the user (`ask`, `plan`) included. */
export function isWorking(agent: Pick<Agent, 'state' | 'ask' | 'plan' | 'endedAt'>): boolean {
  return agent.endedAt === null && (isMidTurn(agent) || ALSO_WORKING.has(agent.state));
}

/**
 * A line saying what a finished turn ended on: the summary of its `STATUS: <state> | <summary>` marker line, else the
 * message's first line, else the marker's own text.
 */
export function summaryOfMessage(message: string | null | undefined): string | null {
  if (message === null || message === undefined) return null;
  const lines = message.split('\n').map((line) => line.trim());
  const marker = lines.findLast((line) => /^STATUS:/i.test(line))?.replace(/^STATUS:\s*/i, '');
  const fromMarker = marker?.includes('|') ? marker.slice(marker.indexOf('|') + 1).trim() : '';
  const text = fromMarker || lines.find((line) => line !== '' && !/^STATUS:/i.test(line)) || marker || '';
  const line = oneLine(text);
  if (line === '') return null;
  return line.length > MAX_STATUS_LENGTH ? `${line.slice(0, MAX_STATUS_LENGTH - 1)}…` : line;
}

/**
 * The status a tile shows. Mid-turn it is what the agent set. Once its turn has ended, or the agent has, a
 * percentage is of work that is over (one waiting on a question mid-turn keeps its own), so it goes: the agent's own summary stays; one that set none shows what its last
 * message said, or nothing.
 */
export function statusAfterTurn(
  status: AgentStatus | null,
  working: boolean,
  finalMessage: string | null | undefined,
  finishedAt: string | null,
): AgentStatus | null {
  if (working) return status;
  if (status !== null) return status.progress === null ? status : { ...status, progress: null };
  const summary = summaryOfMessage(finalMessage);
  return summary === null || finishedAt === null ? null : { summary, progress: null, updatedAt: finishedAt };
}
