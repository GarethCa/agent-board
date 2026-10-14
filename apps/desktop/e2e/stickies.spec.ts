import { expect, type Locator, type Page } from '@playwright/test';
import { connectDaemon } from '@agent-board/daemon/client';
import { daemonPaths } from '@agent-board/daemon/paths';
import type { BoardItem, Zone } from '@agent-board/daemon/protocol';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drag, settledBox, withDaemon } from './board-helpers.ts';
import { test, connectedDaemonPid, launchApp, pickFolderNext, removeDataDir, stopDaemon, tempDataDir, browseForZone, addEmptyZone } from './launch.ts';

/** The board as the daemon has stored it. */
function stored(dataDir: string): Promise<{ zones: Zone[]; items: BoardItem[] }> {
  return withDaemon(dataDir, async (client) => ({ zones: await client.call('zone.list'), items: await client.call('item.list') }));
}

/** A point on bare board, left of the zone: checked, so a click there can't land on anything else. */
async function bareBoardPoint(window: Page, zone: Locator): Promise<{ x: number; y: number }> {
  const box = await settledBox(zone);
  const point = { x: Math.max(box.x - 150, 40), y: box.y + box.height / 2 };
  const bare = await window.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('react-flow__pane') ?? false,
    point,
  );
  expect(bare, 'the point is bare board').toBe(true);
  return point;
}

