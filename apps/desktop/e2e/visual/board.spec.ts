import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { AGENT_TILE_SIZE, PERCH_ROOM } from '@agent-board/daemon/board-layout';
import type { EdgePoint } from '@agent-board/daemon/protocol';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agents, closeAgent, launch, listFinishedTurns, screen, sessionWindow, spawnAgent, tile, tileAction, TURN_MS, zones } from '../agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from '../launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, pinNow, pinRandomText, settle } from '../render.ts';
import { scratch } from '../scratch.ts';
import { untilStill } from '../board-helpers.ts';
import { SHOT, needsBaselines, viewSettled, nodesStill, PACK_SHOTS, pinChatTimes } from './shared.ts';

test.use({ viewport: null });

/**
 * Two waiting agents in a zone, with what a theme redraws by name: two notes, Ink text, a filled shape and a flow edge
 * between the agents; then fits the view to them all.
 */
async function fillBusyBoard(app: ElectronApplication, window: Page, repo: string) {
  await pickFolderNext(app, repo);
  await browseForZone(window);
  await spawnAgent(window, 'monorepo', 'Pick a database');
  await spawnAgent(window, 'monorepo', 'Tidy the tokens');
  await expect(tile(window)).toHaveCount(2);
  for (const at of [0, 1]) await expect(tile(window).nth(at)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
  await window.addStyleTag({ content: '.hybrid-tile { rotate: 1deg !important; }' });

  // Stored light colours, drawn by name in the dark theme: two notes, Ink text and a filled shape, and a flow edge.
  const [planner, builder] = await agents(window);
  const [zone] = await zones(window);
  await window.evaluate(
    async ({ zoneId, from, to }) => {
      const { items, flowEdges } = globalThis.window.agentBoard;
      await items.create({ kind: 'sticky', zoneId, x: 30, y: 250, width: 220, height: 140, data: { text: '**Ship Friday**\n\n- checkout fix\n- cache decision', color: '#fff3a3' } });
      await items.create({ kind: 'sticky', zoneId: null, x: -280, y: 60, width: 200, height: 120, data: { text: 'Ask about the Stripe test keys', color: '#fcc2d7' } });
      await items.create({ kind: 'text', zoneId: null, x: -280, y: -60, width: 300, height: 50, data: { text: 'Launch week', size: 'h1', bold: true, italic: false, align: 'left', color: '#2b2a27', wrap: false } });
      await items.create({
        kind: 'shape',
        zoneId: null,
        x: -280,
        y: 220,
        width: 200,
        height: 80,
        data: { shape: 'rounded', fill: '#d0ebff', stroke: '#3b5bdb', strokeWidth: 2.5, dashed: false, text: 'Release 1.0', textSize: 'body', bold: true, textColor: '#2b2a27' },
      });
      await flowEdges.create({ from, to });
    },
    { zoneId: zone!.id, from: planner!.sessionId, to: builder!.sessionId },
  );
  await expect(window.getByTestId('flow-edge')).toHaveCount(1);
  // The board draws only what is in view, so fit it all in first.
  await window.getByRole('button', { name: /^Fit view/ }).click();
  await viewSettled(window);
  await expect(window.getByTestId('sticky')).toHaveCount(2);
  await expect(window.getByTestId('shape')).toHaveCount(1);
  await expect(window.getByTestId('text-item')).toHaveCount(1);
}

for (const { theme, scheme } of PACK_SHOTS) {
  test(`the ${theme} theme pack: a busy board with notes, text, a shape and a flow edge`, async () => {
    needsBaselines(`${theme}-board`);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(
      dataDir,
      { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: theme, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
      RENDER_ARGS,
    );
    await listFinishedTurns(window);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: scheme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await fillBusyBoard(app, window, repo);
      await pinRandomText(window);
      await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`${theme}-board.png`, SHOT);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/** Arrows between notes (row 22): straight, elbow bent once, and a curve bowed by its bow handle, selected with its handles. */
for (const { theme, suffix } of [
  { theme: 'light', suffix: '' },
  { theme: 'dark', suffix: '-dark' },
] as const) {
  test(`arrows: straight, an elbow bent once, and a bowed curve selected with its end and bow handles, ${theme}`, async () => {
    needsBaselines(`arrows${suffix}`);
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window } = await launch(dataDir, { ...RENDER_ENV, ...appearance }, RENDER_ARGS);
    await listFinishedTurns(window);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await window.evaluate(async () => {
        const { items, connectors } = globalThis.window.agentBoard;
        const note = (text: string, x: number, y: number) =>
          items.create({ kind: 'sticky', zoneId: null, x, y, width: 160, height: 120, data: { text, color: '#ffd43b' } });
        const ends = async (row: number, style: 'straight' | 'elbow' | 'curved', points: EdgePoint[], label = '') => {
          const [from, to] = [await note(`${style} from`, 0, row * 200), await note(`${style} to`, 820, row * 200 + 40)];
          await connectors.create({ from: { type: 'item', id: from.id, side: 'right' }, to: { type: 'item', id: to.id, side: 'left' }, style, points, label });
        };
        await ends(0, 'straight', []);
        await ends(1, 'elbow', [{ x: -40, y: 70 }]);
        await ends(2, 'curved', [{ x: -60, y: -110, bow: true }], 'bowed');
      });
      await expect(window.locator('.react-flow__edge-path.connector-line')).toHaveCount(3);
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      // The curve selected by its label: its end handles and its one bow handle, on the point it was pulled to.
      await window.getByTestId('connector-label').click();
      await expect(window.getByTestId('line-bow')).toHaveCount(1);
      await expect(window.getByTestId('line-insert')).toHaveCount(0);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`arrows${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });

  test(`a class diagram's relations: their ends, a dashed one, labels by each end, one routed round a note, and one selected, ${theme}`, async () => {
    needsBaselines(`relations${suffix}`);
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window } = await launch(dataDir, { ...RENDER_ENV, ...appearance }, RENDER_ARGS);
    await listFinishedTurns(window);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await window.evaluate(async () => {
        const { items, connectors } = globalThis.window.agentBoard;
        const note = (text: string, x: number, y: number, height = 100) =>
          items.create({ kind: 'sticky', zoneId: null, x, y, width: 160, height, data: { text, color: '#ffd43b' } });
        const [board, zone, tile, agentTile, session, iface] = [
          await note('Board', 0, 0),
          await note('Zone', 360, 0),
          await note('Tile', 360, 320),
          await note('AgentTile', 760, 320),
          await note('Session', 760, 0),
          await note('Startable', 1380, 160),
        ];
        const join = (from: { id: string }, fromSide: 'top' | 'right' | 'bottom' | 'left', to: { id: string }, toSide: typeof fromSide, look: object) =>
          connectors.create({ from: { type: 'item', id: from.id, side: fromSide }, to: { type: 'item', id: to.id, side: toSide }, style: 'straight', ...look });
        await join(board, 'right', zone, 'left', { startEnd: 'diamond', endEnd: 'none', label: 'holds', startLabel: '1', endLabel: '0..*' });
        await join(zone, 'bottom', tile, 'top', { startEnd: 'filled-diamond', endEnd: 'none', label: 'owns', startLabel: '1', endLabel: '0..*' });
        await join(agentTile, 'left', tile, 'right', { endEnd: 'triangle', label: 'is a' });
        await join(agentTile, 'top', session, 'bottom', { endEnd: 'arrow', dashed: true, label: '«uses»' });
        // The elbow from Session goes round this one.
        await note('in the way', 1080, -20, 160);
        await join(session, 'right', iface, 'top', { style: 'elbow', endEnd: 'triangle', dashed: true, endLabel: 'role' });
      });
      await expect(window.locator('.react-flow__edge-path.connector-line')).toHaveCount(5);
      await expect(window.locator('.react-flow__edge-path.connector-line[data-routed]')).toHaveCount(1);
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      // The composition selected by its label: its bar names the relation.
      await window.getByTestId('connector-label').filter({ hasText: 'owns' }).click();
      await expect(window.getByRole('button', { name: 'Relation' })).toHaveText('Composition');
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`relations${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}

test('the dark theme: a busy board with notes, text, a shape and a flow edge, its Edge rules, and the session window in both views', async () => {
  needsBaselines('dark-board', 'dark-edge-rules', 'dark-session-window', 'dark-chat-view');
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(
    dataDir,
    { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: 'dark', SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
    RENDER_ARGS,
  );
  await listFinishedTurns(window);
  try {
    await window.setViewportSize(VIEWPORT);
    // Playwright pins the page to light; the setting has the window in dark mode, as macOS would.
    await window.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await pinFonts(window);
    await fillBusyBoard(app, window, repo);
    await pinRandomText(window);
    let restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot('dark-board.png', SHOT);
    await restorePointer();

    // The Edge rules panel, on the edge: its token opens them.
    await window.getByTestId('rail-token').locator('.rail-token-open').click();
    const rules = window.getByRole('complementary', { name: 'Edge rules' });
    await expect(rules).toBeVisible();
    await expect(rules.getByTestId('edge-rules-preview')).not.toBeEmpty();
    await pinRandomText(window);
    restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('body')).toHaveScreenshot('dark-edge-rules.png', SHOT);
    await restorePointer();
    await window.keyboard.press('Escape');

    // The session window: its terminal the inset well, then the chat view of the same session.
    await tile(window).filter({ hasText: 'Pick a database' }).dblclick();
    await expect(screen(window)).toContainText('Which database should I use');
    await pinRandomText(window);
    restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('body')).toHaveScreenshot('dark-session-window.png', { ...SHOT, mask: [screen(window)] });
    await restorePointer();
    const view = sessionWindow(window).getByRole('group', { name: 'View' });
    await view.getByRole('button', { name: 'Chat' }).click();
    await expect(sessionWindow(window).getByTestId('chat-assistant')).toHaveText(['Which database should I use, Postgres or SQLite?']);
    await expect(sessionWindow(window).getByTestId('chat-live')).toHaveAttribute('data-live', 'done');
    await pinRandomText(window);
    await pinChatTimes(window);
    await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('body')).toHaveScreenshot('dark-chat-view.png', SHOT);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hand-off between agents bent through a point to the top of the other tile, selected with its handles and its Edge rules in four sections', async () => {
  needsBaselines('edge-rules', 'edge-bent');
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  await listFinishedTurns(window);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Fix checkout flake');
    await spawnAgent(window, 'monorepo', 'Review checkout fix');
    await expect(tile(window)).toHaveCount(2);
    for (const at of [0, 1]) await expect(tile(window).nth(at)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    // Apart, the second lower down, so the edge has room for its label and a bend.
    const [fixer, reviewer] = await agents(window);
    const [zone] = await zones(window);
    await window.evaluate(
      async ({ zoneId, from, to }) => {
        await globalThis.window.agentBoard.agents.move(from, { zoneId, x: 20, y: 40 });
        await globalThis.window.agentBoard.agents.move(to, { zoneId, x: 560, y: 300 });
        await globalThis.window.agentBoard.flowEdges.create({ from, to, trigger: 'manual', fromSide: 'right', toSide: 'top' });
      },
      { zoneId: zone!.id, from: fixer!.sessionId, to: reviewer!.sessionId },
    );
    await expect(window.getByTestId('flow-edge')).toHaveCount(1);
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);

    // Bent through one point (dragging a bend out is the e2e's: here it is put exactly, so it lands the same run to
    // run), up and to the right of the middle of its ends, where its bends are kept from. Selected, it shows its handles.
    await window.evaluate(async () => {
      const { flowEdges } = globalThis.window.agentBoard;
      const [edge] = await flowEdges.list();
      await flowEdges.update({ id: edge!.id, points: [{ x: 220, y: -150 }] });
    });
    await window.getByTestId('rail-token').locator('.rail-token-open').click();
    const rules = window.getByRole('complementary', { name: 'Edge rules' });
    await expect(rules).toBeVisible();
    await expect(window.getByTestId('line-bow')).toHaveCount(1);
    await expect(rules.getByTestId('edge-rules-preview')).not.toBeEmpty();
    await pinRandomText(window);
    let restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('body')).toHaveScreenshot('edge-rules.png', SHOT);
    await restorePointer();

    // Unselected, the bent line alone.
    await rules.getByRole('button', { name: 'Close edge rules' }).click();
    await expect(window.getByTestId('line-bow')).toHaveCount(0);
    restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot('edge-bent.png', SHOT);
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hand-off between the ends of a row of three agents goes round the tile between them, as an elbow and as a curve; straight, or bent by hand, it goes where it is put, until Route automatically; an arrow routes too; and both go straight again once that tile moves away', async () => {
  needsBaselines('edge-routed', 'edge-routed-curved');
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  await listFinishedTurns(window);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Fix checkout flake');
    await spawnAgent(window, 'monorepo', 'Pick a cache');
    await spawnAgent(window, 'monorepo', 'Review checkout fix');
    await expect(tile(window)).toHaveCount(3);
    for (const at of [0, 1, 2]) await expect(tile(window).nth(at)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    // In a row, the first handing off to the third, past the second, with room between them for the rail's token.
    const [fixer, cache, reviewer] = await agents(window);
    const [zone] = await zones(window);
    await window.evaluate(
      async ({ zoneId, from, between, to }) => {
        const { agents, flowEdges } = globalThis.window.agentBoard;
        await agents.move(from, { zoneId, x: 40, y: 120 });
        await agents.move(between, { zoneId, x: 560, y: 120 });
        await agents.move(to, { zoneId, x: 1080, y: 120 });
        await flowEdges.create({ from, to, trigger: 'manual', fromSide: 'right', toSide: 'left', style: 'elbow' });
      },
      { zoneId: zone!.id, from: fixer!.sessionId, between: cache!.sessionId, to: reviewer!.sessionId },
    );
    const edge = window.getByTestId('flow-edge');
    const restyle = (changes: { style?: 'straight' | 'elbow' | 'curved'; points?: { x: number; y: number }[] }) =>
      window.evaluate(async (shape) => {
        const { flowEdges } = globalThis.window.agentBoard;
        const [made] = await flowEdges.list();
        await flowEdges.update({ id: made!.id, ...shape });
      }, changes);
    /** The board as it is, with nothing hovered: the pointer off the Fit view button it pressed, which keeps its hover. */
    const shoot = async (name: string) => {
      await window.mouse.move(VIEWPORT.width - 4, VIEWPORT.height / 2);
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(name, SHOT);
      await restorePointer();
    };
    await expect(edge).toHaveAttribute('data-routed', 'true');
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    await shoot('edge-routed.png');

    await restyle({ style: 'curved' });
    await expect(edge).toHaveAttribute('data-routed', 'true');
    await shoot('edge-routed-curved.png');

    // A straight line is always straight, across the tile in its way.
    await restyle({ style: 'straight' });
    await expect(edge).not.toHaveAttribute('data-routed');
    await expect(edge).toHaveAttribute('d', /^M ?[\d.]+,[\d.]+ ?L ?[\d.]+,[\d.]+$/);

    // Bent by hand, an elbow goes through its bend, 150 above the middle of its ends, and isn't routed.
    await restyle({ style: 'elbow', points: [{ x: 0, y: -150 }] });
    await expect(edge).not.toHaveAttribute('data-routed');
    const drawn = (await edge.getAttribute('d'))!;
    const startY = Number(/^M ?[\d.]+,([\d.]+)/.exec(drawn)![1]);
    expect(drawn).toContain(`,${startY - 150} `);

    // Route automatically, on its style bar, takes the bend out: it routes again.
    await window.getByTestId('rail-token').locator('.rail-token-open').click();
    await window.getByRole('button', { name: 'Route automatically' }).click();
    await expect(edge).toHaveAttribute('data-routed', 'true');
    await expect(window.getByRole('button', { name: 'Route automatically' })).toHaveCount(0);
    await window.getByRole('complementary', { name: 'Edge rules' }).getByRole('button', { name: 'Close edge rules' }).click();

    // An arrow between the same two goes round the tile in its way as well.
    await window.evaluate(
      async ({ from, to }) => {
        await globalThis.window.agentBoard.connectors.create({ from: { type: 'agent', id: from, side: 'bottom' }, to: { type: 'agent', id: to, side: 'bottom' }, style: 'elbow' });
      },
      { from: fixer!.sessionId, to: reviewer!.sessionId },
    );
    const arrow = window.locator('.react-flow__edge-path.connector-line');
    await expect(arrow).toHaveCount(1);
    // Bottom to bottom, an unrouted elbow runs just under the row: clear of the middle tile, so it isn't routed yet.
    await expect(arrow).not.toHaveAttribute('data-routed');
    await window.evaluate(async () => {
      const [made] = await globalThis.window.agentBoard.connectors.list();
      await globalThis.window.agentBoard.connectors.update({ id: made!.id, from: { ...made!.from, side: 'right' }, to: { ...made!.to, side: 'left' } });
    });
    await expect(arrow).toHaveAttribute('data-routed', 'true');

    // With the second tile moved out of the row, nothing is in the way: both lines are drawn as they always were.
    await window.evaluate(
      async ({ zoneId, between }) => {
        await globalThis.window.agentBoard.agents.move(between, { zoneId, x: 560, y: 600 });
      },
      { zoneId: zone!.id, between: cache!.sessionId },
    );
    await expect(edge).not.toHaveAttribute('data-routed');
    await expect(arrow).not.toHaveAttribute('data-routed');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent note's tether goes round the tile between the note and its agent, and is straight again once that tile moves away", async () => {
  needsBaselines('tether-routed');
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  await listFinishedTurns(window);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pinNow(window, new Date('2026-01-02T09:00:00.000Z'));
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Fix checkout flake');
    await spawnAgent(window, 'monorepo', 'Pick a cache');
    await expect(tile(window)).toHaveCount(2);
    for (const at of [0, 1]) await expect(tile(window).nth(at)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    const [fixer, cache] = await agents(window);
    const [zone] = await zones(window);
    // A note on the left about the fixer on the right, with the second agent's tile between them.
    await window.evaluate(
      async ({ zoneId, fixerId, fixerName, between }) => {
        const board = globalThis.window.agentBoard;
        await board.agents.move(between, { zoneId, x: 420, y: 120 });
        await board.agents.move(fixerId, { zoneId, x: 900, y: 120 });
        await board.items.create({
          kind: 'agent-note',
          zoneId,
          x: 40,
          y: 120,
          width: 240,
          height: 150,
          data: {
            text: '**Round 2 of 3**\n\n- implementer: `2 of 3` done\n- reviewer: idle',
            agent: { sessionId: fixerId, name: fixerName, harness: 'claude', role: 'orchestrator' },
            about: fixerId,
            writtenAt: '2026-01-01T00:00:00.000Z',
            editedByUser: false,
          },
        });
      },
      { zoneId: zone!.id, fixerId: fixer!.sessionId, fixerName: fixer!.name, between: cache!.sessionId },
    );
    const tether = window.getByTestId('agent-note-tether');
    await expect(tether).toHaveCount(1);
    await expect(tether).toHaveAttribute('data-routed', 'true');
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    await window.mouse.move(VIEWPORT.width - 4, VIEWPORT.height / 2);
    await pinRandomText(window);
    const restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot('tether-routed.png', SHOT);
    await restorePointer();

    // Out of its way, it is the straight line again.
    await window.evaluate(
      async ({ zoneId, between }) => {
        await globalThis.window.agentBoard.agents.move(between, { zoneId, x: 420, y: 600 });
      },
      { zoneId: zone!.id, between: cache!.sessionId },
    );
    await expect(tether).not.toHaveAttribute('data-routed');
    await expect(tether).toHaveAttribute('d', /^M[\d.\s,]+L[\d.\s,]+$/);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two agents stacked one above the other, joined both ways by edges made without sides: one rail between the sides facing each other', async () => {
  needsBaselines('edges-stacked');
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  await listFinishedTurns(window);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Fix checkout flake');
    await spawnAgent(window, 'monorepo', 'Review checkout fix');
    await expect(tile(window)).toHaveCount(2);
    for (const at of [0, 1]) await expect(tile(window).nth(at)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    // The implementer above its reviewer, joined as an orchestrator joins them: with no sides given, each way.
    const [fixer, reviewer] = await agents(window);
    const [zone] = await zones(window);
    await window.evaluate(
      async ({ zoneId, from, to }) => {
        const { agents, flowEdges } = globalThis.window.agentBoard;
        await agents.move(from, { zoneId, x: 40, y: 40 });
        await agents.move(to, { zoneId, x: 40, y: 520 });
        await flowEdges.create({ from, to, payload: 'handover', path: 'handover.md' });
        await flowEdges.create({ from: to, to: from, trigger: 'manual' });
      },
      { zoneId: zone!.id, from: fixer!.sessionId, to: reviewer!.sessionId },
    );
    await expect(window.getByTestId('flow-edge')).toHaveCount(1);
    await expect(window.getByTestId('rail-token')).toHaveCount(1);
    // The zone grows round the moved tiles over a few frames, and the rail follows them: fit and shoot only once the tiles and the rail's line hold still.
    await nodesStill(window);
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    await nodesStill(window);
    await untilStill(() => window.getByTestId('flow-edge').evaluate((rail) => `${rail.getAttribute('d')} ${rail.getAttribute('data-routed')}`));
    await pinRandomText(window);
    const restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot('edges-stacked.png', SHOT);
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('linked sessions as one rail: a pair waiting for Send beside a one-way link, then its review on its way, a hand-off held, and the pair at rest', async () => {
  needsBaselines('rail-waiting', 'rail-chain', 'rail-sending', 'rail-held', 'rail-rest');
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  await listFinishedTurns(window);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Fix checkout flake');
    await spawnAgent(window, 'monorepo', 'Review checkout fix');
    await spawnAgent(window, 'monorepo', 'Merge checkout fix');
    await expect(tile(window)).toHaveCount(3);
    for (const at of [0, 1, 2]) await expect(tile(window).nth(at)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    const [fixer, reviewer, merger] = await agents(window);
    const [zone] = await zones(window);
    // The fixer's handover goes to the reviewer once CI is green; the reviewer's review goes back when sent.
    writeFileSync(join(fixer!.worktree, 'handover.md'), '# Handover\n');
    writeFileSync(join(reviewer!.worktree, 'review.md'), '# Review\n');
    const [handover, review] = await window.evaluate(
      async ({ zoneId, ids }) => {
        const { agents, flowEdges } = globalThis.window.agentBoard;
        for (const [index, id] of ids.entries()) await agents.move(id, { zoneId, x: 20 + index * 520, y: 40 });
        return [
          await flowEdges.create({ from: ids[0]!, to: ids[1]!, payload: 'handover', path: 'handover.md', conditions: [{ kind: 'pr-checks' }] }),
          await flowEdges.create({ from: ids[1]!, to: ids[0]!, trigger: 'manual', payload: 'handover', path: 'review.md' }),
        ];
      },
      { zoneId: zone!.id, ids: [fixer!.sessionId, reviewer!.sessionId, merger!.sessionId] },
    );
    const token = window.getByTestId('rail-token');
    await expect(token).toHaveAttribute('data-state', 'waiting');
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    const shoot = async (name: string) => {
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(name, SHOT);
      await restorePointer();
    };
    // The reviewer is done: its review waits at its end, with Send.
    await shoot('rail-waiting.png');

    // A one-way link on to the merger: a rail with a small arrow, and a ghost of what comes next.
    await window.evaluate(
      ([from, to]) => globalThis.window.agentBoard.flowEdges.create({ from: from!, to: to!, payload: 'json', path: 'verdict.json', conditions: [{ kind: 'pr-checks' }] }),
      [reviewer!.sessionId, merger!.sessionId],
    );
    await expect(token).toHaveCount(2);
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    await shoot('rail-chain.png');

    // Sent, it is on its way to the fixer: under reduced motion it is drawn there at once. The trip is held open, so the
    // shot never races its end.
    const longTrip = await window.addStyleTag({ content: ':root { --motion-handoff: 600000ms !important; }' });
    await token.filter({ hasText: 'review.md' }).getByTestId('rail-token-send').click();
    await expect(token.filter({ hasText: 'review.md' })).toHaveAttribute('data-state', 'sending');
    // Send says "Sent." in a toast, which is not part of the rail's picture: dismissed before any shot.
    const toasts = window.getByRole('list', { name: 'Notifications' });
    await toasts.getByRole('button', { name: 'Dismiss' }).click({ timeout: 2000 }).catch(() => undefined);
    await expect(toasts.getByRole('listitem')).toHaveCount(0);
    // The fixer's turn on it ends meanwhile, and its handover is held until CI is green: shot once its tile is still.
    const held = async () => (await window.evaluate(() => globalThis.window.agentBoard.flowEdges.list())).find((edge) => edge.id === handover.id)?.held;
    await expect.poll(held, { timeout: 30_000 }).not.toBeNull();
    await expect(tile(window).filter({ hasText: 'Fix checkout flake' })).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    await shoot('rail-sending.png');

    // Its trip over, the handover shows, held at the fixer's end.
    await longTrip.evaluate((element) => (element as Element).remove());
    // Any change to the edges looks again at what is on its way.
    await window.evaluate((id) => globalThis.window.agentBoard.flowEdges.update({ id, deliverAs: 'message' }), review.id);
    await expect(token.filter({ hasText: 'handover.md' })).toHaveAttribute('data-state', 'held');
    await shoot('rail-held.png');

    // Dropped, the pair is at rest: the review at the fixer's end, delivered, round 1.
    await window.evaluate((id) => globalThis.window.agentBoard.flowEdges.drop(id), handover.id);
    await expect(token.filter({ hasText: 'review.md' })).toHaveAttribute('data-state', 'delivered');
    await shoot('rail-rest.png');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const { theme, suffix } of [
  { theme: 'light', suffix: '' },
  { theme: 'dark', suffix: '-dark' },
] as const) {
  test(`a lane with closed agents folded to chips beside a live one, joined by edges, ${theme}`, async () => {
    needsBaselines(`folded-chips${suffix}`);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
    await listFinishedTurns(window);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Fix checkout flake');
      await spawnAgent(window, 'monorepo', 'Review checkout fix');
      await spawnAgent(window, 'monorepo', 'Ship checkout fix');
      await expect(tile(window)).toHaveCount(3);
      for (const at of [0, 1, 2]) await expect(tile(window).nth(at)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      const [fixer, reviewer, shipper] = await agents(window);
      const [zone] = await zones(window);
      await window.evaluate(
        async ({ zoneId, ids }) => {
          const { agents, flowEdges } = globalThis.window.agentBoard;
          for (const [index, id] of ids.entries()) await agents.move(id, { zoneId, x: 40 + index * 300, y: 40 });
          await flowEdges.create({ from: ids[0]!, to: ids[1]!, payload: 'handover', path: 'handover.md' });
          await flowEdges.create({ from: ids[1]!, to: ids[2]!, payload: 'handover', path: 'handover.md' });
        },
        { zoneId: zone!.id, ids: [fixer!.sessionId, reviewer!.sessionId, shipper!.sessionId] },
      );
      await closeAgent(window, fixer!.sessionId);
      await closeAgent(window, reviewer!.sessionId);
      await expect(window.locator('[data-testid="agent-tile"][data-folded]')).toHaveCount(2);
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`folded-chips${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('connections hidden: the hand-off and the arrow between two agents are not drawn, and each tile says how many it has', async () => {
  needsBaselines('connections-hidden');
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  await listFinishedTurns(window);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Fix checkout flake');
    await spawnAgent(window, 'monorepo', 'Review checkout fix');
    await expect(tile(window)).toHaveCount(2);
    for (const at of [0, 1]) await expect(tile(window).nth(at)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    const [fixer, reviewer] = await agents(window);
    const [zone] = await zones(window);
    await window.evaluate(
      async ({ zoneId, from, to }) => {
        const { agents, flowEdges, connectors } = globalThis.window.agentBoard;
        await agents.move(from, { zoneId, x: 40, y: 40 });
        await agents.move(to, { zoneId, x: 440, y: 40 });
        await flowEdges.create({ from, to });
        await connectors.create({ from: { type: 'agent', id: to, side: 'bottom' }, to: { type: 'agent', id: from, side: 'bottom' } });
      },
      { zoneId: zone!.id, from: fixer!.sessionId, to: reviewer!.sessionId },
    );
    await expect(window.locator('.react-flow__edge')).toHaveCount(2);
    // ⇧E: hand-offs only, then none.
    await window.keyboard.press('Shift+E');
    await window.keyboard.press('Shift+E');
    await expect(window.locator('.react-flow__edge')).toHaveCount(0);
    await expect(window.getByTestId('connections-count')).toHaveText(['↔ 2', '↔ 2']);
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    await pinRandomText(window);
    const restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot('connections-hidden.png', SHOT);
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an orchestrator expanded in place, its crew pushed aside in their frame, which its zone grows to hold', async () => {
  needsBaselines('expanded-crew');
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  await listFinishedTurns(window);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Lead two: Fix the flaky test');
    if (await sessionWindow(window).isVisible()) await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await expect(tile(window)).toHaveCount(3, { timeout: 2 * TURN_MS });
    // Waiting, not just done working: an agent still thinking, or idle before it asks, redraws its tile.
    for (const at of [0, 1, 2]) await expect(tile(window).nth(at)).toHaveAttribute('data-state', 'waiting', { timeout: 2 * TURN_MS });
    await expect(window.getByTestId('crew-frame')).toHaveCount(1);
    await tileAction(window.locator('[data-testid="agent-tile"][data-orchestrator]'), 'Expand in place');
    await expect(window.getByTestId('expanded-tile')).toHaveCount(1);
    // Its pane in view marks the orchestrator seen, but only while the app has the focus, which a background run may
    // not: mark it seen as its pane would. Its crew's finished turns are its own to take, so nothing needs the user.
    await window.evaluate(async () => {
      const { agents } = globalThis.window.agentBoard;
      const lead = (await agents.list()).find((agent) => agent.spawnedBy === null);
      await agents.markSeen(lead!.sessionId);
    });
    await expect(window.getByTestId('inbox-count')).toContainText('Nothing needs you');
    // The crew is pushed aside and the zone grows to hold it, over a few frames: fit only once all of it holds still.
    await expect(window.locator('[data-testid="expanded-tile"][data-opening]')).toHaveCount(0);
    await nodesStill(window);
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    await pinRandomText(window);
    const restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot('expanded-crew.png', { ...SHOT, mask: [screen(window)] });
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const { shot, layout, prompt } of [
  { shot: 'arranged-crew-rail', layout: 'rows', prompt: 'Arrange a messy crew' },
  { shot: 'arranged-crew-rail-columns', layout: 'columns', prompt: 'Arrange a messy crew in columns' },
] as const) test(`an orchestrator arranges its crew in ${layout}: its implementer and reviewer a rail apart, the token and its label clear of both tiles`, async () => {
  needsBaselines(shot);
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  await listFinishedTurns(window);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', prompt);
    if (await sessionWindow(window).isVisible()) await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    // Each CLI command starts the app's executable as Node: a turn's worth of time each.
    await expect(tile(window)).toHaveCount(3, { timeout: 4 * TURN_MS });
    for (const at of [0, 1, 2]) await expect(tile(window).nth(at)).not.toHaveAttribute('data-state', 'working', { timeout: 2 * TURN_MS });
    const token = window.getByTestId('rail-token');
    // The rail comes from a CLI command too, and holds the fit back until the crew is arranged.
    await expect(token).toHaveCount(1, { timeout: 4 * TURN_MS });
    const named = (name: string) => tile(window).filter({ has: window.getByTitle(name, { exact: true }) });
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    // The lane's note, past its reviewer: drawn once the view fits the zone, as the board draws only what is in view.
    await expect(window.getByTestId('agent-note')).toHaveCount(1, { timeout: 4 * TURN_MS });
    // The first fit can land while the arrange is still moving the crew: fit again once every node holds still.
    await nodesStill(window);
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    // The token, and the line under it, lie between the implementer and its reviewer, touching neither.
    const [impl, review, chip, note] = await Promise.all([
      named('impl').boundingBox(),
      named('review').boundingBox(),
      token.locator('.rail-token-chip').boundingBox(),
      token.getByTestId('rail-token-note').boundingBox(),
    ]);
    for (const part of [chip!, note!]) {
      // In rows the rail runs across, in columns down: past the room above the reviewer for the characters on its top edge.
      if (layout === 'rows') {
        expect(part.x).toBeGreaterThan(impl!.x + impl!.width);
        expect(part.x + part.width).toBeLessThan(review!.x);
      } else {
        expect(part.y).toBeGreaterThan(impl!.y + impl!.height);
        expect(part.y + part.height).toBeLessThan(review!.y - PERCH_ROOM * (impl!.width / AGENT_TILE_SIZE.width));
      }
    }
    await pinRandomText(window);
    // The note's badge says when it was written.
    await window.evaluate(() => {
      for (const element of document.querySelectorAll("[data-testid='sticky'], [data-testid='agent-note']")) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) (walker.currentNode as Text).data = (walker.currentNode as Text).data.replace(/\d\d:\d\d/, '14:31');
      }
    });
    const restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot(`${shot}.png`, SHOT);
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
