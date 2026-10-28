// Reading Claude Code's screen while an agent's first prompt waits for its session to come up.

import { setTimeout as delay } from 'node:timers/promises';

/**
 * What Claude's folder-trust screen shows, any one of which on screen means it is up: its warning, its rows, and the
 * line under them. Claude 2.1.312 titles it `Quick safety check:` with rows `No, exit` and `Yes, I trust this folder`;
 * older builds asked `Do you trust the files in this folder?` with `Yes, proceed`.
 */
const TRUST_MARKS = ['Quick safety check', 'Is this a project you created or one you trust?', 'Do you trust the files in this folder?'];

/** The trust screen's row that trusts the folder, as each build labels it. */
const TRUST_YES = /^(\d+\.\s+)?Yes, (I trust this folder|proceed)\b/;

/** The trust screen's row that exits Claude: its pointer starts there, so Enter there quits. */
const TRUST_NO = /^(\d+\.\s+)?No, exit\b/;

/** The pointer before the row a menu's Enter picks, or the glyph before what is typed at Claude's prompt. */
const POINTER = /^[>❯›]\s?(.*)$/;

/**
 * What Claude shows as an agent starts: its folder-trust screen, with the row its pointer is on (`on`: `yes` trusts
 * the folder, `no` exits, null when neither row is seen); its prompt, ready for a first message; or something else.
 */
export type StartupScreen = { kind: 'trust'; on: 'yes' | 'no' | null } | { kind: 'prompt' } | { kind: 'other' };

/**
 * Reads the visible `lines` of a starting Claude session's screen, box drawing taken out (`screenLines`). The trust
 * screen, known by its title or its yes row (never `No, exit` alone), is read first: its pointer row (`❯ No, exit`) looks like a prompt. Claude's prompt is a pointer line framed by
 * the rules above and below it, which `screenLines` leaves empty; a menu's pointer row has its other rows beside it.
 */
export function readStartupScreen(lines: readonly string[]): StartupScreen {
  const trimmed = lines.map((line) => line.trim());
  // Its title or its yes row: a `No, exit` row alone may be another of Claude's startup screens.
  const rows = trimmed.map((line) => POINTER.exec(line)?.[1]?.trim() ?? line);
  if (trimmed.some((line) => TRUST_MARKS.some((mark) => line.includes(mark))) || rows.some((row) => TRUST_YES.test(row))) {
    const pointed = trimmed.map((line) => POINTER.exec(line)?.[1]?.trim()).find((row) => row !== undefined && (TRUST_YES.test(row) || TRUST_NO.test(row)));
    return { kind: 'trust', on: pointed === undefined ? null : TRUST_YES.test(pointed) ? 'yes' : 'no' };
  }
  for (let index = trimmed.length - 1; index > 0; index -= 1) {
    if (POINTER.test(trimmed[index]!) && trimmed[index - 1] === '' && trimmed[index + 1] === '') return { kind: 'prompt' };
  }
  return { kind: 'other' };
}

/** The key that moves a menu's pointer down a row. */
const DOWN_KEY = '\x1b[B';

/** How long `answerTrustScreen` waits for the pointer to reach the row that trusts the folder, and how often it looks. */
const POINTER_WAIT_MS = 2_000;
const POINTER_POLL_MS = 100;

/** What `answerTrustScreen` reads a terminal's screen with, and writes keys to it with. */
export interface TrustScreenTerminal {
  /** The terminal's visible lines, box drawing taken out (`screenLines`), or null once it is gone. */
  screen(): Promise<string[] | null>;
  write(data: string): void;
  /** Resolves after `ms`: real time by default. */
  wait?(ms: number): Promise<void>;
}

/**
 * Answers Claude's trust screen on `terminal` with the row that trusts the folder, for whoever decided to: the user's
 * Trust folder, or a setting of theirs. Reads the screen first, and does nothing unless it is the trust screen. With
 * the pointer on `No, exit` it presses Down, then reads the screen again until the pointer is on the yes row, for up
 * to `POINTER_WAIT_MS`. It presses Enter only on a pointer seen on that row, as Enter on any other could exit Claude,
 * and never Escape. Claude records the trust itself. Resolves undefined once Enter is pressed, or why not:
 * `not-trust` when the screen isn't the trust screen, `pointer` when the pointer was not seen on the yes row.
 */
export async function answerTrustScreen(terminal: TrustScreenTerminal): Promise<'not-trust' | 'pointer' | undefined> {
  const wait = terminal.wait ?? ((ms: number) => delay(ms));
  const read = async () => readStartupScreen((await terminal.screen()) ?? []);
  let screen = await read();
  if (screen.kind !== 'trust') return 'not-trust';
  if (screen.on === 'no') {
    terminal.write(DOWN_KEY);
    for (let waited = 0; waited < POINTER_WAIT_MS && screen.kind === 'trust' && screen.on !== 'yes'; waited += POINTER_POLL_MS) {
      await wait(POINTER_POLL_MS);
      screen = await read();
    }
  }
  if (screen.kind !== 'trust' || screen.on !== 'yes') return 'pointer';
  terminal.write('\r');
  return undefined;
}

/** The last `count` lines of `lines` with text on them, as one line, for a flag saying what a terminal waits on. */
export function screenTail(lines: readonly string[], count = 3): string {
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(-count)
    .join(' · ');
}
