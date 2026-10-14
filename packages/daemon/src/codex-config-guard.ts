// Watches a Codex agent that runs with --dangerously-bypass-hook-trust for project config appearing where Codex
// would load it (ADR-0004). Codex reads hook config when a session starts, and `/new` or `/fork` in the TUI start one
// inside the same flagged process, so config the agent writes mid-session would run unreviewed there.
import { lstatSync, watch, type FSWatcher } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * The first `.codex` Codex would load project config from: in `cwd` or a folder above it, up to `worktree`. Any entry
 * by that name counts, a dangling symlink included (its target may appear later). Fails closed: a `.codex` that can't
 * be checked (no permission, say) counts as there.
 */
export function projectCodexConfig(cwd: string, worktree: string): string | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const config = join(dir, '.codex');
    if (entryMayExist(config)) return config;
    if (dir === worktree || relative(worktree, dir).startsWith('..') || dirname(dir) === dir) return undefined;
  }
}

function entryMayExist(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return true;
  }
}

export interface CodexConfigGuard {
  /** Looks again now, e.g. after a tool call. Calls `onFound` once if config is there. */
  check(): void;
  stop(): void;
}

/** How often the guard looks even without a watch event: macOS can drop events, e.g. just after a watch starts. */
const CODEX_CONFIG_POLL_MS = 1_000;

/**
 * Calls `onFound` with the path once a `.codex` exists in `cwd` or a folder above it, up to `worktree`. It watches
 * each of those folders, looks every `CODEX_CONFIG_POLL_MS` in case a watch event is lost, and `check` lets the
 * caller look on every hook too. A folder it can't watch counts as found: the guard fails closed.
 */
export function guardCodexConfig(cwd: string, worktree: string, onFound: (path: string) => void): CodexConfigGuard {
  const watchers: FSWatcher[] = [];
  let done = false;
  const poll = setInterval(() => check(), CODEX_CONFIG_POLL_MS);
  poll.unref();
  const stop = () => {
    done = true;
    clearInterval(poll);
    for (const watcher of watchers.splice(0)) watcher.close();
  };
  const found = (path: string) => {
    if (done) return;
    stop();
    onFound(path);
  };
  const check = () => {
    if (done) return;
    const config = projectCodexConfig(cwd, worktree);
    if (config !== undefined) found(config);
  };

  for (const dir of chain(cwd, worktree)) {
    try {
      // Any change in the folder: macOS may report `.codex/hooks.json` or no name, and a check is a few lstats.
      const watcher = watch(dir, { persistent: false }, check);
      watcher.on('error', () => found(`${dir} (can no longer be watched)`));
      watchers.push(watcher);
    } catch {
      found(`${dir} (can't be watched)`);
      return { check, stop };
    }
  }
  // Anything that appeared before the watches started.
  check();
  return { check, stop };
}

/** `cwd` and each folder above it, up to and including `worktree`. */
function chain(cwd: string, worktree: string): string[] {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dir === worktree || dirname(dir) === dir) return dirs;
  }
}
