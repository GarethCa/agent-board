import { expect } from '@playwright/test';
import { promoReady, promoTile, seedCrowd } from '../demo-board.ts';
import { test } from '../launch.ts';
import { camera, onPromoBoard, recordShot, stillView, tileArea } from './shots.ts';

// Shot 7 (33–38 s): from one tile, the camera pulls back over a crowded board, five zones and eighteen agents, to show
// it scales.
test.use({ viewport: null });

test('shot 7: a pull back over a crowded board', async () => {
  test.setTimeout(300_000);
  await onPromoBoard({}, async ({ app, page, board, dir }) => {
    await seedCrowd(page, dir);
    await promoReady(page, board);
    // Every crowd agent's one short turn over, so none is still starting.
    await expect
      .poll(async () => (await page.evaluate(() => window.agentBoard.agents.list())).filter((agent) => agent.state === 'starting').length, { timeout: 60_000 })
      .toBe(0);
    await camera(page, await tileArea(page, board, 'implementer', { x: 20, y: 20, width: 440, height: 240 }), 0);
    await stillView(page);
    await expect(promoTile(page, 'implementer')).toBeVisible();
    await recordShot(app, page, 'shot-07-scale', async (log) => {
      await log.hold(800);
      log.mark('pull-back');
      // Taller than the board, so it all sits above the band at the bottom where the caption goes.
      await camera(page, { x: -100, y: -150, width: 2700, height: 1700 }, 4_000);
      log.mark('wide');
      await log.hold(1_200);
    });
  });
});
