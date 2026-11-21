import { expect, type Page } from '@playwright/test';
import { createFakeGitHub, FAKE_GITHUB_STATE, type FakeGitHubPullRequest } from '@agent-board/tracker/testing';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { agents, launch, sessionWindow, spawnAgent, tile, tileAction, windowKey } from './agent-helpers.ts';
import { fillWideScreen, showTileParts } from './settings-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test, tabText } from './launch.ts';
import { scratch } from './scratch.ts';

const name = 'Jump to a session, zone or setting';
const spotlight = (page: Page) => page.getByRole('dialog', { name });
const panes = (page: Page) => sessionWindow(page).getByTestId('window-pane');
const divider = (page: Page) => sessionWindow(page).getByTestId('window-divider');

test("⌘K's pr: rows list the repo's open PRs, review asked of you first; ⇧↵ opens one beside the agent, the divider steps on a double-click, and a pasted PR link opens its tab", async () => {
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [] });
  const { dir, repo, env } = scratch('waiting');
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_GH: github.gh, AGENT_BOARD_PULL_REQUEST_POLL_MS: '200' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Fix the login redirect');
    const [agent] = await agents(window);
    const pullRequest = (fields: Partial<FakeGitHubPullRequest> & Pick<FakeGitHubPullRequest, 'number' | 'title' | 'headRefName'>): FakeGitHubPullRequest => ({
      repo: 'acme/app',
      state: 'OPEN',
      isDraft: false,
      statusCheckRollup: [],
      ...fields,
    });
    github.setState({
      ...FAKE_GITHUB_STATE,
      pullRequests: [
        pullRequest({ number: 41, title: 'Send users home after login', headRefName: agent!.branch, author: 'octocat' }),
        pullRequest({ number: 52, title: 'Rotate the signing keys', headRefName: 'keys', author: 'monalisa', reviewRequests: [{ login: 'octocat' }] }),
        pullRequest({ number: 60, title: 'Tidy the footer', headRefName: 'footer', author: 'hubot' }),
      ],
    });

    // The agent's window, open on its session, in one pane (drawn as no split at all).
    await tile(window).dblclick();
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await expect(panes(window)).toHaveCount(0);

    // pr: lists someone else's PR whose review is asked of you, in its own group first.
    await window.keyboard.press(windowKey('k'));
    await spotlight(window).getByRole('combobox', { name }).fill('pr:');
    // A group's label is a header above its rows, not a box round them.
    await expect(spotlight(window).locator('.spotlight-group').first()).toHaveAttribute('data-group', 'Review requested from you');
    await expect(spotlight(window).getByTestId('spotlight-row').first()).toContainText('Rotate the signing keys');

    // ⇧↵ opens it in a pane of its own beside the session, half and half in a window too narrow for 120 columns and the rest.
    await window.keyboard.press('Shift+Enter');
    await expect(spotlight(window)).toBeHidden();
    await expect(panes(window)).toHaveCount(2);
    await expect(panes(window).nth(1).getByTestId('session-tab')).toHaveText([tabText('PR #52')]);
    await expect(divider(window)).toHaveAttribute('data-ratio', '0.5');

    // A double-click steps the divider on: the session gets a third.
    await divider(window).dblclick();
    await expect.poll(async () => Number(await divider(window).getAttribute('data-ratio'))).toBeCloseTo(1 / 3, 2);

    // A pasted PR link is one row, read through gh, and ↵ opens its tab.
    await window.keyboard.press(windowKey('k'));
    await spotlight(window).getByRole('combobox', { name }).fill('https://github.com/acme/app/pull/60');
    const rows = spotlight(window).getByTestId('spotlight-row');
    await expect(rows.first()).toContainText('Tidy the footer');
    await expect(rows.nth(1)).toContainText('Open the page instead');
    await window.keyboard.press('Enter');
    await expect(sessionWindow(window).getByRole('tab', { name: tabText('PR #60'), exact: true })).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
    github.dispose();
  }
});

test("on a wide screen ⇧↵ gives the agent's terminal 120 columns beside a PR, and a review's Open PR beside shows the findings in a pane with the PR beside them", async () => {
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [] });
  const { dir, repo, env } = scratch('review');
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_GH: github.gh, AGENT_BOARD_PULL_REQUEST_POLL_MS: '200' });
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(2400, 1000));
    await showTileParts(window, ['chips']);
    // Capped at 1600px the window has no room for 120 columns and as much page beside them, so it fills the board.
    await fillWideScreen(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Write the code');
    const coder = tile(window).filter({ hasText: 'Write the code' });
    await expect(coder).toHaveAttribute('data-state', 'waiting');
    const [coderAgent] = await agents(window);
    const pr = (number: number, title: string, headRefName: string): FakeGitHubPullRequest => ({ repo: 'acme/app', state: 'OPEN', isDraft: false, statusCheckRollup: [], number, title, headRefName, author: 'octocat' });
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pr(41, 'Write the code', coderAgent!.branch), pr(60, 'Tidy the footer', 'footer')] });
    await expect.poll(async () => (await agents(window))[0]?.pullRequests.map((each) => each.number)).toEqual([41]);

    // Beside a PR on a screen with room for both, the terminal rests at 120 columns, counted by the terminal itself.
    await coder.dblclick();
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.keyboard.press(windowKey('k'));
    await spotlight(window).getByRole('combobox', { name }).fill('pr:60');
    await expect(spotlight(window).getByTestId('spotlight-row').first()).toContainText('Tidy the footer');
    await window.keyboard.press('Shift+Enter');
    await expect(panes(window)).toHaveCount(2);
    await expect(divider(window)).not.toHaveAttribute('data-ratio', '0.5');
    const columns = async () => (await window.evaluate(() => globalThis.window.agentBoard.sessions.list())).find((session) => session.id === coderAgent!.sessionId)?.cols ?? 0;
    await expect.poll(columns).toBeGreaterThanOrEqual(118);
    expect(await columns()).toBeLessThanOrEqual(122);

    // A review round, and its Review tab's Open PR beside: the findings in the focused pane, the PR in a pane beside them.
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await tileAction(coder, 'Review its work', 'Review & gate');
    await expect.poll(async () => (await window.evaluate(() => globalThis.window.agentBoard.reviews.list()))[0]?.status, { timeout: 30_000 }).toBe('ready');
    await coder.getByTestId('tile-review').click();
    await sessionWindow(window).getByTestId('review-open-pr-beside').click();
    await expect(panes(window)).toHaveCount(3);
    // A pane draws only its strip; what it shows is a surface of its own beside it, hidden while another tab shows.
    const showing = sessionWindow(window).locator('[data-testid="session-tab-view"]:not([hidden])');
    await expect(showing.filter({ has: window.getByTestId('review-viewer') }).getByTestId('review-verdict')).toContainText('Changes requested');
    // What each pane shows, from the left: the PR's is the one right of the findings'.
    const shown = await showing.evaluateAll((all) =>
      all
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
        .map((view) => (view.querySelector('[data-testid="review-viewer"]') !== null ? 'review' : (view.getAttribute('data-tab') ?? ''))),
    );
    expect(shown[shown.indexOf('review') + 1]).toBe('pr:acme/app#41');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
    github.dispose();
  }
});
