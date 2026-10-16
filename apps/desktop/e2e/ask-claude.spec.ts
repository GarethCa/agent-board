import { expect } from '@playwright/test';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { agents, launch, tile, zones } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

/** Three shapes and the two arrows between them, in reading order, each `width` wide: a diagram to ask about. */
const SHAPES = [
  { shape: 'rounded', text: 'API gateway', x: 20, y: 60 },
  { shape: 'service', text: 'Orders service', x: 200, y: 60 },
  { shape: 'database', text: 'Postgres', x: 380, y: 50 },
];
const SHAPE_SIZE = { width: 120, height: 70 };

test('Ask Claude about a selection: the agent gets its picture and diagram, and its answer lands beside it with a suggested edit', async () => {
  const { dir, repo, env } = scratch('ask-selection');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const [zone] = await zones(window);
    await window.evaluate(
      async ({ zoneId, shapes, size }) => {
        const board = globalThis.window.agentBoard;
        const made = [];
        for (const { shape, text, x, y } of shapes) {
          const data = { shape, fill: null, stroke: '#2b2a27', strokeWidth: 2, dashed: false, text, textSize: 'body', bold: false, textColor: '#2b2a27' };
          made.push(await board.items.create({ kind: 'shape', zoneId, x, y, ...size, data }));
        }
        // A sticky inside the selection's box, between two of its shapes, that is not selected: it must not be drawn.
        await board.items.create({ kind: 'sticky', zoneId, x: 330, y: 105, width: 40, height: 22, data: { text: '', color: '#fff3a3' } });
        for (const [from, to] of [
          [made[0]!, made[1]!],
          [made[1]!, made[2]!],
        ] as const) {
          await board.connectors.create({ from: { type: 'item', id: from.id, side: 'right' }, to: { type: 'item', id: to.id, side: 'left' } });
        }
      },
      { zoneId: zone!.id, shapes: SHAPES, size: SHAPE_SIZE },
    );
    const shapes = window.getByTestId('shape');
    await expect(shapes).toHaveCount(3);
    await shapes.nth(0).click();
    await shapes.nth(1).click({ modifiers: ['Shift'] });
    await shapes.nth(2).click({ modifiers: ['Shift'] });
    await expect(window.getByTestId('selection-label')).toHaveText('3 selected · 3 shapes');

    // It is offered in the selection's menu and on ⌘⇧A, and nothing is sent until Ask.
    await shapes.nth(1).click({ button: 'right' });
    const menu = window.getByRole('menu');
    await expect(menu.getByRole('menuitem').first()).toContainText('Ask Claude…');
    await window.keyboard.press('Escape');
    await window.keyboard.press('ControlOrMeta+Shift+A');
    const popover = window.getByRole('dialog', { name: 'Ask Claude' });
    await expect(popover).toContainText('3 shapes · 2 arrows');
    await popover.getByRole('button', { name: 'Cancel' }).click();
    await expect(popover).toBeHidden();
    expect(await agents(window)).toEqual([]);

    // From the button beside the selection's label.
    await window.getByRole('button', { name: /Ask Claude…/ }).click();
    await expect(popover.getByRole('textbox', { name: 'What to ask' })).toHaveValue('Review this architecture: risks, gaps, alternatives.');
    await expect(popover.getByRole('checkbox', { name: /Let it read monorepo/ })).toBeChecked();
    await expect(popover.getByRole('button', { name: 'Note + suggested edits' })).toHaveAttribute('aria-pressed', 'true');
    await popover.getByRole('textbox', { name: 'What to ask' }).fill("What's risky here?");
    const view = () => window.evaluate(() => (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform);
    const before = await view();
    await popover.getByRole('button', { name: /^Ask/ }).click();
    await expect(popover).toBeHidden();
    // The board is drawn at 2× for the picture (the page hidden meanwhile, the popover with it), then the view is put
    // back as it was.
    await expect.poll(view).toBe(before);

    // An architect starts, and its first answer lands beside the selection as an agent note, joined to it by an arrow.
    const asked = tile(window).filter({ hasText: "Ask: What's risky here?" });
    await expect(asked).toHaveCount(1);
    const [agent] = await agents(window);
    expect(agent).toMatchObject({ roleName: 'architect' });
    const note = window.getByTestId('agent-note');
    await expect(note).toContainText('Saw 3 shapes and 2 arrows');
    // The picture is the selection drawn at 2×: its width is twice the selection's on the board.
    const width = 2 * (SHAPES[2]!.x + SHAPE_SIZE.width - SHAPES[0]!.x);
    const height = 2 * (Math.max(...SHAPES.map((each) => each.y)) + SHAPE_SIZE.height - Math.min(...SHAPES.map((each) => each.y)));
    await expect(note).toContainText(`The picture is a PNG, ${width}×${height} px`);
    // It holds the selected objects alone: no pixel of the sticky between them, which isn't selected.
    const [folder] = readdirSync(join(dataDir, 'selection-asks'));
    const yellow = await app.evaluate(({ nativeImage }, path) => {
      const bitmap = nativeImage.createFromPath(path).toBitmap();
      let count = 0;
      // BGRA: the sticky's yellow is near white in red and green, well under in blue.
      for (let i = 0; i < bitmap.length; i += 4) if (bitmap[i + 2]! > 235 && bitmap[i + 1]! > 225 && bitmap[i]! < 200) count++;
      return count;
    }, join(dataDir, 'selection-asks', folder!, 'selection.png'));
    expect(yellow).toBe(0);
    await expect(note).toContainText('Its nodes: Postgres, API gateway, Orders service.');
    // It ran with no worktree of its own: in the user's checkout, read-only.
    await expect(note).toContainText('a git checkout, in plan mode');
    await expect(note).toContainText('You asked: “What\'s risky here?”');
    await expect(note.getByRole('button', { name: /Ask: What's risky here\?/ })).toBeVisible();
    await expect.poll(async () => (await window.evaluate(() => globalThis.window.agentBoard.connectors.list())).length).toBe(3);

    // Its suggested edit is drawn on the diagram until it is accepted, as one step that undo takes back.
    await expect(window.getByTestId('suggestion-ghost')).toHaveCount(1);
    await expect(note.getByTestId('agent-note-edits')).toContainText('1 edit on the diagram');
    await window.getByRole('button', { name: 'Accept Outbox' }).click();
    await expect(window.getByTestId('suggestion-ghost')).toHaveCount(0);
    await expect(shapes).toHaveCount(4);
    await expect(shapes.filter({ hasText: 'outbox' })).toHaveCount(1);
    await expect.poll(async () => (await window.evaluate(() => globalThis.window.agentBoard.connectors.list())).length).toBe(4);
    await expect(note.getByTestId('agent-note-edits')).toHaveCount(0);
    await window.keyboard.press('ControlOrMeta+Z');
    await expect(shapes).toHaveCount(3);
    await expect(window.getByTestId('suggestion-ghost')).toHaveCount(1);
    // Dismissed, it goes with nothing made.
    await note.getByRole('button', { name: 'Dismiss' }).click();
    await expect(window.getByTestId('suggestion-ghost')).toHaveCount(0);
    await expect(shapes).toHaveCount(3);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
