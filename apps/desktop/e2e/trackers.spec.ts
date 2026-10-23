import { expect, type Page } from '@playwright/test';
import { issueBranchName } from '@agent-board/tracker';
import { createFakeGitHub, FAKE_GITHUB_STATE, type FakeGitHubPullRequest, createTempKeychain } from '@agent-board/tracker/testing';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test, connectedDaemonPid, launchApp, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { agents, expectCardBesideTile, LINEAR_API_KEY, listFinishedTurns, serveLinearFixtures, setZoneTracker, tileAction, untilStarted } from './agent-helpers.ts';
import { scratch } from './scratch.ts';

const tile = (window: Page, sessionId: string) =>
  window.locator(`[data-testid="agent-tile"][data-session-id="${sessionId}"]`);

test('a zone connects to Linear, an agent starts from an issue on its branch, and another is linked to an issue', async () => {
  // The key goes to a throwaway keychain file, which only macOS has. Elsewhere the store is the user's own (the Secret
  // Service on Linux), which tests never touch.
  test.skip(process.platform !== 'darwin', 'needs a throwaway macOS keychain');
  // Only the fixtures' `subject` is relied on, so this holds however they were recorded.
  const { subject, interactions, server: linear } = await serveLinearFixtures();
  const { scope, knownIssue, searchTerm } = subject;
  const listed = interactions.find((i) => JSON.stringify(i.request.body).includes('issues(filter'))!.response.body as {
    data: { issues: { nodes: unknown[] } };
  };
  const branch = issueBranchName(knownIssue);
  const keychain = createTempKeychain();
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir, {
    ...env,
    AGENT_BOARD_LINEAR_API_URL: linear.url,
    AGENT_BOARD_KEYCHAIN: keychain.path,
  });
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);

    execFileSync('security', ['add-generic-password', '-s', 'agent-board', '-a', 'other-account', '-w', 'keep-me', keychain.path]);

    // Pick the zone's team: the first time, Linear wants an API key.
    const zoneTab = window.getByTestId('zone-tab');
    await zoneTab.getByRole('button', { name: 'Zone tracker' }).click();
    const trackerDialog = window.getByRole('dialog', { name: 'Zone tracker' });
    await trackerDialog.getByLabel('Linear API key').fill(LINEAR_API_KEY);
    await trackerDialog.getByRole('button', { name: 'Connect' }).click();
    await expect(trackerDialog.getByLabel('Linear team')).toHaveValue(scope);
    await trackerDialog.getByRole('button', { name: 'Save' }).click();
    await expect(trackerDialog).toBeHidden();
    await expect(zoneTab.getByRole('button', { name: 'Zone tracker' })).toHaveText(scope);

    // The key is in the keychain, and nowhere in the database.
    const stored = execFileSync(
      'security',
      ['find-generic-password', '-s', 'agent-board', '-a', 'linear', '-w', keychain.path],
      {
        encoding: 'utf8',
      },
    );
    expect(stored.trim()).toBe(LINEAR_API_KEY);
    for (const file of readdirSync(dataDir).filter((name) => name.includes('.db'))) {
      expect(readFileSync(join(dataDir, file)).includes(LINEAR_API_KEY)).toBe(false);
    }

    // The key can be taken out again: the dialog asks for one the next time, and the keychain no longer holds it.
    await zoneTab.getByRole('button', { name: 'Zone tracker' }).click();
    await trackerDialog.getByRole('button', { name: 'Disconnect' }).click();
    await expect(trackerDialog.getByLabel('Linear API key')).toBeVisible();
    // Only Linear's key went: another account's entry in the keychain stays.
    expect(
      execFileSync('security', ['find-generic-password', '-s', 'agent-board', '-a', 'other-account', '-w', keychain.path], { encoding: 'utf8' }).trim(),
    ).toBe('keep-me');
    expect(() =>
      execFileSync('security', ['find-generic-password', '-s', 'agent-board', '-a', 'linear', '-w', keychain.path], { stdio: 'pipe' }),
    ).toThrow();
    await trackerDialog.getByLabel('Linear API key').fill(LINEAR_API_KEY);
    await trackerDialog.getByRole('button', { name: 'Connect' }).click();
    await trackerDialog.getByRole('button', { name: 'Save' }).click();
    await expect(trackerDialog).toBeHidden();

    // Start an agent from an issue.
    await zoneTab.getByRole('button', { name: 'New agent' }).click();
    const newAgent = window.getByRole('dialog', { name: 'New agent' });
    const issues = newAgent.getByRole('listbox', { name: 'Issues' });
    await expect(issues.getByRole('option')).toHaveCount(listed.data.issues.nodes.length);
    await newAgent.getByLabel('Search issues').fill(searchTerm);
    await expect(issues.getByRole('option').first()).toContainText(knownIssue.id);
    await issues.getByRole('option').filter({ hasText: knownIssue.id }).click();
    // The pick stays shown whatever the list shows.
    await newAgent.getByLabel('Search issues').fill('');
    await expect(newAgent.getByTestId('selected-issue')).toContainText(knownIssue.id);
    await newAgent.getByRole('button', { name: 'Start' }).click();
    await expect(newAgent).toBeHidden();
    await untilStarted(window);

    const [fromIssue] = await agents(window);
    expect(fromIssue!.branch).toBe(branch);
    expect(branch).toMatch(new RegExp(`^${knownIssue.id.toLowerCase()}-`));
    expect(
      execFileSync('git', ['-C', fromIssue!.worktree, 'branch', '--show-current'], { encoding: 'utf8' }).trim(),
    ).toBe(fromIssue!.branch);
    const first = tile(window, fromIssue!.sessionId);
    await expect(first.getByTestId('tile-issue')).toContainText(knownIssue.id);
    // Its issue's card sits beside it, joined by the "issue brief" edge.
    await expectCardBesideTile(window, knownIssue.id, first);
    // Its title is the chip's tooltip.
    expect(await first.getByTestId('tile-issue').getAttribute('title')).toContain(knownIssue.title);

    // Link a second agent to the issue from its tile.
    await zoneTab.getByRole('button', { name: 'New agent' }).click();
    await newAgent.getByLabel('Task').fill('Look around');
    await newAgent.getByRole('button', { name: 'Start' }).click();
    await expect(newAgent).toBeHidden();
    await untilStarted(window);
    const second = (await agents(window)).find((agent) => agent.sessionId !== fromIssue!.sessionId)!;
    const secondTile = tile(window, second.sessionId);
    await expect(secondTile.getByTestId('tile-issue')).toHaveCount(0);
    await tileAction(secondTile, 'Link issue');
    const linkDialog = window.getByRole('dialog', { name: 'Link issue' });
    await linkDialog.getByRole('option').filter({ hasText: knownIssue.id }).click();
    await linkDialog.getByRole('button', { name: 'Link', exact: true }).click();
    await expect(linkDialog).toBeHidden();
    await expect(secondTile.getByTestId('tile-issue')).toContainText(knownIssue.id);
    // Its branch stays the one it started on.
    await expect(secondTile).toContainText(second.branch);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
    keychain.remove();
    await linear.close();
  }
});

