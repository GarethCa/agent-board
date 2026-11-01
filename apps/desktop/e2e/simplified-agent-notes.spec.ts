import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, spawnAgent, tile, TURN_MS, zones } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings } from './settings-helpers.ts';

// A note an agent writes under the Simplified design is a white card with a byline, "by ‹agent›", that flies to its
// agent. A sticky is not touched, and Classic's Agent notes setting is not drawn.

const LONG = Array.from({ length: 30 }, (_, row) => `- item ${row + 1} of a long list the card must scroll or grow for`).join('\n');

test("an agent note is a card whose byline flies to its agent, long markdown stays inside it, and Classic's note look is not offered", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env, [], { design: 'simplified' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Run the crew');
    const lead = tile(window).filter({ hasText: 'Run the crew' });
    await expect(lead).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    const [agent] = await agents(window);
    const [zone] = await zones(window);
    await window.evaluate(
      async ({ zoneId, sessionId, name, long }) => {
        const board = globalThis.window.agentBoard;
        const writtenAt = new Date().toISOString();
        await board.agents.move(sessionId, { zoneId, x: 20, y: 300 });
        await board.items.create({ kind: 'sticky', zoneId, x: 20, y: 40, width: 200, height: 160, data: { text: 'mine', color: '#fff3a3' } });
        const about = { agent: { sessionId, name, harness: 'claude', role: null }, writtenAt, editedByUser: false };
        await board.items.create({ kind: 'agent-note', zoneId, x: 300, y: 40, width: 240, height: 150, data: { ...about, text: '**Round 2 of 3**\n\n- reviewer: idle' } });
        await board.items.create({ kind: 'agent-note', zoneId, x: 600, y: 40, width: 240, height: 150, data: { ...about, text: `**Long**\n\n${long}`, userSized: true } });
      },
      { zoneId: zone!.id, sessionId: agent!.sessionId, name: agent!.name, long: LONG },
    );
    const notes = window.getByTestId('agent-note');
    await expect(notes).toHaveCount(2);
    const note = notes.first();

    // A card, not a tab under a dashed edge, and the agent is named in a byline.
    await expect(note).toHaveAttribute('data-look', 'document');
    await expect(note.locator('.agent-note-tab')).toHaveCount(0);
    await expect(note.locator('.agent-note-card')).toHaveCSS('border-top-style', 'none');
    await expect(note.locator('.agent-note-byline')).toContainText(`by ${agent!.name}`);
    await expect(note.locator('strong')).toHaveText('Round 2 of 3');
    // A sticky stays a sticky, drawn exactly as Classic draws it.
    const sticky = window.getByTestId('sticky');
    await expect(sticky).toHaveCount(1);
    await expect(sticky.locator('.agent-note-byline, .agent-note-card')).toHaveCount(0);
    const stickyLook = () =>
      sticky.evaluate((element) =>
        [element, ...element.querySelectorAll('*')].map((node) => {
          const style = getComputedStyle(node);
          return [style.backgroundColor, style.color, style.border, style.borderRadius, style.boxShadow, style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, style.padding].join('|');
        }),
      );
    const simplifiedSticky = await stickyLook();
    await window.evaluate(() => globalThis.window.agentBoard.design.set('classic'));
    await expect.poll(() => window.evaluate(() => document.documentElement.dataset.design ?? null)).toBeNull();
    expect(await stickyLook()).toEqual(simplifiedSticky);
    await window.evaluate(() => globalThis.window.agentBoard.design.set('simplified'));
    await expect.poll(() => window.evaluate(() => document.documentElement.dataset.design ?? null)).toBe('simplified');

    // A long note scrolls inside its card, which does not grow past its box.
    const long = notes.nth(1);
    const body = long.locator('.agent-note-body');
    await expect.poll(() => body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    const card = (await long.locator('.agent-note-card').boundingBox())!;
    const foot = (await long.locator('.agent-note-foot').boundingBox())!;
    expect(foot.y + foot.height).toBeLessThanOrEqual(card.y + card.height + 1);

    // The byline flies to its agent: the board is panned away from it first, and the click brings its tile into view and selects it.
    const inView = async () => {
      const box = await lead.boundingBox();
      const view = window.viewportSize()!;
      return box !== null && box.x >= 0 && box.y >= 0 && box.x + box.width <= view.width && box.y + box.height <= view.height;
    };
    // A window too short for its tile, with the notes above it still in view.
    await window.setViewportSize({ width: 1280, height: 520 });
    await expect.poll(inView).toBe(false);
    await note.getByRole('button', { name: agent!.name }).click();
    await expect(lead.locator('xpath=ancestor::*[contains(@class, "react-flow__node")][1]')).toHaveClass(/selected/);
    await expect.poll(inView).toBe(true);

    // Classic's Agent notes setting is not drawn, and a saved terminal look does not show.
    await window.evaluate(() => globalThis.window.agentBoard.view.set('agentNoteLook', 'terminal'));
    await expect(note).toHaveAttribute('data-look', 'document');
    await expect(note.locator('strong')).toHaveText('Round 2 of 3');
    await expect(note.locator('.agent-note-line')).toHaveCount(0);
    const settings = await openSettings(window, 'board');
    await expect(settings.getByRole('region', { name: 'Agent notes', exact: true })).toHaveCount(0);
    await expect(settings.getByRole('region', { name: 'Tidying', exact: true })).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
