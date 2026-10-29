import { expect, type Locator, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, openBoardMenu, sessionWindow, spawnAgent, tile, TURN_MS } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// The chat shows Claude Code's live states in the style picked for every chat, and answers what waits on the user
// where it shows. The fake claude's `orchestrate` scenario plays each state by its prompt; nothing here answers for the
// user but the clicks.

type Style = 'Cards' | 'Timeline' | 'Status line';

/** Opens the agent named `name`'s session window on its chat, and returns the chat's frame. */
async function openChat(window: Page, name: string): Promise<Locator> {
  await tile(window).filter({ hasText: name }).dblclick();
  await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
  return sessionWindow(window).getByTestId('chat-frame');
}

async function closeChat(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Close session window' }).click();
  await expect(sessionWindow(window)).toBeHidden();
}

/** Picks the chat style: Cards is the default, Timeline from Settings › Chat (with no window open), the status line from the switch over a chat. */
async function pickStyle(window: Page, style: Style): Promise<void> {
  if (style === 'Timeline') {
    const menu = await openBoardMenu(window);
    const choices = menu.getByRole('radiogroup', { name: 'Chat style' });
    await expect(choices.getByRole('radio', { name: /^Cards/ })).toBeChecked();
    await choices.getByRole('radio', { name: /^Timeline/ }).check();
    await window.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  } else if (style === 'Status line') {
    await sessionWindow(window).getByRole('group', { name: 'Chat style' }).getByRole('button', { name: 'Status line' }).click();
  }
}

const STYLE_IDS: Record<Style, string> = { Cards: 'cards', Timeline: 'timeline', 'Status line': 'status-line' };

