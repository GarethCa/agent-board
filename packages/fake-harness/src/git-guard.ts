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

/**
 * How long the run's start and end wait on git: they run in the main process, outside the workers, so the guard's
 * bound on sync launches (`boundSync`) does not cover them.
 */
const GIT_TIMEOUT_MS = 10_000;

/** A snapshot of the dev repo's `core.*` config: its entries, undefined outside a repo, or why git could not read it. */
export type CoreConfig = string | undefined | { unreadable: string };

/** Git ran out of time: the config is unknown, not absent. */
const timedOut = (error: unknown): boolean => (error as { code?: string }).code === 'ETIMEDOUT';

/** The repo's shared config path (the main checkout's, from a worktree), or undefined outside a repo. */
function sharedConfig(cwd: string, timeoutMs: number): string | undefined {
  const env = scrubGitEnv({ ...process.env });
  const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs }).trim();
  const config = join(resolve(cwd, common), 'config');
  return existsSync(config) ? config : undefined;
}

/** The `core.*` entries of the dev repo's shared config: where a leaked GIT_DIR shows (`core.bare`, `core.worktree`). */
export function coreConfigOf(cwd: string, timeoutMs: number = GIT_TIMEOUT_MS): CoreConfig {
  let config: string | undefined;
  try {
    config = sharedConfig(cwd, timeoutMs);
  } catch (error) {
    if (timedOut(error)) return { unreadable: `git rev-parse: ETIMEDOUT after ${timeoutMs} ms` };
    return undefined;
  }
  if (!config) return undefined;
  const env = scrubGitEnv({ ...process.env });
  try {
    return execFileSync('git', ['config', '--file', config, '--get-regexp', '^core\\.'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs });
  } catch (error) {
    if (timedOut(error)) return { unreadable: `git config: ETIMEDOUT after ${timeoutMs} ms` };
    return '';
  }
}

/**
 * Throws if the dev repo's `core.*` config now differs from `before`, naming the change. Other config (a worker's
 * `push -u` writes branch entries) is not compared, so concurrent gates do not trip it. When either snapshot could not
 * be read, it warns and skips the check rather than report a leak that may not have happened.
 */
export function assertCoreConfigUnchanged(cwd: string, before: CoreConfig, timeoutMs: number = GIT_TIMEOUT_MS): void {
  const after = coreConfigOf(cwd, timeoutMs);
  const unreadable = [before, after].find((snapshot) => typeof snapshot === 'object');
  if (unreadable !== undefined) {
    console.warn(`agent-board git guard: could not read the dev repo's core git config (${unreadable.unreadable}), so its check is skipped this run`);
    return;
  }
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
