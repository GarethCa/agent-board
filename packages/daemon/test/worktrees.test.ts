import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { addWorktree, agentWorktreePath, removeWorktree } from '../src/worktrees.ts';
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
