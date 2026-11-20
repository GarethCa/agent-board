import { execFile } from 'node:child_process';
import { join } from 'node:path';

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
 *
 * Also fails, uploading nothing, when a `.lfsconfig` Git LFS could read sets a key that could choose where to upload
 * (see `REFUSED_LFSCONFIG_KEY`): that file is part of the branch, so an agent could point the daemon's upload, and the
 * credentials git would offer for it, at a server of its choosing. Refused rather than pinned to origin's endpoint, as
 * pinning would mean redoing Git LFS's own working-out of that endpoint (ssh, aliases, the repo's own settings). The
 * check runs before `git lfs push`, which reads the files again: an agent still running in `dir` could write one in
 * between, a small window this doesn't close.
 */
export async function pushLfsObjects(dir: string, remote: string, ref: string): Promise<GitResult> {
  const nothing = { ok: true, stdout: '', stderr: '' };
  const tracked = await runGit(dir, ['grep', '--quiet', '--fixed-strings', 'filter=lfs', ref, '--', ':(glob)**/.gitattributes']);
  if (!tracked.ok) return nothing;
  const installed = await runGit(dir, ['lfs', 'version']);
  if (!installed.ok) return nothing;
  const refusedKeys = await refusedLfsConfigKeys(dir, ref);
  if (refusedKeys.length > 0) {
    const stderr = `.lfsconfig sets ${refusedKeys.join(', ')}, which can choose the server Git LFS uploads to; the board won't upload with it. Remove those keys, or push this branch yourself.`;
    return { ok: false, stdout: '', stderr };
  }
  return runGit(dir, ['lfs', 'push', remote, ref]);
}

/**
 * The `.lfsconfig` keys `pushLfsObjects` refuses. Current Git LFS takes three endpoint keys from that file: `lfs.url`,
 * `lfs.pushurl` and `remote.<name>.lfsurl`. It ignores `remote.<name>.lfspushurl` and `url.<base>.(push)insteadOf`
 * there, which are refused anyway, for an older Git LFS that read every key. Git LFS reads the file with `--includes`,
 * so `include.path` and `includeIf.<condition>.path` are refused too: the file they name can set any of the others.
 * Names come back from `git config` with the section and key lowercased and the subsection as written.
 */
const REFUSED_LFSCONFIG_KEY = /^(lfs\.(push)?url|remote\..+\.lfs(push)?url|url\..+\.(push)?insteadof|include\.path|includeif\..+\.path)$/i;

/**
 * The refused keys (`REFUSED_LFSCONFIG_KEY`) set in any `.lfsconfig` Git LFS might read for a push of `ref` from `dir`:
 * the worktree's file, which it reads first, then the index's, `HEAD`'s and `ref`'s. Includes aren't followed, as any
 * include is refused, and a read that fails still counts the keys git listed before it stopped (a malformed file lists
 * the entries above its bad line).
 */
async function refusedLfsConfigKeys(dir: string, ref: string): Promise<string[]> {
  const top = await runGit(dir, ['rev-parse', '--show-toplevel']);
  const sources = [
    ...(top.ok ? [['--file', join(top.stdout, '.lfsconfig')]] : []),
    ['--blob', ':.lfsconfig'],
    ['--blob', 'HEAD:.lfsconfig'],
    ['--blob', `${ref}:.lfsconfig`],
  ];
  const keys = new Set<string>();
  for (const source of sources) {
    const listed = await runGit(dir, ['config', '--no-includes', ...source, '--list', '--name-only']);
    for (const key of listed.stdout.split('\n')) if (REFUSED_LFSCONFIG_KEY.test(key)) keys.add(key);
  }
  return [...keys];
}
