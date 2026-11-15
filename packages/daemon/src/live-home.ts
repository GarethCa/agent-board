/**
 * What only the installed app may change in the user's own home: the launchers in `~/.agent-board/bin` (the hook shim
 * and the `agent-board` CLI), the global hook files and the `agent-board` command link. A dev build, a test or a probe
 * that points one of them at its own build breaks every agent and hook on the live board once that build is gone.
 */
import { realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

/** The user's own home from the account database, whatever `$HOME` says: tests point `$HOME` at a temp folder, never this. */
export function usersOwnHome(): string {
  return userInfo().homedir;
}

/** Whether `path` is `dir` or lies inside it. */
function isUnder(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The temp folder, both as named and as resolved (macOS names `/var/folders/…`, which is `/private/var/folders/…`). */
function tempDirs(): string[] {
  const temp = tmpdir();
  try {
    return [temp, realpathSync(temp)];
  } catch {
    return [temp];
  }
}

/**
 * Whether the app at `command` is a build run from a scratch folder, a temp folder or a git worktree, not the one the
 * user installed: even packaged, such a build may be gone tomorrow.
 */
export function isScratchBuild(command: string, temps: readonly string[] = tempDirs()): boolean {
  return temps.some((temp) => isUnder(command, temp)) || command.split(/[\\/]/).includes('worktrees');
}

/**
 * Where a daemon that isn't told writes the hook shim, and the `agent-board` CLI launcher beside it: the user's own
 * `~/.agent-board/bin`, which every agent's PATH and Codex hook command name, only for the installed app. Any other run
 * (a dev build, a test, a probe) keeps its launchers in its own data dir.
 */
export function defaultHookShimPath(where: { installedApp: boolean; dataDir: string; home: string }): string {
  return join(where.installedApp ? join(where.home, '.agent-board') : where.dataDir, 'bin', 'agent-board-hook');
}

/**
 * Throws unless this is the installed app or none of `paths` lies in the user's own home (`home`): a dev or test build
 * may change the files of a temp home, never the user's.
 */
export function refuseUsersHomeUnlessInstalled(paths: readonly string[], installedApp: boolean, home: string = usersOwnHome()): void {
  if (installedApp) return;
  const own = paths.find((path) => isUnder(path, home));
  if (own !== undefined) {
    throw new Error(`only the installed agent-board app changes ${own}; this build isn't it (a dev or test build, or one run from a temporary or worktree folder), so use the installed app for it`);
  }
}
