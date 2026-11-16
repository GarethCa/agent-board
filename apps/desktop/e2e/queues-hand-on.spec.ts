import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import type { Agent, BoardItem, QueueData, QueueView } from '@agent-board/daemon/protocol';
import { launch, spawnAgent, tile } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, runDesign, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// Part of a queue's life that reaches agents: the user hands a job to an idle agent (only what they write is typed),
// the user's own queue shows agents' Needs-you rows and goes through them one at a time, and a drain the user turns on
// starts an agent for a waiting job. The fake claude's `ask-plan` scenario plays the agents.

/** Runs `body` with the app open on a fresh repo zone whose agents run the fake claude's `ask-plan` scenario. */
async function withApp(body: (page: Page, zoneId: string) => Promise<void>): Promise<void> {
  const setup = scratch('ask-plan');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, setup.env);
  try {
    await pickFolderNext(app, setup.repo);
    await browseForZone(page);
    const [zone] = await page.evaluate(() => window.agentBoard.zones.list());
    await body(page, zone!.id);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(setup.dir, { recursive: true, force: true });
  }
}

/** Starts an agent in the zone with `prompt`, and returns it. */
async function spawn(page: Page, prompt: string, name: string): Promise<Agent> {
  const before = await page.evaluate(() => window.agentBoard.agents.list());
  await spawnAgent(page, 'monorepo', prompt, { name });
  const after = await page.evaluate(() => window.agentBoard.agents.list());
  return after.find((agent) => !before.some((known) => known.sessionId === agent.sessionId))!;
}

/** Puts a queue in the zone, for `audience`, holding `lines` as jobs. */
async function queueOf(page: Page, zoneId: string, title: string, audience: 'agents' | 'user', lines: string[], y = 360): Promise<BoardItem> {
  return page.evaluate(
    async ({ zoneId, title, audience, lines, y }) => {
      const data: QueueData = { title, madeBy: { kind: 'user' }, audience, noAgents: false, count: 0 };
      const item = await window.agentBoard.items.create({ kind: 'queue', zoneId, x: 600, y, width: 340, height: 244, data: { ...data } });
      for (const text of lines) await window.agentBoard.items.changeQueue(item.id, { action: 'add', text });
      return item;
    },
    { zoneId, title, audience, lines, y },
  );
}

const readQueue = (page: Page, id: string): Promise<QueueView> => page.evaluate((id) => window.agentBoard.items.readQueue(id), id);
const card = (page: Page, title: string) => page.getByTestId('queue-card').filter({ hasText: title });

