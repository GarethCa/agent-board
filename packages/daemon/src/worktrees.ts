// Agent worktrees (ADR-0007): one git worktree and branch per agent, outside the repo.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
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

/** Whether the repo has a commit yet: one just made with `git init` has none, its HEAD naming a branch to come. */
async function hasCommit(repoRoot: string): Promise<boolean> {
  return (await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).ok;
}

/**
 * Why there is nothing to start from at the repo's branch `branch`, which has no commit: the repo has none yet, the
 * branch is one checked out with none yet (an agent's in a repo that had none), or there is no such branch.
 */
export async function noBranchWhy(repoRoot: string, branch: string): Promise<string> {
  if (!(await hasCommit(repoRoot))) return `${basename(repoRoot)} has no commits yet: there is nothing to start from until it has a first commit`;
  const listed = await runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  if (listed.ok && listed.stdout.split('\n').includes(`branch refs/heads/${branch}`)) {
    return `${branch} has no commits yet: there is nothing to start from until it has one`;
  }
  return `${basename(repoRoot)} has no branch ${branch}`;
}

/** The first git that can add a worktree on a branch with no commits (`git worktree add --orphan`). */
const ORPHAN_WORKTREE_GIT = [2, 42];

/** Whether the git on PATH can add a worktree on a branch with no commits, by its version. */
async function canAddOrphanWorktree(dir: string): Promise<boolean> {
  // `git version 2.50.1 (Apple Git-155)`, `git version 2.42.0.windows.1`.
  const version = /(\d+)\.(\d+)/.exec((await runGit(dir, ['--version'])).stdout);
  if (version === null) return false;
  const [major, minor] = [Number(version[1]), Number(version[2])];
  return major > ORPHAN_WORKTREE_GIT[0]! || (major === ORPHAN_WORKTREE_GIT[0] && minor >= ORPHAN_WORKTREE_GIT[1]!);
}

/**
 * Creates `branch` at the tip of the repo's branch `base`, or at the commit `base.commit`, (its current HEAD without),
 * checked out in a new worktree at `path`. In a repo with no commits yet, given no base, the new branch has none either
 * (`--orphan`): nothing is committed for it. Resolves false, having made nothing, when git is too old for that (before
 * 2.42), so the caller can do without a worktree.
 */
