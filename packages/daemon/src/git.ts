import { execFile } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface RunGitOptions {
  /**
   * Runs the repo's hooks, which `runGit` otherwise turns off. Only for a command whose hook the user wants run by the
   * board: a hook can be a file an agent wrote (an in-tree `core.hooksPath`, as husky sets), and the daemon would run it
   * outside the agent's permissions.
   */
  hooks?: true;
}

/** Turns the repo's hooks off for one git command: `git -c core.hooksPath=/dev/null …` finds no hook to run. */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'] as const;

/**
 * Always on: no fsmonitor, a program named in the repo's config that git would run on every `status`, and that an agent
 * could point at a script of its own. The daemon's reads of a worktree's status don't need it.
 */
const NO_FSMONITOR = ['-c', 'core.fsmonitor=false'] as const;

/**
 * Runs `git -C <dir> <args>`. Resolves whether or not git succeeds; rejects only when git itself can't be run. Any
 * GIT_DIR/GIT_WORK_TREE the daemon inherited are ignored: `dir` alone decides the repo. With `timeoutMs`, git is killed
 * after that long, which counts as a failure. Optional locks are off (`GIT_OPTIONAL_LOCKS=0`): a read like `status` never
 * refreshes and writes the index, so it can't hold `index.lock` against the user's own git. `env` adds to its
 * environment: `{ LC_ALL: 'C' }` for a message to be read, which a translated git would otherwise word in its language.
 *
 * Hooks are off (see `RunGitOptions.hooks`), and so is any fsmonitor: the folders the daemon runs git in are agents'
 * worktrees and the repos they share, where a hook, or the program a config names, may be agent-written. Filters still
 * run, so Git LFS still smudges its files at checkout; what its hooks did is either not needed by the daemon (marking
 * locked files read-only) or done explicitly (`pushLfsObjects`).
 */
export function runGit(dir: string, args: string[], timeoutMs?: number, extraEnv: Record<string, string> = {}, options: RunGitOptions = {}): Promise<GitResult> {
  const env = { ...process.env, ...extraEnv };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  env.GIT_OPTIONAL_LOCKS = '0';
  const hooks = options.hooks === true ? [] : NO_HOOKS;
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', dir, ...NO_FSMONITOR, ...hooks, ...args], { env, timeout: timeoutMs }, (error, stdout, stderr) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') reject(new Error('git was not found on PATH'));
      else resolve({ ok: !error, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/**
 * Uploads the Git LFS objects `ref` needs to `remote`, which LFS's pre-push hook would have done for a push with hooks
 * on. Call it before pushing `ref` with `runGit`. Succeeds with nothing done when `ref`'s tree tracks no file with LFS
 * (no `filter=lfs` in any of its `.gitattributes`), or this machine has no `git lfs`; fails, with its message, when the
 * upload does, as a push then would leave the remote with pointers to files it doesn't have.
 */
export async function pushLfsObjects(dir: string, remote: string, ref: string): Promise<GitResult> {
  const nothing = { ok: true, stdout: '', stderr: '' };
  const tracked = await runGit(dir, ['grep', '--quiet', '--fixed-strings', 'filter=lfs', ref, '--', ':(glob)**/.gitattributes']);
  if (!tracked.ok) return nothing;
  const installed = await runGit(dir, ['lfs', 'version']);
  if (!installed.ok) return nothing;
  return runGit(dir, ['lfs', 'push', remote, ref]);
}
