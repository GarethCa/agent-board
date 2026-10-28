import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import type { DaemonClient } from '@agent-board/daemon/client';
import type { BoardItem } from '@agent-board/daemon/protocol';
import { agents, launch, spawnAgent, tile, zones } from './agent-helpers.ts';
import { drag, settledBox, withDaemon } from './board-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// An orchestrator's arrange sizes each lane's note to what the app measures its text at, not to the daemon's estimate,
// and its zone map knows the board was measured.

/** The board token of the agent `sessionId`, which the fake harness prints when asked for its identity. */
async function tokenOf(client: DaemonClient, sessionId: string): Promise<string> {
  let text = '';
  const printed = new Promise<string>((resolve) =>
    client.onEvent((event) => {
      if ((event.type === 'session.snapshot' || event.type === 'session.output') && event.sessionId === sessionId) text += event.data;
      const token = /identity:(.*):end\r\n/.exec(text)?.[1];
      if (token !== undefined) resolve(token);
    }),
  );
  await client.call('session.attach', { sessionId });
  return printed;
}

const fitView = (window: Page) => window.getByRole('button', { name: /^Fit view/ }).click();

/**
 * An orchestrator with a worker, arranged once, on a board in front: its token, its zone, and the lane's note as saved
 * now (`noteOf`).
 */
async function arrangedCrew(dataDir: string, window: Page, app: Parameters<typeof pickFolderNext>[0], repo: string) {
  await pickFolderNext(app, repo);
  await browseForZone(window);
  await spawnAgent(window, 'monorepo', 'Print your board identity');
  await expect(tile(window)).toHaveCount(1);
  const [lead] = await agents(window);
  const [zone] = await zones(window);
  const token = await withDaemon(dataDir, (client) => tokenOf(client, lead!.sessionId));
  await withDaemon(dataDir, async (client) => {
    await client.call('orchestrator.spawn', { token, name: 'worker', prompt: 'Do the work' });
    await client.call('orchestrator.arrange', { token });
  });
  await fitView(window);
  const noteOf = () => window.evaluate(async () => (await globalThis.window.agentBoard.items.list()).find((item: BoardItem) => item.kind === 'agent-note')!);
  return { token, zone: zone!, noteOf };
}

/** The room a note's text has to spare under it, as it is drawn: none, if the note is as tall as its text. */
const roomUnder = (window: Page) => () =>
  window
    .getByTestId('agent-note')
    .locator('.agent-note-body')
    .evaluate((element: HTMLElement) => {
      const drawn = element.clientHeight;
      element.style.flex = '0 0 auto';
      const own = element.clientHeight;
      element.style.flex = '';
      return drawn - own;
    });

/** A note's text, far more than a tile's height, and less than the daemon reckons it needs. */
const longText = (lines: number) => Array.from({ length: lines }, (_, index) => `- step ${index + 1} is done`).join('\n');

