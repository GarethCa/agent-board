import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { fakeBinDir } from '@agent-board/fake-harness';
import { LINEAR_API_URL } from '@agent-board/tracker';
import {
  createFakeGitHub,
  createTempKeychain,
  FAKE_GITHUB_STATE,
  RECORDED_LINEAR_FIXTURES,
  serveFixtures,
  type HttpInteraction,
} from '@agent-board/tracker/testing';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FakeNotification } from '../src/main/notifications.ts';
import { launch, LINEAR_API_KEY } from './agent-helpers.ts';
import { test, pickFolderNext, tempDataDir, newShell } from './launch.ts';
import { scratch } from './scratch.ts';

// First-run onboarding. The app runs on a bare PATH with an empty bin dir first, so it finds none of the CLIs
// (never the developer's real ones); "installing" one puts its fake there. Never the network: gh is the fake gh, Linear
// a fixture server, the key a throwaway keychain.

const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** A first-run env: nothing installed, onboarding allowed, a temp home and repo. */
function firstRun() {
  const { repo, env, dir } = scratch('output');
  const bin = join(dir, 'bin');
  const nodeBin = join(dir, 'node-bin');
  mkdirSync(bin);
  mkdirSync(nodeBin);
  // The fakes run on node; nothing else is in this dir.
  symlinkSync(process.execPath, join(nodeBin, 'node'));
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, loggedIn: false });
  const appEnv = {
    ...env,
    PATH: `${bin}:${nodeBin}:${BARE_PATH}`,
    SHELL: '/bin/sh',
    AGENT_BOARD_ONBOARDING: '1',
    AGENT_BOARD_GH: join(bin, 'gh'),
  };
  return {
    repo,
    home: env.HOME!,
    env: appEnv,
    github,
    /** Puts the fake CLI on the app's PATH, as installing it would. */
    install(name: 'claude' | 'codex' | 'gh') {
      if (name === 'gh') {
        writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec '${github.gh}' "$@"\n`);
        chmodSync(join(bin, 'gh'), 0o755);
      } else {
        symlinkSync(join(fakeBinDir, name), join(bin, name));
      }
    },
  };
}

const row = (window: Page, name: string) => window.getByRole('listitem', { name });
const badge = (window: Page, name: string) => row(window, name).getByRole('img', { name: /^(Ready|Needs action|Not set up|Checking)$/ });
const notifications = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis.agentBoardNotifications ?? []).map(({ title }: FakeNotification) => title));

/** With `AGENT_BOARD_E2E_SHOTS` set to a folder, saves a screenshot of the window there, to compare with the mocks. */
async function shot(window: Page, name: string) {
  const folder = process.env.AGENT_BOARD_E2E_SHOTS;
  if (folder) await window.screenshot({ path: join(folder, `onboarding-${name}.png`) });
}

test('first run: everything missing, then fixed through the fakes, then the tour, then a zone', async () => {
  const run = firstRun();
  const dataDir = tempDataDir();
  // Linear's part needs a throwaway keychain file, which only macOS has.
  const darwin = process.platform === 'darwin';
  const keychain = darwin ? createTempKeychain() : undefined;
  const { interactions } = JSON.parse(readFileSync(RECORDED_LINEAR_FIXTURES, 'utf8')) as { interactions: HttpInteraction[] };
  // The teams the recording lists (the recorder keeps only the team under test).
  const teamKeys = interactions.flatMap(({ response }) => {
    const data = (response.body as { data?: { teams?: { nodes: { key: string }[] } } } | null)?.data;
    return data?.teams?.nodes.map((team) => team.key) ?? [];
  });
  const linear = await serveFixtures(
    interactions.filter((i) => i.response.status === 200),
    LINEAR_API_URL,
  );
  try {
    const { app, window } = await launch(dataDir, {
      ...run.env,
      AGENT_BOARD_LINEAR_API_URL: linear.url,
      ...(keychain ? { AGENT_BOARD_KEYCHAIN: keychain.path } : {}),
    });

    // Welcome.
    const welcome = window.getByRole('dialog', { name: 'Welcome to agent-board' });
    await expect(welcome).toBeVisible();
    await expect(welcome.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute('aria-valuenow', '1');
    // The board's keys are off under it: N makes no sticky note.
    await window.keyboard.press('n');
    await shot(window, '1-welcome');
    await welcome.getByRole('button', { name: 'Get started' }).click();

    // Connect: nothing is set up.
    const connect = window.getByRole('dialog', { name: 'Connect your tools' });
    for (const name of ['Claude Code CLI', 'Codex CLI', 'GitHub']) {
      await expect(row(window, name)).toContainText('not found');
      await expect(badge(window, name)).toHaveAccessibleName('Not set up');
    }
    await expect(badge(window, 'Linear')).toHaveAccessibleName('Not set up');
    await expect(badge(window, 'Global hooks')).toHaveAccessibleName('Not set up');
    await expect(badge(window, 'Notifications')).toHaveAccessibleName('Not set up');
    await expect(connect.getByTestId('connect-summary')).toContainText('0 of 6 ready');
    await expect(connect.getByTestId('connect-summary')).toContainText('1 required · 5 optional left');
    await shot(window, '2-connect-missing');

    // Install the harnesses, and check again in place.
    run.install('claude');
    run.install('codex');
    await row(window, 'Claude Code CLI').getByRole('button', { name: 'Check Claude Code CLI again' }).click();
    await expect(connect.getByTestId('connect-summary')).toContainText('5 optional left');
    await expect(connect.getByTestId('connect-summary')).not.toContainText('required');
    await row(window, 'Codex CLI').getByRole('button', { name: 'Check Codex CLI again' }).click();
    await expect(row(window, 'Claude Code CLI')).toContainText('found v2.1.0, signed in');
    await expect(row(window, 'Codex CLI')).toContainText('found v0.46.0, signed in');
    await expect(badge(window, 'Claude Code CLI')).toHaveAccessibleName('Ready');

    // gh installed but signed out: Sign in runs gh auth login in a shell tile; back in setup, it is signed in.
    run.install('gh');
    await row(window, 'GitHub').getByRole('button', { name: 'Check GitHub again' }).click();
    await expect(row(window, 'GitHub')).toContainText('not signed in');
    await expect(badge(window, 'GitHub')).toHaveAccessibleName('Needs action');
    await row(window, 'GitHub').getByRole('button', { name: 'Sign in' }).click();
    await expect(window.getByTestId('session-terminal').locator('.xterm-rows')).toContainText('Logged in as octocat');
    expect(run.github.calls().some((call) => call.args.join(' ') === 'auth login --web')).toBe(true);
    await window.getByTestId('onboarding-away').getByRole('button', { name: 'Back to setup' }).click();
    // Its window closes, so the tour has the board; the shell tile stays on it.
    await expect(window.getByTestId('session-terminal')).toHaveCount(0);
    await expect(window.locator('.hybrid-tile')).toHaveCount(1);
    await expect(row(window, 'GitHub')).toContainText('signed in');
    await expect(badge(window, 'GitHub')).toHaveAccessibleName('Ready');

    // Linear: the key is tested, its teams shown, and it goes only to the keychain.
    if (darwin) {
      await row(window, 'Linear').getByLabel('Linear API key').fill(LINEAR_API_KEY);
      await row(window, 'Linear').getByRole('button', { name: 'Test' }).click();
      await expect(row(window, 'Linear')).toContainText(`Teams ${teamKeys.join(', ')}`);
      await expect(badge(window, 'Linear')).toHaveAccessibleName('Ready');
      const stored = execFileSync('security', ['find-generic-password', '-s', 'agent-board', '-a', 'linear', '-w', keychain!.path], { encoding: 'utf8' });
      expect(stored.trim()).toBe(LINEAR_API_KEY);
      for (const file of readdirSync(dataDir).filter((name) => name.includes('.db'))) {
        expect(readFileSync(join(dataDir, file)).includes(LINEAR_API_KEY)).toBe(false);
      }
    }

    // Global hooks, into the temp home's ~/.claude/settings.json and ~/.codex/hooks.json, as the row says.
    await expect(row(window, 'Global hooks')).toContainText('~/.codex/hooks.json');
    await row(window, 'Global hooks').getByRole('switch', { name: 'Global hooks' }).click();
    await expect(badge(window, 'Global hooks')).toHaveAccessibleName('Ready');
    expect(readFileSync(join(run.home, '.claude', 'settings.json'), 'utf8')).toContain('agent-board-hook');
    expect(readFileSync(join(run.home, '.codex', 'hooks.json'), 'utf8')).toContain('agent-board-hook');

    // Notifications: Allow sends a test one, which is what makes the OS ask. Whether it was allowed can't be known, so
    // the row says only that it was sent, and can send another.
    await row(window, 'Notifications').getByRole('button', { name: 'Allow' }).click();
    await expect(badge(window, 'Notifications')).toHaveAccessibleName('Ready');
    await expect(row(window, 'Notifications')).toContainText('test notification sent');
    expect(await notifications(app)).toEqual(['Test notification']);
    await row(window, 'Notifications').getByRole('button', { name: 'Send again' }).click();
    await expect.poll(() => notifications(app)).toEqual(['Test notification', 'Test notification']);
    await expect(connect.getByTestId('connect-summary')).toContainText(darwin ? 'All set' : '5 of 6 ready');
    await shot(window, '2-connect-fixed');
    await connect.getByRole('button', { name: 'Continue' }).click();

    // The tour: five stops over the real chrome.
    const tour = window.getByTestId('tour');
    await expect(window.getByRole('dialog', { name: 'Your zones, agents and settings' })).toBeVisible();
    await expect(tour.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute('aria-valuenow', '3');
    await tour.getByRole('button', { name: 'Next' }).click();
    await expect(window.getByRole('dialog', { name: 'Add a zone: a group, or one for a repo' })).toBeVisible();
    await shot(window, '3-tour');
    for (const title of ['Agents waiting on you collect here', 'Double-click a tile to open it', 'Start an agent, and the keys to know']) {
      await tour.getByRole('button', { name: 'Next' }).click();
      await expect(window.getByRole('dialog', { name: title })).toBeVisible();
    }
    await tour.getByRole('button', { name: 'Finish' }).click();

    // Finish: create the first zone, from Add zone.
    const finish = window.getByRole('dialog', { name: 'You’re set up' });
    await expect(finish).toBeVisible();
    await shot(window, '4-finish');
    await finish.getByRole('button', { name: /Create your first zone/ }).click();
    await expect(finish).toBeHidden();
    await pickFolderNext(app, run.repo);
    const addZone = window.getByRole('dialog', { name: 'Add zone' });
    await addZone.getByRole('tab', { name: 'File browser' }).click();
    await addZone.getByRole('button', { name: 'Choose a folder…' }).click();
    await addZone.getByRole('button', { name: /^Add zone/ }).click();
    await expect(window.getByTestId('zone-tab').getByText('monorepo', { exact: true })).toBeVisible();
    // The N pressed under the welcome made nothing.
    expect(await window.evaluate(() => self.agentBoard.items.list())).toEqual([]);
    expect(await window.evaluate(() => self.agentBoard.view.get('onboarding'))).toEqual({ finished: true, showInMenu: true });
  } finally {
    await linear.close();
    run.github.dispose();
    keychain?.remove();
  }
});

test('onboarding can be skipped, stays closed on later launches, and Getting started reopens it', async () => {
  const run = firstRun();
  const dataDir = tempDataDir();
  try {
    const first = await launch(dataDir, run.env);
    await first.window.getByRole('dialog', { name: 'Welcome to agent-board' }).getByRole('button', { name: 'Skip' }).click();
    await expect(first.window.getByTestId('onboarding')).toBeHidden();
    await expect(first.window.getByTestId('empty-board')).toBeVisible();
    await first.app.close();

    // The board is still empty, but onboarding was skipped: it doesn't open again.
    const { app, window } = await launch(dataDir, run.env);
    await expect(window.getByTestId('empty-board')).toBeVisible();
    await expect(window.getByTestId('onboarding')).toHaveCount(0);

    // The board menu's Help › Getting started brings it back; Esc skips it again.
    await window.getByRole('button', { name: 'Board menu' }).click();
    await window.getByRole('button', { name: 'Getting started' }).click();
    await expect(window.getByRole('dialog', { name: 'Welcome to agent-board' })).toBeVisible();
    // Tab never leaves it for the board under it, either way round.
    for (const key of [...Array<string>(6).fill('Tab'), ...Array<string>(6).fill('Shift+Tab')]) {
      await window.keyboard.press(key);
      expect(await window.evaluate(() => document.activeElement?.closest('[data-onboarding-root]') !== null)).toBe(true);
    }
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('onboarding')).toHaveCount(0);

    // So does the app menu's Help › Getting started, and its tour's Esc skips to Finish, where the board menu's row
    // can be turned off.
    await app.evaluate(({ Menu }) => {
      const help = Menu.getApplicationMenu()!.items.find((item) => item.role === 'help')!;
      help.submenu!.items.find((item) => item.label === 'Getting started')!.click();
    });
    const welcome = window.getByRole('dialog', { name: 'Welcome to agent-board' });
    await welcome.getByRole('button', { name: 'Get started' }).click();
    await window.getByRole('dialog', { name: 'Connect your tools' }).getByRole('button', { name: 'Do this later' }).click();
    await expect(window.getByTestId('tour')).toBeVisible();
    await window.keyboard.press('Escape');
    const finish = window.getByRole('dialog', { name: 'You’re set up' });
    await finish.getByRole('checkbox').uncheck();
    await finish.getByRole('button', { name: 'Just show me the board' }).click();
    await window.getByRole('button', { name: 'Board menu' }).click();
    await expect(window.getByRole('button', { name: 'Find a zone or agent' }).or(window.getByLabel('Find a zone or agent'))).toBeVisible();
    await expect(window.getByRole('button', { name: 'Getting started' })).toHaveCount(0);
  } finally {
    run.github.dispose();
  }
});

test('the sample board shows agents in every state, and leaving it shows the real board', async () => {
  const run = firstRun();
  const dataDir = tempDataDir();
  try {
    const { window } = await launch(dataDir, run.env);
    await window.getByRole('dialog', { name: 'Welcome to agent-board' }).getByRole('button', { name: 'Get started' }).click();
    await window.getByRole('dialog', { name: 'Connect your tools' }).getByRole('button', { name: 'Continue' }).click();
    await window.getByTestId('tour').getByRole('button', { name: 'Skip tour' }).click();
    await window.getByRole('dialog', { name: 'You’re set up' }).getByRole('button', { name: /Explore a sample board/ }).click();
    const sample = window.getByTestId('sample-board');
    await expect(sample.getByTestId('agent-tile')).toHaveCount(10);
    await shot(window, '5-sample-board');
    await sample.getByRole('button', { name: 'Leave sample board' }).click();
    await expect(sample).toHaveCount(0);
    // Nothing was made: the board is as empty as before.
    await expect(window.getByTestId('empty-board')).toBeVisible();
    expect(await window.evaluate(() => self.agentBoard.agents.list())).toEqual([]);
  } finally {
    run.github.dispose();
  }
});

test('a board that holds only a session is not a first run: onboarding stays closed', async () => {
  const run = firstRun();
  const dataDir = tempDataDir();
  try {
    // Made before onboarding existed: a loose shell tile, and no onboarding saved.
    const before = await launch(dataDir, { ...run.env, AGENT_BOARD_ONBOARDING: '0' });
    await newShell(before.window);
    await expect(before.window.getByTestId('session-terminal')).toBeVisible();
    await before.app.close();

    const { window } = await launch(dataDir, run.env);
    await expect(window.locator('.hybrid-tile')).toHaveCount(1);
    await expect(window.getByTestId('onboarding')).toHaveCount(0);
    expect(await window.evaluate(() => self.agentBoard.view.get('onboarding'))).toBeNull();
  } finally {
    run.github.dispose();
  }
});

test('a Linear key Linear refuses is said so, and nothing is stored', async () => {
  const run = firstRun();
  const dataDir = tempDataDir();
  const { interactions } = JSON.parse(readFileSync(RECORDED_LINEAR_FIXTURES, 'utf8')) as { interactions: HttpInteraction[] };
  // Only Linear's recorded refusal of a revoked key.
  const linear = await serveFixtures(
    interactions.filter((i) => i.response.status === 401),
    LINEAR_API_URL,
  );
  try {
    const { window } = await launch(dataDir, { ...run.env, AGENT_BOARD_LINEAR_API_URL: linear.url });
    await window.getByRole('dialog', { name: 'Welcome to agent-board' }).getByRole('button', { name: 'Get started' }).click();
    await row(window, 'Linear').getByLabel('Linear API key').fill('lin_api_revoked0000');
    await row(window, 'Linear').getByRole('button', { name: 'Test' }).click();
    await expect(row(window, 'Linear')).toContainText('Linear refused the API key');
    await expect(badge(window, 'Linear')).toHaveAccessibleName('Not set up');
    // Refused before anything was stored: not in the database either.
    for (const file of readdirSync(dataDir).filter((name) => name.includes('.db'))) {
      expect(readFileSync(join(dataDir, file)).includes('lin_api_revoked0000')).toBe(false);
    }
  } finally {
    await linear.close();
    run.github.dispose();
  }
});
