import { expect, type Page } from '@playwright/test';
import { createFakeGitHub, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { agents, launch, sessionWindow, spawnAgent, tile, TURN_MS } from './agent-helpers.ts';
import { browseForZone, classicOnly, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings, settingsSection } from './settings-helpers.ts';

// An agent's sidebar, its shelves: under the Simplified design at the window's leading edge, opening on the agent's page
// (the board's Now until it writes one) with Made, Crew and Setup a tab away, resized on the handle after it and collapsed
// to a rail (⌘I) whose icons open a shelf as a peek; under Classic, in place of the details strip while the Agent sidebar
// setting is Shelves.

const shelves = (window: Page) => sessionWindow(window).getByTestId('agent-shelves');
const rail = (window: Page) => sessionWindow(window).getByTestId('agent-shelves-rail');
const peek = (window: Page) => sessionWindow(window).getByTestId('agent-shelves-peek');
const tabs = (window: Page) => shelves(window).getByRole('tablist', { name: 'Shelves' });
const handle = (window: Page) => sessionWindow(window).getByTestId('details-handle');
const toggle = (window: Page) => sessionWindow(window).locator('.session-window-head').getByRole('button', { name: /^(Show|Collapse) the shelves$/ });
const width = async (window: Page) => Math.round((await shelves(window).boundingBox())!.width);

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

test("an agent's shelves open at the window's leading edge, resize on their handle, collapse to a rail whose icons peek, and are remembered", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env, [], { design: 'simplified' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await tile(window).dblclick();

    // Open at first, with its handle and none of Classic's details strip: at the leading edge, on the board's Now: who
    // started it, and what the page is for.
    await expect(toggle(window)).toHaveAttribute('aria-pressed', 'true');
    await expect(handle(window)).toBeVisible();
    await expect(sessionWindow(window).locator('.session-details')).toHaveCount(0);
    await expect(shelves(window)).toBeVisible();
    const offset = async () => (await shelves(window).boundingBox())!.x - (await sessionWindow(window).locator('.session-window-body').boundingBox())!.x;
    await expect.poll(async () => Math.abs(await offset()) < 0.5).toBe(true);
    // Its status line says who started it and, once its turn has ended, what the header's status word leaves out.
    await expect(shelves(window).getByTestId('page-status-line')).toContainText('started by you');
    await expect(shelves(window).getByTestId('page-status-line')).toContainText('Asks you', { timeout: TURN_MS });
    await expect(shelves(window).getByTestId('page-invite')).toBeVisible();
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

    // Pulled below its minimum it collapses to the rail; ⌘I opens it again at its width.
    await dragHandle(window, -2000);
    await expect(shelves(window)).toHaveCount(0);
    await expect(rail(window)).toBeVisible();
    await expect(handle(window)).toHaveCount(0);
    await expect(toggle(window)).toHaveAttribute('aria-pressed', 'false');
    await window.keyboard.press('ControlOrMeta+i');
    await expect(shelves(window)).toBeVisible();
    await expect.poll(() => width(window)).toBe(316);

    // Stepped below its minimum from the keyboard it collapses too, and the focus goes to the header's toggle.
    await dragHandle(window, -116);
    await expect.poll(() => width(window)).toBe(200);
    await handle(window).focus();
    await window.keyboard.press('ArrowLeft');
    await expect(shelves(window)).toHaveCount(0);
    await expect(toggle(window)).toBeFocused();
    await window.keyboard.press('Enter');
    await expect(shelves(window)).toBeVisible();
    await handle(window).dblclick();
    await expect.poll(() => width(window)).toBe(316);

    // Open when the window closes, it is open when the next one opens.
    await sessionWindow(window).getByRole('button', { name: /^Done, close / }).click();
    await expect(sessionWindow(window)).toHaveCount(0);
    await tile(window).dblclick();
    await expect(shelves(window)).toBeVisible();

    // Show technical details gives Setup its tab, and with it a tab row: where it works, its branch, folder and AI, open;
    // and the workspace footer on every shelf.
    await expect(shelves(window).getByTestId('shelves-footer')).toHaveCount(0);
    await setTechnical(window, true);
    await expect(shelves(window).getByTestId('shelves-footer')).toContainText('Claude');
    await tabs(window).getByRole('tab', { name: 'Setup' }).click();
    const technical = shelves(window).getByRole('region', { name: 'Where it works' });
    await expect(technical).toContainText('Claude');

    // Its folder row copies the folder's path.
    const folderRow = technical.getByTestId('setup-folder');
    const path = (await folderRow.getAttribute('title'))!;
    await folderRow.getByRole('button', { name: 'Copy folder' }).click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(path);

    // The footer's button collapses it to the rail, each shelf an icon. One opens its shelf as a peek over the terminal,
    // which Esc closes, handing the focus back to the icon.
    await shelves(window).getByTestId('shelves-footer').getByRole('button', { name: 'Collapse to the rail' }).click();
    await expect(rail(window)).toBeVisible();
    const now = rail(window).getByRole('button', { name: /^Now/ });
    await now.click();
    await expect(peek(window).getByTestId('page-now')).toBeVisible();
    await expect(now).toHaveAttribute('aria-expanded', 'true');
    await window.keyboard.press('Escape');
    await expect(peek(window)).toHaveCount(0);
    await expect(now).toBeFocused();
    // Esc there left the window alone.
    await expect(sessionWindow(window)).toBeVisible();
    // Another icon swaps it, its own icon closes it, and a click outside does too.
    await rail(window).getByRole('button', { name: 'Setup' }).click();
    await expect(peek(window)).toHaveAttribute('data-shelf', 'setup');
    await now.click();
    await expect(peek(window)).toHaveAttribute('data-shelf', 'page');
    await now.click();
    await expect(peek(window)).toHaveCount(0);
    await now.click();
    await sessionWindow(window).locator('.session-window-main').click({ position: { x: 500, y: 200 } });
    await expect(peek(window)).toHaveCount(0);

    // Collapsed when the window closes, it is collapsed when the next one opens; and a peek's first button opens the
    // shelves on its shelf.
    await sessionWindow(window).getByRole('button', { name: /^Done, close / }).click();
    await expect(sessionWindow(window)).toHaveCount(0);
    await tile(window).dblclick();
    await expect(rail(window)).toBeVisible();
    await rail(window).getByRole('button', { name: 'Setup' }).click();
    await peek(window).getByRole('button', { name: 'Open as shelves' }).click();
    await expect(shelves(window)).toBeVisible();
    await expect(tabs(window).getByRole('tab', { name: 'Setup' })).toHaveAttribute('aria-selected', 'true');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent's pins are a block of its page, deleted with Undo, and what it showed is in Made, counted on its tab, each opening where it belongs", async () => {
  const { dir, repo, env } = scratch('ask-plan');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env, [], { design: 'simplified' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pins: notes/report.md');
    await expect.poll(() => pinCount(window), { timeout: TURN_MS }).toBe(4);
    await tile(window).dblclick();

    // Its pins are on its page, each a record it can delete, with Undo.
    const pins = shelves(window).getByTestId('page-pins').getByTestId('details-pin');
    await expect(pins).toHaveCount(4);
    await pins.nth(1).hover();
    await pins.nth(1).getByRole('button', { name: 'Delete record' }).click();
    await expect(pins.nth(1)).toHaveAttribute('data-gone', 'true');
    await window.getByRole('button', { name: 'Undo' }).click();
    await expect(pins.nth(1)).not.toHaveAttribute('data-gone', 'true');

    // A pinned Markdown file opens in a Doc tab, a link in a web tab.
    await pins.nth(0).getByRole('button').first().click();
    await expect(sessionWindow(window).getByTestId('doc-view').getByTestId('doc-body')).toContainText('Merge the flake fix first');
    await pins.nth(2).getByRole('button').first().click();
    await expect(sessionWindow(window).getByRole('tab', { name: 'localhost:9' })).toBeVisible();

    // Made has a tab with its count, leaving out its pins; the document opens in its Document tab.
    const made = tabs(window).getByRole('tab', { name: /^Made/ });
    await expect(made).toHaveAttribute('aria-label', 'Made, 1');
    await made.click();
    const document = shelves(window).getByTestId('made-shown').getByTestId('details-document');
    await expect(document).toContainText('Release 1.4 plan');
    await document.getByRole('button').click();
    await expect(sessionWindow(window).getByTestId('document-view')).toBeVisible();

    // On the rail: an icon for each shelf with something in it, none for Setup with the technical layer off, and Made's
    // count; and a window open beside the one that collapsed it follows.
    await window.keyboard.press('ControlOrMeta+i');
    await expect(rail(window).getByRole('button', { name: /^Made/ }).locator('.agent-shelves-rail-badge')).toHaveText('1');
    await expect(rail(window).getByRole('button', { name: 'Setup' })).toHaveCount(0);
    await expect(rail(window).locator('.agent-shelves-rail-item')).toHaveCount(2);
    await window.evaluate(() => {
      localStorage.removeItem('agent-board.shelves-rail');
      globalThis.dispatchEvent(new StorageEvent('storage', { key: 'agent-board.shelves-rail' }));
    });
    await expect(shelves(window)).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Made's open pull request is a card whose x shows on hover, clear of its title, and deletes it with Undo, and Show brings it back", async () => {
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [] });
  const { dir, repo, env } = scratch('ask-plan');
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_GH: github.gh, AGENT_BOARD_PULL_REQUEST_POLL_MS: '200' }, [], { design: 'simplified' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Record PR: https://github.com/acme/app/pull/41');
    const [agent] = await agents(window);
    github.setState({
      ...FAKE_GITHUB_STATE,
      pullRequests: [{ repo: 'acme/app', number: 41, title: 'Send users home after login', headRefName: agent!.branch, headRefOid: 'b'.repeat(40), state: 'OPEN', isDraft: false, body: '', statusCheckRollup: [], files: [], comments: [], reviewComments: [] }],
    });
    await expect.poll(async () => (await agents(window))[0]?.records.filter((record) => record.kind === 'pr').length, { timeout: TURN_MS }).toBe(1);
    await tile(window).dblclick();
    await tabs(window).getByRole('tab', { name: /^Made/ }).click();

    const card = shelves(window).getByTestId('made-pr');
    await expect(card).toHaveAttribute('data-source', 'recorded');
    const remove = card.getByRole('button', { name: 'Delete record' });
    await card.hover();
    await expect(remove).toHaveCSS('opacity', '1');
    // The title stops short of it, so a click on the title's end opens the pull request.
    const title = (await card.locator('.made-pr-title').boundingBox())!;
    expect(title.x + title.width).toBeLessThanOrEqual((await remove.boundingBox())!.x + 1);

    await remove.click();
    await window.getByRole('button', { name: 'Undo' }).click();
    await expect(card).toBeVisible();
    await card.hover();
    await remove.click();
    // Faded out, the shelf says what it hides and keeps its tab, and Show brings the card back.
    const hidden = shelves(window).getByTestId('details-hidden');
    await expect(hidden).toContainText('1 hidden', { timeout: TURN_MS });
    await expect(card).toHaveCount(0);
    await hidden.getByRole('button', { name: 'Show' }).click();
    await expect(card).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    github.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Classic's Shelves sidebar puts the shelves in place of the details strip, resizes it on its handle, is kept across a restart, and Full brings the strip back", async () => {
  classicOnly();
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await tile(window).dblclick();

    // Full by default: the details strip's rail, and no shelves.
    await expect(sessionWindow(window).locator('.session-details')).toBeVisible();
    await expect(shelves(window)).toHaveCount(0);
    await expect(toggle(window)).toHaveCount(0);

    // Shelves, picked in Settings while the window is open: the shelves replace the strip at once, shown, with where it
    // works in Setup, and the window's controls in the header: one state button, and Stop under ⋯.
    const settings = await openSettings(window, 'agents.sidebar');
    const choice = settingsSection(settings, 'Sidebar').getByRole('group', { name: 'Agent sidebar' });
    await choice.getByRole('button', { name: 'Shelves' }).click();
    await expect(shelves(window)).toBeVisible();
    await expect(sessionWindow(window).locator('.session-details')).toHaveCount(0);
    // Its rail brings it back, so Classic's header needs no toggle.
    await expect(toggle(window)).toHaveCount(0);
    await expect(shelves(window).getByTestId('page-now')).toBeVisible();
    await tabs(window).getByRole('tab', { name: 'Setup' }).click();
    await expect(shelves(window).getByRole('region', { name: 'Where it works' })).toBeVisible();
    const controls = sessionWindow(window).locator('.session-window-head').getByTestId('shelf-controls');
    await expect(controls.getByRole('button', { name: /^(Interrupt|Pause)$/ })).toBeVisible();
    await controls.getByRole('button', { name: 'More controls' }).click();
    await expect(window.getByRole('menuitem', { name: /^Stop/ })).toBeEnabled();
    await window.keyboard.press('Escape');
    // Paused from the state button, the header's one button is Wake.
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    await controls.getByRole('button', { name: 'Pause' }).click();
    await expect(controls.getByRole('button', { name: 'Wake' })).toBeVisible({ timeout: TURN_MS });

    // It resizes on its handle as the Simplified design's does, and collapses to its rail.
    await expect.poll(() => width(window)).toBe(316);
    await dragHandle(window, 80);
    await expect.poll(() => width(window)).toBe(396);
    await handle(window).dblclick();
    await expect.poll(() => width(window)).toBe(316);
    // The footer says its branch while it shows; on the rail, the header says it, so it is never out of sight.
    const where = sessionWindow(window).locator('.session-window-where');
    await expect(where).toHaveCount(0);
    await shelves(window).getByRole('button', { name: 'Collapse to the rail' }).click();
    await expect(shelves(window)).toHaveCount(0);
    await expect(where).toBeVisible();
    await rail(window).getByRole('button', { name: 'Show the shelves' }).click();
    await expect(shelves(window)).toBeVisible();
    await expect(where).toHaveCount(0);

    // Full again: the strip is back on its rail.
    await choice.getByRole('button', { name: 'Full' }).click();
    await expect(shelves(window)).toHaveCount(0);
    await expect(sessionWindow(window).locator('.session-details-rail')).toBeVisible();
    await expect(toggle(window)).toHaveCount(0);
    await expect(controls).toHaveCount(0);

    // Shelves again, it is kept across a restart: the window open as the app quit opens again with the inspector.
    await choice.getByRole('button', { name: 'Shelves' }).click();
    await expect(shelves(window)).toBeVisible();
    await app.close();
    ({ app, window } = await launch(dataDir, env));
    await expect(shelves(window)).toBeVisible();
    await expect(sessionWindow(window).locator('.session-details')).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
