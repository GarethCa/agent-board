import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { pushLfsObjects, runGit } from '../src/git.ts';
import { addDetachedWorktree, addWorktree, agentWorktreePath } from '../src/worktrees.ts';
import { git, tempDataDir, tempRepo } from './helpers.ts';

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/**
 * A repo set up the way husky sets one up: `core.hooksPath = .husky/_`, a folder of untracked shims that each run the
 * tree's own `.husky/<hook>` from the folder the hook runs in. Its branch `planted` commits a `.husky/post-checkout` that
 * leaves `marker`, the way an agent's branch could. The branch also has a file run through a smudge filter that leaves
 * `smudged`: a filter, as Git LFS uses for its files, which turning hooks off must not stop.
 */
function plantedRepo(): { repo: string; marker: string; smudged: string } {
  const repo = tempRepo();
  const flags = tempDataDir();
  const [marker, smudged] = [join(flags, 'hook-ran'), join(flags, 'smudged')];
  git(repo, 'config', 'core.hooksPath', '.husky/_');
  git(repo, 'config', 'filter.mark.smudge', `touch '${smudged}'; cat`);
  git(repo, 'config', 'filter.mark.clean', 'cat');
  mkdirSync(join(repo, '.husky', '_'), { recursive: true });
  writeFileSync(join(repo, '.husky', '_', '.gitignore'), '*\n');
  script(join(repo, '.husky', '_', 'post-checkout'), 'if [ -f .husky/post-checkout ]; then sh .husky/post-checkout "$@"; fi');
  git(repo, 'checkout', '--quiet', '-b', 'planted');
  script(join(repo, '.husky', 'post-checkout'), `touch '${marker}'`);
  writeFileSync(join(repo, '.gitattributes'), 'big.bin filter=mark\n');
  writeFileSync(join(repo, 'big.bin'), 'content\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'plant a hook');
  git(repo, '-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '-');
  expect(existsSync(smudged) || existsSync(marker)).toBe(false);
  return { repo, marker, smudged };
}

describe('the board runs no hook a branch brings', () => {
  it('makes a worktree on a branch that commits a post-checkout hook without running it, while filters still run', async () => {
    const { repo, marker, smudged } = plantedRepo();
    const worktree = agentWorktreePath(tempDataDir(), repo, 'agent');
    expect(await addWorktree(repo, worktree, 'agent', 'planted')).toBe(true);
    expect(readFileSync(join(worktree, 'big.bin'), 'utf8')).toBe('content\n');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(smudged)).toBe(true);
  });

  it("checks out a reviewer's detached worktree without running it either", async () => {
    const { repo, marker } = plantedRepo();
    await addDetachedWorktree(repo, agentWorktreePath(tempDataDir(), repo, 'review'), 'planted');
    expect(existsSync(marker)).toBe(false);
  });

  it("runs no fsmonitor the repo's config names as it reads a worktree's status", async () => {
    const repo = tempRepo();
    const marker = join(tempDataDir(), 'fsmonitor-ran');
    const monitor = join(tempDataDir(), 'fsmonitor');
    script(monitor, `touch '${marker}'`);
    git(repo, 'config', 'core.fsmonitor', monitor);
    expect((await runGit(repo, ['status', '--porcelain'])).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it('runs hooks for a command that asks for them', async () => {
    const { repo, marker } = plantedRepo();
    expect((await runGit(repo, ['checkout', '--quiet', 'planted'])).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect((await runGit(repo, ['checkout', '--quiet', '--detach'], undefined, {}, { hooks: true })).ok).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });
});

describe('pushLfsObjects', () => {
  /**
   * A `git lfs` on PATH that runs `body`, having written the arguments it was run with to `calls`, one call a line. The
   * global config is a machine's that has run `git lfs install`, which names the LFS filter for every repo.
   */
  function fakeLfs(body = ''): string {
    const bin = tempDataDir();
    const calls = join(bin, 'calls');
    script(join(bin, 'git-lfs'), `echo "$*" >> '${calls}'\n${body}`);
    const global = join(bin, 'gitconfig');
    writeFileSync(global, '[filter "lfs"]\n\tprocess = git-lfs filter-process\n\trequired = true\n');
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', global);
    onTestFinished(() => void vi.unstubAllEnvs());
    return calls;
  }

  /** A repo whose `dir/.gitattributes` tracks `*.bin` with LFS, committed. */
  function lfsRepo(dir = 'assets'): string {
    const repo = tempRepo();
    mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, dir, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'track binaries');
    return repo;
  }

  it.each(['.', 'assets'])("uploads the ref's LFS objects when its tree tracks files with LFS (attributes in %s)", async (dir) => {
    const calls = fakeLfs();
    expect((await pushLfsObjects(lfsRepo(dir), 'origin', 'HEAD')).ok).toBe(true);
    expect(readFileSync(calls, 'utf8').split('\n')).toContain('push origin HEAD');
  });

  it("does nothing for a ref whose tree tracks nothing with LFS, though the machine's config names its filter", async () => {
    const calls = fakeLfs();
    expect((await pushLfsObjects(tempRepo(), 'origin', 'HEAD')).ok).toBe(true);
    expect(existsSync(calls)).toBe(false);
  });

  /** Commits `.lfsconfig` with `body` at the top of `repo`. */
  function commitLfsConfig(repo: string, body: string): void {
    writeFileSync(join(repo, '.lfsconfig'), body);
    git(repo, 'add', '.lfsconfig');
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'lfs config');
  }

  it.each([
    ['lfs.url', '[lfs]\n\turl = https://elsewhere.example/lfs\n'],
    ['lfs.pushurl', '[lfs]\n\tpushurl = https://elsewhere.example/lfs\n'],
    ['remote.origin.lfsurl', '[remote "origin"]\n\tlfsurl = https://elsewhere.example/lfs\n'],
    ['remote.origin.lfspushurl', '[remote "origin"]\n\tlfspushurl = https://elsewhere.example/lfs\n'],
    ['url.<base>.insteadof', '[url "https://elsewhere.example/"]\n\tinsteadOf = https://github.com/\n'],
  ])("refuses, uploading nothing, when the ref's .lfsconfig sets a key that could name where to upload (%s)", async (key, body) => {
    const calls = fakeLfs();
    const repo = lfsRepo();
    commitLfsConfig(repo, body);
    const result = await pushLfsObjects(repo, 'origin', 'HEAD');
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('.lfsconfig');
    expect(result.stderr.toLowerCase()).toContain(key.replace('<base>', 'https://elsewhere.example/').toLowerCase());
    expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').not.toContain('push');
  });

  it('refuses when only the worktree has a .lfsconfig that names where to upload, as Git LFS reads that file first', async () => {
    const calls = fakeLfs();
    const repo = lfsRepo();
    writeFileSync(join(repo, '.lfsconfig'), '[lfs]\n\turl = https://elsewhere.example/lfs\n');
    expect(await pushLfsObjects(repo, 'origin', 'HEAD')).toMatchObject({ ok: false });
    expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').not.toContain('push');
  });

  it.each([
    ['in-tree', 'sub/x.cfg'],
    ['absolute', ''],
  ])("refuses a .lfsconfig that includes another file (%s path), as Git LFS follows includes", async (_kind, inTree) => {
    const calls = fakeLfs();
    const repo = lfsRepo();
    const included = inTree === '' ? join(tempDataDir(), 'x.cfg') : join(repo, inTree);
    mkdirSync(join(included, '..'), { recursive: true });
    writeFileSync(included, '[lfs]\n\turl = https://elsewhere.example/lfs\n');
    commitLfsConfig(repo, `[include]\n\tpath = ${inTree === '' ? included : inTree}\n`);
    const result = await pushLfsObjects(repo, 'origin', 'HEAD');
    expect(result).toMatchObject({ ok: false });
    expect(result.stderr).toContain('include.path');
    expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').not.toContain('push');
  });

  it('refuses a conditional include in .lfsconfig', async () => {
    const calls = fakeLfs();
    const repo = lfsRepo();
    commitLfsConfig(repo, '[includeIf "gitdir:/"]\n\tpath = /tmp/x.cfg\n');
    expect((await pushLfsObjects(repo, 'origin', 'HEAD')).stderr).toContain('includeif.gitdir:/.path');
    expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').not.toContain('push');
  });

  it('refuses when only the index has a .lfsconfig that names where to upload', async () => {
    const calls = fakeLfs();
    const repo = lfsRepo();
    writeFileSync(join(repo, '.lfsconfig'), '[lfs]\n\turl = https://elsewhere.example/lfs\n');
    git(repo, 'add', '.lfsconfig');
    rmSync(join(repo, '.lfsconfig'));
    expect(await pushLfsObjects(repo, 'origin', 'HEAD')).toMatchObject({ ok: false });
    expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').not.toContain('push');
  });

  it.each([
    ['lfs.url', '[LFS]\n\tURL = https://elsewhere.example/lfs\n'],
    ['remote.Origin.lfsurl', '[remote "Origin"]\n\tlfsUrl = https://elsewhere.example/lfs\n'],
  ])("refuses a .lfsconfig only on the pushed ref, not HEAD, written in mixed case (%s)", async (key, body) => {
    const calls = fakeLfs();
    const repo = lfsRepo();
    git(repo, 'checkout', '--quiet', '-b', 'agent');
    commitLfsConfig(repo, body);
    git(repo, 'checkout', '--quiet', '-');
    expect(existsSync(join(repo, '.lfsconfig'))).toBe(false);
    const result = await pushLfsObjects(repo, 'origin', 'refs/heads/agent');
    expect(result).toMatchObject({ ok: false });
    expect(result.stderr).toContain(key);
    expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').not.toContain('push');
  });

  it('refuses a malformed .lfsconfig whose good lines above the bad one name where to upload', async () => {
    const calls = fakeLfs();
    const repo = lfsRepo();
    commitLfsConfig(repo, '[lfs]\n\turl = https://elsewhere.example/lfs\n[broken\n');
    expect(await pushLfsObjects(repo, 'origin', 'HEAD')).toMatchObject({ ok: false });
    expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').not.toContain('push');
  });

  it('uploads when the .lfsconfig sets only keys that do not choose a server', async () => {
    const calls = fakeLfs();
    const repo = lfsRepo();
    commitLfsConfig(repo, '[lfs]\n\tfetchexclude = docs/*\n');
    expect((await pushLfsObjects(repo, 'origin', 'HEAD')).ok).toBe(true);
    expect(readFileSync(calls, 'utf8').split('\n')).toContain('push origin HEAD');
  });

  it('fails with the message of an upload that fails', async () => {
    fakeLfs('if [ "$1" = push ]; then echo "batch request failed" >&2; exit 2; fi');
    expect(await pushLfsObjects(lfsRepo(), 'origin', 'HEAD')).toMatchObject({ ok: false, stderr: 'batch request failed' });
  });
});
