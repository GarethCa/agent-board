import { expect, type Locator, type Page } from '@playwright/test';
import { connectDaemon } from '@agent-board/daemon/client';
import { daemonPaths } from '@agent-board/daemon/paths';
import type { Connector } from '@agent-board/daemon/protocol';
import { centreOf, settledBox, withDaemon } from './board-helpers.ts';
import { test, connectedDaemonPid, launchApp, removeDataDir, tempDataDir } from './launch.ts';

const storedConnector = (dataDir: string): Promise<Connector | undefined> => withDaemon(dataDir, async (client) => (await client.call('connector.list'))[0]);

/** The point `fromEnd` along the line from its start (or, negative, back from its end), on the screen. */
async function along(line: Locator, fromEnd: number): Promise<{ x: number; y: number }> {
  return line.evaluate((path: SVGPathElement, distance) => {
    // Its `pathLength` is the board's measure of it; the point is found by the drawn length.
    const total = path.getTotalLength();
    const at = path.getPointAtLength(distance < 0 ? total + distance : distance);
    const matrix = path.getScreenCTM()!;
    return { x: at.x * matrix.a + at.y * matrix.c + matrix.e, y: at.x * matrix.b + at.y * matrix.d + matrix.f };
  }, fromEnd);
}

/** Opens the Relation menu, once the last one has gone (a press while it fades out doesn't open it again). */
async function openRelations(window: Page): Promise<void> {
  await expect(window.getByRole('menu')).toHaveCount(0);
  await window.getByRole('button', { name: 'Relation' }).click();
}

async function pickRelation(window: Page, name: string): Promise<void> {
  await openRelations(window);
  // A relation's row also says which way it reads, under its name.
  await window.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click();
}

