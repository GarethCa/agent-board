import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { Agent } from '@agent-board/daemon/protocol';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launch, screen, sessionWindow, spawnAgent, tile } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { serveWebPages } from './web-server.ts';
import { drag } from './board-helpers.ts';

// An agent asks the user and presents plans through the board MCP, and the user answers from the inbox and
// the Plan tab. The fake claude's `ask-plan` scenario does the asking; nothing here answers for the user.

const item = (window: Page, agent: Agent) => window.locator(`[data-testid="inbox-item"][data-session-id="${agent.sessionId}"]`);
const agentTile = (window: Page, agent: Agent) => tile(window).and(window.locator(`[data-session-id="${agent.sessionId}"]`));
const planView = (window: Page) => sessionWindow(window).getByTestId('plan-view');
const questionCard = (window: Page, agent: Agent) => window.locator(`[data-testid="question-card"][data-session-id="${agent.sessionId}"]`);

/** Opens the inbox from the Needs-you pill if it is closed. Dispatched: a session window's scrim may cover the pill. */
async function openInbox(window: Page): Promise<void> {
  if (!(await window.getByTestId('needs-you-inbox').isVisible())) await window.getByTestId('inbox-count').dispatchEvent('click');
  await expect(window.getByTestId('needs-you-inbox')).toBeVisible();
}

/** Starts an agent in the repo's zone with `prompt`, and returns it. */
async function spawn(page: Page, prompt: string): Promise<Agent> {
  const before = await page.evaluate(() => window.agentBoard.agents.list());
  await spawnAgent(page, 'monorepo', prompt);
  const after = await page.evaluate(() => window.agentBoard.agents.list());
  return after.find((agent) => !before.some((known) => known.sessionId === agent.sessionId))!;
}

/** The agent as the daemon has it now. */
const latest = (page: Page, agent: Agent) => page.evaluate((sessionId) => window.agentBoard.agents.list().then((all) => all.find((each) => each.sessionId === sessionId)!), agent.sessionId);

const notifications = (app: ElectronApplication) => app.evaluate(() => (globalThis.agentBoardNotifications ?? []).map(({ title, body }) => ({ title, body })));

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

test('a question an agent asks waits in the inbox, a button per option, and the one the user clicks is its answer', async () => {
  await withApp(async (window, app) => {
    const agent = await spawn(window, 'Ask: Which cache should the product pages use? | Redis | In-memory LRU | CDN only');

    // The tile keeps its orange border, shows the question and its options, and says it asks you.
    await expect(agentTile(window, agent)).toHaveAttribute('data-state', 'waiting');
    await expect(agentTile(window, agent).getByTestId('tile-ask')).toHaveText('Which cache should the product pages use?\nRedis · In-memory LRU · CDN only');
    await expect(agentTile(window, agent).getByText('asks you')).toBeVisible();
    await expect.poll(() => notifications(app)).toContainEqual({ title: `${agent.name} asks you`, body: 'Which cache should the product pages use? (Redis · In-memory LRU · CDN only)' });

    await openInbox(window);
    const card = item(window, agent).getByTestId('inbox-ask');
    await expect(card).toContainText('Which cache should the product pages use?');
    await expect(card).toContainText(/Waits \d+ more minutes, then carries on without an answer/);
    await expect(card.getByLabel(`Reply to ${agent.name}`)).toHaveAttribute('placeholder', 'Or reply in your own words…');
    await card.getByRole('button', { name: 'In-memory LRU', exact: true }).click();

    await expect(item(window, agent)).toHaveCount(0);
    await agentTile(window, agent).dispatchEvent('dblclick');
    await expect(screen(window)).toContainText('The user answered: In-memory LRU');
  });
});

