import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { Agent } from '@agent-board/daemon/protocol';
import { rmSync } from 'node:fs';
import { launch, screen, sessionWindow, spawnAgent, tile } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// A steps card an agent waits on, in Needs you and above its composer: a set to answer (the fake claude's `Steps: …`),
// stepped through in place and sent; and a to-do of the user's it waits on (`Steps, then wait on <n>: …`), ticked in place.

const inbox = (window: Page) => window.getByTestId('needs-you-inbox');

/** Runs `body` with the app open on a fresh repo zone whose agents run the fake claude's `ask-plan` scenario. */
async function withApp(body: (window: Page, app: ElectronApplication) => Promise<void>): Promise<void> {
  const setup = scratch('ask-plan');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, setup.env);
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

/** Starts an agent in the repo's zone with `prompt`, and returns it. */
async function spawn(page: Page, prompt: string): Promise<Agent> {
  const before = await page.evaluate(() => window.agentBoard.agents.list());
  await spawnAgent(page, 'monorepo', prompt);
  const after = await page.evaluate(() => window.agentBoard.agents.list());
  return after.find((agent) => !before.some((known) => known.sessionId === agent.sessionId))!;
}

const listAgents = (page: Page) => page.evaluate(() => window.agentBoard.agents.list());

const openSession = async (window: Page, agent: Agent) => {
  await tile(window).and(window.locator(`[data-session-id="${agent.sessionId}"]`)).dblclick();
  await expect(sessionWindow(window)).toBeVisible();
};

test('a set an agent waits on is answered and sent from Needs you, in its stepper', async () => {
  await withApp(async (window) => {
    const agent = await spawn(window, 'Steps: # Release 1.4 ;; ? Which store? [Redis | SQLite] ;; ? Ship on Friday? [yes/no] (required)');
    await window.getByTestId('inbox-count').click();
    const row = inbox(window).getByTestId('steps-wait');
    await expect(row).toHaveAttribute('data-kind', 'steps');
    await expect(row).toContainText('Release 1.4');
    await expect(row).toContainText('2 questions for you');

    await row.getByTestId('steps-wait-answer').click();
    const stepper = row.getByTestId('steps-stepper');
    await expect(stepper).toContainText('Which store?');
    await expect(stepper).toContainText('0 of 2 answered');
    // Opened by Answer, it has the keys: 2 picks the second choice.
    await expect(stepper).toBeFocused();
    await window.keyboard.press('2');
    await expect(stepper.getByRole('button', { name: /SQLite/ })).toHaveAttribute('aria-pressed', 'true');
    await stepper.getByRole('button', { name: /Next|Skip/ }).click();
    await expect(stepper).toContainText('Ship on Friday?');
    // On the required question it is named, and Send waits for it.
    await expect(stepper).toContainText('Step 2 is required');
    await expect(stepper.getByTestId('steps-stepper-send')).toHaveCount(0);
    // Back keeps the answer given.
    await stepper.getByRole('button', { name: 'Back' }).click();
    await expect(stepper.getByRole('button', { name: /SQLite/ })).toHaveAttribute('aria-pressed', 'true');
    await stepper.getByRole('button', { name: /Next|Skip/ }).click();
    await stepper.getByRole('button', { name: /Yes/ }).click();
    await expect(stepper.getByTestId('steps-stepper-send')).toHaveText(/Send 2 answers/);
    await stepper.getByTestId('steps-stepper-send').click();

    // Sent, it leaves Needs you, and the answers are typed at the agent's prompt.
    await expect(inbox(window).getByTestId('steps-wait')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await openSession(window, agent);
    await expect(screen(window)).toContainText('[agent-board] The user answered your steps “Release 1.4”');
    await expect(screen(window)).toContainText('SQLite');
  });
});

test('a to-do of yours an agent waits on is ticked from Needs you, and the agent is told', async () => {
  await withApp(async (window) => {
    const agent = await spawn(window, 'Steps, then wait on 2: # Deploy checklist ;; - [ ] Pull main ;; - [ ] Rotate the deploy key @user');
    await window.getByTestId('inbox-count').click();
    const row = inbox(window).getByTestId('steps-wait');
    await expect(row).toHaveAttribute('data-kind', 'todo');
    await expect(row).toContainText('Rotate the deploy key');
    await expect(row).toContainText('Deploy checklist');

    await row.getByRole('button', { name: 'Done' }).click();
    await expect(inbox(window).getByTestId('steps-wait')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await openSession(window, agent);
    await expect(screen(window)).toContainText('is done, ticked by the user: Rotate the deploy key', { timeout: 15_000 });
  });
});

test('the asking agent’s window shows its set above the composer, and answers it there', async () => {
  await withApp(async (window) => {
    const agent = await spawn(window, 'Steps: # Cache plan ;; ? Which store? [Redis | SQLite]');
    await openSession(window, agent);
    const strip = sessionWindow(window).getByTestId('steps-strip');
    // It opens on its questions, as the quick ask does in the window: keys answer it.
    await expect(strip.getByTestId('steps-stepper')).toContainText('Cache plan');
    await strip.getByTestId('steps-stepper').focus();
    await window.keyboard.press('1');
    await expect(strip.getByRole('button', { name: /Redis/ })).toHaveAttribute('aria-pressed', 'true');
    await strip.getByTestId('steps-stepper-send').click();
    await expect(strip).toHaveCount(0);
    await expect(screen(window)).toContainText('[agent-board] The user answered your steps “Cache plan”', { timeout: 15_000 });
  });
});

test('a to-do’s link opens from Needs you, the agent’s window and its card, and ticks nothing', async () => {
  await withApp(async (window, app) => {
    // The open is stubbed: nothing leaves the machine.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { opened?: string[] }).opened = opened;
      shell.openExternal = async (url: string) => void opened.push(url);
    });
    const opened = () => app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? []);
    const url = 'https://example.com/decision-1';
    const agent = await spawn(window, `Steps, then wait on 1: # Decisions ;; - [ ] Read the decision @user -> ${url}`);

    // Needs you: the row's link opens, by click and by keyboard, and the to-do stays unticked.
    await window.getByTestId('inbox-count').click();
    const row = inbox(window).getByTestId('steps-wait');
    const link = row.getByTestId('steps-link');
    await link.click();
    await expect.poll(opened).toEqual([url]);
    await link.focus();
    await window.keyboard.press('Enter');
    await expect.poll(opened).toEqual([url, url]);
    await expect(row).toHaveAttribute('data-kind', 'todo');
    await window.keyboard.press('Escape');

    // The card on the board, at rest and open.
    const card = window.getByTestId('steps-card').first();
    await card.getByTestId('steps-link').click();
    await expect.poll(opened).toHaveLength(3);
    await card.click();
    await card.getByTestId('steps-link').click();
    await expect.poll(opened).toHaveLength(4);
    await expect(card.getByRole('button', { name: 'Untick' })).toHaveCount(0);

    // The agent's window: its strip.
    await openSession(window, agent);
    const strip = sessionWindow(window).getByTestId('steps-strip');
    await strip.getByTestId('steps-link').click();
    await expect.poll(opened).toHaveLength(5);
    await expect(strip.getByTestId('steps-wait')).toHaveAttribute('data-kind', 'todo');
    // Nothing was ticked: the agent still waits on it.
    expect((await listAgents(window)).find((each) => each.sessionId === agent.sessionId)?.stepsWait?.kind).toBe('todo');
  });
});
