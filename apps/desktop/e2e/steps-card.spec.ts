import { expect, type Page } from '@playwright/test';
import type { Agent } from '@agent-board/daemon/protocol';
import { rmSync } from 'node:fs';
import { launch, screen, sessionWindow, spawnAgent, tile } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// Steps cards on the board: an agent's (the fake claude's `Steps: …` puts one up), answered on the card and sent, and
// one the user makes with K, typed in and ticked.

const card = (window: Page) => window.getByTestId('steps-card');

/** Runs `body` with the app open on a fresh repo zone whose agents run the fake claude's `ask-plan` scenario. */
async function withApp(body: (window: Page) => Promise<void>): Promise<void> {
  const setup = scratch('ask-plan');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, setup.env);
  try {
    await pickFolderNext(app, setup.repo);
    await browseForZone(window);
    await body(window);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(setup.dir, { recursive: true, force: true });
  }
}

/** Starts an agent in the repo's zone with `prompt`, and returns it. */
async function spawn(page: Page, prompt: string): Promise<Agent> {
  const before = await page.evaluate(() => window.agentBoard.agents.list());
  await spawnAgent(page, 'monorepo', prompt);
  const after = await page.evaluate(() => window.agentBoard.agents.list());
  return after.find((agent) => !before.some((known) => known.sessionId === agent.sessionId))!;
}

test("an agent's steps card is answered on the board by key and click, and Send types the answers at its prompt", async () => {
  await withApp(async (window) => {
    const agent = await spawn(window, 'Steps: # Release 0.7 ;; ? Ship on Friday? [yes/no] (required) ;; ? Which store? [Redis | SQLite] ;; - [ ] Pin node 22 @user');

    // At rest: its title, how far along, and the step that is the user's.
    await expect(card(window)).toBeVisible();
    await expect(card(window)).toContainText('Release 0.7');
    await expect(card(window).getByTestId('steps-count')).toHaveText('0/3');
    const now = card(window).getByTestId('steps-now');
    await expect(now).toContainText('Ship on Friday?');
    await expect(now).toContainText('Yours to answer');

    // Answer steps in: the question opens with its keys, 1 is Yes, ↓ moves on.
    await now.getByRole('button', { name: /Answer/ }).click();
    await expect(card(window)).toHaveAttribute('data-stepped-in', 'true');
    await expect(card(window).getByTestId('steps-open')).toHaveAttribute('data-step', '1');
    await expect(card(window).getByTestId('steps-send')).toBeDisabled();
    await window.keyboard.press('1');
    await expect(card(window).getByRole('button', { name: /Yes/ })).toHaveAttribute('aria-pressed', 'true');
    // A board key is the card's while it has the keyboard: N makes no note.
    await window.keyboard.press('n');
    await expect(window.locator('.sticky')).toHaveCount(0);
    await window.keyboard.press('ArrowDown');
    await expect(card(window).getByTestId('steps-open')).toHaveAttribute('data-step', '2');
    await card(window).getByRole('button', { name: /SQLite/ }).click();
    await expect(card(window).getByTestId('steps-count')).toHaveText('2/3');

    await expect(card(window).getByTestId('steps-send')).toBeEnabled();
    await card(window).getByTestId('steps-send').click();
    await expect(card(window)).toContainText('Answers sent');

    // esc gives the keys back to the board.
    await card(window).press('Escape');
    await expect(card(window)).not.toHaveAttribute('data-stepped-in', 'true');

    await tile(window).and(window.locator(`[data-session-id="${agent.sessionId}"]`)).dblclick();
    await expect(sessionWindow(window)).toBeVisible();
    await expect(screen(window)).toContainText('[agent-board] The user answered your steps “Release 0.7”');
    await expect(screen(window)).toContainText('SQLite');
  });
});

test('K makes a steps card of the user’s, which takes its steps typed one a line, and ticks them at rest', async () => {
  await withApp(async (window) => {
    await window.locator('.react-flow__pane').click({ position: { x: 600, y: 500 } });
    await window.keyboard.press('k');
    const field = card(window).getByLabel('Steps, one a line');
    await expect(field).toBeFocused();
    await field.fill('# Weekly setup\n- [ ] Pull main\n- [ ] Water the plants');
    await field.press('ControlOrMeta+Enter');

    await expect(card(window)).toContainText('Weekly setup');
    await expect(card(window).getByTestId('steps-count')).toHaveText('0/2');
    // Put down, it is at rest: the step that matters, with its button.
    await window.locator('.react-flow__pane').click({ position: { x: 100, y: 700 } });
    const now = card(window).getByTestId('steps-now');
    await expect(now).toContainText('Pull main');
    await now.getByRole('button', { name: /Done/ }).click();
    await expect(card(window).getByTestId('steps-count')).toHaveText('1/2');
  });
});

test('a words answer keeps what is typed, ⌘↵ in it sends and esc leaves, and undoing a move keeps the answers', async () => {
  await withApp(async (window) => {
    await spawn(window, 'Steps: # Notes ;; ? Anything else we should know?');
    await expect(card(window).getByTestId('steps-count')).toHaveText('0/1');

    // A move to undo later.
    await card(window).getByText('Notes').click();
    await window.keyboard.press('ArrowRight');

    // Selected, its step is open with its field.
    const field = card(window).getByLabel('Anything else we should know?');
    await field.fill('Ship it on Friday');
    await field.press('ControlOrMeta+Enter');
    // Its one step answered, the list is finished.
    await expect(card(window).getByTestId('steps-count')).toHaveText('Done');
    await expect(card(window)).toContainText('Answers sent');
    await field.press('Escape');
    await expect(card(window)).not.toHaveAttribute('data-stepped-in', 'true');

    // Undo puts the card back where it was, and leaves what was answered and sent.
    await window.keyboard.press('ControlOrMeta+z');
    await window.waitForTimeout(500);
    await expect(card(window).getByTestId('steps-count')).toHaveText('Done');
    await expect(card(window)).toContainText('Answers sent');
  });
});
