/**
 * Claude Code's rate-limit screens, written by hand from the menu component in Claude Code 2.1.309 (its
 * `rate-limit-options` command, which it opens by itself once a turn hits a usage limit). Nothing here was recorded
 * from a real session: the labels, their order and what each does are read from that build's bundled JavaScript.
 *
 * - The menu is titled `What do you want to do?`. Its rows are `Stop and wait for limit to reset` (`Stop` on a
 *   usage-billed plan), then, when Claude can wait for the reset by itself, `Wait here, then continue automatically at
 *   <time>`, then the usage-credits row (`Switch to usage credits`, or `Add funds to continue with usage credits` once
 *   credits are on, or `Ask your admin for more usage` in a team), then `Upgrade your plan`. Behind a feature flag the
 *   usage-credits and upgrade rows come first instead, so a row is found by its label, never by where it is.
 * - The usage-credits row opens the billing page in a browser (and may start a new login); it never resumes the turn.
 *   Escape (the menu's cancel) closes it and leaves the prompt, where `continue` resumes the turn, putting `continue`
 *   there while Claude's own continue at the reset is armed. `Stop and wait for limit to reset` closes it too, but
 *   may cancel that continue at the reset.
 * - With its `autoContinueAtUsageLimit` setting on (the default), Claude opens no menu: it puts `continue` at the
 *   prompt itself and submits it at the reset, and Enter submits it now.
 */

/** The menu's title. */
export const RATE_LIMIT_MENU_TITLE = 'What do you want to do?';

/** The row that closes the menu, leaving the turn to be resumed at the prompt. */
export const RATE_LIMIT_STOP_ROW = 'Stop and wait for limit to reset';

/** The row that opens the billing page to turn usage credits on. */
export const RATE_LIMIT_CREDITS_ROW = 'Switch to usage credits';

/** The row that opens the upgrade page. */
export const RATE_LIMIT_UPGRADE_ROW = 'Upgrade your plan';

/** What Claude puts at the prompt to resume a rate-limited turn, and submits by itself at the reset. */
export const RATE_LIMIT_CONTINUE = 'continue';

/** The menu's rows: the stop row first, as Claude orders them by default, or the usage-credits row first. */
export function rateLimitMenuRows(order: 'stop-first' | 'credits-first' = 'stop-first'): string[] {
  return order === 'stop-first'
    ? [RATE_LIMIT_STOP_ROW, RATE_LIMIT_CREDITS_ROW, RATE_LIMIT_UPGRADE_ROW]
    : [RATE_LIMIT_CREDITS_ROW, RATE_LIMIT_UPGRADE_ROW, RATE_LIMIT_STOP_ROW];
}

/**
 * The menu as Claude draws it, a line each: in a rounded box, its title, then its numbered rows with `❯` at the one
 * picked (the first, as it opens), then its key hints.
 */
export function drawRateLimitMenu(rows: string[], pointer = 0): string[] {
  const inner = [RATE_LIMIT_MENU_TITLE, '', ...rows.map((row, index) => `${index === pointer ? '❯' : ' '} ${index + 1}. ${row}`), '', 'Enter to confirm · Esc to cancel'];
  const width = Math.max(...inner.map((line) => line.length)) + 2;
  return [`╭${'─'.repeat(width)}╮`, ...inner.map((line) => `│ ${line.padEnd(width - 2)} │`), `╰${'─'.repeat(width)}╯`];
}
