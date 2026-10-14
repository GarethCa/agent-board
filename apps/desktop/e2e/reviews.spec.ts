import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import type { ReviewRound } from '@agent-board/daemon/protocol';
import { agents, launch, sessionWindow, spawnAgent, tile, tileAction } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';

const rounds = (page: Page): Promise<ReviewRound[]> => page.evaluate(() => window.agentBoard.reviews.list());

/** How long the fake reviewer, or the implementer reading a doc, may take. */
const REVIEW_MS = 30_000;

test("a reviewer spawned from an implementer's tile leaves its doc and ends; the doc opens in a Review tab of the implementer's window, is sent back to it, and a second round approves", async () => {
  const { dir, repo, env } = scratch('review');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Write the code');
    const coder = tile(window).filter({ hasText: 'Write the code' });
    await expect(coder).toHaveAttribute('data-state', 'waiting');
    const [coderAgent] = await agents(window);

    // From its tile: a reviewer starts on the board, dashed, writes its review and is stopped.
    await tileAction(coder, 'Review its work');
    const reviewer = window.locator('[data-testid="agent-tile"][data-reviewer]');
    await expect(reviewer).toHaveCount(1);
    // Its round is a subtitle, not part of its name; the whole name is the tooltip.
    await expect(reviewer.locator('.hybrid-tile-name')).toHaveText('Write the code');
    await expect(reviewer.locator('.hybrid-tile-subtitle')).toHaveText('Review · r1');
    // The fake types its doc a word at a time: allow for a busy machine.
    await expect(reviewer).toHaveAttribute('data-state', 'done', { timeout: REVIEW_MS });
    await expect.poll(async () => (await rounds(window))[0]?.status).toBe('ready');

    // Its chip on the implementer's tile opens the implementer's window on the Review tab.
    await coder.getByTestId('tile-review').click();
    const win = sessionWindow(window);
    await expect(win).toHaveAttribute('data-session-id', coderAgent!.sessionId);
    await expect(win.getByRole('tab', { name: 'Review · round 1' })).toHaveAttribute('aria-selected', 'true');
    const viewer = win.getByTestId('review-viewer');
    await expect(viewer.getByTestId('review-verdict')).toContainText('Changes requested');
    await expect(viewer.getByTestId('review-verdict')).toContainText('1 blocker · 1 major · 1 minor left');
    await expect(viewer.getByRole('region', { name: 'Blocker' })).toContainText('The worktree moves while the PTY still holds its cwd');
    await expect(viewer.getByRole('button', { name: 'src/sessions/move.ts:88' })).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Approve and merge' })).toBeDisabled();
    await expect(viewer).toContainText('1 blocker still open.');
    await expect(viewer.getByTestId('review-cap')).toHaveText('cap 3');

    // Sent back, it is the implementer's next message (which the fake, typing a word at a time, takes a while to echo).
    await viewer.getByRole('button', { name: 'Send to implementer' }).click();
    await expect
      .poll(async () => (await agents(window)).find((agent) => agent.sessionId === coderAgent!.sessionId)?.lastMessage, { timeout: REVIEW_MS })
      .toMatch(/^Done: Hand-off from Write the code · review r1 \(its review, round 1\): # Review of the work so far Verdict: Changes requested/);
    await expect(viewer.getByTestId('review-round').first()).toContainText('sent');

    // The terminal is a tab away, still attached.
    await win.getByRole('tab', { name: 'Terminal' }).click();
    await expect(viewer).toHaveCount(0);
    await expect(win.getByTestId('session-terminal')).toBeVisible();
    await win.getByRole('tab', { name: 'Review · round 1' }).click();

    // A second round reviews the fixes: it approves, the old findings struck through.
    await viewer.getByRole('button', { name: 'Start round 2' }).click();
    await expect(win.getByRole('tab', { name: 'Review · round 2' })).toBeVisible();
    await expect(viewer.getByTestId('review-round')).toHaveCount(2);
    // Round 1's reviewer is done with: it goes, its doc kept.
    await expect(reviewer).toHaveCount(1);
    await expect(reviewer).toContainText('Review · r2');
    await expect(viewer.getByTestId('review-verdict')).toContainText('Approve', { timeout: REVIEW_MS });
    await expect(viewer.getByRole('region', { name: 'Blocker' })).toContainText('1 resolved');
    await expect(viewer.locator('[data-testid="review-finding"][data-resolved="true"]')).toHaveCount(2);
    // No pull request yet, so nothing to merge.
    await expect(viewer).toContainText('Write the code has no open pull request.');
    // Round 1 is still there to read.
    await viewer.getByTestId('review-round').first().click();
    await expect(viewer.getByTestId('review-verdict')).toContainText('Changes requested');

    // Dismissing an earlier round leaves the tab open on the latest.
    await viewer.getByRole('button', { name: 'Dismiss' }).click();
    await expect(viewer.getByRole('button', { name: 'Dismiss' })).toBeDisabled();
    await expect(win.getByRole('tab', { name: 'Review · round 2' })).toHaveAttribute('aria-selected', 'true');

    // Dismissed, the latest round's tab closes and its reviewer goes; its doc stays.
    await viewer.getByTestId('review-round').last().click();
    await viewer.getByRole('button', { name: 'Dismiss' }).click();
    // The window's tabs go; the terminal's own tabs are another strip.
    await expect(win.getByRole('tablist', { name: 'Window tabs' })).toHaveCount(0);
    await expect(reviewer).toHaveCount(0);
    expect((await rounds(window)).map((round) => [round.round, round.status, round.dismissedAt !== null])).toEqual([
      [1, 'ready', true],
      [2, 'ready', true],
    ]);

    // Asked for again from the tile, the docs can still be read.
    await win.getByRole('button', { name: 'Close session window' }).click();
    await coder.getByTestId('tile-review').click();
    await expect(sessionWindow(window).getByRole('tab', { name: 'Review · round 2' })).toHaveAttribute('aria-selected', 'true');
    await expect(sessionWindow(window).getByTestId('review-verdict')).toContainText('Approve');
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
