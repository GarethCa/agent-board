import { HAND_OFF_HEAD, type AgentMessageKind, type MessageKind, type MessageSender } from './protocol.ts';
import { cutText } from './text-words.ts';

/**
 * The sender mark (ADR-0023): what heads every message the board types at an agent's prompt for another agent (a
 * send, a reply, a hand-off), so its transcript, which records every message as the user's, still says who sent it.
 * `⟨send from Captain · agent:944e1234⟩ Fix the login test`: on the message's first line, so a short message is still
 * typed as one line and a long one pasted with it (in its first piece if in several), and read back from the
 * transcript (`readSender`) for the chat.
 * The angle brackets are U+27E8 and U+27E9, which no harness reads as markup and nothing typed strips.
 *
 * A clock's run is marked the same way, as the clock's (`⟨clock from Master check-in · item:…⟩ …`, `markClock`), and
 * the board's own notices are read by the lead they already have (`[agent-board] …`): neither is the user's.
 */

/** The longest sender name a mark carries. */
const MAX_MARK_NAME = 80;

/** The most characters of its prompt's first line a clock is named by in its mark. */
const MAX_CLOCK_NAME = 32;

const MARK = /^⟨(send|reply|hand-off|clock) from ([^⟨⟩\n]+) · ((agent|item):[A-Za-z0-9_-]+)⟩ ?/;

/** What leads each notice the board types at an agent's prompt for itself. */
export const BOARD_LEAD = '[agent-board] ';

/** Who the board's own notices are from. */
const BOARD: MessageSender = { ref: 'board', name: 'agent-board', kind: 'board' };

/** Claude's wrapper round a block it folded, its tags sharing an id; the line break inside each tag is the wrapper's. */
const PASTED_BLOCK = /<pasted_content id="([^"<>]*)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g;

/** What is in `text` if it is nothing but one block Claude folded, else undefined. */
export function onlyPasted(text: string): string | undefined {
  const [only, ...more] = [...text.matchAll(PASTED_BLOCK)];
  return only !== undefined && more.length === 0 && text.replace(only[0], '').trim() === '' ? only[2] : undefined;
}

/** A name as a mark carries it: printable, on one line, with no angle bracket to end the mark early. */
const markName = (name: string, none = 'an agent') =>
  // eslint-disable-next-line no-control-regex -- dropping control characters is the point
  name.replace(/[\x00-\x1f\x7f-\x9f⟨⟩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_MARK_NAME).trim() || none;

/** `text` headed with the mark of `kind` from the agent `name`, ref `ref` (`agent:944e1234`). */
export function markSender(kind: AgentMessageKind, name: string, ref: string, text: string): string {
  return `⟨${kind} from ${markName(name)} · ${ref}⟩ ${text}`;
}

/** What a clock is called where no name is given it: its prompt's first words, as its mark carries them. */
export const clockName = (prompt: string): string => markName(cutText(prompt.trim().split('\n', 1)[0]!, MAX_CLOCK_NAME), 'a clock');

/** `text`, a run of the clock with id `itemId` named `name`, headed with the clock's mark; a `/` or `!` command as it is. */
export function markClock(name: string, itemId: string, text: string): string {
  // A prompt that is a command (`/compact`, `!make`) is the user's own, typed to run: a mark first would make it text.
  if (/^\s*[/!]/.test(text)) return text;
  return `⟨clock from ${markName(name, 'a clock')} · item:${itemId}⟩ ${text}`;
}

/**
 * The sender a user message's mark names, and its text without the mark. A hand-off's payload is read from its head
 * (`Hand-off from impl (its plan.md): `) as `payload`; the head, and a send's closing line on who it is from
 * (`[agent-board] From …`), stay in the text until the chat says so itself. A clock's mark names it, and a message led
 * by `[agent-board]` is the board's, without its lead. A message with neither is the user's, as it was. The mark may lie inside a block Claude folded, of all or the start of a long message: an agent's message is
 * read whole, with no wrapper left in it, however Claude took it in.
 */
export function readSender(text: string): { text: string; from?: MessageSender } {
  const unwrapped = text.replace(PASTED_BLOCK, '$2');
  const plain = unwrapped === text ? text : unwrapped.trimStart();
  const mark = MARK.exec(plain);
  if (mark === null) return plain.startsWith(BOARD_LEAD) ? { text: plain.slice(BOARD_LEAD.length), from: BOARD } : { text };
  const [whole, kind, name, ref, refKind] = mark as unknown as [string, MessageKind, string, string, 'agent' | 'item'];
  // A clock's ref is its item's, an agent's message an agent's: a mark that mixes them is no one's.
  if ((kind === 'clock') !== (refKind === 'item')) return { text };
  const body = plain.slice(whole.length);
  const from: MessageSender = { ref, name, kind };
  // Found by its shape, not the mark's name: a name the mark had to clean (brackets, a long one) is the head's as it was.
  const head = kind === 'hand-off' ? HAND_OFF_HEAD.exec(body) : null;
  if (head !== null) from.payload = head[1];
  return { text: body, from };
}

/**
 * The closing line a send ends with, so the receiver knows who it is from: with how to answer when it may
 * (`answerable`), else only who. Matches `SEND_TRAILER`, which the chat reads it back with.
 */
export function sendTrailer(name: string, ref: string, answerable: boolean): string {
  return `\n\n[agent-board] From ${name} (${ref})${answerable ? `, who you may answer with \`agent-board send ${ref} -- '…'\`` : ''}.`;
}
