import { expect, type Page } from '@playwright/test';
import { createFakeGitHub, FAKE_GITHUB_STATE, type FakeGitHubPullRequest } from '@agent-board/tracker/testing';
import { execFileSync } from 'node:child_process';
import type { Agent } from '@agent-board/daemon/protocol';
import { closeAgent, launch } from '../agent-helpers.ts';
import { makeRepo, pinPaths, pinRandomLooks, scenarioPicker, stillBoard } from '../demo-board.ts';
import { removeDataDir, tempDataDir, test } from '../launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, settle } from '../render.ts';
import { scratch } from '../scratch.ts';
import { SHOT, needsBaselines, THEMES } from './shared.ts';

test.use({ viewport: null });

/**
 * A zone on status shelves the way a busy one is: about 30 agents, from the fake harness. The picker steers each by its
 * name: "Clear build output…" asks to run a command (needs you), "Resize images…" works on with subagents, "Pick a
 * cache…" ends its turn at its prompt (started, quiet); the rest finish a turn, and some get an open pull request
 * (waiting on review), some are closed (done); those started with no prompt have not begun (to do). A lead with the
 * orchestrator role is pinned top-left.
 */
const NEEDS_YOU = ['Clear build output in docs', 'Clear build output in web', 'Clear build output in api'];
const WORKING = ['Resize images on the gallery', 'Resize images for email', 'Resize images in the docs', 'Resize images on cards', 'Resize images for print', 'Resize images on mobile'];
const QUIET = ['Pick a cache for search', 'Pick a cache for images', 'Pick a cache for sessions', 'Pick a cache for prices', 'Pick a cache for feeds'];
const REVIEW = ['Fix checkout flake', 'Add invoice export', 'Tighten the auth check', 'Trim the bundle', 'Retry failed webhooks', 'Paginate the orders list'];
const TO_DO = ['Audit log', 'Search facets', 'Rate-limit headers', 'Docs sweep', 'Invite flow'];
const DONE = ['Dark theme', 'Login copy', 'Avatar upload', 'Health check'];

async function seedShelvedZone(page: Page, dir: string, github: ReturnType<typeof createFakeGitHub>): Promise<string> {
  const repo = makeRepo(dir, 'web-app');
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/web-app.git']);
  const zone = await page.evaluate(async (path) => {
    const result = await window.agentBoard.zones.addFolder(path, { x: 0, y: 0, width: 1700, height: 900, color: '#4c6ef5' });
    if (result.status !== 'added') throw new Error(result.message);
    return result.zone;
  }, repo);
  const spawn = (name: string, prompt: string | undefined, role?: string) =>
    page.evaluate(
      async (params) => {
        const result = await window.agentBoard.agents.spawn(params);
        if (result.status !== 'started') throw new Error(result.message);
        return result.agent;
      },
      { zoneId: zone.id, name, ...(prompt === undefined ? {} : { prompt }), ...(role === undefined ? {} : { role }), cols: 100, rows: 30 },
    );
  // Read from the daemon, not the tiles: with this many, the board draws only those in view.
  const listed = (name: string) => page.evaluate(async (wanted) => (await window.agentBoard.agents.list()).find((agent) => agent.name === wanted), name);
  const settled = (names: readonly string[], ready: (agent: Agent) => boolean) =>
    expect.poll(async () => (await Promise.all(names.map(listed))).every((agent) => agent !== undefined && ready(agent)), { timeout: 60_000 }).toBe(true);
  // One at a time, so each starts after the one before: the order they are listed in on their shelves.
  await spawn('Lead the web crew', 'Lead the web crew', 'orchestrator');
  const needsYou: Agent[] = [];
  for (const name of NEEDS_YOU) needsYou.push(await spawn(name, name));
  const working: Agent[] = [];
  for (const name of WORKING) working.push(await spawn(name, name));
  const quiet: Agent[] = [];
  for (const name of QUIET) quiet.push(await spawn(name, name));
  const review: Agent[] = [];
  for (const name of REVIEW) review.push(await spawn(name, name));
  for (const name of TO_DO) await spawn(name, undefined);
  const done: Agent[] = [];
  for (const name of DONE) done.push(await spawn(name, name));

  await settled(NEEDS_YOU, (agent) => agent.state === 'needs-permission' || agent.permissions.length > 0);
  await settled(WORKING, (agent) => agent.subagents.length >= 3);
  await settled([...QUIET, ...REVIEW, ...DONE, 'Lead the web crew'], (agent) => agent.finishedAt !== null && (agent.state === 'idle' || agent.state === 'waiting'));
  // Started with no prompt: at its prompt, no turn begun.
  await settled(TO_DO, (agent) => agent.state === 'idle' && agent.finishedAt === null);
  // Agents a hand-off joins share a stack: the three clearing build output are one unit of work, as are two of those
  // resizing images and two picking a cache.
  const join = (from: Agent, to: Agent) => page.evaluate(({ from, to }) => window.agentBoard.flowEdges.create({ from, to, payload: 'handover', path: 'handover.md' }), { from: from.sessionId, to: to.sessionId });
  await join(needsYou[0]!, needsYou[1]!);
  await join(needsYou[1]!, needsYou[2]!);
  await join(working[0]!, working[1]!);
  await join(quiet[0]!, quiet[1]!);
  // Those under review: an open pull request each, on its branch.
  const pullRequests = review.map(
    (agent, index): FakeGitHubPullRequest => ({
      repo: 'acme/web-app',
      number: 40 + index,
      title: agent.name,
      headRefName: agent.branch,
      headRefOid: 'b'.repeat(40),
      state: 'OPEN',
      isDraft: false,
      author: 'maria',
      body: '',
      statusCheckRollup: [],
      files: [],
      comments: [],
      reviewComments: [],
    }),
  );
  github.setState({ ...FAKE_GITHUB_STATE, repos: [{ nameWithOwner: 'acme/web-app', description: 'The web app', squashMergeAllowed: true }], pullRequests });
  await settled(REVIEW, (agent) => agent.pullRequests.some((pr) => pr.state === 'open'));
  for (const agent of done) await closeAgent(page, agent.sessionId);
  await settled(DONE, (agent) => agent.endedAt !== null && agent.shellSessionId === null);
  return zone.id;
}

