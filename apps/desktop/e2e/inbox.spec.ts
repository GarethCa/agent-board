import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { Agent } from '@agent-board/daemon/protocol';
import { rmSync } from 'node:fs';
import { launch, screen, spawnAgent, tile } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch, type Scratch } from './scratch.ts';

const item = (window: Page, sessionId: string) => window.locator(`[data-testid="inbox-item"][data-session-id="${sessionId}"]`);
/** The Needs-you pill: how many agents wait, in `data-count`. */
const count = (window: Page) => window.getByTestId('inbox-count');

/**
 * Opens the inbox from the Needs-you pill if it is closed: it closes when the focus leaves it, as for a terminal.
 * Dispatched, not clicked: a session window's scrim may cover the pill.
 */
async function openInbox(window: Page): Promise<void> {
  if (!(await window.getByTestId('needs-you-inbox').isVisible())) await count(window).dispatchEvent('click');
  await expect(window.getByTestId('needs-you-inbox')).toBeVisible();
}

/** Opens the agent's session window from its tile. Dispatched, not clicked: on a small window the inbox may cover it. */
const openFromTile = (window: Page, agent: Agent) =>
  tile(window).and(window.locator(`[data-session-id="${agent.sessionId}"]`)).dispatchEvent('dblclick');

/** Starts an agent in the repo's zone and returns it. */
async function spawn(page: Page, prompt: string): Promise<Agent> {
  const before = await page.evaluate(() => window.agentBoard.agents.list());
  await spawnAgent(page, 'monorepo', prompt);
  const after = await page.evaluate(() => window.agentBoard.agents.list());
  return after.find((agent) => !before.some((known) => known.sessionId === agent.sessionId))!;
}

/** Runs `body` with the app open on a fresh repo zone, its agents running the fake claude with `scratch`'s scenario. */
async function withApp(
  setup: Scratch,
  body: (window: Page, app: ElectronApplication) => Promise<void>,
  env: Record<string, string> = {},
): Promise<void> {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...setup.env, ...env });
  try {
    await pickFolderNext(app, setup.repo);
    await browseForZone(window);
    await body(window, app);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(setup.dir, { recursive: true, force: true });
  }
}

test('answering a waiting agent from the inbox delivers the text and it resumes; answered in its terminal instead, it leaves the inbox too', async () => {
  await withApp(scratch('waiting'), async (window) => {
    await expect(count(window)).toHaveAttribute('data-count', '0');
    const agent = await spawn(window, 'Pick a database');

    const waiting = item(window, agent.sessionId);
    await expect(count(window)).toHaveAttribute('data-count', '1');
    await openInbox(window);
    await expect(waiting).toBeVisible();
    await expect(waiting.getByTestId('inbox-last-message')).toHaveText('Which database should I use, Postgres or SQLite?');
    await waiting.getByLabel('Answer').fill('SQLite');
    await waiting.getByRole('button', { name: 'Send' }).click();

    // It resumed, and once it waits again the item is back with its new last message.
    await expect(waiting.getByTestId('inbox-last-message')).toHaveText('Going with SQLite.');
    await openFromTile(window, agent);
    await expect(screen(window)).toContainText('Going with SQLite.');

    // Answered in its terminal, not the inbox: the item goes all the same.
    await window.getByTestId('session-terminal').click();
    await window.keyboard.type('Ship it');
    await window.keyboard.press('Enter');
    await expect(count(window)).toHaveAttribute('data-count', '0');
    await expect(screen(window)).toContainText('Done: Ship it.');
    // ...until it waits once more.
    await openInbox(window);
    await expect(waiting.getByTestId('inbox-last-message')).toHaveText('Done: Ship it.');
  });
});

test("approving and denying a permission from the inbox answer the agent's PermissionRequest", async () => {
  await withApp(scratch('permission'), async (window) => {
    const allowed = await spawn(window, 'Clean up');
    const asking = item(window, allowed.sessionId);
    await openInbox(window);
    await expect(asking).toContainText('Wants to use Bash');
    await expect(asking.getByTestId('inbox-tool-input')).toHaveText('rm -rf dist');
    await asking.getByRole('button', { name: 'Allow' }).click();
    // The inbox answered it: it ran, and its terminal never asked.
    await expect(asking).not.toContainText('Wants to use Bash');
    await openFromTile(window, allowed);
    await expect(screen(window)).toContainText('Removed dist.');
    await expect(screen(window)).not.toContainText('(y/n)');
    await window.getByRole('button', { name: 'Close session window' }).click();

    const denied = await spawn(window, 'Clean up again');
    const second = item(window, denied.sessionId);
    await openInbox(window);
    await expect(second).toContainText('Wants to use Bash');
    await second.getByRole('button', { name: 'Deny' }).click();
    await expect(second).not.toContainText('Wants to use Bash');
    await openFromTile(window, denied);
    await expect(screen(window)).toContainText('Okay, I left dist alone.');
    await expect(screen(window)).not.toContainText('(y/n)');
  });
});

test('a permission the inbox held too long falls back to the terminal, and answering it there clears the item', async () => {
  await withApp(
    scratch('permission'),
    async (window) => {
      const agent = await spawn(window, 'Clean up');
      const asking = item(window, agent.sessionId);
      await openInbox(window);
      await expect(asking).toContainText('Asking in its terminal now');
      await expect(asking.getByRole('button', { name: 'Allow' })).toHaveCount(0);

      await asking.getByRole('button', { name: 'Open' }).click();
      await expect(screen(window)).toContainText('(y/n)');
      await window.getByTestId('session-terminal').click();
      await window.keyboard.type('y');
      await window.keyboard.press('Enter');
      await expect(screen(window)).toContainText('Removed dist.');
      await expect(count(window)).toHaveAttribute('data-count', '0');
    },
    { AGENT_BOARD_PERMISSION_HOLD_MS: '500' },
  );
});

test("two subagents asking at once each get a row in the inbox, answered on their own, and the agent's terminal says why it waits", async () => {
  await withApp(scratch('subagent-permission'), async (window) => {
    const agent = await spawn(window, 'Clean up');
    const asking = item(window, agent.sessionId);
    const prompts = asking.getByTestId('inbox-prompt');
    await openInbox(window);
    await expect(prompts).toHaveCount(2);
    await expect(prompts.first()).toContainText('Its general-purpose subagent wants to use Bash');

    // Its terminal shows no prompt while the inbox holds them, and says so.
    await asking.getByRole('button', { name: 'Open' }).click();
    await expect(window.getByTestId('held-prompts-notice')).toContainText('held for an answer in the Needs you inbox');
    await window.getByRole('button', { name: 'Close session window' }).click();

    await openInbox(window);
    await prompts.filter({ hasText: 'rm -rf build' }).getByRole('button', { name: 'Deny' }).click();
    await expect(prompts).toHaveCount(1);
    await expect(prompts).toContainText('rm -rf dist');
    await expect(asking).toHaveAttribute('data-state', 'needs-permission');
    await prompts.getByRole('button', { name: 'Allow' }).click();
    await expect(prompts).toHaveCount(0);

    await openFromTile(window, agent);
    await expect(screen(window)).toContainText('Both workers are done.');
    await expect(screen(window)).toContainText('Removed dist.');
    await expect(screen(window)).toContainText('Left build alone.');
    await expect(screen(window)).not.toContainText('(y/n)');
    await expect(window.getByTestId('held-prompts-notice')).toHaveCount(0);
  });
});
