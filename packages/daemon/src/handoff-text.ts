import { markSender } from './sender-marker.ts';

/** Control characters, C0 and C1, but for the tab and line breaks, which become spaces. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/** `text` with no control characters, on one line. */
const plain = (text: string) => text.replace(CONTROLS, '').replace(/\s+/g, ' ').trim();

/**
 * What agent B is typed when agent `from` hands it `text`, its payload `name` (`final message`, `plan.md`): another
 * agent's words, not the user's, so they say where they came from, can't start as a TUI command (`/` a slash command,
 * `!` a shell command in B's worktree), and carry no control character to drive B's terminal (an escape sequence, ^C,
 * ^U). One line, as a typed prompt must be.
 */
export function handoffLine(from: string, name: string, text: string): string {
  return `Hand-off from ${plain(from)} (its ${plain(name)}): ${plain(text)}`;
}

/**
 * Agent `from`'s hand-off of `text`, its payload `name`, headed with its sender mark (ADR-0023): what a running agent
 * is typed, and what a crew's new member reads of its work in its first prompt, so the two read alike. Undefined when
 * the text is nothing once on one line, as there is nothing to hand off.
 */
export function handOffMessage(from: string, ref: string, name: string, text: string): string | undefined {
  return plain(text) === '' ? undefined : markSender('hand-off', from, ref, handoffLine(from, name, text));
}

/**
 * Agent `from`'s `text` headed with its send mark (ADR-0023), on one line, so no line of it can start as the board's
 * (`[agent-board] …`): what a crew's new member reads of the prompt an agent started its crew with. Undefined when the
 * text is nothing once on one line.
 */
export function sentLine(from: string, ref: string, text: string): string | undefined {
  return plain(text) === '' ? undefined : markSender('send', from, ref, plain(text));
}
