import { expect } from '@playwright/test';
import { connectDaemon } from '@agent-board/daemon/client';
import { daemonPaths } from '@agent-board/daemon/paths';
import { createFakeGitHub, FAKE_GITHUB_STATE, type FakeGitHubPullRequest } from '@agent-board/tracker/testing';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { launch, TURN_MS, zones } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings } from './settings-helpers.ts';

const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args]);

const pullRequest = (branch: string, reviews: FakeGitHubPullRequest['reviews'] = []): FakeGitHubPullRequest => ({
  repo: 'acme/app',
  number: 214,
  title: 'Lock out after five tries',
  headRefName: branch,
  state: 'OPEN',
  isDraft: false,
  statusCheckRollup: [],
  reviews,
});

// Its card at rest, its card opened in place, and its terminal: the one ask is the same in each.
for (const view of ['card', 'opened card', 'terminal'] as const) {
  test(`a ticket's watches, from its ${view}: off until turned on in its Watches menu, a new review its one ask with Read, and Read clears it`, async () => {
    const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [] });
    const { dir, repo, env } = scratch('waiting');
    // gh names acme/app from origin.
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...env, TMPDIR: dir, AGENT_BOARD_GH: github.gh, AGENT_BOARD_PULL_REQUEST_POLL_MS: '200' });
    const daemon = await connectDaemon(daemonPaths(dataDir).socket);
    try {
      await pickFolderNext(app, repo);
      await browseForZone(window);
      const [zone] = await zones(window);
      if (view !== 'terminal') {
        // Ticket tiles open as their terminal unless Settings says their card.
        const settings = await openSettings(window, 'board.tiles');
        const card = settings.getByRole('group', { name: 'Ticket tiles open as' }).getByRole('button', { name: 'Card' });
        await card.click();
        await expect(card).toHaveAttribute('aria-pressed', 'true');
        await settings.close();
      }
      // The window has no way to start a ticket's chat yet: it starts as an agent's own `new` would.
      const chat = await daemon.call('agent.spawn', { zoneId: zone!.id, name: 'chat', ticketChat: true, cols: 120, rows: 40 });
      const card = window.locator('[data-ticket-tile]');
      const ticket = view === 'card' ? card : window.locator(`[data-testid="expanded-tile"][data-session-id="${chat.sessionId}"]`);
      if (view === 'opened card') {
        await expect(card).toHaveAttribute('data-session-id', chat.sessionId, { timeout: TURN_MS });
        await card.hover();
        await card.getByRole('button', { name: 'Expand' }).click();
      }
      await expect(ticket).toHaveAttribute('data-session-id', chat.sessionId, { timeout: TURN_MS });
      if (view !== 'card') await expect(ticket).toHaveAttribute('data-ticket-open', view === 'terminal' ? 'terminal' : 'card', { timeout: TURN_MS });
      if (view === 'opened card') {
        // Opened in place it runs under the minimap: zoomed out, its footer clears it.
        await window.getByRole('button', { name: 'Fit View' }).click();
        await window.getByRole('button', { name: 'Zoom Out' }).click();
      }

      github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest(chat.branch)] });
      await expect(ticket.getByTestId('ticket-pr')).toHaveText('#214', { timeout: TURN_MS });
      // Nothing is on by default: no watch icons.
      await expect(ticket.getByTestId('ticket-watch-icon')).toHaveCount(0);

      await ticket.hover();
      await ticket.getByRole('button', { name: 'Watches' }).click();
      const menu = window.getByRole('dialog', { name: 'What chat watches' });
      await expect(menu).toContainText('It never approves or merges.');
      // Its switch follows the daemon's answer, so it is clicked, not checked.
      await menu.getByRole('switch', { name: 'Human reviews: on tile' }).click();
      await expect(menu.getByRole('switch', { name: 'Human reviews: on tile' })).toBeChecked({ timeout: TURN_MS });
      await expect(menu.getByRole('switch', { name: 'Human reviews: tell chat' })).not.toBeChecked();
      await expect(ticket.locator('[data-testid="ticket-watch-icon"][data-kind="reviews"]')).toBeVisible({ timeout: TURN_MS });
      await expect.poll(() => window.evaluate(async (id) => (await self.agentBoard.agents.list()).find((agent) => agent.sessionId === id)?.watch?.checkedAt ?? null, chat.sessionId), { timeout: TURN_MS }).not.toBeNull();

      // A review lands; changing the pace reads the pull request at once, as a push does.
      github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest(chat.branch, [{ author: 'sam', state: 'CHANGES_REQUESTED', body: 'Cap the retries.', submittedAt: '2026-11-14T11:02:00Z' }])] });
      await menu.getByRole('button', { name: '2 min' }).click();
      await expect(menu.getByTestId('ticket-watches-news')).toContainText('sam requested changes', { timeout: TURN_MS });
      await window.keyboard.press('Escape');
      await expect(menu).toBeHidden();

      await expect(ticket.getByTestId('tile-state-word')).toHaveText('New review');
      // Opened, it has no line of its own: its chat or its terminal is.
      if (view === 'card') await expect(ticket.getByTestId('tile-description')).toHaveText('sam requested changes on #214.');
      await expect(ticket.locator('[data-testid="ticket-watch-icon"][data-kind="reviews"]')).toHaveAttribute('data-tone', 'new');
      const read = ticket.getByTestId('tile-act');
      await expect(read).toHaveText('Read');
      await read.click();

      await expect(ticket.getByTestId('tile-state-word')).not.toHaveText('New review', { timeout: TURN_MS });
      await expect(ticket.getByTestId('tile-act')).toHaveCount(0);
      await expect(ticket.locator('[data-testid="ticket-watch-icon"][data-kind="reviews"]')).toHaveAttribute('data-tone', 'quiet');
      // The watches only read: no review, approval or merge went to GitHub.
      expect(github.calls().filter((call) => call.args.includes('POST') || call.args.includes('merge') || call.args.includes('review'))).toEqual([]);
    } finally {
      daemon.close();
      await app.close();
      await removeDataDir(dataDir);
      github.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
