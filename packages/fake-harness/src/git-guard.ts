import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The variables that point git at a repository, set when a run starts inside a git hook, a merge or a worktree command.
 * Left in a test's environment they make `git -C <tmp> init --bare` (no path) re-initialise the dev repo as bare
 * (`core.bare = true`, which breaks every worktree) and `git init` write `core.worktree` into its config.
 */
export const REPO_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
] as const;

/** The repo-locating variables set in `env`. */
export function leakedGitVars(env: NodeJS.ProcessEnv): string[] {
  return REPO_GIT_VARS.filter((name) => env[name] !== undefined);
}

/** Removes the repo-locating variables from `env` (the process's own by default), so git in a test finds only the repo it is told to. */
export function scrubGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  for (const name of REPO_GIT_VARS) delete env[name];
  return env;
}

/** The repo's shared config path (the main checkout's, from a worktree), or undefined outside a repo. */
function sharedConfig(cwd: string): string | undefined {
  const env = scrubGitEnv({ ...process.env });
  try {
    const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const config = join(resolve(cwd, common), 'config');
    return existsSync(config) ? config : undefined;
  } catch {
    return undefined;
  }
}

/** The `core.*` entries of the dev repo's shared config: where a leaked GIT_DIR shows (`core.bare`, `core.worktree`). */
export function coreConfigOf(cwd: string): string | undefined {
  const config = sharedConfig(cwd);
  if (!config) return undefined;
  const env = scrubGitEnv({ ...process.env });
  try {
    return execFileSync('git', ['config', '--file', config, '--get-regexp', '^core\\.'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/**
 * Throws if the dev repo's `core.*` config now differs from `before`, naming the change. Other config (a worker's
 * `push -u` writes branch entries) is not compared, so concurrent gates do not trip it.
 */
export function assertCoreConfigUnchanged(cwd: string, before: string | undefined): void {
  const after = coreConfigOf(cwd);
  if (before !== after) {
    throw new Error(`agent-board git guard: the dev repo's core git config changed during the run (a test leaked GIT_DIR or GIT_WORK_TREE?)\nbefore:\n${before ?? '(none)'}\nafter:\n${after ?? '(none)'}`);
  }
}

/**
 * Vitest/Playwright globalSetup body: strips the repo-locating variables from the run's environment (workers inherit
 * them clean), snapshots the dev repo's `core.*` config, and fails the run at teardown if it changed.
 */
export function gitGuardGlobalSetup(cwd: string = process.cwd()): () => void {
  scrubGitEnv();
  const before = coreConfigOf(cwd);
  return () => assertCoreConfigUnchanged(cwd, before);
}
