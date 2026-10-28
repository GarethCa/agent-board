import { expect } from '@playwright/test';
import { promoReady, stillBoard } from '../demo-board.ts';
import { test } from '../launch.ts';
import { fitZone, onPromoBoard, recordShot } from './shots.ts';

// Shot 2 (4–9 s): a hard cut to the whole board in the Workbench light theme, two zones and six tiles at work, and a
// slow camera dolly in on the storefront's three.
test.use({ viewport: null });

test('shot 2: the board, framed whole, then a slow dolly in', async () => {
  test.setTimeout(300_000);
  await onPromoBoard({}, async ({ app, page, board }) => {
    await promoReady(page, board);
    await page.getByRole('button', { name: 'Fit View' }).click();
    await stillBoard(page);
    await recordShot(app, page, 'shot-02-board', async (log) => {
      await log.hold(1_200);
      log.mark('dolly');
      await fitZone(page, board.zones.storefront.id, 4_000);
      log.mark('dolly-end');
      await log.hold(800);
    });
    await expect(page.getByTestId('inbox-count')).toContainText('3 need you');
  });
});