for (const style of ['Cards', 'Timeline', 'Status line'] as const) {
  test(`in the ${style} style, the chat shows a permission prompt, a plan, a usage limit and a subagent, and answers them where they show`, async () => {
    const { dir, repo, env } = scratch('orchestrate');
    const dataDir = tempDataDir();
    // Claude's rate-limit menu with its usage-credits row first: Continue on credits closes it, picking no row.
    let { app, window } = await launch(dataDir, { ...env, FAKE_HARNESS_RATE_LIMIT_SCREEN: 'menu-credits-first' });
    try {
      await pickFolderNext(app, repo);
      await browseForZone(window);

      // A permission prompt, allowed from the chat: the turn goes on and ends, done.
      await spawnAgent(window, 'monorepo', 'Ask permission', { name: 'asker' });
      if (style === 'Timeline') await pickStyle(window, style);
      let chat = await openChat(window, 'asker');
      if (style === 'Status line') await pickStyle(window, style);
      await expect(chat).toHaveAttribute('data-style', STYLE_IDS[style]);
      // Each style's switch shows which is picked, and every chat follows it.
      await expect(sessionWindow(window).getByRole('group', { name: 'Chat style' }).getByRole('button', { name: style })).toHaveAttribute('aria-pressed', 'true');
      const live = chat.getByTestId('chat-live');
      await expect(live).toHaveAttribute('data-live', 'permission', { timeout: TURN_MS });
      await expect(live).toContainText('Allow Bash?');
      await live.getByRole('button', { name: 'Allow Bash' }).click();
      await expect(live).toHaveAttribute('data-live', 'done', { timeout: TURN_MS });
      await expect(live).toContainText('Done');
      // The status line reads out its state, not its time counting on.
      if (style === 'Status line') await expect(live.getByRole('status')).toHaveText('Done');
      await closeChat(window);

      // A plan: Open plan shows it in the window's Plan tab; the cards and the rail approve it in place too.
      await spawnAgent(window, 'monorepo', 'Plan: Cache the product pages', { name: 'planner' });
      chat = await openChat(window, 'planner');
      await expect(chat.getByTestId('chat-live')).toHaveAttribute('data-live', 'plan', { timeout: TURN_MS });
      await expect(chat.getByTestId('chat-live')).toContainText('Cache the product pages');
      if (style !== 'Status line') {
        await chat.getByTestId('chat-live').getByRole('button', { name: 'Approve' }).click();
        await expect(chat.getByTestId('chat-live')).toHaveAttribute('data-live', 'done', { timeout: TURN_MS });
        await expect(chat.getByTestId('chat-assistant').last()).toContainText('approved');
      } else {
        await chat.getByTestId('chat-live').getByRole('button', { name: 'Open plan' }).click();
        await expect(sessionWindow(window).getByTestId('plan-view')).toBeVisible();
      }
      await closeChat(window);

      // A question: answered with one of its options, or in the user's own words (the status line's Answer opens them).
      await spawnAgent(window, 'monorepo', 'Ask: Which cache should the product pages use? | Redis | In-memory LRU', { name: 'questioner' });
      chat = await openChat(window, 'questioner');
      const asking = chat.getByTestId('chat-live');
      await expect(asking).toHaveAttribute('data-live', 'ask', { timeout: TURN_MS });
      await expect(asking).toContainText('Which cache should the product pages use?');
      if (style === 'Status line') await asking.getByRole('button', { name: 'Answer' }).click();
      if (style === 'Timeline') {
        await asking.getByRole('button', { name: 'Reply…' }).click();
        await asking.getByRole('textbox', { name: 'Your answer' }).fill('Memcached');
        await asking.getByRole('textbox', { name: 'Your answer' }).press('Enter');
      } else {
        await asking.getByRole('button', { name: 'Redis' }).click();
      }
      await expect(asking).toHaveAttribute('data-live', 'done', { timeout: TURN_MS });
      await expect(chat.getByTestId('chat-assistant').last()).toContainText(style === 'Timeline' ? 'Memcached' : 'Redis');
      await closeChat(window);

      // A usage limit, moved on from the chat with Continue on credits.
      await spawnAgent(window, 'monorepo', 'Hit the rate limit', { name: 'limited' });
      chat = await openChat(window, 'limited');
      await expect(chat.getByTestId('chat-live')).toHaveAttribute('data-live', 'rate-limited', { timeout: TURN_MS });
      await expect(chat.getByTestId('chat-live')).toContainText('Usage limit');
      await chat.getByTestId('chat-live').getByRole('button', { name: 'Continue on credits' }).click();
      await expect(chat.getByTestId('chat-live')).not.toHaveAttribute('data-live', 'rate-limited', { timeout: TURN_MS });
      await closeChat(window);

      // Thinking, then a subagent: the call opens to the subagent's own conversation.
      await spawnAgent(window, 'monorepo', 'Think, then send a subagent', { name: 'explorer' });
      chat = await openChat(window, 'explorer');
      await expect(chat.getByTestId('chat-assistant').last()).toHaveText('The explorer found where sessions are created.', { timeout: TURN_MS });
      await expect(chat.getByTestId('chat-thinking')).toHaveCount(1);
      await expect(chat.getByTestId('chat-live')).toHaveAttribute('data-live', 'done');
      if (style === 'Cards') {
        const card = chat.getByTestId('chat-tool').filter({ hasText: 'Explore' });
        await expect(card).toHaveAttribute('data-status', 'done');
        await card.getByTestId('chat-tool-line').click();
      } else if (style === 'Timeline') {
        await chat.getByTestId('chat-tool-run').getByTestId('chat-tool-line').click();
      } else {
        await chat.getByTestId('chat-tool').filter({ hasText: 'Explore' }).click();
      }
      await expect(chat.getByTestId('chat-subagent')).toContainText('Sessions are created in src/daemon/sessions.ts.');
      // Its thinking keeps its text, folded under it (on the status line, under its row of chips).
      const thinking = chat.getByTestId('chat-thinking');
      await (style === 'Status line' ? thinking : thinking.getByRole('button')).click();
      await expect(style === 'Status line' ? chat.getByTestId('chat-tool-run').filter({ has: window.getByTestId('chat-thinking') }) : thinking).toContainText('an explorer can find where');
      await closeChat(window);

      // The style picked outlasts a relaunch.
      await app.close();
      ({ app, window } = await launch(dataDir, env));
      const menu = await openBoardMenu(window);
      await expect(menu.getByRole('radiogroup', { name: 'Chat style' }).getByRole('radio', { name: new RegExp(`^${style}`) })).toBeChecked();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
