import { appendFileSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { ConfigError } from './hooks.ts';
import { GUARD_DIR_ENV, GUARD_DIR_PREFIX, type HarnessName } from './paths.ts';

/** Names one more home to treat as the user's own, for the guard's own test: it adds to the real home, never replaces it. */
export const REAL_HOME_ENV = 'FAKE_HARNESS_REAL_HOME';

/** The `CLAUDE_CONFIG_DIR` and `CODEX_HOME` the run started with, which `useTempHome` unsets, joined by the path delimiter. */
export const REAL_CONFIG_DIRS_ENV = 'FAKE_HARNESS_REAL_CONFIG_DIRS';

/**
 * The user's own config dirs: those of the home in the account database, not `$HOME`, which tests point at a temp
 * folder, of `FAKE_HARNESS_REAL_HOME` if set, and any config dir of the user's own that `useTempHome` unset.
 */
export function realConfigDirs(env: NodeJS.ProcessEnv, home: string = userInfo().homedir): string[] {
  const homes = [home, env[REAL_HOME_ENV]].filter((dir): dir is string => Boolean(dir));
  const own = (env[REAL_CONFIG_DIRS_ENV] ?? '').split(delimiter).filter(Boolean);
  return [...homes.flatMap((dir) => [join(dir, '.claude'), join(dir, '.codex')]), ...own];
}

function inside(dir: string, parent: string): boolean {
  const path = relative(parent, resolve(dir));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/** The run's tripwire dir: named in the env, else found on PATH, where the harness guard keeps it for every child. */
function guardDir(env: NodeJS.ProcessEnv): string | undefined {
  const named = env[GUARD_DIR_ENV];
  if (named) return named;
  return (env.PATH ?? '').split(delimiter).find((dir) => basename(dir).startsWith(GUARD_DIR_PREFIX));
}

/**
 * Refuses a config dir in the user's real home. Its settings hold the live app's hooks, so a fake that read them would
 * post to the user's own board (an "external session" there) and could change its state. Records the hit in the run's
 * tripwire log, so the run fails even when the test that spawned this fake ignores how it exited.
 */
export function refuseRealConfigDir(
  harness: HarnessName,
  configDir: string,
  env: NodeJS.ProcessEnv,
  realDirs: string[] = realConfigDirs(env),
): void {
  const real = realDirs.find((dir) => inside(configDir, dir));
  if (real === undefined) return;
  const message = `refused to read the user's real ${real}: start the fake ${harness} with fakeHarnessEnv() and a temp home`;
  const dir = guardDir(env);
  const log = dir === undefined ? undefined : join(dir, 'hits.log');
  if (log !== undefined && existsSync(log)) appendFileSync(log, `${harness} config ${configDir} (cwd ${process.cwd()})\n`);
  throw new ConfigError(message);
}

/** What a test's git may take from a home: a neutral author, and the branch name `git init` starts on. */
const TEST_GITCONFIG = ['[user]', '\tname = Test', '\temail = test@example.com', '[init]', '\tdefaultBranch = main', ''].join('\n');

/**
 * Gives `env` (the process's own by default) a throwaway home, with no `CLAUDE_CONFIG_DIR` or `CODEX_HOME` pointing
 * elsewhere, so every test and everything it starts (a daemon, its agents, a shell the user would type `claude` in)
 * reads a home that holds none of the user's settings or hooks. Returns the home and a teardown that puts the env back.
 */
export function useTempHome(env: NodeJS.ProcessEnv = process.env): { home: string; restore: () => void } {
  const saved = { HOME: env.HOME, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, CODEX_HOME: env.CODEX_HOME, [REAL_CONFIG_DIRS_ENV]: env[REAL_CONFIG_DIRS_ENV] };
  // Resolved (macOS's temp dir is a symlink), as a process's cwd is: paths built from it match those a child sees.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ab-test-home-')));
  writeFileSync(join(home, '.gitconfig'), TEST_GITCONFIG);
  env.HOME = home;
  const own = [env.CLAUDE_CONFIG_DIR, env.CODEX_HOME].filter(Boolean);
  if (own.length > 0) env[REAL_CONFIG_DIRS_ENV] = own.join(delimiter);
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  const restore = (): void => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  };
  return { home, restore };
}
