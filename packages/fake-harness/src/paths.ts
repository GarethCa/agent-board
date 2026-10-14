import { fileURLToPath } from 'node:url';

/** Directory holding the fake `claude` and `codex` executables. */
export const fakeBinDir = fileURLToPath(new URL('../bin', import.meta.url));

export const HARNESS_NAMES = ['claude', 'codex'] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];
