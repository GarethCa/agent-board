/**
 * A guard on the user's live launchers, `~/.agent-board/bin/agent-board` and `agent-board-hook`, and the
 * `~/.agent-board/external-hook.json` the hook launcher reads: every agent's `agent-board` command and every harness
 * hook runs through them. Only the installed app may write them; a test that points one
 * at this checkout's build (or a temp folder) breaks the live board once that build is gone. Snapshot them before a run
 * and fail it after if one now names this checkout or a temp folder. The installed app rewriting its own launchers
 * meanwhile is not a leak, so a change that names neither is let through.
 */
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This checkout's root: a shim a test leaked runs its build from under here. */
const CHECKOUT = fileURLToPath(new URL('../../../', import.meta.url));

/** The live files, relative to `~/.agent-board`. */
const LAUNCHERS = [join('bin', 'agent-board'), join('bin', 'agent-board-hook'), 'external-hook.json'];

type Snapshot = Map<string, string | undefined>;

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The live files' text in `home`'s `.agent-board`, by path; undefined for one that isn't there. */
export function snapshotLaunchers(home: string = homedir()): Snapshot {
  return new Map(LAUNCHERS.map((name) => [join(home, '.agent-board', name), read(join(home, '.agent-board', name))]));
}

/** `root` as a launcher may spell it: as it is, inside single quotes (`'` written `'\''`), or in JSON. */
function spellings(root: string): string[] {
  return [root, root.replaceAll("'", "'\\''"), JSON.stringify(root).slice(1, -1)];
}

/**
 * Throws if a launcher in `before` changed and now names one of `forbidden` (this checkout, the temp folder), naming
 * the launcher and what it now runs.
 */
export function assertLaunchersUntouched(before: Snapshot, forbidden: readonly string[]): void {
  for (const [path, was] of before) {
    const now = read(path);
    if (now === undefined || now === was) continue;
    const named = forbidden.find((root) => spellings(root).some((spelled) => now.includes(spelled)));
    if (named !== undefined) {
      throw new Error(`agent-board shim guard: a test rewrote the live launcher ${path} to run something under ${named}; only the installed app may write it\n${now}`);
    }
  }
}

/** Vitest/Playwright globalSetup body: snapshots the live launchers and fails the run at teardown if a test leaked into them. */
export function shimGuardGlobalSetup(checkout: string = CHECKOUT, home: string = homedir()): () => void {
  const before = snapshotLaunchers(home);
  return () => assertLaunchersUntouched(before, [checkout, tmpdir()]);
}
