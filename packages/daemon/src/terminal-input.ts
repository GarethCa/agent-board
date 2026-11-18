// What a client's input to an agent's terminal says about the line being typed at its prompt. Terminal input is
// control characters as much as text, so the patterns here match them on purpose.
/* eslint-disable no-control-regex */

/** The marks round a bracketed paste. */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * What a terminal sends of itself, not a key: focus reports, and mouse reports, X10 (`ESC [ M` and three raw bytes) or
 * SGR (`ESC [ <`).
 */
const REPORT = /^(?:\x1b\[M[\s\S]{3}|\x1b\[[IO]|\x1b\[<[0-?]*[ -/]*[@-~])/;

/**
 * The escape sequence a key sends: arrows, Home, Delete and function keys (CSI, or SS3 in application mode), a key with
 * Alt (Escape before it), or Escape alone.
 */
const KEY_SEQUENCE = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1bO[\s\S]|\x1b[\s\S]?)/;

/** Up, with or without a modifier: at a prompt it puts an earlier line from its history there. */
const RECALL = /^\x1b(?:\[(?:1;\d+)?|O)A$/;

/** Keys that end the line being typed: Enter submits it, Ctrl-C clears it. */
const LINE_ENDED = /^[\r\x03]$/;

/**
 * Ctrl-U, which the app sends for ⌘⌫ too: it clears the line up to the cursor, and only the wrapped row the cursor is
 * on, so a draft of several lines (Shift+Enter, a paste), or one line long enough to wrap, keeps those before it.
 */
const CLEAR_LINE = '\x15';

/** Ctrl-Y yanks text cut earlier back to the prompt, and Ctrl-V pastes an image there. */
const PUTS_AT_PROMPT = /^[\x19\x16]$/;

/** One key in what a client writes to a terminal, or one paste, or a report of the terminal's own. */
type Key = { kind: 'text' | 'paste'; text: string } | { kind: 'control' | 'sequence'; key: string } | { kind: 'report' };

/** The keys in `data`, in order: a line break inside a paste is the paste's, never Enter. */
function keysOf(data: string): Key[] {
  const keys: Key[] = [];
  let rest = data;
  while (rest !== '') {
    if (rest.startsWith(PASTE_START)) {
      const end = rest.indexOf(PASTE_END, PASTE_START.length);
      keys.push({ kind: 'paste', text: rest.slice(PASTE_START.length, end === -1 ? undefined : end) });
      rest = end === -1 ? '' : rest.slice(end + PASTE_END.length);
      continue;
    }
    const report = REPORT.exec(rest);
    const sequence = report ?? KEY_SEQUENCE.exec(rest);
    if (sequence !== null) {
      keys.push(report === null ? { kind: 'sequence', key: sequence[0] } : { kind: 'report' });
      rest = rest.slice(sequence[0].length);
      continue;
    }
    const character = String.fromCodePoint(rest.codePointAt(0)!);
    keys.push(/^[\x00-\x1f\x7f]$/.test(character) ? { kind: 'control', key: character } : { kind: 'text', text: character });
    rest = rest.slice(character.length);
  }
  return keys;
}

/**
 * The user's line at a prompt, as far as their keys tell: how many characters it holds, or `undefined` once the board
 * can't tell (a line recalled, the cursor moved, a word deleted, a second line begun), when it is held a draft until
 * Enter or Ctrl-C. Ctrl-U ends only one it can count: one line, typed with the cursor at its end, on one row.
 */
export interface Draft {
  length: number | undefined;
}

/** A draft whose length the board can't tell. */
const UNSURE: Draft = { length: undefined };

const grown = (draft: Draft | undefined, by: number): Draft =>
  draft === undefined ? { length: by } : { length: draft.length === undefined ? undefined : draft.length + by };

/**
 * The columns of each row a prompt keeps for its own marks, not the user's text: Claude's `> ` and its box's sides,
 * taken widely, with room to spare, as a row taken too wide leaves text behind.
 */
const PROMPT_MARGIN = 8;

/**
 * Whether a line of `length` characters, typed with the cursor at its end, sits on one row of a prompt `cols` wide
 * (the narrowest a tile's terminal is taken to be, unknown): Ctrl-U clears only the cursor's wrapped row.
 */
const fitsOneRow = (length: number, cols = NARROWEST_PROMPT_COLUMNS): boolean => length < cols - PROMPT_MARGIN;

/**
 * The draft at a prompt after `key`, given the one before it. With `clearsAll`, Ctrl-U clears any draft, as the user's
 * say over what is there (`draftAfterInput`); else only one the board can count, on one row of a prompt `cols` wide
 * (`CLEAR_LINE`).
 */
function draftAfterKey(draft: Draft | undefined, key: Key, clearsAll = false, cols?: number): Draft | undefined {
  switch (key.kind) {
    case 'report':
      return draft;
    case 'text':
      return grown(draft, 1);
    case 'paste':
      if (key.text === '') return draft;
      // A paste of several lines leaves the cursor on the last of them.
      return /[\r\n]/.test(key.text) ? UNSURE : grown(draft, [...key.text].length);
    case 'sequence':
      // Any other moves the cursor or edits the line: what is left there, the board can't tell.
      return RECALL.test(key.key) || draft !== undefined ? UNSURE : undefined;
    case 'control':
      if (LINE_ENDED.test(key.key)) return undefined;
      if (key.key === CLEAR_LINE) {
        if (draft === undefined || clearsAll) return undefined;
        return draft.length !== undefined && fitsOneRow(draft.length, cols) ? undefined : UNSURE;
      }
      if (key.key === '\x7f' || key.key === '\b') {
        if (draft?.length === undefined) return draft;
        return draft.length > 1 ? { length: draft.length - 1 } : undefined;
      }
      if (PUTS_AT_PROMPT.test(key.key)) return UNSURE;
      return draft === undefined ? undefined : UNSURE;
  }
}

/**
 * The user's draft at the prompt after `data` is written to the terminal, given the one before it: typed or pasted
 * text, or a line recalled from history (Up), starts one; Enter or Ctrl-C ends it, and so do Ctrl-U and deleting each
 * character typed with Backspace, unless the cursor moved, a second line was begun or the line was edited otherwise
 * first, or the line wraps onto a second row of its prompt, `cols` wide. Ctrl-U then leaves a draft: it clears only the
 * cursor's row, up to the cursor.
 */
export const draftAfter = (draft: Draft | undefined, data: string, cols?: number): Draft | undefined =>
  keysOf(data).reduce<Draft | undefined>((before, key) => draftAfterKey(before, key, false, cols), draft);

/**
 * Whether the user has a draft at the prompt after `data` is written to the terminal, given whether they had one
 * before (`draftAfter`, its length unknown): so only Enter, Ctrl-C or Ctrl-U ends one, as the user's own say over
 * what is there.
 */
export const draftAfterInput = (drafting: boolean, data: string): boolean =>
  keysOf(data).reduce<Draft | undefined>((draft, key) => draftAfterKey(draft, key, true), drafting ? UNSURE : undefined) !== undefined;

/** Whether `data` written to a terminal presses a key: anything but the focus and mouse reports a terminal sends of itself. */
export const pressesKeys = (data: string): boolean => keysOf(data).some((key) => key.kind !== 'report');

/** Whether `data` presses Escape: mid-turn, it interrupts the turn. */
export const pressesEscape = (data: string): boolean => keysOf(data).some((key) => key.kind === 'sequence' && /^\x1b\x1b?$/.test(key.key));

/** Whether the last key `data` presses is Enter: a line break a paste ends with is no Enter. */
export function endsInEnter(data: string): boolean {
  const last = keysOf(data)
    .filter((key) => key.kind !== 'report')
    .at(-1);
  return last?.kind === 'control' && last.key === '\r';
}

/**
 * Whether `data` written at the prompt presses Enter on a draft: one the user had before it (`drafting`: whether they
 * had one, or the draft itself), or one it starts before that Enter (`draftAfter`). Ctrl-C clears a draft first, and
 * so does Ctrl-U one the board can count on one row of a prompt `cols` wide.
 */
export function submitsDraft(drafting: boolean | Draft | undefined, data: string, cols?: number): boolean {
  let draft: Draft | undefined = typeof drafting === 'object' ? drafting : drafting === true ? UNSURE : undefined;
  for (const key of keysOf(data)) {
    if (key.kind === 'control' && key.key === '\r' && draft !== undefined) return true;
    draft = draftAfterKey(draft, key, false, cols);
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
