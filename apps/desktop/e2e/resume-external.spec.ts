import { expect, type Page } from '@playwright/test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agents, claudeInTerminal, sessionWindow, tile, zones } from './agent-helpers.ts';
import { browseForZone, connectedDaemonPid, launchApp, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

const externalTile = (page: Page) => page.getByTestId('external-tile');
const resumeDialog = (page: Page) => page.getByRole('alertdialog', { name: 'Resume in agent-board?' });

/** Runs the fake claude one-shot in `cwd` as if from another terminal, and waits for it to end. */
async function claudeElsewhere(cwd: string, home: string, sessions: ChildProcessWithoutNullStreams[]): Promise<void> {
  const session = claudeInTerminal(cwd, home, ['-p', 'Tidy the README'], 'output');
  sessions.push(session);
  session.stdout.resume();
  session.stderr.resume();
  await new Promise((resolve) => session.on('close', resolve));
}

test('an external session resumed in agent-board becomes a running agent in the same place, carrying on its conversation', async () => {
  const { dir, repo, env } = scratch('output');
  const home = env.HOME!;
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'ab-e2e-elsewhere-')));
  const dataDir = tempDataDir();
  // Never the developer's own ~/.claude or ~/.codex.
  const app = await launchApp(dataDir, { ...env, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex') });
  const sessions: ChildProcessWithoutNullStreams[] = [];
  try {
    const page = await app.firstWindow();
    await connectedDaemonPid(page);
    await pickFolderNext(app, repo);
    await browseForZone(page);
    const [zone] = await zones(page);
    await page.evaluate(() => window.agentBoard.external.setHooksEnabled(true));

    await claudeElsewhere(repo, home, sessions);
    const external = externalTile(page);
    await expect(external).toHaveAttribute('data-state', 'done');
    const sessionId = await page.evaluate(async () => (await window.agentBoard.external.list())[0]!.sessionId);

    // From its menu: the dialog says where it will work and that it is the main checkout, and Cancel is the default.
    await external.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Resume in agent-board…' }).click();
    await expect(resumeDialog(page)).toContainText(repo);
    await expect(resumeDialog(page)).toContainText("your repo's main checkout");
    await expect(resumeDialog(page).getByRole('button', { name: 'Resume in a new worktree' })).toBeVisible();
    await expect(resumeDialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(resumeDialog(page)).toBeHidden();
    await expect(external).toHaveCount(1);

    // Resumed here, from its expanded tile: a managed agent under the same session id, in the zone the external tile
    // was in, and it goes.
    await external.getByRole('button', { name: 'Expand' }).click();
    await page.getByTestId('resume-external').click();
    await resumeDialog(page).getByRole('button', { name: 'Resume here' }).click();
    await expect(resumeDialog(page)).toBeHidden();
    await expect(external).toHaveCount(0);
    await expect(tile(page)).toHaveAttribute('data-session-id', sessionId);
    await expect(tile(page)).toHaveAttribute('data-zone', zone!.id);
    const [agent] = await agents(page);
    expect(agent).toMatchObject({ sessionId, cwd: repo, endedAt: null, ownsWorktree: false });
    // Its terminal is here now, showing the conversation it had.
    await tile(page).dblclick();
    await expect(sessionWindow(page).getByTestId('session-terminal').locator('.xterm-rows')).toContainText('Tidy the README');
    await page.getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow(page)).toHaveCount(0);

    // One in the Unsorted group, from its tile: the agent takes the place its tile was drawn at, in the group.
    await claudeElsewhere(elsewhere, home, sessions);
    const loose = page.getByTestId('external-tile');
    await expect(loose).toHaveAttribute('data-state', 'done');
    const before = await loose.boundingBox();
    await loose.getByRole('button', { name: 'Resume in agent-board' }).click();
    // Outside git: no new worktree to offer.
    await expect(resumeDialog(page).getByRole('button', { name: 'Resume in a new worktree' })).toHaveCount(0);
    await resumeDialog(page).getByRole('button', { name: 'Resume here' }).click();
    await expect(externalTile(page)).toHaveCount(0);
    const unsorted = (await zones(page)).find((known) => known.name === 'Unsorted');
    const resumed = page.locator(`[data-testid="agent-tile"][data-zone="${unsorted!.id}"]`);
    await expect(resumed).toHaveCount(1);
    const after = await resumed.boundingBox();
    expect(Math.abs(after!.x - before!.x)).toBeLessThan(12);
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(12);
  } finally {
    for (const session of sessions) session.kill();
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('a session that may still be running elsewhere is only resumed past a warning that defaults to Cancel, even one arriving late', async () => {
  const { dir, repo, env } = scratch('waiting');
  const home = env.HOME!;
  const dataDir = tempDataDir();
  // Never the developer's own ~/.claude or ~/.codex.
  const app = await launchApp(dataDir, { ...env, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex') });
  const sessions: ChildProcessWithoutNullStreams[] = [];
  try {
    const page = await app.firstWindow();
    await connectedDaemonPid(page);
    await pickFolderNext(app, repo);
    await browseForZone(page);
    await page.evaluate(() => window.agentBoard.external.setHooksEnabled(true));

    // Still at its prompt in another terminal: the warning shows as the dialog opens, and Enter cancels.
    const session = claudeInTerminal(repo, home, ['Pick a database'], 'waiting');
    sessions.push(session);
    session.stdout.resume();
    session.stderr.resume();
    const external = externalTile(page);
    await expect(external).toHaveAttribute('data-state', 'waiting');
    await external.getByRole('button', { name: 'Resume in agent-board' }).click();
    await expect(resumeDialog(page)).toContainText('may still be running in another terminal');
    await expect(resumeDialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(resumeDialog(page)).toBeHidden();

    // Ended, so the dialog opens with no warning; then it is resumed in another terminal with the global hooks off, so
    // only its transcript, written since, says so. The click on Resume here brings the warning, back on Cancel.
    session.stdin.write('SQLite\n');
    session.stdin.end();
    await expect(external).toHaveAttribute('data-state', 'done');
    const { sessionId } = (await page.evaluate(() => window.agentBoard.external.list()))[0]!;
    await external.getByRole('button', { name: 'Resume in agent-board' }).click();
    await expect(resumeDialog(page).getByRole('button', { name: 'Resume here' })).toBeEnabled();
    await expect(resumeDialog(page)).not.toContainText('may still be running in another terminal');
    const transcript = join(home, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
    const later = new Date(Date.now() + 60_000);
    utimesSync(transcript, later, later);
    await resumeDialog(page).getByRole('button', { name: 'Resume here' }).click();
    await expect(resumeDialog(page)).toContainText('may still be running in another terminal');
    await expect(resumeDialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(resumeDialog(page)).toBeHidden();
    await expect(external).toHaveCount(1);
    expect(await agents(page)).toEqual([]);
  } finally {
    for (const session of sessions) session.kill();
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
