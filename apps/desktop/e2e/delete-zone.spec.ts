import { expect } from '@playwright/test';
import { createFakeGitHub, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launch, zoneNamed, zones } from './agent-helpers.ts';
import { removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

test('⌫ on a selected repo zone asks, leaves its tiles and the repo alone, and ⌘Z brings it back bound with its tiles in it', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, env);
  try {
    const added = await page.evaluate((path) => window.agentBoard.zones.addFolder(path, { x: 100, y: 100 }), repo);
    expect(added.status).toBe('added');
    const [before] = await zones(page);
    expect(before).toMatchObject({ kind: 'repo', repoRoot: repo });
    const zone = zoneNamed(page, before!.name);
    await zone.getByRole('button', { name: 'New shell in zone' }).click();
    await page.getByRole('button', { name: 'Close session window' }).click();
    const shell = page.getByTestId('shell-tile');
    await expect(shell).toHaveCount(1);
    const placed = (await page.evaluate(() => window.agentBoard.shells.list()))[0]!;

    // Cancelled, nothing is deleted.
    await zone.getByTestId('zone-tab').click({ position: { x: 12, y: 12 } });
    await page.keyboard.press('Backspace');
    const confirm = page.getByRole('alertdialog', { name: `Delete zone ${before!.name}?` });
    await expect(confirm).toContainText('Its tile stays on the board where it is');
    await expect(confirm).toContainText("the repo's folder isn't touched");
    await expect(confirm.getByRole('checkbox')).toHaveCount(0);
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    expect(await zones(page)).toEqual([before]);

    // Confirmed: the zone goes; the shell stays loose and the repo is untouched.
    await page.keyboard.press('Backspace');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(zone).toHaveCount(0);
    expect(await zones(page)).toEqual([]);
    await expect(shell).toHaveCount(1);
    expect(existsSync(join(repo, '.git'))).toBe(true);
    expect((await page.evaluate(() => window.agentBoard.shells.list()))[0]!.zoneId).toBeNull();

    // ⌘Z: the same zone, bound to the same repo, with the shell back where it was.
    await page.keyboard.press('Meta+Z');
    await expect(zoneNamed(page, before!.name)).toHaveCount(1);
    expect((await zones(page))[0]).toMatchObject({ id: before!.id, kind: 'repo', repoRoot: repo, folder: '' });
    await expect
      .poll(async () => (await page.evaluate(() => window.agentBoard.shells.list()))[0])
      .toMatchObject({ zoneId: before!.id, position: placed.position });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the context menu's Delete is enabled on a selected zone, and the zone's ⋯ menu offers Delete zone… for a repo zone", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, env);
  try {
    await page.evaluate((path) => window.agentBoard.zones.addFolder(path, { x: 100, y: 100 }), repo);
    const [made] = await zones(page);
    const zone = zoneNamed(page, made!.name);

    await zone.getByTestId('zone-tab').click({ button: 'right', position: { x: 12, y: 12 } });
    const remove = page.getByRole('menuitem', { name: /^Delete ⌫/ });
    await expect(remove).toBeEnabled();
    await remove.click();
    await expect(page.getByRole('alertdialog', { name: `Delete zone ${made!.name}?` })).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();

    await zone.getByRole('button', { name: 'Zone options' }).click();
    await page.getByRole('menuitem', { name: 'Delete zone…' }).click();
    await page.getByRole('alertdialog', { name: `Delete zone ${made!.name}?` }).getByRole('button', { name: 'Delete' }).click();
    await expect(zone).toHaveCount(0);
    expect(existsSync(join(repo, '.git'))).toBe(true);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a managed clone offers an unticked box that deletes its folder too, and ⌘Z then brings the zone back as a group', async () => {
  const { dir, repo, env } = scratch('waiting');
  const reposDir = join(dir, 'repos');
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, repos: [{ nameWithOwner: 'acme/app', description: 'The app', cloneFrom: repo }] });
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, { ...env, AGENT_BOARD_GH: github.gh, AGENT_BOARD_REPOS_DIR: reposDir });
  try {
    const clone = join(reposDir, 'acme', 'app');
    await page.evaluate(() => window.agentBoard.zones.clone('acme/app', { x: 100, y: 100 }));
    await expect.poll(async () => (await zones(page))[0]?.managedClone).toBe(true);
    const [before] = await zones(page);
    const tab = zoneNamed(page, before!.name).getByTestId('zone-tab');
    const confirm = page.getByRole('alertdialog', { name: `Delete zone ${before!.name}?` });

    // Unticked, only the zone goes.
    await tab.click({ position: { x: 12, y: 12 } });
    await page.keyboard.press('Backspace');
    const box = confirm.getByRole('checkbox', { name: /^Also delete the clone in/ });
    await expect(box).not.toBeChecked();
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(zoneNamed(page, before!.name)).toHaveCount(0);
    expect(existsSync(join(clone, '.git'))).toBe(true);
    await page.keyboard.press('Meta+Z');
    await expect(zoneNamed(page, before!.name)).toHaveCount(1);
    expect((await zones(page))[0]).toMatchObject({ id: before!.id, kind: 'repo', repoRoot: clone });

    // Ticked, the folder goes too, and the zone comes back as a group.
    await tab.click({ position: { x: 12, y: 12 } });
    await page.keyboard.press('Backspace');
    await expect(box).not.toBeChecked();
    await box.check();
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(zoneNamed(page, before!.name)).toHaveCount(0);
    // The folder goes after the zone does, as the daemon removes it.
    await expect.poll(() => existsSync(clone)).toBe(false);
    await page.keyboard.press('Meta+Z');
    await expect(zoneNamed(page, before!.name)).toHaveCount(1);
    expect((await zones(page))[0]).toMatchObject({ id: before!.id, kind: 'unbound', repoRoot: null });
    await expect(page.getByText('is back as a group')).toBeVisible();
  } finally {
    await app.close();
    github.dispose();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a zone selected with a note and a shell is one confirmation and one undo step', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, env);
  try {
    await page.evaluate((path) => window.agentBoard.zones.addFolder(path, { x: 100, y: 100 }), repo);
    const [made] = await zones(page);
    await page.evaluate(
      () => window.agentBoard.items.create({ kind: 'sticky', zoneId: null, x: 900, y: 100, width: 160, height: 120, data: { text: 'note', color: '#fff3a3' } }),
    );
    await zoneNamed(page, made!.name).getByRole('button', { name: 'New shell in zone' }).click();
    await page.getByRole('button', { name: 'Close session window' }).click();
    await expect(page.getByTestId('shell-tile')).toHaveCount(1);
    await expect(page.getByTestId('sticky')).toHaveCount(1);

    // The board has the focus, on bare board.
    await page.locator('.react-flow__pane').click({ position: { x: 40, y: 500 } });
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Backspace');
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toHaveCount(1);
    await expect(confirm).toHaveAccessibleName('Delete selection?');
    await expect(confirm).toContainText(`${made!.name} comes off the board`);
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByTestId('sticky')).toHaveCount(0);
    await expect(page.getByTestId('shell-tile')).toHaveCount(0);
    expect(await zones(page)).toEqual([]);

    // One ⌘Z: the zone and the note come back together.
    await page.keyboard.press('Meta+Z');
    await expect(zoneNamed(page, made!.name)).toHaveCount(1);
    await expect(page.getByTestId('sticky')).toHaveCount(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a zone still cloning is left out of a delete, and a note selected with it is deleted', async () => {
  const { dir, repo, env } = scratch('waiting');
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, repos: [{ nameWithOwner: 'acme/app', description: 'The app', cloneFrom: repo }], cloneDelayMs: 30_000 });
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, { ...env, AGENT_BOARD_GH: github.gh, AGENT_BOARD_REPOS_DIR: join(dir, 'repos') });
  try {
    const cloning = await page.evaluate(() => window.agentBoard.zones.clone('acme/app', { x: 100, y: 100 }));
    await page.evaluate(
      () => window.agentBoard.items.create({ kind: 'sticky', zoneId: null, x: 900, y: 100, width: 160, height: 120, data: { text: 'note', color: '#fff3a3' } }),
    );
    await expect(page.getByTestId('sticky')).toHaveCount(1);
    await page.locator('.react-flow__pane').click({ position: { x: 40, y: 500 } });
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Backspace');
    const confirm = page.getByRole('alertdialog', { name: 'Delete selection?' });
    await expect(confirm).toContainText('still cloning');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByTestId('sticky')).toHaveCount(0);
    expect((await zones(page)).map((zone) => zone.id)).toEqual([cloning.id]);
  } finally {
    await app.close();
    github.dispose();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
