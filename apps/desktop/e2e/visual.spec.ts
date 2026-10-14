import { expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { agents, launch, screen, sessionWindow, setClickOpens, spawnAgent, tile, tileAction, TURN_MS, zones } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
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
    await pinRandomText(window);
    let restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot('dark-board.png', SHOT);
    await restorePointer();

    // The Edge rules panel, on the edge.
    await window.getByTestId('flow-edge').locator('.flow-edge-pill').click({ force: true });
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

for (const theme of ['light', 'dark'] as const) {
  test(`the chat view in the ${theme} theme: Markdown replies, a folded run of tool calls and the message box`, async () => {
    const shot = theme === 'dark' ? 'dark-chat-markdown' : 'chat-markdown';
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
      await window.emulateMedia({ colorScheme: theme });
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
const GALLERY_SECTIONS = ['buttons', 'fields', 'overlays', 'labels', 'dialog', 'empty', 'window', 'chrome'];

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
