import { expect } from '@playwright/test';
import type { EdgePoint } from '@agent-board/daemon/protocol';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agents, launch, listFinishedTurns, screen, setClickOpens, spawnAgent, tile, TURN_MS, zoneNamed, zones } from '../agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone, type LaunchOptions } from '../launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, pinNow, pinRandomText, settle } from '../render.ts';
import { scratch } from '../scratch.ts';
import { centreOf, drag, settledBox } from '../board-helpers.ts';
import { openSettings, settingsSection } from '../settings-helpers.ts';
import { SHOT, needsBaselines, viewSettled, nodesStill, THEMES, launchGallery, shootSimplifiedNotes } from './shared.ts';

test.use({ viewport: null });

// An agent's calm tile in the Simplified design: one in each status, then the technical layer added to one.
const CALM_STATUSES = ['working', 'waiting', 'done', 'paused', 'scheduled', 'problem', 'stopped'];
for (const { theme, suffix } of THEMES) {
  test(`an agent's calm tile in each status in the Simplified design: name, window controls, one grey line, the status and a button only when it needs you, ${theme}`, async () => {
    needsBaselines(...CALM_STATUSES.map((status) => `simplified-tile-${status}${suffix}`));
    const dataDir = tempDataDir();
    const { app, window } = await launchGallery(dataDir, theme, undefined, { design: 'simplified' });
    try {
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      // The gallery's folded chips are agent tiles too, in a section of their own.
      await expect(window.getByTestId('calm-tile-gallery').locator('[data-testid^="simplified-tile-"]').getByTestId('agent-tile')).toHaveCount(8);
      await pinFonts(window);
      await ignorePointer(window);
      await settle(window);
      for (const status of CALM_STATUSES) {
        await expect.soft(window.getByTestId(`simplified-tile-${status}`)).toHaveScreenshot(`simplified-tile-${status}${suffix}.png`, SHOT);
      }
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}

test("an agent's calm tile with Show technical details on in the Simplified design: its AI, branch, pull request, raw state and exit code under it", async () => {
  needsBaselines('simplified-tile-technical');
  const dataDir = tempDataDir();
  const { app, window } = await launchGallery(dataDir, 'light', undefined, { design: 'simplified', technical: true });
  try {
    await expect(window.locator('html')).toHaveAttribute('data-technical', '');
    const calm = window.getByTestId('simplified-tile-technical');
    await expect(calm.getByTestId('tile-technical')).toBeVisible();
    await pinFonts(window);
    await ignorePointer(window);
    await settle(window);
    await expect.soft(calm).toHaveScreenshot('simplified-tile-technical.png', SHOT);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

// Settings › Alerts in the Simplified design: the one "Notify me when" pop-up in place of Classic's three rows.
for (const { theme, suffix } of THEMES) {
  test(`Settings › Alerts in the Simplified design: one Notify me when pop-up, ${theme}`, async () => {
    needsBaselines(`simplified-settings-alerts${suffix}`);
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window } = await launch(dataDir, { ...RENDER_ENV, ...appearance }, RENDER_ARGS, { design: 'simplified' });
    try {
      const settings = await openSettings(window, 'alerts.notifications');
      await settings.emulateMedia({ colorScheme: theme });
      await expect.poll(() => settings.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await expect(settings.getByLabel('Notify me when')).toBeVisible();
      await pinFonts(settings);
      const restorePointer = await ignorePointer(settings);
      await settle(settings);
      await expect.soft(settings.locator('body')).toHaveScreenshot(`simplified-settings-alerts${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close().catch(() => {});
      await removeDataDir(dataDir);
    }
  });
}

// A shell's calm tile, a start's calm tile and the folded chips in the Simplified design, from the gallery.
const CALM_SHELLS = ['running', 'stopped', 'ended'];
const CALM_STARTS = ['starting', 'failed'];
for (const { theme, suffix } of THEMES) {
  test(`a shell's calm tile, a start's and the folded chips in the Simplified design: name and window controls, the folder, a status only when there is one, ${theme}`, async () => {
    needsBaselines(...CALM_SHELLS.map((name) => `simplified-shell-tile-${name}${suffix}`), ...CALM_STARTS.map((name) => `simplified-start-tile-${name}${suffix}`), `simplified-folded-chips${suffix}`);
    const dataDir = tempDataDir();
    const { app, window } = await launchGallery(dataDir, theme, undefined, { design: 'simplified' });
    try {
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      await expect(window.getByTestId('simplified-folded-chips').getByTestId('agent-tile')).toHaveCount(3);
      await pinFonts(window);
      await ignorePointer(window);
      await settle(window);
      for (const name of CALM_SHELLS) {
        await expect.soft(window.getByTestId(`simplified-shell-tile-${name}`)).toHaveScreenshot(`simplified-shell-tile-${name}${suffix}.png`, SHOT);
      }
      for (const name of CALM_STARTS) {
        await expect.soft(window.getByTestId(`simplified-start-tile-${name}`)).toHaveScreenshot(`simplified-start-tile-${name}${suffix}.png`, SHOT);
      }
      await expect.soft(window.getByTestId('simplified-folded-chips')).toHaveScreenshot(`simplified-folded-chips${suffix}.png`, SHOT);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}

// A tile expanded in place in the Simplified design: the card's hairline around the session window, its status as the calm tile draws it, and the branch
// and pull requests left to Show technical details.
for (const { theme, suffix } of THEMES) {
  test(`a tile expanded in place in the Simplified design: a hairline card, its status mark and 24px header controls, ${theme}`, async () => {
    needsBaselines(`simplified-expanded-tile${suffix}`);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, { design: 'simplified' });
    await listFinishedTurns(window);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Fix checkout flake');
      await expect(tile(window)).toHaveCount(1);
      await expect(tile(window).first()).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      await setClickOpens(window, 'Expand in place');
      await tile(window).first().dblclick();
      const expanded = window.getByTestId('expanded-tile');
      await expect(expanded).toBeVisible();
      await expect(screen(window)).toContainText('Which database should I use');
      await expect(expanded.getByTestId('status-mark')).toBeVisible();
      // The branch and pull requests are the technical layer: not in the header while it is off.
      await expect(expanded.locator('.session-window-where')).toBeHidden();
      const viewport = () => window.locator('.react-flow__viewport').evaluate((element) => (element as HTMLElement).style.transform);
      let last = '';
      await expect
        .poll(async () => {
          const now = await viewport();
          const still = now === last;
          last = now;
          return still;
        })
        .toBe(true);
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`simplified-expanded-tile${suffix}.png`, { ...SHOT, mask: [screen(window)] });
      await restorePointer();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
      await removeDataDir(dataDir);
    }
  });
}

// Projects in the Simplified design: a repo's well with two agents counted in its heading, and a folderless one tinted by
// a fill of its own; then the first one's right-click menu with Project options › open, which is its whole ⋯.
for (const { theme, suffix } of THEMES) {
  test(`projects in the Simplified design: two wells, and a project's right-click menu with its options open, ${theme}`, async () => {
    needsBaselines(`simplified-zone${suffix}`, `simplified-zone-menu${suffix}`);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, { design: 'simplified' });
    await listFinishedTurns(window);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Fix login redirect');
      await spawnAgent(window, 'monorepo', 'Write onboarding docs');
      await expect(tile(window)).toHaveCount(2);
      for (const at of [0, 1]) await expect(tile(window).nth(at)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      await window.evaluate(async () => {
        const { zones } = globalThis.window.agentBoard;
        const [monorepo] = await zones.list();
        const kobo = await zones.addUnbound({ name: 'Kobo Planning', x: monorepo!.x + monorepo!.width + 40, y: monorepo!.y, width: 600, height: 240 });
        await zones.setLook(kobo.id, { color: '#be4bdb', fillOpacity: 12 });
      });
      await expect(window.getByTestId('zone')).toHaveCount(2);
      // Nothing selected, so no project shows its resize handles.
      await window.locator('.react-flow__pane').click({ position: { x: 8, y: 400 } });
      await expect(window.locator('.react-flow__node.selected')).toHaveCount(0);
      await nodesStill(window);
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      await nodesStill(window);
      await pinRandomText(window);
      let restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`simplified-zone${suffix}.png`, SHOT);
      await restorePointer();

      const monorepo = zoneNamed(window, 'monorepo');
      const box = (await monorepo.boundingBox())!;
      await window.mouse.click(box.x + box.width - 48, box.y + box.height - 48, { button: 'right' });
      // The pointer rests on bare board, so no row is hovered and hiding it closes nothing.
      await window.mouse.move(640, 120);
      await window.getByRole('menuitem', { name: 'Project options' }).focus();
      await window.keyboard.press('ArrowRight');
      await expect(window.getByRole('menuitem', { name: 'Agents in this project' })).toBeVisible();
      restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('body')).toHaveScreenshot(`simplified-zone-menu${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// Connections in the Simplified design: today's rails, arrows and captions restyled by its tokens.
for (const { theme, suffix } of THEMES) {
  const simplified: LaunchOptions = { design: 'simplified' };
  const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};

  test(`rails between three agents in the Simplified design: a pair waiting with no Send on its token, and a one-way link with what comes next, ${theme}`, async () => {
    needsBaselines(`simplified-edges${suffix}`);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, simplified);
    await listFinishedTurns(window);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
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
      writeFileSync(join(fixer!.worktree, 'handover.md'), '# Handover\n');
      writeFileSync(join(reviewer!.worktree, 'review.md'), '# Review\n');
      await window.evaluate(
        async ({ zoneId, ids }) => {
          const { agents, flowEdges } = globalThis.window.agentBoard;
          for (const [index, id] of ids.entries()) await agents.move(id, { zoneId, x: 20 + index * 520, y: 40 });
          await flowEdges.create({ from: ids[0]!, to: ids[1]!, payload: 'handover', path: 'handover.md', conditions: [{ kind: 'pr-checks' }] });
          await flowEdges.create({ from: ids[1]!, to: ids[0]!, trigger: 'manual', payload: 'handover', path: 'review.md' });
          await flowEdges.create({ from: ids[1]!, to: ids[2]!, payload: 'json', path: 'verdict.json', conditions: [{ kind: 'pr-checks' }] });
        },
        { zoneId: zone!.id, ids: [fixer!.sessionId, reviewer!.sessionId, merger!.sessionId] },
      );
      const token = window.getByTestId('rail-token');
      await expect(token).toHaveCount(2);
      await expect(token.filter({ hasText: 'review.md' })).toHaveAttribute('data-state', 'waiting');
      // The waiting review has no Send on it: it is sent from its Edge rules.
      await expect(window.getByTestId('rail-token-send')).toHaveCount(0);
      await nodesStill(window);
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      await nodesStill(window);
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`simplified-edges${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`arrows between notes in the Simplified design: straight, an elbow and a bowed curve selected, ${theme}`, async () => {
    needsBaselines(`simplified-arrows${suffix}`);
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...RENDER_ENV, ...appearance }, RENDER_ARGS, simplified);
    await listFinishedTurns(window);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
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
      await window.getByTestId('connector-label').click();
      await expect(window.getByTestId('line-bow')).toHaveCount(1);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`simplified-arrows${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}

test('connections hidden in the Simplified design: no rail or arrow is drawn, and each tile says how many it has', async () => {
  needsBaselines('simplified-connections-hidden');
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, { design: 'simplified' });
  await listFinishedTurns(window);
  try {
    await window.setViewportSize(VIEWPORT);
    await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
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
    await expect(window.locator('.react-flow__edge')).toHaveCount(1);
    await window.keyboard.press('Shift+E');
    await expect(window.locator('.react-flow__edge')).toHaveCount(0);
    await expect(window.getByTestId('connections-count')).toHaveText(['↔ 2', '↔ 2']);
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    await pinRandomText(window);
    const restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot('simplified-connections-hidden.png', SHOT);
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const { theme, suffix } of THEMES) {
  test(`the text style bar with its font size control, ${theme}`, async () => {
    needsBaselines(`text-style-bar${suffix}`);
    const dataDir = tempDataDir();
    const { app, window } = await launch(
      dataDir,
      { ...RENDER_ENV, ...(theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {}), SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
      RENDER_ARGS,
    );
    await listFinishedTurns(window);
    try {
      await window.setViewportSize(VIEWPORT);
      if (theme === 'dark') await window.emulateMedia({ colorScheme: 'dark' });
      await pinFonts(window);
      await window.evaluate(async () => {
        await globalThis.window.agentBoard.items.create({
          kind: 'text',
          zoneId: null,
          x: 0,
          y: 0,
          width: 300,
          height: 60,
          data: { text: 'Launch week', size: 'h1', fontSize: 32, bold: true, italic: false, align: 'left', color: '#2b2a27', wrap: true },
        });
      });
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      await window.getByTestId('text-item').click();
      const bar = window.getByRole('toolbar', { name: 'Text style' });
      await expect(bar).toBeVisible();
      await pinRandomText(window);
      await ignorePointer(window);
      await settle(window);
      await expect.soft(bar).toHaveScreenshot(`text-style-bar${suffix}.png`, SHOT);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}

for (const { theme, suffix } of [
  { theme: 'light', suffix: '' },
  { theme: 'dark', suffix: '-dark' },
] as const) {
  test(`Ask Claude about a selection: the popover beside it, then the answer with a suggested edit as a ghost, ${theme}`, async () => {
    needsBaselines(`ask-claude-popover${suffix}`, `ask-claude-answer${suffix}`);
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
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await pinNow(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Checkout review');
      await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      const [architect] = await agents(window);
      const [zone] = await zones(window);
      await window.evaluate(
        async ({ zoneId, sessionId }) => {
          const board = globalThis.window.agentBoard;
          const shape = (kind: string, text: string, x: number, y: number) =>
            board.items.create({
              kind: 'shape',
              zoneId,
              x,
              y,
              width: 120,
              height: 70,
              data: { shape: kind, fill: null, stroke: '#2b2a27', strokeWidth: 2, dashed: false, text, textSize: 'body', bold: false, textColor: '#2b2a27' },
            });
          const gateway = await shape('rounded', 'API gateway', 30, 80);
          const orders = await shape('service', 'Orders service', 210, 80);
          const postgres = await shape('database', 'Postgres', 390, 70);
          for (const [from, to] of [
            [gateway, orders],
            [orders, postgres],
          ] as const) {
            await board.connectors.create({ from: { type: 'item', id: from.id, side: 'right' }, to: { type: 'item', id: to.id, side: 'left' } });
          }
          await board.agents.move(sessionId, { zoneId, x: 560, y: 330 });
          const answer = await board.items.create({
            kind: 'agent-note',
            zoneId,
            x: 560,
            y: 40,
            width: 272,
            height: 230,
            data: {
              text: '**1 risk, 1 gap**\n\n1. Orders writes Postgres, then the queue: one can fail. Use an *outbox*.\n2. Gap: who reads `order-events`?',
              agent: { sessionId, name: 'Checkout review', harness: 'claude', role: 'architect' },
              // A time of its own, in the render's UTC, so the shot doesn't change with the clock.
              writtenAt: '2026-10-15T14:02:00.000Z',
              editedByUser: false,
              asked: "What's risky here?",
              suggestions: [
                {
                  id: '1',
                  title: 'Outbox',
                  shapes: [{ key: 's1', shape: 'database', text: 'outbox', x: 0, y: 0, width: 90, height: 70 }],
                  arrows: [{ from: { object: { type: 'item', id: orders.id } }, to: { shape: 's1' }, label: '' }],
                },
              ],
            },
          });
          // Joined to the selection's rightmost object, as the daemon joins an answer.
          await board.connectors.create({ from: { type: 'item', id: postgres.id, side: 'right' }, to: { type: 'item', id: answer.id, side: 'left' } });
          // The ghost goes under the orders service, on the board.
          const placed = (await board.zones.list()).find((each) => each.id === zoneId)!;
          const [note] = (await board.items.list()).filter((item) => item.kind === 'agent-note');
          const data = note!.data as { suggestions: { shapes: { x: number; y: number }[] }[] };
          data.suggestions[0]!.shapes[0]!.x = placed.x + 225;
          data.suggestions[0]!.shapes[0]!.y = placed.y + 230;
          await board.items.update({ id: note!.id, data });
        },
        { zoneId: zone!.id, sessionId: architect!.sessionId },
      );
      await expect(window.getByTestId('suggestion-ghost')).toHaveCount(1);
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`ask-claude-answer${suffix}.png`, SHOT);
      await restorePointer();

      // The three shapes selected, and the popover open from the button beside their label (CM).
      const shapes = window.getByTestId('shape');
      await shapes.nth(0).click();
      await shapes.nth(1).click({ modifiers: ['Shift'] });
      await shapes.nth(2).click({ modifiers: ['Shift'] });
      await window.getByRole('button', { name: /Ask Claude…/ }).click();
      await expect(window.getByRole('dialog', { name: 'Ask Claude' })).toBeVisible();
      const restoreAgain = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`ask-claude-popover${suffix}.png`, SHOT);
      await restoreAgain();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`agent notes beside a sticky, tethered to their agent: the document card, then the terminal card, ${theme}`, async () => {
    needsBaselines(`agent-notes${suffix}`, `agent-notes-terminal${suffix}`);
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
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await pinNow(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Master Orchestrator');
      await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      const [lead] = await agents(window);
      const [zone] = await zones(window);
      await window.evaluate(
        async ({ zoneId, sessionId, below }) => {
          const board = globalThis.window.agentBoard;
          const agent = { sessionId, name: 'Master Orchestrator', harness: 'claude', role: 'orchestrator' };
          // A time of its own, in the render's UTC, so the shot doesn't change with the clock.
          const writtenAt = '2026-10-15T14:02:00.000Z';
          await board.agents.move(sessionId, { zoneId, x: 330, y: 330 });
          await board.items.create({ kind: 'sticky', zoneId, x: 30, y: 40, width: 200, height: 170, data: { text: 'ask reviewer to check the flaky retry test before merge!', color: '#fff3a3' } });
          await board.items.create({
            kind: 'agent-note',
            zoneId,
            x: 270,
            y: 40,
            width: 272,
            height: 200,
            data: { text: '**ENG-199 · round 2 of 3**\n\n- Implementer: fixing findings, `2 of 3` done\n- Reviewer: idle until `R2` arrives\n- Then the gate, and I merge **#185**', agent, about: sessionId, writtenAt, editedByUser: true },
          });
          await board.items.create({
            kind: 'agent-note',
            zoneId,
            x: 580,
            y: 40,
            width: 272,
            // Made too short for its text: it grows to show it all.
            height: 120,
            data: {
              text: '**3 risks, 1 gap**\n\n1. Orders writes Postgres, then the queue: use an *outbox*.\n2. Cache tokens at the gateway.\n3. Retries on the payment call are not idempotent.\n\n**Gap:** no load test for the checkout path.',
              agent,
              writtenAt,
              editedByUser: false,
              asked: "What's risky here?",
            },
          });
          // A zone in Yellow, the colour that read worst under the tab's text, and a note outside every zone: both
          // tab tints, beside the first zone's.
          const yellow = await board.zones.addUnbound({ name: 'Docs', color: '#fcc419', x: below.x, y: below.y, width: 560, height: 160 });
          const short = { text: '**Docs pass** is waiting on the API names.', agent, writtenAt, editedByUser: false };
          await board.items.create({ kind: 'agent-note', zoneId: yellow.id, x: 30, y: 20, width: 272, height: 100, data: short });
          await board.items.create({ kind: 'agent-note', zoneId: null, x: below.x + 600, y: below.y + 20, width: 272, height: 100, data: short });
        },
        { zoneId: zone!.id, sessionId: lead!.sessionId, below: { x: zone!.x, y: zone!.y + zone!.height + 56 } },
      );
      await expect(window.getByTestId('agent-note')).toHaveCount(4);
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`agent-notes${suffix}.png`, SHOT);
      await restorePointer();

      // The terminal card, every note at once, picked in the Settings window.
      const settings = await openSettings(window, 'board.notes');
      await settingsSection(settings, 'Agent notes').getByRole('button', { name: 'Terminal' }).click();
      // A click on bare board leaves nothing selected, as in the document card's shot.
      await window.mouse.click(VIEWPORT.width - 120, VIEWPORT.height / 2);
      await expect(window.getByTestId('agent-note').first()).toHaveAttribute('data-look', 'terminal');
      const restoreAgain = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`agent-notes-terminal${suffix}.png`, SHOT);
      await restoreAgain();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`agent notes in the Simplified design: under a tab, one with no author, beside a sticky and a waiting tile, one with long markdown, ${theme}`, async () => {
    needsBaselines(`simplified-agent-notes${suffix}`);
    await shootSimplifiedNotes(theme, theme, `simplified-agent-notes${suffix}`);
  });

  test(`a question asked on the board: its card beside the asking agent's tile, its tail at the tile, ${theme}`, async () => {
    needsBaselines(`question-card${suffix}`);
    const { dir, repo, env } = scratch('ask-plan');
    const dataDir = tempDataDir();
    const { app, window } = await launch(
      dataDir,
      { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: theme, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
      RENDER_ARGS,
    );
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Ask on the board: Which database should I use for the job cache? | SQLite | Postgres');
      await expect(window.getByTestId('question-card')).toBeVisible({ timeout: TURN_MS });
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`question-card${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`a plan shown on the board: its card beside the waiting agent, and Review plan's decision beside it, ${theme}`, async () => {
    needsBaselines(`plan-card${suffix}`, `plan-card-review${suffix}`);
    const { dir, repo, env } = scratch('ask-plan');
    const dataDir = tempDataDir();
    const { app, window } = await launch(
      dataDir,
      { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: theme, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
      RENDER_ARGS,
    );
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Plan doc on the board: docs/migration.md');
      const card = window.getByTestId('plan-card');
      await expect(card.getByTestId('plan-card-stamp')).toHaveText('waiting on you', { timeout: TURN_MS });
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      await pinRandomText(window);
      let restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`plan-card${suffix}.png`, SHOT);
      await restorePointer();

      await card.getByTestId('plan-card-review-button').click();
      await expect(window.getByTestId('plan-card-review')).toBeVisible();
      restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('body')).toHaveScreenshot(`plan-card-review${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`a document an agent shows: its card beside the tile, open and as a slim bar, and its Document tab, read and in Edit, ${theme}`, async () => {
    needsBaselines(`doc-card${suffix}`, `doc-card-bar${suffix}`, `doc-tab${suffix}`, `doc-tab-edit${suffix}`);
    const { dir, repo, env } = scratch('ask-plan');
    const dataDir = tempDataDir();
    const { app, window } = await launch(
      dataDir,
      { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: theme, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
      RENDER_ARGS,
    );
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Doc on the board: docs/release-plan.md');
      const card = window.getByTestId('doc-card');
      await expect(card.getByTestId('doc-card-preview')).toContainText('Merge the flake fix first', { timeout: TURN_MS });
      await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      await pinRandomText(window);
      let restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`doc-card${suffix}.png`, SHOT);
      await restorePointer();

      await card.click();
      await window.getByRole('button', { name: 'Collapse to a bar' }).click();
      await expect(card).toHaveAttribute('data-collapsed', 'true');
      // Nothing selected: a click on bare board below the zone.
      await window.mouse.click(VIEWPORT.width / 2, VIEWPORT.height - 90);
      restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`doc-card-bar${suffix}.png`, SHOT);
      await restorePointer();

      await card.dispatchEvent('dblclick');
      const doc = window.getByTestId('session-window').getByTestId('document-view');
      await expect(doc.getByTestId('doc-body')).toContainText('Merge the flake fix first');
      await pinRandomText(window);
      // Its line under the title names a time and a temporary folder.
      const meta = { ...SHOT, mask: [doc.getByTestId('doc-meta')] };
      restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('body')).toHaveScreenshot(`doc-tab${suffix}.png`, meta);
      await restorePointer();

      await doc.getByRole('button', { name: 'Edit' }).click();
      await doc.getByLabel('Markdown of Release 1.4 plan').fill('# Release 1.4 plan\n\n## Order\nHold the pin bump to 1.5, then merge the flake fix.\n');
      await doc.getByLabel('Markdown of Release 1.4 plan').evaluate((field) => (field as HTMLTextAreaElement).blur());
      restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('body')).toHaveScreenshot(`doc-tab-edit${suffix}.png`, meta);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`a document card dragged taller by its corner shows more of its page, ${theme}`, async () => {
    needsBaselines(`doc-card-resized${suffix}`);
    const { dir, repo, env } = scratch('ask-plan');
    const dataDir = tempDataDir();
    const { app, window } = await launch(
      dataDir,
      { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: theme, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
      RENDER_ARGS,
    );
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Doc on the board: docs/long-plan.md');
      const card = window.getByTestId('doc-card');
      const preview = card.getByTestId('doc-card-preview');
      await expect(preview).toContainText('Step 14', { timeout: TURN_MS });
      await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      await window.getByRole('button', { name: /^Fit view/ }).click();
      await viewSettled(window);
      const shownLines = () =>
        preview.evaluate((body) => {
          const end = body.getBoundingClientRect().bottom;
          return [...body.querySelectorAll('li')].filter((line) => line.getBoundingClientRect().bottom <= end).length;
        });
      const before = await shownLines();

      await card.click();
      const corner = centreOf(await settledBox(window.locator('.react-flow__resize-control.handle.bottom.right')));
      await drag(window, corner, { x: corner.x + 60, y: corner.y + 90 });
      await expect.poll(shownLines).toBeGreaterThan(before);
      // Nothing selected: a click on bare board below the zone.
      await window.mouse.click(VIEWPORT.width / 2, VIEWPORT.height - 40);
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`doc-card-resized${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
