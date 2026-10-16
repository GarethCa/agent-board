import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { EdgePoint } from '@agent-board/daemon/protocol';
import { createFakeGitHub, FAKE_GITHUB_STATE, type FakeGitHubPullRequest } from '@agent-board/tracker/testing';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agents, closeAgent, launch, LONG_MODEL, narrowBy, pickInChip, screen, sessionWindow, setClickOpens, spawnAgent, startBadgedAgent, startCrowdedAgent, tile, tileAction, TURN_MS, windowKey, zoneNamed, zones } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone, newShell } from './launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, pinRandomText, settle } from './render.ts';
import { scratch } from './scratch.ts';

// Visual regression for the Workbench theme. Baselines are per platform (`-linux`, `-darwin`) and both are committed;
// a test runs against the ones for the platform it is on, and fails, never skips, if they are missing. `pnpm visual:update`
// regenerates this machine's; `pnpm visual:check` compares them. The baselines are for macOS.
test.use({ viewport: null });

/** Tight: a recoloured PR chip is a few hundred pixels. Shots are stable to the pixel run to run. */
const SHOT = { maxDiffPixels: 100, animations: 'disabled' as const, caret: 'hide' as const };

const SNAPSHOTS = join(import.meta.dirname, 'visual.spec.ts-snapshots');

/** Fails the test, saying how to fix it, if any of its `shots` has no baseline for this platform, unless baselines are being written. */
function needsBaselines(...shots: string[]) {
  const { updateSnapshots } = test.info().config;
  if (updateSnapshots === 'all' || updateSnapshots === 'changed') return;
  const missing = shots.filter((shot) => !existsSync(join(SNAPSHOTS, `${shot}-visual-${process.platform}.png`)));
  expect(missing, `no ${process.platform} baseline for these shots: run \`pnpm visual:update\`, look at each PNG, and commit them`).toEqual([]);
}

