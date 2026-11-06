import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, sessionWindow, spawnAgent, tile, TURN_MS } from './agent-helpers.ts';
import { browseForZone, classicOnly, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings, settingsSection } from './settings-helpers.ts';

// An agent's sidebar, its shelves: under the Simplified design hidden until shown, at the window's leading edge, opening
// on the agent's page (the board's Now until it writes one) with Made, Crew and Setup a tab away, resized on the handle
// after it, with its technical details only while Show technical details is on; under Classic, in place of the details
// strip while the Agent sidebar setting is Simple.

const inspector = (window: Page) => sessionWindow(window).getByTestId('agent-shelves');
const tabs = (window: Page) => inspector(window).getByRole('tablist', { name: 'Shelves' });
const handle = (window: Page) => sessionWindow(window).getByTestId('details-handle');
const toggle = (window: Page) => sessionWindow(window).locator('.session-window-head').getByRole('button', { name: /^(Show|Hide) details$/ });
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

test("an agent's inspector opens from the header at the window's leading edge, resizes on its handle, hides below its minimum and is remembered", async () => {
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

    // Shown from the header, at the leading edge, open on the board's Now: who started it, and what the page is for.
    await toggle(window).click();
    await expect(toggle(window)).toHaveAttribute('aria-pressed', 'true');
    await expect(inspector(window)).toBeVisible();
    const offset = async () => (await inspector(window).boundingBox())!.x - (await sessionWindow(window).locator('.session-window-body').boundingBox())!.x;
    await expect.poll(async () => Math.abs(await offset()) < 0.5).toBe(true);
    // Its status line says who started it and, once its turn has ended, what the header's status word leaves out.
    await expect(inspector(window).getByTestId('inspector-status-line')).toContainText('started by you');
    await expect(inspector(window).getByTestId('inspector-status-line')).toContainText('Asks you', { timeout: TURN_MS });
    await expect(inspector(window).getByTestId('page-invite')).toBeVisible();
    // It has made nothing and started no one, and its Setup waits for the technical switch: with the page the one
    // shelf, there is no tab row.
    await expect(tabs(window)).toHaveCount(0);
    await expect.poll(() => width(window)).toBe(316);

    // Dragged right it widens, and the right arrow widens it too: the handle is on its trailing edge.
    await dragHandle(window, 80);
    await expect.poll(() => width(window)).toBe(396);
    await handle(window).focus();
    await window.keyboard.press('ArrowRight');
    await expect.poll(() => width(window)).toBe(412);
    await window.keyboard.press('ArrowLeft');
    await expect.poll(() => width(window)).toBe(396);
    // Double-click goes back to the default width.
    await handle(window).dblclick();
    await expect.poll(() => width(window)).toBe(316);

    // Pulled below its minimum it hides; ⌘I shows it again at its width.
    await dragHandle(window, -2000);
    await expect(inspector(window)).toHaveCount(0);
    await expect(toggle(window)).toHaveAttribute('aria-pressed', 'false');
    await window.keyboard.press('ControlOrMeta+i');
    await expect(inspector(window)).toBeVisible();
    await expect.poll(() => width(window)).toBe(316);

    // Stepped below its minimum from the keyboard it hides too, and the focus goes to the header's toggle.
    await dragHandle(window, -116);
    await expect.poll(() => width(window)).toBe(200);
    await handle(window).focus();
    await window.keyboard.press('ArrowLeft');
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

    // Show technical details gives Setup its tab, and with it a tab row: where it works, its branch, folder and AI, open.
    await setTechnical(window, true);
    await tabs(window).getByRole('tab', { name: 'Setup' }).click();
    const technical = inspector(window).getByRole('region', { name: 'Where it works' });
    await expect(technical).toContainText('Claude · default model');

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

test("an agent's Made shelf holds what it showed and pinned, counted on its tab, and each row opens where it belongs", async () => {
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

    // Made has a tab with its count: one document and four pins.
    const made = tabs(window).getByRole('tab', { name: /^Made/ });
    await expect(made).toHaveAttribute('aria-label', 'Made, 5');
    await made.click();
    await expect(inspector(window).getByTestId('inspector-document')).toContainText('Release 1.4 plan');
    const pins = inspector(window).getByTestId('inspector-pin');
    await expect(pins).toHaveCount(4);

    // A pinned Markdown file opens in a Doc tab, a link in a web tab, and the document in its Document tab.
    await pins.nth(0).getByRole('button').click();
    await expect(sessionWindow(window).getByTestId('doc-view').getByTestId('doc-body')).toContainText('Merge the flake fix first');
    await pins.nth(2).getByRole('button').click();
    await expect(sessionWindow(window).getByRole('tab', { name: 'localhost:9' })).toBeVisible();
    await inspector(window).getByTestId('inspector-document').getByRole('button').click();
    await expect(sessionWindow(window).getByTestId('document-view')).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Classic's Simple sidebar puts the shelves in place of the details strip, resizes it on its handle, is kept across a restart, and Full brings the strip back", async () => {
  classicOnly();
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await tile(window).dblclick();

    // Full by default: the details strip's rail, no inspector and no header toggle.
    await expect(sessionWindow(window).locator('.session-details')).toBeVisible();
    await expect(inspector(window)).toHaveCount(0);
    await expect(toggle(window)).toHaveCount(0);

    // Simple, picked in Settings while the window is open: the shelves replace the strip at once, shown, with the window's
    // controls and technical details in Setup.
    const settings = await openSettings(window, 'agents.sidebar');
    const choice = settingsSection(settings, 'Sidebar').getByRole('group', { name: 'Agent sidebar' });
    await choice.getByRole('button', { name: 'Simple' }).click();
    await expect(inspector(window)).toBeVisible();
    await expect(sessionWindow(window).locator('.session-details')).toHaveCount(0);
    await expect(toggle(window)).toHaveAttribute('aria-pressed', 'true');
    await expect(inspector(window).getByTestId('page-now')).toBeVisible();
    await tabs(window).getByRole('tab', { name: 'Setup' }).click();
    await expect(inspector(window).getByRole('list', { name: 'Controls' }).getByRole('button', { name: 'Stop' })).toBeEnabled();
    await expect(inspector(window).getByRole('region', { name: 'Where it works' })).toBeVisible();

    // It resizes on its handle as the Simplified design's does, and the header's toggle hides and shows it.
    await expect.poll(() => width(window)).toBe(316);
    await dragHandle(window, 80);
    await expect.poll(() => width(window)).toBe(396);
    await handle(window).dblclick();
    await expect.poll(() => width(window)).toBe(316);
    await toggle(window).click();
    await expect(inspector(window)).toHaveCount(0);
    await window.keyboard.press('ControlOrMeta+i');
    await expect(inspector(window)).toBeVisible();

    // Full again: the strip is back on its rail, and the toggle goes with the inspector.
    await choice.getByRole('button', { name: 'Full' }).click();
    await expect(inspector(window)).toHaveCount(0);
    await expect(sessionWindow(window).locator('.session-details-rail')).toBeVisible();
    await expect(toggle(window)).toHaveCount(0);

    // Simple again, it is kept across a restart: the window open as the app quit opens again with the inspector.
    await choice.getByRole('button', { name: 'Simple' }).click();
    await expect(inspector(window)).toBeVisible();
    await app.close();
    ({ app, window } = await launch(dataDir, env));
    await expect(inspector(window)).toBeVisible();
    await expect(sessionWindow(window).locator('.session-details')).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
