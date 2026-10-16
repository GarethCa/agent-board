import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pushTargets } from '../src/push-targets.ts';
import { git, tempDataDir, tempRepo } from './helpers.ts';

const commit = (cwd: string, message: string) => {
  git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--allow-empty', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
};

/** A repo whose `origin` is a local bare repo holding `main` and a pull request's branch, `pr-x`. */
function repoWithOrigin() {
  const repo = tempRepo();
  const origin = join(tempDataDir(), 'origin.git');
  git(repo, 'init', '--quiet', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '--quiet', 'origin', 'HEAD:main', 'HEAD:pr-x');
  git(repo, 'fetch', '--quiet', 'origin');
  return repo;
}

/** A worktree of `repo` on a new branch `branch` cut from `from`, as an agent's. */
function worktree(repo: string, branch: string, from: string, ...flags: string[]) {
  const dir = join(tempDataDir(), branch);
  git(repo, 'worktree', 'add', '--quiet', ...flags, '-b', branch, dir, from);
  return dir;
}

describe('pushTargets', () => {
  it("names the branch's upstream when it isn't the branch itself", async () => {
    const repo = repoWithOrigin();
    const fix = worktree(repo, 'pr-x-fix', 'origin/pr-x', '--track');

    expect(await pushTargets(fix, 'pr-x-fix')).toEqual({ pushedTo: ['pr-x'] });
  });

  it('names the remote branches its own commits were pushed to, those holding its newest first, and its newest commit', async () => {
    const repo = repoWithOrigin();
    const fix = worktree(repo, 'fix', 'origin/main', '--no-track');
    commit(fix, 'one');
    git(fix, 'push', '--quiet', 'origin', 'HEAD:pr-a');
    const two = commit(fix, 'two');
    git(fix, 'push', '--quiet', 'origin', 'HEAD:pr-b');

    expect(await pushTargets(fix, 'fix')).toEqual({ pushedTo: ['pr-b', 'pr-a'], commit: two });
  });

  it("leaves out another worktree's pushes, and a branch it was only cut from", async () => {
    const repo = repoWithOrigin();
    const other = worktree(repo, 'other', 'origin/main', '--no-track');
    commit(other, 'theirs');
    git(other, 'push', '--quiet', 'origin', 'HEAD:pr-theirs');
    const fix = worktree(repo, 'fix', 'origin/pr-x', '--no-track');
    commit(fix, 'mine');

    // Nor a commit it never pushed, which GitHub can't have.
    expect(await pushTargets(fix, 'fix')).toEqual({ pushedTo: [] });
  });

  it('searches for its newest pushed commit, not a later one it never pushed', async () => {
    const repo = repoWithOrigin();
    const fix = worktree(repo, 'fix', 'origin/main', '--no-track');
    const pushed = commit(fix, 'fix');
    git(fix, 'push', '--quiet', 'origin', 'HEAD:pr-x');
    commit(fix, 'notes');

    expect(await pushTargets(fix, 'fix')).toEqual({ pushedTo: ['pr-x'], commit: pushed });
  });

  it("counts no commit a rebase or cherry-pick only fast-forwarded it to, even one pushed from another worktree", async () => {
    const repo = repoWithOrigin();
    const other = worktree(repo, 'other', 'origin/pr-x', '--no-track');
    const theirs = commit(other, 'theirs');
    git(other, 'push', '--quiet', 'origin', 'HEAD:pr-x');
    git(repo, 'fetch', '--quiet', 'origin');
    const rebased = worktree(repo, 'rebased', 'origin/main', '--no-track');
    git(rebased, 'rebase', '--quiet', theirs);
    const picked = worktree(repo, 'picked', 'origin/main', '--no-track');
    git(picked, 'cherry-pick', '--ff', theirs);

    expect(await pushTargets(rebased, 'rebased')).toEqual({ pushedTo: [] });
    expect(await pushTargets(picked, 'picked')).toEqual({ pushedTo: [] });
  });

  it('counts the commits a rebase replayed onto another branch as its own', async () => {
    const repo = repoWithOrigin();
    const fix = worktree(repo, 'fix', 'origin/main', '--no-track');
    commit(fix, 'mine');
    git(fix, 'rebase', '--quiet', 'origin/pr-x');
    const replayed = git(fix, 'rev-parse', 'HEAD');
    git(fix, 'push', '--quiet', 'origin', 'HEAD:pr-x');

    expect(await pushTargets(fix, 'fix')).toEqual({ pushedTo: ['pr-x'], commit: replayed });
  });

  it('counts the commits a pull --rebase replayed as its own, and their push', async () => {
    const repo = repoWithOrigin();
    const fix = worktree(repo, 'fix', 'origin/main', '--no-track');
    commit(fix, 'mine');
    const other = worktree(repo, 'other', 'origin/main', '--no-track');
    commit(other, 'theirs');
    git(other, 'push', '--quiet', 'origin', 'HEAD:main');
    git(fix, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'pull', '--quiet', '--rebase', 'origin', 'main');
    const replayed = git(fix, 'rev-parse', 'HEAD');
    git(fix, 'push', '--quiet', 'origin', 'HEAD:pr-b');

    expect(await pushTargets(fix, 'fix')).toEqual({ pushedTo: ['pr-b'], commit: replayed });
  });

  it('names no commit once the branch it pushed to is pruned, rather than a later one it never pushed', async () => {
    const repo = repoWithOrigin();
    const fix = worktree(repo, 'fix', 'origin/main', '--no-track');
    commit(fix, 'pushed');
    git(fix, 'push', '--quiet', 'origin', 'HEAD:pr-a');
    commit(fix, 'notes');
    git(fix, 'push', '--quiet', 'origin', '--delete', 'pr-a');
    git(fix, 'fetch', '--quiet', '--prune', 'origin');

    expect(await pushTargets(fix, 'fix')).toEqual({ pushedTo: [] });
  });

  it('skips a reflog line that names no commit', async () => {
    const repo = repoWithOrigin();
    const fix = worktree(repo, 'fix', 'origin/main', '--no-track');
    const mine = commit(fix, 'mine');
    git(fix, 'push', '--quiet', 'origin', 'HEAD:pr-x');
    appendFileSync(join(git(repo, 'rev-parse', '--absolute-git-dir'), 'logs', 'refs', 'heads', 'fix'), 'garbage\tcommit: broken\n');

    expect(await pushTargets(fix, 'fix')).toEqual({ pushedTo: ['pr-x'], commit: mine });
  });

  it('names nothing for a branch with no commits of its own and no upstream', async () => {
    const repo = repoWithOrigin();
    const fresh = worktree(repo, 'fresh', 'origin/main', '--no-track');

    expect(await pushTargets(fresh, 'fresh')).toEqual({ pushedTo: [] });
  });

  it('names nothing in a directory that is not a git repo', async () => {
    expect(await pushTargets(tempDataDir(), 'fix')).toEqual({ pushedTo: [] });
  });
});
