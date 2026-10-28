import { expect, type Page } from '@playwright/test';
import { fakeBinDir } from '@agent-board/fake-harness';
import { createFakeGitHub, createTempKeychain, FAKE_GITHUB_STATE, type FakeGitHubPullRequest } from '@agent-board/tracker/testing';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { agents, launch, listFinishedTurns, screen, sessionWindow, setClickOpens, tile, tileAction } from './agent-helpers.ts';
import { demoReady, makeRepo, pinPaths, pinRandomLooks, scenarioPicker, seedBoard, stillBoard } from './demo-board.ts';
import { openAddZone, removeDataDir, tempDataDir, test } from './launch.ts';
import { ignorePointer, RENDER_ARGS, RENDER_ENV, settle, VIEWPORT } from './render.ts';
import { scratch } from './scratch.ts';

// The README's screenshots, made by `pnpm readme:screenshots`. The app runs on the fake claude with a seeded demo
// board, drawn the way the visual spec draws it (./render.ts: software rendering, one device pixel per CSS pixel, motion
// off, a fixed locale and time zone). Unlike the visual spec the fonts are the app's own, so the shots show its real look.
// Light theme, but for one shot of the board in the dark one. Each PNG is recompressed to a small palette before it is written to docs/assets/screenshots/.
test.use({ viewport: null });

const OUT = join(import.meta.dirname, '..', '..', '..', 'docs', 'assets', 'screenshots');

/** Writes `png` to `docs/assets/screenshots/<name>.png`, quantised: UI flat colours take a fraction of the bytes. */
async function write(name: string, png: Buffer): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await sharp(png).png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 }).toFile(join(OUT, `${name}.png`));
}


/** Shoots the whole window once the page is still. Taken through the DevTools protocol, scaled to two device pixels per CSS pixel for retina screens: Playwright's own screenshot of an Electron window is at one. */
async function shoot(page: Page, name: string): Promise<void> {
  const restorePointer = await ignorePointer(page);
  await settle(page);
  await stillBoard(page);
  const session = await page.context().newCDPSession(page);
  const { data } = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, ...VIEWPORT, scale: 2 } });
  await session.detach();
  await write(name, Buffer.from(data, 'base64'));
  await restorePointer();
}

/** Like `shoot`, for a window with a web tab: that page is a view of its own over the window, so it is shot on its own and laid over the window's shot at the tab's area. */
async function shootWithPage(page: Page, webPage: Page, area: { x: number; y: number; width: number; height: number }, name: string, pin: () => Promise<void>): Promise<void> {
  const restorePointer = await ignorePointer(page);
  await settle(page);
  await stillBoard(page);
  await pin();
  const shotOf = async (target: Page, clip: { x: number; y: number; width: number; height: number }) => {
    const session = await target.context().newCDPSession(target);
    const { data } = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { ...clip, scale: 2 } });
    await session.detach();
    return Buffer.from(data, 'base64');
  };
  const board = await shotOf(page, { x: 0, y: 0, ...VIEWPORT });
  const inner = await webPage.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const content = await shotOf(webPage, { x: 0, y: 0, width: Math.min(inner.width, Math.round(area.width)), height: Math.min(inner.height, Math.round(area.height)) });
  const composed = await sharp(board).composite([{ input: content, left: Math.round(area.x * 2), top: Math.round(area.y * 2) }]).png().toBuffer();
  await write(name, composed);
  await restorePointer();
}


