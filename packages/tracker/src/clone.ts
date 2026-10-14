import { execFile, spawn } from 'node:child_process';
import { ghFailure, GhError, type GhOptions } from './gh.ts';

/** Where a clone is: git's phase (`Receiving objects`) and how far through it, or null when git gives no figure. */
export interface CloneProgress {
  phase: string;
  percent: number | null;
}

export interface CloneOptions extends GhOptions {
  /** Called with each progress line git prints. */
  onProgress?(progress: CloneProgress): void;
  /** Aborting it stops the clone: the promise rejects with an `AbortError`. What was cloned so far is left. */
  signal?: AbortSignal;
}

/** How much of gh's and git's error output a failure keeps. */
const MAX_STDERR = 8 * 1024;

/**
 * Clones the GitHub repo `owner/repo` into `dir` with `gh repo clone`, so the user's own gh login and git protocol
 * are used. Rejects with a `GhError` when the clone fails, and with an `AbortError` when `signal` aborts. It has no
 * timeout: a big repo may take long, and the user can cancel it.
 */
export function cloneRepo(repo: string, dir: string, options: CloneOptions = {}): Promise<void> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    // In its own process group, so cancelling stops git and the helpers it runs too, not only gh. No console window
    // flashes up for it on Windows.
    const child = spawn(options.gh ?? 'gh', ['repo', 'clone', repo, dir, '--', '--progress'], {
      env: options.env,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
      windowsHide: true,
    });
    let stderr = '';
    let pending = '';
    const onAbort = () => killTree(child.pid, () => child.kill('SIGKILL'));
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR);
      // git redraws a progress line with \r, and ends it with \n.
      const lines = (pending + chunk).split(/[\r\n]/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const progress = parseCloneProgress(line);
        if (progress !== undefined) options.onProgress?.(progress);
      }
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      signal?.removeEventListener('abort', onAbort);
      reject(
        error.code === 'ENOENT'
          ? new GhError('unavailable', 'the GitHub CLI (gh) was not found: install it from https://cli.github.com', '')
          : error,
      );
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(abortError());
      else if (code === 0) resolve();
      else reject(ghFailure(code, cloneErrors(stderr)));
    });
  });
}

/** Kills a process and everything it started: its process group, or on Windows its process tree. */
function killTree(pid: number | undefined, fallback: () => void): void {
  if (pid === undefined) return fallback();
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, (error) => error && fallback());
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    fallback();
  }
}

const PROGRESS = /^(?:remote: )?([A-Z][\w ]*?):\s+(\d{1,3})%/;
const CLONING = /^Cloning into /;

/** One line of git's clone output as progress, or undefined for a line that is none. */
export function parseCloneProgress(line: string): CloneProgress | undefined {
  const text = line.trim();
  const match = PROGRESS.exec(text);
  if (match !== null) return { phase: match[1]!, percent: Math.min(100, Number(match[2])) };
  if (CLONING.test(text)) return { phase: 'Cloning', percent: null };
  return undefined;
}

/** The error lines of a clone's output, without its progress. */
function cloneErrors(stderr: string): string {
  return stderr
    .split(/[\r\n]/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && parseCloneProgress(line) === undefined)
    .join('\n');
}

function abortError(): Error {
  return new DOMException('the clone was cancelled', 'AbortError');
}
