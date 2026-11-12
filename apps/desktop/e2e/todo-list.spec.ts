import { expect, type Page } from '@playwright/test';
import type { TodoData } from '@agent-board/daemon/protocol';
import { rmSync } from 'node:fs';
import { launch, sessionWindow, spawnAgent } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// A to-do list on the board: an agent's `remind` (the fake claude's `Remind: …`) puts one under its tile, its zone's tab
// counts what is left, and the user ticks, adds and folds it in place, each saved as the user's.

const card = (window: Page) => window.getByTestId('todo-card');
const badge = (window: Page) => window.getByTestId('zone-todo-badge');

/** The saved lines of the board's one to-do list. */
const savedLines = (page: Page) =>
  page.evaluate(async () => {
    const items = await window.agentBoard.items.list();
    return (items.find((item) => item.kind === 'todo')!.data as unknown as TodoData).lines;
  });

test("an agent's reminders make its to-do list, counted on the zone's tab, which the user ticks, adds to and folds", async () => {
  const setup = scratch('ask-plan');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, setup.env);
  try {
    await pickFolderNext(app, setup.repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Remind: Send #214 off for approval ;; Restart the app');

    // Its list, with who wrote each line, and the count of what is left on the zone's tab.
    await expect(card(window)).toBeVisible();
    await expect(card(window).getByTestId('todo-line')).toHaveCount(2);
    await expect(card(window).getByTestId('todo-count')).toHaveText('2');
    await expect(badge(window)).toHaveText('2');

    // The user ticks one: the count goes down, and the tick is saved as theirs.
    await card(window).getByRole('checkbox', { name: 'Send #214 off for approval' }).click();
    await expect(card(window).getByTestId('todo-count')).toHaveText('1');
    await expect(badge(window)).toHaveText('1');
    await expect.poll(async () => (await savedLines(window))[0]?.done?.by.kind).toBe('user');

    // The tab's count lists the zone's lists by whose they are; a tick there is the card's, and stays to be unticked.
    await badge(window).click();
    const popover = window.getByTestId('zone-todo-popover');
    await expect(popover.getByTestId('zone-todo-group')).toHaveCount(1);
    await expect(popover.getByTestId('zone-todo-line')).toHaveCount(2);
    await popover.getByRole('checkbox', { name: 'Restart the app' }).click();
    await expect(card(window).getByTestId('todo-count')).toHaveText('All done');
    await popover.getByRole('checkbox', { name: 'Restart the app' }).click();
    await expect(badge(window)).toHaveText('1');

    // A double-click edits a line there: esc cancels the edit and leaves the list open, ↵ saves it trimmed, and an
    // emptied line keeps its words.
    const text = (name: string) => popover.getByTestId('zone-todo-line').locator('.todo-text', { hasText: name });
    const lineField = popover.getByTestId('todo-input');
    await text('Restart the app').dblclick();
    await lineField.fill('Half typed');
    await lineField.press('Escape');
    await expect(popover).toBeVisible();
    await expect(lineField).toHaveCount(0);
    await expect(text('Restart the app')).toBeVisible();
    await text('Restart the app').dblclick();
    await lineField.fill('  Restart the app tonight  ');
    await lineField.press('Enter');
    await expect(text('Restart the app tonight')).toBeVisible();
    await expect.poll(async () => (await savedLines(window))[1]?.text).toBe('Restart the app tonight');
    await text('Restart the app tonight').dblclick();
    await lineField.fill('');
    await lineField.press('Enter');
    await expect(text('Restart the app tonight')).toBeVisible();

    await window.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);

    // The agent's list opens as a tab in its window, the same list.
    await card(window).locator('.todo-head').click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Open in its window' }).click();
    const tab = sessionWindow(window).getByTestId('todo-tab');
    await expect(tab.getByTestId('todo-line')).toHaveCount(2);
    await tab.getByRole('checkbox', { name: 'Restart the app' }).click();
    await expect(badge(window)).toHaveCount(0);
    await tab.getByRole('checkbox', { name: 'Restart the app' }).click();
    await expect(badge(window)).toHaveText('1');
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow(window)).toHaveCount(0);

    // And adds one of their own, from the foot.
    await card(window).getByRole('button', { name: 'Add a to-do' }).click();
    const field = card(window).getByTestId('todo-input');
    await expect(field).toBeFocused();
    await field.fill('Book the release slot');
    await field.press('Enter');
    await field.press('Escape');
    await expect(card(window).getByTestId('todo-line')).toHaveCount(3);
    await expect(badge(window)).toHaveText('2');
    await expect.poll(async () => (await savedLines(window)).map((line) => line.by.kind)).toEqual(['agent', 'agent', 'user']);

    // Ticked off, the tab's count goes, and the folded pill says all done.
    for (const name of ['Restart the app', 'Book the release slot']) await card(window).getByRole('checkbox', { name }).click();
    await expect(badge(window)).toHaveCount(0);
    await card(window).locator('.todo-head').click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Fold' }).click();
    await expect(window.getByTestId('todo-pill')).toHaveText(/All done/);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(setup.dir, { recursive: true, force: true });
  }
});