test('the Workbench theme: the empty board, a busy board, its menu and inbox, a waiting tile, an expanded tile, and the session window', async () => {
  needsBaselines('empty-board', 'tile-waiting', 'board', 'board-menu', 'inbox', 'expanded-tile', 'session-window');
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    // The chrome on a first launch: the islands over an empty board, and its welcome.
    let restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot('empty-board.png', SHOT);
    await restorePointer();

    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    await spawnAgent(window, 'monorepo', 'Tidy the tokens');
    await expect(tile(window)).toHaveCount(2);
    await expect(tile(window).nth(1)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });

    // Branch names end in a random suffix, and the worktrees' folders and the daemon's pid differ run to run: pinned.
    await pinRandomText(window);
    // Soft, so one run reports (and writes an actual for) every shot that changed.
    restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(tile(window).first()).toHaveScreenshot('tile-waiting.png', SHOT);
    await expect.soft(window.locator('.board')).toHaveScreenshot('board.png', SHOT);
    await restorePointer();

    // The board menu, open: its zones, sessions and settings.
    await window.getByRole('button', { name: 'Board menu' }).click();
    await expect(window.getByRole('dialog', { name: 'Board menu' })).toBeVisible();
    await pinRandomText(window);
    restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('body')).toHaveScreenshot('board-menu.png', SHOT);
    await restorePointer();
    await window.keyboard.press('Escape');

    // The inbox, open from the Needs-you pill.
    await window.getByTestId('inbox-count').click();
    await expect(window.getByTestId('needs-you-inbox')).toBeVisible();
    restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('body')).toHaveScreenshot('inbox.png', SHOT);
    await restorePointer();
    await window.keyboard.press('Escape');

    // A tile expanded in place: its details collapsed to the icon rail on the left, its terminal beside them, the tile beside it pushed clear.
    await setClickOpens(window, 'Expand in place');
    const viewport = () => window.locator('.react-flow__viewport').evaluate((element) => (element as HTMLElement).style.transform);
    const unmoved = await viewport();
    await tile(window).first().dblclick();
    const expandedTile = window.getByTestId('expanded-tile');
    await expect(screen(window)).toContainText('Which database should I use');
    // It opens past the board's edge, so the view follows it once a double-click can no longer come: shot after that,
    // which a slow run would otherwise race.
    await expect.poll(viewport).not.toBe(unmoved);
    let last = '';
    await expect
      .poll(async () => {
        const now = await viewport();
        const still = now === last;
        last = now;
        return still;
      })
      .toBe(true);
    await pinRandomText(window);
    restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot('expanded-tile.png', { ...SHOT, mask: [screen(window)] });
    await restorePointer();
    await expandedTile.getByRole('button', { name: 'Collapse' }).click();
    await expect(expandedTile).toHaveCount(0);

    await setClickOpens(window, 'Session window');
    await tile(window).first().dblclick();
    await expect(screen(window)).toContainText('Which database should I use');
    await pinRandomText(window);
    // The terminal's text and cursor are masked, not its background.
    await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('body')).toHaveScreenshot('session-window.png', { ...SHOT, mask: [screen(window)] });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a crowded tile at its narrowest, and New agent with a long model id: nothing runs past its container', async () => {
  needsBaselines('tile-crowded-narrow', 'new-agent-long-model');
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await startCrowdedAgent(window);
    for (let step = 0; step < 4; step++) await narrowBy(window, tile(window), -60);
    await expect(tile(window).getByTestId('tile-folded')).toBeVisible();
    await pinRandomText(window);
    let restorePointer = await ignorePointer(window);
    await settle(window);
    // A follow-up reviewer's branch line names the commit it reviews, which differs run to run.
    await expect.soft(tile(window)).toHaveScreenshot('tile-crowded-narrow.png', { ...SHOT, mask: [tile(window).locator('.hybrid-tile-branch')] });
    await restorePointer();

    // The picker's chips beside Start, with a typed model id as long as one gets.
    await zoneNamed(window, 'monorepo').getByRole('button', { name: 'New agent' }).click();
    const form = window.getByRole('dialog', { name: 'New agent' });
    await pickInChip(form, 'Model', 'Other…');
    await form.getByRole('textbox', { name: 'Model id' }).fill(LONG_MODEL);
    await pickInChip(form, 'Role', 'Follow-up reviewer');
    restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(form).toHaveScreenshot('new-agent-long-model.png', SHOT);
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tile with model and role badges gains two PR chips, which stay while the rest folds into +N', async () => {
  needsBaselines('tile-crowded-pr');
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [] });
  const { dir, repo, env } = scratch('waiting');
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0', AGENT_BOARD_GH: github.gh, AGENT_BOARD_PULL_REQUEST_POLL_MS: '200' }, RENDER_ARGS);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await startBadgedAgent(window);
    const [agent] = await agents(window);
    const pullRequest = (number: number): FakeGitHubPullRequest => ({
      repo: 'acme/app',
      number,
      title: `Pull request ${number}`,
      headRefName: agent!.branch,
      headRefOid: 'b'.repeat(40),
      state: 'OPEN',
      isDraft: false,
      body: 'A change.',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/app/actions/runs/1' }],
      files: [],
      comments: [],
      reviewComments: [],
    });
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest(41), pullRequest(42)] });
    await expect(tile(window).getByTestId('tile-pr')).toHaveCount(2, { timeout: 20_000 });
    await expect(tile(window).getByTestId('tile-folded')).toBeVisible();
    await pinRandomText(window);
    const restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(tile(window)).toHaveScreenshot('tile-crowded-pr.png', { ...SHOT, mask: [tile(window).locator('.hybrid-tile-branch')] });
    await restorePointer();

  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a finished agent keeps the summary it set and shows no percentage from mid-turn', async () => {
  needsBaselines('tile-finished-status');
  const { dir, repo, env } = scratch('board');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Look around');
    // Its turn over (its CLI calls take a turn's worth of time) it waits, its tile saying what it last said. Stopped, it
    // shows what it set, with no percentage.
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    await tile(window).getByRole('button', { name: 'Expand' }).click();
    const expanded = window.getByTestId('expanded-tile');
    await expanded.getByRole('navigation', { name: 'Session controls' }).getByRole('button', { name: 'Stop' }).click();
    await expanded.getByRole('button', { name: 'Collapse' }).click();
    await expect(tile(window).getByTestId('tile-description')).toHaveText('Look around');
    await pinRandomText(window);
    const restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(tile(window)).toHaveScreenshot('tile-finished-status.png', { ...SHOT, mask: [tile(window).locator('.hybrid-tile-branch')] });
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dock of fifteen sessions scrolls with a fade at its edge', async () => {
  needsBaselines('session-dock-overflow');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    for (let count = 0; count < 15; count++) {
      await newShell(window);
      await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
      await window.getByRole('button', { name: 'Minimise session window' }).click();
      await expect(window.getByTestId('dock-item')).toHaveCount(count + 1);
    }
    const dock = window.getByTestId('session-dock');
    await expect(dock).toHaveAttribute('data-more', 'start');
    const restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(dock).toHaveScreenshot('session-dock-overflow.png', SHOT);
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test("a shell tile's session window with tabs, split into two panes each with its strip", async () => {
  needsBaselines('shell-window-tabs');
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' }).click();
    const tabs = sessionWindow(window).getByTestId('session-tab');
    await expect(tabs).toHaveCount(1);
    await window.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control+Shift'}+t`);
    await expect(tabs).toHaveCount(2);
    // The window has opened to its size: a split looks at the pane's room.
    await settle(window);
    await window.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control+Shift'}+d`);
    await expect(sessionWindow(window).getByTestId('window-pane')).toHaveCount(2);
    await expect(sessionWindow(window).locator('.xterm-rows')).toHaveCount(3);
    await pinRandomText(window);
    await ignorePointer(window);
    await settle(window);
    // The shells' prompts and the tile's folder (a temporary one) differ run to run.
    await expect.soft(window.locator('body')).toHaveScreenshot('shell-window-tabs.png', {
      ...SHOT,
      mask: [sessionWindow(window).locator('.xterm-rows'), sessionWindow(window).locator('.session-window-where')],
    });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a session window resized up to the board\'s top edge clears the macOS traffic lights, windowed, and reaches the top in full screen', async () => {
  needsBaselines('session-window-top-edge', 'session-window-top-edge-full-screen');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.getByRole('button', { name: 'Restore session window' }).click();
    const dragTopEdgeUp = async () => {
      const edge = (await sessionWindow(window).locator('[data-edge="n"]').boundingBox())!;
      await window.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
      await window.mouse.down();
      await window.mouse.move(edge.x + edge.width / 2, -200, { steps: 8 });
      await window.mouse.up();
    };
    // The terminal is masked; the lights themselves are the OS's, so the shot shows the room kept for them.
    const shoot = async (name: string) => {
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('body')).toHaveScreenshot(name, { ...SHOT, mask: [screen(window), sessionWindow(window).locator('.session-window-where')] });
      await restorePointer();
    };
    await dragTopEdgeUp();
    await shoot('session-window-top-edge.png');
    // What the main process sends when the window goes full screen, which hides the lights.
    await window.evaluate(() => (document.documentElement.dataset.fullScreen = 'true'));
    // The page has taken it in: the bounds a drag stays inside follow the flag.
    await window.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await dragTopEdgeUp();
    await shoot('session-window-top-edge-full-screen.png');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

/** Zones in four colours with every fill opacity from none to the most, and a zone's menu with its 16 colours and slider. */
for (const { theme, suffix } of [
  { theme: 'light', suffix: '' },
  { theme: 'dark', suffix: '-dark' },
] as const) {
  test(`zone colours and fill opacity: four zones and the zone menu, ${theme}`, async () => {
    needsBaselines(`zone-looks${suffix}`, `zone-menu${suffix}`);
    const { dir, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      const looks = [
        { name: 'Theme default', color: '#4c6ef5', fillOpacity: null },
        { name: 'Outline only', color: '#fd7e14', fillOpacity: 0 },
        { name: 'Soft', color: '#be4bdb', fillOpacity: 20 },
        { name: 'Strong', color: '#495057', fillOpacity: 40 },
      ];
      await window.evaluate(async (wanted) => {
        const { zones } = globalThis.window.agentBoard;
        for (const [index, look] of wanted.entries()) {
          const zone = await zones.addUnbound({ name: look.name, x: (index % 2) * 320, y: Math.floor(index / 2) * 220, width: 300, height: 200 });
          await zones.setLook(zone.id, { color: look.color, fillOpacity: look.fillOpacity });
        }
      }, looks);
      await expect(window.getByTestId('zone')).toHaveCount(4);
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      await pinRandomText(window);
      let restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`zone-looks${suffix}.png`, SHOT);
      await restorePointer();

      await window.getByTestId('zone').first().getByRole('button', { name: 'Zone options' }).click();
      await expect(window.getByRole('slider', { name: 'Fill opacity' })).toBeVisible();
      restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('body')).toHaveScreenshot(`zone-menu${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close().catch(() => {});
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const { theme, suffix } of [
  { theme: 'light', suffix: '' },
  { theme: 'dark', suffix: '-dark' },
] as const) {
  test(`the ⌘K switcher over the board, before and after typing, ${theme}`, async () => {
    needsBaselines(`spotlight-empty${suffix}`, `spotlight-typed${suffix}`);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Pick a database');
      await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      await spawnAgent(window, 'monorepo', 'Tidy the tokens');
      await expect(tile(window)).toHaveCount(2);
      await expect(tile(window).nth(1)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      // Seen, so it moves from Needs you to Recent.
      await tile(window).filter({ hasText: 'Tidy the tokens' }).dblclick();
      await window.getByRole('button', { name: 'Close session window' }).click();
      await expect(sessionWindow(window)).toHaveCount(0);

      await window.keyboard.press(windowKey('k'));
      const switcher = window.getByRole('dialog', { name: 'Jump to a session or zone' });
      await expect(switcher.getByTestId('spotlight-row')).toHaveCount(3);
      await pinRandomText(window);
      let restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('body')).toHaveScreenshot(`spotlight-empty${suffix}.png`, SHOT);
      await restorePointer();

      await window.keyboard.type('tid');
      await expect(switcher.getByTestId('spotlight-row')).toHaveCount(1);
      await pinRandomText(window);
      restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('body')).toHaveScreenshot(`spotlight-typed${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close().catch(() => {});
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/** The board menu with more zones than fit a short window: it stays inside the window, scrolls, and its last control can be reached. */
test('the board menu with a dozen zones in a short window stays inside it and scrolls to Settings', async () => {
  needsBaselines('board-menu-overflow');
  const { dir, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  try {
    await window.setViewportSize({ width: VIEWPORT.width, height: 700 });
    await pinFonts(window);
    await window.evaluate(async () => {
      const { zones } = globalThis.window.agentBoard;
      for (let index = 0; index < 12; index++) {
        await zones.addUnbound({ name: `Zone ${index + 1}`, x: (index % 4) * 320, y: Math.floor(index / 4) * 220, width: 300, height: 200 });
      }
    });
    await expect(window.getByTestId('zone')).toHaveCount(12);
    await window.getByRole('button', { name: 'Board menu' }).click();
    const menu = window.getByRole('dialog', { name: 'Board menu' });
    await expect(menu).toBeVisible();
    await pinRandomText(window);

    // The popover ends inside the window, and the sections are what scroll.
    const bottom = await menu.evaluate((element) => element.getBoundingClientRect().bottom);
    expect(bottom).toBeLessThanOrEqual(700);
    const sections = menu.locator('.board-menu-sections');
    expect(await sections.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

    const restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('body')).toHaveScreenshot('board-menu-overflow.png', SHOT);
    await restorePointer();

    // The last Settings control scrolls into view and is clickable.
    const last = menu.getByRole('group', { name: 'Settings' }).or(menu.locator('section', { hasText: 'Settings' })).locator('button, [role="switch"], [role="radio"]').last();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await last.click({ trial: true });
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Waits until the board's view stops moving: after a fit or a jump, which animate. */
async function viewSettled(window: Page): Promise<void> {
  const viewport = () => window.locator('.react-flow__viewport').evaluate((element) => (element as HTMLElement).style.transform);
  let last = '';
  await expect
    .poll(async () => {
      const now = await viewport();
      const still = now === last;
      last = now;
      return still;
    })
    .toBe(true);
}

/**
 * Two waiting agents in a zone, with what a theme redraws by name: two notes, Ink text, a filled shape and a flow edge
 * between the agents; then fits the view to them all.
 */
async function fillBusyBoard(app: ElectronApplication, window: Page, repo: string) {
  await pickFolderNext(app, repo);
  await browseForZone(window);
  await spawnAgent(window, 'monorepo', 'Pick a database');
  await spawnAgent(window, 'monorepo', 'Tidy the tokens');
  await expect(tile(window)).toHaveCount(2);
  for (const at of [0, 1]) await expect(tile(window).nth(at)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
  await window.addStyleTag({ content: '.hybrid-tile { rotate: 1deg !important; }' });

  // Stored light colours, drawn by name in the dark theme: two notes, Ink text and a filled shape, and a flow edge.
  const [planner, builder] = await agents(window);
  const [zone] = await zones(window);
  await window.evaluate(
    async ({ zoneId, from, to }) => {
      const { items, flowEdges } = globalThis.window.agentBoard;
      await items.create({ kind: 'sticky', zoneId, x: 30, y: 250, width: 220, height: 140, data: { text: '**Ship Friday**\n\n- checkout fix\n- cache decision', color: '#fff3a3' } });
      await items.create({ kind: 'sticky', zoneId: null, x: -280, y: 60, width: 200, height: 120, data: { text: 'Ask about the Stripe test keys', color: '#fcc2d7' } });
      await items.create({ kind: 'text', zoneId: null, x: -280, y: -60, width: 300, height: 50, data: { text: 'Launch week', size: 'h1', bold: true, italic: false, align: 'left', color: '#2b2a27', wrap: false } });
      await items.create({
        kind: 'shape',
        zoneId: null,
        x: -280,
        y: 220,
        width: 200,
        height: 80,
        data: { shape: 'rounded', fill: '#d0ebff', stroke: '#3b5bdb', strokeWidth: 2.5, dashed: false, text: 'Release 1.0', textSize: 'body', bold: true, textColor: '#2b2a27' },
      });
      await flowEdges.create({ from, to });
    },
    { zoneId: zone!.id, from: planner!.sessionId, to: builder!.sessionId },
  );
  await expect(window.getByTestId('flow-edge')).toHaveCount(1);
  // The board draws only what is in view, so fit it all in first.
  await window.getByRole('button', { name: /^Fit view/ }).click();
  await viewSettled(window);
  await expect(window.getByTestId('sticky')).toHaveCount(2);
  await expect(window.getByTestId('shape')).toHaveCount(1);
  await expect(window.getByTestId('text-item')).toHaveCount(1);
}

/**
 * The theme packs shot, a few standing for all of them (tokens.test.ts holds every pack to the same rules): a dark one,
 * a warm light one and the colour-blind-safe one.
 */
const PACK_SHOTS = [
  { theme: 'catppuccin-mocha', scheme: 'dark' },
  { theme: 'gruvbox-light', scheme: 'light' },
  { theme: 'clear-sight-light', scheme: 'light' },
] as const;

for (const { theme, scheme } of PACK_SHOTS) {
  test(`the ${theme} theme pack: a busy board with notes, text, a shape and a flow edge`, async () => {
    needsBaselines(`${theme}-board`);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(
      dataDir,
      { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: theme, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
      RENDER_ARGS,
    );
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: scheme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await fillBusyBoard(app, window, repo);
      await pinRandomText(window);
      await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`${theme}-board.png`, SHOT);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/** Arrows between notes (row 22): straight, elbow bent once, and a curve bowed by its bow handle, selected with its handles. */
for (const { theme, suffix } of [
  { theme: 'light', suffix: '' },
  { theme: 'dark', suffix: '-dark' },
] as const) {
  test(`arrows: straight, an elbow bent once, and a bowed curve selected with its end and bow handles, ${theme}`, async () => {
    needsBaselines(`arrows${suffix}`);
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window } = await launch(dataDir, { ...RENDER_ENV, ...appearance }, RENDER_ARGS);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await window.evaluate(async () => {
        const { items, connectors } = globalThis.window.agentBoard;
        const note = (text: string, x: number, y: number) =>
          items.create({ kind: 'sticky', zoneId: null, x, y, width: 160, height: 120, data: { text, color: '#ffd43b' } });
        const ends = async (row: number, style: 'straight' | 'elbow' | 'curved', points: EdgePoint[], label = '') => {
          const [from, to] = [await note(`${style} from`, 0, row * 200), await note(`${style} to`, 820, row * 200 + 40)];
          await connectors.create({ from: { type: 'item', id: from.id, side: 'right' }, to: { type: 'item', id: to.id, side: 'left' }, style, points, label });
        };
        await ends(0, 'straight', []);
        await ends(1, 'elbow', [{ x: -40, y: 70 }]);
        await ends(2, 'curved', [{ x: -60, y: -110, bow: true }], 'bowed');
      });
      await expect(window.locator('.react-flow__edge-path.connector-line')).toHaveCount(3);
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      // The curve selected by its label: its end handles and its one bow handle, on the point it was pulled to.
      await window.getByTestId('connector-label').click();
      await expect(window.getByTestId('line-bow')).toHaveCount(1);
      await expect(window.getByTestId('line-insert')).toHaveCount(0);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`arrows${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}

test('the dark theme (AN1): a busy board with notes, text, a shape and a flow edge, its Edge rules, and the session window in both views', async () => {
  needsBaselines('dark-board', 'dark-edge-rules', 'dark-session-window', 'dark-chat-view');
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(
    dataDir,
    { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: 'dark', SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
    RENDER_ARGS,
  );
  try {
    await window.setViewportSize(VIEWPORT);
    // Playwright pins the page to light; the setting has the window in dark mode, as macOS would.
    await window.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await pinFonts(window);
    await fillBusyBoard(app, window, repo);
    await pinRandomText(window);
    let restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot('dark-board.png', SHOT);
    await restorePointer();

    // The Edge rules panel, on the edge: its token opens them.
    await window.getByTestId('rail-token').locator('.rail-token-open').click();
    const rules = window.getByRole('complementary', { name: 'Edge rules' });
    await expect(rules).toBeVisible();
    await expect(rules.getByTestId('edge-rules-preview')).not.toBeEmpty();
    await pinRandomText(window);
    restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('body')).toHaveScreenshot('dark-edge-rules.png', SHOT);
    await restorePointer();
    await window.keyboard.press('Escape');

    // The session window: its terminal the inset well, then the chat view of the same session.
    await tile(window).filter({ hasText: 'Pick a database' }).dblclick();
    await expect(screen(window)).toContainText('Which database should I use');
    await pinRandomText(window);
    restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('body')).toHaveScreenshot('dark-session-window.png', { ...SHOT, mask: [screen(window)] });
    await restorePointer();
    const view = sessionWindow(window).getByRole('group', { name: 'View' });
    await view.getByRole('button', { name: 'Chat' }).click();
    await expect(sessionWindow(window).getByTestId('chat-assistant')).toHaveText(['Which database should I use, Postgres or SQLite?']);
    await pinRandomText(window);
    await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('body')).toHaveScreenshot('dark-chat-view.png', SHOT);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hand-off between agents bent through a point to the top of the other tile, selected with its handles and its Edge rules in four sections', async () => {
  needsBaselines('edge-rules', 'edge-bent');
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Fix checkout flake');
    await spawnAgent(window, 'monorepo', 'Review checkout fix');
    await expect(tile(window)).toHaveCount(2);
    for (const at of [0, 1]) await expect(tile(window).nth(at)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    // Apart, the second lower down, so the edge has room for its label and a bend.
    const [fixer, reviewer] = await agents(window);
    const [zone] = await zones(window);
    await window.evaluate(
      async ({ zoneId, from, to }) => {
        await globalThis.window.agentBoard.agents.move(from, { zoneId, x: 20, y: 40 });
        await globalThis.window.agentBoard.agents.move(to, { zoneId, x: 560, y: 300 });
        await globalThis.window.agentBoard.flowEdges.create({ from, to, trigger: 'manual', fromSide: 'right', toSide: 'top' });
      },
      { zoneId: zone!.id, from: fixer!.sessionId, to: reviewer!.sessionId },
    );
    await expect(window.getByTestId('flow-edge')).toHaveCount(1);
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);

    // Bent through one point (dragging a bend out is the e2e's: here it is put exactly, so it lands the same run to
    // run), up and to the right of the middle of its ends, where its bends are kept from. Selected, it shows its handles.
    await window.evaluate(async () => {
      const { flowEdges } = globalThis.window.agentBoard;
      const [edge] = await flowEdges.list();
      await flowEdges.update({ id: edge!.id, points: [{ x: 220, y: -150 }] });
    });
    await window.getByTestId('rail-token').locator('.rail-token-open').click();
    const rules = window.getByRole('complementary', { name: 'Edge rules' });
    await expect(rules).toBeVisible();
    await expect(window.getByTestId('line-bow')).toHaveCount(1);
    await expect(rules.getByTestId('edge-rules-preview')).not.toBeEmpty();
    await pinRandomText(window);
    let restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('body')).toHaveScreenshot('edge-rules.png', SHOT);
    await restorePointer();

    // Unselected, the bent line alone.
    await rules.getByRole('button', { name: 'Close edge rules' }).click();
    await expect(window.getByTestId('line-bow')).toHaveCount(0);
    restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot('edge-bent.png', SHOT);
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two agents stacked one above the other, joined both ways by edges made without sides: one rail between the sides facing each other', async () => {
  needsBaselines('edges-stacked');
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Fix checkout flake');
    await spawnAgent(window, 'monorepo', 'Review checkout fix');
    await expect(tile(window)).toHaveCount(2);
    for (const at of [0, 1]) await expect(tile(window).nth(at)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    // The implementer above its reviewer, joined as an orchestrator joins them: with no sides given, each way.
    const [fixer, reviewer] = await agents(window);
    const [zone] = await zones(window);
    await window.evaluate(
      async ({ zoneId, from, to }) => {
        const { agents, flowEdges } = globalThis.window.agentBoard;
        await agents.move(from, { zoneId, x: 40, y: 40 });
        await agents.move(to, { zoneId, x: 40, y: 520 });
        await flowEdges.create({ from, to, payload: 'handover', path: 'handover.md' });
        await flowEdges.create({ from: to, to: from, trigger: 'manual' });
      },
      { zoneId: zone!.id, from: fixer!.sessionId, to: reviewer!.sessionId },
    );
    await expect(window.getByTestId('flow-edge')).toHaveCount(1);
    await expect(window.getByTestId('rail-token')).toHaveCount(1);
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    await pinRandomText(window);
    const restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot('edges-stacked.png', SHOT);
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('linked sessions as one rail (CD4): a pair waiting for Send beside a one-way link, then its review on its way, a hand-off held, and the pair at rest', async () => {
  needsBaselines('rail-waiting', 'rail-chain', 'rail-sending', 'rail-held', 'rail-rest');
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Fix checkout flake');
    await spawnAgent(window, 'monorepo', 'Review checkout fix');
    await spawnAgent(window, 'monorepo', 'Merge checkout fix');
    await expect(tile(window)).toHaveCount(3);
    for (const at of [0, 1, 2]) await expect(tile(window).nth(at)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    const [fixer, reviewer, merger] = await agents(window);
    const [zone] = await zones(window);
    // The fixer's handover goes to the reviewer once CI is green; the reviewer's review goes back when sent.
    writeFileSync(join(fixer!.worktree, 'handover.md'), '# Handover\n');
    writeFileSync(join(reviewer!.worktree, 'review.md'), '# Review\n');
    const [handover, review] = await window.evaluate(
      async ({ zoneId, ids }) => {
        const { agents, flowEdges } = globalThis.window.agentBoard;
        for (const [index, id] of ids.entries()) await agents.move(id, { zoneId, x: 20 + index * 520, y: 40 });
        return [
          await flowEdges.create({ from: ids[0]!, to: ids[1]!, payload: 'handover', path: 'handover.md', conditions: [{ kind: 'pr-checks' }] }),
          await flowEdges.create({ from: ids[1]!, to: ids[0]!, trigger: 'manual', payload: 'handover', path: 'review.md' }),
        ];
      },
      { zoneId: zone!.id, ids: [fixer!.sessionId, reviewer!.sessionId, merger!.sessionId] },
    );
    const token = window.getByTestId('rail-token');
    await expect(token).toHaveAttribute('data-state', 'waiting');
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    const shoot = async (name: string) => {
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(name, SHOT);
      await restorePointer();
    };
    // The reviewer is done: its review waits at its end, with Send.
    await shoot('rail-waiting.png');

    // A one-way link on to the merger: a rail with a small arrow, and a ghost of what comes next.
    await window.evaluate(
      ([from, to]) => globalThis.window.agentBoard.flowEdges.create({ from: from!, to: to!, payload: 'json', path: 'verdict.json', conditions: [{ kind: 'pr-checks' }] }),
      [reviewer!.sessionId, merger!.sessionId],
    );
    await expect(token).toHaveCount(2);
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    await shoot('rail-chain.png');

    // Sent, it is on its way to the fixer: under reduced motion it is drawn there at once. The trip is held open, so the
    // shot never races its end.
    const longTrip = await window.addStyleTag({ content: ':root { --motion-handoff: 600000ms !important; }' });
    await token.filter({ hasText: 'review.md' }).getByTestId('rail-token-send').click();
    await expect(token.filter({ hasText: 'review.md' })).toHaveAttribute('data-state', 'sending');
    // The fixer's turn on it ends meanwhile, and its handover is held until CI is green: shot once its tile is still.
    const held = async () => (await window.evaluate(() => globalThis.window.agentBoard.flowEdges.list())).find((edge) => edge.id === handover.id)?.held;
    await expect.poll(held, { timeout: 30_000 }).not.toBeNull();
    await expect(tile(window).filter({ hasText: 'Fix checkout flake' })).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    await shoot('rail-sending.png');

    // Its trip over, the handover shows, held at the fixer's end.
    await longTrip.evaluate((element) => (element as Element).remove());
    // Any change to the edges looks again at what is on its way.
    await window.evaluate((id) => globalThis.window.agentBoard.flowEdges.update({ id, deliverAs: 'message' }), review.id);
    await expect(token.filter({ hasText: 'handover.md' })).toHaveAttribute('data-state', 'held');
    await shoot('rail-held.png');

    // Dropped, the pair is at rest: the review at the fixer's end, delivered, round 1.
    await window.evaluate((id) => globalThis.window.agentBoard.flowEdges.drop(id), handover.id);
    await expect(token.filter({ hasText: 'review.md' })).toHaveAttribute('data-state', 'delivered');
    await shoot('rail-rest.png');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const { theme, suffix } of [
  { theme: 'light', suffix: '' },
  { theme: 'dark', suffix: '-dark' },
] as const) {
  test(`a lane with closed agents folded to chips beside a live one, joined by edges, ${theme}`, async () => {
    needsBaselines(`folded-chips${suffix}`);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Fix checkout flake');
      await spawnAgent(window, 'monorepo', 'Review checkout fix');
      await spawnAgent(window, 'monorepo', 'Ship checkout fix');
      await expect(tile(window)).toHaveCount(3);
      for (const at of [0, 1, 2]) await expect(tile(window).nth(at)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      const [fixer, reviewer, shipper] = await agents(window);
      const [zone] = await zones(window);
      await window.evaluate(
        async ({ zoneId, ids }) => {
          const { agents, flowEdges } = globalThis.window.agentBoard;
          for (const [index, id] of ids.entries()) await agents.move(id, { zoneId, x: 40 + index * 300, y: 40 });
          await flowEdges.create({ from: ids[0]!, to: ids[1]!, payload: 'handover', path: 'handover.md' });
          await flowEdges.create({ from: ids[1]!, to: ids[2]!, payload: 'handover', path: 'handover.md' });
        },
        { zoneId: zone!.id, ids: [fixer!.sessionId, reviewer!.sessionId, shipper!.sessionId] },
      );
      await closeAgent(window, fixer!.sessionId);
      await closeAgent(window, reviewer!.sessionId);
      await expect(window.locator('[data-testid="agent-tile"][data-folded]')).toHaveCount(2);
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`folded-chips${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('connections hidden: the hand-off and the arrow between two agents are not drawn, and each tile says how many it has', async () => {
  needsBaselines('connections-hidden');
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Fix checkout flake');
    await spawnAgent(window, 'monorepo', 'Review checkout fix');
    await expect(tile(window)).toHaveCount(2);
    for (const at of [0, 1]) await expect(tile(window).nth(at)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    const [fixer, reviewer] = await agents(window);
    const [zone] = await zones(window);
    await window.evaluate(
      async ({ zoneId, from, to }) => {
        const { agents, flowEdges, connectors } = globalThis.window.agentBoard;
        await agents.move(from, { zoneId, x: 40, y: 40 });
        await agents.move(to, { zoneId, x: 440, y: 40 });
        await flowEdges.create({ from, to });
        await connectors.create({ from: { type: 'agent', id: to, side: 'bottom' }, to: { type: 'agent', id: from, side: 'bottom' } });
      },
      { zoneId: zone!.id, from: fixer!.sessionId, to: reviewer!.sessionId },
    );
    await expect(window.locator('.react-flow__edge')).toHaveCount(2);
    // ⇧E: hand-offs only, then none.
    await window.keyboard.press('Shift+E');
    await window.keyboard.press('Shift+E');
    await expect(window.locator('.react-flow__edge')).toHaveCount(0);
    await expect(window.getByTestId('connections-count')).toHaveText(['↔ 2', '↔ 2']);
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    await pinRandomText(window);
    const restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot('connections-hidden.png', SHOT);
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an orchestrator expanded in place, its crew pushed aside in their frame, which its zone grows to hold', async () => {
  needsBaselines('expanded-crew');
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Lead two: Fix the flaky test');
    if (await sessionWindow(window).isVisible()) await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await expect(tile(window)).toHaveCount(3, { timeout: 2 * TURN_MS });
    for (const at of [0, 1, 2]) await expect(tile(window).nth(at)).not.toHaveAttribute('data-state', 'working', { timeout: 2 * TURN_MS });
    await expect(window.getByTestId('crew-frame')).toHaveCount(1);
    await tileAction(window.locator('[data-testid="agent-tile"][data-orchestrator]'), 'Expand in place');
    await expect(window.getByTestId('expanded-tile')).toHaveCount(1);
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    await pinRandomText(window);
    const restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot('expanded-crew.png', { ...SHOT, mask: [screen(window)] });
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an orchestrator arranges its crew: its implementer and reviewer a rail apart, the token and its label clear of both tiles', async () => {
  needsBaselines('arranged-crew-rail');
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Arrange a messy crew');
    if (await sessionWindow(window).isVisible()) await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    // Each CLI command starts the app's executable as Node: a turn's worth of time each.
    await expect(tile(window)).toHaveCount(3, { timeout: 4 * TURN_MS });
    await expect(window.getByTestId('agent-note')).toHaveCount(1, { timeout: 4 * TURN_MS });
    for (const at of [0, 1, 2]) await expect(tile(window).nth(at)).not.toHaveAttribute('data-state', 'working', { timeout: 2 * TURN_MS });
    const token = window.getByTestId('rail-token');
    await expect(token).toHaveCount(1);
    const named = (name: string) => tile(window).filter({ has: window.getByTitle(name, { exact: true }) });
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    // The token, and the line under it, lie between the implementer and its reviewer, touching neither.
    const [impl, review, chip, note] = await Promise.all([
      named('impl').boundingBox(),
      named('review').boundingBox(),
      token.locator('.rail-token-chip').boundingBox(),
      token.getByTestId('rail-token-note').boundingBox(),
    ]);
    for (const part of [chip!, note!]) {
      expect(part.x).toBeGreaterThan(impl!.x + impl!.width);
      expect(part.x + part.width).toBeLessThan(review!.x);
    }
    await pinRandomText(window);
    // The note's badge says when it was written.
    await window.evaluate(() => {
      for (const element of document.querySelectorAll("[data-testid='sticky'], [data-testid='agent-note']")) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) (walker.currentNode as Text).data = (walker.currentNode as Text).data.replace(/\d\d:\d\d/, '14:31');
      }
    });
    const restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot('arranged-crew-rail.png', SHOT);
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const { theme, scheme } of [{ theme: 'light', scheme: 'light' }, { theme: 'dark', scheme: 'dark' }, ...PACK_SHOTS] as const) {
  test(`the chat view in the ${theme} theme: Markdown replies, a folded run of tool calls and the message box`, async () => {
    const shot = theme === 'light' ? 'chat-markdown' : `${theme}-chat-markdown`;
    needsBaselines(shot);
    const { dir, repo, env } = scratch('markdown');
    const dataDir = tempDataDir();
    const { app, window } = await launch(
      dataDir,
      { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: theme, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
      RENDER_ARGS,
    );
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: scheme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Find the TODOs');
      await tile(window).dblclick();
      await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
      const chat = sessionWindow(window).getByTestId('chat-view');
      await expect(chat.getByTestId('chat-assistant').last()).toContainText('Found one TODO', { timeout: TURN_MS });
      const box = sessionWindow(window).getByRole('textbox', { name: 'Message to the agent' });
      await box.fill('Fix the TODO\nAdd a test');
      await box.press('Enter');
      await expect(chat.getByRole('heading', { name: 'The plan' })).toBeVisible({ timeout: TURN_MS });
      // A draft of two lines, so the box shows how it grows.
      await box.fill('Then open the pull request\nand link the issue');
      await pinRandomText(window);
      await ignorePointer(window);
      await settle(window);
      await expect.soft(sessionWindow(window)).toHaveScreenshot(`${shot}.png`, SHOT);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the dark theme (AN1): a review doc in its implementer's session window", async () => {
  needsBaselines('dark-review-viewer');
  const { dir, repo, env } = scratch('review');
  const dataDir = tempDataDir();
  const { app, window } = await launch(
    dataDir,
    { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: 'dark', SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
    RENDER_ARGS,
  );
  try {
    await window.setViewportSize(VIEWPORT);
    await window.emulateMedia({ colorScheme: 'dark' });
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark');
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Write the code');
    const coder = tile(window).filter({ hasText: 'Write the code' });
    await expect(coder).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    await tileAction(coder, 'Review its work');
    // The fake reviewer types its doc a word at a time.
    await expect(window.locator('[data-testid="agent-tile"][data-reviewer]')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
    await coder.getByTestId('tile-review').click();
    const viewer = sessionWindow(window).getByTestId('review-viewer');
    await expect(viewer.getByTestId('review-verdict')).toContainText('Changes requested');
    await pinRandomText(window);
    await ignorePointer(window);
    await settle(window);
    // A round's time is the clock's when it ran.
    await expect.soft(window.locator('body')).toHaveScreenshot('dark-review-viewer.png', { ...SHOT, mask: [viewer.locator('.review-round-when')] });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('first-run onboarding: each step, with nothing installed', async () => {
  const shots = ['onboarding-welcome', 'onboarding-connect', 'onboarding-tour', 'onboarding-finish'];
  needsBaselines(...shots);
  const { dir, env } = scratch('output');
  // A bare PATH with an empty bin dir first: none of the CLIs is found, the same on every machine.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const dataDir = tempDataDir();
  const { window } = await launch(
    dataDir,
    { ...env, ...RENDER_ENV, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, AGENT_BOARD_GH: join(bin, 'gh'), AGENT_BOARD_ONBOARDING: '1', SHELL: '/bin/sh' },
    RENDER_ARGS,
  );
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    const step = async (shot: string, ready: () => Promise<void>, next: () => Promise<void>) => {
      await ready();
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('body')).toHaveScreenshot(`${shot}.png`, SHOT);
      await restorePointer();
      await next();
    };
    await step('onboarding-welcome', () => expect(window.getByRole('dialog', { name: 'Welcome to agent-board' })).toBeVisible(), () =>
      window.getByRole('button', { name: 'Get started' }).click(),
    );
    await step(
      'onboarding-connect',
      async () => {
        await expect(window.getByTestId('connect-summary')).toContainText('0 of 6 ready');
        await expect(window.getByRole('img', { name: 'Checking' })).toHaveCount(0);
      },
      () => window.getByRole('button', { name: 'Continue' }).click(),
    );
    await step('onboarding-tour', () => expect(window.getByRole('dialog', { name: 'Your zones, agents and settings' })).toBeVisible(), () =>
      window.getByRole('button', { name: 'Skip tour' }).click(),
    );
    await step('onboarding-finish', () => expect(window.getByRole('dialog', { name: 'You’re set up' })).toBeVisible(), async () => {});
  } finally {
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Each theme the galleries are shot in: the light one under the original names, the dark one with `-dark`. */
const THEMES = [
  { theme: 'light', suffix: '' },
  { theme: 'dark', suffix: '-dark' },
] as const;

/** Launches on the gallery (`#gallery`) in `theme`. */
async function launchGallery(dataDir: string, theme: 'light' | 'dark') {
  const launched = await launch(dataDir, { ...RENDER_ENV, AGENT_BOARD_APPEARANCE: theme }, RENDER_ARGS);
  const { window } = launched;
  await window.setViewportSize(VIEWPORT);
  // Playwright pins the page to light; the setting has the window in its mode, as macOS would.
  await window.emulateMedia({ colorScheme: theme });
  await window.evaluate(() => {
    location.hash = '#gallery';
    location.reload();
  });
  await expect(window.locator('html')).toHaveAttribute('data-theme', theme);
  return launched;
}

for (const { theme, suffix } of THEMES) {
  test(`every agent state has its look: the tile and character galleries, ${theme}`, async () => {
    needsBaselines(`tile-states${suffix}`, `character-gallery${suffix}`);
    const dataDir = tempDataDir();
    const { app, window } = await launchGallery(dataDir, theme);
    try {
      await expect(window.getByTestId('character-gallery')).toBeVisible();
      await pinFonts(window);
      await ignorePointer(window);
      await settle(window);
      await expect.soft(window.getByTestId('tile-gallery')).toHaveScreenshot(`tile-states${suffix}.png`, SHOT);
      await expect.soft(window.getByTestId('character-gallery')).toHaveScreenshot(`character-gallery${suffix}.png`, SHOT);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}

/** The component gallery's sections (ui/ComponentGallery.tsx), each shot on its own so a change names its primitive. */
const GALLERY_SECTIONS = ['buttons', 'fields', 'overlays', 'labels', 'dialog', 'empty', 'window', 'chrome', 'shapes'];

for (const { theme, suffix } of THEMES) {
  test(`every primitive in every state: the component gallery, ${theme}`, async () => {
    needsBaselines(...GALLERY_SECTIONS.map((section) => `gallery-${section}${suffix}`));
    const dataDir = tempDataDir();
    const { app, window } = await launchGallery(dataDir, theme);
    try {
      await expect(window.getByTestId('component-gallery')).toBeVisible();
      // Not pinned: the app bundles its fonts, so these shots guard them too, and they render the same on any machine.
      const fontsLoaded = await window.evaluate(async () => {
        await document.fonts.ready;
        return ['13px "Bricolage Grotesque Variable"', '11.5px "JetBrains Mono Variable"'].every((font) => document.fonts.check(font));
      });
      expect(fontsLoaded, 'the bundled fonts loaded').toBe(true);
      await ignorePointer(window);
      await settle(window);
      for (const section of GALLERY_SECTIONS) {
        await expect.soft(window.getByTestId(`gallery-${section}`)).toHaveScreenshot(`gallery-${section}${suffix}.png`, SHOT);
      }
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}

for (const { theme, suffix } of THEMES) {
  test(`the text style bar with its font size control, ${theme}`, async () => {
    needsBaselines(`text-style-bar${suffix}`);
    const dataDir = tempDataDir();
    const { app, window } = await launch(
      dataDir,
      { ...RENDER_ENV, ...(theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {}), SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
      RENDER_ARGS,
    );
    try {
      await window.setViewportSize(VIEWPORT);
      if (theme === 'dark') await window.emulateMedia({ colorScheme: 'dark' });
      await pinFonts(window);
      await window.evaluate(async () => {
        await globalThis.window.agentBoard.items.create({
          kind: 'text',
          zoneId: null,
          x: 0,
          y: 0,
          width: 300,
          height: 60,
          data: { text: 'Launch week', size: 'h1', fontSize: 32, bold: true, italic: false, align: 'left', color: '#2b2a27', wrap: true },
        });
      });
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      await window.getByTestId('text-item').click();
      const bar = window.getByRole('toolbar', { name: 'Text style' });
      await expect(bar).toBeVisible();
      await pinRandomText(window);
      await ignorePointer(window);
      await settle(window);
      await expect.soft(bar).toHaveScreenshot(`text-style-bar${suffix}.png`, SHOT);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}

for (const { theme, suffix } of [
  { theme: 'light', suffix: '' },
  { theme: 'dark', suffix: '-dark' },
] as const) {
  test(`Ask Claude about a selection: the popover beside it, then the answer with a suggested edit as a ghost, ${theme}`, async () => {
    needsBaselines(`ask-claude-popover${suffix}`, `ask-claude-answer${suffix}`);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(
      dataDir,
      { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: theme, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
      RENDER_ARGS,
    );
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Checkout review');
      await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      const [architect] = await agents(window);
      const [zone] = await zones(window);
      await window.evaluate(
        async ({ zoneId, sessionId }) => {
          const board = globalThis.window.agentBoard;
          const shape = (kind: string, text: string, x: number, y: number) =>
            board.items.create({
              kind: 'shape',
              zoneId,
              x,
              y,
              width: 120,
              height: 70,
              data: { shape: kind, fill: null, stroke: '#2b2a27', strokeWidth: 2, dashed: false, text, textSize: 'body', bold: false, textColor: '#2b2a27' },
            });
          const gateway = await shape('rounded', 'API gateway', 30, 80);
          const orders = await shape('service', 'Orders service', 210, 80);
          const postgres = await shape('database', 'Postgres', 390, 70);
          for (const [from, to] of [
            [gateway, orders],
            [orders, postgres],
          ] as const) {
            await board.connectors.create({ from: { type: 'item', id: from.id, side: 'right' }, to: { type: 'item', id: to.id, side: 'left' } });
          }
          await board.agents.move(sessionId, { zoneId, x: 560, y: 330 });
          const answer = await board.items.create({
            kind: 'agent-note',
            zoneId,
            x: 560,
            y: 40,
            width: 272,
            height: 230,
            data: {
              text: '**1 risk, 1 gap**\n\n1. Orders writes Postgres, then the queue: one can fail. Use an *outbox*.\n2. Gap: who reads `order-events`?',
              agent: { sessionId, name: 'Checkout review', harness: 'claude', role: 'architect' },
              // A time of its own, in the render's UTC, so the shot doesn't change with the clock.
              writtenAt: '2026-10-15T14:02:00.000Z',
              editedByUser: false,
              asked: "What's risky here?",
              suggestions: [
                {
                  id: '1',
                  title: 'Outbox',
                  shapes: [{ key: 's1', shape: 'database', text: 'outbox', x: 0, y: 0, width: 90, height: 70 }],
                  arrows: [{ from: { object: { type: 'item', id: orders.id } }, to: { shape: 's1' }, label: '' }],
                },
              ],
            },
          });
          // Joined to the selection's rightmost object, as the daemon joins an answer (CM1).
          await board.connectors.create({ from: { type: 'item', id: postgres.id, side: 'right' }, to: { type: 'item', id: answer.id, side: 'left' } });
          // The ghost goes under the orders service, on the board.
          const placed = (await board.zones.list()).find((each) => each.id === zoneId)!;
          const [note] = (await board.items.list()).filter((item) => item.kind === 'agent-note');
          const data = note!.data as { suggestions: { shapes: { x: number; y: number }[] }[] };
          data.suggestions[0]!.shapes[0]!.x = placed.x + 225;
          data.suggestions[0]!.shapes[0]!.y = placed.y + 230;
          await board.items.update({ id: note!.id, data });
        },
        { zoneId: zone!.id, sessionId: architect!.sessionId },
      );
      await expect(window.getByTestId('suggestion-ghost')).toHaveCount(1);
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`ask-claude-answer${suffix}.png`, SHOT);
      await restorePointer();

      // The three shapes selected, and the popover open from the button beside their label (CM).
      const shapes = window.getByTestId('shape');
      await shapes.nth(0).click();
      await shapes.nth(1).click({ modifiers: ['Shift'] });
      await shapes.nth(2).click({ modifiers: ['Shift'] });
      await window.getByRole('button', { name: /Ask Claude…/ }).click();
      await expect(window.getByRole('dialog', { name: 'Ask Claude' })).toBeVisible();
      const restoreAgain = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`ask-claude-popover${suffix}.png`, SHOT);
      await restoreAgain();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`agent notes beside a sticky, tethered to their agent: the document card, then the terminal card, ${theme}`, async () => {
    needsBaselines(`agent-notes${suffix}`, `agent-notes-terminal${suffix}`);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(
      dataDir,
      { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: theme, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
      RENDER_ARGS,
    );
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Master Orchestrator');
      await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      const [lead] = await agents(window);
      const [zone] = await zones(window);
      await window.evaluate(
        async ({ zoneId, sessionId }) => {
          const board = globalThis.window.agentBoard;
          const agent = { sessionId, name: 'Master Orchestrator', harness: 'claude', role: 'orchestrator' };
          // A time of its own, in the render's UTC, so the shot doesn't change with the clock.
          const writtenAt = '2026-10-15T14:02:00.000Z';
          await board.agents.move(sessionId, { zoneId, x: 330, y: 330 });
          await board.items.create({ kind: 'sticky', zoneId, x: 30, y: 40, width: 200, height: 170, data: { text: 'ask reviewer to check the flaky retry test before merge!', color: '#fff3a3' } });
          await board.items.create({
            kind: 'agent-note',
            zoneId,
            x: 270,
            y: 40,
            width: 272,
            height: 200,
            data: { text: '**ENG-199 · round 2 of 3**\n\n- Implementer: fixing findings, `2 of 3` done\n- Reviewer: idle until `R2` arrives\n- Then the gate, and I merge **#185**', agent, about: sessionId, writtenAt, editedByUser: true },
          });
          await board.items.create({
            kind: 'agent-note',
            zoneId,
            x: 580,
            y: 40,
            width: 272,
            height: 200,
            data: { text: '**3 risks, 1 gap**\n\n1. Orders writes Postgres, then the queue: use an *outbox*.\n2. Cache tokens at the gateway.', agent, writtenAt, editedByUser: false, asked: "What's risky here?" },
          });
        },
        { zoneId: zone!.id, sessionId: lead!.sessionId },
      );
      await expect(window.getByTestId('agent-note')).toHaveCount(2);
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`agent-notes${suffix}.png`, SHOT);
      await restorePointer();

      // The terminal card, every note at once (CO1).
      const menu = window.getByRole('dialog', { name: 'Board menu' });
      await window.getByRole('button', { name: 'Board menu' }).dispatchEvent('click');
      await menu.getByRole('group', { name: 'Agent notes' }).getByRole('button', { name: 'Terminal' }).click();
      // Closed by a click on bare board, not Escape, whose focus back on the menu button would show its tooltip.
      await window.mouse.click(VIEWPORT.width - 120, VIEWPORT.height / 2);
      await expect(menu).toBeHidden();
      await expect(window.getByTestId('agent-note').first()).toHaveAttribute('data-look', 'terminal');
      const restoreAgain = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`agent-notes-terminal${suffix}.png`, SHOT);
      await restoreAgain();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
