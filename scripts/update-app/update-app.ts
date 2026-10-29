// `pnpm update:app`: brings this checkout up to date with its upstream and installs the new app over the old one.
// Node built-ins and built-ins-only modules alone, so it runs before anything is installed.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { daemonLaunchEnv, runsUnderDaemon } from '../../packages/daemon/src/daemon-launch.ts';
import { APP_NAME, appCli } from '../app-install/app-install.ts';

/** In the git dir (`git rev-parse --git-path`, since `.git` is a file in a worktree), so it is never part of the tree: the commit last installed from this checkout. */
const STAMP = 'agent-board-installed';

/** What the updater runs beyond git: a seam, so tests can drive it. */
export interface Machine {
  /** Runs a command with the terminal attached, throwing if it fails. */
  run(command: string, args: string[], cwd: string): void;
  /** Runs the installed app's `agent-board restart-daemon` on `dataDir`, its output on the terminal, throwing if it fails. */
  restartDaemon(app: string, dataDir: string): void;
  /** Opens the installed app. */
  open(app: string): void;
  /** Whether this process runs in a session of the daemon on `dataDir`, which its restart would end, or `unknown`. */
  runsUnderDaemon(dataDir: string): boolean | 'unknown';
}

export interface UpdateAppOptions {
  /** The checkout to update and build in. */
  repoDir: string;
  /** Where the app is installed: `~/Applications`. */
  installDir: string;
  launch: boolean;
  /** Build and install even when the installed app is already from the checkout's latest commit. */
  force: boolean;
  /** Restart the daemon on the new build, resuming its sessions. Off, it is left running on the old build. */
  restart: boolean;
  /** The installed app's data dir, whose daemon is restarted. */
  dataDir: string;
  log(message: string): void;
}

export interface UpdateResult {
  /** False when nothing was built because the installed app was already current. */
  updated: boolean;
  /** The commit now installed. */
  sha: string;
}

/**
 * Updates the checkout with a fast-forward, builds it, and installs the app over the previous one. It refuses, before
 * changing anything, a checkout with local edits, on no branch, without an upstream, or that has diverged from it.
 * Then it restarts the daemon on the new build, resuming its sessions, before it opens the app: an app shows no board
 * on a daemon from another build. Without `restart` the daemon is left running, and the app offers the restart.
 */
export async function updateApp(options: UpdateAppOptions, machine: Machine = realMachine): Promise<UpdateResult> {
  const { repoDir, log } = options;
  const git = (...args: string[]) => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const isAncestor = (older: string, newer: string) => spawnSync('git', ['-C', repoDir, 'merge-base', '--is-ancestor', older, newer]).status === 0;

  const branch = tryGit(git, 'symbolic-ref', '--short', '-q', 'HEAD');
  if (!branch) throw new Error('this checkout is not on a branch (a detached HEAD). Run `git switch main`, then try again.');
  const upstream = tryGit(git, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  if (!upstream) throw new Error(`branch ${branch} tracks no remote branch, so there is nothing to update from. Run \`git switch main\`, then try again.`);
  if (git('status', '--porcelain', '--untracked-files=no')) {
    throw new Error('you have uncommitted changes in this checkout, so it was left as it is. Commit or stash them (`git stash`), then try again.');
  }

  const remote = tryGit(git, 'config', '--get', `branch.${branch}.remote`) ?? 'origin';
  log(`Fetching ${upstream}`);
  try {
    git('fetch', '--quiet', '--tags', remote);
  } catch (error) {
    throw new Error(`could not fetch from ${remote}: ${gitMessage(error)}. Check your network, then try again.`, { cause: error });
  }

  const before = git('rev-parse', 'HEAD');
  const target = git('rev-parse', '@{u}');
  if (!isAncestor(before, target) && !isAncestor(target, before)) {
    throw new Error(
      `${branch} has diverged from ${upstream}: it has commits ${upstream} lacks, and the other way round. Nothing was changed.\n` +
        `To keep your commits, merge or rebase onto ${upstream} yourself. To drop them, run \`git reset --hard ${upstream}\`.`,
    );
  }

  const stamp = resolve(repoDir, git('rev-parse', '--git-path', STAMP));
  const installedSha = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : undefined;
  const installedApp = join(options.installDir, APP_NAME);
  if (!options.force && installedSha === before && isAncestor(target, before) && existsSync(installedApp)) {
    log(`Already up to date: ${describe(git, before)} is installed at ${installedApp}. Use --force to build it again.`);
    return { updated: false, sha: before };
  }

  if (before !== target && isAncestor(before, target)) {
    git('merge', '--quiet', '--ff-only', '@{u}');
  } else if (before !== target) {
    log(`${branch} is ahead of ${upstream}; building your commits as they are.`);
  }
  const after = git('rev-parse', 'HEAD');

  const was = installedSha && tryGit(git, 'cat-file', '-t', installedSha) === 'commit' ? installedSha : undefined;
  log(was ? `Updating ${describe(git, was)} → ${describe(git, after)}` : `Installing ${describe(git, after)}`);
  const notes = releaseNotes(git, remote, was, after);
  if (notes) log(notes);

  // A board shell or agent: stopping its daemon would end this run before the new daemon started.
  const inside = options.restart ? machine.runsUnderDaemon(options.dataDir) : false;
  const restart = options.restart && inside === false;
  if (inside === true) {
    log('This runs inside a session of the daemon (a board shell or agent), which restarting it would end, this update with it: leaving the daemon running, as with --no-restart.');
  } else if (inside === 'unknown') {
    log('Could not tell whether this runs inside a session of the daemon, which restarting it would end, this update with it: leaving the daemon running, as with --no-restart.');
  }
  // Said before the build, while there is still time to stop it and run again with --no-restart.
  if (restart) log('Once installed, the daemon restarts on the new build. An agent mid-turn loses that turn: `--no-restart` leaves the daemon running.');
  try {
    machine.run('pnpm', ['install', '--frozen-lockfile'], repoDir);
    // `pnpm package` builds, quits the running app and swaps in the new one. It is opened below, once its daemon is.
    machine.run('pnpm', ['package', '--install', '--install-dir', options.installDir, '--no-open'], repoDir);
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\nThe installed app is unchanged. The checkout is at ${describe(git, after)}; fix the problem and run \`pnpm update:app\` again.`,
      { cause: error },
    );
  }
  log(`Updated to ${describe(git, after)}`);
  // Stamped only once the daemon is on it too (or left on purpose): after a failed restart, the next run tries again.
  if (restartDaemon({ ...options, restart }, installedApp, machine)) writeFileSync(stamp, `${after}\n`);
  if (options.launch) {
    machine.open(installedApp);
    log('Opened agent-board.');
  }
  return { updated: true, sha: after };
}

