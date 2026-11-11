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

/** The marks round a bracketed paste. */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * What to write at an agent's prompt for a message, before the return that submits it: one short line typed as it is,
 * or several lines, a long one (`LONGEST_TYPED_LINE_BYTES`), or one with `paste`, as a bracketed paste, as a terminal
 * pastes text, so the harness keeps all of it and its line breaks, and takes a path in it as a dropped file. Both
 * harnesses turn on bracketed paste. Control characters are dropped either way. A long paste may yet be cut up to write
 * (`pastePieces`).
 */
export function answerInput(text: string, paste = false): string {
  const message = text.replace(/\r\n?/g, '\n').replace(UNSENDABLE, '').trim();
  if (!paste && !message.includes('\n') && Buffer.byteLength(message) <= LONGEST_TYPED_LINE_BYTES) return message;
  return `${PASTE_START}${message.replaceAll('\n', '\r')}${PASTE_END}`;
}

/**
 * The most text, and line breaks, of a message one paste carries. Claude 2.1.318 to 2.1.322 fold a paste of over 800 characters or
 * three line breaks into a placeholder, and marks what is in it as pasted material, not the user's words; a smaller one
 * it takes as text, its spaces and line breaks kept. Both limits leave a margin, as a later version may count differently.
 */
const PASTE_PIECE_CHARS = 600;
const PASTE_PIECE_BREAKS = 2;

/** The longest message sent in pieces (`pastePieces`), and the most pieces, the most tried in one write: past them, it goes whole. */
const LONGEST_IN_PIECES = 30_000;
const MOST_PIECES = 199;

/** How much of a piece a character takes up: Claude makes four spaces of a tab, so it counts as four. */
const pieceWidth = (character: string) => (character === '\t' ? 4 : 1);

/** How much of `text` the next piece takes: up to a space where it has to cut a line, never through a character. */
function pieceLength(text: string): number {
  let breaks = 0;
  let width = 0;
  let at = 0;
  for (; at < text.length; at += 1) {
    if (text[at] === '\r' && (breaks += 1) > PASTE_PIECE_BREAKS) return at;
    width += pieceWidth(text[at]!);
    if (width > PASTE_PIECE_CHARS) break;
  }
  if (at === text.length) return at;
  const space = text.lastIndexOf(' ', at - 1);
  if (space >= 0) return space + 1;
  const low = text.charCodeAt(at);
  return low >= 0xdc00 && low <= 0xdfff ? at - 1 : at;
}

/**
 * What to write for `input` (`answerInput`) at a Claude prompt so it stays the user's words: a paste Claude would fold, as
 * pastes each small enough that it takes them as text, all written at once, as it keeps pastes apart however close they
 * come. Should one fold all the same, nothing is lost. A message starting with `!` or `/` stays whole, as it does today:
 * a small first piece starting with `!` put Claude's prompt in bash mode, where Enter runs it. So does one too long to go
 * in pieces, and anything else is written as it is.
 */
export function pastePieces(input: string): string[] {
  if (!input.startsWith(PASTE_START)) return [input];
  let rest = input.slice(PASTE_START.length, -PASTE_END.length);
  if (/^[!/]/.test(rest) || [...rest].reduce((width, character) => width + pieceWidth(character), 0) > LONGEST_IN_PIECES) return [input];
  const pieces: string[] = [];
  while (rest !== '') {
    const length = pieceLength(rest);
    pieces.push(`${PASTE_START}${rest.slice(0, length)}${PASTE_END}`);
    rest = rest.slice(length);
    if (pieces.length > MOST_PIECES) return [input];
  }
  return pieces;
}

/**
 * The columns a prompt is taken to have when counting its rows (`promptRows`): narrower than a tile's terminal usually is,
 * as too many rows only costs keys that do nothing at an empty prompt, and too few leaves text behind.
 */
const NARROWEST_PROMPT_COLUMNS = 20;

/** How many rows, at most, `input` written at a prompt takes up: Ctrl-U clears only one of a line's wrapped rows. */
export function promptRows(input: string): number {
  return submittedText(input)
    .split('\r')
    .reduce((rows, line) => rows + 1 + Math.floor(line.length / NARROWEST_PROMPT_COLUMNS), 0);
}

/** What a harness submits of `input` written at its prompt (`answerInput`): a paste comes without its marks. */
export function submittedText(input: string): string {
  return input.replace(/\x1b\[20[01]~/g, '');
}

/** Text as one line at a prompt: a line break would submit what came before it on its own. */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}
