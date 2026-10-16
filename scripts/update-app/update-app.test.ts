import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { updateApp, type Machine, type UpdateAppOptions } from './update-app.ts';

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ab-update-')));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' }).trim();
}

function commit(repo: string, file: string, content: string): string {
  writeFileSync(join(repo, file), content);
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', file);
  return git(repo, 'rev-parse', 'HEAD');
}

/** An upstream with one tagged release, and a user's clone of it. */
function clones() {
  const root = tempDir();
  const upstream = join(root, 'upstream');
  mkdirSync(upstream);
  git(upstream, 'init', '--quiet', '--initial-branch', 'main');
  commit(upstream, 'README.md', 'one\n');
  git(upstream, 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
  const user = join(root, 'user');
  execFileSync('git', ['clone', '--quiet', upstream, user]);
  git(user, 'remote', 'set-url', 'origin', 'git@github.com:acme/agent-board.git');
  git(user, 'config', 'url.' + upstream + '.insteadOf', 'git@github.com:acme/agent-board.git');
  return { upstream, user };
}

/** A fake machine: `pnpm package` installs a .app into --install-dir that says which commit it was built from. */
function fakeMachine(options: { failOn?: string } = {}) {
  const calls: string[] = [];
  const machine: Machine = {
    run(command, args, cwd) {
      calls.push(`${command} ${args.join(' ').replace(/ \S*Applications/, ' <apps>')}`);
      if (args[0] === options.failOn) throw new Error(`${command} ${args.join(' ')} failed (exit 1)`);
      if (args[0] === 'package') {
        const app = join(args[args.indexOf('--install-dir') + 1]!, 'agent-board.app', 'Contents', 'MacOS');
        mkdirSync(app, { recursive: true });
        writeFileSync(join(app, 'agent-board'), git(cwd, 'rev-parse', 'HEAD'));
      }
    },
  };
  return { machine, calls };
}

function setup(overrides: Partial<UpdateAppOptions> = {}) {
  const { upstream, user } = clones();
  const logs: string[] = [];
  const opts: UpdateAppOptions = { repoDir: user, installDir: join(tempDir(), 'Applications'), launch: true, force: false, log: (m) => logs.push(m), ...overrides };
  const installedSha = () => readFileSync(join(opts.installDir, 'agent-board.app', 'Contents', 'MacOS', 'agent-board'), 'utf8');
  return { upstream, user, opts, logs, installedSha };
}

describe('updateApp', () => {
  it('installs the checkout as it is on the first run, then fast-forwards and builds', async () => {
    const { upstream, user, opts, logs, installedSha } = setup();

    const first = fakeMachine();
    await updateApp(opts, first.machine);
    expect(installedSha()).toBe(git(user, 'rev-parse', 'HEAD'));
    expect(first.calls).toEqual(['pnpm install --frozen-lockfile', 'pnpm package --install --install-dir <apps> --open']);

    const next = commit(upstream, 'CHANGELOG.md', 'two\n');
    git(upstream, 'tag', '-a', 'v0.2.0', '-m', 'v0.2.0');
    logs.length = 0;
    const second = fakeMachine();
    const result = await updateApp(opts, second.machine);

    expect(result).toEqual({ updated: true, sha: next });
    expect(git(user, 'rev-parse', 'HEAD')).toBe(next);
    expect(installedSha()).toBe(next);
    expect(second.calls).toEqual(['pnpm install --frozen-lockfile', 'pnpm package --install --install-dir <apps> --open']);
    expect(logs).toContain('Updating v0.1.0 → v0.2.0');
    expect(logs).toContain('1 new commit. Release notes: https://github.com/acme/agent-board/releases/tag/v0.2.0');
  });

  it('does nothing when the installed app is already current, unless forced', async () => {
    const { opts } = setup();
    await updateApp(opts, fakeMachine().machine);

    const again = fakeMachine();
    expect(await updateApp(opts, again.machine)).toMatchObject({ updated: false });
    expect(again.calls).toEqual([]);

    const forced = fakeMachine();
    expect(await updateApp({ ...opts, force: true }, forced.machine)).toMatchObject({ updated: true });
    expect(forced.calls).toHaveLength(2);
  });

  it('refuses a dirty tree and changes nothing', async () => {
    const { upstream, user, opts, installedSha } = setup();
    const before = git(user, 'rev-parse', 'HEAD');
    commit(upstream, 'new.txt', 'x\n');
    writeFileSync(join(user, 'README.md'), 'edited\n');
    const { machine, calls } = fakeMachine();

    await expect(updateApp(opts, machine)).rejects.toThrow(/uncommitted changes/);

    expect(git(user, 'rev-parse', 'HEAD')).toBe(before);
    expect(readFileSync(join(user, 'README.md'), 'utf8')).toBe('edited\n');
    expect(calls).toEqual([]);
    expect(() => installedSha()).toThrow();
  });

  it('refuses a branch that has diverged from its upstream and changes nothing', async () => {
    const { upstream, user, opts } = setup();
    commit(upstream, 'upstream.txt', 'u\n');
    const mine = commit(user, 'mine.txt', 'm\n');
    const { machine, calls } = fakeMachine();

    await expect(updateApp(opts, machine)).rejects.toThrow(/has diverged from origin\/main/);

    expect(git(user, 'rev-parse', 'HEAD')).toBe(mine);
    expect(calls).toEqual([]);
  });

  it('builds local commits that are ahead of the upstream, without pulling', async () => {
    const { user, opts, installedSha } = setup();
    const mine = commit(user, 'mine.txt', 'm\n');

    await updateApp(opts, fakeMachine().machine);

    expect(installedSha()).toBe(mine);
  });

  it('works in a git worktree, where .git is a file, and counts a branch ahead of its upstream as current', async () => {
    const { user, opts, logs } = setup();
    const worktree = join(tempDir(), 'wt');
    git(user, 'worktree', 'add', '--quiet', worktree, '-b', 'feature', '--track', 'origin/main');
    commit(worktree, 'mine.txt', 'm\n');
    const there = { ...opts, repoDir: worktree };

    await updateApp(there, fakeMachine().machine);
    const again = fakeMachine();
    expect(await updateApp(there, again.machine)).toMatchObject({ updated: false });

    expect(again.calls).toEqual([]);
    expect(logs.at(-1)).toContain('Already up to date');
  });

  it('refuses a detached HEAD and a branch with no upstream', async () => {
    const { user, opts } = setup();
    git(user, 'switch', '--quiet', '-c', 'mine');
    await expect(updateApp(opts, fakeMachine().machine)).rejects.toThrow(/tracks no remote branch/);
    git(user, 'switch', '--quiet', '--detach');
    await expect(updateApp(opts, fakeMachine().machine)).rejects.toThrow(/not on a branch/);
  });

  it('keeps the installed app, and builds again next time, when the build fails', async () => {
    const { upstream, user, opts, installedSha } = setup();
    await updateApp(opts, fakeMachine().machine);
    const old = installedSha();
    const next = commit(upstream, 'two.txt', '2\n');

    await expect(updateApp(opts, fakeMachine({ failOn: 'package' }).machine)).rejects.toThrow(/installed app is unchanged/);
    expect(installedSha()).toBe(old);
    expect(git(user, 'rev-parse', 'HEAD')).toBe(next);

    await updateApp(opts, fakeMachine().machine);
    expect(installedSha()).toBe(next);
  });

  it('does not ask the build to open the app with launch off', async () => {
    const { opts } = setup({ launch: false });
    const { machine, calls } = fakeMachine();

    await updateApp(opts, machine);

    expect(calls).toEqual(['pnpm install --frozen-lockfile', 'pnpm package --install --install-dir <apps> --no-open']);
  });
});
