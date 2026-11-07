/**
 * The gate's green stamps: when a commit last passed the whole of `check:local` on a clean tree. One file per commit,
 * named by its full SHA and holding the time it passed, in a directory shared by every worktree on the machine, so a
 * later step can trust that commit without running the gate again.
 *
 * Each pass is also recorded against the commit's tree, in `trees/` beside the commit stamps: a squash merge makes a new
 * commit with the same tree as the branch that passed, and the code is what the gate checked, not the commit. A tree
 * stamp holds the time and the commit that ran the gate. Both are written together, by the one branch of check-local.sh
 * that has a full, passed run on a clean tree; nothing else writes either (the subset runs of `check:pr` and its recheck, `--quick` and a dirty tree write none).
 */
import { execFileSync } from 'node:child_process';
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

/** The folder of tree stamps inside the stamp dir. */
const TREES = 'trees';

/** Writes `text` to `path` aside and renames it, so a reader never sees half a stamp. */
function writeWhole(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

/**
 * Records that `sha` passed the full gate at `at`, replacing an earlier pass of it, and forgets stamps long past. With
 * `tree` (the tree of `sha`), the pass is recorded against the tree too, so another commit of the same code counts.
 */
export function writeStamp(dir: string, sha: string, at: Date, tree?: string): void {
  if (!FULL_SHA.test(sha)) throw new Error(`"${sha}" is not a full commit SHA.`);
  if (tree !== undefined && !FULL_SHA.test(tree)) throw new Error(`"${tree}" is not a full tree hash.`);
  mkdirSync(join(dir, TREES), { recursive: true });
  writeWhole(join(dir, sha), `${at.toISOString()}\n`);
  if (tree !== undefined) writeWhole(join(dir, TREES, tree), `${at.toISOString()} ${sha}\n`);
  const oldest = at.getTime() - STAMP_KEEP_DAYS * 86_400_000;
  for (const name of readdirSync(dir)) {
    const stamped = readStamp(dir, name);
    if (stamped !== undefined && stamped.getTime() < oldest) rmSync(join(dir, name), { force: true });
  }
  for (const name of readdirSync(join(dir, TREES))) {
    const stamped = readTreeStamp(dir, name);
    if (stamped !== undefined && stamped.at.getTime() < oldest) rmSync(join(dir, TREES, name), { force: true });
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

export interface TreeStamp {
  at: Date;
  /** The commit that ran the gate on this tree. */
  commit: string;
}

/** When a commit with this `tree` last passed the full gate, and which commit it was; undefined if none did. */
export function readTreeStamp(dir: string, tree: string): TreeStamp | undefined {
  if (!FULL_SHA.test(tree)) return undefined;
  let text: string;
  try {
    text = readFileSync(join(dir, TREES, tree), 'utf8');
  } catch {
    return undefined;
  }
  const [time, commit, ...rest] = text.trim().split(' ');
  const at = new Date(time ?? '');
  if (Number.isNaN(at.getTime()) || commit === undefined || !FULL_SHA.test(commit) || rest.length > 0) return undefined;
  return { at, commit };
}

/** How a pass was found: for the commit itself, or for another commit of the same tree. */
export interface Pass {
  at: Date;
  /** `commit`: the commit's own stamp. `tree`: another commit's, of the same code. */
  via: 'commit' | 'tree';
  /** The commit that ran the gate. */
  commit: string;
}

/**
 * The newest full-gate pass that counts for `sha`, whose tree is `tree`: its own stamp, or that of any commit with the
 * same tree (a squash merge of a gated branch, say). Undefined when neither exists.
 */
export function readPass(dir: string, sha: string, tree: string | undefined): Pass | undefined {
  const own = readStamp(dir, sha);
  const shared = tree === undefined ? undefined : readTreeStamp(dir, tree);
  const ownPass: Pass | undefined = own && { at: own, via: 'commit', commit: sha };
  const treePass: Pass | undefined = shared && { at: shared.at, via: 'tree', commit: shared.commit };
  if (ownPass !== undefined && (treePass === undefined || ownPass.at.getTime() >= treePass.at.getTime())) return ownPass;
  return treePass;
}

/** The tree of `sha` in `repo`, or undefined if git cannot say. */
export function treeOf(repo: string, sha: string): string | undefined {
  try {
    const tree = execFileSync('git', ['-C', repo, 'rev-parse', `${sha}^{tree}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return FULL_SHA.test(tree) ? tree : undefined;
  } catch {
    return undefined;
  }
}
