import { HAND_OFF_HEAD, type MessageKind, type MessageSender } from './protocol.ts';

/**
 * The sender mark (ADR-0023): what heads every message the board types at an agent's prompt for another agent (a
 * send, a reply, a hand-off), so its transcript, which records every message as the user's, still says who sent it.
 * `⟨send from Captain · agent:944e1234⟩ Fix the login test`: on the message's first line, so a short message is still
 * typed as one line and a long one pasted with it, and read back from the transcript (`readSender`) for the chat.
 * The angle brackets are U+27E8 and U+27E9, which no harness reads as markup and nothing typed strips.
 */

/** The longest sender name a mark carries. */
const MAX_MARK_NAME = 80;

const MARK = /^⟨(send|reply|hand-off) from ([^⟨⟩\n]+) · (agent:[A-Za-z0-9_-]+)⟩ ?/;

/** A name as a mark carries it: printable, on one line, with no angle bracket to end the mark early. */
// eslint-disable-next-line no-control-regex -- dropping control characters is the point
const markName = (name: string) => name.replace(/[\x00-\x1f\x7f-\x9f⟨⟩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_MARK_NAME).trim() || 'an agent';

/** `text` headed with the mark of `kind` from the agent `name`, ref `ref` (`agent:944e1234`). */
export function markSender(kind: MessageKind, name: string, ref: string, text: string): string {
  return `⟨${kind} from ${markName(name)} · ${ref}⟩ ${text}`;
}

/**
 * The sender a user message's mark names, and its text without the mark. A hand-off's payload is read from its head
 * (`Hand-off from impl (its plan.md): `) as `payload`; the head, and a send's closing line on who it is from
 * (`[agent-board] From …`), stay in the text until the chat says so itself. A message with no mark is the user's, as
 * it was.
 */
export function readSender(text: string): { text: string; from?: MessageSender } {
  const mark = MARK.exec(text);
  if (mark === null) return { text };
  const [whole, kind, name, ref] = mark as unknown as [string, MessageKind, string, string];
  const body = text.slice(whole.length);
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
