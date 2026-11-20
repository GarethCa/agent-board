import { expect, type Page } from '@playwright/test';
import { launch, listFinishedTurns, tile } from './agent-helpers.ts';
import { busySpineZone, cleanUpFromMenu, items, layout } from './clean-up-helpers.ts';
import { untilStill } from './board-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

const named = (page: Page, name: string) => tile(page).filter({ has: page.getByText(name, { exact: true }) });

test("Clean up gathers a Spine zone's notes to their bands and its finished ticket to the Done line, leaves the user's own things be, and Undo or ⌘Z puts all of it back", async () => {
  const { repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, env);
  try {
    await listFinishedTurns(page);
    await pickFolderNext(app, repo);
    await browseForZone(page);
    const { resize, note, sticky } = await busySpineZone(page);
    const before = await layout(page);
    expect(before.doneLines).toBe(0);

    const cleanUp = async () => {
      await cleanUpFromMenu(page);
      const after = await layout(page);
      const band = after.agents['Resize images']!;
      // The note stands at the tail of its agent's band, level with its tile; the finished ticket is a chip on the Done line.
      expect(after.items[note.id]!.y).toBe(band.y);
      expect(after.items[note.id]!.x).toBeGreaterThan(band.x);
      expect((await items(page)).find((item) => item.id === note.id)!.data).toMatchObject({ gatheredTo: `agent:${resize}` });
      expect(after.doneLines).toBe(1);
      await expect(page.getByTestId('done-chip')).toHaveCount(1);
      await expect(named(page, 'Pick a cache')).toHaveCount(0);
      // The sticky and the dragged tile keep their exact places.
      expect(after.items[sticky.id]).toEqual(before.items[sticky.id]);
      expect(after.agents['Write docs']).toEqual(before.agents['Write docs']);
    };
    const putBack = async () => {
      await untilStill(async () => JSON.stringify(await layout(page)));
      expect(await layout(page)).toEqual(before);
      await expect(page.getByTestId('done-chip')).toHaveCount(0);
      await expect(named(page, 'Pick a cache')).toHaveCount(1);
    };

    // Undo on the toast puts every place back, and the Done line goes.
    await cleanUp();
    await page.getByLabel('Notifications').getByRole('button', { name: /^Undo/ }).click();
    await putBack();
    // And so does ⌘Z.
    await cleanUp();
    await page.keyboard.press('ControlOrMeta+z');
    await putBack();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
