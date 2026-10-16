// `pnpm update:app`: brings this checkout up to date with its upstream and installs the new app over the old one.
// Node built-ins only, so it runs before anything is installed.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { APP_NAME } from '../app-install/app-install.ts';

/** In the git dir (`git rev-parse --git-path`, since `.git` is a file in a worktree), so it is never part of the tree: the commit last installed from this checkout. */
const STAMP = 'agent-board-installed';

/** What the updater runs beyond git: a seam, so tests can drive it. */
export interface Machine {
  /** Runs a command with the terminal attached, throwing if it fails. */
  run(command: string, args: string[], cwd: string): void;
}

export interface UpdateAppOptions {
  /** The checkout to update and build in. */
  repoDir: string;
  /** Where the app is installed: `~/Applications`. */
  installDir: string;
  launch: boolean;
  /** Build and install even when the installed app is already from the checkout's latest commit. */
  force: boolean;
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
 * The running daemon is left alone: the app offers to restart it when its build differs.
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

  try {
    machine.run('pnpm', ['install', '--frozen-lockfile'], repoDir);
    // `pnpm package` builds, quits the running app, swaps in the new one and reopens it.
    machine.run('pnpm', ['package', '--install', '--install-dir', options.installDir, options.launch ? '--open' : '--no-open'], repoDir);
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\nThe installed app is unchanged. The checkout is at ${describe(git, after)}; fix the problem and run \`pnpm update:app\` again.`,
      { cause: error },
    );
  }
  writeFileSync(stamp, `${after}\n`);
  log(`Updated to ${describe(git, after)}`);
  return { updated: true, sha: after };
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
};
