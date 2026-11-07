import { expect, type Page } from '@playwright/test';
import { launch } from './agent-helpers.ts';
import { removeDataDir, tempDataDir, test } from './launch.ts';

/** The page of every style, its live character recording every dip that starts and ends. */
async function demoPage(window: Page) {
  await window.evaluate(() => {
    location.hash = '#gallery-characters';
    location.reload();
  });
  const demo = window.getByTestId('character-change-demo');
  await expect(demo).toBeVisible();
  await demo.locator('.tile-character').evaluate((span) => {
    const dips: string[] = [];
    (window as unknown as { dips: string[] }).dips = dips;
    new MutationObserver(() => dips.push(span.hasAttribute('data-dip') ? 'on' : 'off')).observe(span, { attributes: true, attributeFilter: ['data-dip'] });
  });
  return demo;
}

const dips = (window: Page) => window.evaluate(() => (window as unknown as { dips: string[] }).dips);
const character = (demo: ReturnType<Page['getByTestId']>) => demo.getByTestId('tile-character');
const pick = (demo: ReturnType<Page['getByTestId']>, pose: string) => demo.getByRole('button', { name: pose, exact: true }).click();

test('a character on a tile holds a change for three seconds, never holds up what wants you, and dips once for each', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, {});
  try {
    const demo = await demoPage(window);
    // Nothing dips as it first shows.
    expect(await dips(window)).toEqual([]);

    // The first change has nothing to wait out.
    await pick(demo, 'running');
    await expect(character(demo)).toHaveAttribute('data-pose', 'running');
    await expect.poll(() => dips(window)).toEqual(['on', 'off']);

    // Held, then shown once its three seconds are up, however long ago it was asked for.
    await window.evaluate(() => void ((window as unknown as { dips: string[] }).dips.length = 0));
    await pick(demo, 'thinking');
    await pick(demo, 'running');
    await pick(demo, 'thinking');
    expect(await character(demo).getAttribute('data-pose')).toBe('running');
    await expect(character(demo)).toHaveAttribute('data-pose', 'thinking', { timeout: 5000 });
    await expect.poll(() => dips(window)).toEqual(['on', 'off']);

    // What wants the user is shown at once, straight after that change.
    await pick(demo, 'waiting');
    await expect(character(demo)).toHaveAttribute('data-pose', 'waiting', { timeout: 500 });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a character never dips under Still, with reduced motion or below half zoom, and leaves no dip behind when it goes', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, {});
  try {
    const demo = await demoPage(window);
    const change = async (pose: string) => {
      await pick(demo, pose);
      await expect(character(demo)).toHaveAttribute('data-pose', pose, { timeout: 500 });
    };

    await window.evaluate(() => localStorage.setItem('agent-board.character-motion', 'still'));
    await change('waiting');
    await window.evaluate(() => localStorage.removeItem('agent-board.character-motion'));

    await window.emulateMedia({ reducedMotion: 'reduce' });
    await change('thinking');
    await window.emulateMedia({ reducedMotion: 'no-preference' });

    await demo.evaluate((element) => void (element.style.transform = 'scale(0.4)'));
    await change('waiting');
    await demo.evaluate((element) => void (element.style.transform = ''));
    expect(await dips(window)).toEqual([]);

    // A character that goes mid-dip gives its place back: more than the four that may dip at once go this way, and the
    // next still dips. Changes to and from what wants the user aren't held.
    const toggle = demo.getByRole('button', { name: 'toggle' });
    for (const pose of ['thinking', 'waiting', 'thinking', 'waiting', 'thinking', 'waiting']) {
      await change(pose);
      await toggle.click();
      await expect(character(demo)).toHaveCount(0);
      await toggle.click();
    }
    await change('thinking');
    await expect(demo.locator('.tile-character')).toHaveAttribute('data-dip', '');
    await expect(demo.locator('.tile-character')).not.toHaveAttribute('data-dip', '');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
