import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { Agent } from '@agent-board/daemon/protocol';
import { rmSync } from 'node:fs';
import { agents, launch, sessionWindow, spawnAgent, tile } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import type { FakeScenario } from '@agent-board/fake-harness';

// Under the Simplified design a permission prompt the board holds the harness's hook for shows above the pane's composer,
// in a plain sentence, and is answered there. The fake claude asks for a shell command: `permission` asks for `rm -rf dist`
// (destructive), `long-permission` for the prompt itself. Nothing here answers for the user but a click.

const decision = (window: Page) => sessionWindow(window).getByTestId('pane-decision');
const latest = async (window: Page, agent: Agent) => (await agents(window)).find((each) => each.sessionId === agent.sessionId)!;

async function spawn(window: Page, prompt: string, harness: 'Claude' | 'Codex' = 'Claude'): Promise<Agent> {
  const before = await agents(window);
  await spawnAgent(window, 'monorepo', prompt, { harness });
  return (await agents(window)).find((agent) => !before.some((known) => known.sessionId === agent.sessionId))!;
}

/** Runs `body` with the app open on a fresh repo zone whose agents run the fake claude's `scenario`, suggesting a rule to allow. */
async function withApp(scenario: FakeScenario, body: (window: Page, app: ElectronApplication) => Promise<void>): Promise<void> {
  const setup = scratch(scenario);
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...setup.env, FAKE_HARNESS_PERMISSION_SUGGESTIONS: '1' }, [], { design: 'simplified' });
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

const openTerminal = (window: Page) => sessionWindow(window).getByRole('button', { name: 'Terminal' }).click();

test('a command to run reads as a sentence, and Allow once runs it', async () => {
  await withApp('long-permission', async (window) => {
    const agent = await spawn(window, 'pnpm test');
    await expect(tile(window)).toHaveAttribute('data-state', 'needs-permission');
    await tile(window).dblclick();

    const frame = decision(window);
    await expect(frame).toHaveAttribute('data-kind', 'permission');
    await expect(frame).toContainText(`${agent.name} wants to`);
    await expect(frame.getByTestId('permission-sentence')).toHaveText('Run a command: run it');
    await expect(frame.getByTestId('permission-detail')).toHaveText('pnpm test');
    // Claude asks in its terminal while the board holds the request, so there is no hold to count down.
    await expect(frame.getByTestId('permission-countdown')).toHaveText('Its terminal asks too.');
    await expect(frame.getByRole('button')).toHaveText([/^Decide later/, 'Deny', 'Allow pnpm test for this session', 'Allow once']);
    // The card has the keyboard but answers nothing on its own: the agent still waits.
    await expect(frame).toBeFocused();
    expect((await latest(window, agent)).permissions).toHaveLength(1);

    await frame.getByRole('button', { name: 'Allow once' }).click();
    await expect(frame).toHaveCount(0);
    await expect.poll(async () => (await latest(window, agent)).permissions).toHaveLength(0);
    await openTerminal(window);
    await expect(sessionWindow(window).getByTestId('session-terminal')).not.toContainText('for the session');
  });
});

test('Allow for this session sends the rule the harness suggested, scoped to the session', async () => {
  await withApp('long-permission', async (window) => {
    const agent = await spawn(window, 'pnpm lint');
    await tile(window).dblclick();
    await decision(window).getByRole('button', { name: 'Allow pnpm lint for this session' }).click();
    await expect.poll(async () => (await latest(window, agent)).permissions).toHaveLength(0);
    await openTerminal(window);
    await expect(sessionWindow(window).getByTestId('session-terminal')).toContainText('Allowed Bash for the session');
  });
});

test('Deny reaches the harness, which leaves the command alone', async () => {
  await withApp('long-permission', async (window) => {
    const agent = await spawn(window, 'pnpm install');
    await tile(window).dblclick();
    await decision(window).getByRole('button', { name: 'Deny' }).click();
    await expect.poll(async () => (await latest(window, agent)).permissions).toHaveLength(0);
    await openTerminal(window);
    await expect(sessionWindow(window).getByTestId('session-terminal')).toContainText('Denied');
  });
});

