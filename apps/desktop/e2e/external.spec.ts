import { expect, type Page } from '@playwright/test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, connectedDaemonPid, launchApp, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { claudeInTerminal, tileAction, zones } from './agent-helpers.ts';
import { scratch } from './scratch.ts';
import { openSettings, settingsSection } from './settings-helpers.ts';

function writeStatus(repo: string, status: Record<string, unknown>): void {
  mkdirSync(join(repo, '.agent-board'), { recursive: true });
  writeFileSync(join(repo, '.agent-board', 'status.json'), JSON.stringify({ version: 1, issue: 'ACME-99', role: 'implement', ...status }));
}

const externalTile = (window: Page) => window.getByTestId('external-tile');

test('with global hooks on, claude sessions started in other terminals appear in their zone or the Unsorted group, with live state and their status file', async () => {
  const { dir, repo, env } = scratch('waiting');
  const home = env.HOME!;
  const settings = join(home, '.claude', 'settings.json');
  // The user's own Claude settings, which installing and removing the hooks must leave as they were.
  const own = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } };
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(settings, JSON.stringify(own));
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'ab-e2e-elsewhere-')));
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir, {
    ...env,
    // Never the developer's own ~/.claude or ~/.codex.
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
  });
  const sessions: ChildProcessWithoutNullStreams[] = [];
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    // A repo zone, and a folder zone for the folder the session starts in: the folder zone is the one it goes in.
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await expect(window.getByTestId('zone')).toHaveCount(1);
    await pickFolderNext(app, join(repo, 'apps', 'web'));
    await browseForZone(window);
    await expect(window.getByTestId('zone')).toHaveCount(2);
    const zone = (await zones(window)).find((known) => known.kind === 'folder');

    // The setting is in the Settings window, under Accounts › Other terminals.
    const settingsWindow = await openSettings(window, 'accounts.terminals');
    const toggle = settingsSection(settingsWindow, 'Other terminals').getByRole('switch', { name: 'Show sessions from other terminals' });
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    expect(readFileSync(settings, 'utf8')).toContain('agent-board-hook');

    writeStatus(repo, { state: 'running', summary: 'Writing the tests first' });
    const session = claudeInTerminal(join(repo, 'apps', 'web'), home, ['Pick a database'], 'waiting');
    sessions.push(session);
    session.stdout.resume();
    session.stderr.resume();

    // In the folder's zone, named by its worker's status file, waiting for an answer.
    const tile = window.locator(`[data-testid="external-tile"][data-zone="${zone!.id}"]`);
    await expect(tile).toHaveCount(1);
    await expect(tile).toContainText('ACME-99 implement');
    await expect(tile).toHaveAttribute('data-harness', 'claude');
    await expect(tile).toHaveAttribute('data-state', 'waiting');
    await expect(tile.getByTestId('tile-status')).toContainText('Writing the tests first');

    // Still running elsewhere: removing it says so, and Cancel leaves it be.
    await tileAction(tile, 'Remove from board');
    const removing = window.getByRole('alertdialog', { name: 'Remove from board?' });
    await expect(removing).toContainText('keeps running elsewhere');
    await expect(removing).not.toContainText("can't be undone");
    await removing.getByRole('button', { name: 'Cancel' }).click();
    await expect(tile).toHaveCount(1);
    expect(session.exitCode).toBeNull();

    writeStatus(repo, { state: 'done', summary: 'Pushed the branch', handover: '.agent-board/handover.md' });
    await expect(tile.getByTestId('tile-status')).toHaveAttribute('data-status-state', 'done');
    await expect(tile.getByTestId('tile-status')).toContainText('Pushed the branch');
    await expect(tile.getByTestId('tile-docs')).toContainText('.agent-board/handover.md');

    session.stdin.write('SQLite\n');
    session.stdin.end();
    await expect(tile).toHaveAttribute('data-state', 'done');

    // Outside every zone: in the Unsorted group, an ordinary group zone made for it.
    const loose = claudeInTerminal(elsewhere, home, ['-p', 'Say hello'], 'output');
    sessions.push(loose);
    loose.stdout.resume();
    loose.stderr.resume();
    const unsortedZone = window.getByTestId('zone').filter({ hasText: 'Unsorted' });
    await expect(unsortedZone).toHaveCount(1);
    await expect(unsortedZone).toHaveAttribute('data-kind', 'unbound');
    const unsortedId = (await zones(window)).find((known) => known.name === 'Unsorted')!.id;
    const looseTile = window.locator(`[data-testid="external-tile"][data-zone="${unsortedId}"]`);
    await expect(looseTile).toHaveCount(1);
    await expect(looseTile).toHaveAttribute('data-state', 'done');
    await expect(externalTile(window)).toHaveCount(2);

    await tileAction(looseTile, 'Remove from board');
    await expect(externalTile(window)).toHaveCount(1);
    // The group stays, empty, as any group does.
    await expect(unsortedZone).toHaveCount(1);

    await openSettings(window, 'accounts.terminals');
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual(own);
  } finally {
    for (const session of sessions) session.kill();
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
