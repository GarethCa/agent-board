import { expect, type Page } from '@playwright/test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agents, launch, spawnAgent, tile, zones } from './agent-helpers.ts';
import { addEmptyZone, browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// Demo mode (AGENT_BOARD_DEMO=1, for recording the promo): off unless asked for, and then the board hides its dev
// chrome and gives a recording its camera and cursor through window.__demo.

/** The board's viewport, as React Flow transforms it. */
const viewport = (page: Page) =>
  page.locator('.react-flow__viewport').evaluate((element) => {
    const { a: zoom, e: x, f: y } = new DOMMatrix(getComputedStyle(element).transform);
    return { x, y, zoom };
  });

test('is off by default: no demo hooks in the window or the main process, and the dev chrome shows', async () => {
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, {});
  try {
    expect(await page.evaluate(() => 'demo' in document.documentElement.dataset)).toBe(false);
    expect(await page.evaluate(() => window.__demo)).toBeUndefined();
    expect(await app.evaluate(() => 'agentBoardDemo' in globalThis)).toBe(false);
    await expect(page.getByTestId('daemon-status')).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('with AGENT_BOARD_DEMO=1, hides the daemon status, moves the camera on cue and draws a cursor that ripples', async () => {
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, { AGENT_BOARD_DEMO: '1' });
  try {
    expect(await page.evaluate(() => 'demo' in document.documentElement.dataset)).toBe(true);
    expect(await app.evaluate(() => 'agentBoardDemo' in globalThis)).toBe(true);
    await expect(page.getByTestId('daemon-status')).toBeHidden();

    // Pushes in on a small part of the board, as far as the board zooms: further than the board's own moves go.
    await page.evaluate(() => window.__demo!.camera!({ x: 0, y: 0, width: 40, height: 40 }, 300));
    const pushedIn = await viewport(page);
    expect(pushedIn.zoom).toBeGreaterThan(1);

    // A move cut short by another still settles, so a spec awaiting it carries on.
    const cutShort = await page.evaluate(async () => {
      const first = window.__demo!.camera!({ x: 0, y: 0, width: 400, height: 400 }, 1_500);
      await window.__demo!.camera!({ x: 0, y: 0, width: 40, height: 40 }, 200);
      await first;
      return 'settled';
    });
    expect(cutShort).toBe('settled');

    // Frames a zone, and says when the move has finished.
    await addEmptyZone(page, 'Promo');
    const zone = await page.evaluate(async () => (await window.agentBoard.zones.list()).find((each) => each.name === 'Promo')!);
    await page.evaluate(() => window.__demo!.camera!({ x: -5000, y: -5000, width: 40, height: 40 }, 0));
    await page.evaluate((id) => window.__demo!.fit!(id, 300, 'linear'), zone.id);
    const framed = await viewport(page);
    const board = await page.locator('.react-flow').evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }));
    expect(framed.x + (zone.x + zone.width / 2) * framed.zoom).toBeCloseTo(board.width / 2, 0);
    expect(framed.y + (zone.y + zone.height / 2) * framed.zoom).toBeCloseTo(board.height / 2, 0);
    await expect(page.evaluate(() => window.__demo!.fit!('no-such-zone', 100))).rejects.toThrow('no zone no-such-zone on the board');

    // The cursor stays hidden until asked for, then follows the mouse and ripples where it presses.
    await expect(page.getByTestId('demo-cursor')).toHaveCount(0);
    await page.evaluate(() => window.__demo!.cursor!(true));
    await page.mouse.move(300, 200);
    await expect(page.locator('.demo-cursor')).toHaveCSS('translate', '300px 200px');
    await page.mouse.down();
    await expect(page.locator('.demo-cursor-ripple')).toHaveCount(1);
    await page.mouse.up();
    // The ripple goes once it has spread.
    await expect(page.locator('.demo-cursor-ripple')).toHaveCount(0);
    // Hidden mid-ripple and shown again, it replays no ripple from before.
    await page.mouse.down();
    await page.mouse.up();
    await page.evaluate(() => window.__demo!.cursor!(false));
    await expect(page.getByTestId('demo-cursor')).toHaveCount(0);
    // Counted at once, not waited for: a replayed ripple would be gone again once it had spread.
    expect(
      await page.evaluate(async () => {
        window.__demo!.cursor!(true);
        await new Promise(requestAnimationFrame);
        return document.querySelectorAll('.demo-cursor-ripple').length;
      }),
    ).toBe(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('with AGENT_BOARD_DEMO=1, a document grows on its way along a flow edge, so the hand-off reads in a video', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, { ...env, AGENT_BOARD_DEMO: '1' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(page);
    await spawnAgent(page, 'monorepo', 'Write the code');
    await spawnAgent(page, 'monorepo', 'Review the code');
    for (const name of ['Write the code', 'Review the code']) await expect(tile(page).filter({ hasText: name })).toHaveAttribute('data-state', 'waiting');
    const all = await agents(page);
    const [coder, reviewer] = ['Write the code', 'Review the code'].map((name) => all.find((agent) => agent.name === name)!.sessionId);
    const [zone] = await zones(page);
    writeFileSync(join(all.find((agent) => agent.sessionId === reviewer)!.worktree, 'review.md'), '# Review\n');
    await page.evaluate(
      async ({ zoneId, coder, reviewer }) => {
        await window.agentBoard.agents.move(coder!, { zoneId, x: 20, y: 40 });
        await window.agentBoard.agents.move(reviewer!, { zoneId, x: 620, y: 40 });
        await window.agentBoard.flowEdges.create({ from: reviewer!, to: coder!, trigger: 'manual', payload: 'handover', path: 'review.md' });
      },
      { zoneId: zone!.id, coder, reviewer },
    );

    const token = page.getByTestId('rail-token');
    await expect(token).toHaveAttribute('data-state', 'waiting');
    const growth = () => token.locator('.rail-token-body').evaluate((body) => getComputedStyle(body).animationName);
    expect(await growth()).toBe('none');
    await token.getByTestId('rail-token-send').click();
    await expect(token).toHaveAttribute('data-sliding', 'true');
    expect(await growth()).toBe('demo-handoff-grow');
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
