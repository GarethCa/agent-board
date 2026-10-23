// Agent notes: the notes agents write, a board item of their own kind so none is ever taken for one of the
// user's stickies. `note add` from an agent makes one; Ask Claude's answers are made here too.
import { AGENT_NOTE_SIZE, MAX_AGENT_NOTE_HEIGHT, type Agent, type AgentNoteAuthor, type AgentNoteData } from './protocol.ts';

/** A character drawn twice as wide as a letter: CJK, Hangul, fullwidth forms and emoji. */
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;

/** How the board draws a note's text in one of its looks, px. */
interface Look {
  /** How wide a character of its type is drawn. */
  width(char: string): number;
  /** A line of markdown as it is drawn: without the marks that draw nothing. */
  shown(line: string): string;
  lineHeight: number;
  /** How far in a paragraph's and a list item's lines start. */
  indent: { paragraph: number; item: number };
  /** The space after each block. */
  blockGap: number;
}

/** Bold, italics and a link's address draw nothing. */
const unmarked = (line: string) => line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*+/g, '');

/**
 * Its looks, the document card and the terminal's, measured from the app's styles and rounded up a little, so a note
 * sized here is never too short. The document's code is set smaller, but boxed: its backticks stand in for its box.
 */
const LOOKS: readonly Look[] = [
  {
    width: (char) => (WIDE.test(char) ? 12.5 : char === ' ' ? 3.4 : /[A-Z0-9]/.test(char) ? 7.8 : 6.4),
    shown: unmarked,
    lineHeight: 17.5,
    indent: { paragraph: 0, item: 16 },
    blockGap: 4,
  },
  {
    width: (char) => (WIDE.test(char) ? 13 : 6.8),
    shown: (line) => unmarked(line).replaceAll('`', ''),
    lineHeight: 16,
    indent: { paragraph: 19, item: 28 },
    blockGap: 0,
  },
];
/** The card's sides and padding across, and its tab, border, padding and footer down, px. */
const CHROME_WIDTH = 27;
const CHROME_HEIGHT = 70;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * How many lines `text` takes `room` px wide in `look`: broken between words, and a word too long for a line anywhere
 * in it, as the card's `overflow-wrap: anywhere` breaks it (CJK text, a URL).
 */
function wrappedLines(text: string, room: number, look: Look): number {
  const space = look.width(' ');
  let lines = 1;
  let used = 0;
  for (const word of text.split(' ')) {
    const chars = [...word].map((char) => look.width(char));
    const width = chars.reduce((sum, each) => sum + each, 0);
    if (used + (used > 0 ? space : 0) + width <= room) {
      used += (used > 0 ? space : 0) + width;
      continue;
    }
    if (used > 0) lines++;
    used = 0;
    for (const each of chars) {
      if (used + each > room && used > 0) {
        lines++;
        used = 0;
      }
      used += each;
    }
  }
  return lines;
}

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

/**
 * The size a new agent note of `text` starts at, `width` wide: tall enough to show all its text whichever way the board
 * draws it, and no shorter than `least`. Past `MAX_AGENT_NOTE_HEIGHT` it scrolls.
 */
export function agentNoteSize(text: string, width = AGENT_NOTE_SIZE.width, least = AGENT_NOTE_SIZE.height): { width: number; height: number } {
  const lines = text.split('\n');
  const body = Math.max(
    ...LOOKS.map((look) => {
      let height = 0;
      let last: 'paragraph' | 'item' | undefined;
      for (const line of lines) {
        if (line.trim() === '') {
          last = undefined;
          continue;
        }
        const kind = LIST_ITEM.test(line) ? 'item' : 'paragraph';
        // A list item after a paragraph, or either after a blank line, starts a block of its own.
        if (kind !== last) height += look.blockGap;
        last = kind;
        height += wrappedLines(look.shown(line.replace(LIST_ITEM, '')), width - CHROME_WIDTH - look.indent[kind], look) * look.lineHeight;
      }
      return height;
    }),
  );
  const height = Math.min(MAX_AGENT_NOTE_HEIGHT, Math.max(least, Math.ceil(CHROME_HEIGHT + body)));
  return { width, height };
}
