// A crew worktree shared by several members, on temporary repos: whose a path is, what changed, a member's files
// committed under its name with no index, and uncommitted work recorded and put back.
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  branchHead,
  changedFiles,
  commitPaths,
  editedFiles,
  filesBetween,
  gitSharedWorktree,
  ownerOf,
  ownsPath,
  lostWork,
  recordWork,
  restoreWork,
  throughSymlink,
} from '../src/crew-worktree.ts';
import { git, tempDataDir, tempRepo } from './helpers.ts';

/** A repo on `main` with a committer of its own and three committed files beside the template's. */
function crewRepo() {
  const repo = tempRepo();
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'branch', '-M', 'main');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  for (const file of ['docs/outline.md', 'docs/plan.md', 'README.md']) writeFileSync(join(repo, file), `${file}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'files');
  return repo;
}

const write = (repo: string, file: string, text: string) => writeFileSync(join(repo, file), text);

describe('whose a path is', () => {
  it('holds a file equal to a file entry or under a folder entry, case-insensitively', () => {
    expect(ownsPath(['docs/outline.md'], 'Docs/Outline.MD')).toBe(true);
    expect(ownsPath(['docs/outline.md'], 'docs/outline.md.bak')).toBe(false);
    expect(ownsPath(['Mocks/'], 'mocks/a/b.html')).toBe(true);
    expect(ownsPath(['mocks/'], 'mocksmore/b.html')).toBe(false);
    // A file entry names a file, not a folder of that name.
    expect(ownsPath(['mocks'], 'mocks/b.html')).toBe(false);
    expect(ownsPath([], 'a')).toBe(false);
    // A name as macOS spells it, decomposed, is the same name.
    expect(ownsPath(['docs/\u00e9.md'], 'docs/e\u0301.md')).toBe(true);
    expect(ownsPath(['d\u00e9cor/'], 'de\u0301cor/a.md')).toBe(true);
  });

  it("is the member whose writes hold it, or nobody's", () => {
    const sharers = [
      { member: 'designer', writes: ['mocks/', 'docs/outline.md'] },
      { member: 'planner', writes: ['docs/plan.md'] },
    ];
    expect(ownerOf('MOCKS/home.html', sharers)).toBe('designer');
    expect(ownerOf('docs/plan.md', sharers)).toBe('planner');
    expect(ownerOf('README.md', sharers)).toBeNull();
  });
});

describe('what changed in the worktree', () => {
  it("lists modified, deleted, added and untracked files, never ignored ones or the board's own", async () => {
    const repo = crewRepo();
    write(repo, '.gitignore', 'build/\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '--quiet', '-m', 'ignore');
    write(repo, 'docs/outline.md', 'changed\n');
    rmSync(join(repo, 'docs/plan.md'));
    write(repo, 'staged.md', 'new\n');
    git(repo, 'add', 'staged.md');
    mkdirSync(join(repo, 'mocks/deep'), { recursive: true });
    write(repo, 'mocks/deep/a b.html', 'untracked\n');
    write(repo, ' leading space.md', 'odd\n');
    mkdirSync(join(repo, 'build'));
    write(repo, 'build/out.js', 'ignored\n');
    mkdirSync(join(repo, '.agent-board'));
    write(repo, '.agent-board/status.json', '{}\n');
    expect(await changedFiles(repo)).toEqual([' leading space.md', 'docs/outline.md', 'docs/plan.md', 'mocks/deep/a b.html', 'staged.md']);
  });

  it('is nothing in a clean worktree', async () => {
    expect(await changedFiles(crewRepo())).toEqual([]);
  });
});

describe('a path through a symbolic link', () => {
  it('is any existing part of it a link, the path itself included', async () => {
    const repo = crewRepo();
    const outside = tempDataDir();
    symlinkSync(outside, join(repo, 'linked'));
    symlinkSync(join(repo, 'README.md'), join(repo, 'readme-link'));
    expect(await throughSymlink(repo, 'linked/file.md')).toBe(true);
    expect(await throughSymlink(repo, 'readme-link')).toBe(true);
    expect(await throughSymlink(repo, 'docs/outline.md')).toBe(false);
    expect(await throughSymlink(repo, 'missing/folder/file.md')).toBe(false);
  });
});

describe("a member's commit", () => {
  it("commits only the given files, under the member's name, leaving what anyone staged staged", async () => {
    const repo = crewRepo();
    const before = git(repo, 'rev-parse', 'HEAD');
    write(repo, 'docs/outline.md', 'the design\n');
    rmSync(join(repo, 'docs/plan.md'));
    write(repo, 'README.md', 'staged by someone else\n');
    git(repo, 'add', '-A');
    const made = await commitPaths({ worktree: repo, branch: 'main', files: ['docs/outline.md', 'docs/plan.md'], author: 'designer', message: 'designer: design' });
    expect(made).toEqual({ commit: git(repo, 'rev-parse', 'HEAD'), files: ['docs/outline.md', 'docs/plan.md'] });
    expect(git(repo, 'rev-parse', 'HEAD~1')).toBe(before);
    expect(git(repo, 'log', '-1', '--format=%an|%ae|%cn|%s')).toBe('designer|test@example.com|Test|designer: design');
    expect(git(repo, 'diff-tree', '--no-commit-id', '--name-status', '-r', 'HEAD')).toBe('M\tdocs/outline.md\nD\tdocs/plan.md');
    // The shared index holds the commit's versions of those files, and the other change still staged.
    expect(git(repo, 'status', '--porcelain')).toBe('M  README.md');
    expect(git(repo, 'show', 'HEAD:docs/outline.md')).toBe('the design');
  });

  it('commits a new file, and a file made and deleted since adds nothing', async () => {
    const repo = crewRepo();
    write(repo, 'notes.md', 'new\n');
    const made = await commitPaths({ worktree: repo, branch: 'main', files: ['notes.md', 'gone.md'], author: 'planner', message: 'planner: notes' });
    expect(made).toMatchObject({ files: ['gone.md', 'notes.md'] });
    expect(git(repo, 'diff-tree', '--no-commit-id', '--name-status', '-r', 'HEAD')).toBe('A\tnotes.md');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('is nothing when the files match HEAD, or none are given', async () => {
    const repo = crewRepo();
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(await commitPaths({ worktree: repo, branch: 'main', files: ['README.md'], author: 'planner', message: 'm' })).toEqual({ nothing: true });
    expect(await commitPaths({ worktree: repo, branch: 'main', files: [], author: 'planner', message: 'm' })).toEqual({ nothing: true });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('falls back to a board identity in a repo with none of its own', async () => {
    const repo = tempRepo();
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    write(repo, 'apps/web/index.ts', 'export const x = 1;\n');
    const branch = git(repo, 'symbolic-ref', '--short', 'HEAD');
    expect(await commitPaths({ worktree: repo, branch, files: ['apps/web/index.ts'], author: 'designer', message: 'm' })).toHaveProperty('commit');
    expect(git(repo, 'log', '-1', '--format=%an|%ae|%cn|%ce')).toBe('designer|crew@agent-board.test|agent-board|crew@agent-board.test');
  });

  it('refuses a file outside the worktree or through a symbolic link, committing nothing', async () => {
    const repo = crewRepo();
    const head = git(repo, 'rev-parse', 'HEAD');
    const outside = tempDataDir();
    symlinkSync(outside, join(repo, 'linked'));
    write(repo, 'linked/file.md', 'through the link\n');
    write(repo, 'docs/outline.md', 'mine\n');
    for (const file of ['linked/file.md', '../escape.md', '/etc/hosts', 'docs/../README.md']) {
      const made = await commitPaths({ worktree: repo, branch: 'main', files: ['docs/outline.md', file], author: 'designer', message: 'm' });
      expect(made).toHaveProperty('error');
    }
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('fails, saying so, when the branch has moved on from HEAD', async () => {
    const repo = crewRepo();
    // `ahead` is a commit past HEAD, as if another commit landed on it after HEAD was read.
    const ahead = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'ahead');
    git(repo, 'update-ref', 'refs/heads/ahead', ahead);
    write(repo, 'docs/outline.md', 'mine\n');
    const made = await commitPaths({ worktree: repo, branch: 'ahead', files: ['docs/outline.md'], author: 'designer', message: 'm' });
    expect(made).toEqual({ error: expect.stringContaining('moved') });
    expect(git(repo, 'rev-parse', 'ahead')).toBe(ahead);
  });

  it('waits for a lock on the shared index, then gives up naming it', async () => {
    const repo = crewRepo();
    write(repo, 'docs/outline.md', 'mine\n');
    const lock = join(repo, '.git', 'index.lock');
    writeFileSync(lock, '');
    setTimeout(() => rmSync(lock), 120);
    expect(await commitPaths({ worktree: repo, branch: 'main', files: ['docs/outline.md'], author: 'designer', message: 'm' })).toHaveProperty('commit');
    write(repo, 'docs/outline.md', 'again\n');
    writeFileSync(lock, '');
    expect(await commitPaths({ worktree: repo, branch: 'main', files: ['docs/outline.md'], author: 'designer', message: 'm' })).toEqual({
      error: "couldn't commit: index.lock is held",
    });
  });

  it('runs one at a time in a worktree, each on the commit before', async () => {
    const repo = crewRepo();
    write(repo, 'docs/outline.md', 'design\n');
    write(repo, 'docs/plan.md', 'plan\n');
    const [design, plan] = await Promise.all([
      commitPaths({ worktree: repo, branch: 'main', files: ['docs/outline.md'], author: 'designer', message: 'design' }),
      commitPaths({ worktree: repo, branch: 'main', files: ['docs/plan.md'], author: 'planner', message: 'plan' }),
    ]);
    expect(design).toHaveProperty('commit');
    expect(plan).toHaveProperty('commit');
    expect(git(repo, 'log', '--format=%an', '-2')).toBe('planner\ndesigner');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});

describe('recorded work', () => {
  it('is put back after a checkout and a stash wiped it, leaving files new since alone', async () => {
    const repo = crewRepo();
    write(repo, 'docs/outline.md', 'unsaved design\n');
    write(repo, 'mocks.html', 'unsaved mock\n');
    mkdirSync(join(repo, '.agent-board'));
    write(repo, '.agent-board/status.json', '{}\n');
    const statusBefore = git(repo, 'status', '--porcelain');
    const head = git(repo, 'rev-parse', 'HEAD');
    const tree = await recordWork(repo);
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);

    git(repo, 'checkout', '--', 'docs/outline.md');
    expect(await lostWork(repo, tree, head)).toEqual(['docs/outline.md']);
    expect(await restoreWork(repo, tree, head)).toEqual(['docs/outline.md']);
    expect(readFileSync(join(repo, 'docs/outline.md'), 'utf8')).toBe('unsaved design\n');

    git(repo, 'stash', 'push', '--quiet', '-u', '-m', 'crew-worktree-test');
    expect(existsSync(join(repo, 'mocks.html'))).toBe(false);
    write(repo, 'later.md', 'new since\n');
    expect(await restoreWork(repo, tree, head)).toEqual(['docs/outline.md', 'mocks.html']);
    expect(readFileSync(join(repo, 'mocks.html'), 'utf8')).toBe('unsaved mock\n');
    expect(readFileSync(join(repo, 'later.md'), 'utf8')).toBe('new since\n');
    // The shared index is untouched: the put-back work is uncommitted, not staged.
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('puts nothing back when nothing was lost', async () => {
    const repo = crewRepo();
    write(repo, 'docs/outline.md', 'unsaved\n');
    expect(await restoreWork(repo, await recordWork(repo), git(repo, 'rev-parse', 'HEAD'))).toEqual([]);
  });

  it("keeps newer work in a file, and a file committed since, over the record's", async () => {
    const repo = crewRepo();
    write(repo, 'docs/outline.md', 'unsaved design\n');
    write(repo, 'docs/plan.md', 'unsaved plan\n');
    rmSync(join(repo, 'README.md'));
    const head = git(repo, 'rev-parse', 'HEAD');
    const tree = await recordWork(repo);
    // Its owner went on with the design; the plan was committed; the readme's deletion is no work to put back.
    write(repo, 'docs/outline.md', 'newer design\n');
    git(repo, 'commit', '--quiet', '-m', 'plan', '--', 'docs/plan.md');
    git(repo, 'checkout', '--', 'README.md');
    expect(await restoreWork(repo, tree, head)).toEqual([]);
    expect(readFileSync(join(repo, 'docs/outline.md'), 'utf8')).toBe('newer design\n');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('README.md\n');
    // The plan as committed, with nothing uncommitted left over it.
    expect(git(repo, 'status', '--porcelain')).toMatch(/^M docs\/outline\.md$/);
  });

  it('puts back a file whose name git would quote', async () => {
    const repo = crewRepo();
    write(repo, 'docs/é.md', 'unsaved\n');
    const head = git(repo, 'rev-parse', 'HEAD');
    const tree = await recordWork(repo);
    rmSync(join(repo, 'docs/é.md'));
    expect(await restoreWork(repo, tree, head)).toEqual(['docs/é.md']);
    expect(readFileSync(join(repo, 'docs/é.md'), 'utf8')).toBe('unsaved\n');
  });

  it('is compared with other recorded work, tree to tree', async () => {
    const repo = crewRepo();
    const first = await gitSharedWorktree.record(repo);
    write(repo, 'docs/outline.md', 'unsaved\n');
    rmSync(join(repo, 'docs/plan.md'));
    write(repo, 'mocks.html', 'new\n');
    const second = await gitSharedWorktree.record(repo);
    expect(await gitSharedWorktree.between(repo, first, second)).toEqual(['docs/outline.md', 'docs/plan.md', 'mocks.html']);
    expect(await gitSharedWorktree.between(repo, second, second)).toEqual([]);
  });

  it('puts nothing back through a symbolic link', async () => {
    const repo = crewRepo();
    write(repo, 'docs/outline.md', 'unsaved\n');
    const head = git(repo, 'rev-parse', 'HEAD');
    const tree = await recordWork(repo);
    const outside = tempDataDir();
    rmSync(join(repo, 'docs'), { recursive: true });
    symlinkSync(outside, join(repo, 'docs'));
    expect(await restoreWork(repo, tree, head)).toEqual([]);
    expect(existsSync(join(outside, 'design.md'))).toBe(false);
  });
});

describe("a branch's commits", () => {
  it("are read: the branch's head, or null, and the files between two commits", async () => {
    const repo = crewRepo();
    const from = git(repo, 'rev-parse', 'HEAD');
    expect(await branchHead(repo, 'main')).toBe(from);
    expect(await branchHead(repo, 'nope')).toBeNull();
    write(repo, 'docs/outline.md', 'x\n');
    rmSync(join(repo, 'README.md'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', 'two');
    expect(await filesBetween(repo, from, 'HEAD')).toEqual(['README.md', 'docs/outline.md']);
    expect(await filesBetween(repo, from, from)).toEqual([]);
  });
});

describe('the files a PostToolUse payload edited', () => {
  it('are the absolute path an edit tool names, and nothing for any other', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit']) expect(editedFiles({ tool_name: tool, tool_input: { file_path: '/w/a.md' } })).toEqual(['/w/a.md']);
    expect(editedFiles({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/w/n.ipynb' } })).toEqual(['/w/n.ipynb']);
    expect(editedFiles({ tool_name: 'Edit', tool_input: { file_path: 'relative.md' } })).toEqual([]);
    expect(editedFiles({ tool_name: 'Edit', tool_input: { file_path: 3 } })).toEqual([]);
    expect(editedFiles({ tool_name: 'Edit' })).toEqual([]);
    expect(editedFiles({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } })).toEqual([]);
    expect(editedFiles({ tool_name: 'toString', tool_input: { file_path: '/w/a.md' } })).toEqual([]);
    expect(editedFiles({})).toEqual([]);
  });
});
