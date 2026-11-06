// Badges and chips never run past their container: a tile's footer (the model and role badges among them, folding into
// a "+N" past its one line) and New agent's footer chips beside Start.
import { expect, type Locator } from '@playwright/test';
import { createFakeGitHub, FAKE_GITHUB_STATE, type FakeGitHubPullRequest } from '@agent-board/tracker/testing';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { agents, LONG_MODEL, launch, narrowBy, pickInChip, startBadgedAgent, sessionWindow, startCrowdedAgent, tile, TURN_MS, zoneNamed } from './agent-helpers.ts';
import { test, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

/** Whether `inner`'s box lies within `outer`'s, on both axes, once it has settled. */
async function expectWithin(inner: Locator, outer: Locator, what: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const [i, o] = [await inner.boundingBox(), await outer.boundingBox()];
        if (i === null || o === null) return 'not shown';
        const over = [
          ['left', o.x - i.x],
          ['right', i.x + i.width - (o.x + o.width)],
          ['top', o.y - i.y],
          ['bottom', i.y + i.height - (o.y + o.height)],
        ].filter(([, by]) => (by as number) > 0.5);
        return over.length === 0 ? 'inside' : `${what} runs out: ${over.map(([side, by]) => `${side} by ${(by as number).toFixed(1)}px`).join(', ')}`;
      },
      { message: what },
    )
    .toBe('inside');
}

/** Every child of `footer` that shows lies within `container`. */
async function expectChildrenWithin(footer: Locator, container: Locator): Promise<number> {
  const children = await footer.locator('> *').all();
  let shown = 0;
  for (const [index, child] of children.entries()) {
    if (!(await child.isVisible())) continue;
    shown += 1;
    await expectWithin(child, container, `footer child ${index}`);
  }
  return shown;
}

