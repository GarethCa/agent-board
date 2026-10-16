// Badges and chips never run past their container: a tile's footer (the model and role badges among them, folding into
// a "+N" past its one line) and New agent's footer chips beside Start.
import { expect, type Locator } from '@playwright/test';
import { createFakeGitHub, FAKE_GITHUB_STATE, type FakeGitHubPullRequest } from '@agent-board/tracker/testing';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { agents, LONG_MODEL, launch, narrowBy, pickInChip, startBadgedAgent, startCrowdedAgent, tile, zoneNamed } from './agent-helpers.ts';
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
    await expect(folded).toHaveAttribute('title', /Role: Follow-up reviewer/);
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
    await expect(footer.getByTestId('tile-folded')).toHaveAttribute('title', /Role: Implementer/);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('New agent’s footer model chip shrinks beside a long id, and Start stays inside the dialog', async () => {
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
    for (const chip of ['Harness', 'Model', 'Role']) await expectWithin(form.getByRole('button', { name: new RegExp(`^${chip}:`) }), form, chip);

    // Only the model's text is cut short; the harness and the role stay readable.
    const cutShort = (chip: string) =>
      form.getByRole('button', { name: new RegExp(`^${chip}:`) }).locator('.agent-setup-text').evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(await cutShort('Harness')).toBe(false);
    expect(await cutShort('Role')).toBe(false);
    expect(await cutShort('Model')).toBe(true);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
