import { expect } from '@playwright/test';
import { screen, sessionWindow } from '../agent-helpers.ts';
import { promoTile, spawnPromoAgent } from '../demo-board.ts';
import { test } from '../launch.ts';
import { fitZone, onPromoBoard, recordShot, stillView } from './shots.ts';

// Shot 1 (0–4 s): the raw material for the hook's wall of terminals: one agent's session window, its TUI streaming as
// it thinks, plans its todos, sends an explorer off, edits and runs the tests. The edit tiles and offsets copies of it.
test.use({ viewport: null });

test('shot 1: an agent’s terminal, streaming', async () => {
  test.setTimeout(300_000);
  // The implementer starts once the board is seeded, its window open, so its whole turn plays on camera.
  await onPromoBoard({ later: ['implementer'], pace: { subagentWorkMs: 2_500 } }, async ({ app, page, board }) => {
    await fitZone(page, board.zones.storefront.id, 0);
    await stillView(page);
    await spawnPromoAgent(page, board, 'implementer');
    const implementer = promoTile(page, 'implementer');
    await implementer.dblclick();
    await expect(sessionWindow(page)).toBeVisible();
    await recordShot(app, page, 'shot-01-hook', async (log) => {
      // Rolling before the agent has got far: footage of a finished turn, stopped on its permission, is no hook.
      await expect(screen(page)).not.toContainText('npm test');
      await expect(implementer).not.toHaveAttribute('data-needs-you', 'true');
      await expect(screen(page)).toContainText('Update Todos', { timeout: 30_000 });
      log.mark('start');
      await expect(screen(page)).toContainText('Explore(', { timeout: 30_000 });
      log.mark('explorer');
      await expect(screen(page)).toContainText('npm test', { timeout: 30_000 });
      log.mark('tests');
      // Out before the permission it asks next brings its banner.
      await log.hold(500);
      log.mark('end');
    });
  });
});
