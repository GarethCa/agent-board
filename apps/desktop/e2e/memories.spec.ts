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

test('M puts a memory at the pointer ready to type; it remembers what is typed, shows a write made elsewhere, opens full screen to edit a fact and write a document, folds to its icon, whose peek searches and edits, and back', async () => {
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

    // Open, at the card's foot, shows it full screen: search, edit a fact as it saves itself, and write a document.
    await card.getByRole('button', { name: 'Open full screen' }).click();
    const full = window.getByTestId('memory-full');
    await expect(full).toBeVisible();
    const find = full.getByRole('textbox', { name: 'Search facts and documents' });
    // It opens on the newest entry, focused in the list: / goes to the search.
    await expect(full.locator('.memory-full-item[aria-current="true"]')).toBeFocused();
    await window.keyboard.press('/');
    await expect(find).toBeFocused();
    await find.fill('tues');
    await expect(full.locator('.memory-full-item')).toHaveCount(1);
    await full.locator('.memory-full-item').click();
    const value = full.getByRole('textbox', { name: 'Value' });
    await expect(value).toHaveValue('Tuesdays');
    await value.fill('Wednesdays');
    await expect.poll(async () => (await storedMemory(dataDir)).entries.find((entry) => entry.key === 'deploy.day')?.text).toBe('Wednesdays');
    await expect(card.locator('.listcard-row')).toContainText(['Wednesdays']);
    await expect(full.getByRole('region', { name: 'Who and when' })).toContainText('you changed the text');
    // Esc clears the search, and cancels a new entry, without closing the view.
    await find.press('Escape');
    await expect(find).toHaveValue('');
    await expect(full).toBeVisible();
    await full.getByRole('button', { name: 'Document', exact: true }).click();
    const doc = full.getByRole('form', { name: 'New document' });
    await doc.getByRole('textbox', { name: 'Title' }).press('Escape');
    await expect(doc).toBeHidden();
    await expect(full).toBeVisible();
    await full.getByRole('button', { name: 'Document', exact: true }).click();
    await doc.getByRole('textbox', { name: 'Title' }).fill('How we test');
    await doc.getByRole('textbox', { name: 'Document text' }).fill('# Testing\n\nRerun a flaky test once.');
    await doc.getByRole('textbox', { name: 'Document text' }).press('Meta+Enter');
    await expect.poll(async () => (await storedMemory(dataDir)).entries.filter((entry) => entry.file).map(({ key, text }) => ({ key, text }))).toEqual([{ key: 'How we test', text: '# Testing\n\nRerun a flaky test once.' }]);
    // Added, it opens to write on.
    await expect(full.getByRole('article', { name: 'How we test' }).getByRole('textbox', { name: 'Document text' })).toBeFocused();
    // The card has room for a row under each section's head: the document, and the newest fact.
    await expect(card.locator('.listcard-row')).toHaveCount(2);
    await expect(card.locator('.memory-doc-row')).toContainText('How we test');
    await window.keyboard.press('Escape');
    await expect(full).toBeHidden();

    // Folded, it is its brain icon with its count; a click opens its peek beside it, with every entry to search.
    await card.locator('.listcard-title').click();
    await window.getByRole('button', { name: 'Fold to its icon' }).click();
    const icon = window.getByTestId('memory-icon');
    await expect(icon).toBeVisible();
    await expect(icon.locator('.listcard-count')).toHaveText('3');
    await expect.poll(async () => (await storedMemory(dataDir)).item.data.folded).toBe(true);
    await icon.getByRole('button', { name: /open its peek/ }).click();
    const peek = window.getByTestId('memory-peek');
    await expect(peek).toBeVisible();
    await peek.getByRole('textbox', { name: 'Search entries' }).fill('wednes');
    await expect(peek.locator('.listcard-peek-row')).toHaveCount(1);

    // A click on a value edits it: esc puts it back and leaves the peek open; ↵ saves it.
    await peek.getByRole('button', { name: 'Edit deploy.day' }).click();
    const edit = peek.getByRole('textbox', { name: 'Edit deploy.day' });
    await edit.fill('Thursdays');
    await edit.press('Escape');
    await expect(peek).toBeVisible();
    await expect(peek.locator('.listcard-peek-row')).toContainText('Wednesdays');
    expect((await storedMemory(dataDir)).entries.find((entry) => entry.key === 'deploy.day')?.text).toBe('Wednesdays');
    await peek.getByRole('button', { name: 'Edit deploy.day' }).click();
    await edit.fill('Thursdays');
    await edit.press('Enter');
    // Saved, it no longer matches the search.
    await expect(peek.locator('.listcard-peek-row')).toHaveCount(0);
    await expect.poll(async () => (await storedMemory(dataDir)).entries.find((entry) => entry.key === 'deploy.day')?.text).toBe('Thursdays');

    // Pinned, a row goes to the top.
    const search = peek.getByRole('textbox', { name: 'Search entries' });
    await search.fill('staging');
    await peek.locator('.listcard-peek-row').first().hover();
    await peek.getByRole('button', { name: 'Pin note' }).click();
    await search.fill('');
    await expect(peek.locator('.listcard-peek-row').first()).toContainText('Staging is down');

    // By key: ↓ from the search reaches the first row, / goes back to the search, ⌫ removes the row, and Undo puts it back.
    await search.press('ArrowDown');
    const first = peek.getByRole('button', { name: 'Edit note' });
    await expect(first).toBeFocused();
    await first.press('/');
    await expect(search).toBeFocused();
    await search.press('ArrowDown');
    await first.press('Backspace');
    await expect(peek.locator('.listcard-peek-row')).toHaveCount(2);
    await window.locator('.ui-toast', { hasText: 'Removed note' }).getByRole('button', { name: 'Undo' }).click();
    await expect(peek.locator('.listcard-peek-row')).toHaveCount(3);
    await expect.poll(async () => (await storedMemory(dataDir)).entries.map((entry) => entry.text).toSorted()).toEqual(['# Testing\n\nRerun a flaky test once.', 'Staging is down until 14:00', 'Thursdays']);
    await window.keyboard.press('Escape');
    await expect(peek).toBeHidden();

    // Zoomed far out, its face stops shrinking: it still reads as a memory, with its count.
    const face = icon.getByRole('button', { name: /open its peek/ });
    const size = (await face.boundingBox())!.width;
    for (let at = 0; at < 6; at++) await window.getByRole('button', { name: 'Zoom out' }).click();
    await expect(icon).toHaveAttribute('data-lifted', 'true');
    await expect.poll(async () => (await face.boundingBox())!.width).toBeGreaterThan(size * 0.55);
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
