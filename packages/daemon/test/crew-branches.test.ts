// A crew's own branch and worktree (ADR-0026), on temporary repos: cut from the builder's branch, makers' branches
// merged into it with --no-ff, a conflict aborted with the files it was in, and removed with the crew.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeGitHub, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import { gitCrewBranches, openCrewPullRequest, upstreamMakers } from '../src/crew-branches.ts';
import type { PrefabLine } from '../src/protocol.ts';
import { git, gitWritesBefore, pushesTo, tempDataDir, tempRepo, userGitConfig } from './helpers.ts';

/** A repo with a branch for each maker, `api` and `ui`, cut from its first commit, and a committer of its own. */
function makersRepo() {
  const repo = tempRepo();
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'branch', '-M', 'main');
  for (const branch of ['api', 'ui']) git(repo, 'branch', branch);
  return repo;
}

/** Commits `text` to `file` on `branch`, in the repo's own checkout. */
function commit(repo: string, branch: string, file: string, text: string) {
  git(repo, 'checkout', '--quiet', branch);
  writeFileSync(join(repo, file), text);
  git(repo, 'add', file);
  git(repo, 'commit', '--quiet', '-m', `${branch}: ${file}`);
  git(repo, 'checkout', '--quiet', 'main');
}

describe("a crew's branch", () => {
  it('is cut from the builder branch, in a worktree of its own, its name free in the repo', async () => {
    const repo = makersRepo();
    git(repo, 'branch', 'api-crew');
    const branches = gitCrewBranches(tempDataDir());
    const crew = await branches.cut(repo, 'api');
    expect(crew.branch).toBe('api-crew-2');
    expect(crew.repoRoot).toBe(repo);
    expect(git(crew.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('api-crew-2');
    expect(git(repo, 'rev-parse', 'api-crew-2')).toBe(git(repo, 'rev-parse', 'api'));
  });

  it('is cut where it was placed, and found there after a restart: never cut twice', async () => {
    const repo = makersRepo();
    const branches = gitCrewBranches(tempDataDir());
    const placed = await branches.place(repo, 'api');
    expect(existsSync(placed.worktree)).toBe(false);
    expect(await branches.cut(repo, 'api', placed)).toEqual(placed);
    // As a daemon that stopped after cutting it, before it saved so, cuts it again.
    expect(await branches.cut(repo, 'api', placed)).toEqual(placed);
    expect(git(repo, 'branch', '--list', '--format=%(refname:short)', 'api-crew*')).toBe('api-crew');
    // Its worktree gone, as a user may remove it: checked out again, on the branch it has.
    git(repo, 'worktree', 'remove', '--force', placed.worktree);
    expect(await branches.cut(repo, 'api', placed)).toEqual(placed);
    expect(git(placed.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('api-crew');
  });

  it("merges a maker's branch with a merge commit, and says when there is nothing new to merge", async () => {
    const repo = makersRepo();
    commit(repo, 'api', 'api.ts', 'export const api = 1;\n');
    const branches = gitCrewBranches(tempDataDir());
    const crew = await branches.cut(repo, 'main');

    expect(await branches.merge(crew, 'api', 'Merge api into the crew branch')).toEqual({ merged: true, files: expect.any(Array) });
    expect(git(crew.worktree, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2);
    expect(git(crew.worktree, 'log', '-1', '--format=%s')).toBe('Merge api into the crew branch');
    expect(existsSync(join(crew.worktree, 'api.ts'))).toBe(true);
    expect(await branches.merge(crew, 'api', 'Merge api again')).toEqual({ merged: false });
  });

  it('aborts a merge that conflicts, naming the files, and leaves the crew branch as it was', async () => {
    const repo = makersRepo();
    commit(repo, 'api', 'shared.ts', 'export const a = 1;\n');
    commit(repo, 'ui', 'shared.ts', 'export const a = 2;\n');
    commit(repo, 'ui', 'ui.ts', 'export {};\n');
    const branches = gitCrewBranches(tempDataDir());
    const crew = await branches.cut(repo, 'main');
    await branches.merge(crew, 'api', 'Merge api');
    const before = git(crew.worktree, 'rev-parse', 'HEAD');

    expect(await branches.merge(crew, 'ui', 'Merge ui')).toEqual({ conflicts: ['shared.ts'] });
    expect(git(crew.worktree, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(crew.worktree, 'status', '--porcelain')).toBe('');
  });

  it("says why it couldn't merge a branch that isn't there", async () => {
    const branches = gitCrewBranches(tempDataDir());
    const crew = await branches.cut(makersRepo(), 'main');
    expect(await branches.merge(crew, 'gone', 'Merge gone')).toEqual({ error: expect.stringMatching(/gone/) });
  });

  it('finishes a merge left half-done (a daemon stopped mid-merge) before merging the next, never blaming that one', async () => {
    const repo = makersRepo();
    commit(repo, 'api', 'shared.ts', 'export const a = 1;\n');
    commit(repo, 'ui', 'shared.ts', 'export const a = 2;\n');
    git(repo, 'branch', 'docs', 'main');
    commit(repo, 'docs', 'docs.md', '# Docs\n');
    const branches = gitCrewBranches(tempDataDir());
    const crew = await branches.cut(repo, 'main');
    await branches.merge(crew, 'api', 'Merge api');
    // As a daemon stopped between a conflicting merge and its abort leaves it.
    expect(() => git(crew.worktree, 'merge', '--no-ff', '--no-edit', 'ui')).toThrow();

    expect(await branches.merge(crew, 'docs', 'Merge docs')).toEqual({ merged: true, files: expect.any(Array) });
    expect(git(crew.worktree, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(crew.worktree, 'docs.md'))).toBe(true);
  });

  it('merges beside changes in files the merge leaves alone, and waits on changes in files it touches', async () => {
    const repo = makersRepo();
    commit(repo, 'api', 'api.ts', 'export const api = 1;\n');
    commit(repo, 'ui', 'ui.ts', 'export const ui = 1;\n');
    const branches = gitCrewBranches(tempDataDir());
    const crew = await branches.cut(repo, 'main');
    // A member's work in progress, staged as an agent might: the merge goes on beside it, and leaves it uncommitted.
    writeFileSync(join(crew.worktree, 'notes.md'), 'in progress\n');
    git(crew.worktree, 'add', 'notes.md');
    expect(await branches.merge(crew, 'api', 'Merge api')).toEqual({ merged: true, files: ['api.ts'] });
    expect(git(crew.worktree, 'log', '-1', '--format=%s')).toBe('Merge api');
    expect(git(crew.worktree, 'show', '--name-only', '--format=', 'HEAD')).not.toMatch(/notes\.md/);
    expect(git(crew.worktree, 'status', '--porcelain')).toBe('?? notes.md');

    // One in a file the merge would bring in waits, its worktree as it was.
    writeFileSync(join(crew.worktree, 'ui.ts'), 'mine\n');
    const before = git(crew.worktree, 'rev-parse', 'HEAD');
    expect(await branches.merge(crew, 'ui', 'Merge ui')).toEqual({ waits: ['ui.ts'] });
    expect(git(crew.worktree, 'rev-parse', 'HEAD')).toBe(before);
    expect(readFileSync(join(crew.worktree, 'ui.ts'), 'utf8')).toBe('mine\n');
  });

  it('waits on a change in a file whose name git would quote', async () => {
    const repo = makersRepo();
    commit(repo, 'api', 'é.md', 'from api\n');
    const branches = gitCrewBranches(tempDataDir());
    const crew = await branches.cut(repo, 'main');
    writeFileSync(join(crew.worktree, 'é.md'), 'mine\n');
    expect(await branches.merge(crew, 'api', 'Merge api')).toEqual({ waits: ['é.md'] });
    expect(await branches.uncommitted(crew.worktree)).toEqual(['é.md']);
  });

  it("lists a maker's uncommitted changes, but for the board's own files", async () => {
    const repo = makersRepo();
    const branches = gitCrewBranches(tempDataDir());
    const maker = await branches.cut(repo, 'api');
    expect(await branches.uncommitted(maker.worktree)).toEqual([]);
    mkdirSync(join(maker.worktree, '.agent-board'));
    writeFileSync(join(maker.worktree, '.agent-board', 'handover.md'), 'Done\n');
    expect(await branches.uncommitted(maker.worktree)).toEqual([]);
    writeFileSync(join(maker.worktree, 'ui.ts'), 'export {};\n');
    expect(await branches.uncommitted(maker.worktree)).toEqual(['ui.ts']);
  });

  it('keeps a branch on removal while it holds commits no other branch or remote has, and says why', async () => {
    const repo = makersRepo();
    commit(repo, 'api', 'api.ts', 'export const api = 1;\n');
    const branches = gitCrewBranches(tempDataDir());
    const crew = await branches.cut(repo, 'main');
    await branches.merge(crew, 'api', 'Merge api');
    // Its maker's branch gone, as a close takes it once its commits are on the crew branch.
    git(repo, 'branch', '-D', 'api');

    expect(await branches.remove(crew, false)).toEqual({ why: expect.stringMatching(/commit/), worktree: false });
    expect(existsSync(crew.worktree)).toBe(false);
    expect(git(repo, 'branch', '--list', crew.branch)).not.toBe('');
  });

  it('keeps its worktree and branch on removal while the worktree has uncommitted changes, and says so', async () => {
    const repo = makersRepo();
    const branches = gitCrewBranches(tempDataDir());
    const crew = await branches.cut(repo, 'api');
    writeFileSync(join(crew.worktree, 'notes.md'), 'not committed\n');
    expect(await branches.remove(crew, false)).toEqual({ why: expect.stringMatching(/uncommitted changes in 1 file: notes\.md/), worktree: true });
    expect(readFileSync(join(crew.worktree, 'notes.md'), 'utf8')).toBe('not committed\n');
    expect(git(repo, 'branch', '--list', crew.branch)).not.toBe('');
    // Asked to keep its branch, it keeps the worktree too.
    expect(await branches.remove(crew, true)).toMatchObject({ worktree: true });
    expect(existsSync(crew.worktree)).toBe(true);
  });

  it('is removed with its worktree, or keeps its branch when asked', async () => {
    const repo = makersRepo();
    const branches = gitCrewBranches(tempDataDir());
    const kept = await branches.cut(repo, 'api');
    expect(await branches.remove(kept, true)).toBeUndefined();
    expect(existsSync(kept.worktree)).toBe(false);
    expect(git(repo, 'branch', '--list', kept.branch)).not.toBe('');

    const gone = await branches.cut(repo, 'ui');
    expect(await branches.remove(gone, false)).toBeUndefined();
    expect(existsSync(gone.worktree)).toBe(false);
    expect(git(repo, 'branch', '--list', gone.branch)).toBe('');
  });
});

/** Commits hooks to `branch` that each leave a mark in `marks`, in a repo whose hooks path is in its tree, as husky's is. */
function commitHooks(repo: string, branch: string, marks: string) {
  git(repo, 'config', 'core.hooksPath', '.hooks');
  git(repo, 'checkout', '--quiet', branch);
  mkdirSync(join(repo, '.hooks'));
  for (const hook of ['pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-merge', 'pre-push', 'post-checkout']) {
    writeFileSync(join(repo, '.hooks', hook), `#!/bin/sh\ntouch "${marks}/${hook}"\n`);
    chmodSync(join(repo, '.hooks', hook), 0o755);
  }
  git(repo, 'add', '.hooks');
  git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', `${branch}: hooks`);
  git(repo, 'checkout', '--quiet', 'main');
}

describe("a maker's own git hooks", () => {
  it("never run as the crew merges the maker's branch", async () => {
    const repo = makersRepo();
    const marks = tempDataDir();
    commitHooks(repo, 'api', marks);
    const branches = gitCrewBranches(tempDataDir());
    const crew = await branches.cut(repo, 'main');
    expect(await branches.merge(crew, 'api', 'Merge api')).toEqual({ merged: true, files: expect.any(Array) });
    expect(existsSync(join(crew.worktree, '.hooks', 'post-merge'))).toBe(true);
    for (const hook of ['pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-merge']) expect(existsSync(join(marks, hook)), hook).toBe(false);
  });

  it('never run as the crew pushes its branch for its pull request', async () => {
    const repo = makersRepo();
    const origin = tempDataDir();
    execFileSync('git', ['init', '--quiet', '--bare', origin]);
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/web.git');
    pushesTo(origin, 'https://github.com/acme/web.git');
    const marks = tempDataDir();
    commitHooks(repo, 'api', marks);
    const branches = gitCrewBranches(tempDataDir());
    const crew = await branches.cut(repo, 'main');
    await branches.merge(crew, 'api', 'Merge api');
    const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, repos: [{ nameWithOwner: 'acme/web', description: null }] });
    await openCrewPullRequest(crew, { gh: github.gh, repo: 'acme/web', title: 'Add a footer', body: 'Its branches' });
    expect(git(origin, 'rev-parse', `refs/heads/${crew.branch}`)).toBe(git(repo, 'rev-parse', crew.branch));
    expect(existsSync(join(marks, 'pre-push'))).toBe(false);
  });
});

describe("the programs the repo's own config names", () => {
  /** A script that leaves `marker` when run: the program an agent could point the repo's config at. */
  function evil(marker: string): string {
    const path = join(tempDataDir(), 'evil');
    writeFileSync(path, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("never sign the crew's merge, so a gpg.program the repo names never runs", async () => {
    const repo = makersRepo();
    const marker = join(tempDataDir(), 'signed');
    commit(repo, 'api', 'api.ts', 'export const api = 1;\n');
    git(repo, 'config', 'commit.gpgSign', 'true');
    git(repo, 'config', 'gpg.program', evil(marker));
    const branches = gitCrewBranches(tempDataDir());
    const crew = await branches.cut(repo, 'main');
    expect(await branches.merge(crew, 'api', 'Merge api')).toEqual({ merged: true, files: ['api.ts'] });
    expect(existsSync(marker)).toBe(false);
  });

  it("refuse the crew's push when the repo names its own ssh command, which never runs", async () => {
    const repo = makersRepo();
    const marker = join(tempDataDir(), 'ssh-ran');
    git(repo, 'remote', 'add', 'origin', 'ssh://example.invalid/acme/web.git');
    git(repo, 'config', 'core.sshCommand', evil(marker));
    const crew = await gitCrewBranches(tempDataDir()).cut(repo, 'main');
    const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, repos: [{ nameWithOwner: 'acme/web', description: null }] });
    await expect(openCrewPullRequest(crew, { gh: github.gh, repo: 'acme/web', title: 'Add a footer', body: 'Its branches' })).rejects.toThrow(
      /could not push .*core\.sshcommand.*won't push/,
    );
    expect(existsSync(marker)).toBe(false);
    expect(github.state().pullRequests).toHaveLength(0);
  });

  it("refuse the crew's merge when the repo names its own merge driver, which never runs on a conflict", async () => {
    const repo = makersRepo();
    const marker = join(tempDataDir(), 'driver-ran');
    commit(repo, 'main', '.gitattributes', '* merge=evil\n');
    git(repo, 'branch', '-f', 'api', 'main');
    git(repo, 'branch', '-f', 'ui', 'main');
    commit(repo, 'api', 'shared.ts', 'export const by = "api";\n');
    commit(repo, 'ui', 'shared.ts', 'export const by = "ui";\n');
    const branches = gitCrewBranches(tempDataDir());
    const crew = await branches.cut(repo, 'api');
    // Set after the cut, as an agent could from its worktree, in the config every worktree shares.
    git(repo, 'config', 'merge.evil.driver', evil(marker));
    expect(await branches.merge(crew, 'ui', 'Merge ui')).toEqual({ error: expect.stringMatching(/sets merge\.evil\.driver.*won't merge/) });
    expect(existsSync(marker)).toBe(false);
    expect(git(crew.worktree, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'api'));
  });

  it('refuse to check the crew branch out again when the repo names its own filter, which never runs', async () => {
    const repo = makersRepo();
    const marker = join(tempDataDir(), 'smudged');
    commit(repo, 'api', '.gitattributes', '* filter=evil\n');
    const branches = gitCrewBranches(tempDataDir());
    const crew = await branches.cut(repo, 'api');
    git(repo, 'worktree', 'remove', '--force', crew.worktree);
    git(repo, 'config', 'filter.evil.smudge', `touch '${marker}'; cat`);
    await expect(branches.cut(repo, 'api', crew)).rejects.toThrow(/could not check out its crew branch .* again: .*filter\.evil\.smudge/);
    expect(existsSync(crew.worktree)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(git(repo, 'rev-parse', crew.branch)).toBe(git(repo, 'rev-parse', 'api'));
  });

  it('is checked out again, not taken up, when its worktree was made but never checked out', async () => {
    const repo = makersRepo();
    const branches = gitCrewBranches(tempDataDir());
    const crew = await branches.place(repo, 'api');
    // As a daemon that stopped between the worktree's add and its checkout left it.
    git(repo, 'worktree', 'add', '--quiet', '--no-checkout', '-b', crew.branch, crew.worktree, 'api');
    expect(await branches.cut(repo, 'api', crew)).toEqual(crew);
    expect(git(crew.worktree, 'status', '--porcelain')).toBe('');
    // Its index is HEAD's, not missing: a worktree never checked out would show every file deleted.
    expect(git(crew.worktree, 'diff', '--cached', '--name-only', 'HEAD')).toBe('');
    expect(git(crew.worktree, 'ls-tree', '--name-only', 'HEAD')).not.toBe('');
  });

  it('is taken up as it is when its index was emptied, keeping the work in it', async () => {
    const repo = makersRepo();
    const branches = gitCrewBranches(tempDataDir());
    const crew = await branches.cut(repo, 'api');
    writeFileSync(join(crew.worktree, 'work.ts'), 'uncommitted\n');
    git(crew.worktree, 'rm', '-r', '--cached', '--quiet', '.');
    expect(await branches.cut(repo, 'api', crew)).toEqual(crew);
    expect(readFileSync(join(crew.worktree, 'work.ts'), 'utf8')).toBe('uncommitted\n');
  });

  it('refuse to cut the crew branch when the repo names its own filter', async () => {
    const repo = makersRepo();
    git(repo, 'config', 'filter.evil.smudge', 'cat');
    await expect(gitCrewBranches(tempDataDir()).cut(repo, 'api')).rejects.toThrow(/filter\.evil\.smudge.*won't make a worktree/);
  });
});

describe("a key the repo's own config comes to set as the crew merges", () => {
  /**
   * A crew branch cut from `api`, and `ui` to merge into it, both changing `notes.txt`, which `merge=evil` picks, and
   * `m.txt`, whose driver (`mark`, in the user's own config) runs `then` as it merges.
   */
  async function mergingCrew(then = 'true') {
    const repo = makersRepo();
    const driver = join(tempDataDir(), 'mark');
    writeFileSync(driver, `#!/bin/sh\n${then}\nexec git merge-file "$2" "$1" "$3"\n`);
    chmodSync(driver, 0o755);
    git(repo, 'config', '--file', userGitConfig(), 'merge.mark.driver', `${driver} %O %A %B`);
    const files = ['m.txt', 'notes.txt'];
    commit(repo, 'main', '.gitattributes', 'm.txt merge=mark\nnotes.txt merge=evil\n');
    for (const file of files) commit(repo, 'main', file, 'one\ntwo\nthree\n');
    git(repo, 'branch', '-f', 'api', 'main');
    git(repo, 'branch', '-f', 'ui', 'main');
    for (const file of files) commit(repo, 'api', file, 'one, said api\ntwo\nthree\n');
    for (const file of files) commit(repo, 'ui', file, 'one\ntwo\nthree, said ui\n');
    const branches = gitCrewBranches(tempDataDir());
    return { repo, branches, crew: await branches.cut(repo, 'api') };
  }

  it("merges with git's own merge, not a driver it names after the check", async () => {
    const marker = join(tempDataDir(), 'driver-ran');
    const evil = join(tempDataDir(), 'evil');
    writeFileSync(evil, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
    chmodSync(evil, 0o755);
    const { repo, branches, crew } = await mergingCrew();
    gitWritesBefore('merge --no-ff', repo, 'merge.evil.driver', evil);
    expect(await branches.merge(crew, 'ui', 'Merge ui')).toEqual({ merged: true, files: expect.any(Array) });
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(crew.worktree, 'notes.txt'), 'utf8')).toBe('one, said api\ntwo\nthree, said ui\n');
  });

  it('says so, merged, when the key is one no pin holds', async () => {
    const { branches, crew } = await mergingCrew("git config merge.unpicked.driver /bin/evil");
    expect(await branches.merge(crew, 'ui', 'Merge ui')).toEqual({ error: expect.stringMatching(/^ui merged, but .*came to set merge\.unpicked\.driver as the board went to merge/) });
  });
});

describe("the crew's pull request", () => {
  it('is the one open already of the crew branch, as a daemon that stopped before saving it finds it again', async () => {
    const repo = makersRepo();
    const origin = tempDataDir();
    execFileSync('git', ['init', '--quiet', '--bare', origin]);
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/web.git');
    pushesTo(origin, 'https://github.com/acme/web.git');
    const crew = await gitCrewBranches(tempDataDir()).cut(repo, 'main');
    const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, repos: [{ nameWithOwner: 'acme/web', description: null }] });
    const options = { gh: github.gh, repo: 'acme/web', title: 'Add a footer', body: 'Its branches' };
    const url = await openCrewPullRequest(crew, options);
    expect(await openCrewPullRequest(crew, options)).toBe(url);
    expect(github.state().pullRequests).toHaveLength(1);
  });
});

describe('the makers upstream of a member', () => {
  const lines: PrefabLine[] = [
    { from: 'prompt', to: 'api' },
    { from: 'api', to: 'ui', carries: 'handoff' },
    { from: 'api', to: 'api-review', carries: 'handoff' },
    { from: 'api-review', to: 'loop', carries: 'review' },
    { from: 'loop', to: 'api', way: 'again' },
    { from: 'ui', to: 'ui-review', carries: 'handoff' },
    { from: 'loop', to: 'end', way: 'done' },
    { from: 'ui-review', to: 'end', carries: 'review' },
  ];
  const makers = new Set(['api', 'ui']);

  it('are the nearest makers back along its lines, through loop gates, never along a way back', () => {
    expect(upstreamMakers(lines, makers, 'api-review')).toEqual(['api']);
    expect(upstreamMakers(lines, makers, 'ui-review')).toEqual(['ui']);
    expect(upstreamMakers(lines, makers, 'loop')).toEqual(['api']);
    expect(upstreamMakers(lines, makers, 'ui')).toEqual(['api']);
    expect(upstreamMakers(lines, makers, 'end').sort()).toEqual(['api', 'ui']);
    expect(upstreamMakers(lines, makers, 'api')).toEqual([]);
  });
});
