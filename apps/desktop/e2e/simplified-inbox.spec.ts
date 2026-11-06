import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { Agent } from '@agent-board/daemon/protocol';
import type { FakeScenario } from '@agent-board/fake-harness';
import { createFakeGitHub, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agents, launch, sessionWindow, spawnAgent, TURN_MS } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// Under the Simplified design the Needs-you pane lists what waits on the user in sections (what continues the work,
// what reaches out, changes ready to accept, problems), one row pattern for every kind, and a permission prompt reads as the pane's card does, with its buttons. The fake claude plays `orchestrate`:
// `Run: pnpm test | Run the test suite` asks to run a plain command and says whether it ran, `Ask permission` asks to
// `rm -rf dist` (destructive), and `Ask: …` asks a question with choices.

const row = (window: Page, agent: Agent) => window.locator(`[data-testid="inbox-item"][data-session-id="${agent.sessionId}"]`);
const latest = async (window: Page, agent: Agent) => (await agents(window)).find((each) => each.sessionId === agent.sessionId)!;

async function spawn(window: Page, prompt: string): Promise<Agent> {
  const before = await agents(window);
  await spawnAgent(window, 'monorepo', prompt);
  return (await agents(window)).find((agent) => !before.some((known) => known.sessionId === agent.sessionId))!;
}

/** Opens the docked pane on its Needs-you list, if it isn't open on it already. */
async function openList(window: Page): Promise<void> {
  const list = window.getByTestId('master-panel').getByTestId('needs-you-inbox');
  if (!(await list.isVisible())) await window.getByTestId('inbox-count').click();
  await expect(list).toBeVisible();
}

async function withApp(
  scenario: FakeScenario,
  body: (window: Page, app: ElectronApplication) => Promise<void>,
  extra: { env?: Record<string, string>; repo?(repo: string): void } = {},
): Promise<void> {
  const setup = scratch(scenario);
  extra.repo?.(setup.repo);
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...setup.env, FAKE_HARNESS_PERMISSION_SUGGESTIONS: '1', ...extra.env }, [], { design: 'simplified' });
  try {
    await pickFolderNext(app, setup.repo);
    await browseForZone(window);
    await body(window, app);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(setup.dir, { recursive: true, force: true });
  }
}

test("a permission answered from the list reaches the harness: it reads as the pane's sentence, labelled with its zone, and Allow once runs it", async () => {
  await withApp('orchestrate', async (window) => {
    const agent = await spawn(window, 'Run: pnpm test | Run the test suite');
    await openList(window);
    const group = window.getByTestId('inbox-group');
    await expect(group).toHaveCount(1);
    await expect(group.locator('.inbox-group-name')).toHaveText('Continues the work');
    await expect(group.locator('.inbox-group-count')).toHaveText('1');

    const asking = row(window, agent);
    await expect(asking.getByTestId('inbox-zone')).toHaveText('monorepo');
    await expect(asking).toHaveAttribute('data-kind', 'permission');
    await expect(asking.getByTestId('inbox-permission-sentence')).toHaveText('Asks permission to run a command: run the test suite');
    await expect(asking.getByTestId('inbox-tool-input')).toHaveText('pnpm test');
    await expect(asking.getByTestId('permission-wait')).toHaveText('Its terminal asks too.');
    await expect(asking.locator('.inbox-item-actions').getByRole('button')).toHaveText(['Deny', 'Allow once', 'Allow pnpm test for this session']);

    // Return on the row opens its agent and answers nothing.
    await asking.focus();
    await window.keyboard.press('Enter');
    await expect(sessionWindow(window)).toBeVisible();
    expect((await latest(window, agent)).permissions).toHaveLength(1);
    await sessionWindow(window).getByRole('button', { name: `Done, close ${agent.name}` }).click();
    await expect(sessionWindow(window)).toHaveCount(0);

    await openList(window);
    const allow = asking.getByRole('button', { name: 'Allow once' });
    await expect(allow).toBeEnabled();
    await allow.click();
    await expect.poll(async () => (await latest(window, agent)).lastMessage).toContain('Ran pnpm test.');
    expect((await latest(window, agent)).permissions).toHaveLength(0);
    await expect(asking).toHaveCount(0);
  });
});

