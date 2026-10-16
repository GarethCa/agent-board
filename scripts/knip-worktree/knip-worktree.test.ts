import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'knip-worktree-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// agent-board puts agents' worktrees under ~/.agent-board/worktrees/. knip applies .gitignore patterns to the whole path, so an
// unanchored `.agent-board/` rule once made it skip the repo's files there and report their exports as unused.
describe('knip in a checkout under a /.agent-board/ path', () => {
  it('passes, as it does anywhere else', { timeout: 120_000 }, () => {
    const checkout = join(scratch, '.agent-board', 'worktrees', 'repo', 'branch');
    mkdirSync(checkout, { recursive: true });
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const file of tracked) {
      if (!existsSync(join(repo, file))) continue;
      mkdirSync(dirname(join(checkout, file)), { recursive: true });
      cpSync(join(repo, file), join(checkout, file));
    }
    for (const dir of ['', 'apps/desktop', 'packages/daemon', 'packages/fake-harness', 'packages/tracker', 'packages/protocol']) {
      const modules = join(repo, dir, 'node_modules');
      if (existsSync(modules)) symlinkSync(modules, join(checkout, dir, 'node_modules'));
    }
    execFileSync('git', ['init', '-q'], { cwd: checkout });

    const run = spawnSync(join(repo, 'node_modules', '.bin', 'knip'), ['--no-progress'], { cwd: checkout, encoding: 'utf8' });
    expect(run.stdout + run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});
