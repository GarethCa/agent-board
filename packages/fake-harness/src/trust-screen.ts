/**
 * Claude Code's folder-trust screen, recorded from Claude Code 2.1.312 started with no prompt in a folder it had never
 * opened. It shows before the session starts, so no `SessionStart` fires while it is up. Its pointer starts on
 * `No, exit`; Down moves it to `Yes, I trust this folder` (a row's number does not pick it), and Enter picks the row
 * the pointer is on: `No, exit` quits, the other goes on to the prompt and trusts the folder from then on.
 */

/** The row that quits Claude, where the pointer starts. */
export const TRUST_NO_ROW = 'No, exit';

/** The row that trusts the folder and goes on to the prompt. */
export const TRUST_YES_ROW = 'Yes, I trust this folder';

/** The trust screen for `folder`, as Claude draws it, its pointer on `on`. */
export function drawTrustScreen(folder: string, on: 'no' | 'yes' = 'no'): string[] {
  return [
    '─'.repeat(80),
    ' Accessing workspace:',
    '',
    ` ${folder}`,
    '',
    ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
    " project, or work from your team). If not, take a moment to review what's in this folder first.",
    '',
    " Claude Code'll be able to read, edit, and execute files here.",
    '',
    ' Security guide',
    '',
    ` ${on === 'no' ? '❯' : ' '} ${TRUST_NO_ROW}`,
    ` ${on === 'yes' ? '❯' : ' '} ${TRUST_YES_ROW}`,
    '',
    ' Enter to confirm · Esc to cancel',
  ];
}

/** Claude's empty prompt, framed by the rules above and below it, as it draws it ready for a first message. */
export function drawPromptBox(): string[] {
  return ['─'.repeat(80), '❯ ', '─'.repeat(80), '  ? for shortcuts'];
}

/**
 * The line Claude 2.1.312 draws over its prompt box through a turn: a spinner glyph (`✻`, one of `·✢✳✶✻✽`, still under
 * reduced motion) and its verb, then the time and tokens. The footer's `esc to interrupt` is left off, as a narrow
 * terminal truncates it, a rebound key renames it and team mode replaces it.
 */
export const SPINNER_LINE = '✻ Cogitating… (5m 12s · ↓ 1.2k tokens)';
