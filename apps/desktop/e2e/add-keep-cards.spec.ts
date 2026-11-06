import { expect } from '@playwright/test';
import { launch, SHELL_ENV } from './agent-helpers.ts';
import { test, tempDataDir, removeDataDir } from './launch.ts';

// Steps, a memory and a queue can be added three ways, under both designs: the Create toolbar's menu (Classic's
// "More to add", the Simplified design's Draw), their keys K, M and Q, and the board's right-click menu. One test for
// each design, card and way, so a failure names what broke.

const CARDS = [
  { name: 'Steps', key: 'k', testId: 'steps-card', context: 'New steps' },
  { name: 'Memory', key: 'm', testId: 'memory-card', context: 'Add a memory' },
  { name: 'Queue', key: 'q', testId: 'queue-card', context: 'Add a queue' },
] as const;
const WAYS = ['the toolbar menu', 'its key', 'the right-click menu'] as const;

for (const design of ['classic', 'simplified'] as const) {
  for (const { name, key, testId, context } of CARDS) {
    for (const way of WAYS) {
      test(`${design}: ${name} is added from ${way}`, async () => {
        const dataDir = tempDataDir();
        const { app, window } = await launch(dataDir, SHELL_ENV, [], { design });
        try {
          const pane = window.locator('.react-flow__pane');
          const box = (await pane.boundingBox())!;
          if (way === 'the toolbar menu') {
            await window.getByRole('toolbar', { name: 'Create' }).getByRole('button', { name: design === 'simplified' ? 'Draw' : 'More to add' }).click();
            const row = window.getByRole('menuitem', { name });
            // Icon-led, with its key beside it.
            await expect(row.locator('svg').first()).toBeVisible();
            await expect(row).toContainText(key.toUpperCase());
            await row.click();
          } else if (way === 'its key') {
            await window.mouse.click(box.x + box.width - 20, box.y + box.height / 2);
            await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await window.keyboard.press(key);
          } else {
            await pane.click({ button: 'right', position: { x: 60, y: Math.floor(box.height * 0.75) } });
            await window.getByRole('menuitem', { name: context }).click();
          }
          await expect(window.getByTestId(testId)).toHaveCount(1);
        } finally {
          await app.close();
          await removeDataDir(dataDir);
        }
      });
    }
  }
}