test('the README screenshots: the board, an expanded tile, the session window, the inbox and Add zone', async () => {
  const { dir, env } = scratch('output');
  const github = createFakeGitHub({
    ...FAKE_GITHUB_STATE,
    repos: [
      { nameWithOwner: 'acme/storefront', description: 'The web storefront' },
      { nameWithOwner: 'acme/billing-api', description: 'Invoices and payments' },
      { nameWithOwner: 'acme/design-system', description: 'Shared components' },
    ],
  });
  const dataDir = tempDataDir();
  const { app, window } = await launch(
    dataDir,
    { ...env, ...RENDER_ENV, PATH: `${scenarioPicker(dir)}:${env.PATH}`, AGENT_BOARD_GH: github.gh, SHELL: '/bin/sh' },
    RENDER_ARGS,
  );
  await listFinishedTurns(window);
  try {
    await window.setViewportSize(VIEWPORT);
    await seedBoard(window, dir);
    await expect(tile(window)).toHaveCount(6);
    await demoReady(window);
    // Fit View frames the nodes as they are: let them stop growing, shrinking and moving first.
    await stillBoard(window);
    await window.getByRole('button', { name: 'Fit View' }).click();
    await pinRandomLooks(window);
    await pinPaths(window);
    await shoot(window, 'board');

    await window.getByTestId('inbox-count').click();
    await expect(window.getByTestId('needs-you-inbox')).toBeVisible();
    const prompts = window.getByTestId('inbox-prompt');
    await expect(prompts).toHaveCount(2);
    await expect(prompts.filter({ hasText: 'rm -rf dist' })).toHaveCount(1);
    await expect(prompts.filter({ hasText: 'Its general-purpose subagent wants to use Bash' }).filter({ hasText: 'rm -rf build' })).toHaveCount(1);
    await pinRandomLooks(window);
    await shoot(window, 'inbox');
    await window.keyboard.press('Escape');

    const popover = await openAddZone(window, 'GitHub');
    await expect(popover.getByRole('option').first()).toBeVisible();
    await pinRandomLooks(window);
    await pinPaths(window);
    await shoot(window, 'add-zone');
    await window.keyboard.press('Escape');

    // A double-click opens the session window; Expand in place is the setting that opens the tile where it sits instead.
    const waiting = tile(window).filter({ has: window.getByText('Pick a cache', { exact: true }) });
    await waiting.dblclick();
    await expect(sessionWindow(window)).toBeVisible();
    await expect(screen(window)).toContainText('Which database should I use');
    await pinRandomLooks(window);
    await shoot(window, 'session-window');
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();

    await setClickOpens(window, 'Expand in place');
    await waiting.dblclick();
    await expect(window.getByTestId('expanded-tile')).toBeVisible();
    await expect(screen(window)).toContainText('Which database should I use');
    await pinRandomLooks(window);
    await shoot(window, 'expanded-tile');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    github.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the README screenshots: the board in the dark theme', async () => {
  const { dir, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(
    dataDir,
    { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: 'dark', PATH: `${scenarioPicker(dir)}:${env.PATH}`, SHELL: '/bin/sh' },
    RENDER_ARGS,
  );
  await listFinishedTurns(window);
  try {
    await window.setViewportSize(VIEWPORT);
    // Playwright pins the page to light; the setting has the window in dark mode, as macOS would.
    await window.emulateMedia({ colorScheme: 'dark' });
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark');
    await seedBoard(window, dir);
    await expect(tile(window)).toHaveCount(6);
    await demoReady(window);
    // Fit View frames the nodes as they are: let them stop growing, shrinking and moving first.
    await stillBoard(window);
    await window.getByRole('button', { name: 'Fit View' }).click();
    await pinRandomLooks(window);
    await pinPaths(window);
    await shoot(window, 'board-dark');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the README screenshots: flows, the review doc and the chat view', async () => {
  const { dir, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, { ...env, ...RENDER_ENV, PATH: `${scenarioPicker(dir)}:${env.PATH}`, SHELL: '/bin/sh' }, RENDER_ARGS);
  await listFinishedTurns(page);
  try {
    await page.setViewportSize(VIEWPORT);
    const zone = await page.evaluate(async (path) => {
      const result = await window.agentBoard.zones.addFolder(path, { x: 0, y: 0, width: 1260, height: 330, color: '#4c6ef5' });
      if (result.status !== 'added') throw new Error(result.message);
      return result.zone;
    }, makeRepo(dir, 'storefront'));
    const spawn = (prompt: string, x: number, y: number) =>
      page.evaluate(
        async (params) => {
          const result = await window.agentBoard.agents.spawn(params);
          if (result.status !== 'started') throw new Error(result.message);
          return result.agent;
        },
        { zoneId: zone.id, prompt, position: { x, y }, cols: 100, rows: 30 },
      );
    // A gap between the tiles (~275 for the plan edge, whose pill and Send button are wide, ~185 for the other) leaves a visible line and arrowhead each side of each label; the reviewer sits below.
    const planner = await spawn('Plan the checkout', 20, 50);
    const coder = await spawn('Write the code', 550, 50);
    const shipper = await spawn('Ship the release', 990, 50);
    for (const name of ['Plan the checkout', 'Write the code', 'Ship the release']) {
      await expect(tile(page).filter({ hasText: name })).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
    }

    // The planner's plan waits for a Send to reach the coder; the coder hands its handover on once the pull request's checks pass.
    writeFileSync(join(planner.worktree, 'plan.md'), '# Plan\n\n1. Validate the cart.\n2. Charge the card.\n');
    writeFileSync(join(coder.worktree, 'handover.md'), '# Handover\n\nThe checkout validates the cart and charges the card.\n');
    await page.evaluate(
      async ({ a, b, c }) => {
        await window.agentBoard.flowEdges.create({ from: a, to: b, payload: 'handover', path: 'plan.md', trigger: 'manual' });
        await window.agentBoard.flowEdges.create({ from: b, to: c, payload: 'handover', path: 'handover.md', conditions: [{ kind: 'pr-checks' }] });
      },
      { a: planner.sessionId, b: coder.sessionId, c: shipper.sessionId },
    );
    await expect(page.getByTestId('flow-edge')).toHaveCount(2);

    // The coder finishes a turn, and its hand-off is held: the pull request's checks can't pass with no pull request.
    await page.evaluate((id) => window.agentBoard.agents.answer(id, 'Now open the pull request'), coder.sessionId);
    await expect(page.getByTestId('rail-token-note').filter({ hasText: 'held' })).toHaveText('held until CI green', { timeout: 30_000 });

    // A reviewer: its tile is dashed, and it ends once its review doc is in.
    const coderTile = page.locator(`[data-testid="agent-tile"][data-session-id="${coder.sessionId}"]`);
    await tileAction(coderTile, 'Review its work');
    const reviewer = page.locator('[data-testid="agent-tile"][data-reviewer]');
    await expect(reviewer).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
    await expect.poll(async () => (await page.evaluate(() => window.agentBoard.reviews.list()))[0]?.status).toBe('ready');
    await expect(tile(page)).toHaveCount(4);
    // The reviewer lands beside its implementer: move it clear of both edges.
    await page.evaluate(
      async ([id, zoneId]) => window.agentBoard.agents.move(id as string, { zoneId: zoneId as string, x: 20, y: 320 }),
      [await reviewer.getAttribute('data-session-id'), zone.id],
    );

    // Fit View frames the nodes as they are: let them stop growing, shrinking and moving first.
    await stillBoard(page);
    await page.getByRole('button', { name: 'Fit View' }).click();
    await stillBoard(page);
    const rules = page.getByRole('complementary', { name: 'Edge rules' });
    await page.getByTestId('rail-token').filter({ hasText: 'handover.md' }).locator('.rail-token-open').click();
    await expect(rules).toBeVisible();
    await expect(rules).toContainText('Write the code');
    await expect(rules).toContainText('no pull request yet');
    await expect(rules.getByTestId('edge-rules-preview')).toContainText('The checkout validates the cart');
    // The panel slides in: zoom steps are taken about the pane's centre, so let it come to rest first.
    let panel = '';
    let panelStill = 0;
    await expect
      .poll(async () => {
        const now = JSON.stringify(await rules.boundingBox());
        panelStill = now === panel ? panelStill + 1 : 0;
        panel = now;
        return panelStill;
      }, { intervals: [100] })
      .toBeGreaterThanOrEqual(5);
    await stillBoard(page);
    // Zoom out two steps and pan the board into the space left of the panel, so the panel covers no tile or edge.
    // Each step settles before the next.
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await stillBoard(page);
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await stillBoard(page);
    await page.keyboard.press('h');
    const box = await page.getByTestId('zone').boundingBox();
    if (!box) throw new Error('the zone has no box');
    await page.mouse.move(600, 150);
    await page.mouse.down();
    await page.mouse.move(600 + 20 - box.x, 150, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.press('v');
    await stillBoard(page);
    await pinRandomLooks(page);
    await pinPaths(page);
    await shoot(page, 'flow-edges');
    await rules.getByRole('button', { name: 'Close edge rules' }).click();

    // The review doc is a tab of the implementer's window.
    await coderTile.getByTestId('tile-review').click();
    const win = sessionWindow(page);
    await expect(win.getByRole('tab', { name: 'Review · round 1' })).toHaveAttribute('aria-selected', 'true');
    await expect(win.getByTestId('review-verdict')).toContainText('Changes requested');
    await pinRandomLooks(page);
    await pinPaths(page);
    await shoot(page, 'review-doc');
    await win.getByRole('button', { name: 'Close session window' }).click();

    // The chat view reads the agent's transcript.
    await coderTile.dblclick();
    await expect(win).toBeVisible();
    await win.getByRole('tab', { name: 'Terminal' }).click();
    await win.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
    const chat = win.getByTestId('chat-view');
    await expect(chat.getByTestId('chat-assistant').last()).toContainText('Done: Now open the pull request');
    // Its tool calls fold into one row: opened, to show a call.
    await win.getByRole('button', { name: 'Expand all' }).click();
    await expect(chat.getByTestId('chat-tool')).toHaveCount(1);
    await pinRandomLooks(page);
    await shoot(page, 'chat-view');
    expect((await agents(page)).length).toBe(4);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the README screenshots: an orchestrator with its crew frame', async () => {
  const { dir, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, { ...env, ...RENDER_ENV, PATH: `${scenarioPicker(dir)}:${env.PATH}`, SHELL: '/bin/sh' }, RENDER_ARGS);
  await listFinishedTurns(page);
  try {
    await page.setViewportSize(VIEWPORT);
    const zone = await page.evaluate(async (path) => {
      const result = await window.agentBoard.zones.addFolder(path, { x: 0, y: 0, width: 1180, height: 460, color: '#4c6ef5' });
      if (result.status !== 'added') throw new Error(result.message);
      return result.zone;
    }, makeRepo(dir, 'storefront'));
    const spawn = (prompt: string, x: number, y: number) =>
      page.evaluate(
        async (params) => {
          const result = await window.agentBoard.agents.spawn(params);
          if (result.status !== 'started') throw new Error(result.message);
          return result.agent;
        },
        { zoneId: zone.id, prompt, position: { x, y }, cols: 100, rows: 30 },
      );

    // The orchestrator starts two workers through the board's MCP tool and CLI: each takes a turn's worth of time to start.
    const lead = await spawn('Lead two: Fix checkout flake', 40, 80);
    await expect(tile(page)).toHaveCount(3, { timeout: 60_000 });
    const frame = page.getByTestId('crew-frame');
    await expect(frame).toHaveCount(1);
    await expect(frame).toContainText(/'s crew$/);
    await expect(page.locator('[data-testid="agent-tile"][data-orchestrator]').getByTestId('crew-count')).toHaveText('2');
    await expect(tile(page).filter({ has: page.getByTitle('worker one', { exact: true }) })).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
    await expect(tile(page).filter({ has: page.getByTitle('worker two', { exact: true }) })).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
    // The workers land beside the orchestrator: move them out so the crew frame has clear space around its tiles.
    const crew = (await agents(page)).filter((agent) => agent.sessionId !== lead.sessionId);
    for (const [index, worker] of crew.entries()) {
      await page.evaluate(([id, zoneId, x]) => window.agentBoard.agents.move(id as string, { zoneId: zoneId as string, x: x as number, y: 80 }), [worker.sessionId, zone.id, 480 + index * 330]);
    }
    // Fit View frames the nodes as they are: let them stop growing, shrinking and moving first.
    await stillBoard(page);
    await page.getByRole('button', { name: 'Fit View' }).click();
    await pinRandomLooks(page);
    await pinPaths(page);
    await shoot(page, 'orchestrator-crew');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the README screenshots: a board in use, with a question, a document, a clock, a paused agent and the View popover', async () => {
  const { dir, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, { ...env, ...RENDER_ENV, PATH: `${scenarioPicker(dir)}:${env.PATH}`, SHELL: '/bin/sh' }, RENDER_ARGS);
  await listFinishedTurns(page);
  try {
    await page.setViewportSize(VIEWPORT);
    const zone = await page.evaluate(async (path) => {
      const result = await window.agentBoard.zones.addFolder(path, { x: 0, y: 0, width: 1700, height: 700, color: '#4c6ef5' });
      if (result.status !== 'added') throw new Error(result.message);
      return result.zone;
    }, makeRepo(dir, 'storefront'));
    // Each agent is named for its work; the fake claude is steered by its name, which becomes its worktree folder (`scenarioPicker`); the prompts only feed the task lines the tiles show until the shot pins them.
    const spawn = (name: string, prompt: string, x: number, y: number) =>
      page.evaluate(
        async (params) => {
          const result = await window.agentBoard.agents.spawn(params);
          if (result.status !== 'started') throw new Error(result.message);
          return result.agent;
        },
        { zoneId: zone.id, name, prompt, position: { x, y }, cols: 100, rows: 30 },
      );
    const asking = await spawn('Pick a cache', 'Ask on the board: Which cache should the product pages use? | Redis | In-memory LRU | CDN only', 400, 40);
    const writing = await spawn('Write the release plan', 'Doc on the board: docs/release-plan.md', 1000, 40);
    const limited = await spawn('Migrate the orders table', 'Hit the rate limit', 40, 330);
    const scheduled = await spawn('Check the build', 'Check the build', 760, 330);
    const resting = await spawn('Tidy the changelog', 'Tidy the changelog', 1200, 330);
    const taskLines: Record<string, string> = {
      'Ask on the board: Which cache should the product pages use? | Redis | In-memory LRU | CDN only': 'Decide the cache for the product pages',
      'Doc on the board: docs/release-plan.md': 'Write docs/release-plan.md',
      'Hit the rate limit': 'Add the orders migration',
    };

    const card = page.getByTestId('question-card');
    await expect(card).toContainText('Which cache should the product pages use?', { timeout: 60_000 });
    await expect(page.getByTestId('doc-card')).toContainText('Release 1.4 plan', { timeout: 60_000 });
    await expect(tile(page).filter({ has: page.getByText('Migrate the orders table', { exact: true }) })).toHaveAttribute('data-state', 'rate-limited', { timeout: 60_000 });
    await expect(page.getByTestId('continue-on-credits')).toBeVisible();
    for (const name of ['Check the build', 'Tidy the changelog']) {
      await expect(tile(page).filter({ hasText: name })).toHaveAttribute('data-state', 'idle', { timeout: 60_000 });
    }
    await page.evaluate(
      async ({ scheduledId, restingId, limitedId, askingId }) => {
        const board = window.agentBoard;
        await board.agents.setSchedule(scheduledId, { cron: '30 6 * * *', prompt: 'Check last night’s build' });
        await board.agents.pause(restingId);
        await board.connectors.create({ from: { type: 'agent', id: limitedId, side: 'top' }, to: { type: 'agent', id: askingId, side: 'left' }, style: 'elbow' });
      },
      { scheduledId: scheduled.sessionId, restingId: resting.sessionId, limitedId: limited.sessionId, askingId: asking.sessionId },
    );
    await page.evaluate(
      async ({ zoneId, sessionId, name }) => {
        const board = window.agentBoard;
        await board.items.create({
          kind: 'agent-note',
          zoneId,
          x: 760,
          y: 520,
          width: 240,
          height: 150,
          data: {
            text: '**Round 2 of 3**\n\n- implementer: fixes in\n- reviewer: idle',
            agent: { sessionId, name, harness: 'claude', role: 'orchestrator' },
            about: sessionId,
            writtenAt: '2026-10-01T09:41:00Z',
            editedByUser: false,
          },
        });
        await board.items.create({
          kind: 'shape',
          zoneId,
          x: 40,
          y: 540,
          width: 300,
          height: 60,
          data: { shape: 'rounded', fill: '#d0ebff', stroke: '#3b5bdb', strokeWidth: 2.5, dashed: false, text: 'Release 1.4: ship on Friday', textSize: 'body', bold: true, textColor: '#2b2a27' },
        });
      },
      { zoneId: zone.id, sessionId: writing.sessionId, name: writing.name },
    );
    await expect(page.getByTestId('clock')).toHaveCount(1);
    await expect(tile(page).filter({ hasText: 'Tidy the changelog' })).toHaveAttribute('data-state', 'hibernated');
    // Fit View frames the nodes as they are: let them stop growing, shrinking and moving first.
    await stillBoard(page);
    await page.getByRole('button', { name: 'Fit View' }).click();
    const pinTasks = () =>
      page.evaluate((lines) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          const shown = lines[node.data.trim()];
          if (shown !== undefined) node.data = shown;
        }
      }, taskLines);
    await pinRandomLooks(page);
    await pinPaths(page);
    await pinTasks();
    await shoot(page, 'board-in-use');

    await page.getByRole('button', { name: 'View', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'View', exact: true })).toBeVisible();
    await pinRandomLooks(page);
    await pinTasks();
    await shoot(page, 'view-popover');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** What the PR tab carries that differs run to run: the time it read the pull request, and its branch, drawn as the window's header draws it (`pinRandomLooks` pinned that one). */
async function pinPullRequestLooks(page: Page, branch: string): Promise<void> {
  await page.evaluate((real) => {
    const pinned = document.querySelector('.session-window-where')?.textContent?.trim() ?? real;
    const walker = document.createTreeWalker(document.querySelector("[data-testid='pr-view']") ?? document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      node.data = node.data.replace(/Read \d{1,2}:\d{2} [AP]M/, 'Read 9:41 AM').split(real).join(pinned);
    }
  }, branch);
}

/** A page for the web tab to show: a storefront dev server's home, drawn the way a small app would draw it. */
const DEV_PAGE = `<!doctype html><meta charset="utf-8"><title>Storefront</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: #f7f5ef; color: #2b2a27; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 18px 48px; background: #fff; border-bottom: 1px solid #e3dfd3; }
  header b { font-size: 20px; } nav span { margin-left: 24px; color: #6b6860; }
  main { padding: 48px; max-width: 760px; } h1 { font-size: 36px; margin: 0 0 8px; } p { color: #6b6860; margin: 0 0 28px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .card { background: #fff; border: 1px solid #e3dfd3; border-radius: 12px; padding: 16px; } .card i { display: block; height: 90px; border-radius: 8px; margin-bottom: 12px; }
  .card b { display: block; } .card span { color: #6b6860; }
  button { margin-top: 28px; padding: 10px 18px; border: 0; border-radius: 8px; background: #3b5bdb; color: #fff; font: inherit; }
</style>
<header><b>Storefront</b><nav><span>Shop</span><span>Cart (1)</span></nav></header>
<main><h1>Checkout, fixed.</h1><p>The cart now validates before it charges the card.</p>
<div class="grid"><div class="card"><i style="background:#d0ebff"></i><b>Canvas tote</b><span>$24</span></div><div class="card"><i style="background:#ffd8a8"></i><b>Enamel mug</b><span>$14</span></div><div class="card"><i style="background:#c3fae8"></i><b>Sticker pack</b><span>$6</span></div></div>
<button>Go to checkout</button></main>`;

test('the README screenshots: a session window with two panes, a PR tab and a web tab', async () => {
  const dev = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(DEV_PAGE);
  });
  await new Promise<void>((resolve) => dev.listen(0, '127.0.0.1', resolve));
  const devUrl = `http://127.0.0.1:${(dev.address() as AddressInfo).port}/`;
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [] });
  const { dir, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(
    dataDir,
    { ...env, ...RENDER_ENV, PATH: `${scenarioPicker(dir)}:${env.PATH}`, AGENT_BOARD_GH: github.gh, AGENT_BOARD_PULL_REQUEST_POLL_MS: '200', SHELL: '/bin/sh' },
    RENDER_ARGS,
  );
  await listFinishedTurns(page);
  try {
    await page.setViewportSize(VIEWPORT);
    // gh finds the agent's pull requests in the repo its worktree's remote names.
    const repo = makeRepo(dir, 'storefront');
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/storefront.git']);
    const zone = await page.evaluate(async (path) => {
      const result = await window.agentBoard.zones.addFolder(path, { x: 0, y: 0, width: 420, height: 400, color: '#4c6ef5' });
      if (result.status !== 'added') throw new Error(result.message);
      return result.zone;
    }, repo);
    const agent = await page.evaluate(
      async (params) => {
        const result = await window.agentBoard.agents.spawn(params);
        if (result.status !== 'started') throw new Error(result.message);
        return result.agent;
      },
      { zoneId: zone.id, prompt: 'Fix checkout flake', position: { x: 40, y: 80 }, cols: 100, rows: 30 },
    );
    await expect(tile(page)).toHaveAttribute('data-state', 'idle', { timeout: 30_000 });
    // Fit View frames the nodes as they are: let them stop growing, shrinking and moving first.
    await stillBoard(page);
    await page.getByRole('button', { name: 'Fit View' }).click();
    const pullRequest: FakeGitHubPullRequest = {
      repo: 'acme/storefront',
      number: 41,
      title: 'Validate the cart before charging the card',
      headRefName: agent.branch,
      headRefOid: 'b'.repeat(40),
      state: 'OPEN',
      isDraft: false,
      author: 'maria',
      body: 'Fixes the **flaky checkout**: the cart is validated first, so a bad cart never reaches the card charge.\n\n- validate items and stock\n- charge once, then clear the cart',
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/storefront/actions/runs/1' },
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/storefront/actions/runs/2' },
        { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/storefront/actions/runs/3' },
      ],
      files: [
        { filename: 'src/checkout.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ -10,4 +10,6 @@ export async function checkout(cart: Cart) {\n-  await charge(cart.total);\n+  validate(cart);\n+  await charge(cart.total);\n+  cart.clear();\n   return receipt(cart);\n }' },
      ],
      comments: [{ author: 'sam', body: 'Nice, this was biting us in the demo.', createdAt: '2026-10-01T09:00:00Z' }],
      reviewComments: [{ id: 9, author: 'sam', path: 'src/checkout.ts', line: 11, body: 'Should this throw on an empty cart?', createdAt: '2026-10-01T10:00:00Z' }],
    };
    github.setState({ ...FAKE_GITHUB_STATE, repos: [{ nameWithOwner: 'acme/storefront', description: 'The web storefront', squashMergeAllowed: true }], pullRequests: [pullRequest] });
    await expect(tile(page).getByTestId('tile-pr')).toHaveText('#41');

    // The agent's chip opens its window on a PR tab.
    await tile(page).getByTestId('tile-pr').click();
    const win = sessionWindow(page);
    const prView = win.getByTestId('pr-view');
    await expect(prView.getByTestId('pr-title')).toContainText('Validate the cart');
    await expect(prView.getByTestId('pr-check')).toHaveCount(3);
    await expect(prView.getByTestId('pr-comment')).toHaveCount(2);
    await expect(prView.getByTestId('pr-approve')).toBeVisible();
    await pinRandomLooks(page);
    await pinPaths(page);
    await pinPullRequestLooks(page, agent.branch);
    await shoot(page, 'pr-tab');

    // Two panes, each with its own strip: the agent beside a shell, the PR tab and a second shell.
    await win.getByRole('tab', { name: 'claude', exact: true }).click();
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control+Shift'}+d`);
    const panes = win.getByTestId('window-pane');
    await expect(panes).toHaveCount(2);
    const shell = win.locator('[data-testid="session-tab-view"][data-focused] .shell-pane[data-focused="true"]');
    await shell.getByTestId('session-terminal').click();
    await page.keyboard.type('ls');
    await page.keyboard.press('Enter');
    await expect(shell).toContainText('README.md');
    await panes.nth(0).getByRole('tab', { name: 'claude', exact: true }).click();
    await pinRandomLooks(page);
    await pinPaths(page);
    await pinPullRequestLooks(page, agent.branch);
    await shoot(page, 'session-panes');

    // A web tab from + › Web…, showing the agent's dev server.
    await panes.nth(0).getByRole('button', { name: 'New tab' }).click();
    await page.getByRole('menuitem', { name: 'Web…' }).click();
    const address = page.getByTestId('web-address');
    await expect(address).toBeFocused();
    await address.fill(devUrl);
    await address.press('Enter');
    const webPage = app.windows().find((candidate) => candidate.url().startsWith(devUrl)) ?? (await app.waitForEvent('window', (candidate) => candidate.url().startsWith(devUrl)));
    await expect(webPage.locator('h1')).toHaveText('Checkout, fixed.');
    await webPage.evaluate(() => document.fonts.ready);
    await expect(win.getByTestId('web-view')).toHaveAttribute('aria-busy', 'false');
    // Nothing hovered or focused: the New tab button gets focus back from the dialog, and its tooltip shows for it.
    await page.mouse.move(640, 790);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    // The page is drawn by the main process over the tab's area, outside the window's own pixels: shot on its own and laid over the window's.
    const area = (await win.getByTestId('web-page').boundingBox())!;
    await pinRandomLooks(page);
    await pinPaths(page);
    const port = new URL(devUrl).port;
    const pinPort = () =>
      page.evaluate(
        ({ port }) => {
          // The dev server's port is the machine's: drawn as the usual one.
          for (const input of document.querySelectorAll<HTMLInputElement>("[data-testid='web-address']")) input.value = input.value.replace(`127.0.0.1:${port}`, 'localhost:5173');
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode as Text;
            node.data = node.data.replace(`127.0.0.1:${port}`, 'localhost:5173');
          }
        },
        { port },
      );
    await shootWithPage(page, webPage, area, 'web-tab', pinPort);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    github.dispose();
    dev.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the README screenshots: first-run onboarding', async () => {
  const { dir, env } = scratch('output');
  const github = createFakeGitHub();
  const dataDir = tempDataDir();
  const { app, window } = await launch(
    dataDir,
    { ...env, ...RENDER_ENV, PATH: `${fakeBinDir}:${env.PATH}`, AGENT_BOARD_GH: github.gh, AGENT_BOARD_ONBOARDING: '1', SHELL: '/bin/sh' },
    RENDER_ARGS,
  );
  await listFinishedTurns(window);
  try {
    await window.setViewportSize(VIEWPORT);
    await expect(window.getByRole('dialog', { name: 'Welcome to agent-board' })).toBeVisible();
    await shoot(window, 'onboarding-welcome');
    await window.getByRole('button', { name: 'Get started' }).click();
    await expect(window.getByTestId('connect-summary')).toBeVisible();
    await expect(window.getByRole('img', { name: 'Checking' })).toHaveCount(0);
    await pinRandomLooks(window);
    await pinPaths(window);
    await shoot(window, 'onboarding-connect');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    github.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the README screenshots: Add zone from a Linear team', async () => {
  // The key goes to a throwaway keychain file, which only macOS has (as in add-zone.spec.ts).
  test.skip(process.platform !== 'darwin', 'needs a throwaway macOS keychain: this shot is only made on a Mac');
  // A Linear that knows three invented teams and no projects or issues. It answers each query with the field that
  // query asks for: a connection the app reads (`projects.nodes`) but finds missing is an error in the popover.
  const connections = {
    teams: [{ key: 'WEB', name: 'Storefront' }, { key: 'PAY', name: 'Payments' }, { key: 'DSN', name: 'Design system' }],
  };
  const linear = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += String(chunk)));
    request.on('end', () => {
      const { query } = JSON.parse(body) as { query: string };
      const field = /{\s*(\w+)/.exec(query.slice(query.indexOf('{')))?.[1] ?? '';
      const nodes = connections[field as keyof typeof connections] ?? [];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { [field]: { nodes } } }));
    });
  });
  await new Promise<void>((resolve) => linear.listen(0, '127.0.0.1', resolve));
  const keychain = createTempKeychain();
  const { dir, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(
    dataDir,
    {
      ...env,
      ...RENDER_ENV,
      AGENT_BOARD_LINEAR_API_URL: `http://127.0.0.1:${(linear.address() as AddressInfo).port}/graphql`,
      AGENT_BOARD_KEYCHAIN: keychain.path,
      SHELL: '/bin/sh',
    },
    RENDER_ARGS,
  );
  await listFinishedTurns(window);
  try {
    await window.setViewportSize(VIEWPORT);
    const popover = await openAddZone(window, 'Linear');
    await popover.getByRole('textbox', { name: 'Linear API key' }).fill('lin_api_demo0123456789');
    await popover.getByRole('button', { name: 'Connect Linear' }).click();
    await popover.getByRole('option').filter({ hasText: 'Storefront' }).click();
    await expect(popover.getByRole('textbox', { name: 'Zone name' })).toHaveValue('Storefront');
    await shoot(window, 'add-zone-linear');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    keychain.remove();
    linear.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
