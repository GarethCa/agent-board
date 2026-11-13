import { expect, type Page } from '@playwright/test';
import { closeAgent, launch, listFinishedTurns, openSubmenu, tile, tileGroup, windowKey } from './agent-helpers.ts';
import { demoReady, scenarioPicker, seedBoard, stillBoard } from './demo-board.ts';
import { removeDataDir, tempDataDir, test } from './launch.ts';
import { RENDER_ARGS, RENDER_ENV, settle, VIEWPORT } from './render.ts';
import { scratch } from './scratch.ts';

const stacks = (page: Page) => page.getByTestId('shelf-stack');
const stack = (page: Page, title: string) => stacks(page).filter({ hasText: title });
const named = (page: Page, name: string) => tile(page).filter({ has: page.getByText(name, { exact: true }) });
/** Every agent's saved place, which the shelves never write. */
const places = (page: Page) => page.evaluate(async () => (await window.agentBoard.agents.list()).map((agent) => [agent.name, agent.position?.x, agent.position?.y]).sort());

test('a zone on status shelves: a stack per unit of work on its shelf, the lead pinned top-left, a stack fanned out over the board, and back to free as it was', async () => {
  const { dir, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, { ...env, ...RENDER_ENV, PATH: `${scenarioPicker(dir)}:${env.PATH}`, SHELL: '/bin/sh' }, RENDER_ARGS);
  try {
    await listFinishedTurns(page);
    await page.setViewportSize(VIEWPORT);
    await seedBoard(page, dir);
    await demoReady(page);
    const web = (await page.evaluate(() => window.agentBoard.zones.list())).find((zone) => zone.name === 'web-app')!;
    // A lead in the zone, with the orchestrator role: pinned in the head row once the zone is shelved.
    await page.evaluate(async (zoneId) => {
      const result = await window.agentBoard.agents.spawn({ zoneId, prompt: 'Lead the web crew', role: 'orchestrator', position: { x: 30, y: 420 }, cols: 100, rows: 30 });
      if (result.status !== 'started') throw new Error(result.message);
    }, web.id);
    await expect(named(page, 'Lead the web crew')).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
    await closeAgent(page, (await page.evaluate(() => window.agentBoard.agents.list())).find((agent) => agent.name === 'Fix checkout flake')!.sessionId);
    const saved = await places(page);

    await page.evaluate((id) => window.agentBoard.zones.configure(id, { layoutMode: 'shelves' }), web.id);
    await expect(page.getByTestId('shelves')).toHaveCount(1);
    // Pick a cache and Clear build output need you and Resize images works, on Doing; Fix checkout flake, closed, is in Done's line.
    await expect(stacks(page)).toHaveCount(3);
    await expect(page.getByTestId('shelf-done')).toHaveText(/1 done\s*Show/);
    for (const title of ['Pick a cache', 'Clear build output']) await expect(stack(page, title)).toHaveAttribute('data-needs-you', 'true');
    await expect(stack(page, 'Resize images')).toHaveAttribute('data-stage', 'doing');
    // The agents are folded into their cards; the lead stays, at the zone's top-left.
    for (const name of ['Pick a cache', 'Clear build output', 'Resize images']) await expect(named(page, name)).toBeHidden();
    const lead = named(page, 'Lead the web crew');
    await expect(lead).toBeVisible();
    const zoneBox = (await page.getByTestId('zone').filter({ hasText: 'web-app' }).boundingBox())!;
    const leadBox = (await lead.boundingBox())!;
    expect(leadBox.x - zoneBox.x).toBeLessThan(60);
    expect(leadBox.y - zoneBox.y).toBeLessThan(80);

    await page.getByRole('button', { name: 'Fit View' }).click();
    await settle(page);
    await stillBoard(page);
    await page.screenshot({ path: test.info().outputPath('shelves.png') });

    // A click fans the stack's tile out under its card, moving nothing; Esc folds it back.
    await stack(page, 'Pick a cache').click();
    await expect(stack(page, 'Pick a cache')).toHaveAttribute('aria-expanded', 'true');
    await expect(named(page, 'Pick a cache')).toBeVisible();
    const card = (await stack(page, 'Pick a cache').boundingBox())!;
    const fanned = (await named(page, 'Pick a cache').boundingBox())!;
    expect(fanned.y).toBeGreaterThan(card.y + card.height - 2);
    await settle(page);
    await page.screenshot({ path: test.info().outputPath('shelves-fanned.png') });
    await page.keyboard.press('Escape');
    await expect(named(page, 'Pick a cache')).toBeHidden();

    // Found with ⌘K, an agent folded into a stack is shown fanned out, not at its hidden tile's place.
    await page.keyboard.press(windowKey('k'));
    await page.getByTestId('spotlight').getByRole('combobox').fill('Clear build output');
    await page.keyboard.press('Enter');
    await expect(stack(page, 'Clear build output')).toHaveAttribute('aria-expanded', 'true');
    await expect(named(page, 'Clear build output')).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(named(page, 'Clear build output')).toBeHidden();

    // Done shows its chips on Show.
    await page.getByTestId('shelf-done').click();
    await expect(stack(page, 'Fix checkout flake')).toHaveAttribute('data-stage', 'done');
    await settle(page);
    await page.screenshot({ path: test.info().outputPath('shelves-done-shown.png') });

    // Freed from the head row, the lead is a stack like any other.
    // By its bottom-right corner, clear of the board menu's island over the top-left of the view.
    const leadSize = (await lead.boundingBox())!;
    await lead.click({ button: 'right', position: { x: leadSize.width - 24, y: leadSize.height - 12 } });
    await openSubmenu(page, tileGroup('Arrange'));
    // A lone tile has nothing to line up with: its Align is greyed, and says why.
    await expect(page.getByRole('menuitem', { name: /^Align/ })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('menuitem', { name: /^Align/ })).toContainText('Select two or more to line them up');
    await page.getByRole('menuitem', { name: /Free from top-left/ }).click();
    await expect(lead).toBeHidden();
    await expect(stack(page, 'Lead the web crew')).toHaveCount(1);

    // Nothing was saved anywhere else: back to free, every tile is where it was.
    expect(await places(page)).toEqual(saved);
    await page.evaluate((id) => window.agentBoard.zones.configure(id, { layoutMode: 'free' }), web.id);
    await expect(page.getByTestId('shelves')).toHaveCount(0);
    for (const name of ['Pick a cache', 'Clear build output', 'Resize images', 'Lead the web crew']) await expect(named(page, name)).toBeVisible();
    expect(await places(page)).toEqual(saved);
  } finally {
    await app.close();
    removeDataDir(dataDir);
  }
});