test('a connector draws a class diagram’s relations, types a label by each end that follows its route, and swaps direction with ⇧S', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const client = await connectDaemon(daemonPaths(dataDir).socket);
    const note = (text: string, x: number, y: number, height = 120) =>
      client.call('item.create', { kind: 'sticky', zoneId: null, x, y, width: 160, height, data: { text, color: '#fff3a3' } });
    // A child and its parent, with a note between them that the line goes round.
    const child = await note('child', 0, 320);
    const parent = await note('parent', 640, 320);
    await note('in the way', 320, 260, 240);
    await client.call('connector.create', {
      from: { type: 'item', id: child.id, side: 'right' },
      to: { type: 'item', id: parent.id, side: 'left' },
      style: 'elbow',
    });
    client.close();
    const line = window.locator('.react-flow__edge-path.connector-line');
    await expect(line).toHaveAttribute('data-routed', 'true');

    // Picked from the Relation menu, it is an inheritance: a hollow triangle at the parent, the line stopping at its back.
    await window.mouse.click(...(Object.values(await along(line, 60)) as [number, number]));
    await expect(window.getByRole('button', { name: 'Relation' })).toHaveText('Directed');
    await pickRelation(window, 'Inheritance');
    await expect.poll(() => storedConnector(dataDir)).toMatchObject({ startEnd: 'none', endEnd: 'triangle', dashed: false });
    await expect(line).toHaveAttribute('marker-end', 'url(#connector-triangle)');
    await expect(line).toHaveCSS('stroke-dasharray', /^0(px)?,? 0(px)?,? [\d.]+(px)?,? 11(px)?$/);
    await expect(window.getByRole('button', { name: 'Relation' })).toHaveText('Inheritance');

    // A dependency is dashed, with an open arrow; a composition has a filled diamond at the whole (its `from`).
    await pickRelation(window, 'Dependency');
    await expect.poll(() => storedConnector(dataDir)).toMatchObject({ startEnd: 'none', endEnd: 'arrow', dashed: true });
    await expect(line).toHaveAttribute('data-dashed', 'true');
    await pickRelation(window, 'Composition');
    await expect.poll(() => storedConnector(dataDir)).toMatchObject({ startEnd: 'filled-diamond', endEnd: 'none', dashed: false });
    await expect(line).toHaveAttribute('marker-start', 'url(#connector-filled-diamond)');

    // Custom ends… shows each end and the dash, one by one.
    await openRelations(window);
    await window.getByRole('menuitem', { name: 'Custom ends…' }).click();
    await window.getByRole('button', { name: 'End: hollow diamond' }).click();
    await window.getByRole('button', { name: 'Start: none' }).click();
    await expect.poll(() => storedConnector(dataDir)).toMatchObject({ startEnd: 'none', endEnd: 'diamond' });

    // A double-click near an end types its label, which sits by that end, beside the line as it is routed there.
    for (const { distance, name, text, end } of [
      { distance: -20, name: 'End label', text: '0..*', end: 'to' },
      { distance: 20, name: 'Start label', text: '1', end: 'from' },
    ]) {
      await window.keyboard.press('Escape');
      await window.mouse.dblclick(...(Object.values(await along(line, distance)) as [number, number]));
      const input = window.getByRole('textbox', { name });
      await expect(input).toBeFocused();
      await window.keyboard.type(text);
      await window.keyboard.press('Enter');
      const label = window.locator(`[data-testid="connector-end-label"][data-end="${end}"]`);
      await expect(label).toHaveText(text);
      const [at, tip] = [centreOf(await settledBox(label)), await along(line, end === 'to' ? -1 : 1)];
      expect(Math.hypot(at.x - tip.x, at.y - tip.y)).toBeLessThan(60);
    }
    await expect.poll(() => storedConnector(dataDir)).toMatchObject({ startLabel: '1', endLabel: '0..*', label: '' });

    // ⇧S turns it round: the diamond is by the child now, and each label stays by its note.
    await window.locator('[data-testid="connector-end-label"][data-end="to"]').click();
    await window.keyboard.press('Shift+S');
    await expect
      .poll(() => storedConnector(dataDir))
      .toMatchObject({ from: { id: parent.id, side: 'left' }, to: { id: child.id, side: 'right' }, endEnd: 'diamond', startLabel: '0..*', endLabel: '1' });
    // The Shape tool stays down.
    await expect(window.getByRole('button', { name: 'Shape', exact: true })).toHaveAttribute('aria-pressed', 'false');

    // One undo puts it back the way it was drawn, labels and all.
    await window.keyboard.press('Meta+z');
    await expect
      .poll(() => storedConnector(dataDir))
      .toMatchObject({ from: { id: child.id, side: 'right' }, to: { id: parent.id, side: 'left' }, endEnd: 'diamond', startLabel: '1', endLabel: '0..*' });

    // With no arrow selected, ⇧S is the board's again: it arms the Shape tool.
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    await window.mouse.click(pane.x + pane.width / 2, pane.y + pane.height - 60);
    await expect(window.getByRole('button', { name: 'Relation' })).toHaveCount(0);
    await window.keyboard.press('Shift+S');
    await expect(window.getByRole('button', { name: 'Shape', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await window.keyboard.press('Escape');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a connector on a turned note keeps its end shape and its end label by the end, off the line', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const client = await connectDaemon(daemonPaths(dataDir).socket);
    const note = (text: string, x: number, y: number, rotation = 0) =>
      client.call('item.create', { kind: 'sticky', zoneId: null, x, y, width: 160, height: 120, rotation, data: { text, color: '#fff3a3' } });
    const part = await note('part', 80, 300);
    const whole = await note('whole, turned', 520, 260, 30);
    await client.call('connector.create', {
      from: { type: 'item', id: part.id, side: 'right' },
      to: { type: 'item', id: whole.id, side: 'left' },
      style: 'straight',
      endEnd: 'triangle',
      endLabel: 'many',
    });
    client.close();
    const line = window.locator('.react-flow__edge-path.connector-line');
    await expect(line).toHaveAttribute('marker-end', 'url(#connector-triangle)');
    const label = window.locator('[data-testid="connector-end-label"][data-end="to"]');
    await expect(label).toHaveText('many');
    const box = await settledBox(label);
    const tip = await along(line, -1);
    expect(Math.hypot(box.x + box.width / 2 - tip.x, box.y + box.height / 2 - tip.y)).toBeLessThan(60);
    // Beside the line, not over it: no point of the line near its end is inside the label.
    for (const distance of [-1, -10, -20, -30, -40, -50]) {
      const at = await along(line, distance);
      const inside = at.x > box.x && at.x < box.x + box.width && at.y > box.y && at.y < box.y + box.height;
      expect(inside, `${distance}: ${at.x},${at.y}`).toBe(false);
    }
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
