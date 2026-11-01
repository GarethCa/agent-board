import { expect, type Page } from '@playwright/test';
import { fakeBinDir } from '@agent-board/fake-harness';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { launch, screen } from './agent-helpers.ts';
import { test, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

// The Simplified design's first run: the Captain's welcome, then getting Claude ready. The app runs on a bare PATH
// with an empty bin dir first, so it never finds the developer's real CLIs; "installing" Claude Code puts the fake
// there. The installer itself is only shown, to copy: nothing here runs it.

const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const INSTALL_COMMAND = 'curl -fsSL https://claude.ai/install.sh | bash';

/** A first-run env under the Simplified design: nothing installed, onboarding allowed. */
function firstRun(extra: Record<string, string> = {}) {
  const { env, dir } = scratch('output');
  const bin = join(dir, 'bin');
  const nodeBin = join(dir, 'node-bin');
  mkdirSync(bin);
  mkdirSync(nodeBin);
  // The fakes run on node; nothing else is in this dir.
  symlinkSync(process.execPath, join(nodeBin, 'node'));
  return {
    env: { ...env, PATH: `${bin}:${nodeBin}:${BARE_PATH}`, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0', AGENT_BOARD_ONBOARDING: '1', ...extra },
    /** Puts the fake Claude Code on the app's PATH, as installing it would. */
    install() {
      symlinkSync(join(fakeBinDir, 'claude'), join(bin, 'claude'));
    },
  };
}

const ready = (window: Page) => window.getByRole('dialog', { name: 'Let’s get Claude ready' });
const row = (window: Page, name: string) => ready(window).getByRole('listitem', { name });
const mark = (window: Page, name: string) => row(window, name).getByRole('img', { name: /^(Done|To do|Checking|Not yet)$/ });
const onboarding = (window: Page) => window.evaluate(() => self.agentBoard.view.get('onboarding'));

test('Simplified first run, with Claude Code missing: the Captain, then the install command to copy and a terminal, then ready', async () => {
  const run = firstRun();
  const { app, window } = await launch(tempDataDir(), run.env, [], { design: 'simplified' });

  // The Captain says hello: step 1 of 2.
  const welcome = window.getByRole('dialog', { name: 'Ahoy! I’m the Captain.' });
  await expect(welcome).toBeVisible();
  await expect(welcome.getByRole('img', { name: 'The Captain' })).toBeVisible();
  await expect(welcome).toContainText('Step 1 of 2');
  await expect(welcome.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute('aria-valuemax', '2');
  await welcome.getByRole('button', { name: 'Get started' }).click();

  // Claude Code isn't found: the command to install it, and signing in waits on it. Continue stays shut.
  await expect(ready(window)).toContainText('Step 2 of 2');
  await expect(mark(window, 'Claude Code')).toHaveAccessibleName('To do');
  await expect(row(window, 'Claude Code')).toContainText('Claude Code isn’t installed yet');
  await expect(row(window, 'Claude Code').getByLabel('Install command')).toHaveText(INSTALL_COMMAND);
  await expect(mark(window, 'Sign in')).toHaveAccessibleName('Not yet');
  await expect(ready(window).getByRole('button', { name: 'Continue' })).toBeDisabled();
  await expect(ready(window).getByRole('button', { name: 'Skip for now' })).toBeVisible();
  // Under the Simplified design, nothing on this step names a CLI, a PATH or a hooks file.
  await expect(ready(window)).not.toContainText(/CLI|PATH|hooks/);

  // Copy puts the command on the clipboard.
  await row(window, 'Claude Code').getByRole('button', { name: 'Copy' }).click();
  await expect(row(window, 'Claude Code').getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(INSTALL_COMMAND);

  // Open Terminal opens a shell tile with nothing typed in it: the installer is the user's to run.
  await row(window, 'Claude Code').getByRole('button', { name: 'Open Terminal' }).click();
  await expect(screen(window)).toContainText('$');
  await expect(window.getByTestId('onboarding-away')).toBeVisible();
  await expect(screen(window)).not.toContainText('install.sh');

  // Back in setup, it checks again: still not installed.
  await window.getByTestId('onboarding-away').getByRole('button', { name: 'Back to setup' }).click();
  await expect(window.getByTestId('session-terminal')).toHaveCount(0);
  await expect(mark(window, 'Claude Code')).toHaveAccessibleName('To do');

  // Installed (the fake, signed in): Check again finds it, and both rows are done.
  run.install();
  await row(window, 'Claude Code').getByRole('button', { name: 'Check again' }).click();
  await expect(mark(window, 'Claude Code')).toHaveAccessibleName('Done');
  await expect(row(window, 'Claude Code')).toContainText('Claude Code is installed');
  await expect(mark(window, 'Sign in')).toHaveAccessibleName('Done');
  await expect(row(window, 'Sign in')).toContainText('Signed in to Claude');
  await expect(ready(window).getByRole('button', { name: 'Skip for now' })).toHaveCount(0);

  // Continue ends it on the board, and it doesn't open by itself again.
  await ready(window).getByRole('button', { name: 'Continue' }).click();
  await expect(window.getByTestId('onboarding')).toHaveCount(0);
  expect(await onboarding(window)).toEqual({ finished: true, showInMenu: true });
});

test('Simplified first run, installed but signed out: Sign in runs Claude Code’s sign-in in a terminal; Back, Skip for now, and Getting started brings it back', async () => {
  const run = firstRun({ FAKE_HARNESS_LOGGED_OUT: '1' });
  run.install();
  const dataDir = tempDataDir();
  const first = await launch(dataDir, run.env, [], { design: 'simplified' });
  let { window } = first;
  await first.app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { opened?: string[] }).opened = opened;
    shell.openExternal = async (url: string) => void opened.push(url);
  });

  await window.getByRole('dialog', { name: 'Ahoy! I’m the Captain.' }).getByRole('button', { name: 'Get started' }).click();
  await expect(mark(window, 'Claude Code')).toHaveAccessibleName('Done');
  await expect(mark(window, 'Sign in')).toHaveAccessibleName('To do');
  await expect(row(window, 'Sign in')).toContainText('a Claude plan or an API key');
  await expect(ready(window).getByRole('button', { name: 'Continue' })).toBeDisabled();
  // Which plans work? opens Anthropic's page on who can sign in.
  await row(window, 'Sign in').getByRole('button', { name: 'Which plans work?' }).click();
  await expect.poll(() => first.app.evaluate(() => (globalThis as { opened?: string[] }).opened)).toEqual(['https://code.claude.com/docs/en/authentication']);

  // Sign in runs the found Claude Code's own sign-in, in a shell tile, on this click only.
  await row(window, 'Sign in').getByRole('button', { name: 'Sign in' }).click();
  await expect(screen(window)).toContainText('auth login');
  await window.getByTestId('onboarding-away').getByRole('button', { name: 'Back to setup' }).click();
  // Still signed out (the fake stays so): the row still asks.
  await expect(mark(window, 'Sign in')).toHaveAccessibleName('To do');

  // Back goes to the Captain's welcome, and Get started returns.
  await ready(window).getByRole('button', { name: 'Back' }).click();
  await window.getByRole('dialog', { name: 'Ahoy! I’m the Captain.' }).getByRole('button', { name: 'Get started' }).click();

  // Skip for now ends it on the board.
  await ready(window).getByRole('button', { name: 'Skip for now' }).click();
  await expect(window.getByTestId('onboarding')).toHaveCount(0);
  expect(await onboarding(window)).toEqual({ finished: true, showInMenu: true });
  await first.app.close();

  // Skipped, it doesn't open by itself on the next launch; the board menu's Getting started brings the Captain back.
  ({ window } = await launch(dataDir, run.env, [], { design: 'simplified' }));
  await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
  await expect(window.getByTestId('onboarding')).toHaveCount(0);
  await window.getByRole('button', { name: 'Board menu' }).click();
  await window.getByRole('button', { name: 'Getting started' }).click();
  await expect(window.getByRole('dialog', { name: 'Ahoy! I’m the Captain.' })).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('onboarding')).toHaveCount(0);
});

test('Simplified first run, with Claude Code ready: both rows are done straight away, and Esc skips', async () => {
  const run = firstRun();
  run.install();
  const { window } = await launch(tempDataDir(), run.env, [], { design: 'simplified' });

  await window.getByRole('dialog', { name: 'Ahoy! I’m the Captain.' }).getByRole('button', { name: 'Get started' }).click();
  await expect(mark(window, 'Claude Code')).toHaveAccessibleName('Done');
  await expect(mark(window, 'Sign in')).toHaveAccessibleName('Done');
  await expect(ready(window).getByRole('button', { name: 'Continue' })).toBeEnabled();
  await expect(ready(window).getByLabel('Install command')).toHaveCount(0);

  await window.keyboard.press('Escape');
  await expect(window.getByTestId('onboarding')).toHaveCount(0);
  expect(await onboarding(window)).toEqual({ finished: true, showInMenu: true });
});
