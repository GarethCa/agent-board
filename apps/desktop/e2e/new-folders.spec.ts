// Agents in a new folder or a brand-new repo: a zone added for a folder outside git starts its agents in that folder,
// and a zone of a repo with no commits yet starts its agents on the first try, committing nothing for the user.
import { expect, type Page } from '@playwright/test';
import type { Agent, Zone } from '@agent-board/daemon/protocol';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { withDaemon } from './board-helpers.ts';
import { launch, zoneNamed } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

/** The board as the daemon has stored it. */
function stored(dataDir: string): Promise<{ zones: Zone[]; agents: Agent[] }> {
  return withDaemon(dataDir, async (client) => ({ zones: await client.call('zone.list'), agents: await client.call('agent.list') }));
}

const picker = (window: Page) => window.getByRole('dialog', { name: 'New agent' });

/** Whether the repo has a commit yet. */
function hasCommit(repo: string): boolean {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', 'HEAD'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

test('a zone for a new folder outside git starts agents in the folder, and a zone of a repo with no commits starts them on the first try', async () => {
  const { dir, env } = scratch('waiting');
  const notes = join(dir, 'notes');
  mkdirSync(notes);
  const fresh = join(dir, 'fresh');
  mkdirSync(fresh);
  execFileSync('git', ['-C', fresh, 'init', '--quiet']);
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    // A new folder outside git: the zone is a group whose own folder it is, and New agent starts in it.
    await pickFolderNext(app, notes);
    await browseForZone(window);
    const group = zoneNamed(window, 'notes');
    await expect(group).toHaveAttribute('data-kind', 'unbound');
    await group.getByRole('button', { name: 'New agent' }).click();
    await expect(picker(window).getByRole('group', { name: 'Repo' }).getByRole('button', { name: /^Repo:/ })).toHaveText('No repo');
    await picker(window).getByRole('button', { name: /^Start/ }).click();
    await expect(picker(window)).toHaveCount(0);
    await expect.poll(async () => (await stored(dataDir)).agents.length).toBe(1);
    const [plain] = (await stored(dataDir)).agents;
    expect(plain).toMatchObject({ plainFolder: true, ownsWorktree: false, branch: '', worktree: notes });
    await expect(window.getByTestId('not-isolated')).toHaveText('shared folder, no worktree');
    expect(existsSync(join(notes, '.git'))).toBe(false);

    // Made a git repo on the user's click, the folder's zone is a repo zone with no commits yet.
    await group.getByRole('button', { name: 'Zone options' }).click();
    await window.getByRole('menuitem', { name: /^Make it a git repo/ }).click();
    await expect(group).toHaveAttribute('data-kind', 'repo');
    expect(existsSync(join(notes, '.git'))).toBe(true);
    expect(hasCommit(notes)).toBe(false);

    // A repo just made with git init: New agent starts on the first try, and nothing is committed.
    await pickFolderNext(app, fresh);
    await browseForZone(window);
    const repo = zoneNamed(window, 'fresh');
    await expect(repo).toHaveAttribute('data-kind', 'repo');
    await repo.getByRole('button', { name: 'New agent' }).click();
    await picker(window).getByRole('button', { name: /^Start/ }).click();
    await expect(picker(window)).toHaveCount(0);
    await expect.poll(async () => (await stored(dataDir)).agents.filter((agent) => agent.repoRoot === fresh).length).toBe(1);
    expect(hasCommit(fresh)).toBe(false);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
