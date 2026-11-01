import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { Agent } from '@agent-board/daemon/protocol';
import { rmSync } from 'node:fs';
import { agents, launch, sessionWindow, spawnAgent, tile, windowKey } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test, type LaunchOptions } from './launch.ts';
import { scratch } from './scratch.ts';

// Under the Simplified design an agent's question or plan shows above its pane's composer and is answered there. The
// fake claude's `ask-plan` scenario does the asking; nothing here answers for the user but a click or a key press.

const decision = (window: Page) => sessionWindow(window).getByTestId('pane-decision');
const later = (window: Page) => sessionWindow(window).getByTestId('pane-decision-later');
const latest = async (window: Page, agent: Agent) => (await agents(window)).find((each) => each.sessionId === agent.sessionId)!;

/** Starts an agent in the repo's zone with `prompt`, and returns it. */
async function spawn(window: Page, prompt: string): Promise<Agent> {
  const before = await agents(window);
  await spawnAgent(window, 'monorepo', prompt);
  return (await agents(window)).find((agent) => !before.some((known) => known.sessionId === agent.sessionId))!;
}

/** Runs `body` with the app open on a fresh repo zone whose agents run the fake claude's `ask-plan` scenario. */
async function withApp(options: LaunchOptions, body: (window: Page, app: ElectronApplication) => Promise<void>): Promise<void> {
  const setup = scratch('ask-plan');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, setup.env, [], options);
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

test('a question shows above the composer with the keyboard on it, Esc puts it off while it waits in Needs you, and choice 2 answers it', async () => {
  await withApp({ design: 'simplified' }, async (window) => {
    const agent = await spawn(window, 'Ask: Which cache should the product pages use? | Redis | In-memory LRU | CDN only');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');
    await tile(window).dblclick();

    const frame = decision(window);
    await expect(frame).toHaveAttribute('data-kind', 'ask');
    await expect(frame).toContainText(`${agent.name} asks`);
    await expect(frame).toContainText('Which cache should the product pages use?');
    const choices = frame.getByRole('group', { name: `Answers for ${agent.name}` }).getByRole('button');
    await expect(choices).toHaveText(['1Redis', '2In-memory LRU', '3CDN only']);
    await expect(frame.getByLabel(`Reply to ${agent.name}`)).toHaveAttribute('placeholder', 'Something else…');
    // The composer stays beneath it, and the card has the keyboard as the window opens.
    await expect(sessionWindow(window).getByLabel('Message to the agent')).toBeVisible();
    await expect(frame).toBeFocused();

    // Esc is Decide later: the window stays open, the question still waits, and a line brings it back.
    await window.keyboard.press('Escape');
    await expect(frame).toHaveCount(0);
    await expect(sessionWindow(window)).toBeVisible();
    await expect(later(window)).toContainText(`${agent.name} asked you a question`);
    expect((await latest(window, agent)).ask).not.toBeNull();

    // It is still in Needs you (the docked list, behind the window).
    await window.getByTestId('inbox-count').dispatchEvent('click');
    await expect(window.locator(`[data-testid="inbox-item"][data-session-id="${agent.sessionId}"]`).getByTestId('inbox-ask')).toHaveCount(1);
    await window.getByTestId('inbox-count').dispatchEvent('click');

    // Closed and opened again, the window keeps it put off.
    await sessionWindow(window).getByRole('button', { name: 'Done' }).click();
    await expect(sessionWindow(window)).toHaveCount(0);
    await tile(window).dblclick();
    await expect(later(window)).toBeVisible();
    await expect(frame).toHaveCount(0);

    // Brought back, it has the keyboard again.
    await later(window).getByRole('button', { name: 'Answer' }).click();
    await expect(frame).toBeFocused();

    // A digit typed in the composer is the draft's, never an answer.
    const field = sessionWindow(window).getByLabel('Message to the agent');
    await field.click();
    await window.keyboard.press('2');
    await expect(field).toHaveValue('2');
    expect((await latest(window, agent)).ask).not.toBeNull();
    await expect(frame).toBeVisible();

    // Back on the card, its second choice answers it on its key.
    await frame.getByText('Which cache should the product pages use?').click();
    await window.keyboard.press('2');
    await expect(frame).toHaveCount(0);
    await expect(later(window)).toHaveCount(0);
    await expect.poll(async () => (await latest(window, agent)).ask).toBeNull();
    await sessionWindow(window).getByRole('button', { name: 'Terminal' }).click();
    await expect(sessionWindow(window).getByTestId('session-terminal')).toContainText('The user answered: In-memory LRU');
  });
});

test('a plan shows above the composer with Reject leading and Approve trailing, Read the plan opens its tab, and ⌘↵ approves it', async () => {
  await withApp({ design: 'simplified' }, async (window) => {
    const agent = await spawn(window, 'Plan: Cache product pages in Redis');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');
    await tile(window).dblclick();

    const frame = decision(window);
    await expect(frame).toHaveAttribute('data-kind', 'plan');
    await expect(frame).toContainText('Plan v1');
    await expect(frame).toContainText('Cache product pages in Redis');
    await expect(frame.getByTestId('plan-decision').getByRole('button')).toHaveText(['Reject', 'Request changes', /^Approve/]);
    const comments = frame.getByLabel(`Comments on plan v1 for ${agent.name}`);
    await expect(comments).toBeFocused();

    await frame.getByRole('button', { name: 'Read the plan ›' }).click();
    await expect(sessionWindow(window).getByTestId('plan-view')).toBeVisible();
    // The card is the chat's: back on it, the plan is decided there.
    await sessionWindow(window).getByRole('tab', { name: 'claude', exact: true }).click();
    await expect(comments).toBeFocused();

    // Its comments take the keyboard, Return is a new line in them, and ⌘↵ approves.
    await window.keyboard.type('Keep the TTL short');
    await window.keyboard.press(windowKey('Enter'));
    await expect.poll(async () => (await latest(window, agent)).plan?.decision?.outcome).toBe('approved');
    expect((await latest(window, agent)).plan?.decision?.comments).toBe('Keep the TTL short');
    await expect(frame).toHaveCount(0);
  });
});

test('under Classic a question stays out of the pane', async () => {
  await withApp({}, async (window) => {
    await spawn(window, 'Ask: Which cache? | Redis | CDN only');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');
    await tile(window).dblclick();
    await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
    await expect(sessionWindow(window).getByLabel('Message to the agent')).toBeVisible();
    await expect(decision(window)).toHaveCount(0);
  });
});
