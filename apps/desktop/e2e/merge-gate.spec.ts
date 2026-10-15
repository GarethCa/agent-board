import { expect, type Page } from '@playwright/test';
import { createFakeGitHub, FAKE_GITHUB_STATE, type FakeGitHubPullRequest } from '@agent-board/tracker/testing';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agents, launch, sessionWindow, spawnAgent, tile, tileAction, TURN_MS, zoneNamed } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

/** The fake gate command (fixtures/gate): its steps pass, fail or stream as its mode says. Never a repo's real checks. */
const FAKE_GATE = fileURLToPath(new URL('../../../fixtures/gate/fake-gate.sh', import.meta.url));
const gateCommand = (mode: string) => `sh '${FAKE_GATE}' ${mode}`;

const tabNamed = (page: Page, name: string) => sessionWindow(page).getByTestId('session-tab').filter({ has: page.getByRole('tab', { name, exact: true }) });
const gateView = (page: Page) => sessionWindow(page).getByTestId('gate-view');
const header = (page: Page) => sessionWindow(page).getByRole('group', { name: 'Merge gate' });

/** Sets the zone's gate command from its tab's More menu. */
async function setGateCommand(page: Page, command: string): Promise<void> {
  await zoneNamed(page, 'monorepo').getByRole('button', { name: 'Zone options' }).click();
  await page.getByRole('menuitem', { name: /gate command/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Gate command' });
  await dialog.getByRole('textbox').fill(command);
  await dialog.getByTestId('gate-command-save').click();
  await expect(dialog).toBeHidden();
}

/** Sets the zone's gate command behind the board's back, as another window would. */
const configureGate = (page: Page, zoneId: string, command: string) =>
  page.evaluate(([id, gate]) => window.agentBoard.zones.configure(id, { gateCommand: gate }), [zoneId, command] as const);

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

test("an agent's merge gate: run in its worktree into a Gate tab, its failure sent to it, then Open PR from its handover, and Merge once the gate and GitHub are green", async () => {
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [] });
  const { dir, repo, env } = scratch('waiting');
  // gh names acme/app from origin; pushes go to a bare repo here, never GitHub.
  const bare = join(dir, 'origin.git');
  execFileSync('git', ['init', '--quiet', '--bare', bare]);
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  git(repo, 'remote', 'set-url', '--push', 'origin', bare);
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, TMPDIR: dir, AGENT_BOARD_GH: github.gh, AGENT_BOARD_PULL_REQUEST_POLL_MS: '200' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);

    // It runs through sh -c, so a chained command may be saved.
    await zoneNamed(window, 'monorepo').getByRole('button', { name: 'Zone options' }).click();
    await window.getByRole('menuitem', { name: 'Set a gate command…' }).click();
    const dialog = window.getByRole('dialog', { name: 'Gate command' });
    await dialog.getByRole('textbox').fill('pnpm lint && pnpm test');
    await expect(dialog).toContainText('It runs through sh -c, so && and pipes work.');
    await expect(dialog.getByTestId('gate-command-save')).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await setGateCommand(window, gateCommand('fail'));

    await spawnAgent(window, 'monorepo', 'Validate the cart');
    const [agent] = await agents(window);
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    writeFileSync(join(agent!.worktree, 'cart.ts'), 'export const validated = true;\n');
    git(agent!.worktree, 'add', '.');
    git(agent!.worktree, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'Validate the cart');
    const head = git(agent!.worktree, 'rev-parse', 'HEAD');
    mkdirSync(join(agent!.worktree, '.agent-board'));
    writeFileSync(join(agent!.worktree, '.agent-board', 'handover.md'), '## Problem\n\nCheckout was flaky.\n\n## Change\n\nThe cart is validated first.\n');

    // Nothing runs by itself: its window offers Run gate, and Open PR waits for it, saying why.
    await tile(window).dblclick();
    await expect(header(window).getByTestId('header-run-gate')).toBeVisible();
    await expect(header(window).getByTestId('header-open-pr')).toBeDisabled();
    await expect(header(window).getByTestId('header-open-pr')).toHaveAttribute('data-why', 'Run the gate first: the PR carries its table for the head commit.');

    // ⌘⇧G runs it into a Gate tab in the focused pane: its steps, e2e failing, with its last lines.
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+KeyG' : 'Control+Shift+KeyG');
    await expect(tabNamed(window, 'Gate')).toHaveAttribute('data-active', 'true');
    await expect(gateView(window).getByTestId('gate-headline')).toContainText('Failed: 2 of 3 passed');
    await expect(gateView(window).getByTestId('gate-step')).toHaveText([/lint\s*pass/, /test\s*pass/, /e2e\s*FAIL/]);
    await expect(gateView(window).getByTestId('gate-log')).toContainText('Expected "Out of stock" to be visible');
    await expect(gateView(window).getByTestId('gate-meta')).toContainText(head.slice(0, 7));
    await expect(tile(window).getByTestId('tile-gate')).toHaveText('✗ gate · e2e');
    // A step's own log, picked from the table, and one that came from the file it named.
    await gateView(window).getByTestId('gate-step').filter({ hasText: 'test' }).click();
    await expect(gateView(window).getByTestId('gate-log')).toContainText('✓ src/case-3.test.ts');

    // Send failure pastes it at the agent's prompt, unsent, and shows the agent's own tab.
    await gateView(window).getByTestId('gate-send-failure').click();
    await expect(tabNamed(window, 'claude')).toHaveAttribute('data-active', 'true');
    await expect(sessionWindow(window).getByTestId('session-terminal')).toContainText('failed on', { timeout: TURN_MS });

    // Passing now (the zone's command changed behind the window), run from the tile's More menu: Open PR is enabled.
    await configureGate(window, agent!.zoneId!, gateCommand('pass'));
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await tileAction(tile(window), 'Run gate');
    await expect(gateView(window).getByTestId('gate-headline')).toContainText('Passed: 3 of 3');
    await expect(tile(window).getByTestId('tile-gate')).toHaveText('✓ gate 3/3');
    const openPr = header(window).getByTestId('header-open-pr');
    await expect(openPr).toBeEnabled();

    // Open PR pushes the branch and opens one from the template and the handover, with the gate table; then Merge.
    await openPr.click();
    await expect(header(window).getByTestId('header-merge')).toBeVisible({ timeout: TURN_MS });
    expect(git(bare, 'rev-parse', `refs/heads/${agent!.branch}`)).toBe(head);
    const create = github.calls().find((call) => call.args[0] === 'pr' && call.args[1] === 'create')!;
    expect(create.stdin).toContain('The cart is validated first.');
    expect(create.stdin).toContain(`on \`${head.slice(0, 7)}\``);

    // The PR tab it opens on merges too, the gate having passed on its head.
    const prView = sessionWindow(window).getByTestId('pr-view');
    await expect(prView.getByTestId('pr-merge')).toBeEnabled({ timeout: TURN_MS });
    await expect(prView).not.toContainText("gate hasn't passed");
    // Pushed to since, its head is one the gate never saw: Merge says so, and asks plainly before going past the gate.
    const passedState = github.state();
    github.setState({ ...passedState, pullRequests: passedState.pullRequests.map((pr): FakeGitHubPullRequest => ({ ...pr, headRefOid: 'c'.repeat(40) })) });
    await prView.getByTestId('pr-refresh').click();
    await expect(prView.getByTestId('pr-not-allowed')).toContainText("Validate the cart's gate hasn't passed on this head", { timeout: TURN_MS });
    await prView.getByTestId('pr-merge').click();
    await expect(window.getByTestId('pr-past-gate')).toContainText("The gate hasn't passed on ccccccc, this pull request's head");
    await expect(window.getByTestId('pr-confirm')).toHaveText('Merge past the gate');
    await window.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    expect(github.calls().some((call) => call.args[1] === 'merge')).toBe(false);
    github.setState(passedState);
    await prView.getByTestId('pr-refresh').click();
    await expect(prView).not.toContainText("gate hasn't passed", { timeout: TURN_MS });

    // While GitHub's checks run, Merge says so and can't be pressed.
    const setChecks = (status: string, conclusion: string) => {
      const state = github.state();
      github.setState({
        ...state,
        pullRequests: state.pullRequests.map((pr): FakeGitHubPullRequest => ({ ...pr, statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status, conclusion }] })),
      });
    };
    setChecks('IN_PROGRESS', '');
    const popover = window.getByTestId('merge-popover');
    // Opening it reads the PR again, unless a read from before the checks changed is still under way: open it until it
    // shows them, as a user would look again.
    await expect(async () => {
      if (await popover.isVisible()) await window.keyboard.press('Escape');
      await header(window).getByTestId('header-merge').click();
      await expect(popover.getByTestId('merge-why')).toHaveText("GitHub's checks: build is still running.", { timeout: 1000 });
    }).toPass({ timeout: TURN_MS });
    await expect(popover.getByTestId('merge-gate-condition')).toContainText(`Gate passed on ${head.slice(0, 7)} (head)`);
    await expect(popover.getByTestId('merge-confirm')).toBeDisabled();
    await window.keyboard.press('Escape');

    // Green: confirmed, it squash-merges the head the gate passed on, and cleans up as ticked.
    setChecks('COMPLETED', 'SUCCESS');
    await expect(async () => {
      if (await popover.isVisible()) await window.keyboard.press('Escape');
      await header(window).getByTestId('header-merge').click();
      await expect(popover.getByTestId('merge-confirm')).toBeEnabled({ timeout: 1000 });
    }).toPass({ timeout: TURN_MS });
    await expect(popover.getByRole('checkbox', { name: /Close/ })).toBeChecked();
    await expect(popover.getByRole('checkbox', { name: /Comment/ })).toBeDisabled();
    await popover.getByTestId('merge-confirm').click();
    await expect(window.getByText(`Merged #35 into main. Closed Validate the cart, removed its worktree, deleted ${agent!.branch}.`)).toBeVisible({ timeout: TURN_MS });
    expect(github.calls().map((call) => call.args.join(' '))).toContain(`pr merge 35 --repo acme/app --squash --match-head-commit ${head}`);
    await expect(tile(window)).toHaveCount(0);
    expect(git(repo, 'branch', '--list', agent!.branch)).toBe('');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    github.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("someone else's pull request: the header offers Approve, at the commit shown, not Merge", async () => {
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [] });
  const { dir, repo, env } = scratch('waiting');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_GH: github.gh, AGENT_BOARD_PULL_REQUEST_POLL_MS: '200' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Review the cart');
    const [agent] = await agents(window);
    github.setState({
      ...FAKE_GITHUB_STATE,
      pullRequests: [{ repo: 'acme/app', number: 41, title: 'Validate the cart', headRefName: agent!.branch, headRefOid: 'b'.repeat(40), state: 'OPEN', isDraft: false, statusCheckRollup: [], author: 'maria' }],
    });
    await expect(tile(window).getByTestId('tile-pr')).toHaveText('#41', { timeout: TURN_MS });

    await tile(window).dblclick();
    await expect(header(window).getByTestId('header-approve')).toBeVisible({ timeout: TURN_MS });
    await expect(header(window).getByTestId('header-merge')).toHaveCount(0);
    await header(window).getByTestId('header-approve').click();
    await window.getByTestId('header-approve-confirm').click();
    await expect.poll(() => github.calls().find((call) => call.args.includes('POST'))?.args).toContain(`commit_id=${'b'.repeat(40)}`);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    github.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a zone with no gate: Open PR and Merge in the window's and the expanded tile's header, Merge waiting for GitHub alone", async () => {
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [] });
  const { dir, repo, env } = scratch('waiting');
  const bare = join(dir, 'origin.git');
  execFileSync('git', ['init', '--quiet', '--bare', bare]);
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  git(repo, 'remote', 'set-url', '--push', 'origin', bare);
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_GH: github.gh, AGENT_BOARD_PULL_REQUEST_POLL_MS: '200' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Tidy the docs');
    const [agent] = await agents(window);
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    writeFileSync(join(agent!.worktree, 'docs.md'), '# Docs\n');
    git(agent!.worktree, 'add', '.');
    git(agent!.worktree, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'Tidy the docs');
    const head = git(agent!.worktree, 'rev-parse', 'HEAD');

    // Its expanded tile's header has them too.
    await tile(window).getByRole('button', { name: 'Expand' }).click();
    const expanded = window.getByTestId('expanded-tile').getByRole('group', { name: 'Merge gate' });
    await expect(expanded.getByTestId('header-open-pr')).toBeEnabled({ timeout: TURN_MS });
    await expect(expanded.getByTestId('header-run-gate')).toHaveCount(0);
    await window.getByTestId('expanded-tile').getByRole('button', { name: 'Collapse' }).click();

    // No gate to run first: Open PR opens it at once, with no gate table.
    await tile(window).dblclick();
    await header(window).getByTestId('header-open-pr').click();
    await expect(header(window).getByTestId('header-merge')).toBeVisible({ timeout: TURN_MS });
    expect(github.calls().find((call) => call.args[0] === 'pr' && call.args[1] === 'create')!.stdin).not.toContain('Gate `');
    // Its own PR tab still merges: no gate guards it.
    await expect(sessionWindow(window).getByTestId('pr-view').getByTestId('pr-merge')).toBeEnabled({ timeout: TURN_MS });

    // Merge says there is no gate, and waits for GitHub's checks alone.
    const state = github.state();
    github.setState({ ...state, pullRequests: state.pullRequests.map((pr): FakeGitHubPullRequest => ({ ...pr, statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }] })) });
    const popover = window.getByTestId('merge-popover');
    await expect(async () => {
      if (await popover.isVisible()) await window.keyboard.press('Escape');
      await header(window).getByTestId('header-merge').click();
      await expect(popover.getByTestId('merge-confirm')).toBeEnabled({ timeout: 1000 });
    }).toPass({ timeout: TURN_MS });
    await expect(popover.getByTestId('merge-no-gate')).toHaveText("This zone has no gate: set one in the zone's ⋯ menu.");
    await expect(popover.getByTestId('merge-gate-condition')).toHaveCount(0);
    await popover.getByTestId('merge-confirm').click();
    await expect(tile(window)).toHaveCount(0, { timeout: TURN_MS });
    expect(github.calls().map((call) => call.args.join(' '))).toContain(`pr merge 35 --repo acme/app --squash --match-head-commit ${head}`);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    github.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
