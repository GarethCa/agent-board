// What a client's input to an agent's terminal says about the line being typed at its prompt. Terminal input is
// control characters as much as text, so the patterns here match them on purpose.
/* eslint-disable no-control-regex */

/**
 * Escape sequences a terminal sends that aren't typing: focus and mouse reports, arrow and function keys. An X10 mouse
 * report carries three raw bytes after `ESC [ M`.
 */
const ESCAPE_SEQUENCE = /\x1b\[M[\s\S]{3}|\x1b\[[0-?]*[ -/]*[@-~]|\x1bO[\s\S]|\x1b[\s\S]?/g;

/** Keys that end the line being typed: Enter submits it, Ctrl-C and Ctrl-U clear it. */
const LINE_ENDED = /[\r\x03\x15]/;

/** A character that is typed text, not a control key. */
const TYPED = /[^\x00-\x1f\x7f]/;

/**
 * Whether the user has a draft at the prompt after `data` is written to the terminal, given whether they had one
 * before: typed or pasted text starts one, and Enter, Ctrl-C or Ctrl-U ends it. Deleting the text key by key leaves it
 * counted as a draft until one of those.
 */
export function draftAfterInput(drafting: boolean, data: string): boolean {
  const lines = data.replace(ESCAPE_SEQUENCE, '').split(LINE_ENDED);
  if (TYPED.test(lines.at(-1)!)) return true;
  return lines.length > 1 ? false : drafting;
}

/**
 * Whether `data` written at the prompt presses Enter on a draft: one the user had before it (`drafting`), or text it
 * types before that Enter. Ctrl-C and Ctrl-U clear a draft first, as in `draftAfterInput`.
 */
export function submitsDraft(drafting: boolean, data: string): boolean {
  let draft = drafting;
  for (const key of data.replace(ESCAPE_SEQUENCE, '')) {
    if (key === '\r') {
      if (draft) return true;
    } else if (LINE_ENDED.test(key)) draft = false;
    else if (TYPED.test(key)) draft = true;
  }
  return false;
}

/**
 * Control characters a message may not carry: all but tab and the line break, C1 too (U+009B is a one-character CSI),
 * so no text in it can press keys at the prompt or end a paste early.
 */
const UNSENDABLE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * The longest line typed at a prompt as keys. A terminal hands its reader at most 1 KiB at a time on macOS, and Claude
 * keeps only the last read of a longer line typed with no paste around it: a 2,700-character message reached its
 * transcript as its last 700 or so. A paste of any length arrives whole.
 */
const LONGEST_TYPED_LINE_BYTES = 512;

/**
 * What to write at an agent's prompt for a message, before the return that submits it: one short line typed as it is,
 * or several lines, a long one (`LONGEST_TYPED_LINE_BYTES`), or one with `paste`, as a bracketed paste, as a terminal
 * pastes text, so the harness keeps all of it and its line breaks, and takes a path in it as a dropped file. Both
 * harnesses turn on bracketed paste. Control characters are dropped either way.
 */
export function answerInput(text: string, paste = false): string {
  const message = text.replace(/\r\n?/g, '\n').replace(UNSENDABLE, '').trim();
  if (!paste && !message.includes('\n') && Buffer.byteLength(message) <= LONGEST_TYPED_LINE_BYTES) return message;
  return `\x1b[200~${message.replaceAll('\n', '\r')}\x1b[201~`;
}

/** What a harness submits of `input` written at its prompt (`answerInput`): a paste comes without its marks. */
export function submittedText(input: string): string {
  return input.replace(/\x1b\[20[01]~/g, '');
}

/** Text as one line at a prompt: a line break would submit what came before it on its own. */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}
