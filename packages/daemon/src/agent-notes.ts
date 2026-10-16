// Agent notes: the notes agents write, a board item of their own kind so none is ever taken for one of the
// user's stickies. `note add` from an agent makes one; Ask Claude's answers are made here too.
import { AGENT_NOTE_SIZE, type Agent, type AgentNoteAuthor, type AgentNoteData } from './protocol.ts';

/** The most an agent note grows to as it is made; it scrolls past that, and the user can resize it. */
const MAX_AGENT_NOTE_HEIGHT = 480;
/**
 * About how many characters of its UI type fit on a line, fewer in a list item's indent; how tall a line is, and a
 * blank line between paragraphs; and its header, footer and padding together, px.
 */
const CHARS_PER_LINE = 40;
const CHARS_PER_ITEM = 34;
const LINE_HEIGHT = 18;
const GAP_HEIGHT = 6;
const CHROME_HEIGHT = 84;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/** What an agent note says of `agent`: its name and harness, and its role as its badge calls it. */
export function agentNoteAuthor(agent: Agent): AgentNoteAuthor {
  // Only an orchestrator writes notes through `note`: one with no role of its own is badged as that.
  const role = agent.role === 'implementer' ? 'implementer' : agent.role === 'reviewer' || agent.role === 'follow-up-reviewer' ? 'reviewer' : 'orchestrator';
  return { sessionId: agent.sessionId, name: agent.name, harness: agent.harness, role };
}

/** The data of a note `author` writes now: its markdown, who wrote it and when, not edited by the user. */
export function agentNoteData(author: AgentNoteAuthor, text: string, more: Pick<AgentNoteData, 'asked' | 'about' | 'suggestions'> = {}, now = new Date()): AgentNoteData {
  return { text, agent: author, writtenAt: now.toISOString(), editedByUser: false, ...more };
}

/** The size a new agent note of `text` starts at: its width, and about as tall as its lines, within limits. */
export function agentNoteSize(text: string): { width: number; height: number } {
  const body = text.split('\n').reduce((sum, line) => {
    if (line.trim() === '') return sum + GAP_HEIGHT;
    const perLine = LIST_ITEM.test(line) ? CHARS_PER_ITEM : CHARS_PER_LINE;
    return sum + Math.max(1, Math.ceil(line.length / perLine)) * LINE_HEIGHT;
  }, 0);
  const height = Math.min(MAX_AGENT_NOTE_HEIGHT, Math.max(AGENT_NOTE_SIZE.height, CHROME_HEIGHT + body));
  return { width: AGENT_NOTE_SIZE.width, height };
}
