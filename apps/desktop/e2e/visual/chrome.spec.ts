import { expect } from '@playwright/test';
import { createFakeGitHub, FAKE_GITHUB_STATE, type FakeGitHubPullRequest } from '@agent-board/tracker/testing';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { agents, launch, listFinishedTurns, LONG_MODEL, narrowBy, pickInChip, screen, sessionWindow, setClickOpens, spawnAgent, startBadgedAgent, startCrowdedAgent, tile, TURN_MS, windowKey, zoneNamed, useFullSidebar } from '../agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone, newShell } from '../launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, pinRandomText, settle } from '../render.ts';
import { scratch } from '../scratch.ts';
import { openSettings, settingsSection, showTileParts } from '../settings-helpers.ts';
import { SETTINGS_GROUPS } from '../../src/renderer/src/chrome/settings-ia.ts';
import { SHOT, needsBaselines, viewSettled } from './shared.ts';

test.use({ viewport: null });

test('the Workbench theme: the empty board, a busy board, its menu and inbox, a waiting tile, an expanded tile, and the session window', async () => {
  needsBaselines('empty-board', 'tile-waiting', 'board', 'board-menu', 'inbox', 'expanded-tile', 'session-window');
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  await listFinishedTurns(window);
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

    // The board menu, open: its zones, sessions and its Settings… row.
    await window.getByRole('button', { name: 'Board menu' }).click();
    await expect(window.getByRole('dialog', { name: 'Board menu' })).toBeVisible();
    await pinRandomText(window);
    restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('body')).toHaveScreenshot('board-menu.png', SHOT);
    await restorePointer();
    await window.keyboard.press('Escape');
    await expect(window.getByRole('dialog', { name: 'Board menu' })).toBeHidden();

    // The inbox, open from the Needs-you pill.
    await window.getByTestId('inbox-count').click();
    await expect(window.getByTestId('needs-you-inbox')).toBeVisible();
    restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('body')).toHaveScreenshot('inbox.png', SHOT);
    await restorePointer();
    await window.keyboard.press('Escape');
    // Gone before the board menu is opened again, or the inbox, still leaving, covers the button.
    await expect(window.getByTestId('needs-you-inbox')).toBeHidden();

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
    await expandedTile.getByRole('button', { name: 'Collapse', exact: true }).click();
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
  await listFinishedTurns(window);
  try {
    await showTileParts(window, ['chips']);
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
  await listFinishedTurns(window);
  try {
    await showTileParts(window, ['chips']);
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await startBadgedAgent(window);
    // Its state is in the shot: a turn still under way draws "thinking", one that has finished "waiting".
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
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

test('a finished agent says it finished, with what it is for under its name', async () => {
  needsBaselines('tile-finished-status');
  const { dir, repo, env } = scratch('board');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  await listFinishedTurns(window);
  try {
    await useFullSidebar(window);
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Look around');
    // Its turn over (its CLI calls take a turn's worth of time) it waits, its tile saying what it last said. Stopped, it
    // says it finished.
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    await tile(window).getByRole('button', { name: 'Expand' }).click();
    const expanded = window.getByTestId('expanded-tile');
    await expanded.getByRole('navigation', { name: 'Session controls' }).getByRole('button', { name: 'Stop' }).click();
    await expanded.getByRole('button', { name: 'Collapse', exact: true }).click();
    // What it is for stays under its name; its line says it finished.
    await expect(tile(window).getByTestId('tile-about')).toHaveText('Look around');
    await expect(tile(window).getByTestId('tile-description')).toHaveText('Finished');
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
  await listFinishedTurns(window);
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
  await listFinishedTurns(window);
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
  await listFinishedTurns(window);
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

/**
 * Zones in four colours with every fill opacity from none to the most, a zone's menu with its 16 colours and slider
 *, and the ▾ beside its Tidy: Tidy now and its spacing.
 */
for (const { theme, suffix } of [
  { theme: 'light', suffix: '' },
  { theme: 'dark', suffix: '-dark' },
] as const) {
  test(`zone colours and fill opacity: four zones and the zone menu, ${theme}`, async () => {
    needsBaselines(`zone-looks${suffix}`, `zone-menu${suffix}`, `zone-spacing-menu${suffix}`);
    const { dir, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
    await listFinishedTurns(window);
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
      await window.keyboard.press('Escape');
      await expect(window.getByRole('menu')).toBeHidden();

      // A zone wide enough for Tidy and its ▾ to stay on its tab.
      await window.evaluate(() => globalThis.window.agentBoard.zones.addUnbound({ name: 'Spacing', x: 0, y: 460, width: 720, height: 200 }));
      const spacious = zoneNamed(window, 'Spacing');
      await spacious.getByRole('button', { name: 'Tidy and spacing' }).click();
      await expect(window.getByRole('menuitemradio', { name: /Roomy/ })).toHaveAttribute('aria-checked', 'true');
      await expect(window.getByRole('menuitem', { name: /Roomy · Settings/ })).toBeVisible();
      restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('body')).toHaveScreenshot(`zone-spacing-menu${suffix}.png`, SHOT);
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
    await listFinishedTurns(window);
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
      const switcher = window.getByRole('dialog', { name: 'Jump to a session, zone or setting' });
      await expect(switcher.getByTestId('spotlight-row')).toHaveCount(3);
      await pinRandomText(window);
      let restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('body')).toHaveScreenshot(`spotlight-empty${suffix}.png`, SHOT);
      await restorePointer();

      // The agent, and under it the settings its letters find too: Tidying, and Arrange spacing in it.
      await window.keyboard.type('tid');
      await expect(switcher.getByTestId('spotlight-row')).toHaveCount(3);
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

/** Settings › General › Appearance's Mode switch and Theme control, and the Theme popover open over the Settings window. */
for (const { theme, suffix } of [
  { theme: 'light', suffix: '' },
  { theme: 'dark', suffix: '-dark' },
] as const) {
  test(`the Theme control and its popover, ${theme}`, async () => {
    needsBaselines(`theme-control${suffix}`, `theme-popover${suffix}`);
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window } = await launch(dataDir, { ...RENDER_ENV, ...appearance }, RENDER_ARGS);
    await listFinishedTurns(window);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      const settings = await openSettings(window, 'general.appearance');
      await settings.emulateMedia({ colorScheme: theme });
      await expect.poll(() => settings.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(settings);
      const mode = settings.getByRole('group', { name: 'Mode' });
      const control = settings.getByRole('button', { name: 'Theme: Agent Board' });
      await expect(mode.getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light' })).toHaveAttribute('aria-pressed', 'true');
      let restorePointer = await ignorePointer(settings);
      await settle(settings);
      // The fieldsets, the outer of each name (the Mode switch inside its fieldset is a group named Mode too).
      const top = (await mode.first().boundingBox())!;
      const bottom = (await settings.getByRole('group', { name: 'Theme' }).first().boundingBox())!;
      const clip = { x: top.x - 8, y: top.y - 8, width: Math.max(top.width, bottom.width) + 16, height: bottom.y + bottom.height - top.y + 16 };
      await expect.soft(settings).toHaveScreenshot(`theme-control${suffix}.png`, { ...SHOT, clip });
      await restorePointer();

      await control.click();
      const popover = settings.getByRole('dialog', { name: 'Themes' });
      await expect(popover.getByRole('option', { name: 'Agent Board' })).toHaveAttribute('aria-selected', 'true');
      restorePointer = await ignorePointer(settings);
      await settle(settings);
      await expect.soft(popover).toHaveScreenshot(`theme-popover${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close().catch(() => {});
      await removeDataDir(dataDir);
    }
  });
}

for (const { theme, suffix } of [
  { theme: 'light', suffix: '' },
  { theme: 'dark', suffix: '-dark' },
] as const) {
  test(`the keyboard cheat sheet over the board, opened with ? on a selected tile, ${theme}`, async () => {
    needsBaselines(`cheat-sheet${suffix}`);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
    await listFinishedTurns(window);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Pick a database');
      await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });

      await tile(window).click({ position: { x: 40, y: 70 } });
      await window.keyboard.press('?');
      await expect(window.getByRole('dialog', { name: 'Keyboard' })).toBeVisible();
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('body')).toHaveScreenshot(`cheat-sheet${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close().catch(() => {});
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/** The board menu with more zones than fit a short window: it stays inside the window, scrolls, and its Settings… row can be reached. */
test('the board menu with a dozen zones in a short window stays inside it and scrolls to its Settings… row', async () => {
  needsBaselines('board-menu-overflow');
  const { dir, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  await listFinishedTurns(window);
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

    // The Settings… row scrolls into view and is clickable.
    const row = menu.getByRole('button', { name: /^Settings…/ });
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeInViewport();
    await row.click({ trial: true });
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the compact window setting: Off by default, then a custom window with its field', async () => {
  needsBaselines('settings-compact-window', 'settings-compact-window-custom');
  const { dir, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  await listFinishedTurns(window);
  try {
    const settings = await openSettings(window, 'agents.context');
    await pinFonts(settings);
    const menu = settingsSection(settings, 'Context');
    const select = menu.getByLabel("Compact agents' context at");
    await expect(select).toHaveValue('0');
    await select.selectOption('custom');
    const custom = menu.getByLabel('Custom window, in tokens');
    await custom.fill('300000');
    await custom.press('Enter');
    await expect.poll(() => window.evaluate(() => globalThis.window.agentBoard.flowEdges.settings().then((settings) => settings.compactWindow))).toBe(300_000);
    // The range comes from one place: a window outside it is refused and the field goes back.
    await custom.fill('50000');
    await custom.press('Enter');
    await expect(custom).toHaveValue('300000');
    await select.scrollIntoViewIfNeeded();
    const restorePointer = await ignorePointer(settings);
    await settle(settings);
    await expect.soft(menu.locator('.ui-field', { hasText: "Compact agents' context at" })).toHaveScreenshot('settings-compact-window.png', SHOT);
    await expect.soft(menu.locator('.ui-field', { hasText: 'Custom window, in tokens' })).toHaveScreenshot('settings-compact-window-custom.png', SHOT);
    await restorePointer();
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The Settings window on each of its seven groups' pages, and searching, light and dark. */
for (const { theme, suffix } of [
  { theme: 'light', suffix: '' },
  { theme: 'dark', suffix: '-dark' },
] as const) {
  test(`the Settings window on each group, ${theme}`, async () => {
    const shots = [...SETTINGS_GROUPS.map((group) => `settings-window-${group.id}${suffix}`), `settings-window-search${suffix}`];
    needsBaselines(...shots);
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window } = await launch(dataDir, { ...RENDER_ENV, ...appearance }, RENDER_ARGS);
    try {
      const settings = await openSettings(window);
      await settings.emulateMedia({ colorScheme: theme });
      await expect.poll(() => settings.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(settings);
      for (const group of SETTINGS_GROUPS) {
        await openSettings(window, group.id);
        await pinRandomText(settings);
        const restorePointer = await ignorePointer(settings);
        await settle(settings);
        await expect.soft(settings.locator('body')).toHaveScreenshot(`settings-window-${group.id}${suffix}.png`, SHOT);
        await restorePointer();
      }

      // Searching: the sidebar filtered to what holds "path", the page those sections with the matches highlighted.
      await settings.getByRole('searchbox', { name: 'Search settings' }).fill('path');
      await expect(settings.getByRole('main', { name: 'Search' })).toBeVisible();
      await pinRandomText(settings);
      const restorePointer = await ignorePointer(settings);
      await settle(settings);
      await expect.soft(settings.locator('body')).toHaveScreenshot(`settings-window-search${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close().catch(() => {});
      await removeDataDir(dataDir);
    }
  });
}

/** Settings › Board › Agent tiles: its switches, two of them on, light and dark. */
for (const { theme, suffix } of [
  { theme: 'light', suffix: '' },
  { theme: 'dark', suffix: '-dark' },
] as const) {
  test(`the Agent tiles section with two parts turned back on, ${theme}`, async () => {
    needsBaselines(`settings-agent-tiles${suffix}`);
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window } = await launch(dataDir, { ...RENDER_ENV, ...appearance }, RENDER_ARGS);
    try {
      const settings = await openSettings(window, 'board.tiles');
      await settings.emulateMedia({ colorScheme: theme });
      await expect.poll(() => settings.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(settings);
      const section = settingsSection(settings, 'Agent tiles');
      for (const name of ['Expand, Pop out and ⋯, without hovering', 'Who set its status line']) {
        const toggle = section.getByRole('switch', { name });
        await toggle.click();
        await expect(toggle).toBeChecked();
      }
      const box = section.locator('.settings-box');
      await box.scrollIntoViewIfNeeded();
      const restorePointer = await ignorePointer(settings);
      await settle(settings);
      await expect.soft(box).toHaveScreenshot(`settings-agent-tiles${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close().catch(() => {});
      await removeDataDir(dataDir);
    }
  });
}