test('a question is answered from its row by the number its choice shows, reached with the arrow keys', async () => {
  await withApp('orchestrate', async (window) => {
    const first = await spawn(window, 'Run: pnpm test | Run the test suite');
    await expect.poll(async () => (await latest(window, first)).permissions).toHaveLength(1);
    const agent = await spawn(window, 'Ask: Which database? | Postgres | SQLite');
    await expect.poll(async () => (await latest(window, agent)).ask).not.toBeNull();
    await openList(window);
    await row(window, first).focus();
    await window.keyboard.press('ArrowDown');
    await expect(row(window, agent)).toBeFocused();
    await window.keyboard.press('2');
    await expect.poll(async () => (await latest(window, agent)).ask).toBeNull();
    await expect.poll(async () => (await latest(window, agent)).lastMessage).toContain('SQLite');
    // The permission above it is left as it was.
    expect((await latest(window, first)).permissions).toHaveLength(1);
  });
});

test('a destructive command has Deny and Review… only, and Deny reaches the harness', async () => {
  await withApp('permission', async (window) => {
    const agent = await spawn(window, 'Clean up');
    await openList(window);
    const asking = row(window, agent);
    await expect(asking.getByTestId('inbox-permission-sentence')).toHaveText('Asks permission to run a command: remove build output');
    await expect(asking.getByTestId('inbox-tool-input')).toHaveText('rm -rf dist');
    await expect(asking.locator('.inbox-item-actions').getByRole('button')).toHaveText(['Deny', 'Review…']);
    await expect(asking.getByTestId('permission-warning')).toHaveText('This can’t be undone.');

    const deny = asking.getByRole('button', { name: 'Deny' });
    await expect(deny).toBeEnabled();
    await deny.click();
    await expect.poll(async () => (await latest(window, agent)).lastMessage).toContain('Okay, I left dist alone.');
  });
});

test('Review… on a destructive command lets its terminal ask, and opens the agent there', async () => {
  await withApp('permission', async (window) => {
    const agent = await spawn(window, 'Clean up');
    await openList(window);
    const asking = row(window, agent);
    const review = asking.getByRole('button', { name: 'Review…' });
    await expect(review).toBeEnabled();
    await review.click();
    await expect(sessionWindow(window)).toBeVisible();
    // Review… promises the terminal, so it is shown (the window opens on the chat by default), not just drawn in a hidden pane.
    await expect(sessionWindow(window).getByTestId('session-terminal')).toBeVisible();
    await expect(sessionWindow(window).getByTestId('session-terminal')).toContainText('(y/n)');
    // Nothing is answered: the prompt stays, no longer held, for the terminal to take.
    // The release reaches the board's state a moment after the window opens, so wait for it.
    await expect.poll(async () => (await latest(window, agent)).permissions).toMatchObject([{ heldUntil: null }]);
  });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/** Starts an agent on `waiting`, commits a change in its worktree and opens its pull request #35, green, on the fake GitHub. */
async function withChanges(body: (window: Page, agent: Agent, head: string, merges: () => string[]) => Promise<void>): Promise<void> {
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [] });
  try {
    await withApp(
      'waiting',
      async (window) => {
        const agent = await spawn(window, 'Tidy the docs');
        await expect.poll(async () => (await latest(window, agent)).state, { timeout: TURN_MS }).toBe('waiting');
        writeFileSync(join(agent.worktree, 'docs.md'), '# Docs\n');
        git(agent.worktree, 'add', '.');
        git(agent.worktree, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'Tidy the docs');
        const head = git(agent.worktree, 'rev-parse', 'HEAD');
        github.setState({
          ...FAKE_GITHUB_STATE,
          pullRequests: [
            {
              repo: 'acme/app',
              number: 35,
              title: 'Tidy the docs',
              headRefName: agent.branch,
              headRefOid: head,
              state: 'OPEN',
              isDraft: false,
              statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
              author: 'octocat',
            },
          ],
        });

        await openList(window);
        await expect(row(window, agent)).toHaveAttribute('data-kind', 'accept', { timeout: TURN_MS });
        await body(window, agent, head, () => github.calls().map((call) => call.args.join(' ')).filter((call) => call.startsWith('pr merge')));
      },
      {
        // The moment Undo has, shortened from 10 s for the test.
        env: { AGENT_BOARD_GH: github.gh, AGENT_BOARD_PULL_REQUEST_POLL_MS: '200', AGENT_BOARD_ACCEPT_AFTER_MS: String(ACCEPT_MS) },
        repo: (repo) => git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git'),
      },
    );
  } finally {
    github.dispose();
  }
}