test('a question answered in the user’s own words, and one skipped, each reach the agent as they were', async () => {
  await withApp(async (window) => {
    const words = await spawn(window, 'Ask in words: What should the banner say?');
    await openInbox(window);
    const card = item(window, words).getByTestId('inbox-ask');
    await card.getByLabel(`Reply to ${words.name}`).fill('Free shipping over £50');
    await card.getByRole('button', { name: `Send to ${words.name}` }).click();
    await expect(item(window, words)).toHaveCount(0);

    const skipped = await spawn(window, 'Ask only: Which cache? | Redis | CDN only');
    await openInbox(window);
    const only = item(window, skipped).getByTestId('inbox-ask');
    // Only its options: no reply field.
    await expect(only.getByRole('button', { name: 'Redis', exact: true })).toBeVisible();
    await expect(only.getByLabel(`Reply to ${skipped.name}`)).toHaveCount(0);
    await only.getByRole('button', { name: `Skip ${skipped.name}'s question` }).click();
    await expect(item(window, skipped)).toHaveCount(0);

    await agentTile(window, words).dispatchEvent('dblclick');
    await expect(screen(window)).toContainText('The user answered: Free shipping over £50');
    await window.keyboard.press('Escape');
    await agentTile(window, skipped).dispatchEvent('dblclick');
    await expect(screen(window)).toContainText('The user skipped the question');
  });
});

test('a question asked on the board is a card beside its tile, which stays where it is dragged and goes once answered there or in the inbox', async () => {
  await withApp(async (window) => {
    const agent = await spawn(window, 'Ask on the board: Which cache should the product pages use? | Redis | CDN only');
    const card = questionCard(window, agent);
    await expect(card).toContainText('Which cache should the product pages use?');
    await expect(card).toHaveAttribute('data-side', 'left');
    // The tile points at the card rather than repeating the question.
    await expect(agentTile(window, agent).getByTestId('tile-ask')).toHaveText('Asking you ↗');
    const tileBox = (await agentTile(window, agent).boundingBox())!;
    const cardBox = (await card.boundingBox())!;
    expect(cardBox.x).toBeGreaterThan(tileBox.x + tileBox.width);

    // Dragged by its head, it stays where it is dropped, tethered to its tile, and the question keeps its place.
    const head = (await card.locator('.question-card-head').boundingBox())!;
    const from = { x: head.x + 20, y: head.y + head.height / 2 };
    await drag(window, from, { x: from.x + 160, y: from.y + 220 });
    await expect(card).not.toHaveAttribute('data-side');
    await expect.poll(async () => (await window.evaluate(() => globalThis.window.agentBoard.agents.list())).find((known) => known.sessionId === agent.sessionId)?.ask?.at).not.toBeNull();
    const moved = (await card.boundingBox())!;
    expect(moved.y).toBeGreaterThan(cardBox.y + 150);
    await expect(window.getByTestId('agent-note-tether')).toHaveCount(1);

    // Its options answer it from the card, as the inbox does, and the inbox item goes with the card.
    await card.getByRole('button', { name: 'CDN only' }).click();
    await expect(card).toHaveCount(0);
    await openInbox(window);
    await expect(item(window, agent)).toHaveCount(0);
    await window.keyboard.press('Escape');

    // Answered in the inbox instead, its card goes too.
    const inboxed = await spawn(window, 'Ask on the board: What should the banner say? | Free shipping');
    await expect(questionCard(window, inboxed)).toBeVisible();
    await openInbox(window);
    await item(window, inboxed).getByTestId('inbox-ask').getByRole('button', { name: 'Free shipping', exact: true }).click();
    await expect(questionCard(window, inboxed)).toHaveCount(0);

    // Selected by a click on its question, a card moves on the arrow keys, and the move is kept with its question.
    const keyed = await spawn(window, 'Ask on the board: Which region? | eu-west-1 | us-east-1');
    const keyedCard = questionCard(window, keyed);
    await keyedCard.locator('.question-card-question').click();
    await window.keyboard.press('ArrowDown');
    await window.keyboard.press('ArrowDown');
    await expect(keyedCard).not.toHaveAttribute('data-side');
    await expect.poll(async () => (await window.evaluate(() => globalThis.window.agentBoard.agents.list())).find((known) => known.sessionId === keyed.sessionId)?.ask?.at).not.toBeNull();

    // A digit typed into its reply is a word, and one pressed with a control elsewhere focused is that control's.
    await keyedCard.getByLabel(`Reply to ${keyed.name}`).fill('');
    await keyedCard.getByLabel(`Reply to ${keyed.name}`).pressSequentially('1');
    await expect(keyedCard.getByLabel(`Reply to ${keyed.name}`)).toHaveValue('1');
    await keyedCard.locator('.question-card-question').click();
    await window.getByTestId('inbox-count').focus();
    await window.keyboard.press('1');
    await expect(keyedCard).toBeVisible();

    // One key answers one question: picking another agent's in the inbox leaves the selected card alone.
    const other = await spawn(window, 'Ask: Which queue? | SQS | Kafka');
    await keyedCard.locator('.question-card-question').click();
    await openInbox(window);
    await item(window, other).getByTestId('inbox-ask').getByRole('button', { name: 'SQS', exact: true }).focus();
    await window.keyboard.press('1');
    await expect(item(window, other)).toHaveCount(0);
    // That answer's round trip is done, so neither `1` (with the pill focused, nor here) could have answered this one.
    expect((await window.evaluate(() => globalThis.window.agentBoard.agents.list())).find((known) => known.sessionId === keyed.sessionId)?.ask).not.toBeNull();
    await expect(keyedCard).toBeVisible();
    await window.keyboard.press('Escape');

    // Escape lets go of the card: its keys no longer answer it.
    await keyedCard.locator('.question-card-question').click();
    await window.keyboard.press('Escape');
    await expect.poll(() => window.evaluate(() => document.activeElement?.closest('.react-flow__node') ?? null)).toBeNull();

    // With the card itself focused, its key answers it.
    await keyedCard.locator('.question-card-question').click();
    await window.keyboard.press('2');
    await expect(keyedCard).toHaveCount(0);

    await agentTile(window, keyed).dispatchEvent('dblclick');
    await expect(screen(window)).toContainText('The user answered: us-east-1');
    await window.keyboard.press('Escape');
    await agentTile(window, agent).dispatchEvent('dblclick');
    await expect(screen(window)).toContainText('The user answered: CDN only');
  });
});

