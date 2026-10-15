import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { createFakeGitHub, FAKE_GITHUB_STATE, type FakeGitHubPullRequest } from '@agent-board/tracker/testing';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { agents, launch, sessionWindow, showDetails, spawnAgent, tile } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

const tabs = (page: Page) => sessionWindow(page).getByTestId('session-tab');
const tabNamed = (page: Page, name: string) => tabs(page).filter({ has: page.getByRole('tab', { name, exact: true }) });
const prView = (page: Page) => sessionWindow(page).getByTestId('pr-view');

/** Sends every link the app opens in the OS browser to a list instead, read back with `opened`. */
async function stubBrowser(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { opened?: string[] }).opened = opened;
    shell.openExternal = async (url: string) => void opened.push(url);
  });
}
const opened = (app: ElectronApplication) => app.evaluate(() => (globalThis as { opened?: string[] }).opened);

test("an agent's PR chip opens a PR tab: its description, checks, files and comments, Approve and Merge once allowed and confirmed; it drags to split, is kept across a restart and is read only while it shows", async () => {
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [] });
  const { dir, repo, env } = scratch('waiting');
  // gh finds the agent's pull requests in the repo its worktree's remote names.
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  const dataDir = tempDataDir();
  const appEnv = { ...env, AGENT_BOARD_GH: github.gh, AGENT_BOARD_PULL_REQUEST_POLL_MS: '200' };
  let { app, window } = await launch(dataDir, appEnv);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Fix the login redirect');
    const [agent] = await agents(window);

    const pullRequest = (fields: Partial<FakeGitHubPullRequest> = {}): FakeGitHubPullRequest => ({
      repo: 'acme/app',
      number: 41,
      title: 'Send users home after login',
      headRefName: agent!.branch,
      headRefOid: 'b'.repeat(40),
      state: 'OPEN',
      isDraft: false,
      body: 'Fixes the **blank page**. See [the issue](https://github.com/acme/app/issues/34).\n\n<img src="https://example.com/x.png" onerror="alert(1)">',
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/app/actions/runs/1' },
        { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: '' },
      ],
      files: [{ filename: 'src/login.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,2 +1,2 @@\n-redirect("/blank")\n+redirect("/home")\n export {};' }],
      comments: [{ author: 'monalisa', body: 'Looks close.', createdAt: '2026-10-01T09:00:00Z' }],
      reviewComments: [{ id: 9, author: 'monalisa', path: 'src/login.ts', line: 1, body: 'Why home?', createdAt: '2026-10-01T10:00:00Z' }],
      ...fields,
    });
    // GitHub's rate limit is reached as the agent opens a draft PR.
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest({ isDraft: true })] });
    const chip = tile(window).getByTestId('tile-pr');
    await expect(chip).toHaveText('#41');
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest({ isDraft: true })], rateLimited: true });

    // Its chip opens its window on a PR tab, which says why it can't read it.
    await chip.click();
    await expect(tabNamed(window, 'PR #41')).toHaveAttribute('data-active', 'true');
    await expect(prView(window).getByTestId('pr-error')).toContainText(/rate limit/i);

    // Refresh reads it again: a draft can't be approved or merged, and says so.
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest({ isDraft: true })] });
    await prView(window).getByTestId('pr-refresh').click();
    await expect(prView(window).getByTestId('pr-title')).toContainText('Send users home after login');
    await expect(prView(window).getByTestId('pr-error')).toHaveCount(0);
    await expect(prView(window).getByTestId('pr-state')).toHaveText('Draft');
    await expect(prView(window).getByTestId('pr-not-allowed')).toHaveText('It is a draft.');
    await expect(prView(window).getByTestId('pr-approve')).toHaveCount(0);
    await expect(prView(window).getByTestId('pr-merge')).toHaveCount(0);

    // Its description is Markdown, with no HTML in it loaded, and its links go to the browser.
    const description = prView(window).getByTestId('pr-description');
    await expect(description.locator('strong')).toHaveText('blank page');
    await expect(prView(window).locator('img')).toHaveCount(0);
    await stubBrowser(app);
    await description.getByRole('link', { name: 'the issue' }).click();
    await expect.poll(() => opened(app)).toEqual(['https://github.com/acme/app/issues/34']);

    // Its checks, its files each with a diff, and its comments, one on a line of the diff.
    await expect(prView(window).getByTestId('pr-check')).toHaveText(['test', 'lint']);
    await expect(prView(window).getByTestId('pr-check').first()).toHaveAttribute('data-state', 'passing');
    await expect(prView(window).getByTestId('pr-file')).toContainText('src/login.ts');
    await expect(prView(window).getByTestId('pr-diff').locator('tr[data-kind="addition"]')).toContainText('redirect("/home")');
    await expect(prView(window).getByTestId('pr-diff').locator('tr[data-kind="deletion"]')).toContainText('redirect("/blank")');
    await expect(prView(window).getByTestId('pr-comment')).toHaveCount(2);
    await expect(prView(window).getByTestId('pr-comment').nth(1)).toContainText('src/login.ts:1');

    // Ready for review: Approve asks first, and Cancel does nothing.
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest()] });
    await prView(window).getByTestId('pr-refresh').click();
    await prView(window).getByTestId('pr-approve').click();
    const confirm = window.getByRole('alertdialog', { name: 'Approve #41?' });
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    expect(github.calls().some((call) => call.args.includes('POST'))).toBe(false);
    await prView(window).getByTestId('pr-approve').click();
    await window.getByRole('alertdialog', { name: 'Approve #41?' }).getByTestId('pr-confirm').click();
    await expect(prView(window).getByTestId('pr-review')).toContainText('octocat approved');
    // At the commit shown, so nothing pushed since is approved.
    expect(github.calls().find((call) => call.args.includes('POST'))?.args).toContain(`commit_id=${'b'.repeat(40)}`);

    // Merge asks too, and merges only the commit shown.
    await prView(window).getByTestId('pr-merge').click();
    await window.getByRole('alertdialog', { name: 'Merge #41?' }).getByTestId('pr-confirm').click();
    await expect(prView(window).getByTestId('pr-state')).toHaveText('Merged');
    await expect(prView(window).getByTestId('pr-merge')).toHaveCount(0);
    expect(github.calls().find((call) => call.args[1] === 'merge')?.args).toEqual(['pr', 'merge', '41', '--repo', 'acme/app', '--squash', '--match-head-commit', 'b'.repeat(40)]);
    // The tile hears of it at once.
    await expect(chip).toHaveAttribute('data-state', 'merged');

    // Its row in the window's details shows the tab already open, not a second one.
    await tabNamed(window, 'claude').getByRole('tab').click();
    await showDetails(sessionWindow(window));
    await sessionWindow(window).getByRole('button', { name: /#41 Send users home after login/ }).click();
    await expect(tabNamed(window, 'PR #41')).toHaveCount(1);
    await expect(tabNamed(window, 'PR #41')).toHaveAttribute('data-active', 'true');

    // Left behind the agent's own tab, it is kept across a restart, and isn't read until it shows.
    await tabNamed(window, 'claude').getByRole('tab').click();
    await app.close();
    const before = github.calls().filter((call) => call.args[1] === 'view' && call.args[0] === 'pr').length;
    ({ app, window } = await launch(dataDir, appEnv));
    // The window open when it quit opens again, with its tabs as they were.
    await expect(tabNamed(window, 'PR #41')).toHaveCount(1);
    await expect(tabNamed(window, 'PR #41')).not.toHaveAttribute('data-active', 'true');
    await expect(tabNamed(window, 'claude')).toHaveAttribute('data-active', 'true');
    // The watcher reads the agent's pull requests meanwhile, but not the PR tab's.
    await expect(tile(window).getByTestId('tile-pr')).toHaveAttribute('data-state', 'merged');
    expect(github.calls().filter((call) => call.args[1] === 'view' && call.args[0] === 'pr').length).toBe(before);
    await tabNamed(window, 'PR #41').getByRole('tab').click();
    await expect(prView(window).getByTestId('pr-state')).toHaveText('Merged');
    expect(github.calls().filter((call) => call.args[1] === 'view' && call.args[0] === 'pr').length).toBe(before + 1);

    // It drags onto its pane's right edge like any tab, splitting the window: a pane of its own.
    const page = window;
    const view = sessionWindow(page).locator('[data-testid="session-tab-view"]:not([hidden])');
    const box = (await view.boundingBox())!;
    const from = (await tabNamed(page, 'PR #41').boundingBox())!;
    await page.mouse.move(from.x + Math.min(20, from.width / 2), from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2, { steps: 16 });
    await page.mouse.up();
    await expect(sessionWindow(page).getByTestId('window-pane')).toHaveCount(2);
    await expect(sessionWindow(page).getByTestId('window-pane').nth(1).getByTestId('session-tab')).toHaveText(['PR #41']);
    await expect(prView(page).getByTestId('pr-state')).toHaveText('Merged');

    // It closes like any tab, and the + menu offers it again.
    await tabNamed(window, 'PR #41').getByRole('button', { name: /Close/ }).click();
    await expect(tabNamed(window, 'PR #41')).toHaveCount(0);
    await sessionWindow(window).getByRole('button', { name: 'New tab' }).click();
    await window.getByRole('menuitem', { name: '#41 Send users home after login' }).click();
    await expect(tabNamed(window, 'PR #41')).toHaveAttribute('data-active', 'true');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
    github.dispose();
  }
});
