import { expect, type Page } from '@playwright/test';
import type { Agent } from '@agent-board/daemon/protocol';
import { rmSync } from 'node:fs';
import { launch, screen, sessionWindow, spawnAgent, tile } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// The quick ask on an agent's tile: the fake claude's `Ask several: …` asks up to four questions and waits. The chip
// on its tile opens the ask beside it, never the ask arriving; its answers go back in the agent's waiting call.

const QUESTIONS = 'Ask several: Which store? | Redis | SQLite ;; Keep the old limit? | Yes | No ;; Anything else?';

const chip = (window: Page) => window.getByTestId('ask-chip');
const quickAsk = (window: Page) => window.getByTestId('quick-ask');

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

/** Opens the agent's session window, to read what its waiting call was answered with. */
async function openSession(window: Page, agent: Agent) {
  await tile(window).and(window.locator(`[data-session-id="${agent.sessionId}"]`)).dblclick();
  await expect(sessionWindow(window)).toBeVisible();
}

test('the chip on an asking tile opens its ask, stepped through by key, and Send answers the waiting agent', async () => {
  await withApp(async (window) => {
    const agent = await spawn(window, QUESTIONS);

    // The tile says it asks, with a dot for each question; nothing opens by itself.
    await expect(chip(window)).toBeVisible();
    await expect(chip(window)).toContainText('3 questions');
    await expect(chip(window)).toHaveAttribute('aria-expanded', 'false');
    await window.waitForTimeout(300);
    await expect(quickAsk(window)).toHaveCount(0);

    await chip(window).click();
    await expect(quickAsk(window)).toBeVisible();
    await expect(quickAsk(window)).toContainText('Which store?');
    await expect(quickAsk(window).getByRole('img', { name: 'Question 1 of 3' })).toBeVisible();
    // Beside its tile, never over it: past its right edge, level with its top.
    const frame = (await tile(window).and(window.locator(`[data-session-id="${agent.sessionId}"]`)).boundingBox())!;
    const open = (await window.locator('.quick-ask-popover').boundingBox())!;
    expect(open.x).toBeGreaterThanOrEqual(frame.x + frame.width);
    expect(Math.abs(open.y - frame.y)).toBeLessThan(4);
    // A key picks; the next question opens.
    await window.keyboard.press('2');
    await expect(quickAsk(window)).toContainText('Keep the old limit?');
    // esc closes it, keeping the answer: it opens again where it was left.
    await window.keyboard.press('Escape');
    await expect(quickAsk(window)).toHaveCount(0);
    await chip(window).click();
    await expect(quickAsk(window).getByRole('img', { name: 'Question 2 of 3' })).toBeVisible();
    await window.keyboard.press('1');

    // A question in words: typed, and ↵ answers it.
    const words = quickAsk(window).getByLabel('Anything else?');
    await expect(words).toBeFocused();
    await words.fill('Ship it on Friday');
    await words.press('Enter');

    // The answers, as chips above Send; one clicked goes back to change it.
    await expect(quickAsk(window).getByRole('listitem')).toHaveText(['1. SQLite', '2. Yes', '3. Ship it on Friday']);
    await expect(quickAsk(window).getByTestId('quick-ask-send')).toContainText('Send 3 answers');
    await quickAsk(window).getByRole('listitem').nth(1).click();
    await window.keyboard.press('2');
    await expect(quickAsk(window).getByRole('listitem').nth(1)).toHaveText('2. No');
    await window.keyboard.press('Enter');

    await expect(chip(window)).toHaveCount(0);
    await openSession(window, agent);
    await expect(screen(window)).toContainText('The user answered:');
    await expect(screen(window)).toContainText('SQLite');
    await expect(screen(window)).toContainText('Ship it on Friday');
  });
});

test('two questions in words each start empty, and ↵ on ⋯ opens its menu rather than sending', async () => {
  await withApp(async (window) => {
    await spawn(window, 'Ask several: Anything else? ;; Any risks?');
    await chip(window).click();
    const first = quickAsk(window).getByLabel('Anything else?');
    await expect(first).toBeFocused();
    await first.fill('Ship it on Friday');
    await first.press('Enter');
    // The next question in words opens with its own empty field, focused.
    const second = quickAsk(window).getByLabel('Any risks?');
    await expect(second).toBeFocused();
    await expect(second).toHaveValue('');
    await second.fill('None');
    await second.press('Enter');

    // On the answers, ↵ on ⋯ is ⋯'s: its menu opens, and nothing is sent.
    await expect(quickAsk(window).getByTestId('quick-ask-send')).toContainText('Send 2 answers');
    await quickAsk(window).getByRole('button', { name: 'More' }).focus();
    await window.keyboard.press('Enter');
    await expect(window.getByRole('menuitem', { name: /Put on the board/ })).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(chip(window)).toBeVisible();
  });
});

test('⋯ › Put on the board turns the ask into a steps card, whose Send answers the agent still waiting', async () => {
  await withApp(async (window) => {
    const agent = await spawn(window, QUESTIONS);
    await chip(window).click();
    await window.keyboard.press('1');

    await quickAsk(window).getByRole('button', { name: 'More' }).click();
    await window.getByRole('menuitem', { name: /Put on the board/ }).click();
    const card = window.getByTestId('steps-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('asks 3 questions');
    await expect(card.getByTestId('steps-count')).toHaveText('1/3');
    // The tile no longer opens it: it points at its card.
    await expect(chip(window)).toHaveCount(0);
    await expect(window.getByTestId('tile-ask')).toContainText('Asking you on a steps card');

    await card.getByTestId('steps-now').getByRole('button', { name: /Answer/ }).click();
    await window.keyboard.press('1');
    await card.getByTestId('steps-send').click();
    await expect(card).toContainText('Answers sent');

    await openSession(window, agent);
    await expect(screen(window)).toContainText('The user answered:');
    await expect(screen(window)).toContainText('Redis');
    await expect(screen(window)).not.toContainText('[agent-board] The user answered your steps');
  });
});
