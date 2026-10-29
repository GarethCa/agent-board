// Starting the daemon from a command line, as the app's updater and `agent-board restart-daemon` do. Node built-ins and
// built-ins-only modules alone: scripts/update-app imports it before anything is installed.
import { execFileSync } from 'node:child_process';
import { readLockPid } from './lock.ts';
import { daemonPaths } from './paths.ts';

/**
 * What belongs to the caller rather than the user: every `AGENT_BOARD_*` (an agent's board session and hook token, and
 * the settings tests and developers point at temp dirs); pnpm's script env (lowercase `npm_*`, `PNPM_*` but the user's
 * `PNPM_HOME`, `INIT_CWD`); the Claude Code session it may run in (its id, pid and messaging socket, never the user's
 * `CLAUDE_CODE_*` settings); and the shell's own bookkeeping.
 */
const CALLERS_OWN =
  /^(AGENT_BOARD_\w*|npm_\w*|PNPM_\w*|INIT_CWD|CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(SESSION_ID|MESSAGING_\w*|CHILD_SESSION|ENTRYPOINT)|OLDPWD|SHLVL|_)$/;

/**
 * The environment to start a daemon with from a command line: the caller's, without what belongs to the caller
 * (`CALLERS_OWN`), which the daemon would otherwise keep, and hand every session it starts, until its next restart, and
 * without the `node_modules/.bin` folders pnpm puts in front of PATH. The user's own settings stay, as they are in
 * their terminal; the app's daemon, started from launchd's, has fewer. Plus `ELECTRON_RUN_AS_NODE`, so the app's
 * executable runs as Node.
 */
export function daemonLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (CALLERS_OWN.test(name) && name !== 'PNPM_HOME') continue;
    clean[name] = value;
  }
  if (env.PATH !== undefined) {
    clean.PATH = env.PATH.split(':')
      .filter((dir) => !/(^|\/)node_modules\/\.bin\/?$/.test(dir))
      .join(':');
  }
  clean.ELECTRON_RUN_AS_NODE = '1';
  return clean;
}

/**
 * Whether this process runs inside a session of the daemon on `dataDir`: in a board shell or an agent's command, the
 * daemon one of its ancestors. Stopping that daemon ends its sessions, and this process with them. Told by process
 * ancestry, not by the board env, which a caller may have unset. `unknown` when the ancestry can't be read (`ps`
 * failed, or on Windows, which has no `ps`): callers treat it as yes, since a wrong no ends their run.
 */
export function runsUnderDaemon(dataDir: string): boolean | 'unknown' {
  const pid = readLockPid(daemonPaths(dataDir).lock);
  if (pid === undefined) return false;
  if (process.platform === 'win32') return 'unknown';
  try {
    return ancestors(process.pid).includes(pid);
  } catch {
    return 'unknown';
  }
}

/** The parent, grandparent and so on of `pid`, up to (not including) pid 1, from `ps`, which throws if it can't run. */
export function ancestors(pid: number): number[] {
  const parents = new Map<number, number>();
  // -A and -o are POSIX: the same on macOS and Linux.
  for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child !== undefined && parent !== undefined && Number.isInteger(child) && Number.isInteger(parent)) parents.set(child, parent);
  }
  const found: number[] = [];
  for (let next = parents.get(pid); next !== undefined && next > 1 && !found.includes(next); next = parents.get(next)) found.push(next);
  return found;
}
