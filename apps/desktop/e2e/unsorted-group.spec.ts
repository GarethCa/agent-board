import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExternalSession, Zone } from '@agent-board/daemon/protocol';
import { claudeInTerminal, launch, zoneNamed } from './agent-helpers.ts';
import { settledBox, withDaemon } from './board-helpers.ts';
import { connectedDaemonPid, removeDataDir, stopDaemon, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

const storedZones = (dataDir: string): Promise<Zone[]> => withDaemon(dataDir, (client) => client.call('zone.list'));
const storedExternals = (dataDir: string): Promise<ExternalSession[]> => withDaemon(dataDir, (client) => client.call('external.list'));

/** Presses on `from`, drags to `to` and lets go. */
async function dragBy(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

/** A full restart: the app and its daemon both go, so the board must come back from the database. */
async function restart(app: ElectronApplication, page: Page, dataDir: string, env: Record<string, string>) {
  await connectedDaemonPid(page);
  await app.close();
  await stopDaemon(dataDir);
  return launch(dataDir, env);
}

test('Unsorted is a group zone that moves, resizes, renames and dissolves like any other, and keeps its layout across a restart', async () => {
  const { dir, env } = scratch('waiting');
  const home = env.HOME!;
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'ab-e2e-elsewhere-')));
  const dataDir = tempDataDir();
  // Never the developer's own ~/.claude or ~/.codex.
  const appEnv = { ...env, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex') };
  let { app, window: page } = await launch(dataDir, appEnv);
  const sessions: ChildProcessWithoutNullStreams[] = [];
  try {
    await page.evaluate(() => window.agentBoard.external.setHooksEnabled(true));
    for (const cwd of [dir, elsewhere]) {
      const session = claudeInTerminal(cwd, home, ['Pick a database'], 'waiting');
      session.stdout.resume();
      session.stderr.resume();
      sessions.push(session);
    }

    // Two sessions in no repo's zone: both appear in one ordinary group, "Unsorted".
    const group = () => zoneNamed(page, 'Unsorted');
    await expect(group()).toHaveCount(1);
    await expect(group()).toHaveAttribute('data-kind', 'unbound');
    const unsorted = (await storedZones(dataDir)).find((zone) => zone.name === 'Unsorted')!;
    const inGroup = page.locator(`[data-testid="external-tile"][data-zone="${unsorted.id}"]`);
    await expect(inGroup).toHaveCount(2);
    await expect.poll(async () => (await storedExternals(dataDir)).every((session) => session.position !== null)).toBe(true);

    // Moved by its tab, then widened from its bottom-left corner (the bottom-right one sits under the minimap).
    await page.getByRole('button', { name: 'Fit View' }).click();
    await page.getByRole('button', { name: 'Zoom Out' }).click();
    const tabBox = await settledBox(group().getByTestId('zone-tab'));
    await dragBy(page, { x: tabBox.x + 10, y: tabBox.y + tabBox.height / 2 }, { x: tabBox.x + 10, y: tabBox.y + 100 });
    await expect.poll(async () => (await storedZones(dataDir)).find((zone) => zone.id === unsorted.id)!.y).not.toBe(unsorted.y);
    const moved = (await storedZones(dataDir)).find((zone) => zone.id === unsorted.id)!;
    await group().getByTestId('zone-tab').click({ position: { x: 12, y: 12 } });
    const corner = await settledBox(group().locator('.react-flow__resize-control.handle.bottom.left'));
    await dragBy(page, { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 }, { x: corner.x - 60, y: corner.y + 40 });
    await expect.poll(async () => (await storedZones(dataDir)).find((zone) => zone.id === unsorted.id)!.width).toBeGreaterThan(moved.width);
    const resized = (await storedZones(dataDir)).find((zone) => zone.id === unsorted.id)!;

    // Renamed in place, from its tab.
    await group().getByTestId('zone-tab').getByText('Unsorted', { exact: true }).dblclick();
    await page.getByTestId('rename-field').fill('Strays');
    await page.keyboard.press('Enter');
    await expect(zoneNamed(page, 'Strays')).toHaveCount(1);
    await expect.poll(async () => (await storedZones(dataDir)).find((zone) => zone.id === unsorted.id)!.name).toBe('Strays');

    // A tile dragged out of it is loose on the board, where it was let go.
    const strays = () => zoneNamed(page, 'Strays');
    const first = inGroup.first();
    const box = await settledBox(first);
    const zoneBox = await settledBox(strays());
    await dragBy(page, { x: box.x + 40, y: box.y + box.height - 12 }, { x: box.x + 40, y: zoneBox.y + zoneBox.height + 80 });
    await expect.poll(async () => (await storedExternals(dataDir)).filter((session) => session.zoneId === null).length).toBe(1);
    const loose = (await storedExternals(dataDir)).find((session) => session.zoneId === null)!;
    expect(loose.position).not.toBeNull();

    // The layout outlives a restart: the group where and as big as it was, its new name, the tile still out.
    ({ app, window: page } = await restart(app, page, dataDir, appEnv));
    await expect(strays()).toHaveCount(1);
    await expect(zoneNamed(page, 'Unsorted')).toHaveCount(0);
    const kept = (await storedZones(dataDir)).find((zone) => zone.id === unsorted.id)!;
    expect(kept).toMatchObject({ name: 'Strays', x: resized.x, y: resized.y, width: resized.width, height: resized.height });
    const afterRestart = await storedExternals(dataDir);
    expect(afterRestart.find((session) => session.id === loose.id)).toMatchObject({ zoneId: null, position: loose.position });
    expect(afterRestart.filter((session) => session.zoneId === unsorted.id)).toHaveLength(1);

    // Dissolved from its ⋯ menu, it leaves its tile loose where it is drawn, and no group in its place.
    const staying = page.locator(`[data-testid="external-tile"][data-zone="${unsorted.id}"]`);
    await expect(staying).toHaveCount(1);
    const drawnAt = await settledBox(staying);
    await strays().getByRole('button', { name: 'Zone options' }).click();
    await page.getByRole('menuitem', { name: 'Dissolve' }).click();
    await expect(strays()).toHaveCount(0);
    await expect(page.getByTestId('external-tile').and(page.locator('[data-zone=""]'))).toHaveCount(2);
    const stayed = await settledBox(page.getByTestId('external-tile').and(page.locator('[data-zone=""]')).filter({ hasText: (await storedExternals(dataDir)).find((session) => session.id !== loose.id)!.name }));
    expect(Math.abs(stayed.x - drawnAt.x)).toBeLessThan(2);
    expect(Math.abs(stayed.y - drawnAt.y)).toBeLessThan(2);
    expect(await storedZones(dataDir)).toEqual([]);
    expect((await storedExternals(dataDir)).every((session) => session.zoneId === null && session.position !== null)).toBe(true);

    ({ app, window: page } = await restart(app, page, dataDir, appEnv));
    await expect(page.getByTestId('external-tile')).toHaveCount(2);
    await expect(page.getByTestId('zone')).toHaveCount(0);
    expect(await storedZones(dataDir)).toEqual([]);
  } finally {
    for (const session of sessions) session.kill();
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('a group dissolved right after it was dragged leaves its tile exactly where it is drawn', async () => {
  const { dir, env } = scratch('waiting');
  const home = env.HOME!;
  const dataDir = tempDataDir();
  // Never the developer's own ~/.claude or ~/.codex.
  const appEnv = { ...env, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex') };
  const { app, window: page } = await launch(dataDir, appEnv);
  const session = claudeInTerminal(dir, home, ['Pick a database'], 'waiting');
  try {
    await page.evaluate(() => window.agentBoard.external.setHooksEnabled(true));
    session.stdout.resume();
    session.stderr.resume();
    const group = zoneNamed(page, 'Unsorted');
    await expect(group).toHaveCount(1);
    const tileIn = page.getByTestId('external-tile');
    await expect.poll(async () => (await storedExternals(dataDir))[0]?.position).not.toBeNull();

    // Dragged by its tab and, at once, dissolved: no wait for the daemon's word of where the zone went.
    await page.getByRole('button', { name: 'Fit View' }).click();
    await page.getByRole('button', { name: 'Zoom Out' }).click();
    const tab = await settledBox(group.getByTestId('zone-tab'));
    await dragBy(page, { x: tab.x + 10, y: tab.y + tab.height / 2 }, { x: tab.x + 120, y: tab.y + 140 });
    const drawn = await settledBox(tileIn);
    await group.getByRole('button', { name: 'Zone options' }).click();
    await page.getByRole('menuitem', { name: 'Dissolve' }).click();

    await expect(group).toHaveCount(0);
    await expect(tileIn).toHaveAttribute('data-zone', '');
    const after = await settledBox(tileIn);
    expect(Math.abs(after.x - drawn.x)).toBeLessThan(2);
    expect(Math.abs(after.y - drawn.y)).toBeLessThan(2);
    expect(await storedZones(dataDir)).toEqual([]);
  } finally {
    session.kill();
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
