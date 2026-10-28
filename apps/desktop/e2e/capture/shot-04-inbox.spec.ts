import { expect } from '@playwright/test';
import { promoReady, promoTile } from '../demo-board.ts';
import { test } from '../launch.ts';
import { fitZone, onPromoBoard, recordShot, stillView } from './shots.ts';

// Shot 4 (14–20 s): the pointer clicks the "3 need you" chip, the inbox opens, and `rm -rf dist` is allowed: the
// implementer's orange border clears.
test.use({ viewport: null });

test('shot 4: the inbox, and a permission allowed from it', async () => {
  test.setTimeout(300_000);
  await onPromoBoard({}, async ({ app, page, board }) => {
    await promoReady(page, board);
    await fitZone(page, board.zones.storefront.id, 0);
    await stillView(page);
    const implementer = promoTile(page, 'implementer');
    await recordShot(app, page, 'shot-04-inbox', async (log) => {
      await log.hold(600);
      await log.click('open-inbox', page.getByTestId('inbox-count'));
      const inbox = page.getByTestId('needs-you-inbox');
      await expect(inbox).toBeVisible();
      await log.hold(900);
      const prompt = inbox.getByTestId('inbox-prompt').filter({ hasText: 'rm -rf dist' });
      await log.click('allow', prompt.getByRole('button', { name: 'Allow' }), { ms: 900 });
      await expect(implementer).not.toHaveAttribute('data-needs-you', 'true');
      await expect(page.getByTestId('inbox-count')).toContainText('2 need you');
      await log.hold(700);
      await page.keyboard.press('Escape');
      log.mark('cleared');
      await log.hold(1_500);
    });
  });
});
