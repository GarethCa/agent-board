import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, sessionWindow, spawnAgent, tile, TURN_MS } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// An agent's inspector under the Simplified design: hidden until shown, at the window's trailing edge, a short grouped
// list resized on the handle before it, with its technical details only while Show technical details is on.

const inspector = (window: Page) => sessionWindow(window).getByTestId('inspector');
const handle = (window: Page) => sessionWindow(window).getByTestId('details-handle');
const toggle = (window: Page) => sessionWindow(window).locator('.session-window-head').getByRole('button', { name: /^(Show|Hide) details$/ });
const fold = (window: Page) => inspector(window).getByRole('region', { name: 'More details' });
const width = async (window: Page) => Math.round((await inspector(window).boundingBox())!.width);

/** Turns Show technical details on or off, as its Settings switch does. */
const setTechnical = (page: Page, on: boolean) => page.evaluate((value) => window.agentBoard.technical.set(value), on);

/** How many pins the board's one agent has recorded. */
const pinCount = (page: Page) => page.evaluate(() => window.agentBoard.agents.list().then(([agent]) => agent?.records.filter((record) => record.kind === 'pin').length));

async function dragHandle(window: Page, dx: number): Promise<void> {
  const box = (await handle(window).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await window.mouse.move(x, y);
  await window.mouse.down();
  await window.mouse.move(x + dx / 2, y, { steps: 4 });
  await window.mouse.move(x + dx, y, { steps: 4 });
  await window.mouse.up();
}

test("an agent's inspector opens from the header at the window's trailing edge, resizes on its handle, hides below its minimum and is remembered", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env, [], { design: 'simplified' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await tile(window).dblclick();

    // Hidden at first: no inspector, no handle, and none of Classic's details strip or rail.
    await expect(toggle(window)).toHaveAttribute('aria-pressed', 'false');
    await expect(inspector(window)).toHaveCount(0);
    await expect(handle(window)).toHaveCount(0);
    await expect(sessionWindow(window).locator('.session-details')).toHaveCount(0);

    // Shown from the header, at the trailing edge: its status, who started it, and the Work group.
    await toggle(window).click();
    await expect(toggle(window)).toHaveAttribute('aria-pressed', 'true');
    await expect(inspector(window)).toBeVisible();
    const body = (await sessionWindow(window).locator('.session-window-body').boundingBox())!;
    const box = (await inspector(window).boundingBox())!;
    expect(Math.round(box.x + box.width)).toBe(Math.round(body.x + body.width));
    await expect(inspector(window).getByTestId('inspector-status-line')).toContainText('started by you');
    await expect(inspector(window).getByRole('region', { name: 'Work' })).toContainText('Pull request');
    // Its technical details wait for the switch, and its fold for something to hold.
    await expect(inspector(window).getByRole('region', { name: 'Technical details' })).toHaveCount(0);
    await expect(inspector(window).getByRole('region', { name: 'More details' })).toHaveCount(0);
    await expect.poll(() => width(window)).toBe(316);

    // Dragged left it widens, and the left arrow widens it too: it is the leading edge.
    await dragHandle(window, -80);
    await expect.poll(() => width(window)).toBe(396);
    await handle(window).focus();
    await window.keyboard.press('ArrowLeft');
    await expect.poll(() => width(window)).toBe(412);
    await window.keyboard.press('ArrowRight');
    await expect.poll(() => width(window)).toBe(396);
    // Double-click goes back to the default width.
    await handle(window).dblclick();
    await expect.poll(() => width(window)).toBe(316);

    // Pulled below its minimum it hides; ⌘I shows it again at its width.
    await dragHandle(window, 2000);
    await expect(inspector(window)).toHaveCount(0);
    await expect(toggle(window)).toHaveAttribute('aria-pressed', 'false');
    await window.keyboard.press('ControlOrMeta+i');
    await expect(inspector(window)).toBeVisible();
    await expect.poll(() => width(window)).toBe(316);

    // Stepped below its minimum from the keyboard it hides too, and the focus goes to the header's toggle.
    await dragHandle(window, 116);
    await expect.poll(() => width(window)).toBe(200);
    await handle(window).focus();
    await window.keyboard.press('ArrowRight');
    await expect(inspector(window)).toHaveCount(0);
    await expect(toggle(window)).toBeFocused();
    await window.keyboard.press('Enter');
    await expect(inspector(window)).toBeVisible();
    await handle(window).dblclick();
    await expect.poll(() => width(window)).toBe(316);

    // Shown when the window closes, it is shown when the next one opens.
    await sessionWindow(window).getByRole('button', { name: /^Done, close / }).click();
    await expect(sessionWindow(window)).toHaveCount(0);
    await tile(window).dblclick();
    await expect(inspector(window)).toBeVisible();

    // Show technical details adds its branch, folder and AI, and nothing moves above them.
    // Once its turn has ended, so its status line holds still.
    await expect(inspector(window).getByTestId('inspector-status-line')).toContainText('Asks you', { timeout: TURN_MS });
    // Measured from the inspector's top once two reads agree: while the window eases in, its scale shrinks the offset too.
    const workTop = async () => {
      const read = async () => (await inspector(window).getByRole('region', { name: 'Work' }).boundingBox())!.y - (await inspector(window).boundingBox())!.y;
      let last = await read();
      await expect.poll(async () => {
        const now = await read();
        const still = Math.abs(now - last) < 0.01;
        last = now;
        return still;
      }).toBe(true);
      return last;
    };
    const work = await workTop();
    await setTechnical(window, true);
    const technical = inspector(window).getByRole('region', { name: 'Technical details' });
    await expect(technical).toBeVisible();
    await expect(technical).toContainText('Claude · default model');
    expect(Math.round(await workTop())).toBe(Math.round(work));

    // Its folder row copies the folder's path.
    const folderRow = technical.getByTestId('inspector-folder-row').getByRole('button');
    const path = (await folderRow.getAttribute('title'))!.replace(/: copy its path$/, '');
    await folderRow.click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(path);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent's inspector folds what it showed and pinned under More details, opens and keeps the fold open, and each row opens where it belongs", async () => {
  const { dir, repo, env } = scratch('ask-plan');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env, [], { design: 'simplified' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pins: notes/report.md');
    await expect.poll(() => pinCount(window), { timeout: TURN_MS }).toBe(4);
    await tile(window).dblclick();
    await toggle(window).click();

    // Closed, it names what it holds.
    await expect(fold(window).getByRole('button', { name: /^More details/ })).toHaveAttribute('aria-expanded', 'false');
    await expect(fold(window)).toContainText('More details: 1 document, 4 pins');
    await expect(fold(window).getByTestId('inspector-pin')).toHaveCount(0);

    // Opened, it lists them; and it is still open in the next window.
    await fold(window).getByRole('button', { name: /^More details/ }).click();
    await expect(fold(window).getByTestId('inspector-document')).toContainText('Release 1.4 plan');
    const pins = fold(window).getByTestId('inspector-pin');
    await expect(pins).toHaveCount(4);
    await sessionWindow(window).getByRole('button', { name: /^Done, close / }).click();
    await expect(sessionWindow(window)).toHaveCount(0);
    await tile(window).dblclick();
    await expect(fold(window).getByRole('button', { name: /^More details/ })).toHaveAttribute('aria-expanded', 'true');

    // A pinned Markdown file opens in a Doc tab, a link in a web tab, and the document in its Document tab.
    await pins.nth(0).getByRole('button').click();
    await expect(sessionWindow(window).getByTestId('doc-view').getByTestId('doc-body')).toContainText('Merge the flake fix first');
    await pins.nth(2).getByRole('button').click();
    await expect(sessionWindow(window).getByRole('tab', { name: 'localhost:9' })).toBeVisible();
    await fold(window).getByTestId('inspector-document').getByRole('button').click();
    await expect(sessionWindow(window).getByTestId('document-view')).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
