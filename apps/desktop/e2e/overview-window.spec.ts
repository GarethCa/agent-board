import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, spawnAgent } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// The Overview: its own window, opened from Window › Overview (⌘⇧O), with a column for each project on the board and,
// in each, its agents grouped by what they wait on.

const isOverviewWindow = (page: Page) => page.url().includes('overview=');

/** Clicks Window › Overview, as the menu bar does when ⌘⇧O is pressed: a synthetic key event doesn't reach the native menu. */
const clickOverviewItem = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()!
      .items.flatMap((menu) => menu.submenu?.items ?? [])
      .find((each) => each.label.endsWith('Overview'));
    item!.click();
  });

test("Window › Overview opens the Overview, one window, with an agent in its project's column and its category's group", async () => {
  const { dir, repo, env } = scratch('permission');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Tidy the README', { name: 'readme-tidy' });

    const [overview] = await Promise.all([window.context().waitForEvent('page'), clickOverviewItem(app)]);
    await expect(overview).toHaveTitle('Overview');
    const column = overview.getByTestId('overview-column').filter({ has: overview.getByRole('heading', { name: 'monorepo' }) });
    await expect(column).toBeVisible();

    // The agent waits on a permission prompt: it needs the user, so it is in its column's Needs help group.
    const card = overview.getByTestId('overview-card').filter({ hasText: 'readme-tidy' });
    await expect(column.locator(card)).toHaveAttribute('data-category', 'needs-help');
    await expect(column.getByTestId('overview-group').filter({ has: card })).toHaveAttribute('data-category', 'needs-help');
    await expect(column).toContainText('1 on you');

    // Searching narrows it; a filter that leaves nothing says so.
    await overview.getByRole('searchbox', { name: 'Search threads' }).fill('readme');
    await expect(overview.getByTestId('overview-found')).toHaveText('1 of 1');
    await overview.getByRole('group', { name: 'Show' }).getByRole('button', { name: /^Done/ }).click();
    await expect(overview.getByText('Nothing matches.')).toBeVisible();

    // Asked again while open, it comes forward: no second window.
    await clickOverviewItem(app);
    await expect.poll(() => window.context().pages().filter(isOverviewWindow).length).toBe(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
