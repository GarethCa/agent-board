import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { agents, launch, listFinishedTurns, sessionWindow, showDetails, spawnAgent, tile, tileAction, TURN_MS, useFullSidebar } from '../agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from '../launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, pinRandomText, settle } from '../render.ts';
import { scratch } from '../scratch.ts';
import { crowdedPanel, LONG } from '../master-helpers.ts';
import { SHOT, needsBaselines, PACK_SHOTS, pinChatTimes } from './shared.ts';
import { showTileParts } from '../settings-helpers.ts';

test.use({ viewport: null });

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
    await listFinishedTurns(window);
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
      await expect(sessionWindow(window).getByTestId('chat-live')).toHaveAttribute('data-live', 'done');
      await pinRandomText(window);
      await pinChatTimes(window);
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

for (const style of ['Cards', 'Timeline', 'Status line'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`the chat's states as ${style.toLowerCase()} in the ${theme} theme, in a session window and in the Captain's panel`, async () => {
      const slug = style.toLowerCase().replace(' ', '-');
      const prefix = theme === 'light' ? '' : 'dark-';
      const shots = [`${prefix}chat-states-${slug}`, `${prefix}chat-states-${slug}-panel`];
      needsBaselines(...shots);
      const { dir, repo, env } = scratch('orchestrate');
      const dataDir = tempDataDir();
      // Each later prompt plays the scenario again by its words, as the first does.
      const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, FAKE_HARNESS_REPEAT: '1', AGENT_BOARD_APPEARANCE: theme, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
      try {
        await listFinishedTurns(window);
        await window.setViewportSize(VIEWPORT);
        await window.emulateMedia({ colorScheme: theme });
        await pinFonts(window);
        await pickFolderNext(app, repo);
        await browseForZone(window);
        // Thinking and a subagent, then a held permission prompt: most of the states, done and live.
        await spawnAgent(window, 'monorepo', 'Think, then send a subagent');
        await tile(window).dblclick();
        await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
        await sessionWindow(window).getByRole('group', { name: 'Chat style' }).getByRole('button', { name: style }).click();
        const chat = sessionWindow(window).getByTestId('chat-frame');
        await expect(chat.getByTestId('chat-live')).toHaveAttribute('data-live', 'done', { timeout: TURN_MS });
        const box = sessionWindow(window).getByRole('textbox', { name: 'Message to the agent' });
        await box.fill('Ask permission');
        await box.press('Enter');
        await expect(chat.getByTestId('chat-live')).toHaveAttribute('data-live', 'permission', { timeout: TURN_MS });
        // The pointer off the style button it pressed, so its tooltip, shown or not by the time of the shot, is not in it.
        await window.mouse.move(VIEWPORT.width - 4, VIEWPORT.height / 2);
        await pinRandomText(window);
        await pinChatTimes(window);
        let restorePointer = await ignorePointer(window);
        await settle(window);
        await expect.soft(sessionWindow(window)).toHaveScreenshot(`${shots[0]}.png`, SHOT);
        await restorePointer();
        // Denied from the chat, so nothing waits in the Captain's For you.
        await chat.getByTestId('chat-live').getByRole('button', { name: 'Deny Bash' }).click();
        await expect(chat.getByTestId('chat-live')).toHaveAttribute('data-live', 'done', { timeout: TURN_MS });
        await window.getByRole('button', { name: 'Close session window' }).click();

        // The Captain, its usage limit hit, in its panel.
        await window.getByTestId('master-button').click();
        await window.getByTestId('master-start').click();
        const panel = window.getByTestId('master-panel');
        await expect(panel.getByTestId('chat-live')).toHaveAttribute('data-live', 'done', { timeout: TURN_MS });
        const ask = panel.getByRole('textbox', { name: 'Message to the agent' });
        await ask.fill('Hit the rate limit');
        await ask.press('Enter');
        await expect(panel.getByTestId('chat-live')).toHaveAttribute('data-live', 'rate-limited', { timeout: TURN_MS });
        await window.addStyleTag({ content: '.master-panel * { scrollbar-width: none; }' });
        await pinRandomText(window);
        await pinChatTimes(window);
        restorePointer = await ignorePointer(window);
        await settle(window);
        await expect.soft(panel).toHaveScreenshot(`${shots[1]}.png`, SHOT);
        await restorePointer();
      } finally {
        await app.close();
        await removeDataDir(dataDir);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

/** What an agent's message says in the shots of it: long enough to fold in a narrow chat (the fake agent's input stops short of a kilobyte). */
const HANDED_OFF = [
  'Review is back on the pull request. Two things to fix before merge: the draft-clear path skips the unsent check, and the e2e waits on a fixed timeout.',
  'Everything else looks good. Please rebase on main first, then push and tell me when the gate is green.',
].join(' ');

/** An edge that hands `from`'s final message to `to`, and `from`'s next turn, answered with `text`. */
async function handOff(page: Page, from: string, to: string, text: string): Promise<void> {
  await page.evaluate(([a, b]) => window.agentBoard.flowEdges.create({ from: a!, to: b! }), [from, to]);
  await page.evaluate(([id, typed]) => window.agentBoard.agents.answer(id!, typed!), [from, text]);
}

/** Starts two agents, hands the first's final message to the second, and opens the second's chat. */
async function showAgentMessage(app: ElectronApplication, window: Page, repo: string): Promise<void> {
  await pickFolderNext(app, repo);
  await browseForZone(window);
  await spawnAgent(window, 'monorepo', 'Write the code');
  await spawnAgent(window, 'monorepo', 'Review the code');
  const reviewer = tile(window).filter({ hasText: 'Review the code' });
  for (const each of [tile(window).filter({ hasText: 'Write the code' }), reviewer]) await expect(each).toHaveAttribute('data-state', 'waiting');
  const all = await agents(window);
  const coder = all.find((agent) => agent.name === 'Write the code')!;
  const reviewing = all.find((agent) => agent.name === 'Review the code')!;
  await handOff(window, coder.sessionId, reviewing.sessionId, HANDED_OFF);
  await expect
    .poll(async () => (await agents(window)).find((agent) => agent.sessionId === reviewing.sessionId)?.lastMessage, { timeout: TURN_MS })
    .toContain('⟨hand-off from Write the code');
  await reviewer.dblclick();
  await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
  const chat = sessionWindow(window).getByTestId('chat-frame');
  await expect(chat.getByTestId('chat-live')).toHaveAttribute('data-live', 'done', { timeout: TURN_MS });
}

/** The chat styles shot, in the order they are shown. Cards is also shot narrow, folded, last, in the dark theme. */
const AGENT_MESSAGE_STYLES = ['Cards', 'Timeline', 'Status line'] as const;

// One scene per theme (the theme is set at launch) shows all of its shots: the two agents and the hand-off are set up once, then the chat style is switched.
for (const theme of ['light', 'dark'] as const) {
  test(`an agent's message in the chat as cards, timeline and status line in the ${theme} theme${theme === 'dark' ? ', and folded in a narrow chat' : ''}`, async () => {
    const shotOf = (style: string, narrow: boolean) =>
      `${theme === 'light' ? '' : 'dark-'}chat-agent-message-${style.toLowerCase().replace(' ', '-')}${narrow ? '-folded' : ''}`;
    // Past four lines it folds, shown in a chat narrow enough for the message to wrap that far.
    const shots = [
      ...AGENT_MESSAGE_STYLES.map((style) => ({ style, narrow: false })),
      ...(theme === 'dark' ? [{ style: 'Cards', narrow: true }] : []),
    ];
    needsBaselines(...shots.map(({ style, narrow }) => shotOf(style, narrow)));
    const { dir, repo, env } = scratch('output');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: theme, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
    try {
      await listFinishedTurns(window);
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await pinFonts(window);
      await showAgentMessage(app, window, repo);
      for (const { style, narrow } of shots) {
        await sessionWindow(window).getByRole('group', { name: 'Chat style' }).getByRole('button', { name: style }).click();
        await expect(sessionWindow(window).getByTestId('chat-frame').getByTestId('chat-agent-message')).toHaveCount(1);
        if (narrow) await window.addStyleTag({ content: '.session-chat-view .chat-view { max-width: 440px; }' });
        await pinRandomText(window);
        await pinChatTimes(window);
        const restorePointer = await ignorePointer(window);
        await settle(window);
        await expect.soft(sessionWindow(window)).toHaveScreenshot(`${shotOf(style, narrow)}.png`, SHOT);
        await restorePointer();
      }
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the dark theme: a review doc in its implementer's session window, then its chat with the chat's controls at the tab row's end, wide and narrow", async () => {
  needsBaselines('dark-review-viewer', 'dark-review-tab-row', 'dark-review-tab-row-narrow');
  const { dir, repo, env } = scratch('review');
  const dataDir = tempDataDir();
  const { app, window } = await launch(
    dataDir,
    { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: 'dark', SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
    RENDER_ARGS,
  );
  await listFinishedTurns(window);
  try {
    await showTileParts(window, ['chips']);
    await window.setViewportSize(VIEWPORT);
    await window.emulateMedia({ colorScheme: 'dark' });
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark');
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Write the code');
    const coder = tile(window).filter({ hasText: 'Write the code' });
    await expect(coder).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    await tileAction(coder, 'Review its work', 'Review & gate');
    // The fake reviewer types its doc a word at a time.
    await expect(window.locator('[data-testid="agent-tile"][data-reviewer]')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
    // The review chip can fold into +N on a crowded tile: open it from there.
    const review = coder.getByTestId('tile-review');
    await expect(review).toHaveCount(1);
    if (await review.isVisible()) await review.click();
    else {
      await coder.getByTestId('tile-folded').click();
      await window.getByTestId('tile-folded-row').filter({ hasText: /review/i }).first().click();
    }
    const viewer = sessionWindow(window).getByTestId('review-viewer');
    await expect(viewer.getByTestId('review-verdict')).toContainText('Changes requested');
    await pinRandomText(window);
    let restorePointer = await ignorePointer(window);
    await settle(window);
    // A round's time is the clock's when it ran.
    await expect.soft(window.locator('body')).toHaveScreenshot('dark-review-viewer.png', { ...SHOT, mask: [viewer.locator('.review-round-when')] });
    await restorePointer();

    // The chat's controls sit at the tab row's end, hidden with the chat on the Review tab, and not in the header or the strip.
    const win = sessionWindow(window);
    const tabRow = win.locator('.session-window-tab-row');
    await expect(tabRow.getByRole('button', { name: 'Expand all' })).toBeHidden();
    await win.getByRole('tab', { name: 'Terminal' }).click();
    await win.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
    await expect(tabRow.getByRole('group', { name: 'Chat style' })).toBeVisible();
    await expect(tabRow.getByRole('button', { name: 'Expand all' })).toBeVisible();
    await expect(tabRow.getByRole('button', { name: 'Collapse all' })).toBeVisible();
    for (const elsewhere of [win.locator('.session-window-head'), win.locator('.session-window-strip')]) {
      await expect(elsewhere.getByRole('button', { name: 'Expand all' })).toHaveCount(0);
    }
    await pinRandomText(window);
    await pinChatTimes(window);
    restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(win).toHaveScreenshot('dark-review-tab-row.png', SHOT);
    // Narrow, Expand all and Collapse all fold to their icons, which keep their names; the tabs keep their words.
    // The window keeps a 24 px gutter each side: 612 px wide, under the tab row's 640 px fold.
    await window.setViewportSize({ width: 660, height: VIEWPORT.height });
    await expect(tabRow.getByText('Expand all', { exact: true })).toBeHidden();
    await expect(tabRow.getByRole('button', { name: 'Expand all' })).toBeVisible();
    await expect(win.getByRole('tab', { name: /Review · round/ })).toBeVisible();
    await settle(window);
    await expect.soft(win).toHaveScreenshot('dark-review-tab-row-narrow.png', SHOT);
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent's sidebar: the document it showed, and a file, a link and a note it pinned", async () => {
  needsBaselines('sidebar-pins');
  const { dir, repo, env } = scratch('ask-plan');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  try {
    await showTileParts(window, ['chips']);
    await useFullSidebar(window);
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pins: notes/report.md');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    await tile(window).getByTestId('tile-docs').click();
    await showDetails(sessionWindow(window));
    const details = sessionWindow(window).getByRole('complementary', { name: 'Session details' });
    await expect(details.getByTestId('details-pin')).toHaveCount(4);
    // The sections above folded, so Documents and Pins show whole.
    for (const label of ['Controls', 'Folder (live)', 'Issue', 'Last message', 'Worktree and branch', 'PR and checks', 'Gate', 'Crew', 'Hand-off docs']) {
      await details.getByRole('region', { name: label }).locator('.ui-section-head').click();
    }
    // Scrolled to its end, with no overlay scrollbar, which shows a while after a scroll.
    await window.addStyleTag({ content: '.session-details-sections { scrollbar-width: none; }' });
    await details.locator('.session-details-sections').evaluate((sections) => sections.scrollTo(0, sections.scrollHeight));
    await pinRandomText(window);
    await ignorePointer(window);
    await settle(window);
    // Each time it was shown or pinned is the clock's.
    const when = details.locator('[data-testid="details-document"] .ui-row-meta, [data-testid="details-pin"]:not(:last-child) .ui-row-meta');
    await expect.soft(details).toHaveScreenshot('sidebar-pins.png', { ...SHOT, mask: [when] });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

// The digest's `code` and code block take the board's code colours: the panel is shot in both themes.
for (const theme of ['light', 'dark'] as const) {
  test(`the Captain's panel with names, paths and code too long to fit: cut or wrapped${theme === 'light' ? ', and above the dock with a window minimised' : ', in the dark theme'}`, async () => {
    const prefix = theme === 'light' ? '' : 'dark-';
    needsBaselines(`${prefix}master-panel`, ...(theme === 'light' ? ['master-panel-dock'] : []));
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: theme, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
    try {
      await listFinishedTurns(window);
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Pick a database', { name: LONG });
      await expect(tile(window).first()).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      await crowdedPanel(window, '2026-01-01T14:31:00.000Z');
      const panel = window.getByTestId('master-panel');
      await expect(panel.getByTestId('master-digest')).toBeVisible();
      // Watching folded, For you dragged taller and scrolled to its end, so the whole digest (its path, link, code span
      // and block) is in frame.
      await panel.getByTestId('master-fold-watching').click();
      const grab = (await panel.getByTestId('master-for-you-handle').boundingBox())!;
      await window.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
      await window.mouse.down();
      await window.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2 + 250, { steps: 5 });
      await window.mouse.up();
      // The chat's brief is the same every run; its scrollbar shows a while after a scroll. Its turn is shot once done,
      // with its time pinned.
      await window.addStyleTag({ content: '.master-panel * { scrollbar-width: none; }' });
      await expect(panel.getByTestId('chat-assistant')).toHaveText(['Which database should I use, Postgres or SQLite?'], { timeout: TURN_MS });
      await expect.poll(() => tile(window).evaluateAll((tiles) => tiles.map((each) => each.getAttribute('data-state'))), { timeout: TURN_MS }).toEqual(['waiting', 'waiting']);
      await expect(panel.getByTestId('chat-live')).toHaveAttribute('data-live', 'done', { timeout: TURN_MS });
      await pinChatTimes(window);
      await pinRandomText(window);
      const forYou = panel.locator('.master-panel-for-you');
      await forYou.evaluate((list) => (list.scrollTop = list.scrollHeight));
      await expect(panel.locator('.master-digest .chat-md-code')).toBeInViewport({ ratio: 1 });
      let restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`${prefix}master-panel.png`, SHOT);
      await restorePointer();
      await forYou.evaluate((list) => (list.scrollTop = 0));
      // The dock is shot once, in the light theme.
      if (theme === 'dark') return;

      // A window minimised to the dock: the panel ends above it, the zoom bar beside it.
      await tile(window).first().dblclick();
      await window.getByRole('button', { name: 'Minimise session window' }).click();
      await expect(window.getByTestId('dock-item')).toHaveCount(1);
      await pinRandomText(window);
      restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot('master-panel-dock.png', SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

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