const ACCEPT_MS = 1_500;

test('changes ready to accept: Accept changes waits a moment, Undo then merges nothing, and left alone it merges at the commit shown', async () => {
  await withChanges(async (window, agent, head, merges) => {
    const ready = row(window, agent);
    await expect(window.getByTestId('inbox-group').filter({ has: ready }).locator('.inbox-group-name')).toHaveText('Ready for you to accept');
    // Its title is its name here, so the line doesn't say it twice.
    await expect(ready.getByTestId('inbox-accept-line')).toHaveText('Pull request #35 is ready to merge.');
    const accept = ready.getByRole('button', { name: `Accept ${agent.name}'s changes` });
    await expect(accept).toBeEnabled({ timeout: TURN_MS });
    await expect(ready.getByTestId('inbox-accept-why')).toHaveText(`Squash-merges it, then closes ${agent.name}, removes its worktree and deletes ${agent.branch}.`);

    // Undo inside the moment: nothing is merged, and Accept is back.
    await accept.click();
    await expect(ready.getByTestId('inbox-accept-wait')).toContainText('Merging in');
    await ready.getByRole('button', { name: `Undo accepting ${agent.name}'s changes` }).click();
    await expect(accept).toBeEnabled();
    await window.waitForTimeout(ACCEPT_MS + 1_000);
    expect(merges()).toEqual([]);

    // Left alone, it merges at the commit shown, with the clean-up last used here (all of it, the first time).
    await accept.click();
    await expect.poll(merges, { timeout: TURN_MS }).toEqual([`pr merge 35 --repo acme/app --squash --match-head-commit ${head}`]);
    await expect(ready).toHaveCount(0, { timeout: TURN_MS });
  });
});

test('an accept is dropped, merging nothing, when the agent is sent more work before its moment comes', async () => {
  await withChanges(async (window, agent, _head, merges) => {
    const ready = row(window, agent);
    const accept = ready.getByRole('button', { name: `Accept ${agent.name}'s changes` });
    await expect(accept).toBeEnabled({ timeout: TURN_MS });
    const finished = (await latest(window, agent)).finishedAt;
    await accept.click();
    // The user replies instead: the agent takes another turn, and its row (with Undo) may leave the list meanwhile.
    await window.evaluate(({ sessionId }) => self.agentBoard.agents.answer(sessionId, 'Also bump the version'), { sessionId: agent.sessionId });
    await expect.poll(async () => (await latest(window, agent)).finishedAt, { timeout: TURN_MS }).not.toBe(finished);
    await window.waitForTimeout(ACCEPT_MS + 1_000);
    expect(merges()).toEqual([]);
    await expect(window.getByText(`Didn't merge #35: ${agent.name} has moved on since you accepted it.`)).toBeVisible();
  });
});

test('an agent that crashed is listed under Problems, saying so, until it is dismissed', async () => {
  await withApp('crash', async (window) => {
    const agent = await spawn(window, 'Do the work');
    await expect.poll(async () => (await latest(window, agent)).state, { timeout: TURN_MS }).toBe('failed');
    await openList(window);
    const problem = row(window, agent);
    await expect(window.getByTestId('inbox-group').filter({ has: problem }).locator('.inbox-group-name')).toHaveText('Problems');
    await expect(problem.getByTestId('inbox-problem-line')).toHaveText(/^It stopped with an error/);
    await problem.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(sessionWindow(window)).toBeVisible();
    await sessionWindow(window).getByRole('button', { name: `Done, close ${agent.name}` }).click();
    // Nothing here gets it going again, so it can be dismissed.
    await openList(window);
    await problem.getByRole('button', { name: `Dismiss ${agent.name}'s problem` }).click();
    await expect(problem).toHaveCount(0);
  });
});
