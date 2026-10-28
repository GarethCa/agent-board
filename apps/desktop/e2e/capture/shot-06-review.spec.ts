import { expect } from '@playwright/test';
import { screen, sessionWindow } from '../agent-helpers.ts';
import { promoReady, promoTile } from '../demo-board.ts';
import { test } from '../launch.ts';
import { fitZone, onPromoBoard, recordShot, stillView } from './shots.ts';

// Shot 6 (27–33 s): the implementer's session window opens on a double-click; round 1's findings go to it and its TUI
// types the fix as a diff; round 2 approves, and its review doc shows the verdict.
test.use({ viewport: null });

test('shot 6: the session window types a fix, and review round 2 approves', async () => {
  test.setTimeout(360_000);
  await onPromoBoard({}, async ({ app, page, board }) => {
    await promoReady(page, board);
    await fitZone(page, board.zones.storefront.id, 0);
    await stillView(page);
    const implementer = promoTile(page, 'implementer');
    const id = board.agents.implementer!.sessionId;
    // Off camera: the permission allowed, the turn done, and round 1 of review in, asking for changes.
    await page.getByTestId('inbox-count').click();
    await page.getByTestId('inbox-prompt').filter({ hasText: 'rm -rf dist' }).getByRole('button', { name: 'Allow' }).click();
    await page.keyboard.press('Escape');
    await expect(implementer).toHaveAttribute('data-state', 'waiting', { timeout: 90_000 });
    const round = (number: number) => page.evaluate(async ([id, number]) => (await window.agentBoard.reviews.list()).find((each) => each.implementer === id && each.round === number), [id, number] as const);
    const first = await page.evaluate((id) => window.agentBoard.reviews.start(id), id);
    await expect.poll(async () => (await round(1))?.status, { timeout: 90_000 }).toBe('ready');

    await recordShot(app, page, 'shot-06-review', async (log) => {
      await log.hold(500);
      await log.click('open', implementer, { double: true });
      const win = sessionWindow(page);
      await expect(win).toBeVisible();
      await log.hold(600);
      log.mark('findings-sent');
      await page.evaluate((round) => window.agentBoard.reviews.send(round), first.id);
      await expect(screen(page)).toContainText('expiresAt', { timeout: 30_000 });
      log.mark('diff');
      await expect(screen(page)).toContainText('Pushed to #12', { timeout: 60_000 });
      log.mark('pushed');
      await log.hold(800);
      await page.evaluate((id) => window.agentBoard.reviews.start(id), id);
      await expect.poll(async () => (await round(2))?.status, { timeout: 90_000 }).toBe('ready');
      await log.click('review-tab', win.getByRole('tab', { name: /^Review/ }));
      await expect(win.getByTestId('review-verdict')).toContainText('Approve');
      log.mark('approved');
      // Long enough for the beat's caption to spring in, be read, and fade.
      await log.hold(4_000);
    });
  });
});
