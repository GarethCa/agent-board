/**
 * How long Accept changes waits before it merges, the time Undo has: it acts before the merge, never reverts one. Tests
 * shorten it with `AGENT_BOARD_ACCEPT_AFTER_MS`.
 */
export const ACCEPT_AFTER_MS = 10_000;