test('a destructive command has Review… and Deny, no Allow, and no default button', async () => {
  await withApp('permission', async (window) => {
    const agent = await spawn(window, 'Clean up');
    await tile(window).dblclick();

    const frame = decision(window);
    await expect(frame.getByTestId('permission-sentence')).toHaveText('Run a command: remove build output');
    await expect(frame.getByTestId('permission-detail')).toHaveText('rm -rf dist');
    await expect(frame.getByRole('button')).toHaveText([/^Decide later/, 'Deny', 'Review…']);
    await expect(frame.getByRole('button', { name: /allow/i })).toHaveCount(0);
    // No button has the focus, so Return answers nothing.
    await expect(frame).toBeFocused();
    await window.keyboard.press('Enter');
    expect((await latest(window, agent)).permissions).toHaveLength(1);

    // Review… lets the harness ask now, not when the hold lapses, and shows the terminal where it does. Nothing is answered.
    await frame.getByRole('button', { name: 'Review…' }).click();
    await expect(sessionWindow(window).getByTestId('session-terminal')).toContainText('(y/n)');
    await expect(frame).toHaveCount(0);
    expect((await latest(window, agent)).permissions).toMatchObject([{ heldUntil: null }]);
  });
});

test('Esc puts a permission off without answering it, and a line brings it back', async () => {
  await withApp('long-permission', async (window) => {
    const agent = await spawn(window, 'pnpm build');
    await tile(window).dblclick();
    await expect(decision(window)).toBeFocused();
    await window.keyboard.press('Escape');
    await expect(decision(window)).toHaveCount(0);
    await expect(sessionWindow(window).getByTestId('pane-decision-later')).toContainText(`${agent.name} asked to run a command`);
    expect((await latest(window, agent)).permissions).toHaveLength(1);
    await sessionWindow(window).getByTestId('pane-decision-later').getByRole('button', { name: 'Review' }).click();
    await expect(decision(window)).toBeVisible();
  });
});

// Codex answers through the same held hook, but its hook reply has no session scope: no middle button.
test('under Codex, Allow once and Deny reach the harness and there is no Allow for this session', async () => {
  await withApp('long-permission', async (window) => {
    const allowed = await spawn(window, 'pnpm test', 'Codex');
    await tile(window).and(window.locator(`[data-session-id="${allowed.sessionId}"]`)).dblclick();
    const frame = decision(window);
    await expect(frame.getByTestId('permission-sentence')).toHaveText('Run a command: run it');
    await expect(frame.getByRole('button')).toHaveText([/^Decide later/, 'Deny', 'Allow once']);
    await expect(frame.getByTestId('permission-countdown')).toContainText("If you don't answer within");
    await frame.getByRole('button', { name: 'Allow once' }).click();
    await expect.poll(async () => (await latest(window, allowed)).permissions).toHaveLength(0);
    await openTerminal(window);
    await expect(sessionWindow(window).getByTestId('session-terminal')).not.toContainText('(y/n)');
    await sessionWindow(window).getByRole('button', { name: 'Done' }).click();

    const denied = await spawn(window, 'pnpm install', 'Codex');
    await tile(window).and(window.locator(`[data-session-id="${denied.sessionId}"]`)).dblclick();
    await decision(window).getByRole('button', { name: 'Deny' }).click();
    await expect.poll(async () => (await latest(window, denied)).permissions).toHaveLength(0);
    await openTerminal(window);
    await expect(sessionWindow(window).getByTestId('session-terminal')).toContainText('Denied');
  });
});

test('under Codex a destructive command has Review… and Deny, and Review… lets its terminal ask', async () => {
  await withApp('permission', async (window) => {
    const agent = await spawn(window, 'Clean up', 'Codex');
    await tile(window).and(window.locator(`[data-session-id="${agent.sessionId}"]`)).dblclick();
    const frame = decision(window);
    await expect(frame.getByRole('button')).toHaveText([/^Decide later/, 'Deny', 'Review…']);
    await frame.getByRole('button', { name: 'Review…' }).click();
    await expect(sessionWindow(window).getByTestId('session-terminal')).toContainText('(y/n)');
    expect((await latest(window, agent)).permissions).toMatchObject([{ heldUntil: null }]);
  });
});