test('makes a sticky note, types and recolours it, moves it into a zone that then moves, and keeps it across a restart', async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ab-e2e-stickies-')));
  const repo = join(scratch, 'monorepo');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  const dataDir = tempDataDir();

  let app = await launchApp(dataDir);
  try {
    let window = await app.firstWindow();
    await connectedDaemonPid(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const zone = window.getByTestId('zone');
    await expect(zone).toHaveCount(1);
    // Zoomed out a step, so there is bare board beside the zone.
    await window.getByRole('button', { name: 'Zoom Out' }).click();

    // Double-click bare board: a note appears there, ready to type.
    const spot = await bareBoardPoint(window, zone);
    await window.mouse.dblclick(spot.x, spot.y);
    const note = window.getByTestId('sticky');
    await expect(note).toHaveCount(1);
    const editor = note.getByRole('textbox', { name: 'Note text' });
    await expect(editor).toBeFocused();
    const noteBox = await settledBox(note);
    expect(Math.abs(noteBox.x + noteBox.width / 2 - spot.x)).toBeLessThan(2);
    expect(Math.abs(noteBox.y + noteBox.height / 2 - spot.y)).toBeLessThan(2);

    // Long enough that it is shrunk to fit, so the size depends on the handwriting face's metrics.
    await window.keyboard.type('**Plan** for _today_: the design system, the zone picker, the dock and the inbox');
    await window.keyboard.press('Enter');
    await window.keyboard.type('- ship it');
    await window.keyboard.press('Escape');
    await expect(editor).toBeHidden();
    await expect(note.locator('strong')).toHaveText('Plan');
    await expect(note.locator('em')).toHaveText('today');
    await expect(note.locator('li')).toHaveText('ship it');
    await expect.poll(async () => (await stored(dataDir)).items[0]?.data.text).toBe('**Plan** for _today_: the design system, the zone picker, the dock and the inbox\n- ship it');

    // Selected, it shows its colours.
    await note.click();
    await window.getByRole('button', { name: 'Blue' }).click();
    await expect(note).toHaveAttribute('data-color', '#a5d8ff');
    await expect.poll(async () => (await stored(dataDir)).items[0]?.data.color).toBe('#a5d8ff');

    // Dragged onto the zone, it goes in it.
    const zoneId = (await stored(dataDir)).zones[0]!.id;
    const into = await settledBox(zone);
    const from = await settledBox(note);
    await drag(
      window,
      { x: from.x + from.width / 2, y: from.y + 10 },
      { x: into.x + into.width / 2, y: into.y + into.height / 2 },
      { steps: 10 },
    );
    await expect(note).toHaveAttribute('data-zone', zoneId);
    await expect.poll(async () => (await stored(dataDir)).items[0]?.zoneId).toBe(zoneId);

    // Moving the zone by its tab takes the note with it.
    const zoneXBefore = (await stored(dataDir)).zones[0]!.x;
    const noteBefore = await settledBox(note);
    const zoneBefore = await settledBox(zone);
    const tab = await settledBox(window.getByTestId('zone-tab'));
    await drag(window, { x: tab.x + 10, y: tab.y + tab.height / 2 }, { x: tab.x + 90, y: tab.y + tab.height / 2 + 60 });
    const zoneAfter = await settledBox(zone);
    const noteAfter = await settledBox(note);
    expect(zoneAfter.x - zoneBefore.x).toBeGreaterThan(40);
    expect(noteAfter.x - noteBefore.x).toBeCloseTo(zoneAfter.x - zoneBefore.x, 0);
    expect(noteAfter.y - noteBefore.y).toBeCloseTo(zoneAfter.y - zoneBefore.y, 0);
    await expect.poll(async () => (await stored(dataDir)).zones[0]!.x).not.toBe(zoneXBefore);

    // Backspace with the zone selected deletes nothing: not the zone, and not the note inside it.
    await window.getByTestId('zone-tab').click();
    await expect(window.locator('.react-flow__node.selected').getByTestId('zone')).toHaveCount(1);
    await window.keyboard.press('Backspace');
    await expect(zone).toHaveCount(1);
    await expect(note).toHaveCount(1);
    expect((await stored(dataDir)).items).toHaveLength(1);

    // A change made by another client shows up on the board.
    const noteId = (await stored(dataDir)).items[0]!.id;
    const other = await connectDaemon(daemonPaths(dataDir).socket);
    await other.call('item.update', { id: noteId, data: { color: '#b2f2bb' } });
    other.close();
    await expect(note).toHaveAttribute('data-color', '#b2f2bb');

    /** Where the note sits in its zone, as fractions of the zone's size: the same whatever the zoom. */
    const placeInZone = async () => {
      const [n, z] = [await settledBox(window.getByTestId('sticky')), await settledBox(window.getByTestId('zone'))];
      return { x: (n.x - z.x) / z.width, y: (n.y - z.y) / z.height };
    };
    const placeBefore = await placeInZone();
    const fontSize = (one: Locator) => one.evaluate((element) => getComputedStyle(element).fontSize);
    const sizeBefore = await fontSize(note);

    // A full restart: the app and its daemon both go, so the note must come back from the database.
    const firstDaemon = await connectedDaemonPid(window);
    await app.close();
    // Stopped here, unless a slow quit (Linux) already let it idle out on its own.
    expect([firstDaemon, undefined]).toContain(await stopDaemon(dataDir));
    app = await launchApp(dataDir);
    window = await app.firstWindow();
    expect(await connectedDaemonPid(window)).not.toBe(firstDaemon);

    const restored = window.getByTestId('sticky');
    await expect(restored).toHaveCount(1);
    await expect(restored).toHaveAttribute('data-color', '#b2f2bb');
    await expect(restored).toHaveAttribute('data-zone', zoneId);
    await expect(restored.locator('strong')).toHaveText('Plan');
    // Fitted in the handwriting face, not the fallback it measures with until the face has loaded.
    await expect.poll(() => fontSize(restored)).toBe(sizeBefore);
    const placeAfter = await placeInZone();
    expect(placeAfter.x).toBeCloseTo(placeBefore.x, 2);
    expect(placeAfter.y).toBeCloseTo(placeBefore.y, 2);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('N adds a note at the pointer and the Sticky button one in the middle; a selected note resizes and goes with Backspace', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    const notes = window.getByTestId('sticky');

    // Typed straight after N, without waiting for the note: every key lands in it, and an n never makes another.
    await window.mouse.move(pane.x + 200, pane.y + 200);
    await window.keyboard.press('n');
    await window.keyboard.type('no new notes');
    await window.keyboard.press('Escape');
    await expect(notes).toHaveCount(1);
    const first = await settledBox(notes.first());
    expect(Math.abs(first.x + first.width / 2 - (pane.x + 200))).toBeLessThan(2);
    expect(Math.abs(first.y + first.height / 2 - (pane.y + 200))).toBeLessThan(2);
    await expect(notes.first()).toContainText('no new notes');
    await expect.poll(async () => (await stored(dataDir)).items.map((item) => item.data.text)).toEqual(['no new notes']);

    // Selected, it resizes from a corner. Done before the next note, which may land over the corner in a small window.
    await notes.first().click();
    const corner = await settledBox(window.locator('.react-flow__resize-control.handle.bottom.right'));
    const grip = { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 };
    await drag(window, grip, { x: grip.x + 60, y: grip.y + 40 });
    await expect.poll(async () => (await stored(dataDir)).items.map(({ width, height }) => [width, height])).toEqual([
      [260, 240],
    ]);

    await window.getByRole('button', { name: 'Sticky' }).click();
    await expect(notes).toHaveCount(2);
    await window.keyboard.press('Escape');
    await expect.poll(async () => (await stored(dataDir)).items.length).toBe(2);
    const middle = await settledBox(notes.nth(1));
    expect(Math.abs(middle.x + middle.width / 2 - (pane.x + pane.width / 2))).toBeLessThan(2);
    expect(Math.abs(middle.y + middle.height / 2 - (pane.y + pane.height / 2))).toBeLessThan(2);

    // Selected, a note goes with Backspace, unasked.
    await notes.first().click();
    await window.keyboard.press('Backspace');
    await expect(notes).toHaveCount(1);
    await expect.poll(async () => (await stored(dataDir)).items.length).toBe(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a note being typed in keeps its text when the app quits before the typing ends', async () => {
  const dataDir = tempDataDir();
  let app = await launchApp(dataDir);
  try {
    let window = await app.firstWindow();
    await connectedDaemonPid(window);
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    await window.mouse.move(pane.x + 200, pane.y + 200);
    await window.keyboard.press('n');
    const editor = window.getByRole('textbox', { name: 'Note text' });
    await expect(editor).toBeFocused();
    await window.keyboard.type('typed before quitting');
    // No Escape, no click elsewhere: the app goes while the note is still being typed in.
    await app.close();

    app = await launchApp(dataDir);
    window = await app.firstWindow();
    await connectedDaemonPid(window);
    await expect(window.getByTestId('sticky')).toContainText('typed before quitting');
    expect((await stored(dataDir)).items.map((item) => item.data.text)).toEqual(['typed before quitting']);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test("a note's links never open inside the app: only https links are links, and windows can't open or navigate", async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const client = await connectDaemon(daemonPaths(dataDir).socket);
    await client.call('item.create', {
      kind: 'sticky',
      zoneId: null,
      // Clear of the board's buttons, top left.
      x: 200,
      y: 150,
      width: 300,
      height: 200,
      data: { text: '[safe](https://example.com/x) and [plain](http://127.0.0.1:9/x)', color: '#fff3a3' },
    });
    client.close();
    const note = window.getByTestId('sticky');
    await expect(note).toHaveCount(1);

    // The https link is a link with nowhere to navigate to; the http one is only text.
    const link = note.getByRole('link');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveText('safe');
    await expect(note.locator('a[href]')).toHaveCount(0);
    await expect(note).toContainText('[plain](http://127.0.0.1:9/x)');

    // A middle-click opens no window.
    await link.click({ button: 'middle' });
    // Nor does script, nor can it navigate the board away.
    await window.evaluate(() => {
      globalThis.open('http://127.0.0.1:9/opened');
    });
    await window.evaluate(() => {
      globalThis.location.href = 'http://127.0.0.1:9/navigated';
    });
    await window.waitForTimeout(500);
    expect(app.windows()).toHaveLength(1);
    // Still the board. (Read from the page: Playwright's locators wait on the navigation that was refused.)
    expect(await window.evaluate(() => globalThis.location.protocol)).toBe('file:');
    expect(await window.evaluate(() => document.querySelectorAll('[data-testid=sticky]').length)).toBe(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a note deleted in another window while being typed in goes quietly', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    await window.mouse.move(pane.x + 200, pane.y + 200);
    await window.keyboard.press('n');
    await expect(window.getByRole('textbox', { name: 'Note text' })).toBeFocused();
    await expect.poll(async () => (await stored(dataDir)).items.length).toBe(1);
    // Typed, not yet saved: deleting the note elsewhere unmounts its editor, which would save what was typed.
    await window.keyboard.type('half a thought');
    const other = await connectDaemon(daemonPaths(dataDir).socket);
    await other.call('item.delete', { id: (await stored(dataDir)).items[0]!.id });
    other.close();

    await expect(window.getByTestId('sticky')).toHaveCount(0);
    await window.waitForTimeout(1_000);
    await expect(window.getByRole('alert')).toHaveCount(0);
    expect((await stored(dataDir)).items).toEqual([]);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a note in an empty zone moves with it, and stays in it when the zone is bound to a repo', async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ab-e2e-stickies-')));
  const repo = join(scratch, 'later');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    await addEmptyZone(window, 'Ideas');
    const zone = window.getByTestId('zone');
    await expect(zone).toHaveAttribute('data-kind', 'unbound');
    const zoneId = (await stored(dataDir)).zones[0]!.id;

    // Double-click the empty zone's body: the note goes in it.
    const body = await settledBox(zone);
    await window.mouse.dblclick(body.x + body.width / 2, body.y + body.height / 2);
    const note = window.getByTestId('sticky');
    await expect(note).toHaveAttribute('data-zone', zoneId);
    await window.keyboard.type('before binding');
    await window.keyboard.press('Escape');
    await expect.poll(async () => (await stored(dataDir)).items[0]?.zoneId).toBe(zoneId);

    // Moving the zone takes the note with it.
    const noteBefore = await settledBox(note);
    const tab = await settledBox(window.getByTestId('zone-tab'));
    await drag(window, { x: tab.x + 10, y: tab.y + tab.height / 2 }, { x: tab.x + 70, y: tab.y + tab.height / 2 + 50 });
    const noteAfter = await settledBox(note);
    expect(noteAfter.x - noteBefore.x).toBeGreaterThan(40);
    expect(noteAfter.y - noteBefore.y).toBeGreaterThan(30);
    const item = (await stored(dataDir)).items[0]!;

    // Bound to a repo, it is the same zone, so the note stays in it, where it was.
    await pickFolderNext(app, repo);
    await zone.getByRole('button', { name: 'Bind zone' }).click();
    await window.getByRole('menuitem', { name: 'Open as repo…' }).click();
    await expect(zone).toHaveAttribute('data-kind', 'repo');
    await expect(note).toHaveAttribute('data-zone', zoneId);
    await expect(note).toContainText('before binding');
    expect((await stored(dataDir)).items).toEqual([item]);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(scratch, { recursive: true, force: true });
  }
});
