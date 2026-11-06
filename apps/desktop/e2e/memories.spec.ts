import { expect } from '@playwright/test';
import type { BoardItem, MemoryView } from '@agent-board/daemon/protocol';
import { withDaemon } from './board-helpers.ts';
import { test, connectedDaemonPid, launchApp, removeDataDir, tempDataDir } from './launch.ts';

/** The board's one memory, with its entries, as the daemon has it. */
function storedMemory(dataDir: string): Promise<MemoryView> {
  return withDaemon(dataDir, async (client) => {
    const memory = (await client.call('item.list')).find((item: BoardItem) => item.kind === 'memory')!;
    return client.call('memory.read', { id: memory.id });
  });
}

test('M puts a memory at the pointer ready to type; it remembers what is typed, shows a write made elsewhere, opens its peek to search, and folds to its icon and back', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    await window.mouse.move(pane.x + 400, pane.y + 300);
    await window.keyboard.press('m');

    // A new memory opens on its empty state, its box focused: `key: value` makes a keyed entry.
    const card = window.getByTestId('memory-card');
    await expect(card).toContainText('Nothing remembered yet');
    await expect(card.getByTestId('memory-scope')).toHaveText('Board');
    const add = card.getByTestId('memory-add');
    await expect(add).toBeFocused();
    await add.fill('deploy.day: Tuesdays');
    await add.press('Enter');
    await expect(card.locator('.listcard-row')).toHaveCount(1);
    await expect(card.locator('.listcard-row')).toContainText('deploy.day');
    await expect(card.locator('.listcard-row')).toContainText('Tuesdays');
    await expect(add).toHaveValue('');
    const memory = await storedMemory(dataDir);
    expect(memory.entries.map(({ key, text }) => ({ key, text }))).toEqual([{ key: 'deploy.day', text: 'Tuesdays' }]);

    // A write made elsewhere (an agent's, or the CLI's) shows on the card as it lands.
    await withDaemon(dataDir, (client) => client.call('memory.change', { id: memory.item.id, change: { action: 'add', text: 'Staging is down until 14:00' } }));
    await expect(card.locator('.listcard-row')).toHaveCount(2);
    await expect(card.locator('.listcard-row').first()).toContainText('Staging is down');

    // Open ↗ shows every entry beside it, to search.
    await card.getByRole('button', { name: 'Open ↗' }).click();
    const peek = window.getByTestId('memory-peek');
    await expect(peek).toBeVisible();
    await peek.getByRole('textbox', { name: 'Search entries' }).fill('tues');
    await expect(peek.locator('.listcard-peek-row')).toHaveCount(1);

    // A click on a value edits it: esc puts it back and leaves the peek open; ↵ saves it.
    await peek.getByRole('button', { name: 'Edit deploy.day' }).click();
    const edit = peek.getByRole('textbox', { name: 'Edit deploy.day' });
    await edit.fill('Wednesdays');
    await edit.press('Escape');
    await expect(peek).toBeVisible();
    await expect(peek.locator('.listcard-peek-row')).toContainText('Tuesdays');
    expect((await storedMemory(dataDir)).entries.find((entry) => entry.key === 'deploy.day')?.text).toBe('Tuesdays');
    await peek.getByRole('button', { name: 'Edit deploy.day' }).click();
    await edit.fill('Wednesdays');
    await edit.press('Enter');
    await expect(card.locator('.listcard-row')).toContainText(['Wednesdays', 'Staging is down']);
    await expect.poll(async () => (await storedMemory(dataDir)).entries.find((entry) => entry.key === 'deploy.day')?.text).toBe('Wednesdays');

    // Pinned, a row goes to the top of the card.
    const search = peek.getByRole('textbox', { name: 'Search entries' });
    await search.fill('');
    await peek.locator('.listcard-peek-row').nth(1).hover();
    await peek.getByRole('button', { name: 'Pin note' }).click();
    await expect(card.locator('.listcard-row').first()).toContainText('Staging is down');

    // By key: ↓ from the search reaches the first row, / goes back to the search, ⌫ removes the row, and Undo puts it back.
    await search.press('ArrowDown');
    const first = peek.getByRole('button', { name: 'Edit note' });
    await expect(first).toBeFocused();
    await first.press('/');
    await expect(search).toBeFocused();
    await search.press('ArrowDown');
    await first.press('Backspace');
    await expect(peek.locator('.listcard-peek-row')).toHaveCount(1);
    await window.locator('.ui-toast', { hasText: 'Removed note' }).getByRole('button', { name: 'Undo' }).click();
    await expect(peek.locator('.listcard-peek-row')).toHaveCount(2);
    await expect.poll(async () => (await storedMemory(dataDir)).entries.map((entry) => entry.text).toSorted()).toEqual(['Staging is down until 14:00', 'Wednesdays']);
    await window.keyboard.press('Escape');
    await expect(peek).toBeHidden();

    // Folded, it is its brain icon with its count; a click opens the same peek.
    await card.locator('.listcard-title').click();
    await window.getByRole('button', { name: 'Fold to its icon' }).click();
    const icon = window.getByTestId('memory-icon');
    await expect(icon).toBeVisible();
    await expect(icon.locator('.listcard-count')).toHaveText('2');
    await expect.poll(async () => (await storedMemory(dataDir)).item.data.folded).toBe(true);
    await icon.getByRole('button', { name: /open its peek/ }).click();
    await expect(peek).toBeVisible();
    await window.keyboard.press('Escape');

    // Zoomed far out, its face stops shrinking: it still reads as a memory, with its count.
    const face = icon.getByRole('button', { name: /open its peek/ });
    const full = (await face.boundingBox())!.width;
    for (let at = 0; at < 6; at++) await window.getByRole('button', { name: 'Zoom out' }).click();
    await expect(icon).toHaveAttribute('data-lifted', 'true');
    await expect.poll(async () => (await face.boundingBox())!.width).toBeGreaterThan(full * 0.55);
    for (let at = 0; at < 6; at++) await window.getByRole('button', { name: 'Zoom in' }).click();
    await expect(icon).not.toHaveAttribute('data-lifted');

    await icon.locator('.listcard-icon-name').click();
    await window.getByRole('button', { name: 'Open the card' }).click();
    await expect(card).toBeVisible();
    await expect.poll(async () => (await storedMemory(dataDir)).item.width).toBe(340);
    // Drawn anew, the card leaves the keyboard where it was: only a memory just made takes it.
    await expect(card.getByTestId('memory-add')).not.toBeFocused();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