export async function addWorktree(repoRoot: string, path: string, branch: string, base?: string | { commit: string }): Promise<boolean> {
  let start = 'HEAD';
  if (typeof base === 'object') {
    start = base.commit;
  } else if (base !== undefined) {
    const found = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}^{commit}`]);
    if (!found.ok) throw new Error(await noBranchWhy(repoRoot, base));
    start = `refs/heads/${base}`;
  } else if (!(await hasCommit(repoRoot))) {
    if (!(await canAddOrphanWorktree(repoRoot))) return false;
    mkdirSync(dirname(path), { recursive: true });
    const orphan = await runGit(repoRoot, ['worktree', 'add', '--orphan', '-b', branch, path]);
    if (!orphan.ok) throw new Error(`could not create a worktree for ${basename(repoRoot)}: ${orphan.stderr}`);
    return true;
  }
  mkdirSync(dirname(path), { recursive: true });
  const added = await runGit(repoRoot, ['worktree', 'add', '-b', branch, path, start]);
  if (!added.ok) throw new Error(`could not create a worktree for ${basename(repoRoot)}: ${added.stderr}`);
  return true;
}

/**
 * Checks out the tip of the repo's branch `branch`, detached, in a new worktree at `path` (a reviewer's): no
 * branch of its own, so it can't push. Resolves to the commit it checked out.
 */
export async function addDetachedWorktree(repoRoot: string, path: string, branch: string): Promise<string> {
  const found = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  if (!found.ok) throw new Error(await noBranchWhy(repoRoot, branch));
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
 * The repo's default branch: what `origin/HEAD` points at. Without it, `main` or `master` when exactly one exists and the
 * repo has no remote branches (a local-only repo): with remote branches, a stale local `main` could be the wrong guess.
 * Otherwise null. Only reads.
 */
export async function defaultBranchOf(repoRoot: string): Promise<string | null> {
  const remote = await runGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remote.ok && remote.stdout.startsWith('origin/')) return remote.stdout.slice('origin/'.length);
  const remotes = await runGit(repoRoot, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes']);
  if (!remotes.ok || remotes.stdout !== '') return null;
  const found: string[] = [];
  for (const name of ['main', 'master']) {
    if ((await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])).ok) found.push(name);
  }
  return found.length === 1 ? found[0]! : null;
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

/** Whether `path` is the folder of a worktree git lists for the repo; throws if git can't say. */
async function isRegistered(repoRoot: string, path: string): Promise<boolean> {
  const listed = await runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) throw new Error(`could not list the worktrees of ${repoRoot}: ${listed.stderr}`);
  // `realpath`: git lists the resolved path, and a temp or home folder may be a symlink.
  const target = existsSync(path) ? realpathSync(path) : path;
  return listed.stdout.split('\n').some((line) => line.startsWith('worktree ') && line.slice('worktree '.length) === target);
}

/** Whether `worktree` lies below the `<repo name>-<hash>` folder that `agentWorktreePath` puts a repo's worktrees in. */
function isAgentWorktreePath(repoRoot: string, worktree: string): boolean {
  const hash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
  const folder = `${basename(repoRoot)}-${hash}`;
  const parts = resolve(worktree).split(sep);
  // A branch name can hold `/`, so the folder is any ancestor, never the path itself.
  return parts.slice(0, -1).includes(folder);
}

/** Waits between the attempts to delete a worktree's folder that git has already let go of: a process may still write to it. */
const REMOVE_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

/**
 * Removes the worktree, changes and all, then deletes its branch unless `keepBranch`. Either may already be gone.
 *
 * Git deregisters a worktree before it deletes its files, so when a process writes into the folder meanwhile, `git
 * worktree remove` fails with "Directory not empty" and leaves a folder git no longer knows. That folder alone is then
 * deleted, trying again after each of `retryDelaysMs`, but only when git positively lists it as not a worktree and it is
 * below this repo's worktrees folder. Any other git failure throws and deletes nothing.
 */
export async function removeWorktree(
  repoRoot: string,
  worktree: string,
  branch: string,
  keepBranch = false,
  { retryDelaysMs = REMOVE_RETRY_DELAYS_MS, onFolderRetry }: { retryDelaysMs?: readonly number[]; onFolderRetry?: (error: Error) => void } = {},
): Promise<void> {
  // The repo's own checkout is never a worktree to remove: nothing here may touch it.
  if (resolve(worktree) === resolve(repoRoot)) throw new Error(`${worktree} is the repo's own checkout, not a worktree: it is left as it is`);
  if (existsSync(worktree)) {
    const removed = await runGit(repoRoot, ['worktree', 'remove', '--force', worktree]);
    if (!removed.ok) {
      const failure = (reason: string) => new Error(`could not remove the worktree ${worktree}: ${reason}`);
      if (await isRegistered(repoRoot, worktree)) throw failure(removed.stderr);
      if (!isAgentWorktreePath(repoRoot, worktree)) throw failure(`${removed.stderr} (and it is not in this repo's worktrees folder)`);
      for (let attempt = 0; ; attempt++) {
        try {
          await rm(worktree, { recursive: true, force: true });
          break;
        } catch (error) {
          const delay = retryDelaysMs[attempt];
          if (delay === undefined) throw failure((error as Error).message);
          onFolderRetry?.(error as Error);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }
  // Forget a worktree whose folder was deleted by hand, so its branch is free to delete.
  await runGit(repoRoot, ['worktree', 'prune']);
  if (keepBranch) return;
  const exists = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (!exists.ok) return;
  const deleted = await runGit(repoRoot, ['branch', '-D', branch]);
  if (!deleted.ok) throw new Error(`could not delete the branch ${branch}: ${deleted.stderr}`);
}
