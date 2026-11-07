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

// Classic's toolbar with Shell's word and More to add is no wider than it was before More to add (512.1 px; 513.2 px
// with the button on its own), at a wide window and at a narrow one, with the chevron joined to Zone.
test('classic: the toolbar keeps Shell\u2019s word and is no wider than before, with More to add joined to Zone', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV, [], { design: 'classic' });
  try {
    const toolbar = window.getByRole('toolbar', { name: 'Create' });
    await expect(toolbar.getByRole('button', { name: 'New shell' })).toHaveText('Shell');
    for (const width of [1440, 960]) {
      await window.setViewportSize({ width, height: 800 });
      await expect.poll(async () => (await toolbar.boundingBox())!.width).toBeLessThanOrEqual(513.2);
    }
    // Below 960 px both words go, so the toolbar clears the Needs-you island, as it did before.
    await window.setViewportSize({ width: 900, height: 800 });
    await expect.poll(async () => (await toolbar.boundingBox())!.width).toBeLessThanOrEqual(445);
    await window.setViewportSize({ width: 1440, height: 800 });
    const zone = (await toolbar.getByRole('button', { name: 'Zone' }).boundingBox())!;
    const more = (await toolbar.getByRole('button', { name: 'More to add' }).boundingBox())!;
    expect(more.x - (zone.x + zone.width)).toBeLessThanOrEqual(1);
    expect(more.width).toBeGreaterThanOrEqual(16);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
