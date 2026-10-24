import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { rmSync, writeFileSync } from 'node:fs';
import { CAPTURE_MARGIN, type ZoneScreenshot } from '@agent-board/daemon/protocol';
import { untilStill, withDaemon } from './board-helpers.ts';
import { launch, sessionWindow, setClickOpens, spawnAgent, tile, zones } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// A picture of a zone for its orchestrator (`zone screenshot`): the app draws the zone in a hidden window of its own,
// the board's canvas alone with every terminal's text hidden, and the user's window, view and windows stay as they were.

/** A PNG's width and height, from its header. */
function pngSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, 'base64');
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** What the user's board saved: where it looks, at what zoom, and the windows it has open. */
const savedView = (page: Page) => page.evaluate(async () => [await window.agentBoard.view.get('viewport'), await window.agentBoard.view.get('windows')]);

/** What a capture window must never show: a terminal, a session window, its scrim, the dock or the minimap. */
const NEVER_SHOWN = ['.xterm', '[data-testid=session-window]', '.session-window-scrim', '[data-testid=session-dock]', '.board-minimap'];

/**
 * Takes a picture of `zoneId`, watching its capture window from opening to closing: it must show the zone's canvas,
 * and never any of `NEVER_SHOWN`, at any moment it is checked; for `expanded`, an expanded tile's terminal drawn as
 * hidden. Returns the picture.
 */
async function screenshot(app: ElectronApplication, dataDir: string, zoneId: string, { expanded = false } = {}): Promise<ZoneScreenshot> {
  const opened = app.waitForEvent('window');
  const taking = withDaemon(dataDir, (client) => client.call('orchestrator.screenshot', { zoneId }));
  const capture = await opened;
  const seen = new Set<string>();
  const count = (selector: string) => capture.locator(selector).count().catch(() => 0);
  let checks = 0;
  // Until it closes, once its picture is taken: a session window drawn late is caught as surely as one drawn at once.
  while (!capture.isClosed()) {
    for (const selector of [...NEVER_SHOWN, '.react-flow__node-zone', '[data-testid=terminal-hidden]']) if ((await count(selector)) > 0) seen.add(selector);
    checks++;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const shot = await taking;
  expect(checks).toBeGreaterThan(1);
  expect(NEVER_SHOWN.filter((selector) => seen.has(selector))).toEqual([]);
  expect(seen.has('.react-flow__node-zone')).toBe(true);
  if (expanded) expect(seen.has('[data-testid=terminal-hidden]')).toBe(true);
  return shot;
}

test('takes a picture of a zone in a hidden window, its canvas alone with no terminal, session window or dock, without changing the user’s view, and a plain drawing of it', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const [made] = await zones(window);
    await withDaemon(dataDir, (client) => client.call('zone.update', { id: made!.id, x: made!.x, y: made!.y, width: 1400, height: 900 }));
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');
    await spawnAgent(window, 'monorepo', 'Review the schema');
    await expect(tile(window)).toHaveCount(2);
    await withDaemon(dataDir, async (client) => {
      const [first, second] = await client.call('agent.list');
      await client.call('flowEdge.create', { from: first!.sessionId, to: second!.sessionId });
    });
    const [zone] = await zones(window);
    // Placed from the zone's top-left, as an item in a zone is.
    await withDaemon(dataDir, (client) =>
      client.call('item.create', { kind: 'sticky', zoneId: zone!.id, x: 40, y: zone!.height - 240, width: 200, height: 180, data: { text: 'Ship by Friday', color: '#fff3a3' } }),
    );
    // The zone, and a margin round it for its tab.
    const size = { width: zone!.width + 2 * CAPTURE_MARGIN, height: zone!.height + 2 * CAPTURE_MARGIN };

    // As the app opens a tile at first: in a session window over the board, its terminal showing what it printed.
    await tile(window).first().dblclick();
    await expect(sessionWindow(window).getByTestId('session-terminal')).toContainText('Which database should I use');
    // Opening it panned the board and saved its windows, a moment later.
    await untilStill(async () => JSON.stringify(await savedView(window)), { every: 1_500 });
    const before = await savedView(window);

    const shown = await screenshot(app, dataDir, zone!.id);
    expect(shown).toMatchObject({ zoneId: zone!.id, style: 'board', scale: 1, ...size });
    expect(pngSize(shown.png)).toEqual(size);
    // Closed once taken; the user's window kept its view, its windows and its live terminal.
    await expect.poll(() => app.windows().length).toBe(1);
    expect(await savedView(window)).toEqual(before);
    await expect(sessionWindow(window).getByTestId('session-terminal')).toContainText('Which database should I use');

    // Expanded in place instead.
    await window.getByRole('button', { name: 'Close session window' }).click();
    await setClickOpens(window, 'Expand in place');
    await tile(window).first().dblclick();
    await expect(window.getByTestId('expanded-tile').getByTestId('session-terminal')).toContainText('Which database should I use');
    const expanded = await screenshot(app, dataDir, zone!.id, { expanded: true });
    expect(pngSize(expanded.png)).toEqual(size);
    writeFileSync(test.info().outputPath('zone-board.png'), Buffer.from(expanded.png, 'base64'));

    const sketch: ZoneScreenshot = await withDaemon(dataDir, (client) => client.call('orchestrator.screenshot', { zoneId: zone!.id, style: 'lofi' }));
    expect(sketch).toMatchObject({ style: 'lofi', ...size });
    expect(pngSize(sketch.png)).toEqual(size);
    writeFileSync(test.info().outputPath('zone-lofi.png'), Buffer.from(sketch.png, 'base64'));
    await expect.poll(() => app.windows().length).toBe(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
