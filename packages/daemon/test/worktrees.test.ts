import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { addWorktree, agentWorktreePath, localBaseBranch, removeWorktree, unsavedWork } from '../src/worktrees.ts';
import { git, tempDataDir, tempRepo } from './helpers.ts';

/** A repo and a worktree of it, in the folder an agent's would be in. */
async function worktreeOf(branch = 'busy'): Promise<{ repo: string; worktree: string }> {
  const repo = tempRepo();
  const worktree = agentWorktreePath(tempDataDir(), repo, branch);
  await addWorktree(repo, worktree, branch);
  return { repo, worktree };
}

/** Starts a process that keeps creating files in the worktree until killed; resolves once it has written the first. */
async function startWriter(worktree: string): Promise<{ stop(): void }> {
  const deep = join(worktree, 'out', 'deep');
  mkdirSync(deep, { recursive: true });
  const script = `const fs=require('fs');const d=${JSON.stringify(deep)};const end=Date.now()+60000;let i=0;while(Date.now()<end){try{fs.mkdirSync(d,{recursive:true});fs.writeFileSync(d+'/f'+i++,'x');}catch{}}`;
  const writer = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  const stop = () => void writer.kill('SIGKILL');
  onTestFinished(stop);
  await vi.waitFor(() => expect(existsSync(deep) && readdirSync(deep).length).toBeGreaterThan(0), { timeout: 10_000, interval: 10 });
  return { stop };
}

/** Makes a folder that nothing inside can be deleted from, until the test ends. */
function lockFolder(worktree: string): void {
  const locked = join(worktree, 'locked');
  mkdirSync(locked);
  mkdirSync(join(locked, 'inner'));
  chmodSync(locked, 0o555);
  onTestFinished(() => chmodSync(locked, 0o755));
}

