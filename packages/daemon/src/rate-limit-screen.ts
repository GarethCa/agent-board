// Reading Claude Code's screen after a turn hit a usage limit, to resume it on usage credits (`agent.continueOnCredits`).

/** What Claude puts at its prompt to resume a rate-limited turn, and submits by itself at the reset. */
export const CONTINUE = 'continue';

/** The title of the menu Claude opens on a rate limit. */
const MENU_TITLE = 'What do you want to do?';

/**
 * The labels of the menu's rows, as each starts: stopping, waiting for the reset, usage credits (or an admin's), and
 * an upgrade. One on screen means the menu is up, its title on screen or not.
 */
const MENU_ROWS = ['Stop and wait for limit to reset', 'Wait here, then continue', 'Switch to usage', 'Add funds to continue', 'Ask your admin for more usage', 'Upgrade your plan', 'Upgrade to'];

/**
 * The option a list's pointer is on (`❯ 1. Stop and wait…`). One without the pointer may be a list in a reply.
 */
const POINTED_OPTION = /^[>❯›]\s*\d+\.\s/;

/** What goes before an option's label: its pointer, its number, or both. */
const OPTION_MARKS = /^[>❯›]?\s*(\d+\.\s+)?/;

/** The prompt glyphs Claude has drawn before what is typed. */
const PROMPT = /^[>❯›]\s?(.*)$/;

/**
 * What Claude shows after a turn hit its limit: its menu (or a list of options like it), which Escape closes; its
 * prompt and what it holds; or neither, with the last line it shows.
 */
export type RateLimitScreen = { kind: 'menu' } | { kind: 'prompt'; holds: string } | { kind: 'unknown'; line: string };

/**
 * Reads the visible `lines` of a rate-limited Claude session's screen, box drawing taken out (`screenLines`), from the
 * bottom up: what Claude shows now is its last menu or prompt, and what is above it (a reply quoting the menu's title,
 * an old message) is history. A line of the menu (its title, a row of it or a numbered option under a pointer) is
 * read as the menu before it is read as a prompt: Enter there would pick whatever row the pointer is on.
 */
export function readRateLimitScreen(lines: string[]): RateLimitScreen {
  const shown = lines.map((line) => line.trim()).filter((line) => line !== '');
  for (let index = shown.length - 1; index >= 0; index -= 1) {
    const line = shown[index]!;
    if (line.includes(MENU_TITLE) || POINTED_OPTION.test(line) || MENU_ROWS.some((row) => line.replace(OPTION_MARKS, '').startsWith(row))) return { kind: 'menu' };
    const prompt = PROMPT.exec(line);
    if (prompt !== null) return { kind: 'prompt', holds: prompt[1]!.trim() };
  }
  return { kind: 'unknown', line: shown.at(-1) ?? '' };
}
