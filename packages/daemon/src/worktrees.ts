// Agent worktrees (ADR-0007): one git worktree and branch per agent, outside the repo.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runGit } from './git.ts';

/** `<worktreesDir>/<repo name>-<hash of its path>/<branch>`: repos with the same name never collide. */
export function agentWorktreePath(worktreesDir: string, repoRoot: string, branch: string): string {
  const hash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
  return join(worktreesDir, `${basename(repoRoot)}-${hash}`, branch);
}

/** Longest slug of an agent's name in its branch name (ADR-0007). */
const MAX_SLUG_LENGTH = 40;

/** An agent's name as a slug, at most `MAX_SLUG_LENGTH`: for its branch and its scratch repo's folder. */
export function nameSlug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, MAX_SLUG_LENGTH)
      .replace(/^-+|-+$/g, '') || 'agent'
  );
}

/** A new branch name for an agent called `name`: its name as a slug, plus a random suffix so names can repeat. */
export function agentBranchName(name: string): string {
  return `${nameSlug(name)}-${randomBytes(3).toString('hex')}`;
}

/** Most agents that can share one issue's branch name, with `-2`, `-3`… suffixes. */
const MAX_BRANCH_SUFFIX = 99;

/**
 * `branch`, or the first of `branch-2`, `branch-3`… that the repo has no branch called, for a second agent on the
 * same issue.
 */
export async function freeBranchName(repoRoot: string, branch: string): Promise<string> {
  for (let n = 1; n <= MAX_BRANCH_SUFFIX; n++) {
    const candidate = n === 1 ? branch : `${branch}-${n}`;
    const taken = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
    if (!taken.ok) return candidate;
  }
  throw new Error(`${branch} and ${MAX_BRANCH_SUFFIX - 1} numbered branches after it already exist`);
}

/** `branch`, a name typed for a new agent's branch, trimmed, once git takes it as a branch name; any repo will do. */
export async function checkedBranchName(branch: string): Promise<string> {
  const name = branch.trim();
  const valid = name !== '' && !name.startsWith('-') && (await runGit(tmpdir(), ['check-ref-format', '--branch', name])).ok;
  if (!valid) throw new Error(`${branch} is not a valid branch name`);
  return name;
}

/** `branch`, checked already, if the repo has no branch by that name: a typed name is never given a suffix. */
export async function freeTypedBranch(repoRoot: string, branch: string): Promise<string> {
  const taken = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (taken.ok) throw new Error(`${basename(repoRoot)} already has a branch ${branch}`);
  return branch;
}

/**
 * Creates `branch` at the tip of the repo's branch `base`, or at the commit `base.commit`, (its current HEAD without),
 * checked out in a new worktree at `path`.
 */
export async function addWorktree(repoRoot: string, path: string, branch: string, base?: string | { commit: string }): Promise<void> {
  let start = 'HEAD';
  if (typeof base === 'object') {
    start = base.commit;
  } else if (base !== undefined) {
    const found = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}^{commit}`]);
    if (!found.ok) throw new Error(`${basename(repoRoot)} has no branch ${base}`);
    start = `refs/heads/${base}`;
  }
  mkdirSync(dirname(path), { recursive: true });
  const added = await runGit(repoRoot, ['worktree', 'add', '-b', branch, path, start]);
  if (!added.ok) throw new Error(`could not create a worktree for ${basename(repoRoot)}: ${added.stderr}`);
}

/**
 * Checks out the tip of the repo's branch `branch`, detached, in a new worktree at `path` (a reviewer's): no
 * branch of its own, so it can't push. Resolves to the commit it checked out.
 */
export async function addDetachedWorktree(repoRoot: string, path: string, branch: string): Promise<string> {
  const found = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  if (!found.ok) throw new Error(`${basename(repoRoot)} has no branch ${branch}`);
  mkdirSync(dirname(path), { recursive: true });
  const added = await runGit(repoRoot, ['worktree', 'add', '--detach', path, found.stdout]);
  if (!added.ok) throw new Error(`could not create a worktree for ${basename(repoRoot)}: ${added.stderr}`);
  return found.stdout;
}

/** `path`, or the first of `path-2`, `path-3`… that nothing is at yet. */
export function freeWorktreePath(path: string): string {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? path : `${path}-${n}`;
    if (!existsSync(candidate)) return candidate;
  }
}

/** The branch the repo's main checkout is on: a reviewer's branch when it is given none. Throws on a detached HEAD. */
export async function checkedOutBranch(repoRoot: string): Promise<string> {
  const head = await runGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!head.ok || head.stdout === '') throw new Error(`${basename(repoRoot)} is on a detached HEAD: pick the branch to review`);
  return head.stdout;
}

/**
 * Why removing the worktree and branch would lose work, or undefined if it wouldn't: uncommitted changes (untracked
 * files included) in the worktree, commits on its HEAD that no branch has (a detached HEAD after a rebase, bisect or
 * checkout of a commit), or commits on the branch that no other branch or remote-tracking branch has.
 */
export async function unsavedWork(repoRoot: string, worktree: string, branch: string): Promise<string | undefined> {
  if (existsSync(worktree)) {
    const status = await runGit(worktree, ['status', '--porcelain']);
    if (!status.ok) throw new Error(`could not check ${worktree} for changes: ${status.stderr}`);
    if (status.stdout !== '') return 'its worktree has uncommitted changes';
    const detached = await runGit(worktree, ['rev-list', '--count', 'HEAD', '--not', '--branches', '--remotes']);
    const count = detached.ok ? Number(detached.stdout) : 0;
    if (count > 0) return `its worktree's HEAD has ${commits(count)} that no branch has`;
  }
  // `--exclude` patterns for `--branches` leave out the `refs/heads/` prefix. Branch names here are glob-free slugs.
  const unique = await runGit(repoRoot, [
    'rev-list',
    '--count',
    `refs/heads/${branch}`,
    '--not',
    `--exclude=${branch}`,
    '--branches',
    '--remotes',
  ]);
  // A branch that is already gone has nothing to lose.
  const count = unique.ok ? Number(unique.stdout) : 0;
  return count > 0 ? `its branch ${branch} has ${commits(count)} no other branch has` : undefined;
}

function commits(count: number): string {
  return `${count} commit${count === 1 ? '' : 's'}`;
}

/** Removes the worktree, changes and all, then deletes its branch unless `keepBranch`. Either may already be gone. */
export async function removeWorktree(repoRoot: string, worktree: string, branch: string, keepBranch = false): Promise<void> {
  if (existsSync(worktree)) {
    const removed = await runGit(repoRoot, ['worktree', 'remove', '--force', worktree]);
    if (!removed.ok) throw new Error(`could not remove the worktree ${worktree}: ${removed.stderr}`);
  }
  // Forget a worktree whose folder was deleted by hand, so its branch is free to delete.
  await runGit(repoRoot, ['worktree', 'prune']);
  if (keepBranch) return;
  const exists = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (!exists.ok) return;
  const deleted = await runGit(repoRoot, ['branch', '-D', branch]);
  if (!deleted.ok) throw new Error(`could not delete the branch ${branch}: ${deleted.stderr}`);
}
