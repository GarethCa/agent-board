import { expect, type Page } from '@playwright/test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { agents, launch, listFinishedTurns, spawnAgent, tile, TURN_MS, zones } from '../agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone, type LaunchOptions } from '../launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, pinNow, pinRandomText, settle } from '../render.ts';
import { scratch } from '../scratch.ts';
import { untilStill, viewTransform } from '../board-helpers.ts';

// Visual regression for the Workbench theme, in one spec file per surface so Playwright runs them on several workers.
// Baselines are per platform (`-linux`, `-darwin`) and both are committed, in `e2e/visual.spec.ts-snapshots/` (the
// `visual` project's snapshotPathTemplate keeps them there, so a split moves no shot); a test runs against the ones for
// the platform it is on, and fails, never skips, if they are missing. `pnpm visual:update` regenerates this machine's;
// `pnpm visual:check` compares them. The baselines are for macOS.

/** Tight: a recoloured PR chip is a few hundred pixels. Shots are stable to the pixel run to run. */
export const SHOT = { maxDiffPixels: 100, animations: 'disabled' as const, caret: 'hide' as const };

const SNAPSHOTS = join(import.meta.dirname, '..', 'visual.spec.ts-snapshots');

/** Fails the test, saying how to fix it, if any of its `shots` has no baseline for this platform, unless baselines are being written. */
export function needsBaselines(...shots: string[]) {
  const { updateSnapshots } = test.info().config;
  if (updateSnapshots === 'all' || updateSnapshots === 'changed') return;
  const missing = shots.filter((shot) => !existsSync(join(SNAPSHOTS, `${shot}-visual-${process.platform}.png`)));
  expect(missing, `no ${process.platform} baseline for these shots: run \`pnpm visual:update\`, look at each PNG, and commit them`).toEqual([]);
}

/** Waits until the board's view stops moving: after a fit or a jump, which animate. */
export const viewSettled = (window: Page): Promise<void> => untilStill(() => viewTransform(window));

/** Waits until every node on the board (tiles, zones, notes) holds its place and size: after an arrange or a zone growing round its crew. */
export const nodesStill = (window: Page): Promise<void> =>
  untilStill(
    () =>
      window.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => `${node.dataset.id} ${node.style.transform} ${node.offsetWidth}x${node.offsetHeight}`).join('|'),
      ),
    { timeout: 4 * TURN_MS },
  );

/**
 * The theme packs shot, a few standing for all of them (tokens.test.ts holds every pack to the same rules): a dark one,
 * a warm light one and the colour-blind-safe one.
 */
export const PACK_SHOTS = [
  { theme: 'catppuccin-mocha', scheme: 'dark' },
  { theme: 'gruvbox-light', scheme: 'light' },
  { theme: 'clear-sight-light', scheme: 'light' },
] as const;

/**
 * Times that differ run to run, pinned: those the chat counts or reads from the transcript to `4.1s`, how long a
 * held permission prompt has left to `20 s`, and the session id of an agent a message names.
 */
export async function pinChatTimes(page: Page) {
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      node.data = node.data.replace(/\bwithin \d+ s\b/, 'within 20 s');
      // The fake agent echoes a sender mark, whose ref is the sender's session id: in the chat, and in the sidebar's last message.
      node.data = node.data.replace(/\bagent:[0-9a-f]{8}\b/g, 'agent:00000000');
      if (node.parentElement?.closest('.chat-frame') == null) continue;
      node.data = node.data.replace(/\b(?:\d+h )?(?:\d+m )?\d+(?:\.\d)?s\b/g, '4.1s');
    }
    // The clock times down the side of the Simplified design's Timeline rail: each turn's first, as a run that crosses a
    // minute shows another (the time column keeps its width without them).
    for (const turn of document.querySelectorAll('[data-testid="timeline-turn"]')) {
      turn.querySelectorAll('[data-testid="timeline-time"]').forEach((time, index) => (time.textContent = index === 0 ? '9:14' : ''));
    }
  });
}

/** Each theme the galleries are shot in: the light one under the original names, the dark one with `-dark`. */
export const THEMES = [
  { theme: 'light', suffix: '' },
  { theme: 'dark', suffix: '-dark' },
] as const;

/** Launches on the gallery (`#gallery`, or the page `hash`) in `theme`, a theme of `scheme`'s mode, and in `options`' design. */
export async function launchGallery(dataDir: string, theme: string, scheme: 'light' | 'dark' = theme === 'dark' ? 'dark' : 'light', options: LaunchOptions = {}, hash = '#gallery') {
  const launched = await launch(dataDir, { ...RENDER_ENV, AGENT_BOARD_APPEARANCE: theme }, RENDER_ARGS, options);
  await listFinishedTurns(launched.window);
  const { window } = launched;
  await window.setViewportSize(VIEWPORT);
  // Playwright pins the page to light; the setting has the window in its mode, as macOS would.
  await window.emulateMedia({ colorScheme: scheme });
  await window.evaluate((page) => {
    location.hash = page;
    location.reload();
  }, hash);
  await expect(window.locator('html')).toHaveAttribute('data-theme', theme);
  return launched;
}

/** The Simplified design's agent notes: under a tab, one with no author, beside a sticky and a waiting agent tile, one with long markdown. */
export async function shootSimplifiedNotes(appearanceTheme: string, scheme: 'light' | 'dark', shot: string) {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(
    dataDir,
    { ...env, ...RENDER_ENV, AGENT_BOARD_APPEARANCE: appearanceTheme, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' },
    RENDER_ARGS,
    { design: 'simplified' },
  );
  await listFinishedTurns(window);
  try {
    await window.setViewportSize(VIEWPORT);
    await window.emulateMedia({ colorScheme: scheme });
    await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
    await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(appearanceTheme);
    await pinFonts(window);
    await pinNow(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Master Orchestrator');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    const [lead] = await agents(window);
    const [zone] = await zones(window);
    await window.evaluate(
      async ({ zoneId, sessionId }) => {
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
          height: 200,
          // Sized by the user, shorter than its text: it scrolls inside the card and says there is more.
          data: {
            text: '**3 risks, 1 gap**\n\n1. Orders writes Postgres, then the queue: use an *outbox*.\n2. Cache tokens at the gateway.\n3. Retries on the payment call are not idempotent.\n4. Sessions are never revoked.\n5. Logs carry the card number.\n\n**Gap:** no load test for the checkout path.',
            agent,
            writtenAt,
            editedByUser: false,
            asked: "What's risky here?",
            userSized: true,
          },
        });
        // No known author: its tab reads just Note.
        await board.items.create({
          kind: 'agent-note',
          zoneId,
          x: 30,
          y: 240,
          width: 200,
          height: 100,
          data: { text: 'Nobody signed this one.', agent: { sessionId: '', name: '', harness: 'claude', role: null }, writtenAt, editedByUser: false },
        });
      },
      { zoneId: zone!.id, sessionId: lead!.sessionId },
    );
    await expect(window.getByTestId('agent-note')).toHaveCount(3);
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    await pinRandomText(window);
    const restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot(`${shot}.png`, SHOT);
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
}
