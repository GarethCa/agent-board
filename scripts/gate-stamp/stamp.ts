/**
 * The gate's green stamps: when a commit last passed the whole of `check:local` on a clean tree. One file per commit,
 * named by its full SHA and holding the time it passed, in a directory shared by every worktree on the machine, so a
 * later step can trust that commit without running the gate again.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FULL_SHA = /^[0-9a-f]{40}$/;

/** A stamp older than this is deleted when the next one is written: nothing trusts one that old. */
export const STAMP_KEEP_DAYS = 7;

/** `CHECK_STAMP_DIR`, or `~/.cache/agent-board-gate/stamps`, beside the e2e lock. */
export function stampDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CHECK_STAMP_DIR ?? join(env.HOME ?? homedir(), '.cache', 'agent-board-gate', 'stamps');
}

/** Records that `sha` passed the full gate at `at`, replacing an earlier pass of it, and forgets stamps long past. */
export function writeStamp(dir: string, sha: string, at: Date): void {
  if (!FULL_SHA.test(sha)) throw new Error(`"${sha}" is not a full commit SHA.`);
  mkdirSync(dir, { recursive: true });
  // Written aside and renamed, so a reader never sees half a stamp.
  const temp = join(dir, `.${sha}.${process.pid}`);
  writeFileSync(temp, `${at.toISOString()}\n`);
  renameSync(temp, join(dir, sha));
  const oldest = at.getTime() - STAMP_KEEP_DAYS * 86_400_000;
  for (const name of readdirSync(dir)) {
    const stamped = readStamp(dir, name);
    if (stamped !== undefined && stamped.getTime() < oldest) rmSync(join(dir, name), { force: true });
  }
}

/** When `sha` last passed the full gate, or undefined if it never did. */
export function readStamp(dir: string, sha: string): Date | undefined {
  if (!FULL_SHA.test(sha)) return undefined;
  let text: string;
  try {
    text = readFileSync(join(dir, sha), 'utf8');
  } catch {
    return undefined;
  }
  const at = new Date(text.trim());
  return Number.isNaN(at.getTime()) ? undefined : at;
}
