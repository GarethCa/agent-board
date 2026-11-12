import { expect } from '@playwright/test';
import type { BoardItem, QueueView } from '@agent-board/daemon/protocol';
import { withDaemon } from './board-helpers.ts';
import { test, connectedDaemonPid, launchApp, removeDataDir, tempDataDir } from './launch.ts';

/** The user's queue, with its jobs, as the daemon has it. */
function storedQueue(dataDir: string): Promise<QueueView> {
  return withDaemon(dataDir, async (client) => {
    const queue = (await client.call('item.list')).find((item: BoardItem) => item.kind === 'queue')!;
    return client.call('queue.read', { id: queue.id });
  });
}

const openTexts = async (dataDir: string) => (await storedQueue(dataDir)).jobs.filter((job) => job.state !== 'done').map((job) => job.text);

test('⌘⇧P parks a line at the back of the user’s queue and gives the focus back; Esc and an empty line park nothing; ⌘K finds it too; Undo takes it back', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    // The user's own queue, made as a person makes one: Q at the pointer, For you, a first line typed in its box.
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    await window.mouse.move(pane.x + 400, pane.y + 300);
    await window.keyboard.press('q');
    const card = window.getByTestId('queue-card');
    await card.getByRole('button', { name: 'For you' }).click();
    const add = card.getByTestId('queue-add');
    await add.fill('Read the brief');
    await add.press('Enter');
    await expect(card.locator('.listcard-row')).toHaveCount(1);

    // Something else has the focus: the card's own add box.
    await add.focus();
    await expect(add).toBeFocused();

    const field = window.getByTestId('park-thought');
    const line = field.getByRole('textbox', { name: 'Park a thought' });
    await window.keyboard.press('ControlOrMeta+Shift+KeyP');
    await expect(line).toBeFocused();
    await line.fill('check whether the docs need a page');
    await line.press('Enter');
    await expect(field).toBeHidden();
    await expect(add).toBeFocused();
    await expect.poll(() => openTexts(dataDir)).toEqual(['Read the brief', 'check whether the docs need a page']);

    // Esc closes it with nothing parked, and so does an empty (or blank) line.
    await window.keyboard.press('ControlOrMeta+Shift+KeyP');
    await line.fill('not this one');
    await line.press('Escape');
    await expect(field).toBeHidden();
    await expect(add).toBeFocused();
    await window.keyboard.press('ControlOrMeta+Shift+KeyP');
    await line.fill('   ');
    await line.press('Enter');
    await expect(field).toBeHidden();
    await expect(add).toBeFocused();

    // ⌘K's Park a thought opens the same field.
    await window.keyboard.press('ControlOrMeta+KeyK');
    await window.getByRole('combobox').fill('park a thought');
    await window.getByRole('option', { name: /Park a thought/ }).click();
    await line.fill('from the switcher');
    await line.press('Enter');
    await expect(field).toBeHidden();
    await expect.poll(() => openTexts(dataDir)).toEqual(['Read the brief', 'check whether the docs need a page', 'from the switcher']);

    // The toast that says so takes it back.
    await window.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => openTexts(dataDir)).toEqual(['Read the brief', 'check whether the docs need a page']);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