test("arranges a lane round its note at the height the app measures its text at, and maps the zone as measured", async () => {
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    const { token, zone, noteOf } = await arrangedCrew(dataDir, window, app, repo);
    const written = await noteOf();

    // The user writes the lane's note long.
    const long = longText(12);
    await window.evaluate(({ id, text }) => globalThis.window.agentBoard.items.update({ id, data: { text, editedByUser: true } }), { id: written.id, text: long });
    await fitView(window);
    const arranged = await withDaemon(dataDir, (client) => client.call('orchestrator.arrange', { token }));
    expect(arranged.unmeasured).toBe(false);
    // Its text shows whole, with no room to spare under it, and nothing is laid on top of anything.
    await expect.poll(roomUnder(window)).toBeGreaterThanOrEqual(-1);
    await expect.poll(roomUnder(window)).toBeLessThanOrEqual(2);
    expect((await noteOf()).data.text).toBe(long);
    const map = await withDaemon(dataDir, (client) => client.call('orchestrator.map', { zoneId: zone.id }));
    expect({ unmeasured: map.unmeasured, overlaps: map.overlaps, offGrid: map.offGrid }).toEqual({ unmeasured: false, overlaps: [], offGrid: [] });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("measures a lane's note the board doesn't draw, off screen, and arranges round it", async () => {
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    const { token, zone, noteOf } = await arrangedCrew(dataDir, window, app, repo);
    const written = await noteOf();

    // Panned far from the zone, the board draws none of it.
    const pane = window.locator('.react-flow__pane');
    const box = (await pane.boundingBox())!;
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let step = 0; step < 6; step++) await window.mouse.wheel(0, 4000);
    await expect(window.getByTestId('agent-note')).toHaveCount(0);

    // The note's text changes while it is off screen.
    const long = longText(10);
    await window.evaluate(({ id, text }) => globalThis.window.agentBoard.items.update({ id, data: { text, editedByUser: true } }), { id: written.id, text: long });
    const arranged = await withDaemon(dataDir, (client) => client.call('orchestrator.arrange', { token }));
    expect(arranged.unmeasured).toBe(false);
    await expect(window.getByTestId('agent-note')).toHaveCount(0);
    const sized = await noteOf();
    expect(sized.data.text).toBe(long);

    // Drawn again, it is as tall as its text: measured right, not grown to fit as it is drawn.
    await fitView(window);
    await expect.poll(roomUnder(window)).toBeGreaterThanOrEqual(-1);
    await expect.poll(roomUnder(window)).toBeLessThanOrEqual(2);
    expect((await noteOf()).height).toBe(sized.height);
    const map = await withDaemon(dataDir, (client) => client.call('orchestrator.map', { zoneId: zone.id }));
    expect({ unmeasured: map.unmeasured, overlaps: map.overlaps }).toEqual({ unmeasured: false, overlaps: [] });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lane's note dragged bigger keeps its size through an arrange and a restart, and its text scrolls with a more cue", async () => {
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const first = await launch(dataDir, env);
  let current = first;
  try {
    const { token, noteOf } = await arrangedCrew(dataDir, first.window, first.app, repo);
    const before = await noteOf();
    const note = first.window.getByTestId('agent-note');
    await note.locator('.agent-note-card').click({ position: { x: 20, y: 30 } });
    const dragCorner = async () => {
      const corner = await settledBox(first.window.locator('.react-flow__resize-control.handle.bottom.right'));
      const grip = { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 };
      await drag(first.window, grip, { x: grip.x + 120, y: grip.y + 90 });
    };
    await dragCorner();
    await expect.poll(async () => (await noteOf()).data.userSized).toBe(true);
    // Undone, it is the board's to size again: its old size, and no longer the user's.
    await first.window.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await noteOf()).data.userSized).toBe(false);
    expect(await noteOf()).toMatchObject({ width: before.width, height: before.height });
    await dragCorner();
    await expect.poll(async () => (await noteOf()).data.userSized).toBe(true);
    const sized = await noteOf();
    expect(sized.width).toBeGreaterThan(before.width + 40);
    expect(sized.height).toBeGreaterThan(before.height + 30);

    // Arranged again, the lane goes round it and it keeps its size, also with a text far longer than it has room for.
    await withDaemon(dataDir, (client) => client.call('orchestrator.arrange', { token }));
    expect(await noteOf()).toMatchObject({ width: sized.width, height: sized.height });
    await first.window.evaluate(({ id, text }) => globalThis.window.agentBoard.items.update({ id, data: { text, editedByUser: true } }), { id: sized.id, text: longText(40) });
    await withDaemon(dataDir, (client) => client.call('orchestrator.arrange', { token }));
    expect(await noteOf()).toMatchObject({ width: sized.width, height: sized.height });
    // Its text no longer fits: it scrolls, and says there is more under it until it is read to the end.
    const more = first.window.getByTestId('agent-note-more');
    await expect(more).toBeVisible();
    await note.locator('.agent-note-body').evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect(more).toHaveCount(0);

    // After a restart of the app.
    await first.app.close();
    current = await launch(dataDir, env);
    await expect(current.window.getByTestId('agent-note')).toBeVisible();
    const again = await current.window.evaluate(async () => (await globalThis.window.agentBoard.items.list()).find((item: BoardItem) => item.kind === 'agent-note')!);
    expect(again).toMatchObject({ width: sized.width, height: sized.height });
    // Its text still scrolls under the cue.
    await expect(current.window.getByTestId('agent-note-more')).toBeVisible();
  } finally {
    await current.app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