describe('removeWorktree', () => {
  it.each([false, true])('removes a worktree a process keeps writing into, once it stops (keepBranch %s)', async (keepBranch) => {
    const { repo, worktree } = await worktreeOf();
    const writer = await startWriter(worktree);
    const retries: string[] = [];
    await removeWorktree(repo, worktree, 'busy', keepBranch, {
      onFolderRetry: (error) => {
        retries.push(error.message);
        writer.stop();
      },
    });
    // Git had let go of the folder and then failed on the files, so the folder was deleted again after a pause.
    expect(retries.length).toBeGreaterThan(0);
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(worktree);
    expect(git(repo, 'branch', '--list', 'busy')).toBe(keepBranch ? 'busy' : '');
  });

  // Root deletes out of a read-only folder all the same.
  it.skipIf(process.getuid?.() === 0)('gives up with the reason once the retries are used up, leaving the folder', async () => {
    const { repo, worktree } = await worktreeOf();
    lockFolder(worktree);
    const retries: string[] = [];
    await expect(removeWorktree(repo, worktree, 'busy', false, { retryDelaysMs: [10, 10], onFolderRetry: (e) => retries.push(e.message) })).rejects.toThrow(
      /could not remove the worktree .*(EACCES|EPERM|not empty)/i,
    );
    expect(retries).toHaveLength(2);
    expect(existsSync(worktree)).toBe(true);
  });

  it("deletes nothing when git can't say whether the folder is a worktree", async () => {
    const { worktree } = await worktreeOf();
    await expect(removeWorktree(join(tempDataDir(), 'no-such-repo'), worktree, 'busy')).rejects.toThrow(/could not (remove|list)/);
    expect(existsSync(worktree)).toBe(true);
  });

  it('deletes nothing while git still lists the folder as a worktree', async () => {
    const { repo, worktree } = await worktreeOf();
    git(repo, 'worktree', 'lock', worktree);
    await expect(removeWorktree(repo, worktree, 'busy', false, { retryDelaysMs: [] })).rejects.toThrow(/could not remove the worktree/);
    expect(existsSync(worktree)).toBe(true);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(worktree);
  });

  it("deletes nothing outside the repo's worktrees folder", async () => {
    const repo = tempRepo();
    const stray = join(tempDataDir(), 'stray');
    mkdirSync(stray);
    await expect(removeWorktree(repo, stray, 'busy')).rejects.toThrow(/not in this repo's worktrees folder/);
    expect(existsSync(stray)).toBe(true);
  });
});

describe('unsavedWork with ignoreBoardFiles', () => {
  it('leaves out the board\u2019s own files, and still finds any other change or a commit no other branch has', async () => {
    const { repo, worktree } = await worktreeOf('crew-build');
    const unsaved = (ignoreBoardFiles: boolean) => unsavedWork(repo, worktree, 'crew-build', { ignoreBoardFiles });
    expect(await unsaved(true)).toBeUndefined();

    mkdirSync(join(worktree, '.agent-board'), { recursive: true });
    writeFileSync(join(worktree, '.agent-board', 'review.md'), 'Verdict: Approve\n');
    expect(await unsaved(true)).toBeUndefined();
    expect(await unsaved(false)).toBe('its worktree has uncommitted changes');

    writeFileSync(join(worktree, 'notes.txt'), 'mine\n');
    expect(await unsaved(true)).toBe('its worktree has uncommitted changes');

    git(worktree, 'add', 'notes.txt');
    git(worktree, 'commit', '-m', 'Local work');
    expect(await unsaved(true)).toBe('its branch crew-build has 1 commit no other branch has');
  });
});

describe('localBaseBranch', () => {
  const commit = (repo: string, message: string) => git(repo, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', message);

  /** A clone of a repo that has a branch `feature`, which the clone knows only as `origin/feature`. */
  function cloned() {
    const upstream = tempRepo('upstream');
    git(upstream, 'checkout', '-q', '-b', 'feature');
    commit(upstream, 'the feature');
    git(upstream, 'checkout', '-q', '-');
    const clone = join(tempDataDir(), 'clone');
    git(upstream, 'clone', '-q', upstream, clone);
    return { upstream, clone };
  }

  it('is the branch itself, when the repo has it', async () => {
    const { clone } = cloned();
    const main = git(clone, 'branch', '--show-current');
    expect(await localBaseBranch(clone, main)).toBe(main);
  });

  it("is a local branch made at the remote's, for a branch the repo has only on origin, by either name", async () => {
    const { upstream, clone } = cloned();
    expect(await localBaseBranch(clone, 'origin/feature')).toBe('feature');
    expect(git(clone, 'rev-parse', 'refs/heads/feature')).toBe(git(upstream, 'rev-parse', 'feature'));
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'feature@{upstream}')).toBe('origin/feature');
    expect(await localBaseBranch(clone, 'feature')).toBe('feature');

    const other = cloned();
    expect(await localBaseBranch(other.clone, 'feature')).toBe('feature');
  });

  it('fetches a branch pushed since the repo last fetched', async () => {
    const { upstream, clone } = cloned();
    git(upstream, 'checkout', '-q', '-b', 'later');
    commit(upstream, 'pushed later');
    expect(await localBaseBranch(clone, 'later')).toBe('later');
    expect(git(clone, 'rev-parse', 'refs/heads/later')).toBe(git(upstream, 'rev-parse', 'later'));
  });

  it("starts from the remote's tip, not the one the repo last fetched", async () => {
    const { upstream, clone } = cloned();
    git(upstream, 'checkout', '-q', 'feature');
    commit(upstream, 'pushed since the clone');
    expect(await localBaseBranch(clone, 'origin/feature')).toBe('feature');
    expect(git(clone, 'rev-parse', 'refs/heads/feature')).toBe(git(upstream, 'rev-parse', 'feature'));
  });

  it("falls back on the remote's branch as the repo last fetched it, when the remote can't be reached", async () => {
    const { upstream, clone } = cloned();
    const known = git(upstream, 'rev-parse', 'feature');
    git(clone, 'remote', 'set-url', 'origin', join(tempDataDir(), 'gone'));
    expect(await localBaseBranch(clone, 'origin/feature')).toBe('feature');
    expect(git(clone, 'rev-parse', 'refs/heads/feature')).toBe(known);
  });

  it("moves a local branch of that name that is behind the remote's up to it", async () => {
    const { upstream, clone } = cloned();
    git(clone, 'branch', '--quiet', 'feature', 'origin/feature');
    git(upstream, 'checkout', '-q', 'feature');
    commit(upstream, 'pushed since the clone');
    expect(await localBaseBranch(clone, 'origin/feature')).toBe('feature');
    expect(git(clone, 'rev-parse', 'refs/heads/feature')).toBe(git(upstream, 'rev-parse', 'feature'));
  });

  it("refuses a local branch of that name that has gone its own way, or is behind and checked out, and leaves it", async () => {
    const { upstream, clone } = cloned();
    git(clone, 'checkout', '-q', '-b', 'feature', 'origin/feature');
    commit(clone, 'only here');
    const mine = git(clone, 'rev-parse', 'feature');
    await expect(localBaseBranch(clone, 'origin/feature')).rejects.toThrow(
      'feature here is not origin/feature, and has commits it lacks: give --base feature to start from it, or update it',
    );
    expect(git(clone, 'rev-parse', 'refs/heads/feature')).toBe(mine);

    git(clone, 'reset', '-q', '--hard', 'origin/feature');
    git(upstream, 'checkout', '-q', 'feature');
    commit(upstream, 'pushed since the clone');
    await expect(localBaseBranch(clone, 'origin/feature')).rejects.toThrow('feature here is not origin/feature, and is checked out, so it is not moved');
  });

  it('makes or moves no local branch when the check refuses the commit', async () => {
    const { upstream, clone } = cloned();
    const seen: string[] = [];
    const refuse = async (ref: string, name: string) => {
      seen.push(`${name} ${ref}`);
      throw new Error('refused');
    };
    await expect(localBaseBranch(clone, 'origin/feature', refuse)).rejects.toThrow('refused');
    expect(seen).toEqual(['feature refs/remotes/origin/feature']);
    expect(git(clone, 'branch', '--list', 'feature')).toBe('');

    git(clone, 'branch', '--quiet', 'feature', 'origin/feature');
    const before = git(clone, 'rev-parse', 'feature');
    git(upstream, 'checkout', '-q', 'feature');
    commit(upstream, 'pushed since the clone');
    await expect(localBaseBranch(clone, 'origin/feature', refuse)).rejects.toThrow('refused');
    expect(git(clone, 'rev-parse', 'refs/heads/feature')).toBe(before);
  });

  it('resolves one base for two spawns at once', async () => {
    const { upstream, clone } = cloned();
    expect(await Promise.all([localBaseBranch(clone, 'origin/feature'), localBaseBranch(clone, 'origin/feature'), localBaseBranch(clone, 'feature')])).toEqual([
      'feature',
      'feature',
      'feature',
    ]);
    expect(git(clone, 'rev-parse', 'refs/heads/feature')).toBe(git(upstream, 'rev-parse', 'feature'));
  });

  it('says why there is none, when no remote has it either', async () => {
    const { clone } = cloned();
    await expect(localBaseBranch(clone, 'nope')).rejects.toThrow('clone has no branch nope');
    await expect(localBaseBranch(tempRepo('alone'), 'nope')).rejects.toThrow('alone has no branch nope');
  });
});
