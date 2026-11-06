import { expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launch, listFinishedTurns, screen, sessionWindow, spawnAgent, tile, TURN_MS, windowKey, zoneControl } from '../agent-helpers.ts';
import { test, openAddZone, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from '../launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, pinRandomText, settle } from '../render.ts';
import { scratch } from '../scratch.ts';
import { drag } from '../board-helpers.ts';
import { SHOT, needsBaselines, viewSettled, nodesStill, pinChatTimes, THEMES, shootSimplifiedNotes } from './shared.ts';

test.use({ viewport: null });

/**
 * A shape's style bar where the theme paints some slots alike: Latte folds Blue into Accent, Dracula folds more, each
 * folded swatch with its dashed ring.
 */
for (const { theme, scheme } of [
  { theme: 'catppuccin-latte', scheme: 'light' },
  { theme: 'dracula', scheme: 'dark' },
] as const) {
  test(`the shape style bar shows each distinct colour once, ${theme}`, async () => {
    needsBaselines(`shape-bar-${theme}`);
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...RENDER_ENV, AGENT_BOARD_APPEARANCE: theme }, RENDER_ARGS);
    await listFinishedTurns(window);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: scheme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      const pane = (await window.locator('.react-flow__pane').boundingBox())!;
      await window.mouse.click(pane.x + pane.width - 20, pane.y + pane.height / 2);
      await window.keyboard.press('s');
      await drag(window, { x: pane.x + 300, y: pane.y + 400 }, { x: pane.x + 500, y: pane.y + 510 });
      await window.getByTestId('shape').click();
      const bar = window.getByRole('toolbar', { name: 'Shape style' });
      await expect(bar).toBeVisible();
      await ignorePointer(window);
      await settle(window);
      await expect.soft(bar).toHaveScreenshot(`shape-bar-${theme}.png`, SHOT);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}

// The Delete question in the Simplified design: an alertdialog over a board with a sticky and a live shell selected, shot with the scrim around it.
for (const { theme, suffix } of THEMES) {
  test(`the Delete selection question in the Simplified design, ${theme}`, async () => {
    needsBaselines(`simplified-delete-confirm${suffix}`);
    const { dir, repo, env } = scratch('output');
    const dataDir = tempDataDir();
    const { app, window } = await launch(
      dataDir,
      { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: theme, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
      RENDER_ARGS,
      { design: 'simplified' },
    );
    await listFinishedTurns(window);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await zoneControl(window, 'monorepo', 'New shell in zone', 'New terminal');
      await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
      await window.evaluate(async () => {
        await globalThis.window.agentBoard.items.create({ kind: 'sticky', zoneId: null, x: 700, y: 420, width: 160, height: 160, data: { text: 'note', color: '#fff3a3' } });
      });
      await window.getByTestId('sticky').click({ position: { x: 12, y: 12 } });
      await window.getByTestId('shell-tile').click({ modifiers: ['Shift'] });
      await window.keyboard.press('Backspace');
      const confirm = window.getByRole('alertdialog', { name: 'Delete selection?' });
      await expect(confirm).toBeVisible();
      await pinFonts(window);
      await pinRandomText(window);
      await ignorePointer(window);
      await settle(window);
      // The whole window, so the scrim over the board is in the shot. The calm shell tile's panes line is technical, so it isn't drawn here.
      await expect.soft(window.locator('body')).toHaveScreenshot(`simplified-delete-confirm${suffix}.png`, SHOT);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const { theme, suffix } of THEMES) {
  const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
  test(`the Simplified empty board: three starter cards, ${theme}`, async () => {
    needsBaselines(`simplified-empty-board${suffix}`);
    const { dir, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, { design: 'simplified' });
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`simplified-empty-board${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`the Simplified first run: the Captain's welcome, then getting Claude ready with nothing installed, ${theme}`, async () => {
    const shots = [`simplified-onboarding-welcome${suffix}`, `simplified-onboarding-connect${suffix}`];
    needsBaselines(...shots);
    const { dir, env } = scratch('output');
    // A bare PATH with an empty bin dir first: Claude Code isn't found, the same on every machine.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const dataDir = tempDataDir();
    const { app, window } = await launch(
      dataDir,
      { ...env, ...RENDER_ENV, ...appearance, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, AGENT_BOARD_ONBOARDING: '1', SHELL: '/bin/sh' },
      RENDER_ARGS,
      { design: 'simplified' },
    );
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      const shoot = async (shot: string) => {
        const restorePointer = await ignorePointer(window);
        await settle(window);
        await expect.soft(window.locator('body')).toHaveScreenshot(`${shot}.png`, SHOT);
        await restorePointer();
      };
      const welcome = window.getByRole('dialog', { name: 'Ahoy! I’m the Captain.' });
      await expect(welcome).toBeVisible();
      await shoot(shots[0]!);
      await welcome.getByRole('button', { name: 'Get started' }).click();
      await expect(window.getByRole('listitem', { name: 'Claude Code' }).getByRole('img', { name: 'To do' })).toBeVisible();
      await shoot(shots[1]!);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`the Simplified board: today's islands with fewer buttons, two agents waiting, ${theme}`, async () => {
    needsBaselines(`simplified-board${suffix}`);
    await shootSimplifiedBoard(theme, theme, appearance, `simplified-board${suffix}`);
  });
}

// The Simplified usage island, before Needs you in the top-right island, and the popover of bars a click opens. The
// refill times and the reading's age move with the clock, so they are masked.
for (const { theme, suffix } of THEMES) {
  const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
  test(`the Simplified usage island and its popover, ${theme}`, async () => {
    needsBaselines(`simplified-usage-island${suffix}`, `simplified-usage-popover${suffix}`);
    const { dir, repo, env } = scratch('waiting');
    const now = Math.round(Date.now() / 1000);
    const rateLimits = { five_hour: { used_percentage: 86, resets_at: now + 3600 }, seven_day: { used_percentage: 41, resets_at: now + 3 * 86_400 } };
    const dataDir = tempDataDir();
    const { app, window } = await launch(
      dataDir,
      { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0', FAKE_HARNESS_RATE_LIMITS: JSON.stringify(rateLimits) },
      RENDER_ARGS,
      { design: 'simplified' },
    );
    await listFinishedTurns(window);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Pick a database');
      await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      await window.evaluate(() => globalThis.window.agentBoard.view.set('usageOnBoard', true));
      // A window reads the setting again when it comes to the front.
      await window.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
      const island = window.locator('.island-top-right');
      await expect(window.getByTestId('usage-island')).toHaveText('5h 86% · wk 41%');
      await pinFonts(window);
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(island).toHaveScreenshot(`simplified-usage-island${suffix}.png`, SHOT);
      await restorePointer();

      await window.getByTestId('usage-island').click();
      const popover = window.getByTestId('usage-popover');
      await expect(popover).toBeVisible();
      // The refill times are masked, but a mask is as wide as its text ("in 59m", "in 1h 0m"), which moves with the
      // seconds the run took: give each one a fixed box first.
      await popover.locator('.usage-allowance-refills').evaluateAll((refills) => {
        for (const refill of refills as HTMLElement[]) Object.assign(refill.style, { display: 'inline-block', width: '120px', overflow: 'hidden' });
      });
      await settle(window);
      await expect.soft(popover).toHaveScreenshot(`simplified-usage-popover${suffix}.png`, { ...SHOT, mask: [popover.locator('.usage-allowance-refills'), popover.locator('.usage-allowance-fresh')] });
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// The Simplified design's tabs: light and worded. An agent's window with its Chat tab and a shell tab, then split in two.
for (const { theme, suffix } of THEMES) {
  const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
  test(`a session window's tabs, drawn light and worded in the Simplified design, one strip and split, ${theme}`, async () => {
    needsBaselines(`simplified-tabs${suffix}`, `simplified-tabs-split${suffix}`);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, { design: 'simplified' });
    await listFinishedTurns(window);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Pick a database');
      await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      await tile(window).dblclick();
      const open = sessionWindow(window);
      await expect(open.getByTestId('chat-live')).toHaveAttribute('data-live', 'done');
      // A shell tab beside the chat: ⌘T goes to the terminal's pane, so the terminal is shown first.
      await open.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Terminal' }).click();
      await expect(screen(window)).toContainText('Which database should I use');
      await window.keyboard.press(windowKey('t'));
      await expect(open.getByTestId('session-tab')).toHaveCount(2);
      await open.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat', exact: true }).click();
      await open.getByRole('tab', { name: 'Chat' }).click();
      await expect(open.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
      await expect(open.getByTestId('chat-view')).toBeVisible();
      const masks = [open.locator('.xterm-rows'), open.locator('.session-window-where')];
      await pinRandomText(window);
      await pinChatTimes(window);
      let restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(open).toHaveScreenshot(`simplified-tabs${suffix}.png`, { ...SHOT, mask: masks });
      await restorePointer();
      await window.keyboard.press(windowKey('d'));
      await expect(open.getByTestId('window-pane')).toHaveCount(2);
      await pinRandomText(window);
      restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(open).toHaveScreenshot(`simplified-tabs-split${suffix}.png`, { ...SHOT, mask: masks });
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// New agent and Add zone in the Simplified design: the same dialog and popover as Classic's, in its sheet style. New agent
// shows only the assistant, the task and a name until Show technical details adds the model and role.
for (const { theme, suffix } of THEMES) {
  const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
  test(`New agent and Add zone as Simplified sheets, ${theme}`, async () => {
    needsBaselines(`simplified-new-agent${suffix}`, `simplified-add-zone${suffix}`);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, { design: 'simplified' });
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await zoneControl(window, 'monorepo', 'New agent', 'New agent');
      const form = window.getByRole('dialog', { name: 'New agent' });
      await expect(form).toBeVisible();
      await pinRandomText(window);
      let restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(form).toHaveScreenshot(`simplified-new-agent${suffix}.png`, SHOT);
      await restorePointer();
      await form.getByRole('button', { name: 'Cancel' }).click();
      await expect(form).toBeHidden();

      const popover = await openAddZone(window, 'Group');
      await expect(popover).toBeVisible();
      // The GitHub tab's repo count arrives after the popover opens, later on a busy machine: shot only once it is there.
      await expect(popover.getByRole('tab', { name: /^GitHub\s*\d/ })).toBeVisible();
      restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(popover).toHaveScreenshot(`simplified-add-zone${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// An agent's window in the Simplified design: one header, with its zone, name and status, the Chat | Timeline | Terminal
// switch, the details toggle, ⋯ and Done, over its chat (the view it opens on) and then its terminal.
for (const { theme, suffix } of THEMES) {
  const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
  test(`an agent's window as the Simplified design draws it, on its chat and on its terminal, ${theme}`, async () => {
    needsBaselines(`simplified-session-window${suffix}`, `simplified-session-window-terminal${suffix}`, `simplified-session-window-hover${suffix}`);
    await shootSimplifiedSessionWindow(theme, appearance, `simplified-session-window${suffix}`, `simplified-session-window-terminal${suffix}`);
  });
}

/** The Simplified board with two agents waiting, in `theme` (of `scheme`'s mode, picked by `appearance`), shot as `shot`. */
async function shootSimplifiedBoard(theme: string, scheme: 'light' | 'dark', appearance: Record<string, string>, shot: string) {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, { design: 'simplified' });
  await listFinishedTurns(window);
  try {
    await window.setViewportSize(VIEWPORT);
    await window.emulateMedia({ colorScheme: scheme });
    await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
    await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    await spawnAgent(window, 'monorepo', 'Tidy the tokens');
    await expect(tile(window)).toHaveCount(2);
    await expect(tile(window).nth(1)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    // Named by what it shows: its word and its count.
    await expect(window.getByTestId('inbox-count')).toHaveAccessibleName('Needs you 2');
    await expect(window.getByTestId('inbox-count').locator('.needs-you-count')).toHaveText('2');
    await pinFonts(window);
    await pinRandomText(window);
    const restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot(`${shot}.png`, SHOT);
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An agent's window in the Simplified design, in a theme of `scheme`'s mode (picked by `appearance`), shot on its chat as `chatShot` and its terminal as `terminalShot`. */
async function shootSimplifiedSessionWindow(scheme: 'light' | 'dark', appearance: Record<string, string>, chatShot: string, terminalShot: string) {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, { design: 'simplified' });
  await listFinishedTurns(window);
  try {
    await window.setViewportSize(VIEWPORT);
    await window.emulateMedia({ colorScheme: scheme });
    await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    await tile(window).dblclick();
    const chat = sessionWindow(window).getByTestId('chat-view');
    await expect(chat.getByTestId('chat-assistant')).toHaveText(['Which database should I use, Postgres or SQLite?']);
    await expect(sessionWindow(window).getByTestId('chat-live')).toHaveAttribute('data-live', 'done');
    await pinRandomText(window);
    await pinChatTimes(window);
    let restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('body')).toHaveScreenshot(`${chatShot}.png`, SHOT);
    await restorePointer();

    // The pointer over the header shows its controls.
    const head = sessionWindow(window).locator('.session-window-head');
    await head.locator('.session-window-name').hover({ position: { x: 20, y: 5 } });
    await expect(head.getByTestId('session-window-controls')).toHaveCSS('opacity', '1');
    await settle(window);
    await expect.soft(window.locator('body')).toHaveScreenshot(`${chatShot.replace('simplified-session-window', 'simplified-session-window-hover')}.png`, SHOT);
    await window.mouse.move(2, 2);

    await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Terminal' }).click();
    await expect(screen(window)).toContainText('Which database should I use');
    await pinRandomText(window);
    restorePointer = await ignorePointer(window);
    await settle(window);
    // The terminal's text and cursor are masked, not its background.
    await expect.soft(window.locator('body')).toHaveScreenshot(`${terminalShot}.png`, { ...SHOT, mask: [screen(window)] });
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Theme packs the Simplified design is shot over: two families, each in its light and dark theme. */
const SIMPLIFIED_PACKS = [
  { theme: 'catppuccin-latte', scheme: 'light' },
  { theme: 'catppuccin-mocha', scheme: 'dark' },
  { theme: 'gruvbox-light', scheme: 'light' },
  { theme: 'gruvbox-dark', scheme: 'dark' },
] as const;

// Rosé Pine Dawn's desk is nearly its note's colour at the app's usual paper fill, so its notes take a deeper one.
test('agent notes in the Simplified design over a theme pack whose desk is close to the paper fill, rose-pine-dawn', async () => {
  needsBaselines('simplified-agent-notes-rose-pine-dawn');
  await shootSimplifiedNotes('rose-pine-dawn', 'light', 'simplified-agent-notes-rose-pine-dawn');
});

// The Simplified design over a theme pack: its shapes, type and shadows in the pack's colours.
for (const { theme, scheme } of SIMPLIFIED_PACKS) {
  const appearance = { AGENT_BOARD_APPEARANCE: theme };
  test(`the Simplified board over a theme pack, ${theme}`, async () => {
    needsBaselines(`simplified-board-${theme}`);
    await shootSimplifiedBoard(theme, scheme, appearance, `simplified-board-${theme}`);
  });

  test(`agent notes in the Simplified design over a theme pack, ${theme}`, async () => {
    needsBaselines(`simplified-agent-notes-${theme}`);
    await shootSimplifiedNotes(theme, scheme, `simplified-agent-notes-${theme}`);
  });

  test(`coloured projects in the Simplified design over a theme pack, ${theme}`, async () => {
    needsBaselines(`simplified-zone-${theme}`);
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...RENDER_ENV, ...appearance }, RENDER_ARGS, { design: 'simplified' });
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: scheme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await window.evaluate(async () => {
        const { zones } = globalThis.window.agentBoard;
        const blue = await zones.addUnbound({ name: 'Billing', x: 0, y: 0, width: 520, height: 300 });
        await zones.setLook(blue.id, { color: '#4c6ef5', fillOpacity: null });
        const green = await zones.addUnbound({ name: 'Docs', x: 560, y: 0, width: 520, height: 300 });
        await zones.setLook(green.id, { color: '#2f9e44', fillOpacity: null });
      });
      await expect(window.getByTestId('zone')).toHaveCount(2);
      await window.locator('.react-flow__pane').click({ position: { x: 8, y: 700 } });
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      await nodesStill(window);
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`simplified-zone-${theme}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });

  test(`an agent's window as the Simplified design draws it over a theme pack, ${theme}`, async () => {
    needsBaselines(`simplified-session-window-${theme}`, `simplified-session-window-terminal-${theme}`, `simplified-session-window-hover-${theme}`);
    await shootSimplifiedSessionWindow(scheme, appearance, `simplified-session-window-${theme}`, `simplified-session-window-terminal-${theme}`);
  });
}