test('a waiting job is handed to an idle agent with only the words the user sends, and rides on its tile as a ticket', async () => {
  await withApp(async (page, zoneId) => {
    const agent = await spawn(page, 'Read the README', 'impl-4');
    await expect.poll(async () => (await page.evaluate(() => window.agentBoard.agents.list())).find((each) => each.sessionId === agent.sessionId)?.state).toMatch(/idle|waiting/);
    const queue = await queueOf(page, zoneId, 'Backlog', 'agents', ['Fix the login', 'Write the docs']);

    await card(page, 'Backlog').getByRole('button', { name: 'Open ↗' }).click();
    const peek = page.getByTestId('queue-peek');
    await peek.locator('.listcard-peek-row').first().hover();
    await peek.getByRole('button', { name: 'Hand Fix the login to an agent' }).click();
    const dialog = page.getByTestId('hand-on');
    await expect(dialog).toBeVisible();
    const message = dialog.getByRole('textbox');
    await expect(message).toHaveValue(/^Fix the login\n\nThis is job #\w{8} from the queue “Backlog”, handed to you\./);
    await dialog.getByRole('radio', { name: /impl-4/ }).check();
    await message.fill('Fix the login, then tell me');
    await dialog.getByRole('button', { name: 'Send it' }).click();
    await expect(dialog).toBeHidden();

    await expect.poll(async () => (await readQueue(page, queue.id)).jobs[0]).toMatchObject({ text: 'Fix the login', state: 'taken', takenBy: { sessionId: agent.sessionId } });
    await expect(card(page, 'Backlog').locator('.listcard-row').first()).toContainText('impl-4');

    // A waiting row dragged onto an agent at work does nothing: a working agent takes no drop.
    await page.keyboard.press('Escape');
    const tileOf = (of: Agent) => tile(page).and(page.locator(`[data-session-id="${of.sessionId}"]`));
    const row = card(page, 'Backlog').locator('.listcard-row[data-draggable]').first();
    // As the board sees it, which may hear of the change after the daemon: the drop reads the board's agents.
    await expect(tileOf(agent)).not.toHaveAttribute('data-state', /^(idle|waiting)$/);
    await row.dragTo(tileOf(agent));
    await expect(dialog).toBeHidden();

    // A Classic tile drops its chips at rest, the ticket among them, and its hover card lists the job; the calm tile shows its ticket.
    const taker = tileOf(agent);
    if (runDesign() === 'simplified') await expect(taker.getByTestId('tile-ticket')).toContainText('Fix the login');
    else {
      await expect(taker.getByTestId('tile-ticket')).toHaveCount(0);
      await taker.hover();
      await expect(page.locator('.ui-hover-card')).toContainText('Its job from “Backlog”: Fix the login');
    }

    // Dragged onto an idle agent, Hand on opens with that agent chosen.
    const idle = await spawn(page, 'Read the CONTRIBUTING file', 'impl-5');
    await expect(tileOf(idle)).toHaveAttribute('data-state', /^(idle|waiting)$/);
    await row.dragTo(tileOf(idle));
    await expect(dialog).toContainText('Hand “Write the docs” to an agent');
    await expect(dialog.getByRole('radio', { name: /impl-5/ })).toBeChecked();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });
});

test("the user's queue shows an agent's question beside its items, and goes through them one at a time in its own tile while the board stays usable", async () => {
  await withApp(async (page, zoneId) => {
    const asker = await spawn(page, 'Ask: Keep the old cursor param? | Yes | No', 'impl-3');
    await expect.poll(async () => (await page.evaluate(() => window.agentBoard.agents.list())).find((each) => each.sessionId === asker.sessionId)?.ask?.question).toBe('Keep the old cursor param?');
    const queue = await queueOf(page, zoneId, 'To look at', 'user', ['Load-test findings -> docs/load.md']);

    const look = card(page, 'To look at');
    await expect(look.locator('.queue-needs-row')).toContainText('Keep the old cursor param?');
    await expect(look.locator('.listcard-row').nth(1)).toContainText('doc');
    await expect(look.locator('.listcard-count')).toHaveText('2');

    await look.getByTestId('queue-start').click();
    // The tile itself goes through them: nothing is drawn over the board.
    const going = page.getByTestId('queue-going');
    await expect(going).toHaveAttribute('data-kind', 'needs');
    await expect(going.getByTestId('queue-going-place')).toHaveText('1 of 2');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await going.locator('.listcard-title').click();
    await page.keyboard.press('ArrowRight');
    await expect(going).toContainText('Load-test findings');

    // Another tile stays clickable meanwhile, and the queue's keys are not its: D there takes nothing off.
    const askerTile = tile(page).and(page.locator(`[data-session-id="${asker.sessionId}"]`));
    await askerTile.click();
    await expect(page.locator('.react-flow__node.selected').getByTestId('agent-tile')).toHaveCount(1);
    await page.keyboard.press('d');
    await expect(going).toContainText('Load-test findings');
    expect((await readQueue(page, queue.id)).jobs[0]?.state).toBe('queued');

    // Selected again, D takes the item off and the tile shows what is left.
    await going.locator('.listcard-title').click();
    await page.keyboard.press('d');
    await expect.poll(async () => (await readQueue(page, queue.id)).jobs[0]?.state).toBe('done');
    await expect(going.getByTestId('queue-going-place')).toHaveText('1 of 1');
    await going.getByTestId('queue-going-back').click();
    await expect(going).toBeHidden();
    await expect(look.locator('.queue-needs-row')).toBeVisible();

    // Started from the peek after another tile was clicked, the keys are the queue's at once: no click on the tile first.
    await page.evaluate((id) => window.agentBoard.items.changeQueue(id, { action: 'add', text: 'Read the release notes' }), queue.id);
    await expect(look.locator('.listcard-count')).toHaveText('2');
    await askerTile.click();
    await look.getByRole('button', { name: 'Open ↗' }).click();
    await page.getByTestId('queue-peek-start').click();
    await expect(going.getByTestId('queue-going-place')).toHaveText('1 of 2');
    await page.keyboard.press('ArrowRight');
    await expect(going.getByTestId('queue-going-place')).toHaveText('2 of 2');
    await expect(going).toContainText('Read the release notes');
  });
});

test('a drain the user turns on starts a fresh agent for the waiting job, taken for it', async () => {
  await withApp(async (page, zoneId) => {
    const queue = await queueOf(page, zoneId, 'web jobs', 'agents', ['Empty-cart state']);
    const jobs = card(page, 'web jobs');
    await expect(jobs).toContainText('No one is taking these');
    await jobs.getByTestId('queue-drain').click();
    const sheet = page.getByRole('dialog', { name: 'Start agents for “web jobs”' });
    await sheet.getByRole('button', { name: '1', exact: true }).click();
    await sheet.getByRole('button', { name: 'Start agents' }).click();
    await expect(sheet).toBeHidden();

    await expect.poll(async () => (await page.evaluate(() => window.agentBoard.agents.list())).some((agent) => agent.name === 'Empty-cart state'), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await readQueue(page, queue.id)).jobs[0]?.state).toBe('taken');
    await expect(jobs).toContainText('Agents start for its jobs · at most 1');
  });
});
