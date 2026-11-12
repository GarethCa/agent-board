import { expect } from '@playwright/test';
import type { BoardItem, QueueView } from '@agent-board/daemon/protocol';
import { withDaemon } from './board-helpers.ts';
import { test, connectedDaemonPid, launchApp, removeDataDir, tempDataDir } from './launch.ts';

/** The board's one queue, with its jobs, as the daemon has it. */
function storedQueue(dataDir: string): Promise<QueueView> {
  return withDaemon(dataDir, async (client) => {
    const queue = (await client.call('item.list')).find((item: BoardItem) => item.kind === 'queue')!;
    return client.call('queue.read', { id: queue.id });
  });
}

const openTexts = async (dataDir: string) => (await storedQueue(dataDir)).jobs.filter((job) => job.state !== 'done').map((job) => job.text);

test('Q puts a queue at the pointer ready to type; it queues jobs and notes, shows a change made elsewhere, reorders, finishes and folds to its ticket', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    await window.mouse.move(pane.x + 400, pane.y + 300);
    await window.keyboard.press('q');

    // A new queue opens on its empty state, its box focused, asking who it is for: a line is a job, its link after ->.
    const card = window.getByTestId('queue-card');
    await expect(card).toContainText('No jobs yet');
    await expect(card.getByRole('button', { name: 'For agents' })).toHaveAttribute('aria-pressed', 'true');
    const add = card.getByTestId('queue-add');
    await expect(add).toBeFocused();
    await add.fill('Fix the login -> https://example.test/issues/12');
    await add.press('Enter');
    await expect(card.locator('.listcard-row')).toHaveCount(1);
    await expect(card.locator('.listcard-row .queue-state')).toHaveText('next');
    await expect(card.locator('.listcard-row')).toContainText('Fix the login');
    await expect(card.locator('.listcard-row')).toContainText('#12');
    await add.fill('Write the docs');
    await add.press('Enter');
    // The switch makes the next line a note, read and never taken.
    await card.getByRole('button', { name: 'Adds a job: switch to a note' }).click();
    await add.fill('Ask before touching billing');
    await add.press('Enter');
    await expect(card.locator('.queue-counts')).toHaveText('2 queued · 1 note');
    const queue = await storedQueue(dataDir);
    expect(queue.jobs.map(({ kind, text, link }) => ({ kind, text, link }))).toEqual([
      { kind: 'task', text: 'Fix the login', link: 'https://example.test/issues/12' },
      { kind: 'task', text: 'Write the docs', link: null },
      { kind: 'info', text: 'Ask before touching billing', link: null },
    ]);

    // A change made elsewhere (an agent's, or the CLI's) shows on the card as it lands.
    const fix = queue.jobs[0]!;
    await withDaemon(dataDir, (client) => client.call('queue.change', { id: queue.item.id, change: { action: 'edit', job: fix.id, text: 'Fix the login page' } }));
    await expect(card.locator('.listcard-row').first()).toContainText('Fix the login page');

    // Open ↗: every row in its order. ⌥↓ moves a row down, D finishes it, ⌫ removes it and Undo puts it back where it was.
    await card.getByRole('button', { name: 'Open ↗' }).click();
    const peek = window.getByTestId('queue-peek');
    await expect(peek).toBeVisible();
    const search = peek.getByRole('textbox', { name: 'Search jobs and notes' });
    await search.press('ArrowDown');
    const first = peek.getByRole('button', { name: 'Edit Fix the login page' });
    await expect(first).toBeFocused();
    await first.press('Alt+ArrowDown');
    await expect.poll(() => openTexts(dataDir)).toEqual(['Write the docs', 'Fix the login page', 'Ask before touching billing']);
    await expect(card.locator('.listcard-row').first()).toContainText('Write the docs');
    // The moved row keeps the focus, so it moves on with each press.
    await expect(first).toBeFocused();
    await window.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => openTexts(dataDir)).toEqual(['Write the docs', 'Ask before touching billing', 'Fix the login page']);
    await expect(first).toBeFocused();
    await peek.getByRole('button', { name: 'Edit Write the docs' }).focus();
    await window.keyboard.press('d');
    await expect.poll(async () => (await storedQueue(dataDir)).jobs.find((job) => job.text === 'Write the docs')?.state).toBe('done');
    await expect(card.locator('.queue-counts')).toHaveText('1 queued · 1 note · 1 done');
    await peek.getByRole('button', { name: 'Edit Ask before touching billing' }).focus();
    await window.keyboard.press('Backspace');
    await expect.poll(() => openTexts(dataDir)).toEqual(['Fix the login page']);
    await window.locator('.ui-toast', { hasText: 'Removed “Ask before touching billing”' }).getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => openTexts(dataDir)).toEqual(['Ask before touching billing', 'Fix the login page']);

    // A click on a row edits it: esc puts it back and leaves the peek open; ↵ saves it, a link after -> its link.
    await peek.getByRole('button', { name: 'Edit Ask before touching billing' }).click();
    const edit = peek.getByRole('textbox', { name: 'Edit Ask before touching billing' });
    await edit.fill('Ask first -> docs/billing.md');
    await edit.press('Escape');
    await expect(peek).toBeVisible();
    await peek.getByRole('button', { name: 'Edit Ask before touching billing' }).click();
    await edit.fill('Ask first -> docs/billing.md');
    await edit.press('Enter');
    await expect
      .poll(async () => (await storedQueue(dataDir)).jobs.find((job) => job.kind === 'info'))
      .toMatchObject({ text: 'Ask first', link: 'docs/billing.md' });
    await window.keyboard.press('Escape');
    await expect(peek).toBeHidden();

    // Folded, it is its ticket with its count, the NEXT tab naming the next job, and its scope; a click opens the peek.
    await card.locator('.listcard-title').click();
    await window.getByRole('button', { name: 'Fold to its icon' }).click();
    const icon = window.getByTestId('queue-icon');
    await expect(icon).toBeVisible();
    await expect(icon.locator('.listcard-count')).toHaveText('2');
    await expect(icon.locator('.queue-next-tab')).toBeVisible();
    await expect(icon.locator('.queue-next-tab')).toHaveAttribute('title', 'next: Fix the login page');
    await expect(icon.getByText('Board')).toBeVisible();
    await expect.poll(async () => (await storedQueue(dataDir)).item.data.folded).toBe(true);
    await icon.getByRole('button', { name: /open its peek/ }).click();
    await expect(peek).toBeVisible();
    await window.keyboard.press('Escape');

    // Made the user's own, it is their inbox, which no agent takes from.
    await icon.locator('.listcard-icon-name').click();
    await window.getByRole('button', { name: 'Make it a queue for you' }).click();
    await expect(icon).toContainText('To look at');
    await expect.poll(async () => (await storedQueue(dataDir)).item.data).toMatchObject({ audience: 'user', title: 'To look at' });
    await window.getByRole('button', { name: 'Open the card' }).click();
    await expect(card).toBeVisible();
    await expect(card.getByTestId('queue-add')).not.toBeFocused();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