test('a zone in clusters: each unit of work its tiles together, what needs you first, the lead pinned top-left, and back to free as it was', async () => {
  const { dir, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, { ...env, ...RENDER_ENV, PATH: `${scenarioPicker(dir)}:${env.PATH}`, SHELL: '/bin/sh' }, RENDER_ARGS);
  try {
    await listFinishedTurns(page);
    await page.setViewportSize(VIEWPORT);
    await seedBoard(page, dir);
    await demoReady(page);
    const web = (await page.evaluate(() => window.agentBoard.zones.list())).find((zone) => zone.name === 'web-app')!;
    await page.evaluate(async (zoneId) => {
      const result = await window.agentBoard.agents.spawn({ zoneId, prompt: 'Lead the web crew', role: 'orchestrator', position: { x: 30, y: 420 }, cols: 100, rows: 30 });
      if (result.status !== 'started') throw new Error(result.message);
    }, web.id);
    await expect(named(page, 'Lead the web crew')).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
    await closeAgent(page, (await page.evaluate(() => window.agentBoard.agents.list())).find((agent) => agent.name === 'Fix checkout flake')!.sessionId);
    const saved = await places(page);

    await page.evaluate((id) => window.agentBoard.zones.configure(id, { layoutMode: 'clusters' }), web.id);
    const clusters = page.getByTestId('zone-cluster');
    await expect(clusters).toHaveCount(3);
    // What needs you first, nearest the top-left, outlined as needing you; the live tiles stay themselves.
    await expect(clusters.first()).toHaveAttribute('data-needs-you', 'true');
    for (const name of ['Pick a cache', 'Clear build output', 'Resize images', 'Lead the web crew']) await expect(named(page, name)).toBeVisible();
    // The lead says it is pinned, as on shelves.
    await expect(page.getByTestId('shelf-pin')).toHaveCount(1);
    // Closed, Fix checkout flake is behind Done's line until shown.
    await expect(page.getByTestId('shelf-done')).toHaveText(/1 done\s*Show/);
    await page.getByRole('button', { name: 'Fit View' }).click();
    await settle(page);
    await stillBoard(page);
    await page.screenshot({ path: test.info().outputPath('clusters.png') });
    await page.getByTestId('shelf-done').click();
    await expect(clusters).toHaveCount(4);

    // No cluster overlaps another.
    const boxes = await clusters.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON() as DOMRect));
    for (const [at, a] of boxes.entries()) {
      for (const b of boxes.slice(at + 1)) expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
    }

    // Two clustered tiles selected: Align is off, for it would save where clusters draw them as their own places.
    // Each by a click on its body, as a tile is selected.
    const body = async (name: string) => {
      const box = (await named(page, name).boundingBox())!;
      return { x: box.width - 12, y: box.height / 2 };
    };
    await named(page, 'Pick a cache').click({ position: await body('Pick a cache') });
    await named(page, 'Resize images').click({ position: await body('Resize images'), modifiers: ['Shift'] });
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
    await named(page, 'Resize images').click({ position: await body('Resize images'), button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Align' })).toBeDisabled();
    await page.keyboard.press('Escape');

    expect(await places(page)).toEqual(saved);
    await page.evaluate((id) => window.agentBoard.zones.configure(id, { layoutMode: 'free' }), web.id);
    await expect(clusters).toHaveCount(0);
    expect(await places(page)).toEqual(saved);
  } finally {
    await app.close();
    removeDataDir(dataDir);
  }
});
