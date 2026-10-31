import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, sessionWindow, spawnAgent, tile, TURN_MS } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// A message another agent sent shows in the receiver's chat as the sender's own bubble, never as the user's.

const answer = (page: Page, sessionId: string, text: string) => page.evaluate(([id, typed]) => window.agentBoard.agents.answer(id!, typed!), [sessionId, text]);
/**
 * Wraps past four lines in a narrow chat but not in a wide one, and short enough (under four lines of the line-count
 * guess) that only measuring it at the chat's width says it is long.
 */
const LONG = 'Two things to fix before merge. '.repeat(6).trim();

const join = (page: Page, from: string, to: string) => page.evaluate(([a, b]) => window.agentBoard.flowEdges.create({ from: a!, to: b! }), [from, to]);

test("an agent's hand-off is its own bubble in the receiver's chat, in all three styles, and the chat can show only the user's messages", async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Write the code');
    await spawnAgent(window, 'monorepo', 'Review the code');
    const reviewer = tile(window).filter({ hasText: 'Review the code' });
    for (const each of [tile(window).filter({ hasText: 'Write the code' }), reviewer]) await expect(each).toHaveAttribute('data-state', 'waiting');
    const all = await agents(window);
    const coder = all.find((agent) => agent.name === 'Write the code')!;
    const reviewing = all.find((agent) => agent.name === 'Review the code')!;
    await join(window, coder.sessionId, reviewing.sessionId);

    // The coder's turn ends and its final message goes along the edge, headed with its mark.
    await answer(window, coder.sessionId, LONG);
    await expect
      .poll(async () => (await agents(window)).find((agent) => agent.sessionId === reviewing.sessionId)?.lastMessage, { timeout: TURN_MS })
      .toContain('⟨hand-off from Write the code');

    await reviewer.dblclick();
    await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
    const chat = sessionWindow(window).getByTestId('chat-view');
    const bubble = chat.getByTestId('chat-agent-message');
    // The user's own prompt is the only user block; the coder's words are a bubble from it.
    await expect(chat.getByTestId('chat-user')).toHaveText(['Review the code']);
    await expect(bubble).toHaveCount(1);
    await expect(bubble).toContainText('From Write the code');
    await expect(bubble).toContainText('Hand-off · final message');
    await expect(bubble).toContainText('Two things to fix before merge.');
    // It fits in a few lines at this width, so it offers no fold; in a chat narrow enough for it to wrap past four it folds.
    const text = bubble.getByTestId('chat-agent-more');
    await expect(text).toHaveCount(0);
    await window.addStyleTag({ content: '.session-chat-view .chat-view { max-width: 360px; }' });
    await expect(text).toHaveText('Show all');
    await expect(bubble.locator('.chat-agent-text')).toHaveAttribute('data-collapsed', 'true');
    await text.click();
    await expect(bubble.locator('.chat-agent-text')).toHaveAttribute('data-collapsed', 'false');
    await expect(text).toHaveText('Show less');
    await text.click();
    await expect(bubble.locator('.chat-agent-text')).toHaveAttribute('data-collapsed', 'true');
    // What the receiver was also told is under the badge, not in the text.
    await expect(bubble).not.toContainText('Hand-off from Write the code');
    await bubble.getByTestId('chat-agent-info').click();
    await expect(bubble.getByTestId('chat-agent-aside')).toHaveText('Hand-off from Write the code (its final message)');

    // The same bubble in the other two styles.
    const styles = sessionWindow(window).getByRole('group', { name: 'Chat style' });
    for (const style of ['Timeline', 'Status line', 'Cards']) {
      await styles.getByRole('button', { name: style }).click();
      await expect(bubble).toHaveCount(1);
      await expect(bubble).toContainText('From Write the code');
    }

    // Only my messages folds it into one line, which can show it again.
    const shown = sessionWindow(window).getByRole('group', { name: 'Messages shown' });
    await expect(shown.getByRole('button', { name: 'Include agents' })).toHaveAttribute('aria-pressed', 'true');
    await shown.getByRole('button', { name: 'Only my messages' }).click();
    await expect(bubble).toHaveCount(0);
    await expect(chat.getByTestId('chat-user')).toHaveText(['Review the code']);
    await expect(chat.getByTestId('chat-agents-hidden')).toContainText('1 agent message hidden');
    await chat.getByTestId('chat-agents-hidden').getByRole('button', { name: 'Show' }).click();
    await expect(bubble).toHaveCount(1);
    await expect(shown.getByRole('button', { name: 'Include agents' })).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Captain's panel shows a message an agent sent as a bubble, has its filter in its header, and the session window's switch stays when the panel closes", async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Write the code');
    await window.getByTestId('master-button').click();
    await window.getByTestId('master-start').click();
    const panel = window.getByTestId('master-panel');
    await expect(panel.getByTestId('chat-live')).toHaveAttribute('data-live', 'done', { timeout: TURN_MS });
    const all = await agents(window);
    const coder = all.find((agent) => agent.name === 'Write the code')!;
    const captain = all.find((agent) => agent.master)!;
    await join(window, coder.sessionId, captain.sessionId);
    await answer(window, coder.sessionId, 'Ship it');
    const bubble = panel.getByTestId('chat-agent-message');
    await expect(bubble).toHaveCount(1, { timeout: TURN_MS });
    await expect(bubble).toContainText('From Write the code');

    // Its header has the filter, as one button.
    const only = panel.getByRole('button', { name: 'Only my messages' });
    await only.click();
    await expect(bubble).toHaveCount(0);
    await expect(panel.getByTestId('chat-agents-hidden')).toContainText('1 agent message hidden');
    await expect(only).toHaveAttribute('aria-pressed', 'true');
    await only.click();
    await expect(bubble).toHaveCount(1);

    // The Captain's session window holds the same chat as the panel.
    await panel.getByRole('button', { name: 'Open its session window' }).click();
    await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
    await expect(sessionWindow(window).getByRole('group', { name: 'Messages shown' })).toBeVisible();
    // The window covers the board, so the panel's Close is reached by its label, not through the page's roles.
    await panel.locator('button[aria-label="Close"]').dispatchEvent('click');
    // With the panel's chat gone, the session window's switch stays.
    await expect(panel).toHaveCount(0);
    await expect(sessionWindow(window).getByRole('group', { name: 'Messages shown' })).toBeVisible();
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
