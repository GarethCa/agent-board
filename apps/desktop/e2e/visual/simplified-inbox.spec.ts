import { expect, type Page } from '@playwright/test';
import type { Agent, Zone } from '@agent-board/daemon/protocol';
import { createFakeGitHub, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agents, launch } from '../agent-helpers.ts';
import { makeRepo } from '../demo-board.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from '../launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, pinRandomText, settle } from '../render.ts';
import { scratch } from '../scratch.ts';
import { SHOT, needsBaselines, THEMES } from './shared.ts';

test.use({ viewport: null });

/** Starts an agent in `zone` on `prompt`, names it `name`, and waits until `until` holds for it. */
async function starting(page: Page, zone: Zone, prompt: string, name: string, until: (agent: Agent) => boolean): Promise<Agent> {
  const agent = await page.evaluate(
    async (params) => {
      const result = await window.agentBoard.agents.spawn(params);
      if (result.status !== 'started') throw new Error(result.message);
      return result.agent;
    },
    { zoneId: zone.id, prompt, cols: 100, rows: 30 },
  );
  await page.evaluate(({ sessionId, name }) => window.agentBoard.agents.setName(sessionId, name), { sessionId: agent.sessionId, name });
  let now: Agent | undefined;
  await expect
    .poll(async () => {
      now = (await agents(page)).find((each) => each.sessionId === agent.sessionId);
      return now !== undefined && until(now);
    }, { timeout: 30_000 })
    .toBe(true);
  return now!;
}

const asks = (agent: Agent) => agent.permissions.length > 0 || agent.ask !== null;

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

// The Simplified design's Needs-you list in its sections, each row labelled with its zone: what continues the work (a
// destructive command, with Deny and Review… only, and a plain one with the pane's Allow buttons), a question that
// reaches out, changes ready to accept, and an agent stuck at its usage limit.
for (const { theme, suffix } of THEMES) {
  test(`the Needs-you list in its sections in the Simplified design, ${theme}`, async () => {
    needsBaselines(`simplified-inbox${suffix}`);
    const { dir, repo, env } = scratch('orchestrate');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
    const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [] });
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window: page } = await launch(
      dataDir,
      { ...env, ...RENDER_ENV, ...appearance, FAKE_HARNESS_PERMISSION_SUGGESTIONS: '1', SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0', AGENT_BOARD_GH: github.gh, AGENT_BOARD_PULL_REQUEST_POLL_MS: '200' },
      RENDER_ARGS,
      { design: 'simplified' },
    );
    try {
      // Taller than the other shots, so all four sections are in one.
      await page.setViewportSize({ ...VIEWPORT, height: 1240 });
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator('html')).toHaveAttribute('data-design', 'simplified');
      await pinFonts(page);
      await pickFolderNext(app, repo);
      await browseForZone(page);
      const zones = await page.evaluate(async (path) => {
        const result = await window.agentBoard.zones.addFolder(path, { x: 0, y: 900, width: 640, height: 400, color: '#12b886' });
        if (result.status !== 'added') throw new Error(result.message);
        return [...(await window.agentBoard.zones.list()).filter((zone) => zone.id !== result.zone.id), result.zone];
      }, makeRepo(dir, 'kobo-planning'));
      const [monorepo, kobo] = zones as [Zone, Zone];
      // Oldest first in each section: Kobo's request, then the monorepo's.
      await starting(page, kobo, 'Ask permission', 'Clear build output', asks);
      await starting(page, monorepo, 'Ask: After signing in, go back to the page they were on, or home? | The page they were on | Home', 'Fix login redirect', asks);
      await starting(page, monorepo, 'Run: pnpm test | Run the test suite', 'Run the tests', asks);
      const docs = await starting(page, monorepo, 'Tidy the docs', 'Tidy the docs', (agent) => agent.state === 'waiting' || agent.state === 'idle');
      writeFileSync(join(docs.worktree, 'docs.md'), '# Docs\n');
      git(docs.worktree, 'add', '.');
      git(docs.worktree, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'Tidy the docs');
      github.setState({
        ...FAKE_GITHUB_STATE,
        pullRequests: [
          {
            repo: 'acme/app',
            number: 35,
            title: 'Tidy the docs',
            headRefName: docs.branch,
            headRefOid: git(docs.worktree, 'rev-parse', 'HEAD'),
            state: 'OPEN',
            isDraft: false,
            statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
            author: 'octocat',
          },
        ],
      });
      await starting(page, kobo, 'Hit the rate limit', 'Plan the release', (agent) => agent.state === 'rate-limited');

      // The monorepo's last merge kept its branch, as Merge's popover remembers: the branch's name, with the run's own
      // random suffix, is then not in the shot.
      await page.evaluate((zoneId) => localStorage.setItem(`gate-cleanup:${zoneId}`, JSON.stringify({ branch: false })), monorepo.id);
      await page.getByTestId('inbox-count').click();
      const panel = page.getByTestId('master-panel');
      await expect(panel.getByTestId('inbox-group')).toHaveCount(4, { timeout: 30_000 });
      await expect(panel.getByTestId('inbox-item')).toHaveCount(5);
      // A prompt's buttons ignore clicks for a moment after it shows; the shot is of them armed.
      for (const button of await panel.locator('.inbox-item-actions button').all()) await expect(button).toBeEnabled();
      await page.addStyleTag({ content: '.master-panel * { scrollbar-width: none; }' });
      // The ages and the question's wait are the run's own clock's.
      await page.evaluate(() => {
        document.querySelectorAll('.inbox-row-age').forEach((age, at) => (age.textContent = ['25 min ago', 'just now', '12 min ago', '8 min ago', '3 min ago'][at] ?? 'just now'));
        document.querySelectorAll('.inbox-row-meta span').forEach((span) => (span.textContent = span.textContent!.replace(/Waits \d+ more minutes?/, 'Waits 18 more minutes')));
      });
      await pinRandomText(page);
      const restorePointer = await ignorePointer(page);
      await settle(page);
      await expect.soft(panel).toHaveScreenshot(`simplified-inbox${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      github.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
