import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { guardCodexConfig } from '../src/codex-config-guard.ts';
import { tempDataDir } from './helpers.ts';

function guarded(cwd: string, worktree: string) {
  const onFound = vi.fn<(path: string) => void>();
  const guard = guardCodexConfig(cwd, worktree, onFound);
  onTestFinished(() => guard.stop());
  return { guard, onFound };
}

describe('the Codex config guard', () => {
  it('reports a .codex that appears in the start folder, once', async () => {
    const worktree = tempDataDir();
    const { onFound } = guarded(worktree, worktree);

    mkdirSync(join(worktree, '.codex'));
    writeFileSync(join(worktree, '.codex', 'hooks.json'), '{}');

    await vi.waitFor(() => expect(onFound).toHaveBeenCalledWith(join(worktree, '.codex')), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(onFound).toHaveBeenCalledTimes(1);
  });

  it('reports a .codex symlink that appears in a folder above the start folder', async () => {
    const worktree = tempDataDir();
    mkdirSync(join(worktree, 'apps', 'web'), { recursive: true });
    const { onFound } = guarded(join(worktree, 'apps', 'web'), worktree);

    symlinkSync('/nowhere', join(worktree, 'apps', '.codex'));

    await vi.waitFor(() => expect(onFound).toHaveBeenCalledWith(join(worktree, 'apps', '.codex')), { timeout: 5_000 });
  });

  it('ignores other files, and a .codex deeper than the start folder', async () => {
    const worktree = tempDataDir();
    mkdirSync(join(worktree, 'src'));
    const { guard, onFound } = guarded(worktree, worktree);

    writeFileSync(join(worktree, 'notes.md'), 'x');
    mkdirSync(join(worktree, 'src', '.codex'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    guard.check();

    expect(onFound).not.toHaveBeenCalled();
  });

  it('finds config on a check even without a watch event, and never after it is stopped', () => {
    const worktree = tempDataDir();
    const { guard, onFound } = guarded(worktree, worktree);
    guard.stop();
    mkdirSync(join(worktree, '.codex'));
    guard.check();
    expect(onFound).not.toHaveBeenCalled();

    const other = tempDataDir();
    const second = guarded(other, other);
    second.guard.stop();
    const third = guarded(other, other);
    mkdirSync(join(other, '.codex'));
    third.guard.check();
    expect(third.onFound).toHaveBeenCalledWith(join(other, '.codex'));
  });

  it('fails closed on a folder it cannot watch', () => {
    const { onFound } = guarded(join(tempDataDir(), 'missing'), tempDataDir());
    expect(onFound).toHaveBeenCalledWith(expect.stringContaining("can't be watched"));
  });
});
