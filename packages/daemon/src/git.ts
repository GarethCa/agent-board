import { execFile } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Runs `git -C <dir> <args>`. Resolves whether or not git succeeds; rejects only when git itself can't be run. Any
 * GIT_DIR/GIT_WORK_TREE the daemon inherited are ignored: `dir` alone decides the repo. With `timeoutMs`, git is killed
 * after that long, which counts as a failure. Optional locks are off (`GIT_OPTIONAL_LOCKS=0`): a read like `status` never
 * refreshes and writes the index, so it can't hold `index.lock` against the user's own git. `env` adds to its
 * environment: `{ LC_ALL: 'C' }` for a message to be read, which a translated git would otherwise word in its language.
 */
export function runGit(dir: string, args: string[], timeoutMs?: number, extraEnv: Record<string, string> = {}): Promise<GitResult> {
  const env = { ...process.env, ...extraEnv };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  env.GIT_OPTIONAL_LOCKS = '0';
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', dir, ...args], { env, timeout: timeoutMs }, (error, stdout, stderr) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') reject(new Error('git was not found on PATH'));
      else resolve({ ok: !error, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