test('a plan opens in a Plan tab from the inbox, changes requested there come back as v2, and the approval reaches the agent', async () => {
  await withApp(async (window, app) => {
    const agent = await spawn(window, 'Plan: Cache product pages in Redis');

    await expect(agentTile(window, agent).getByTestId('tile-plan')).toHaveText('plan v1');
    await expect(agentTile(window, agent).getByText('plan to review')).toBeVisible();
    await expect.poll(() => notifications(app)).toContainEqual({ title: `${agent.name} has a plan to review`, body: 'Cache product pages in Redis · v1' });

    await openInbox(window);
    await expect(item(window, agent).getByTestId('inbox-plan')).toContainText('Cache product pages in Redis');
    await item(window, agent).getByRole('button', { name: `Show ${agent.name}'s plan` }).click();

    // Rendered as the PR tab renders Markdown: its raw HTML dropped, so its script neither runs nor shows.
    const body = planView(window).getByTestId('plan-body');
    await expect(body.getByRole('heading', { name: 'Steps' })).toBeVisible();
    await expect(body.locator('code', { hasText: 'getProduct()' })).toBeVisible();
    await expect(body).not.toContainText('document.title');
    await expect(planView(window).getByTestId('plan-version')).toHaveCount(1);

    const decision = planView(window).getByTestId('plan-decision');
    await expect(decision.getByRole('button', { name: `Request changes to plan v1 for ${agent.name}` })).toBeDisabled();
    await decision.getByLabel(`Comments on plan v1 for ${agent.name}`).fill('Also bust on the nightly stock import');
    await decision.getByRole('button', { name: `Request changes to plan v1 for ${agent.name}` }).click();

    // v2 comes back with the change in it, above v1, which is stamped with what was asked.
    await expect(planView(window).getByTestId('plan-version')).toHaveCount(2);
    await expect(body).toContainText('Also bust on the nightly stock import');
    await expect(planView(window).getByTestId('plan-version').first()).toContainText('To review');
    await planView(window).getByTestId('plan-version').last().click();
    await expect(planView(window).getByTestId('plan-decided')).toContainText('Changes requested');
    await expect(planView(window).getByTestId('plan-decided')).toContainText('Also bust on the nightly stock import');
    await expect(agentTile(window, agent).getByTestId('tile-plan')).toHaveText('plan v2');

    // Approved from the inbox this time.
    await openInbox(window);
    await item(window, agent).getByRole('button', { name: `Approve plan v2 for ${agent.name}` }).click();
    await expect(item(window, agent)).toHaveCount(0);
    await expect(planView(window).getByTestId('plan-version').first()).toContainText('Approved');
    await sessionWindow(window).getByRole('tab', { name: 'claude', exact: true }).click();
    await expect(screen(window)).toContainText('The user approved plan v2. Go ahead with it.');
  });
});

