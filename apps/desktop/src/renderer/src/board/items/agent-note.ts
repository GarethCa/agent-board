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

const DAY_MS = 86_400_000;

/** A note's stamp for `iso` as seen from `now`: "Today 07:51", "Yesterday 07:51", "Fri 07:51" within the week, then "28 Oct 07:51" (with the year, if not this one). The weekday and date follow `locale` (else the machine's), the time is always 24-hour and Today/Yesterday English, as the app is; nothing for no time. */
export function noteStamp(iso: string, now: Date, locale?: string): string {
  const time = clockTime(iso);
  if (time === '') return '';
  const at = new Date(iso);
  // Whole calendar days apart in the machine's time zone, so 23:59 to 00:01 is a day.
  const days = Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(at.getFullYear(), at.getMonth(), at.getDate())) / DAY_MS);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days >= 2 && days <= 6) return `${at.toLocaleDateString(locale, { weekday: 'short' })} ${time}`;
  const date = at.toLocaleDateString(locale, { day: 'numeric', month: 'short', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
  return `${date} ${time}`;
}

/** `iso` in full, for the hover and the accessible name: "Saturday 31 October 2026, 07:51". */
export function noteStampFull(iso: string, locale?: string): string {
  const time = clockTime(iso);
  if (time === '') return '';
  return `${new Date(iso).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${time}`;
}

/** What an agent note's footer says: the user edited it, or its agent wrote it again after making it (at `createdAt`). */
export type AgentNoteFooter = { kind: 'edited' } | { kind: 'updated' };

export function agentNoteFooter(note: AgentNoteData, createdAt: string): AgentNoteFooter | undefined {
  if (note.editedByUser) return { kind: 'edited' };
  // A minute or more after it was made: the time it was made at says the rest.
  const rewritten = Date.parse(note.writtenAt) - Date.parse(createdAt) >= 60_000;
  return rewritten ? { kind: 'updated' } : undefined;
}

/** What an answer's footer offers for its suggested edits: "Accept" one, "Accept both", "Accept all". */
export function acceptLabel(count: number): string {
  return count === 1 ? 'Accept' : count === 2 ? 'Accept both' : 'Accept all';
}
