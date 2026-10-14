import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { TrackerError } from './tracker.ts';

export interface GhOptions {
  /** The `gh` executable: `gh` on PATH by default. */
  gh?: string;
  /** Its environment: this process's by default. */
  env?: NodeJS.ProcessEnv;
}

/** How long one `gh` call may take. */
const GH_TIMEOUT_MS = 30_000;

/** A `gh` call that failed, with what `gh` said. */
export class GhError extends TrackerError {
  readonly stderr: string;

  constructor(kind: TrackerError['kind'], message: string, stderr: string) {
    super(kind, message);
    this.stderr = stderr;
  }
}

/**
 * Runs the GitHub CLI with the user's own login, so agent-board keeps no GitHub token. Resolves with its stdout;
 * rejects with a `GhError`: `unauthorized` when gh is not logged in or its token is refused, `unavailable` when gh is
 * missing or GitHub can't be reached, `rejected` otherwise.
 */
export function runGh(args: string[], options: GhOptions & { cwd?: string; input?: string } = {}): Promise<string> {
  const command = options.gh ?? 'gh';
  // A missing directory fails the spawn with the same ENOENT as a missing gh.
  if (options.cwd !== undefined && !existsSync(options.cwd)) {
    return Promise.reject(new GhError('rejected', `${options.cwd} does not exist`, ''));
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd: options.cwd, env: options.env, timeout: GH_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) return resolve(stdout);
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        if (failure.code === 'ENOENT') {
          return reject(
            new GhError(
              'unavailable',
              'the GitHub CLI (gh) was not found: install it from https://cli.github.com and run `gh auth login`',
              '',
            ),
          );
        }
        if (failure.killed) return reject(new GhError('unavailable', 'gh did not answer in time', stderr));
        reject(ghFailure(child.exitCode, stderr.trim()));
      },
    );
    // gh may exit without reading its input (bad arguments, the test guard). Writing then fails with EPIPE, which would
    // otherwise be thrown as an unhandled error; the exit status above already says what happened.
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input ?? '');
  });
}

export function ghFailure(code: number | null, stderr: string): GhError {
  // Exit code 4: "authentication required".
  if (code === 4) return new GhError('unauthorized', 'gh is not logged in to GitHub: run `gh auth login`', stderr);
  if (/HTTP 401|Bad credentials/i.test(stderr)) {
    return new GhError('unauthorized', `GitHub refused gh's token: run \`gh auth login\` (${stderr})`, stderr);
  }
  if (/error connecting to|could not resolve host|dial tcp|i\/o timeout|connection refused|HTTP 5\d\d/i.test(stderr)) {
    return new GhError('unavailable', `could not reach GitHub: ${stderr}`, stderr);
  }
  return new GhError('rejected', `GitHub: ${stderr || `gh exited with code ${code}`}`, stderr);
}