test('a plan shown on the board is a card beside its agent, decided from Review plan, and an edit in its Plan tab is approved as the user’s version', async () => {
  await withApp(async (window, app) => {
    const agent = await spawn(window, 'Plan doc on the board: docs/migration.md');

    const card = window.getByTestId('plan-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Zone id migration');
    await expect(card).toContainText('migration.md');
    await expect(card.getByTestId('plan-card-stamp')).toHaveText('waiting on you');
    await expect(card.getByTestId('plan-card-meta')).toHaveText('v1');
    const told = { title: `${agent.name} has a plan to review`, body: 'Zone id migration · v1' };
    await expect.poll(() => notifications(app)).toContainEqual(told);

    // Review plan opens the inbox's decision beside the card; the text is edited only in the Plan tab.
    await card.getByTestId('plan-card-review-button').click();
    const review = window.getByTestId('plan-card-review');
    await expect(review.getByRole('button', { name: `Approve plan v1 for ${agent.name}` })).toHaveText('Approve');
    await review.getByRole('button', { name: /Edit in the Plan tab/ }).click();
    await expect(planView(window)).toBeVisible();

    await planView(window).getByRole('button', { name: 'Edit' }).click();
    const source = planView(window).getByLabel('Markdown of Zone id migration');
    await expect(source).toBeFocused();
    const decision = planView(window).getByTestId('plan-decision');
    // Edit alone holds nothing; a change not yet saved holds every decision on the plan, the inbox's too.
    await expect(decision.getByRole('button', { name: `Approve plan v1 for ${agent.name}` })).toBeEnabled();
    await source.fill('# Zone id migration\n\n## Steps\n\n- Add zone_id, nullable\n- Backfill from the board file, with a down step\n- Make it NOT NULL\n');
    await expect(planView(window).getByTestId('plan-edit-hint')).toContainText('1 change');
    await expect(decision.getByRole('button', { name: `Approve plan v1 for ${agent.name}` })).toBeDisabled();
    await openInbox(window);
    await expect(item(window, agent).getByTestId('plan-held')).toBeVisible();
    await expect(item(window, agent).getByRole('button', { name: `Approve plan v1 for ${agent.name}` })).toBeDisabled();
    await source.press('ControlOrMeta+s');

    // Saved as v2, the user's, which Approve now approves with their edits.
    await expect(planView(window).getByTestId('plan-version')).toHaveCount(2);
    await expect(planView(window).getByTestId('plan-version').first()).toContainText('by you');
    // The tab lands on the version just saved.
    await expect(planView(window).getByTestId('plan-version').first()).toHaveAttribute('aria-current', 'true');
    await expect(item(window, agent).getByTestId('plan-held')).toHaveCount(0);
    await expect(planView(window).getByTestId('plan-version').last()).toContainText('Edited');
    await expect(decision.getByRole('button', { name: `Approve plan v2 for ${agent.name}` })).toHaveText('Approve with my edits');
    await expect(decision.getByTestId('plan-mine')).toContainText('Approving approves your version (v2)');
    // The user's own edit is no new plan to tell them of.
    expect((await notifications(app)).filter((each) => each.title === told.title)).toEqual([told]);

    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await expect(card.getByTestId('plan-card-meta')).toHaveText('v2 · by you');
    await card.getByTestId('plan-card-review-button').click();
    await review.getByRole('button', { name: `Approve plan v2 for ${agent.name}` }).click();
    await expect(card.getByTestId('plan-card-stamp')).toHaveText('✓ approved');
    await expect(card.getByTestId('plan-card-review-button')).toHaveCount(0);

    expect(readFileSync(join((await latest(window, agent)).worktree, 'docs/migration.md'), 'utf8')).toContain('- Backfill from the board file, with a down step');
    await card.dispatchEvent('dblclick');
    await sessionWindow(window).getByRole('tab', { name: 'claude', exact: true }).click();
    await expect(screen(window)).toContainText('The user approved plan v2, their edit of your v1.');
  });
});