test('a crowded tile’s footer, narrowed, stays on one line, folds the rest into +N and keeps every badge inside the tile', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await startCrowdedAgent(window);

    const footer = tile(window).locator('.hybrid-tile-footer');
    await expect(footer.getByTestId('tile-model')).toHaveText(LONG_MODEL);
    await expect(footer.getByTestId('tile-muted')).toHaveCount(1);
    await expectChildrenWithin(footer, tile(window));

    // However far it narrows, nothing runs out, the footer takes one line, and what folded is in the +N.
    for (const dx of [-40, -40, -40]) {
      await narrowBy(window, tile(window), dx);
      await expectChildrenWithin(footer, tile(window));
      // Lines, told by the middles of what shows: a taller chip's top is above a shorter one's on the same line.
      const lines = await footer.evaluate((element) => {
        const middles = [...element.children]
          .filter((child) => (child as HTMLElement).offsetParent !== null)
          .map((child) => (child as HTMLElement).offsetTop + (child as HTMLElement).offsetHeight / 2)
          .sort((a, b) => a - b);
        return middles.filter((middle, index) => index === 0 || middle - middles[index - 1]! > 6).length;
      });
      expect(lines).toBe(1);
    }
    const folded = footer.getByTestId('tile-folded');
    await expect(folded).toBeVisible();
    // The role goes before the model.
    await folded.click();
    await expect(window.getByTestId('tile-folded-row').filter({ hasText: 'Role: Follow-up reviewer' })).toBeVisible();
    await window.keyboard.press('Escape');
    // The model badge keeps its full id in its tooltip while its text is cut short.
    await expect(footer.getByTestId('tile-model')).toHaveAttribute('title', new RegExp(LONG_MODEL));
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a PR chip arriving in a crowded tile’s footer moves nothing: the name, branch and description keep their boxes, and the lower ranked badges fold into +N', async () => {
  test.setTimeout(120_000);
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [] });
  // 'output', not 'waiting': an agent that asks swaps its description for the question, which moves the row.
  const { dir, repo, env } = scratch('output');
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_GH: github.gh, AGENT_BOARD_PULL_REQUEST_POLL_MS: '200' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await startBadgedAgent(window);
    const footer = tile(window).locator('.hybrid-tile-footer');
    const rows = [tile(window).locator('.hybrid-tile-name'), tile(window).locator('.hybrid-tile-branch'), tile(window).locator('.hybrid-tile-body')];
    const boxes = () => Promise.all(rows.map((row) => row.boundingBox()));
    // The role is already in the +N: one line has room for the model and little more.
    await expect(footer.getByTestId('tile-model')).toBeVisible();
    // Its description changes as its turn runs, and with it the rows' heights: measure once the turn is over and they
    // have stopped moving.
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    let last = '';
    await expect
      .poll(async () => {
        const now = JSON.stringify(await boxes());
        const settled = now === last;
        last = now;
        return settled;
      })
      .toBe(true);
    const before = await boxes();
    expect(before.every((box) => box !== null)).toBe(true);

    // Its branch gets a pull request, and another of its branch follows: they rank above the model and the role.
    const [agent] = await agents(window);
    const pullRequest = (number: number): FakeGitHubPullRequest => ({
      repo: 'acme/app',
      number,
      title: `Pull request ${number}`,
      headRefName: agent!.branch,
      headRefOid: 'b'.repeat(40),
      state: 'OPEN',
      isDraft: false,
      body: 'A change.',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/app/actions/runs/1' }],
      files: [],
      comments: [],
      reviewComments: [],
    });
    for (const numbers of [[41], [41, 42]]) {
      github.setState({ ...FAKE_GITHUB_STATE, pullRequests: numbers.map(pullRequest) });
      await expect(footer.getByTestId('tile-pr')).toHaveCount(numbers.length, { timeout: 20_000 });
      await expect(footer.getByTestId('tile-pr').first()).toBeVisible();
      await expect(footer.getByTestId('tile-folded')).toBeVisible();
      await expectChildrenWithin(footer, tile(window));
      expect(await boxes()).toEqual(before);
    }
    // Clicking the +N lists what folded, a row each; a third pull request, past the two the footer shows, joins them, and its
    // row names it.
    await footer.getByTestId('tile-folded').click();
    const list = window.getByTestId('tile-folded-list');
    await expect(list.getByTestId('tile-folded-row').filter({ hasText: 'Role: Implementer' })).toBeVisible();
    // One row for each of the +N.
    await expect(footer.getByTestId('tile-folded')).toHaveText(`+${await list.getByTestId('tile-folded-row').count()}`);
    await window.keyboard.press('Escape');
    await expect(list).toBeHidden();
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [41, 42, 43].map(pullRequest) });
    const plus = footer.getByTestId('tile-folded');
    const folded = Number((await plus.textContent())!.slice(1));
    await expect(plus).toHaveText(`+${folded + 1}`, { timeout: 20_000 });
    await plus.click();
    await expect(list.getByTestId('tile-folded-row')).toHaveCount(folded + 1);
    await expect(list.getByTestId('tile-folded-row').filter({ hasText: '#43 Pull request 43' })).toBeVisible();

    // The list is the tile's, though it is drawn in a portal: a double-click on an info row opens no session window.
    await list.getByTestId('tile-folded-row').filter({ hasText: 'Role: Implementer' }).dblclick();
    await expect(list).toBeVisible();
    await expect(sessionWindow(window)).toHaveCount(0);
    await window.keyboard.press('Escape');

    // Many pull requests with long titles: the list stays inside the window, its rows cut with an ellipsis and the list
    // scrolling, so every row can be reached.
    const long = (number: number): FakeGitHubPullRequest => ({ ...pullRequest(number), title: `Pull request ${number}: ${'a title that runs on and on '.repeat(8)}` });
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: Array.from({ length: 30 }, (_, index) => long(index + 1)) });
    // More than fit the window's height, whatever number of them the board keeps.
    await expect(plus).toHaveText(/^\+(1\d|[2-9]\d)$/, { timeout: 30_000 });
    const many = Number((await plus.textContent())!.slice(1));
    await plus.click();
    await expect(list.getByTestId('tile-folded-row')).toHaveCount(many);
    const view = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const box = (await list.boundingBox())!;
    expect(box.x + box.width, 'the list ends inside the window').toBeLessThanOrEqual(view.width);
    expect(box.y + box.height, 'the list ends inside the window').toBeLessThanOrEqual(view.height);
    expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight), 'the list scrolls').toBe(true);
    expect(await list.locator('.tile-folded-text').last().evaluate((element) => element.scrollWidth > element.clientWidth), 'a long row is cut').toBe(true);
    await window.keyboard.press('Escape');

    // A row opens what it names: the third pull request's row opens its PR tab.
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [41, 42, 43].map(pullRequest) });
    await expect(plus).toHaveText(`+${folded + 1}`, { timeout: 30_000 });
    await plus.click();
    await list.getByTestId('tile-folded-row').filter({ hasText: '#43 Pull request 43' }).click();
    await expect(list).toBeHidden();
    await expect(sessionWindow(window).getByTestId('pr-view')).toContainText('#43');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('New agent’s footer chips wrap beside a long model id, which shows in full, and Start stays inside the dialog', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await zoneNamed(window, 'monorepo').getByRole('button', { name: 'New agent' }).click();
    const form = window.getByRole('dialog', { name: 'New agent' });
    await pickInChip(form, 'Model', 'Other…');
    await form.getByRole('textbox', { name: 'Model id' }).fill(LONG_MODEL);
    await pickInChip(form, 'Role', 'Follow-up reviewer');
    const start = form.getByRole('button', { name: 'Start' });
    await expectWithin(start, form, 'Start');
    for (const chip of ['Harness', 'Model', 'Reasoning', 'Role']) await expectWithin(form.getByRole('button', { name: new RegExp(`^${chip}:`) }), form, chip);

    // No chip's text is cut short: the row wraps instead, so the whole model id shows.
    const cutShort = (chip: string) =>
      form.getByRole('button', { name: new RegExp(`^${chip}:`) }).locator('.agent-setup-text').evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(await cutShort('Harness')).toBe(false);
    expect(await cutShort('Reasoning')).toBe(false);
    expect(await cutShort('Role')).toBe(false);
    expect(await cutShort('Model')).toBe(false);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
