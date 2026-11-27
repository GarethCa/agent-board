import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { checkCheckoutConfig, checkRepoConfig, isLocalRemoteUrl, pushBranch, pushLfsObjects, repoFiltersOffEnv, runGit, type ConfigCheck } from '../src/git.ts';
import { addDetachedWorktree, addWorktree, agentWorktreePath } from '../src/worktrees.ts';
import { git, gitWritesBefore, pushesTo, tempDataDir, tempRepo, userGitConfig } from './helpers.ts';

/** Why a check refused, or undefined when it passed. */
const refusal = (check: ConfigCheck) => ('refused' in check ? check.refused : undefined);

/** Why the board won't push or fetch from `repo`'s origin, or undefined. */
const repoConfigProgramsWhy = async (repo: string, doing: 'push' | 'fetch') => refusal(await checkRepoConfig(repo, doing, 'origin'));

/** Why the board won't check out or merge in `repo`, or undefined. */
const repoConfigCheckoutProgramsWhy = async (repo: string, doing: string) => refusal(await checkCheckoutConfig(repo, doing, { trees: [] }));

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/**
 * A repo set up the way husky sets one up: `core.hooksPath = .husky/_`, a folder of untracked shims that each run the
 * tree's own `.husky/<hook>` from the folder the hook runs in. Its branch `planted` commits a `.husky/post-checkout` that
 * leaves `marker`, the way an agent's branch could. The branch also has a file run through a smudge filter that leaves
 * `smudged`: a filter in the user's own config, as Git LFS installs its own, which turning hooks off must not stop.
 */
function plantedRepo(): { repo: string; marker: string; smudged: string } {
  const repo = tempRepo();
  const flags = tempDataDir();
  const [marker, smudged] = [join(flags, 'hook-ran'), join(flags, 'smudged')];
  git(repo, 'config', 'core.hooksPath', '.husky/_');
  git(repo, 'config', '--file', userGitConfig(), 'filter.mark.smudge', `touch '${smudged}'; cat`);
  git(repo, 'config', '--file', userGitConfig(), 'filter.mark.clean', 'cat');
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

describe("the programs a repo's own config names, which the board won't push or fetch with", () => {
  /** A config file outside the repo, standing in for the user's own `~/.gitconfig`, with `body`. */
  function globalConfig(body: string): void {
    const global = join(tempDataDir(), 'gitconfig');
    writeFileSync(global, body);
    vi.stubEnv('GIT_CONFIG_GLOBAL', global);
    onTestFinished(() => void vi.unstubAllEnvs());
  }

  it.each([
    ['core.sshCommand', './evil'],
    ['core.askPass', './evil'],
    ['core.gitProxy', './evil'],
    ['credential.helper', '!./evil'],
    ['credential.https://github.com.helper', '!./evil'],
    ['core.alternateRefsCommand', './evil'],
    ['lfs.customtransfer.evil.path', './evil'],
    ['lfs.standaloneTransferAgent', 'evil'],
    ['lfs.https://example.com/acme/web.git/info/lfs.standaloneTransferAgent', 'evil'],
    ['remote.origin.uploadpack', './evil'],
    ['remote.origin.receivepack', './evil'],
    ['protocol.ext.allow', 'always'],
  ])('refuses %s set in the repo', async (key, value) => {
    const repo = tempRepo();
    git(repo, 'config', key, value);
    expect(await repoConfigProgramsWhy(repo, 'push')).toMatch(new RegExp(`sets ${key.replaceAll('.', '\\.')}, which names a program.*won't push`, 'i'));
  });

  it("refuses one set in a worktree's own config, or in a file the repo's config includes", async () => {
    const repo = tempRepo();
    git(repo, 'config', 'extensions.worktreeConfig', 'true');
    git(repo, 'config', '--worktree', 'core.sshCommand', './evil');
    expect(await repoConfigProgramsWhy(repo, 'fetch')).toMatch(/core\.sshcommand/);

    const other = tempRepo();
    const included = join(tempDataDir(), 'included');
    writeFileSync(included, '[credential]\n\thelper = !./evil\n');
    git(other, 'config', 'include.path', included);
    expect(await repoConfigProgramsWhy(other, 'push')).toMatch(/credential\.helper/);
  });

  it("refuses a repo whose config can't be read, as it could set anything", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, '.git', 'config'), '[core\n\tsshCommand = ./evil\n');
    expect(await repoConfigProgramsWhy(repo, 'push')).toMatch(/^could not read the repo's config, so the board won't push/);
  });

  it("allows the same keys in the user's global config, and the repo's other keys, its own signing among them", async () => {
    globalConfig('[core]\n\tsshCommand = ssh -i ~/.ssh/work\n[credential]\n\thelper = osxkeychain\n');
    const repo = tempRepo();
    git(repo, 'config', 'remote.origin.url', 'git@github.com:acme/web.git');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'gpg.format', 'ssh');
    git(repo, 'config', 'gpg.ssh.program', '/Applications/1Password.app/Contents/MacOS/op-ssh-sign');
    expect(await repoConfigProgramsWhy(repo, 'push')).toBeUndefined();
  });
});