test('an unsaved edit in a popped-out Plan tab holds the decision on the board’s plan card until it is cancelled', async () => {
  await withApp(async (window, app) => {
    const agent = await spawn(window, 'Plan doc on the board: docs/migration.md');
    const card = window.getByTestId('plan-card');
    await expect(card.getByTestId('plan-card-stamp')).toHaveText('waiting on you');
    await card.getByTestId('plan-card-review-button').click();
    await window.getByTestId('plan-card-review').getByRole('button', { name: /Edit in the Plan tab/ }).click();
    await expect(planView(window)).toBeVisible();

    // The Plan tab goes to a window of its own, and the draft is made there.
    const [popped] = await Promise.all([app.waitForEvent('window'), sessionWindow(window).getByRole('button', { name: 'Pop out session window' }).click()]);
    const tab = planView(popped);
    await tab.getByRole('button', { name: 'Edit' }).click();
    await tab.getByLabel('Markdown of Zone id migration').fill('# Zone id migration\n\n## Steps\n\n- Add zone_id\n');
    await expect(tab.getByTestId('plan-edit-hint')).toContainText('change');

    // The board's card, in another window, can't decide past it.
    await card.getByTestId('plan-card-review-button').click();
    const review = window.getByTestId('plan-card-review');
    await expect(review.getByTestId('plan-held')).toBeVisible();
    await expect(review.getByRole('button', { name: `Approve plan v1 for ${agent.name}` })).toBeDisabled();

    // Cancelled there, the card decides again.
    await tab.getByRole('button', { name: 'Cancel' }).click();
    await expect(review.getByTestId('plan-held')).toHaveCount(0);
    await expect(review.getByRole('button', { name: `Approve plan v1 for ${agent.name}` })).toBeEnabled();
  });
});

test('an HTML plan runs its script in a view of its own, and reaches neither the network, this machine, the app nor another page', async () => {
  const server = await serveWebPages();
  try {
    await withApp(async (window, app) => {
      await app.evaluate(({ shell }) => {
        const opened: string[] = [];
        (globalThis as { opened?: string[] }).opened = opened;
        shell.openExternal = async (url: string) => void opened.push(url);
      });
      const windowsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
      const agent = await spawn(window, `Plan HTML: ${server.url}`);

      await agentTile(window, agent).getByTestId('tile-plan').click();
      await expect(planView(window).getByTestId('plan-body')).toHaveAttribute('data-format', 'html');
      await expect(planView(window).getByTestId('plan-page')).toHaveAttribute('data-drawn', 'true');

      // The plan's page, as the main process has it (Playwright waits forever on a page whose navigation was stopped). Its
      // script ran, and found nothing to reach.
      const page = () =>
        app.evaluate(async ({ webContents }) => {
          const plan = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('agent-board-plan:'));
          return plan === undefined ? undefined : { url: plan.getURL(), title: plan.getTitle(), heading: await plan.executeJavaScript('document.getElementById("plan").textContent') };
        });
      await expect.poll(page).toEqual({ url: 'agent-board-plan:plan', title: 'fetch:blocked image:blocked app:none node:none', heading: 'The script ran' });

      // Its window.open, form post and navigation, tried after, went nowhere: the tab says so.
      await expect(planView(window).getByTestId('plan-problem')).toContainText("a plan's page stays on the plan");
      await window.waitForTimeout(500);
      expect((await page())?.url).toBe('agent-board-plan:plan');
      expect(server.hits()).toEqual([]);
      expect(await app.evaluate(() => (globalThis as { opened?: string[] }).opened)).toEqual([]);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windowsBefore);

      // Still waiting on the user: only their click decides it.
      await planView(window).getByRole('button', { name: `Reject plan v1 for ${agent.name}` }).click();
      await sessionWindow(window).getByRole('tab', { name: 'claude', exact: true }).click();
      await expect(screen(window)).toContainText("The user rejected plan v1. Don't carry it out.");
    });
  } finally {
    await server.close();
  }
});
