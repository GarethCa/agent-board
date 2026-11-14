import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agentNoteSize } from '@agent-board/daemon/agent-notes';
import { MAX_AGENT_NOTE_HEIGHT, type BoardItem } from '@agent-board/daemon/protocol';
import { agents, launch, spawnAgent, tile, tileAction, TURN_MS, zones } from './agent-helpers.ts';
import { emptyFoot, showTethers, withDaemon } from './board-helpers.ts';
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

test("an agent note: its face selects its agent's tile, a tether leads there, the user's edit says so, and the look switches live", async () => {
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
            // Five minutes on from when it is made: its agent wrote it again, so the footer says it was updated.
            writtenAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            editedByUser: false,
          },
        });
      },
      { zoneId: zone!.id, sessionId: agent!.sessionId, name: agent!.name },
    );
    const note = window.getByTestId('agent-note');
    await expect(note).toHaveAttribute('data-look', 'document');
    // Its agent wrote it again after it was made, until the user edits it.
    await expect(note.locator('.agent-note-foot')).toContainText('updated');
    // It speaks from its agent's face: the harness's mark, ringed in the harness's colour, named for the agent.
    const face = note.getByRole('button', { name: `Note by ${agent!.name}` });
    await expect(face).toHaveCount(1);
    await expect.poll(() => face.evaluate((element) => element.style.getPropertyValue('--agent-note-harness'))).toBe('var(--harness-claude)');
    // Its first line is who wrote it, their role and when; there is no tab above it.
    const head = note.locator('.agent-note-head');
    await expect(head.locator('.agent-note-name')).toHaveText(agent!.name);
    await expect(head.locator('.agent-note-role')).toContainText('orchestrator of the long-running crew');
    await expect(head.locator('.agent-note-time')).toHaveCount(1);
    await expect(note.locator('.agent-note-tab')).toHaveCount(0);
    // A sticky the user made stays a sticky.
    await expect(window.getByTestId('sticky')).toHaveCount(1);
    await expect(note.locator('strong')).toHaveText('Round 2 of 3');
    await expect(note.locator('code')).toHaveText('2 of 3');
    // Its tether is drawn only while View › Show Tethers is on, which it isn't by default.
    await expect(window.getByTestId('agent-note-tether')).toHaveCount(0);
    await showTethers(window);
    await expect(window.getByTestId('agent-note-tether')).toHaveCount(1);
    await expect(note).not.toContainText('edited by you');
    // Even at the least width, with a long role, the first line clips its own text and never passes the bubble.
    expect(await head.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const bubble = (await note.locator('.agent-note-bubble').boundingBox())!;
    const headBox = (await head.boundingBox())!;
    expect(headBox.x + headBox.width).toBeLessThanOrEqual(bubble.x + bubble.width + 0.5);

    // The face selects its agent's tile.
    await face.click();
    await expect(lead.locator('xpath=ancestor::*[contains(@class, "react-flow__node")][1]')).toHaveClass(/selected/);

    // The user's edit says so.
    await note.dblclick();
    const editor = note.getByRole('textbox', { name: 'Note text' });
    await editor.fill('Waiting on the gate');
    await editor.press('Escape');
    await expect(note).toContainText('✎ edited by you');
    // The time stays whole in the first line; the name and role give way.
    const time = note.locator('.agent-note-time');
    // The day with the time (five minutes ahead can be tomorrow, near midnight), and the full date on hover and as its accessible name.
    await expect(time).toHaveText(/ \d\d:\d\d$/);
    await expect(time).toHaveAttribute('title', /\d{4}, \d\d:\d\d$/);
    await expect(time).toHaveAttribute('aria-label', (await time.getAttribute('title'))!);
    expect(await time.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    // Whole, and inside the bubble: a clipped time would run past the bubble's right edge. The face's click moved the
    // view to the tile, so the bubble is measured again.
    const [timeBox, bubbleNow] = [(await time.boundingBox())!, (await note.locator('.agent-note-bubble').boundingBox())!];
    expect(timeBox.x + timeBox.width).toBeLessThanOrEqual(bubbleNow.x + bubbleNow.width);
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
    // The board draws only what is in view, and tethers only while View › Show Tethers is on.
    await showTethers(window);
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
function makeNote(
  dataDir: string,
  text: string,
  { x, y = 40, width = 272, height, lines }: { x: number; y?: number; width?: number; height: number; lines?: number },
): Promise<BoardItem> {
  return withDaemon(dataDir, (client) =>
    client.call('item.create', {
      kind: 'agent-note',
      zoneId: null,
      x,
      y,
      width,
      height,
      data: {
        text,
        agent: { sessionId: '', name: 'lead', harness: 'claude', role: 'orchestrator' },
        writtenAt: new Date().toISOString(),
        editedByUser: false,
        ...(lines === undefined ? {} : { lines }),
      },
    }),
  );
}

test('an agent note grows to show all its text, not as a step of the user’s, up to a limit, then scrolls; or to its line budget, the rest a click away', async () => {
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

    // A note given a line budget shows that many lines, its text fading into a chip that counts the rest. Made taller
    // than those lines, it comes down to them: no empty foot.
    const budgeted = await makeNote(dataDir, tenLines, { x: 1000, height: 400, lines: 3 });
    const kept = notes.nth(3);
    const chip = kept.getByTestId('agent-note-more');
    await expect(chip).toHaveText(/^↓ \d+ more lines$/);
    const keptBody = kept.locator('.agent-note-body');
    await expect.poll(async () => (await find(budgeted.id))?.height).toBeLessThan(400);
    await expect.poll(emptyFoot(keptBody)).toBeLessThanOrEqual(2);
    // Its text isn't cut short either.
    expect(await emptyFoot(keptBody)()).toBeGreaterThanOrEqual(-1);
    // Three lines and the body's own padding, and no more.
    const threeLines = await keptBody.evaluate((element) => {
      const style = getComputedStyle(element);
      return 3 * Number.parseFloat(style.lineHeight) + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    });
    expect(await keptBody.evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(Math.ceil(threeLines));
    expect((await find(budgeted.id))!.height).toBeLessThan(grown);
    // A click on the chip grows the note to all its text, and it is the user's size from then on.
    await chip.click();
    await expect(chip).toHaveCount(0);
    await expect.poll(async () => (await find(budgeted.id))?.data).toMatchObject({ userSized: true });
    expect((await find(budgeted.id))!.data.lines ?? null).toBeNull();
    await expect.poll(() => keptBody.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    // As tall as all its text, and no taller.
    expect(await emptyFoot(keptBody)()).toBeLessThanOrEqual(2);
    expect(await emptyFoot(keptBody)()).toBeGreaterThanOrEqual(-1);
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
