import { expect } from '@playwright/test';
import { daemonPaths } from '@agent-board/daemon/paths';
import { withDaemon } from './board-helpers.ts';
import { connectedDaemonPid, launchApp, removeDataDir, stopDaemon, tempDataDir, test } from './launch.ts';

// An item of a kind this version doesn't know, as a newer version may leave on the board.
const NEWER_DATA = { owner: 'some.mod', kind: 'gauge', version: 3, payload: { needle: 0.4 } };

test('a board with an item of a kind this version does not know loads, and draws it as a placeholder that moves and deletes', async () => {
  const dataDir = tempDataDir();
  let app = await launchApp(dataDir);
  try {
    let window = await app.firstWindow();
    const firstDaemon = await connectedDaemonPid(window);
    const made = await withDaemon(dataDir, (client) =>
      client.call('item.create', { kind: 'sticky', zoneId: null, x: 200, y: 200, width: 200, height: 120, data: { text: 'soon a mod item', color: '#fff3a3' } }),
    );
    await expect(window.getByTestId('sticky')).toHaveCount(1);
    await app.close();
    expect([firstDaemon, undefined]).toContain(await stopDaemon(dataDir));
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(daemonPaths(dataDir).database);
    db.prepare('UPDATE board_items SET kind = ?, data = ? WHERE id = ?').run('mod', JSON.stringify(NEWER_DATA), made.id);
    db.close();

    app = await launchApp(dataDir);
    window = await app.firstWindow();
    await connectedDaemonPid(window);
    const placeholder = window.getByTestId('unknown-item');
    await expect(placeholder).toHaveAttribute('data-kind', 'mod');
    await expect(placeholder).toContainText('Mod item');
    await expect(window.getByRole('button', { name: 'Zone', exact: true })).toBeVisible();

    // Moved, it keeps its data as the newer version left it.
    const box = (await placeholder.boundingBox())!;
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 10 });
    await window.mouse.up();
    await expect
      .poll(async () => withDaemon(dataDir, async (client) => (await client.call('item.list')).find((item) => item.id === made.id)?.x))
      .toBeGreaterThan(250);
    const stored = await withDaemon(dataDir, async (client) => (await client.call('item.list')).find((item) => item.id === made.id));
    expect(stored).toMatchObject({ kind: 'mod', data: NEWER_DATA });

    // Selected, it deletes like any item, but for good: undo says this version can't make it again.
    await window.getByRole('button', { name: "Delete mod item: this version can't undo it" }).click();
    await expect(placeholder).toHaveCount(0);
    await expect.poll(async () => withDaemon(dataDir, async (client) => (await client.call('item.list')).some((item) => item.id === made.id))).toBe(false);
    await window.keyboard.press('ControlOrMeta+z');
    await expect(window.getByRole('alert').filter({ hasText: 'add the mod item' })).toBeVisible();
    await expect(placeholder).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
