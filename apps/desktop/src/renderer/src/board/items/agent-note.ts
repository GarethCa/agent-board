// An agent note's data as the board draws it: who wrote it, when, and whether the user has edited it since.
import { HARNESSES, type AgentNoteData, type SuggestedEdit } from '@agent-board/daemon/protocol';

/** An agent note's data, with defaults for anything missing or of the wrong type. */
export function agentNoteData(data: Record<string, unknown>): AgentNoteData {
  const agent = (typeof data.agent === 'object' && data.agent !== null ? data.agent : {}) as Record<string, unknown>;
  return {
    text: typeof data.text === 'string' ? data.text : '',
    agent: {
      sessionId: typeof agent.sessionId === 'string' ? agent.sessionId : '',
      name: typeof agent.name === 'string' ? agent.name : 'An agent',
      harness: HARNESSES.find((harness) => harness === agent.harness) ?? 'claude',
      role: typeof agent.role === 'string' ? agent.role : null,
    },
    writtenAt: typeof data.writtenAt === 'string' ? data.writtenAt : '',
    editedByUser: data.editedByUser === true,
    ...(typeof data.asked === 'string' ? { asked: data.asked } : {}),
    ...(typeof data.about === 'string' ? { about: data.about } : {}),
    // The daemon checked them as they were made; only a list is taken.
    ...(Array.isArray(data.suggestions) ? { suggestions: data.suggestions as SuggestedEdit[] } : {}),
  };
}

/** `iso` on the clock, as 14:02; nothing for no time. */
export function clockTime(iso: string): string {
  const time = new Date(iso);
  if (iso === '' || Number.isNaN(time.getTime())) return '';
  return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
}

/** What an agent note's footer says: the user edited it, or its agent wrote it again after making it (at `createdAt`). */
export type AgentNoteFooter = { kind: 'edited' } | { kind: 'updated'; time: string };

export function agentNoteFooter(note: AgentNoteData, createdAt: string): AgentNoteFooter | undefined {
  if (note.editedByUser) return { kind: 'edited' };
  // A minute or more after it was made: the time it was made at says the rest.
  const rewritten = Date.parse(note.writtenAt) - Date.parse(createdAt) >= 60_000;
  return rewritten ? { kind: 'updated', time: clockTime(note.writtenAt) } : undefined;
}

/** What an answer's footer offers for its suggested edits: "Accept" one, "Accept both", "Accept all". */
export function acceptLabel(count: number): string {
  return count === 1 ? 'Accept' : count === 2 ? 'Accept both' : 'Accept all';
}
