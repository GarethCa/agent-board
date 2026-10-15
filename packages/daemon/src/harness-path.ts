// Where the harness executables (`claude`, `codex`) are, as absolute paths. A user may have one reachable only through
// `.zshrc` (a PATH line, or the alias the Claude installer adds), which no non-interactive shell reads, so a launch
// that looks the name up on a PATH fails there with `command not found`. The path is found once, kept, and launched.
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { loginShellPath, mergePath } from './login-path.ts';

export type HarnessName = 'claude' | 'codex';

/** Where an installer puts a harness, under a home: the first is Claude's own installer's (`alias claude=…`). */
function knownHarnessDirs(homeDir: string): string[] {
  return [join(homeDir, '.claude', 'local'), join(homeDir, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
}

export interface HarnessPaths {
  /** The harness's absolute path as last found, if it is still an executable file; nothing is run to say so. */
  path(harness: HarnessName): string | undefined;
  /** Looks for it again (the shells are asked), keeping what is found. A lookup already running is shared. */
  refresh(harness: HarnessName): Promise<string | undefined>;
  /** Resolves once a lookup of `harness` that is running has finished, at once when none is. */
  pending(harness: HarnessName): Promise<void>;
  /**
   * `env` as a harness runs in it: with the interactive login shell's PATH (once it was read) merged in, ahead of
   * `env`'s own dirs. A harness found there may be a script that needs an interpreter that only `.zshrc` puts on PATH.
   */
  launchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** What to say when `harness` is not found, naming the path set in Settings if there is one. */
  notFound(harness: HarnessName): string;
}

export interface HarnessPathsOptions {
  /** The user's shell and its arguments: a login shell is asked for its PATH, then its interactive PATH. */
  shell: string;
  shellArgs: string[];
  /** The PATH the daemon (and so a launch's shell) looks names up on. */
  env: NodeJS.ProcessEnv;
  homeDir: string;
  /** Where installers put harnesses; `knownHarnessDirs(homeDir)` by default. */
  knownDirs?: string[];
  /** The path set in Settings, if any. It stands in for the lookup, right or wrong. */
  override?(harness: HarnessName): string | undefined;
  /** How long each shell gets: `loginShellPath`'s default. */
  timeoutMs?: number;
}

/** What the tile and Restart say when a harness is not found; `configured` is a path set in Settings that is not it. */
function harnessNotFound(harness: HarnessName, configured: string | undefined): string {
  return configured === undefined
    ? `${harness} not found on this Mac: install it, or set its path in Settings`
    : `${harness} not found at ${configured}: fix its path in Settings, or clear it`;
}

/**
 * Resolves each harness to an absolute path, in order: the path set in Settings (alone, when there is one, and never
 * kept: clearing it brings the lookup back); the daemon's PATH, which holds the login shell's; the interactive login
 * shell's PATH; the known install locations.
 */
export function createHarnessPaths(options: HarnessPathsOptions): HarnessPaths {
  const found = new Map<HarnessName, string>();
  const running = new Map<HarnessName, Promise<string | undefined>>();
  let interactivePath: string | undefined;
  const override = (harness: HarnessName) => options.override?.(harness)?.trim() || undefined;

  const path = (harness: HarnessName): string | undefined => {
    const set = override(harness);
    if (set !== undefined) return isExecutableFile(set) ? set : undefined;
    const kept = found.get(harness);
    if (kept !== undefined && isExecutableFile(kept)) return kept;
    found.delete(harness);
    return findExecutable(harness, options.env.PATH);
  };

  const readInteractive = async (): Promise<string | undefined> => {
    const read = await loginShellPath(options.shell, options.shellArgs, { env: options.env, timeoutMs: options.timeoutMs, interactive: true });
    if (read !== undefined) interactivePath = read;
    return read;
  };

  const look = async (harness: HarnessName): Promise<string | undefined> => {
    if (override(harness) !== undefined) {
      // Not kept, but its interpreter may be on the interactive PATH only.
      if (interactivePath === undefined) await readInteractive();
      return path(harness);
    }
    const at = path(harness);
    if (at !== undefined) return at;
    const result =
      findExecutable(harness, await readInteractive()) ?? findExecutable(harness, (options.knownDirs ?? knownHarnessDirs(options.homeDir)).join(delimiter));
    if (result !== undefined) found.set(harness, result);
    return result;
  };

  const refresh = (harness: HarnessName): Promise<string | undefined> => {
    let lookup = running.get(harness);
    if (lookup === undefined) {
      lookup = look(harness).finally(() => running.delete(harness));
      running.set(harness, lookup);
    }
    return lookup;
  };

  return {
    path,
    refresh,
    pending: async (harness) => {
      await running.get(harness);
    },
    launchEnv: (env) => (interactivePath === undefined ? env : { ...env, PATH: mergePath(interactivePath, env.PATH) }),
    notFound: (harness) => harnessNotFound(harness, override(harness)),
  };
}

/** `command` itself when it is a path, else the first executable file of that name on `path`. */
export function findExecutable(command: string, path: string | undefined): string | undefined {
  const candidates = isAbsolute(command) ? [command] : (path ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  return candidates.find(isExecutableFile);
}

/** Whether `file` is an executable regular file (symlinks followed). */
function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
