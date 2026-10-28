import { expect } from '@playwright/test';
import { promoReady, promoTile, spawnPromoAgent } from '../demo-board.ts';
import { test } from '../launch.ts';
import { fitZone, onPromoBoard, recordShot, stillView } from './shots.ts';

// Shot 3 (9–14 s): on the billing zone, an agent starts and its subagents pop in on its top edge and run. The cue log
// punches in on its tile.
test.use({ viewport: null });

test('shot 3: subagents pop in on a tile and run', async () => {
  test.setTimeout(300_000);
  await onPromoBoard({ later: ['webhooks'] }, async ({ app, page, board }) => {
    await promoReady(page, board);
    await fitZone(page, board.zones['billing-api'].id, 0);
    await stillView(page);
    await recordShot(app, page, 'shot-03-robots', async (log) => {
      await log.hold(600);
      // The edit holds the whole frame until the agent starts, then eases in on its tile as its subagents arrive.
      await log.punch('spawn', 'out');
      await spawnPromoAgent(page, board, 'webhooks');
      const webhooks = promoTile(page, 'webhooks');
      await expect(webhooks).toBeVisible();
      await log.punch('tile', webhooks, 60);
      await expect(webhooks.getByTestId('character')).toHaveCount(3, { timeout: 30_000 });
      log.mark('robots');
      await log.hold(3_000);
    });
  });
});