/**
 * Restarts the daemon on the new build with its own `agent-board restart-daemon`, which says what it restarted and
 * resumed. A failed restart leaves the update installed: the app offers the restart when it opens. Returns false when
 * the restart failed.
 */
function restartDaemon(options: UpdateAppOptions, app: string, machine: Machine): boolean {
  const { log } = options;
  if (!options.restart) {
    log('Left the daemon running on the old build, with its sessions (--no-restart). The app asks to restart it before it shows the board.');
    return true;
  }
  log('Restarting the daemon on the new build and resuming its sessions.');
  try {
    machine.restartDaemon(app, options.dataDir);
    return true;
  } catch (error) {
    log(
      `Could not restart the daemon: ${(error as Error).message}. Open agent-board: it offers the restart if the old daemon still runs, ` +
        'or Resume all for what the restart stopped. Or run `pnpm update:app` again, which builds and tries the restart again.',
    );
    return false;
  }
}

/** A tag when HEAD is on one, else the nearest tag with the commits since, else the short SHA. */
function describe(git: (...args: string[]) => string, rev: string): string {
  return tryGit(git, 'describe', '--tags', '--always', rev) ?? rev.slice(0, 7);
}

/** How many commits the update brings, and where to read about them: the release page for a tagged commit, else a comparison. */
function releaseNotes(git: (...args: string[]) => string, remote: string, from: string | undefined, to: string): string | undefined {
  const url = tryGit(git, 'config', '--get', `remote.${remote}.url`)?.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1];
  const tag = tryGit(git, 'describe', '--tags', '--exact-match', to);
  const count = from && from !== to ? tryGit(git, 'rev-list', '--count', `${from}..${to}`) : undefined;
  const lines: string[] = [];
  if (count) lines.push(`${count} new commit${count === '1' ? '' : 's'}.`);
  if (url && tag) lines.push(`Release notes: https://github.com/${url}/releases/tag/${tag}`);
  else if (url && from && from !== to) lines.push(`What changed: https://github.com/${url}/compare/${from.slice(0, 12)}...${to.slice(0, 12)}`);
  return lines.length ? lines.join(' ') : undefined;
}

function tryGit(git: (...args: string[]) => string, ...args: string[]): string | undefined {
  try {
    return git(...args) || undefined;
  } catch {
    return undefined;
  }
}

function gitMessage(error: unknown): string {
  const { stderr } = error as { stderr?: Buffer | string };
  return String(stderr ?? (error as Error).message).trim().split('\n').at(-1) ?? 'git failed';
}

const realMachine: Machine = {
  run(command, args, cwd) {
    const { status, error } = spawnSync(command, args, { cwd, stdio: 'inherit' });
    if (error) throw new Error(`could not run ${command}: ${error.message}`);
    if (status !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit ${status})`);
  },
  restartDaemon(app, dataDir) {
    // The app's own executable as Node, as the app runs its daemon: so the new daemon is the new build's.
    const cli = appCli(app, ['restart-daemon', '--data-dir', dataDir]);
    const { status, error } = spawnSync(cli.command, cli.args, { stdio: ['ignore', 'inherit', 'inherit'], env: daemonLaunchEnv(process.env) });
    if (error) throw new Error(`could not run agent-board restart-daemon: ${error.message}`);
    if (status !== 0) throw new Error(`agent-board restart-daemon failed (exit ${status})`);
  },
  open: (app) => void execFileSync('open', [app]),
  runsUnderDaemon,
};
