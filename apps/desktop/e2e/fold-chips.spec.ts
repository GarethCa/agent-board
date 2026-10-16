import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, closeAgent, launch, spawnAgent, tile, tileAction, TURN_MS, zoneNamed, zones } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';

const chip = (page: Page) => page.locator('[data-testid="agent-tile"][data-folded]');
const saved = (page: Page) => page.evaluate(async () => JSON.stringify(await window.agentBoard.view.get('unfoldedTiles')));
/** Where the flow edge's path ends, on the screen. */
const edgeEnds = (page: Page) =>
  page.getByTestId('flow-edge').first().evaluate((element) => {
    const svg = (element instanceof SVGPathElement ? element : element.querySelector('path')) as SVGPathElement;
    const [start, end] = [svg.getPointAtLength(0), svg.getPointAtLength(svg.getTotalLength())];
    const toScreen = (point: DOMPoint) => {
      const { x, y } = point.matrixTransform(svg.getScreenCTM()!);
      return { x, y };
    };
    return { start: toScreen(start), end: toScreen(end) };
  });

test('a closed agent folds to a chip that keeps its edge, unfolds on click, folds again from its tile menu, and undo follows', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Fix checkout flake');
    await spawnAgent(window, 'monorepo', 'Review checkout fix');
    for (const at of [0, 1]) await expect(tile(window).nth(at)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    const [fixer, reviewer] = await agents(window);
    const [zone] = await zones(window);
    await window.evaluate(
      async ({ zoneId, from, to }) => {
        const { agents, flowEdges } = globalThis.window.agentBoard;
        await agents.move(from, { zoneId, x: 40, y: 40 });
        await agents.move(to, { zoneId, x: 400, y: 40 });
        await flowEdges.create({ from, to, payload: 'handover', path: 'handover.md' });
      },
      { zoneId: zone!.id, from: fixer!.sessionId, to: reviewer!.sessionId },
    );
    await expect(window.getByTestId('flow-edge')).toHaveCount(1);
    await expect(chip(window)).toHaveCount(0);
    const open = await edgeEnds(window);

    // Closed, the implementer shrinks to a 34px chip where its tile was; the live reviewer stays full size.
    await closeAgent(window, fixer!.sessionId);
    await expect(chip(window)).toHaveCount(1);
    await expect(chip(window)).toHaveAttribute('data-session-id', fixer!.sessionId);
    const node = window.locator('.react-flow__node').filter({ has: window.locator(`[data-session-id="${fixer!.sessionId}"]`) });
    await expect.poll(() => node.evaluate((element) => (element as HTMLElement).offsetHeight)).toBe(34);
    await expect(chip(window)).toContainText('Fix checkout flake');
    await expect(chip(window).locator('.ui-pill')).toContainText('ended');
    await expect(tile(window).filter({ hasNot: window.locator('[data-folded]') })).toHaveCount(1);

    // The chip is centred in its tile's place, as CA3 draws it: its edge leaves from the same height as the tile's did.
    await expect
      .poll(async () => {
        const [now, box] = [await edgeEnds(window), await chip(window).boundingBox()];
        return Math.abs(now.start.y - (box!.y + box!.height / 2)) < 3 && Math.abs(now.start.y - open.start.y) < 3 && now.start.x < open.start.x;
      })
      .toBe(true);

    // A click unfolds it to its full tile, and the view state remembers it.
    await chip(window).click();
    await expect(chip(window)).toHaveCount(0);
    await expect(tile(window)).toHaveCount(2);
    await expect.poll(() => saved(window)).toBe(JSON.stringify([`agent:${fixer!.sessionId}`]));
    await expect.poll(() => node.evaluate((element) => (element as HTMLElement).offsetHeight)).toBeGreaterThan(100);

    // From its tile menu it folds back, and undo unfolds it again.
    await tileAction(window.locator(`[data-testid="agent-tile"][data-session-id="${fixer!.sessionId}"]`), 'Fold to a chip');
    await expect(chip(window)).toHaveCount(1);
    await expect.poll(() => saved(window)).toBe('[]');
    await window.keyboard.press('ControlOrMeta+z');
    await expect(chip(window)).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent that has only ended, its pane a live shell, keeps its tile and its Restart', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Fix checkout flake');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    const [agent] = await agents(window);
    await window.evaluate((id) => globalThis.window.agentBoard.agents.stop(id), agent!.sessionId);
    await expect(tile(window)).toHaveAttribute('data-state', 'done');
    await expect(tile(window).getByRole('button', { name: 'Restart' })).toBeAttached();
    await expect(chip(window)).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the chip menu has Unfold and Delete agent, and a restarted agent is a full tile again', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Fix checkout flake');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    const [agent] = await agents(window);
    await closeAgent(window, agent!.sessionId);
    await expect(chip(window)).toHaveCount(1);

    await chip(window).click({ button: 'right' });
    await expect(window.getByRole('menuitem', { name: 'Unfold' })).toBeVisible();
    await expect(window.getByRole('menuitem', { name: 'Delete agent' })).toBeVisible();
    await window.keyboard.press('Escape');

    // Restarted, it is running again, so no longer a chip.
    await window.evaluate((id) => globalThis.window.agentBoard.agents.restart(id, false), agent!.sessionId);
    await expect(chip(window)).toHaveCount(0);
    await expect(tile(window)).toHaveCount(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a chip stays exactly where it was through a zone delete and its undo, twice', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Fix checkout flake');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    const [agent] = await agents(window);
    await closeAgent(window, agent!.sessionId);
    await expect(chip(window)).toHaveCount(1);
    const saved = () => agents(window).then((all) => all[0]!.position);
    const before = await saved();
    const box = await chip(window).boundingBox();

    for (let round = 0; round < 2; round++) {
      await zoneNamed(window, 'monorepo').getByRole('button', { name: 'Zone options' }).click();
      await window.getByRole('menuitem', { name: 'Delete zone…' }).click();
      await window.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(zoneNamed(window, 'monorepo')).toHaveCount(0);
      await window.keyboard.press('Meta+Z');
      await expect(zoneNamed(window, 'monorepo')).toHaveCount(1);
      await expect.poll(saved).toMatchObject({ x: before!.x, y: before!.y });
      const now = await chip(window).boundingBox();
      expect(now!.y).toBeCloseTo(box!.y, 0);
      expect(now!.x).toBeCloseTo(box!.x, 0);
    }
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
