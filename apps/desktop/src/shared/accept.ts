/**
 * How long Accept changes waits before it merges, the time Undo has: it acts before the merge, never reverts one. Tests
 * shorten it with `AGENT_BOARD_ACCEPT_AFTER_MS`, which main reads (a packaged app only with `AGENT_BOARD_TEST=1`) and
 * hands the window as a command-line argument (`acceptAfterArgs`), so the window's own environment never sets it.
 */
export const ACCEPT_AFTER_MS = 10_000;

const ACCEPT_AFTER_FLAG = '--agent-board-accept-after-ms=';

/** The window argument that shortens the wait to `ms`, or none when `ms` isn't a positive number. */
export function acceptAfterArgs(ms: string | undefined): string[] {
  const value = Number(ms);
  return value > 0 ? [`${ACCEPT_AFTER_FLAG}${value}`] : [];
}

/** The wait a window's command line (`acceptAfterArgs`) asks for, or the full `ACCEPT_AFTER_MS`. */
export function acceptAfterFrom(argv: readonly string[]): number {
  const arg = argv.find((each) => each.startsWith(ACCEPT_AFTER_FLAG));
  return Number(arg?.slice(ACCEPT_AFTER_FLAG.length)) || ACCEPT_AFTER_MS;
}