/** Fit View, once nothing moves, every random look pinned. */
async function framed(page: Page) {
  await stillBoard(page);
  await page.getByRole('button', { name: 'Fit View' }).click();
  await settle(page);
  await stillBoard(page);
  await pinRandomLooks(page);
  await pinPaths(page);
}

// A shelved zone of about 30 agents, so "at a glance" can be judged: zoomed out with the lead pinned top-left and Done
// folded to its line; a needs-you stack fanned out by a jump to it; Done shown as chips; and the same zone in clusters.
// In Classic and the Simplified design, light and dark.
test('a zone of about 30 agents on status shelves (at a glance, a stack fanned out, Done shown) and in clusters, in both designs, light and dark', async () => {
  test.setTimeout(6 * 60_000);
  const combos = (['classic', 'simplified'] as const).flatMap((design) => THEMES.map(({ theme, suffix }) => ({ design, theme, name: `${design === 'simplified' ? 'simplified-' : ''}shelves${suffix}` })));
  needsBaselines(...combos.flatMap(({ name }) => [`${name}-overview`, `${name}-fanned`, `${name}-done`, `${name.replace('shelves', 'clusters')}-overview`]));
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [] });
  const { dir, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(
    dataDir,
    { ...env, ...RENDER_ENV, PATH: `${scenarioPicker(dir)}:${env.PATH}`, AGENT_BOARD_GH: github.gh, AGENT_BOARD_PULL_REQUEST_POLL_MS: '200', SHELL: '/bin/sh' },
    RENDER_ARGS,
  );
  try {
    await page.setViewportSize(VIEWPORT);
    const zoneId = await seedShelvedZone(page, dir, github);
    await page.evaluate((id) => window.agentBoard.zones.configure(id, { layoutMode: 'shelves' }), zoneId);
    await expect(page.getByTestId('shelves')).toHaveCount(1);
    for (const { design, theme, name } of combos) {
      await page.evaluate(
        async ({ design, mode }) => {
          await window.agentBoard.design.set(design);
          await window.agentBoard.appearance.set({ mode, theme: 'agent-board' });
        },
        { design, mode: theme },
      );
      // Classic marks nothing on the page; the Simplified design marks itself.
      if (design === 'simplified') await expect(page.locator('html')).toHaveAttribute('data-design', 'simplified');
      else await expect(page.locator('html')).not.toHaveAttribute('data-design', 'simplified');
      await expect(page.locator('html')).toHaveAttribute('data-scheme', theme);

      // At a glance: needs you first on Doing, those at work, those waiting on review, those not started, Done folded.
      await framed(page);
      await expect(page.getByTestId('shelf-done')).toHaveText(/4 done\s*Show/);
      await expect.soft(page.locator('.board')).toHaveScreenshot(`${name}-overview.png`, SHOT);

      // A jump to an agent that needs you fans its stack out, and comes to it.
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
      await page.getByTestId('spotlight').getByRole('combobox').fill(NEEDS_YOU[1]!);
      await page.keyboard.press('Enter');
      // Its stack of three, open: the three tiles fanned out below the shelves, the rest of the zone stepped back.
      const stack = page.getByTestId('shelf-stack').filter({ hasText: NEEDS_YOU[0]! });
      await expect(stack).toHaveAttribute('aria-expanded', 'true');
      await expect(stack.getByTestId('shelf-stack-count')).toHaveText('3');
      await expect(page.getByTestId('shelf-scrim')).toBeVisible();
      await settle(page);
      await stillBoard(page);
      await pinRandomLooks(page);
      await pinPaths(page);
      await expect.soft(page.locator('.board')).toHaveScreenshot(`${name}-fanned.png`, SHOT);
      await page.keyboard.press('Escape');

      // Done, shown as chips.
      await page.getByTestId('shelf-done').click();
      await framed(page);
      await expect.soft(page.locator('.board')).toHaveScreenshot(`${name}-done.png`, SHOT);
      await page.getByTestId('shelf-done').click();

      // The same zone in clusters: each ticket's tiles together, what needs you first, the lead pinned top-left. Nothing
      // selected: the jump above selected the agent it came to, which clusters draw as a tile of its own.
      await page.locator('.react-flow__pane').click({ position: { x: 1220, y: 420 } });
      await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
      await page.evaluate((id) => window.agentBoard.zones.configure(id, { layoutMode: 'clusters' }), zoneId);
      await expect(page.getByTestId('clusters')).toHaveCount(1);
      await framed(page);
      await expect.soft(page.locator('.board')).toHaveScreenshot(`${name.replace('shelves', 'clusters')}-overview.png`, SHOT);
      await page.evaluate((id) => window.agentBoard.zones.configure(id, { layoutMode: 'shelves' }), zoneId);
      await expect(page.getByTestId('shelves')).toHaveCount(1);
    }
  } finally {
    await app.close();
    removeDataDir(dataDir);
  }
});
