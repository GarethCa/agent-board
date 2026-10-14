import { execFile } from 'node:child_process';
import { basename, delimiter } from 'node:path';

/** Login shells whose `-c` script syntax the daemon knows. */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/** How long a profile gets to run before the daemon keeps its own PATH. */
const DEFAULT_TIMEOUT_MS = 3_000;

/** Marks the PATH in the shell's output, so whatever the profile prints is left out. */
const MARKER = '__AGENT_BOARD_PATH__';

/**
 * The script syntax of the login shell sessions run in, or undefined when sessions use no login shell (no `-l`), or
 * one whose syntax is unknown (nu, xonsh, tcsh…).
 */
export function loginShellKind(shell: string, shellArgs: string[]): 'posix' | 'fish' | undefined {
  if (!shellArgs.includes('-l')) return undefined;
  const name = basename(shell);
  if (POSIX_SHELLS.has(name)) return 'posix';
  return name === 'fish' ? 'fish' : undefined;
}

/**
 * The PATH the user's login shell sets up, profile and all: a daemon started from an app opened in the Dock or
 * Finder has launchd's bare `/usr/bin:/bin:/usr/sbin:/sbin`, and the CLIs it runs (git, gh, claude, codex) usually
 * live on the profile's PATH. Undefined when sessions use no login shell of a known kind, or the shell fails or takes
 * longer than `timeoutMs`.
 */
export function loginShellPath(
  shell: string,
  shellArgs: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const kind = loginShellKind(shell, shellArgs);
  if (kind === undefined) return Promise.resolve(undefined);
  const path = kind === 'fish' ? '(string join : $PATH)' : '"$PATH"';
  const script = `printf '\\n${MARKER}%s\\n' ${path}`;
  return new Promise((resolve) => {
    const child = execFile(
      shell,
      [...shellArgs, '-c', script],
      { env: options.env, timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, killSignal: 'SIGKILL' },
      (error, stdout) => {
        const line = stdout.split('\n').findLast((l) => l.startsWith(MARKER));
        resolve(error === null && line !== undefined && line.length > MARKER.length ? line.slice(MARKER.length) : undefined);
      },
    );
    // A profile that reads its input gets none, rather than waiting for it.
    child.stdin?.end();
  });
}

/** `login`'s dirs first, then the dirs of `current` it lacks, each once; `current` alone without `login`. */
export function mergePath(login: string | undefined, current: string | undefined): string {
  const dirs = [...(login ?? '').split(delimiter), ...(current ?? '').split(delimiter)].filter(Boolean);
  return [...new Set(dirs)].join(delimiter);
}

/**
 * Puts the login shell's PATH (see `loginShellPath`) in `env`, the daemon's own by default, ahead of what `env` had,
 * so every CLI the daemon runs finds its program as the user's terminal would: git, gh, and the harnesses and shells
 * its sessions start. Keeps `env`'s PATH as it is when there is no login shell PATH to have. Resolves with the PATH
 * it read, if any.
 */
export async function adoptLoginShellPath(
  shell: string,
  shellArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs?: number,
): Promise<string | undefined> {
  const login = await loginShellPath(shell, shellArgs, { env, timeoutMs });
  if (login !== undefined) env.PATH = mergePath(login, env.PATH);
  return login;
}
