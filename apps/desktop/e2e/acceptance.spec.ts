import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { Agent } from '@agent-board/daemon/protocol';
import { createFakeGitHub, createTempKeychain } from '@agent-board/tracker/testing';
import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  agents,
  claudeInTerminal,
  expectCardBesideTile,
  launch,
  LINEAR_API_KEY,
  recordCharacters,
  recordedCharacters,
  recordedStates,
  recordStates,
  screen,
  serveLinearFixtures,
  sessionWindow,
  setZoneTracker,
  SHELL_ENV,
  spawnAgent,
  TURN_MS,
  zoneNamed,
  zones,
} from './agent-helpers.ts';
import { run } from './board-helpers.ts';
import { test, browseForZone, connectedDaemonPid, openAddZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';
import { clickClosing } from './windows.ts';

/**
 * The v1 definition of done, walked end to end on the fakes: every line of it in one journey, on one
 * board, ending with the app quit and relaunched and every session still running. Each step is the user's own
 * gesture; the narrower specs cover each feature's edges.
 *
 * Linear needs a throwaway keychain file, which only macOS has. Elsewhere the Linear zone has no tracker and its agent
 * starts from a typed task, and the run says so in its report and output: that line of the definition goes unchecked.
 */

const agentTile = (page: Page, agent: Agent) => page.locator(`[data-testid="agent-tile"][data-session-id="${agent.sessionId}"]`);
const dockItem = (page: Page) => page.getByTestId('dock-item');
const panes = (page: Page) => page.getByTestId('shell-pane');
const inboxItem = (page: Page, agent: Agent) => page.locator(`[data-testid="inbox-item"][data-session-id="${agent.sessionId}"]`);

/** The agent `spawn` started: the one that wasn't there before, waited for until the daemon lists it. */
async function started(page: Page, spawn: () => Promise<void>): Promise<Agent> {
  const before = new Set((await agents(page)).map((agent) => agent.sessionId));
  await spawn();
  let agent: Agent | undefined;
  await expect
    .poll(async () => (agent = (await agents(page)).find((each) => !before.has(each.sessionId))), { message: 'the new agent is listed', timeout: TURN_MS })
    .toBeDefined();
  return agent!;
}

test('v1 definition of done: zones, tracker-linked Claude and Codex agents, inbox, windows, split shell and outside sessions, all alive after a relaunch', async () => {
  test.setTimeout(240_000);
  const withLinear = process.platform === 'darwin';
  if (!withLinear) {
    const description = `Linear needs a throwaway macOS keychain: "start an agent from a Linear issue" is not checked on ${process.platform}`;
    test.info().annotations.push({ type: 'not checked', description });
    console.warn(`acceptance: ${description}`);
  }
  const {
    subject: { scope, knownIssue },
    server: linear,
  } = await serveLinearFixtures();
  const keychain = withLinear ? createTempKeychain() : undefined;
  const github = createFakeGitHub();
  // Every agent the app starts replays `subagent`: a turn that sends a subagent off, then sits at its prompt.
  const setup = scratch('subagent');
  const { repo } = setup;
  const home = setup.env.HOME!;
  const env = {
    ...setup.env,
    ...SHELL_ENV,
    AGENT_BOARD_GH: github.gh,
    AGENT_BOARD_LINEAR_API_URL: linear.url,
    ...(keychain === undefined ? {} : { AGENT_BOARD_KEYCHAIN: keychain.path }),
    // Never the developer's own ~/.claude or ~/.codex, which "sessions from other terminals" writes its hooks into.
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
  };
  const dataDir = tempDataDir();
  const apps: ElectronApplication[] = [];
  let outside: ChildProcessWithoutNullStreams | undefined;
  try {
    const first = await launch(dataDir, env);
    apps.push(first.app);
    const { app, window } = first;
    const daemonPid = await connectedDaemonPid(window);

    let planning: Agent;
    let fixer: Agent;
    await test.step('two zones share one repo, one taking its issues from GitHub and one from Linear, and a folder inside it is a zone of its own', async () => {
      // Each zone is set up as it is added, while the view is on it.
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await expect(zoneNamed(window, 'monorepo')).toHaveAttribute('data-kind', 'repo');
      await setZoneTracker(
        window,
        'monorepo',
        async (dialog) => {
          await dialog.getByLabel('Tracker').selectOption('github');
          await dialog.getByLabel('GitHub repo').fill('Acme/App');
        },
        'acme/app',
      );

      const popover = await openAddZone(window, 'Recent');
      await popover.getByRole('option').filter({ hasText: repo }).click();
      await popover.getByRole('textbox', { name: 'Zone name' }).fill('Planning');
      await popover.getByRole('button', { name: /^Add zone/ }).click();
      await expect(popover).toBeHidden();
      await expect(zoneNamed(window, 'Planning')).toHaveAttribute('data-kind', 'repo');
      if (withLinear) {
        await setZoneTracker(
          window,
          'Planning',
          async (dialog) => {
            await dialog.getByLabel('Linear API key').fill(LINEAR_API_KEY);
            await dialog.getByRole('button', { name: 'Connect' }).click();
            await expect(dialog.getByLabel('Linear team')).toHaveValue(scope);
          },
          scope,
        );
      }

      await pickFolderNext(app, join(repo, 'apps', 'web'));
      await browseForZone(window);
      await expect(zoneNamed(window, 'monorepo/apps/web')).toHaveAttribute('data-kind', 'folder');
      expect((await zones(window)).map((zone) => zone.repoRoot)).toEqual([repo, repo, repo]);
      await window.getByRole('button', { name: 'Fit View' }).click();
    });

    await test.step('a Claude agent starts from a Linear issue and a Codex agent from a GitHub one, each in its own worktree', async () => {
      await recordStates(window);
      await recordCharacters(window, { onTile: true });
      planning = await started(window, () =>
        spawnAgent(window, 'Planning', 'Plan the work', withLinear ? { issue: knownIssue.id } : {}),
      );
      fixer = await started(window, () => spawnAgent(window, 'monorepo', 'Fix it', { harness: 'Codex', issue: '#34' }));

      await expect(agentTile(window, planning)).toHaveAttribute('data-harness', 'claude');
      await expect(agentTile(window, fixer)).toHaveAttribute('data-harness', 'codex');
      // Each is linked on its tile, its issue's card beside it: one "issue brief" edge each.
      const briefEdges = withLinear ? 2 : 1;
      if (withLinear) {
        await expect(agentTile(window, planning).getByTestId('tile-issue')).toContainText(knownIssue.id);
        await expectCardBesideTile(window, knownIssue.id, agentTile(window, planning), briefEdges);
      }
      await expect(agentTile(window, fixer).getByTestId('tile-issue')).toContainText('#34');
      await expectCardBesideTile(window, '#34', agentTile(window, fixer), briefEdges);
      for (const agent of [planning, fixer]) {
        expect(agent.worktree.startsWith(join(setup.dir, 'worktrees'))).toBe(true);
        expect(existsSync(agent.worktree)).toBe(true);
        expect(execFileSync('git', ['-C', agent.worktree, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe(agent.branch);
      }
      expect(planning.worktree).not.toBe(fixer.worktree);
      expect(fixer.branch).toBe('gh-34-fix-the-login-redirect');
    });

    await test.step('their tiles change state live, with their subagents as characters', async () => {
      // Both turns ran at once, so the characters came and went in either order. A subagent that starts and finishes
      // between two of the board's renders, as on a loaded machine, is only ever drawn handing off its result.
      const subagent = (body: string, harness: string) => expect.stringMatching(new RegExp(`^(running|handing-off)/${body}@${harness}$`));
      await expect
        .poll(() => recordedCharacters(window), { timeout: TURN_MS })
        .toEqual(expect.arrayContaining([subagent('bean', 'claude'), subagent('block', 'codex')]));
      // Claude waits for you after its turn; Codex, with no such hook, is idle at its prompt. Not the idle it started
      // in: its subagent has come and gone.
      await expect(agentTile(window, planning)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      await expect(agentTile(window, fixer)).toHaveAttribute('data-state', 'idle', { timeout: TURN_MS });
      expect(await recordedStates(window)).toContain('running');
      await expect(window.getByTestId('character')).toHaveCount(0);
    });

    await test.step('the waiting agent is answered from the inbox', async () => {
      const count = window.getByTestId('inbox-count');
      await expect(count).toHaveAttribute('data-count', '1');
      await count.click();
      const item = inboxItem(window, planning);
      await expect(item.getByTestId('inbox-last-message')).toHaveText('The explorer found where sessions are created.');
      await item.getByLabel('Answer').fill('Ship it');
      await item.getByRole('button', { name: 'Send' }).click();
      await expect(item.getByTestId('inbox-last-message')).toHaveText('Done: Ship it.');
      // Pressed in the inbox, so it reaches the inbox whatever had the focus once Send went. Closed, or it would cover the
      // session window's buttons in the next step: it once stayed open after a plain Escape (cause not found).
      const inbox = window.getByRole('dialog', { name: 'Needs you' });
      await inbox.press('Escape');
      await expect(inbox).toBeHidden();
    });

    await test.step('a session window opens, minimises to the dock, and pops out into its own OS window', async () => {
      await agentTile(window, fixer).dblclick();
      await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
      await expect(screen(window)).toContainText('The explorer found where sessions are created.');

      await window.getByRole('button', { name: 'Minimise session window' }).click();
      await expect(sessionWindow(window)).toBeHidden();
      await expect(dockItem(window)).toHaveAttribute('data-placement', 'docked');
      // Its chip's first button restores it; the other closes it.
      await dockItem(window).getByRole('button', { name: fixer.name }).first().click();
      await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');

      const [popped] = await Promise.all([app.waitForEvent('window'), window.getByRole('button', { name: 'Pop out session window' }).click()]);
      await expect(sessionWindow(popped)).toHaveAttribute('data-state', 'attached');
      await expect(popped.getByTestId('session-terminal').locator('.xterm-rows')).toContainText('The explorer found where sessions are created.');
      await clickClosing(popped, popped.getByRole('button', { name: 'Back to board' }));
      await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
      await window.getByRole('button', { name: 'Close session window' }).click();
      await expect(sessionWindow(window)).toBeHidden();
    });

    await test.step('a claude session started in another terminal shows up in its zone', async () => {
      await window.getByRole('button', { name: 'Settings', exact: true }).click();
      const toggle = window.getByRole('switch', { name: 'Show sessions from other terminals' });
      await toggle.click();
      await expect(toggle).toBeChecked();
      await window.keyboard.press('Escape');
      await expect(toggle).toBeHidden();

      outside = claudeInTerminal(join(repo, 'apps', 'web'), home, ['Pick a database'], 'waiting');
      outside.stdout.resume();
      outside.stderr.resume();
      const web = (await zones(window)).find((zone) => zone.kind === 'folder')!;
      const external = window.locator(`[data-testid="external-tile"][data-zone="${web.id}"]`);
      await expect(external).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    });

    await test.step('a plain terminal splits into panes', async () => {
      await zoneNamed(window, 'monorepo/apps/web').getByRole('button', { name: 'New shell in zone' }).click();
      await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
      // Typed only once the shell is at its prompt, or the first keys can be lost.
      await expect(panes(window).first()).toContainText('$');
      await run(window, 'echo left-$((40 + 2))');
      await expect(panes(window).first()).toContainText('left-42');
      await sessionWindow(window).getByRole('navigation', { name: 'Session controls' }).getByRole('button', { name: 'Split horizontally' }).click();
      await expect(panes(window)).toHaveCount(2);
      // As in the first pane: typed only once its shell is at its prompt, or the first keys can be lost.
      await expect(panes(window).nth(1)).toContainText('$');
      await run(window, 'echo right-$((6 * 7))');
      await expect(panes(window).nth(1)).toContainText('right-42');
      // Left open, to come back as it was after the relaunch.
    });

    await test.step('quitting and relaunching the app finds every session still running', async () => {
      await app.close();
      const second = await launch(dataDir, env);
      apps.push(second.app);
      const again = second.window;
      expect(await connectedDaemonPid(again)).toBe(daemonPid);

      await expect(again.getByTestId('restart-banner')).toHaveCount(0);
      await expect(agentTile(again, planning)).toHaveAttribute('data-state', 'waiting');
      await expect(agentTile(again, fixer)).toHaveAttribute('data-state', 'idle');
      await expect(again.getByTestId('external-tile')).toHaveAttribute('data-state', 'waiting');

      // The split shell's window, as it was left: both panes, still taking input.
      await expect(panes(again)).toHaveCount(2);
      await expect(panes(again).nth(0)).toContainText('left-42');
      await panes(again).nth(1).click();
      await run(again, 'echo after-$((40 + 2))');
      await expect(panes(again).nth(1)).toContainText('after-42');
      await again.getByRole('button', { name: 'Close session window' }).click();

      // Each agent carries on its conversation where it was.
      for (const [agent, line] of [
        [planning, 'And now?'],
        [fixer, 'Carry on'],
      ] as const) {
        await agentTile(again, agent).dblclick();
        await expect(sessionWindow(again)).toHaveAttribute('data-session-id', agent.sessionId);
        await again.getByTestId('session-terminal').click();
        await run(again, line);
        await expect(screen(again)).toContainText(`Done: ${line}.`);
        await again.getByRole('button', { name: 'Close session window' }).click();
      }
      // The outside session too: answered in its own terminal, it finishes.
      outside!.stdin.write('SQLite\n');
      outside!.stdin.end();
      await expect(again.getByTestId('external-tile')).toHaveAttribute('data-state', 'done');
    });
  } finally {
    outside?.kill();
    for (const app of apps) await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(setup.dir, { recursive: true, force: true });
    keychain?.remove();
    github.dispose();
    await linear.close();
  }
});
