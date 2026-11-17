import { fileURLToPath } from 'node:url';

/** Directory holding the fake `claude` and `codex` executables. */
export const fakeBinDir = fileURLToPath(new URL('../bin', import.meta.url));

export const HARNESS_NAMES = ['claude', 'codex'] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

/** Names the run's tripwire dir (guard.ts), whose `hits.log` fails the run at teardown. */
export const GUARD_DIR_ENV = 'AGENT_BOARD_HARNESS_GUARD_DIR';
/** The tripwire dir's name starts with this, so a child that lost `GUARD_DIR_ENV` can still find it on PATH. */
export const GUARD_DIR_PREFIX = 'agent-board-harness-guard-';