describe("the merge drivers and filters a repo's own config names, which the board won't check out or merge with", () => {
  it.each([
    ['merge.evil.driver', './evil %O %A %B'],
    ['filter.evil.clean', './evil'],
    ['filter.evil.smudge', './evil'],
    ['filter.evil.process', './evil'],
    ['lfs.extension.evil.smudge', './evil %f'],
    ['lfs.extension.evil.clean', './evil %f'],
  ])('refuses %s set in the repo', async (key, value) => {
    const repo = tempRepo();
    git(repo, 'config', key, value);
    expect(await repoConfigCheckoutProgramsWhy(repo, 'merge')).toMatch(new RegExp(`sets ${key.replaceAll('.', '\\.')}, which names a program.*won't merge`, 'i'));
  });

  it("refuses one set in a worktree's own config, and a repo whose config can't be read", async () => {
    const repo = tempRepo();
    git(repo, 'config', 'extensions.worktreeConfig', 'true');
    git(repo, 'config', '--worktree', 'merge.evil.driver', './evil');
    expect(await repoConfigCheckoutProgramsWhy(repo, 'merge')).toMatch(/merge\.evil\.driver/);

    const broken = tempRepo();
    writeFileSync(join(broken, '.git', 'config'), '[filter\n\tsmudge = ./evil\n');
    expect(await repoConfigCheckoutProgramsWhy(broken, 'merge')).toMatch(/^could not read the repo's config, so the board won't merge/);
  });

  it("allows Git LFS's own filter in the repo, any filter in the user's config, and the repo's other merge and filter keys", async () => {
    const repo = tempRepo();
    git(repo, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f');
    git(repo, 'config', 'filter.lfs.smudge', 'git-lfs smudge -- %f');
    git(repo, 'config', 'filter.lfs.process', 'git-lfs filter-process');
    git(repo, 'config', 'filter.lfs.required', 'true');
    git(repo, 'config', 'merge.ff', 'false');
    git(repo, 'config', 'merge.evil.name', 'a driver named but not set');
    git(repo, 'config', '--file', userGitConfig(), 'merge.mine.driver', 'my-merge %O %A %B');
    git(repo, 'config', '--file', userGitConfig(), 'filter.mine.smudge', 'my-filter');
    expect(await repoConfigCheckoutProgramsWhy(repo, 'merge')).toBeUndefined();
  });

  it("refuses Git LFS's values under another case of its name, which is another filter", async () => {
    const repo = tempRepo();
    git(repo, 'config', 'filter.LFS.smudge', 'git-lfs smudge -- %f');
    expect(await repoConfigCheckoutProgramsWhy(repo, 'merge')).toMatch(/sets filter\.LFS\.smudge, which names a program/);
  });

  it("allows Git LFS's filter as `--skip-smudge` writes it", async () => {
    const repo = tempRepo();
    git(repo, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f');
    git(repo, 'config', 'filter.lfs.smudge', 'git-lfs smudge --skip -- %f');
    git(repo, 'config', 'filter.lfs.process', 'git-lfs filter-process --skip');
    expect(await repoConfigCheckoutProgramsWhy(repo, 'merge')).toBeUndefined();
  });

  it.each([
    ['lfs.customtransfer.evil.path', './evil'],
    ['lfs.standaloneTransferAgent', 'evil'],
    ['lfs.https://example.com/acme/web.git/info/lfs.standaloneTransferAgent', 'evil'],
    ['credential.helper', '!./evil'],
    ['core.sshCommand', './evil'],
  ])("with Git LFS's filter on, refuses %s in the repo, which its downloads at checkout would run", async (key, value) => {
    const repo = tempRepo();
    git(repo, 'config', key, value);
    expect(await repoConfigCheckoutProgramsWhy(repo, 'merge')).toBeUndefined();
    git(repo, 'config', '--file', userGitConfig(), 'filter.lfs.process', 'git-lfs filter-process');
    expect(await repoConfigCheckoutProgramsWhy(repo, 'merge')).toMatch(new RegExp(`sets ${key.replaceAll('.', '\\.')}, which names a program git would run \\(as Git LFS's filter is on`, 'i'));
  });

  it('leaves no worktree and no branch behind when the checkout fails, as with a required filter that fails', async () => {
    const config = userGitConfig();
    git(tempRepo(), 'config', '--file', config, 'filter.broken.smudge', 'false');
    git(tempRepo(), 'config', '--file', config, 'filter.broken.clean', 'cat');
    git(tempRepo(), 'config', '--file', config, 'filter.broken.required', 'true');
    const repo = tempRepo();
    writeFileSync(join(repo, '.gitattributes'), 'big.bin filter=broken\n');
    writeFileSync(join(repo, 'big.bin'), 'content\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'need a filter');
    git(repo, 'branch', 'planted');
    const worktree = agentWorktreePath(tempDataDir(), repo, 'agent');
    await expect(addWorktree(repo, worktree, 'agent', 'planted')).rejects.toThrow(/could not create a worktree for [^]*smudge filter broken failed/);
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, 'branch', '--list', 'agent')).toBe('');
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(worktree);
  });

  it("refuses Git LFS's filter key in the repo when it names another program", async () => {
    const repo = tempRepo();
    git(repo, 'config', 'filter.lfs.smudge', './evil');
    expect(await repoConfigCheckoutProgramsWhy(repo, 'merge')).toMatch(/filter\.lfs\.smudge/);
  });

  it("makes no worktree, detached or not, in a repo whose own config names a smudge filter, which never runs", async () => {
    const repo = tempRepo();
    const marker = join(tempDataDir(), 'smudged');
    git(repo, 'config', 'filter.evil.smudge', `touch '${marker}'; cat`);
    git(repo, 'config', 'filter.evil.clean', 'cat');
    writeFileSync(join(repo, '.gitattributes'), 'big.bin filter=evil\n');
    writeFileSync(join(repo, 'big.bin'), 'content\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'pick a filter');
    rmSync(marker, { force: true });
    git(repo, 'branch', 'planted');
    const worktree = agentWorktreePath(tempDataDir(), repo, 'agent');
    await expect(addWorktree(repo, worktree, 'agent', 'planted')).rejects.toThrow(/sets filter\.evil\.smudge.*won't make a worktree/);
    await expect(addDetachedWorktree(repo, agentWorktreePath(tempDataDir(), repo, 'review'), 'planted')).rejects.toThrow(/filter\.evil\.smudge/);
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ['gitdir:**/.git/worktrees/**', 'agent'],
    ['onbranch:agent', 'agent'],
    ['gitdir:**/.git/worktrees/**', 'review'],
  ])('reads the config in the new worktree, where an include on %s applies alone, and removes a %s worktree it refuses', async (condition, kind) => {
    const repo = tempRepo();
    const marker = join(tempDataDir(), 'smudged');
    writeFileSync(join(repo, '.gitattributes'), 'big.bin filter=evil\n');
    writeFileSync(join(repo, 'big.bin'), 'content\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'pick a filter');
    git(repo, 'branch', 'planted');
    const included = join(tempDataDir(), 'evil.inc');
    writeFileSync(included, `[filter "evil"]\n\tsmudge = touch '${marker}'; cat\n\tclean = cat\n`);
    git(repo, 'config', `includeIf.${condition}.path`, included);
    expect(await repoConfigCheckoutProgramsWhy(repo, 'merge')).toBeUndefined();
    const worktree = agentWorktreePath(tempDataDir(), repo, kind);
    const made = kind === 'agent' ? addWorktree(repo, worktree, 'agent', 'planted') : addDetachedWorktree(repo, worktree, 'planted');
    await expect(made).rejects.toThrow(/sets filter\.evil\.smudge.*won't make a worktree/);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, 'branch', '--list', 'agent')).toBe('');
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(worktree);
  });
});

describe('a key written into the repo\'s own config after its check', () => {
  /** `repo`, with `origin` a second repo on disk, and a flag file each planted program would touch. */
  function repoWithOrigin() {
    const [repo, origin] = [tempRepo(), tempRepo()];
    git(repo, 'remote', 'add', 'origin', origin);
    return { repo, origin, ran: join(tempDataDir(), 'ran') };
  }
  const checked = (check: ConfigCheck) => {
    if ('refused' in check) throw new Error(check.refused);
    return check;
  };

  it("fetches with the upload-pack the checked config gave, not one the repo's config names since", async () => {
    const { repo, ran } = repoWithOrigin();
    const check = checked(await checkRepoConfig(repo, 'fetch', 'origin'));
    script(join(repo, 'evil-upload-pack'), `touch '${ran}'; exec git-upload-pack "$@"`);
    git(repo, 'config', 'remote.origin.uploadpack', join(repo, 'evil-upload-pack'));
    git(repo, 'config', 'core.sshCommand', join(repo, 'evil-upload-pack'));
    const fetched = await runGit(repo, ['fetch', '--quiet', ...check.args, 'origin'], undefined, check.env);
    expect(fetched.ok).toBe(true);
    expect(existsSync(ran)).toBe(false);
    expect(await check.after()).toBeUndefined();
  });

  it('says so once the command has run when the key is one no pin holds', async () => {
    const { repo } = repoWithOrigin();
    const check = checked(await checkRepoConfig(repo, 'fetch', 'origin'));
    git(repo, 'config', 'lfs.customtransfer.evil.path', '/bin/evil');
    expect(await check.after()).toMatch(/came to set lfs\.customtransfer\.evil\.path as the board went to fetch, after its check/);
  });

  it("checks files out with the filters the checked config gave, not a smudge the repo's config names since", async () => {
    const repo = tempRepo();
    const ran = join(tempDataDir(), 'ran');
    writeFileSync(join(repo, '.gitattributes'), 'big.bin filter=evil\n');
    writeFileSync(join(repo, 'big.bin'), 'content\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'attributes');
    rmSync(join(repo, 'big.bin'));
    const check = checked(await checkCheckoutConfig(repo, 'make a worktree', { trees: ['HEAD'] }));
    git(repo, 'config', 'filter.evil.smudge', `touch '${ran}'; cat`);
    git(repo, 'config', 'filter.evil.required', 'true');
    const reset = await runGit(repo, ['reset', '--quiet', '--hard'], undefined, check.env);
    expect(reset.ok).toBe(true);
    expect(readFileSync(join(repo, 'big.bin'), 'utf8')).toBe('content\n');
    expect(existsSync(ran)).toBe(false);
    expect(await check.after()).toBeUndefined();
  });

  it("merges with git's own merge, not a driver the repo's config names since", async () => {
    const repo = tempRepo();
    const ran = join(tempDataDir(), 'ran');
    const commit = (message: string) => git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-am', message);
    writeFileSync(join(repo, '.gitattributes'), 'notes.txt merge=evil\n');
    writeFileSync(join(repo, 'notes.txt'), 'one\ntwo\nthree\n');
    git(repo, 'add', '.');
    commit('notes');
    git(repo, 'checkout', '--quiet', '-b', 'side');
    writeFileSync(join(repo, 'notes.txt'), 'one\ntwo\nthree, said the side\n');
    commit('side');
    git(repo, 'checkout', '--quiet', '-');
    writeFileSync(join(repo, 'notes.txt'), 'one, said the base\ntwo\nthree\n');
    commit('base');
    const check = checked(await checkCheckoutConfig(repo, 'merge', { trees: ['HEAD', 'side'], worktree: true }));
    git(repo, 'config', 'merge.evil.driver', `touch '${ran}'; true`);
    const merged = await runGit(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'merge', '--quiet', '--no-edit', 'side'], undefined, check.env);
    expect(merged.ok).toBe(true);
    expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('one, said the base\ntwo\nthree, said the side\n');
    expect(existsSync(ran)).toBe(false);
    expect(await check.after()).toBeUndefined();
  });

  it("refuses, never waiting on it, an attributes file that is a FIFO, which an agent could put there", async () => {
    const repo = tempRepo();
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    execFileSync('mkfifo', [join(repo, '.git', 'info', 'attributes')]);
    expect(refusal(await checkCheckoutConfig(repo, 'make a worktree', { trees: ['HEAD'] }))).toMatch(/won't make a worktree: the attributes file .*info\/attributes isn't a plain file/);
  });

  it.each([
    ['a NUL in it', 'big.bin filter=evil\n\0\n'],
    ['itself marked -diff', 'big.bin filter=evil\n.gitattributes -diff\n'],
    ['a NUL in the name, where git stops reading it', 'big.bin filter=evil\0junk\n'],
  ])("pins the filter a .gitattributes grep would call binary picks, one with %s", async (_, attributes) => {
    const repo = tempRepo();
    const ran = join(tempDataDir(), 'ran');
    writeFileSync(join(repo, '.gitattributes'), attributes);
    writeFileSync(join(repo, 'big.bin'), 'content\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'attributes');
    rmSync(join(repo, 'big.bin'));
    const check = checked(await checkCheckoutConfig(repo, 'make a worktree', { trees: ['HEAD'] }));
    git(repo, 'config', 'filter.evil.smudge', `touch '${ran}'; cat`);
    expect((await runGit(repo, ['reset', '--quiet', '--hard'], undefined, check.env)).ok).toBe(true);
    expect(existsSync(ran)).toBe(false);
  });

  it("merges a file no attribute picks a driver for with git's own, not a merge.text.driver the repo's config names since", async () => {
    const repo = tempRepo();
    const ran = join(tempDataDir(), 'ran');
    const commit = (message: string) => git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-am', message);
    writeFileSync(join(repo, 'notes.txt'), 'one\ntwo\nthree\n');
    git(repo, 'add', '.');
    commit('notes');
    git(repo, 'checkout', '--quiet', '-b', 'side');
    writeFileSync(join(repo, 'notes.txt'), 'one\ntwo\nthree, said the side\n');
    commit('side');
    git(repo, 'checkout', '--quiet', '-');
    writeFileSync(join(repo, 'notes.txt'), 'one, said the base\ntwo\nthree\n');
    commit('base');
    const check = checked(await checkCheckoutConfig(repo, 'merge', { trees: ['HEAD', 'side'], worktree: true }));
    for (const name of ['text', 'union', 'binary']) git(repo, 'config', `merge.${name}.driver`, `touch '${ran}'; true`);
    const merged = await runGit(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'merge', '--quiet', '--no-edit', 'side'], undefined, check.env);
    expect(merged.ok).toBe(true);
    expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('one, said the base\ntwo\nthree, said the side\n');
    expect(existsSync(ran)).toBe(false);
    expect(await check.after()).toBeUndefined();
  });

  it('pins the filters an attributes file at a path relative to the worktree picks', async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, 'attributes'), 'big.bin filter=listed\n');
    git(repo, 'config', 'core.attributesFile', 'attributes');
    const check = checked(await checkCheckoutConfig(repo, 'make a worktree', { trees: [] }));
    expect(Object.values(check.env)).toEqual(expect.arrayContaining(['filter.listed.smudge', 'core.attributesFile', join(repo, 'attributes')]));
  });

  it("refuses when an attributes file is there but can't be read", async () => {
    const repo = tempRepo();
    const attributes = join(repo, '.git', 'info', 'attributes');
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(attributes, 'big.bin filter=hidden\n');
    chmodSync(attributes, 0o000);
    onTestFinished(() => chmodSync(attributes, 0o644));
    expect(refusal(await checkCheckoutConfig(repo, 'make a worktree', { trees: [] }))).toMatch(/could not read the attributes file/);
  });

  it('removes a worktree whose config came to name a program no pin holds as it was checked out', async () => {
    const repo = tempRepo();
    // The user's own filter, trusted, stands in for anything that writes the repo's config mid-checkout.
    git(repo, 'config', '--file', userGitConfig(), 'filter.mark.smudge', 'git config merge.unpicked.driver /bin/evil; cat');
    git(repo, 'checkout', '--quiet', '-b', 'marked');
    writeFileSync(join(repo, '.gitattributes'), 'big.bin filter=mark\n');
    writeFileSync(join(repo, 'big.bin'), 'content\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'marked');
    git(repo, 'checkout', '--quiet', '-');
    const worktree = agentWorktreePath(tempDataDir(), repo, 'agent');
    await expect(addWorktree(repo, worktree, 'agent', 'marked')).rejects.toThrow(/came to set merge\.unpicked\.driver as the board went to make a worktree/);
    expect(existsSync(worktree)).toBe(false);
  });
});

describe('pushBranch', () => {
  /**
   * A repo with a commit, and a bare repo here whose `pre-receive` hook leaves `marker` if it runs: the repo's origin,
   * named in the user's own config (`pushesTo`) unless `ownConfig`, where the repo's config names it, as an agent could.
   */
  function hookedOrigin(ownConfig = false, path = 'origin.git'): { repo: string; origin: string; marker: string } {
    const repo = tempRepo();
    const origin = join(tempDataDir(), path);
    mkdirSync(origin, { recursive: true });
    git(origin, 'init', '--quiet', '--bare');
    const marker = join(tempDataDir(), 'pre-receive-ran');
    script(join(origin, 'hooks', 'pre-receive'), `touch '${marker}'`);
    if (ownConfig) git(repo, 'remote', 'add', 'origin', origin);
    else {
      git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/web.git');
      pushesTo(origin, 'https://github.com/acme/web.git');
    }
    return { repo, origin, marker };
  }

  it("never pushes to a folder the repo's config names after the check, for a server's push", async () => {
    const { repo, origin, marker } = hookedOrigin(true);
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/web.git');
    gitWritesBefore('push --no-verify', repo, 'remote.origin.pushurl', origin);
    expect(await pushBranch(repo, 'origin', 'HEAD', 'feature')).toMatchObject({ ok: false, stderr: expect.stringMatching(/is a folder on this machine/) });
    expect(git(origin, 'branch', '--list')).toBe('');
    expect(existsSync(marker)).toBe(false);
  });

  it("fails, saying it went out, when the repo's config came to name a program no pin holds as it pushed", async () => {
    const repo = tempRepo();
    const origin = join(tempDataDir(), 'origin.git');
    mkdirSync(origin, { recursive: true });
    git(origin, 'init', '--quiet', '--bare');
    git(repo, 'remote', 'add', 'origin', 'ssh://example.invalid/acme/web.git');
    // The user's own ssh command, trusted, stands in for anything that writes the repo's config mid-push.
    const ssh = join(tempDataDir(), 'ssh');
    script(ssh, `git config lfs.customtransfer.evil.path /bin/evil; exec git-receive-pack '${origin}'`);
    git(repo, 'config', '--file', userGitConfig(), 'core.sshCommand', ssh);
    expect(await pushBranch(repo, 'origin', 'HEAD', 'feature')).toMatchObject({
      ok: false,
      stderr: expect.stringMatching(/^it went out, but .*came to set lfs\.customtransfer\.evil\.path as the board went to push/),
    });
    expect(git(origin, 'rev-parse', 'refs/heads/feature')).toBe(git(repo, 'rev-parse', 'HEAD'));
  });

  it("pushes to a folder the user's own config names, with that repo's hooks off", async () => {
    const { repo, origin, marker } = hookedOrigin();
    expect(await pushBranch(repo, 'origin', 'HEAD', 'feature')).toMatchObject({ ok: true });
    expect(git(origin, 'rev-parse', 'refs/heads/feature')).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ['a path', (origin: string) => origin],
    ['a file:// URL', (origin: string) => `file://${origin}`],
  ])("refuses a folder the repo's own config names, by %s, and runs none of its programs", async (_, url) => {
    const { repo, origin, marker } = hookedOrigin(true);
    git(repo, 'remote', 'set-url', 'origin', url(origin));
    expect(await pushBranch(repo, 'origin', 'HEAD', 'feature')).toMatchObject({ ok: false, stderr: expect.stringMatching(/is a folder on this machine.*won't push/) });
    expect(git(origin, 'branch', '--list')).toBe('');
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a folder whose path has :: in it, which git takes for a folder, not a remote helper", async () => {
    const { repo, origin, marker } = hookedOrigin(true, 'x::y/origin.git');
    expect(await pushBranch(repo, 'origin', 'HEAD', 'feature')).toMatchObject({ ok: false });
    expect(git(origin, 'branch', '--list')).toBe('');
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a folder the repo's own config rewrites a server's URL to", async () => {
    const { repo, origin, marker } = hookedOrigin(true);
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/web.git');
    git(repo, 'config', `url.${origin}.pushInsteadOf`, 'https://github.com/acme/web.git');
    expect(await pushBranch(repo, 'origin', 'HEAD', 'feature')).toMatchObject({ ok: false, stderr: expect.stringMatching(/is a folder on this machine/) });
    expect(existsSync(marker)).toBe(false);
  });

  it.each(['remotes', 'branches'])("refuses a folder named only in the repo's old .git/%s file, which isn't config", async (kind) => {
    const { repo, origin, marker } = hookedOrigin(true);
    const alternateRan = join(tempDataDir(), 'alternate-refs-ran');
    const listRefs = join(tempDataDir(), 'list-refs');
    script(listRefs, `touch '${alternateRan}'`);
    writeFileSync(join(origin, 'objects', 'info', 'alternates'), `${join(repo, '.git', 'objects')}\n`);
    git(origin, 'config', 'core.alternateRefsCommand', listRefs);
    git(repo, 'remote', 'remove', 'origin');
    mkdirSync(join(repo, '.git', kind), { recursive: true });
    writeFileSync(join(repo, '.git', kind, 'origin'), kind === 'remotes' ? `URL: ${origin}\nPush: HEAD\n` : `${origin}\n`);
    expect(git(repo, 'remote', 'get-url', '--push', 'origin')).toBe(origin);
    expect(await pushBranch(repo, 'origin', 'HEAD', 'feature')).toMatchObject({ ok: false, stderr: expect.stringMatching(/is a folder on this machine/) });
    expect(git(origin, 'branch', '--list')).toBe('');
    expect(existsSync(alternateRan) || existsSync(marker)).toBe(false);
  });

  it("refuses a folder past the one the user's own rewrite names, by ..", async () => {
    const { repo, origin, marker } = hookedOrigin(true, 'mirrors/acme/origin.git');
    const mirrors = join(origin, '..', '..');
    pushesTo(`${join(mirrors, 'acme')}/`, 'https://github.com/acme/');
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/../acme/origin.git');
    expect(git(repo, 'remote', 'get-url', '--push', 'origin')).toBe(`${join(mirrors, 'acme')}/../acme/origin.git`);
    expect(await pushBranch(repo, 'origin', 'HEAD', 'feature')).toMatchObject({ ok: false, stderr: expect.stringMatching(/is a folder on this machine/) });
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a %-encoded .. past a file:// folder the user's own rewrite names, which git decodes", async () => {
    const { repo, origin, marker } = hookedOrigin(true, 'mirrors/acme/origin.git');
    const acme = join(origin, '..');
    pushesTo(`file://${acme}/`, 'https://github.com/acme/');
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/%2e%2e/acme/origin.git');
    expect(git(repo, 'remote', 'get-url', '--push', 'origin')).toBe(`file://${acme}/%2e%2e/acme/origin.git`);
    expect(await pushBranch(repo, 'origin', 'HEAD', 'feature')).toMatchObject({ ok: false, stderr: expect.stringMatching(/is a folder on this machine/) });
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a sibling folder that only starts with the name of the one the user's own rewrite names", async () => {
    const { repo, origin, marker } = hookedOrigin(true, 'mirrors/acme-evil/origin.git');
    pushesTo(join(origin, '..', '..', 'acme'), 'https://github.com/acme');
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme-evil/origin.git');
    expect(git(repo, 'remote', 'get-url', '--push', 'origin')).toBe(origin);
    expect(await pushBranch(repo, 'origin', 'HEAD', 'feature')).toMatchObject({ ok: false, stderr: expect.stringMatching(/is a folder on this machine/) });
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a folder the user's own rewrite names that isn't a repo, where git would push to <folder>.git beside it", async () => {
    const { repo, origin, marker } = hookedOrigin(true, 'mirrors/acme.git');
    const folder = join(origin, '..', 'acme');
    pushesTo(folder, 'https://github.com/acme/web.git');
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/web.git');
    expect(git(repo, 'remote', 'get-url', '--push', 'origin')).toBe(folder);
    expect(await pushBranch(repo, 'origin', 'HEAD', 'feature')).toMatchObject({ ok: false, stderr: expect.stringMatching(/is a folder on this machine/) });
    expect(git(origin, 'branch', '--list')).toBe('');
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a remote with a local push URL, whatever its other push URLs", async () => {
    const { repo, origin } = hookedOrigin(true);
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/web.git');
    git(repo, 'remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/acme/web.git');
    git(repo, 'remote', 'set-url', '--add', '--push', 'origin', origin);
    expect(await pushBranch(repo, 'origin', 'HEAD', 'feature')).toMatchObject({ ok: false });
  });

  it('never signs, so the program a repo that asks for signed pushes names never runs', async () => {
    const { repo, origin } = hookedOrigin();
    const marker = join(tempDataDir(), 'signer-ran');
    const signer = join(tempDataDir(), 'signer');
    script(signer, `touch '${marker}'; exit 1`);
    git(repo, 'config', 'push.gpgSign', 'true');
    git(repo, 'config', 'gpg.program', signer);
    expect(await pushBranch(repo, 'origin', 'HEAD', 'feature')).toMatchObject({ ok: true });
    expect(git(origin, 'branch', '--list')).toContain('feature');
    expect(existsSync(marker)).toBe(false);
  });

  it("pushes nothing when the repo's own config names a program, saying which", async () => {
    const { repo, origin } = hookedOrigin();
    git(repo, 'config', 'core.sshCommand', './evil');
    expect(await pushBranch(repo, 'origin', 'HEAD', 'feature')).toMatchObject({ ok: false, stderr: expect.stringMatching(/core\.sshcommand/) });
    expect(git(origin, 'branch', '--list')).toBe('');
  });
});

describe('isLocalRemoteUrl', () => {
  it.each([
    ['/srv/repos/web.git', true],
    ['../web.git', true],
    ['file:///srv/repos/web.git', true],
    ['./dir:with-colon', true],
    ['git@github.com:acme/web.git', false],
    ['github.com:acme/web.git', false],
    ['ssh://git@github.com/acme/web.git', false],
    ['https://github.com/acme/web.git', false],
    ['ext::sh -c evil', false],
    ['/tmp/x::y/origin.git', true],
    ['./x::y', true],
  ])('%s: %s', (url, local) => {
    expect(isLocalRemoteUrl(url)).toBe(local);
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

describe("the filters a repo's own config names, which the daemon's reads of a worktree turn off", () => {
  /**
   * A repo whose committed `.gitattributes` puts `notes.txt` through filter `name`, with `notes.txt` changed since but
   * the same size, so git must hash it again to tell.
   */
  function filteredRepo(name: string): string {
    const repo = tempRepo();
    writeFileSync(join(repo, '.gitattributes'), `notes.txt filter=${name}\n`);
    writeFileSync(join(repo, 'notes.txt'), 'first\n');
    git(repo, 'add', '.gitattributes', 'notes.txt');
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--no-verify', '-m', 'filtered');
    writeFileSync(join(repo, 'notes.txt'), 'later\n');
    return repo;
  }

  it.each(['clean', 'process'])("runs no %s program the repo's config names on a status, even a required one", async (setting) => {
    const repo = filteredRepo('evil');
    const marker = join(tempDataDir(), 'filtered');
    git(repo, 'config', `filter.evil.${setting}`, `touch '${marker}'; cat`);
    git(repo, 'config', 'filter.evil.required', 'true');
    const status = await runGit(repo, ['status', '--porcelain'], undefined, {}, { repoFiltersOff: true });
    expect(status).toMatchObject({ ok: true, stdout: 'M notes.txt' });
    expect(existsSync(marker)).toBe(false);
    // The same read with the repo's filters on runs it.
    await runGit(repo, ['status', '--porcelain']);
    expect(existsSync(marker)).toBe(true);
  });

  it("turns off one a worktree's own config names, keeping the settings a caller passes", async () => {
    const repo = filteredRepo('evil');
    const marker = join(tempDataDir(), 'filtered');
    git(repo, 'config', 'extensions.worktreeConfig', 'true');
    git(repo, 'config', '--worktree', 'filter.evil.clean', `touch '${marker}'; cat`);
    const caller = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'color.ui', GIT_CONFIG_VALUE_0: 'never' };
    expect(await runGit(repo, ['status', '--porcelain'], undefined, caller, { repoFiltersOff: true })).toMatchObject({ ok: true, stdout: 'M notes.txt' });
    expect(existsSync(marker)).toBe(false);
    expect(await runGit(repo, ['config', '--get', 'color.ui'], undefined, caller, { repoFiltersOff: true })).toMatchObject({ ok: true, stdout: 'never' });
  });

  it('turns off a filter whose name holds a dot and an equals sign', async () => {
    const repo = filteredRepo('a.b=c');
    const marker = join(tempDataDir(), 'filtered');
    git(repo, 'config', 'filter.a.b=c.clean', `touch '${marker}'; cat`);
    expect(await runGit(repo, ['diff', 'HEAD', '--name-only'], undefined, {}, { repoFiltersOff: true })).toMatchObject({ ok: true, stdout: 'notes.txt' });
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps the user's own filter, even one the repo's config sets again", async () => {
    const repo = filteredRepo('mine');
    const [mine, evil] = [join(tempDataDir(), 'mine'), join(tempDataDir(), 'evil')];
    git(repo, 'config', '--file', userGitConfig(), 'filter.mine.clean', `touch '${mine}'; cat`);
    git(repo, 'config', 'filter.mine.clean', `touch '${evil}'; cat`);
    await runGit(repo, ['status', '--porcelain'], undefined, {}, { repoFiltersOff: true });
    expect([existsSync(mine), existsSync(evil)]).toEqual([true, false]);
  });

  it("turns Git LFS's filter off, the user's own too, when the repo's config sets an extension it would run", async () => {
    const repo = filteredRepo('lfs');
    const marker = join(tempDataDir(), 'lfs-ran');
    // A stand-in for git-lfs, which would run the extension for the file it cleans.
    git(repo, 'config', '--file', userGitConfig(), 'filter.lfs.clean', `touch '${marker}'; cat`);
    git(repo, 'config', '--file', userGitConfig(), 'filter.lfs.required', 'true');
    git(repo, 'config', 'lfs.extension.evil.clean', './evil %f');
    expect(await runGit(repo, ['status', '--porcelain'], undefined, {}, { repoFiltersOff: true })).toMatchObject({ ok: true, stdout: 'M notes.txt' });
    expect(existsSync(marker)).toBe(false);
    git(repo, 'config', '--unset', 'lfs.extension.evil.clean');
    await runGit(repo, ['status', '--porcelain'], undefined, {}, { repoFiltersOff: true });
    expect(existsSync(marker)).toBe(true);
  });

  it("turns off a filter Git LFS's values name under another case of its name, which isn't Git LFS's own", async () => {
    const repo = filteredRepo('LFS');
    git(repo, 'config', 'filter.LFS.clean', 'git-lfs clean -- %f');
    git(repo, 'config', 'filter.LFS.required', 'true');
    expect(await repoFiltersOffEnv(repo)).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'filter.LFS.clean',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'filter.LFS.required',
      GIT_CONFIG_VALUE_1: 'false',
    });
  });

  it("leaves Git LFS's own filter on, as it installs itself in the repo, and adds to the settings the daemon inherited", async () => {
    const repo = tempRepo();
    git(repo, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f');
    git(repo, 'config', 'filter.lfs.smudge', 'git-lfs smudge -- %f');
    git(repo, 'config', 'filter.lfs.process', 'git-lfs filter-process');
    git(repo, 'config', 'filter.lfs.required', 'true');
    expect(await repoFiltersOffEnv(repo)).toEqual({});

    git(repo, 'config', 'filter.evil.smudge', './evil');
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'color.ui');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'never');
    onTestFinished(() => void vi.unstubAllEnvs());
    expect(await repoFiltersOffEnv(repo)).toEqual({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_1: 'filter.evil.smudge',
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'filter.evil.required',
      GIT_CONFIG_VALUE_2: 'false',
    });
  });
});
