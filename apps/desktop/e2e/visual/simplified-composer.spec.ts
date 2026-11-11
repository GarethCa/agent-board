import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, listFinishedTurns, sessionWindow, spawnAgent, tile, TURN_MS, unfoldMenuSection, windowKey } from '../agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone, type LaunchOptions } from '../launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, pinRandomText, settle } from '../render.ts';
import { scratch } from '../scratch.ts';
import { openSettings, settingsSection } from '../settings-helpers.ts';
import { SHOT, needsBaselines, pinChatTimes, THEMES } from './shared.ts';

test.use({ viewport: null });

// The composer in the Simplified design, at the foot of an agent's window: the empty field that invites a reply (the
// "+" at its start, a round send button off), the "+" menu open, and a draft with the send button lit.
for (const { theme, suffix } of THEMES) {
  const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
  test(`the composer as the Simplified design draws it: empty, its + menu open and with a draft, ${theme}`, async () => {
    needsBaselines(`simplified-composer-empty${suffix}`, `simplified-composer-menu${suffix}`, `simplified-composer-draft${suffix}`);
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
      await expect(sessionWindow(window).getByTestId('chat-live')).toHaveAttribute('data-live', 'done');
      const composer = sessionWindow(window).locator('.composer');
      await pinRandomText(window);
      await pinChatTimes(window);
      let restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(composer).toHaveScreenshot(`simplified-composer-empty${suffix}.png`, SHOT);
      await restorePointer();

      await composer.getByTestId('composer-plus').click();
      await expect(window.getByRole('menuitem')).toHaveCount(3);
      restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('body')).toHaveScreenshot(`simplified-composer-menu${suffix}.png`, SHOT);
      await restorePointer();
      await window.keyboard.press('Escape');
      // The menu hands its focus back to the + as it closes; typing before that lands the focus ring on the + in the draft's shot.
      await expect(window.getByRole('menuitem')).toHaveCount(0);
      await expect(composer.getByTestId('composer-plus')).toBeFocused();

      await composer.getByLabel('Message to the agent').fill('Postgres, please');
      await expect(composer.getByLabel('Message to the agent')).toBeFocused();
      restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(composer).toHaveScreenshot(`simplified-composer-draft${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// The composer's other looks in the Simplified design: a draft of several lines (the field grows, its corners stay), an
// agent paused (sending wakes it) and one that has ended (the field is off and says why).
for (const { theme, suffix } of THEMES) {
  const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
  test(`the composer as the Simplified design draws it: a long draft, a paused agent and an ended one, ${theme}`, async () => {
    needsBaselines(`simplified-composer-long-draft${suffix}`, `simplified-composer-paused${suffix}`, `simplified-composer-ended${suffix}`);
    const { dir, repo, env } = scratch('output');
    const dataDir = tempDataDir();
    // No idle_prompt, which would move an idle agent on to waiting.
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, FAKE_HARNESS_IDLE_NOTIFY_MS: '600000', SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, { design: 'simplified' });
    await listFinishedTurns(window);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Run the tests');
      await expect(tile(window)).toHaveAttribute('data-state', 'idle', { timeout: TURN_MS });
      await tile(window).dblclick();
      await expect(sessionWindow(window).getByTestId('chat-live')).toHaveAttribute('data-live', 'done');
      const composer = sessionWindow(window).locator('.composer');
      const more = sessionWindow(window).locator('.session-window-head').getByRole('button', { name: 'More' });
      const shoot = async (name: string) => {
        await pinRandomText(window);
        await pinChatTimes(window);
        const restorePointer = await ignorePointer(window);
        await settle(window);
        await expect.soft(composer).toHaveScreenshot(`${name}${suffix}.png`, SHOT);
        await restorePointer();
      };

      await composer.getByLabel('Message to the agent').fill('First, run the unit tests.\nThen the e2e specs for the composer.\nThen tell me what failed,\nwith the first error of each.\nKeep it short.');
      await shoot('simplified-composer-long-draft');
      await composer.getByLabel('Message to the agent').fill('');

      await more.click();
      await window.getByRole('menuitem', { name: /^Pause/ }).click();
      await expect(tile(window)).toHaveAttribute('data-state', 'hibernated');
      await expect(composer.getByLabel('Message to the agent')).toHaveAttribute('placeholder', 'Paused: sending wakes it');
      await shoot('simplified-composer-paused');

      await sessionWindow(window).locator('.session-window-head').getByRole('button', { name: 'Wake' }).click();
      await expect(tile(window)).toHaveAttribute('data-state', 'idle');
      await more.click();
      await window.getByRole('menuitem', { name: /^End agent…/ }).click();
      await window.getByRole('alertdialog', { name: /^End / }).getByRole('button', { name: 'End agent' }).click();
      await expect(tile(window)).toHaveAttribute('data-state', 'done');
      await expect(composer.getByLabel('Message to the agent')).toBeDisabled();
      await shoot('simplified-composer-ended');
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// A question and a plan an agent waits on, above its composer in the Simplified design: numbered choices with Decide
// later, and the plan's comments with Reject leading and Approve trailing.
for (const { theme, suffix } of THEMES) {
  const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
  for (const { kind, prompt } of [
    { kind: 'question', prompt: 'Ask: Who is the guide for? | New developers | The product team' },
    { kind: 'plan', prompt: 'Plan: Zone id migration' },
  ]) {
    test(`a ${kind} in the pane as the Simplified design draws it, ${theme}`, async () => {
      needsBaselines(`simplified-pane-${kind}${suffix}`);
      const { dir, repo, env } = scratch('ask-plan');
      const dataDir = tempDataDir();
      const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, { design: 'simplified' });
      try {
        await window.setViewportSize(VIEWPORT);
        await window.emulateMedia({ colorScheme: theme });
        await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
        await pinFonts(window);
        await pickFolderNext(app, repo);
        await browseForZone(window);
        await spawnAgent(window, 'monorepo', prompt);
        await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
        await tile(window).dblclick();
        const frame = sessionWindow(window).getByTestId('pane-decision');
        await expect(frame).toBeVisible();
        // No focus ring in the shot: the focus goes to the window, not a choice.
        await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await pinRandomText(window);
        const restorePointer = await ignorePointer(window);
        await settle(window);
        await expect.soft(frame).toHaveScreenshot(`simplified-pane-${kind}${suffix}.png`, SHOT);
        await restorePointer();
      } finally {
        await app.close();
        await removeDataDir(dataDir);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

// A permission prompt the board holds, above the composer in the Simplified design: a plain sentence and the command, with
// Deny, Allow for this session and Allow once; and a destructive command with Review… in place of every Allow.
for (const { theme, suffix } of THEMES) {
  const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
  for (const { name, scenario, prompt } of [
    { name: 'permission', scenario: 'long-permission' as const, prompt: 'pnpm test' },
    { name: 'permission-destructive', scenario: 'permission' as const, prompt: 'Clean up' },
  ]) {
    test(`a ${name === 'permission' ? 'permission prompt' : 'destructive permission prompt'} in the pane as the Simplified design draws it, ${theme}`, async () => {
      needsBaselines(`simplified-pane-${name}${suffix}`);
      const { dir, repo, env } = scratch(scenario);
      const dataDir = tempDataDir();
      const { app, window } = await launch(
        dataDir,
        { ...env, FAKE_HARNESS_PERMISSION_SUGGESTIONS: '1', ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
        RENDER_ARGS,
        { design: 'simplified' },
      );
      try {
        await window.setViewportSize(VIEWPORT);
        await window.emulateMedia({ colorScheme: theme });
        await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
        await pinFonts(window);
        await pickFolderNext(app, repo);
        await browseForZone(window);
        await spawnAgent(window, 'monorepo', prompt);
        await expect(tile(window)).toHaveAttribute('data-state', 'needs-permission', { timeout: TURN_MS });
        await tile(window).dblclick();
        const frame = sessionWindow(window).getByTestId('pane-decision');
        await expect(frame).toBeVisible();
        // A card ignores clicks for its first moments: its buttons are drawn dimmed until then.
        await expect(frame.getByRole('button', { name: /^Deny/ })).toBeEnabled();
        await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await pinRandomText(window);
        const restorePointer = await ignorePointer(window);
        await settle(window);
        // The hold's countdown ticks each second: masked.
        await expect.soft(frame).toHaveScreenshot(`simplified-pane-${name}${suffix}.png`, { ...SHOT, mask: [frame.getByTestId('permission-countdown')] });
        await restorePointer();
      } finally {
        await app.close();
        await removeDataDir(dataDir);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

// An agent's window in the Simplified design on its Timeline: each turn on the rail with the time down its side, every
// step a line (thinking, a subagent's call), the replies in full, and a held permission prompt live at its foot.
for (const { theme, suffix } of THEMES) {
  const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
  test(`an agent's window on its Timeline as the Simplified design draws it, ${theme}`, async () => {
    needsBaselines(`simplified-session-timeline${suffix}`);
    const { dir, repo, env } = scratch('orchestrate');
    const dataDir = tempDataDir();
    const { app, window } = await launch(
      dataDir,
      { ...env, ...RENDER_ENV, ...appearance, FAKE_HARNESS_REPEAT: '1', SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
      RENDER_ARGS,
      { design: 'simplified' },
    );
    await listFinishedTurns(window);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Think, then send a subagent');
      await tile(window).dblclick();
      await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Timeline' }).click();
      const chat = sessionWindow(window).getByTestId('chat-frame');
      await expect(chat).toHaveAttribute('data-style', 'rail');
      await expect(chat.getByTestId('chat-live')).toHaveAttribute('data-live', 'done', { timeout: TURN_MS });
      const box = sessionWindow(window).getByRole('textbox', { name: 'Message to the agent' });
      await box.fill('Ask permission');
      await box.press('Enter');
      await expect(chat.getByTestId('chat-live')).toHaveAttribute('data-live', 'permission', { timeout: TURN_MS });
      // The decision card takes the focus as it shows, and after a key press the page counts that as keyboard focus and
      // rings it: the shot is of the card at rest, as the permission shot above takes it.
      await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await pinRandomText(window);
      await pinChatTimes(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(sessionWindow(window)).toHaveScreenshot(`simplified-session-timeline${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// An agent's sidebar in the Simplified design, open on the board's Now as it waits; with Show technical details on, its
// Setup shelf, where it works.
for (const { theme, suffix } of THEMES) {
  const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
  for (const technical of [false, true]) {
    const shot = `simplified-agent-shelves-live${technical ? '-setup' : ''}${suffix}`;
    test(`an agent's shelves as the Simplified design draws it, technical details ${technical ? 'on' : 'off'}, ${theme}`, async () => {
      needsBaselines(shot);
      const { dir, repo, env } = scratch('waiting');
      const dataDir = tempDataDir();
      const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, { design: 'simplified', technical });
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
        const shelves = sessionWindow(window).getByTestId('agent-shelves');
        await expect(shelves.getByTestId('page-now')).toContainText('Postgres or SQLite');
        if (technical) {
          await shelves.getByRole('tab', { name: 'Setup' }).click();
          await expect(shelves.getByRole('region', { name: 'Where it works' })).toContainText('Claude');
        }
        await pinRandomText(window);
        const restorePointer = await ignorePointer(window);
        await settle(window);
        await expect.soft(shelves).toHaveScreenshot(`${shot}.png`, SHOT);
        await restorePointer();
      } finally {
        await app.close();
        await removeDataDir(dataDir);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

// Classic's Shelves sidebar: the shelves in Classic's tokens, in place of the details strip, open on the board's Now.
for (const { theme, suffix } of THEMES) {
  const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
  const shot = `agent-shelves-live${suffix}`;
  test(`an agent's shelves as Classic's Shelves sidebar draws it, ${theme}`, async () => {
    needsBaselines(shot);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Pick a database');
      await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      // Picked in Settings, which shows the shelves too.
      const settings = await openSettings(window, 'agents.sidebar');
      await settingsSection(settings, 'Sidebar').getByRole('group', { name: 'Agent sidebar' }).getByRole('button', { name: 'Shelves' }).click();
      await settings.close();
      await tile(window).dblclick();
      const shelves = sessionWindow(window).getByTestId('agent-shelves');
      await expect(shelves.getByTestId('page-now')).toContainText('Postgres or SQLite');
      await expect(shelves.getByRole('tab', { name: 'Setup' })).toBeVisible();
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(shelves).toHaveScreenshot(`${shot}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// The Simplified design's one docked pane: Needs you opens it on the list, the Captain on its chat in the character's hat.
for (const { theme, suffix } of THEMES) {
  const simplified: LaunchOptions = { design: 'simplified' };
  const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};

  test(`the docked pane in the Simplified design: the Needs-you list and the Captain's chat, ${theme}`, async () => {
    needsBaselines(`simplified-captain-pane-list${suffix}`, `simplified-captain-pane-chat${suffix}`);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, simplified);
    try {
      await listFinishedTurns(window);
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Pick a database');
      await expect(tile(window).first()).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      const panel = window.getByTestId('master-panel');
      await window.addStyleTag({ content: '.master-panel * { scrollbar-width: none; }' });

      await window.getByTestId('inbox-count').click();
      await expect(panel.getByTestId('inbox-item')).toHaveCount(1);
      await pinChatTimes(window);
      await pinRandomText(window);
      let restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`simplified-captain-pane-list${suffix}.png`, SHOT);
      await restorePointer();

      await window.getByTestId('master-button').click();
      await panel.getByTestId('master-start').click();
      await expect(panel.getByTestId('chat-assistant')).toHaveText(['Which database should I use, Postgres or SQLite?'], { timeout: TURN_MS });
      await expect(panel.getByTestId('chat-live')).toHaveAttribute('data-live', 'done', { timeout: TURN_MS });
      await pinChatTimes(window);
      await pinRandomText(window);
      restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`simplified-captain-pane-chat${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// The pane's "Since you last looked" under the Needs-you list: an agent that finished while the list was away.
for (const { theme, suffix } of THEMES) {
  test(`the pane's Since you last looked in the Simplified design, ${theme}`, async () => {
    needsBaselines(`simplified-digest${suffix}`);
    const { dir, repo, env } = scratch('orchestrate');
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, { design: 'simplified' });
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      await pinFonts(window);
      // A first look, so the agent's finishing comes after one.
      await window.getByTestId('inbox-count').click();
      await expect(window.getByTestId('master-panel')).toBeVisible();
      await window.getByTestId('inbox-count').click();
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Gate in the background');
      await expect.poll(async () => (await agents(window))[0]?.workFinishedAt ?? null, { timeout: TURN_MS }).not.toBeNull();
      await window.getByTestId('inbox-count').click();
      const digest = window.getByTestId('since-looked');
      await expect(digest.getByTestId('since-looked-done')).toHaveCount(1);
      await window.addStyleTag({ content: '.master-panel * { scrollbar-width: none; }' });
      // The clock times are the run's own.
      await window.evaluate(() => {
        document.querySelectorAll('.since-looked time').forEach((time) => (time.textContent = '17:20'));
        document.querySelectorAll('.since-looked-head small').forEach((small) => (small.textContent = 'Last looked 16:00'));
      });
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`simplified-digest${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ⌘K in the Simplified design: the open window leads, under a Windows heading, and the other agent is in Recent.
for (const { theme, suffix } of THEMES) {
  test(`the ⌘K switcher in the Simplified design lists the open window first, ${theme}`, async () => {
    needsBaselines(`simplified-spotlight${suffix}`);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, { design: 'simplified' });
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
      // Seen, so it leaves Needs you; its window stays open over the board.
      await tile(window).filter({ hasText: 'Tidy the tokens' }).dblclick();
      await expect(sessionWindow(window)).toHaveCount(1);

      await window.keyboard.press(windowKey('k'));
      const switcher = window.getByRole('dialog', { name: 'Jump to a session, zone or setting' });
      await expect(switcher.getByTestId('spotlight-row').first()).toContainText('Tidy the tokens');
      await expect(switcher.locator('.spotlight-group').first()).toHaveText('Windows');
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('body')).toHaveScreenshot(`simplified-spotlight${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close().catch(() => {});
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/** The Simplified design's Settings window (General, and searching) and its board menu, whose Quick settings add Show technical details, light and dark. */
for (const { theme, suffix } of [
  { theme: 'light', suffix: '' },
  { theme: 'dark', suffix: '-dark' },
] as const) {
  test(`the Settings window and the board menu in the Simplified design, ${theme}`, async () => {
    const shots = [`settings-window-general-simplified${suffix}`, `settings-window-search-simplified${suffix}`, `board-menu-simplified${suffix}`];
    needsBaselines(...shots);
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window } = await launch(dataDir, { ...RENDER_ENV, ...appearance }, RENDER_ARGS, { design: 'simplified' });
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      await pinFonts(window);
      const settings = await openSettings(window);
      await settings.emulateMedia({ colorScheme: theme });
      await expect.poll(() => settings.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(settings);
      await pinRandomText(settings);
      let restorePointer = await ignorePointer(settings);
      await settle(settings);
      await expect.soft(settings.locator('body')).toHaveScreenshot(`${shots[0]}.png`, SHOT);
      await restorePointer();

      await settings.getByRole('searchbox', { name: 'Search settings' }).fill('path');
      await expect(settings.getByRole('main', { name: 'Search' })).toBeVisible();
      await pinRandomText(settings);
      restorePointer = await ignorePointer(settings);
      await settle(settings);
      await expect.soft(settings.locator('body')).toHaveScreenshot(`${shots[1]}.png`, SHOT);
      await restorePointer();

      // The board menu with Simplified on, so its Quick settings include Show technical details.
      await window.bringToFront();
      await window.getByRole('button', { name: 'Board menu' }).click();
      await unfoldMenuSection(window, 'Quick settings');
      await expect(window.getByRole('dialog', { name: 'Board menu' }).getByRole('switch', { name: 'Show technical details' })).toBeVisible();
      await pinRandomText(window);
      restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('body')).toHaveScreenshot(`${shots[2]}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close().catch(() => {});
      await removeDataDir(dataDir);
    }
  });
}
