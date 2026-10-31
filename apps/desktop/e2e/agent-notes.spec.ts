import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agentNoteSize } from '@agent-board/daemon/agent-notes';
import { MAX_AGENT_NOTE_HEIGHT, type BoardItem } from '@agent-board/daemon/protocol';
import { agents, launch, spawnAgent, tile, tileAction, TURN_MS, zones } from './agent-helpers.ts';
import { withDaemon } from './board-helpers.ts';
import { test, connectedDaemonPid, launchApp, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings, settingsSection } from './settings-helpers.ts';

/** Picks how agent notes look, in the Settings window's Board › Agent notes. */
async function agentNotesLook(window: Page, look: 'Document' | 'Terminal'): Promise<void> {
  const settings = await openSettings(window, 'board.notes');
  const choice = settingsSection(settings, 'Agent notes').getByRole('group', { name: 'Agent notes' }).getByRole('button', { name: look });
  await choice.click();
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
}

test("an agent note: its badge selects its agent's tile, a tether leads there, the user's edit says so, and the look switches live", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Run the crew');
    const lead = tile(window).filter({ hasText: 'Run the crew' });
    await expect(lead).toHaveAttribute('data-state', 'waiting');
    const [agent] = await agents(window);
    const [zone] = await zones(window);
    await window.evaluate(
      async ({ zoneId, sessionId, name }) => {
        const board = globalThis.window.agentBoard;
        await board.agents.move(sessionId, { zoneId, x: 20, y: 300 });
        await board.items.create({ kind: 'sticky', zoneId, x: 20, y: 40, width: 200, height: 160, data: { text: 'mine', color: '#fff3a3' } });
        await board.items.create({
          kind: 'agent-note',
          zoneId,
          x: 300,
          y: 40,
          width: 200,
          height: 150,
          data: {
            text: '**Round 2 of 3**\n\n- implementer: `2 of 3` done\n- reviewer: idle',
            agent: { sessionId, name, harness: 'claude', role: 'orchestrator of the long-running crew' },
            about: sessionId,
            writtenAt: new Date().toISOString(),
            editedByUser: false,
          },
        });
      },
      { zoneId: zone!.id, sessionId: agent!.sessionId, name: agent!.name },
    );
    const note = window.getByTestId('agent-note');
    await expect(note).toHaveAttribute('data-look', 'document');
    // Its tab and edge are tints of the colour of the zone it sits in.
    await expect(note).toHaveCSS('--agent-note-zone', zone!.color);
    // The tab itself is painted from it; out of every zone it is neutral, and in another zone it takes that zone's colour.
    const tabPaint = () => note.locator('.agent-note-tab').evaluate((element) => getComputedStyle(element).backgroundColor);
    const inZone = await tabPaint();
    const noteId = await window.evaluate(async () => (await globalThis.window.agentBoard.items.list()).find((item) => item.kind === 'agent-note')!.id);
    await window.evaluate((id) => globalThis.window.agentBoard.items.update({ id, zoneId: null, x: 900, y: 400 }), noteId);
    await expect(note).toHaveAttribute('data-zone', '');
    await expect.poll(() => note.evaluate((element) => element.style.getPropertyValue('--agent-note-zone'))).toBe('');
    await expect.poll(tabPaint).not.toBe(inZone);
    const loose = await tabPaint();
    const other = await window.evaluate(async ({ avoid, at }) => {
      const { zones } = globalThis.window.agentBoard;
      const colour = ['#e64980', '#fcc419', '#40c057'].find((candidate) => candidate !== avoid)!;
      const made = await zones.addUnbound({ name: 'Elsewhere', color: colour, x: at.x, y: at.y, width: 280, height: 300 });
      return { id: made.id, colour };
    }, { avoid: zone!.color, at: { x: zone!.x + zone!.width + 20, y: zone!.y } });
    await window.evaluate(({ id, zoneId }) => globalThis.window.agentBoard.items.update({ id, zoneId, x: 20, y: 40 }), { id: noteId, zoneId: other.id });
    await expect(note).toHaveCSS('--agent-note-zone', other.colour);
    await expect.poll(tabPaint).not.toBe(loose);
    await expect.poll(tabPaint).not.toBe(inZone);
    // A sticky the user made stays a sticky.
    await expect(window.getByTestId('sticky')).toHaveCount(1);
    await expect(note.locator('strong')).toHaveText('Round 2 of 3');
    await expect(note.locator('code')).toHaveText('2 of 3');
    await expect(window.getByTestId('agent-note-tether')).toHaveCount(1);
    await expect(note).not.toContainText('edited by you');
    // Even at the least width, with a long role, the tab clips its own text and never passes the note.
    const tab = note.locator('.agent-note-tab');
    expect(await tab.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect((await tab.boundingBox())!.width).toBeLessThanOrEqual((await note.boundingBox())!.width);

    // The badge selects its agent's tile.
    await note.getByRole('button', { name: new RegExp(agent!.name) }).click();
    await expect(lead.locator('xpath=ancestor::*[contains(@class, "react-flow__node")][1]')).toHaveClass(/selected/);

    // The user's edit says so.
    await note.dblclick();
    const editor = note.getByRole('textbox', { name: 'Note text' });
    await editor.fill('Waiting on the gate');
    await editor.press('Escape');
    await expect(note).toContainText('✎ edited by you');
    // The time stays whole in the narrow footer; the other text gives way.
    const time = note.locator('.agent-note-time');
    expect(await time.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    // Whole, and inside the card: a clipped time would run past the card's right edge.
    const timeBox = (await time.boundingBox())!;
    const cardBox = (await note.locator('.agent-note-card').boundingBox())!;
    expect(timeBox.x + timeBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
    expect(timeBox.width).toBeGreaterThan(30);
    await expect
      .poll(async () => (await window.evaluate(() => globalThis.window.agentBoard.items.list())).find((item) => item.kind === 'agent-note')?.data)
      .toMatchObject({ text: 'Waiting on the gate', editedByUser: true });

    // Every agent note switches look at once, and the setting is kept.
    await agentNotesLook(window, 'Terminal');
    await expect(note).toHaveAttribute('data-look', 'terminal');
    expect(await window.evaluate(() => globalThis.window.agentBoard.view.get('agentNoteLook'))).toBe('terminal');
    await agentNotesLook(window, 'Document');
    await expect(note).toHaveAttribute('data-look', 'document');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent note's tether goes round the tiles in its way: a reviewer a tile gap from the note, and an expanded tile", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    for (const prompt of ['Run the crew', 'Fix checkout flake', 'Review the fix']) await spawnAgent(window, 'monorepo', prompt);
    await expect(tile(window)).toHaveCount(3);
    for (const at of [0, 1, 2]) await expect(tile(window).nth(at)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    const [lead, fixer, reviewer] = await agents(window);
    const [zone] = await zones(window);
    // The lead's tile above, expanded; under it a lane as an arrange lays one out: the implementer, its reviewer two
    // slots on, and the lead's note on the implementer in the slot past the reviewer, a tile gap from it. Its straight
    // tether runs across the reviewer. A second note, left of the lead, on the reviewer: its straight tether runs
    // across the expanded tile.
    const [past, left] = await window.evaluate(
      async ({ zoneId, lead, fixer, reviewer }) => {
        const board = globalThis.window.agentBoard;
        await board.agents.move(lead.sessionId, { zoneId, x: 300, y: 40 });
        await board.agents.move(fixer, { zoneId, x: 20, y: 900 });
        await board.agents.move(reviewer, { zoneId, x: 564, y: 900 });
        const note = (x: number, y: number, about: string) =>
          board.items.create({
            kind: 'agent-note',
            zoneId,
            x,
            y,
            width: 256,
            height: 200,
            data: {
              text: '**Round 2 of 3**\n\n- implementer: `2 of 3` done\n- reviewer: changes requested',
              agent: { sessionId: lead.sessionId, name: lead.name, harness: 'claude', role: 'orchestrator' },
              about,
              writtenAt: '2026-01-01T00:00:00.000Z',
              editedByUser: false,
            },
          });
        return [(await note(836, 900, fixer)).id, (await note(20, 40, reviewer)).id];
      },
      { zoneId: zone!.id, lead: { sessionId: lead!.sessionId, name: lead!.name }, fixer: fixer!.sessionId, reviewer: reviewer!.sessionId },
    );
    const tetherOf = (noteId: string) => window.locator(`.react-flow__edge[data-id="tether:item:${noteId}"]`).getByTestId('agent-note-tether');
    // The board draws only what is in view.
    const fitView = () => window.getByRole('button', { name: /^Fit view/ }).click();
    await fitView();
    await expect(window.getByTestId('agent-note-tether')).toHaveCount(2);
    await expect(tetherOf(past!)).toHaveAttribute('data-routed', 'true');
    // Round the reviewer's box, not through it: every point along it, on the screen, outside the tile's, both read
    // at once, so a view still easing to fit moves them together.
    const throughReviewer = await tetherOf(past!).evaluate((element) => {
      const path = element as SVGPathElement;
      const reviewer = [...document.querySelectorAll("[data-testid='agent-tile']")].find((tile) => tile.textContent.includes('Review the fix'))!;
      const box = reviewer.getBoundingClientRect();
      const toScreen = path.getScreenCTM()!;
      const length = path.getTotalLength();
      return Array.from({ length: 101 }, (_, step) => path.getPointAtLength((length * step) / 100))
        .map(({ x, y }) => new DOMPoint(x, y).matrixTransform(toScreen))
        .filter(({ x, y }) => x > box.left && x < box.right && y > box.top && y < box.bottom).length;
    });
    expect(throughReviewer).toBe(0);
    // The lead's tile is clear of the second note's line until it expands into it.
    await expect(tetherOf(left!)).not.toHaveAttribute('data-routed');

    await tileAction(tile(window).filter({ hasText: 'Run the crew' }), 'Expand in place');
    await expect(window.getByTestId('expanded-tile')).toBeVisible();
    await fitView();
    await expect(tetherOf(left!)).toHaveAttribute('data-routed', 'true');
    await expect(tetherOf(past!)).toHaveAttribute('data-routed', 'true');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Makes an agent note in the daemon serving `dataDir`, off any zone, `width` by `height` at (`x`, `y`). */
function makeNote(dataDir: string, text: string, { x, y = 40, width = 272, height }: { x: number; y?: number; width?: number; height: number }): Promise<BoardItem> {
  return withDaemon(dataDir, (client) =>
    client.call('item.create', {
      kind: 'agent-note',
      zoneId: null,
      x,
      y,
      width,
      height,
      data: { text, agent: { sessionId: '', name: 'lead', harness: 'claude', role: 'orchestrator' }, writtenAt: new Date().toISOString(), editedByUser: false },
    }),
  );
}

test('an agent note grows to show all its text, not as a step of the user’s, up to a limit, then scrolls', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const stored = () => withDaemon(dataDir, (client) => client.call('item.list'));
    const find = async (id: string) => (await stored()).find((item) => item.id === id);
    const notes = window.getByTestId('agent-note');

    // The user's own step: a note's text edited.
    const mine = await makeNote(dataDir, 'Hello', { x: 40, height: 120 });
    await expect(notes).toHaveCount(1);
    await notes.first().dblclick();
    const editor = notes.first().getByRole('textbox', { name: 'Note text' });
    await editor.fill('Hello there');
    await editor.press('Escape');
    await expect.poll(async () => (await find(mine.id))?.data.text).toBe('Hello there');

    // A note that arrives too short for its ten lines grows until they all show.
    const tenLines = Array.from({ length: 10 }, (_, index) => `- **step ${index + 1}**: the review of \`fit.ts\` is done, the gate is next`).join('\n');
    const short = await makeNote(dataDir, tenLines, { x: 360, height: 120 });
    await expect.poll(async () => (await find(short.id))?.height).toBeGreaterThan(200);
    const body = notes.nth(1).locator('.agent-note-body');
    await expect.poll(() => body.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    const grown = (await find(short.id))!.height;

    // One undo takes the user's edit back: the board's growth is no step in the way, and stays.
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await find(mine.id))?.data.text).toBe('Hello');
    expect((await find(short.id))!.height).toBe(grown);

    // Past the most it grows to, it scrolls.
    const long = await makeNote(dataDir, 'word '.repeat(600), { x: 680, height: 120 });
    await expect.poll(async () => (await find(long.id))?.height).toBe(MAX_AGENT_NOTE_HEIGHT);
    expect(await notes.nth(2).locator('.agent-note-body').evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

/** Texts of every kind the size the daemon gives a note is estimated for: each well under the most a note grows to. */
const ESTIMATED = [
  Array.from({ length: 5 }, (_, index) => `- **step ${index + 1}**: the review of \`fit.ts\` is done, the gate is next`).join('\n'),
  'SHIPPING CHECKLIST\n\n- MERGE GATE GREEN ON MAIN\n- RELEASE NOTES WRITTEN AND REVIEWED\n- TAG PUSHED, BUILD SIGNED',
  '- `apps/desktop/src/renderer/src/board/items/AgentNoteNode.tsx`\n- `packages/daemon/src/agent-notes.ts` and `board-arrange.ts`\n- run `pnpm exec vitest run test/agent-notes.test.ts`',
  'See https://github.com/example/agent-board/pull/289/files#diff-0123456789abcdef for the change, and [the review](https://example.com/review/round-1).',
  '评审第二轮：实现者正在修复问题\n- 审查者等待下一轮开始\n- 然后运行合并检查，再合并拉取请求',
  '🚀 Shipped the fix 🎉\n- ✅ tests pass on main\n- ⏳ waiting on the visual baselines 📸',
  '**ENG-199 · round 2 of 3**\n\n1. Implementer: fixing findings, `2 of 3` done\n2. Reviewer: idle until `R2` arrives\n\nThen the gate, and I merge **#185**',
  '- **impl-notes-fit**: fixing the review findings on the merge gate · PR #289 Agent notes grow to show all their text\n- **review-notes-fit**: waiting for round 2',
];

test('a note made at the size the daemon gives its text shows it all, with little to spare, in either look', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const made: { item: BoardItem; height: number }[] = [];
    for (const [index, text] of ESTIMATED.entries()) {
      // At a lane's width and a new note's, in turn.
      const width = index % 2 === 0 ? 256 : 272;
      const { height } = agentNoteSize(text, width, 0);
      expect(height, text).toBeLessThan(MAX_AGENT_NOTE_HEIGHT);
      made.push({ item: await makeNote(dataDir, text, { x: 20 + (index % 4) * 300, y: 20 + Math.floor(index / 4) * 340, width, height }), height });
    }
    const notes = window.getByTestId('agent-note');
    await expect(notes).toHaveCount(ESTIMATED.length);
    // How much room each note's text leaves, px, by its item's id: below 0 it would not fit.
    const spare = async () =>
      new Map(
        await notes.evaluateAll((elements) =>
          elements.map((element) => {
            const body = element.querySelector<HTMLElement>('.agent-note-body')!;
            const id = element.closest('.react-flow__node')!.getAttribute('data-id')!;
            // The height its text takes: the body sized to it a moment, as it fills the card's room otherwise.
            const room = body.clientHeight;
            body.style.flex = 'none';
            const needs = body.scrollHeight;
            body.style.flex = '';
            return [id.slice(id.indexOf(':') + 1), room - needs] as const;
          }),
        ),
      );
    const document = await spare();
    await agentNotesLook(window, 'Terminal');
    await expect(notes.first()).toHaveAttribute('data-look', 'terminal');
    const terminal = await spare();
    for (const { item, height } of made) {
      const [inDocument, inTerminal] = [document.get(item.id)!, terminal.get(item.id)!];
      // Never short in either look, and at most about two lines over in the look that needs more.
      expect(Math.min(inDocument, inTerminal), item.data.text as string).toBeGreaterThanOrEqual(0);
      expect(Math.min(inDocument, inTerminal), item.data.text as string).toBeLessThanOrEqual(30);
      // It needed no growing.
      expect((await withDaemon(dataDir, (client) => client.call('item.list'))).find((each) => each.id === item.id)!.height).toBe(height);
    }
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
