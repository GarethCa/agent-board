import { expect } from '@playwright/test';
import { promoReady, promoTile } from '../demo-board.ts';
import { test } from '../launch.ts';
import { camera, fitZone, onPromoBoard, recordShot, stillView, tileArea } from './shots.ts';

// Shot 5 (20–27 s): the implementer's turn ends and its handover.md travels along the flow edge to the reviewer, the
// camera flying with it, and the reviewer starts work.
test.use({ viewport: null });

test('shot 5: a handover travels along a flow edge, and the reviewer starts', async () => {
  test.setTimeout(300_000);
  await onPromoBoard({}, async ({ app, page, board }) => {
    await promoReady(page, board);
    await fitZone(page, board.zones.storefront.id, 0);
    await stillView(page);
    const reviewer = promoTile(page, 'reviewer');
    // Off camera: the permission the implementer waits on, allowed, so it carries on to its hand-off.
    await page.getByTestId('inbox-count').click();
    await page.getByTestId('inbox-prompt').filter({ hasText: 'rm -rf dist' }).getByRole('button', { name: 'Allow' }).click();
    await page.keyboard.press('Escape');
    const around = { x: 120, y: 110, width: 700, height: 350 };
    const [from, to] = [await tileArea(page, board, 'implementer', around), await tileArea(page, board, 'reviewer', around)];
    await camera(page, from, 1_200);
    const token = page.getByTestId('rail-token').filter({ hasText: 'handover.md' });
    await recordShot(app, page, 'shot-05-handoff', async (log) => {
      await expect(token).toHaveAttribute('data-sliding', 'true', { timeout: 90_000 });
      log.mark('start');
      log.mark('handoff');
      await camera(page, to, 1_600);
      await expect(reviewer).toHaveAttribute('data-state', /running|thinking/, { timeout: 30_000 });
      log.mark('reviewer-starts');
      await log.hold(2_500);
    });
  });
});