test('a zone takes its issues from a GitHub repo through gh, an agent starts from one, and its tile shows its PRs', async () => {
  const github = createFakeGitHub();
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir, { ...env, AGENT_BOARD_GH: github.gh, AGENT_BOARD_PULL_REQUEST_POLL_MS: '200' });
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    // Its waiting pill, which sets how many PR chips fold, reads as needing you once Needs you lists finished turns.
    await listFinishedTurns(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);

    // GitHub never asks for a token: gh is already logged in.
    await setZoneTracker(
      window,
      'monorepo',
      async (dialog) => {
        await dialog.getByLabel('Tracker').selectOption('github');
        await dialog.getByLabel('GitHub repo').fill('Acme/App');
      },
      'acme/app',
    );

    await window.getByTestId('zone-tab').getByRole('button', { name: 'New agent' }).click();
    const newAgent = window.getByRole('dialog', { name: 'New agent' });
    const issues = newAgent.getByRole('listbox', { name: 'Issues' });
    await expect(issues.getByRole('option')).toHaveCount(2);
    await issues.getByRole('option').filter({ hasText: '#34' }).click();
    await newAgent.getByRole('button', { name: 'Start' }).click();
    await expect(newAgent).toBeHidden();
    await untilStarted(window);

    const [agent] = await agents(window);
    expect(agent!.branch).toBe('gh-34-fix-the-login-redirect');
    const agentTile = tile(window, agent!.sessionId);
    await expect(agentTile.getByTestId('tile-issue')).toContainText('#34');
    // GitHub zones get the card too, beside the tile.
    await expectCardBesideTile(window, '#34', agentTile);
    await expect(agentTile.getByTestId('tile-pr')).toHaveCount(0);

    // The agent opens a PR from its branch; its checks fail.
    const pullRequest = (number: number, fields: Partial<FakeGitHubPullRequest> = {}): FakeGitHubPullRequest => ({
      repo: 'acme/app',
      number,
      title: 'Fix the login redirect',
      headRefName: agent!.branch,
      state: 'OPEN',
      isDraft: false,
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'check', status: 'COMPLETED', conclusion: 'FAILURE' }],
      ...fields,
    });
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest(41)] });
    const pr = agentTile.getByTestId('tile-pr');
    await expect(pr).toHaveText('#41');
    await expect(pr).toHaveAttribute('data-state', 'open');
    await expect(pr).toHaveAttribute('data-checks', 'failing');

    // Clicking it opens the PR in a PR tab of the agent's window (pr-tab.spec.ts), whose GitHub button opens it in the
    // browser (stubbed here). The window stays open over the tile: what follows reads the tile's chips, not clicks them.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { opened?: string[] }).opened = opened;
      shell.openExternal = async (url: string) => void opened.push(url);
    });
    await pr.click();
    const prView = window.getByTestId('pr-view');
    await prView.getByRole('button', { name: 'GitHub' }).click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened))
      .toEqual(['https://github.com/acme/app/pull/41']);

    // The footer is one line: the first PR fits on the tile with its issue; the others fold into its +N.
    github.setState({
      ...FAKE_GITHUB_STATE,
      pullRequests: [pullRequest(44, { isDraft: true }), pullRequest(43, { state: 'MERGED' }), pullRequest(41)],
    });
    await expect(agentTile.getByTestId('tile-pr')).toHaveText(['#44', '#43']);
    await expect(agentTile.getByTestId('tile-folded')).toHaveText('+2');
    await expect(agentTile.getByTestId('tile-folded')).toHaveAttribute('title', /^#43 .*\n#41 /s);

    // The agent commits and pushes onto another branch's PR, as a fix agent cut from it does: its tile shows
    // that PR, marked as pushed to, open and once merged. It is only shown: the agent has no PR of its own to merge.
    const inWorktree = (...args: string[]) => execFileSync('git', ['-C', agent!.worktree, ...args]);
    const mirror = join(dir, 'mirror.git');
    inWorktree('init', '--quiet', '--bare', mirror);
    inWorktree('remote', 'add', 'mirror', mirror);
    inWorktree('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'fix');
    inWorktree('push', '--quiet', 'mirror', 'HEAD:gh-30-the-original-fix');
    const pushedTo = pullRequest(30, { headRefName: 'gh-30-the-original-fix', statusCheckRollup: [] });
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pushedTo] });
    await expect(agentTile.getByTestId('tile-pr')).toHaveText(['#30']);
    await expect(agentTile.getByTestId('tile-pr')).toHaveAttribute('data-state', 'open');
    await expect(agentTile.getByTestId('tile-pr')).toHaveAttribute('data-pushed', 'true');
    await expect(agentTile.getByTestId('tile-pr')).toHaveAttribute('aria-label', 'Pushed to pull request #30, open, no checks');
    expect((await agents(window))[0]!.pullRequests).toEqual([]);
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [{ ...pushedTo, state: 'MERGED' }] });
    await expect(agentTile.getByTestId('tile-pr')).toHaveAttribute('data-state', 'merged');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
    github.dispose();
  }
});
