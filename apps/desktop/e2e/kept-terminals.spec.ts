import { expect, type Page } from '@playwright/test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { agents, clickPopOut, launch, sessionWindow, setClickOpens, SHELL_ENV, spawnAgent, tile } from './agent-helpers.ts';
import { pan } from './bench-helpers.ts';
import { boardZoom, expectSharp, run, settledBox, viewSettled, withDaemon } from './board-helpers.ts';
import { browseForZone, connectedDaemonPid, newShell, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings } from './settings-helpers.ts';
import { GESTURE_QUIET_MS } from '../src/renderer/src/board/wheel-latch.ts';

/** Keeping terminals turned on, whatever the setting, with its usual budget. */
const KEPT_ENV = { ...SHELL_ENV, AGENT_BOARD_TERMINAL_CACHE: '150000000' };

const pane = (window: Page) => window.getByTestId('expanded-tile').getByTestId('session-terminal');

/** Opens a shell tile expanded in place, with a mark on its terminal's element, and listens for what the panes report. */
async function expandedShell(window: Page): Promise<string> {
  await setClickOpens(window, 'Expand in place');
  await newShell(window);
  await expect(sessionWindow(window).locator('.xterm')).toBeVisible();
  await window.getByRole('button', { name: 'Close session window' }).click();
  await window.getByTestId('shell-tile').dblclick();
  await expect(pane(window).locator('.xterm')).toBeVisible();
  await pane(window).click();
  await listenForTerminals(window);
  await markTerminal(window);
  return (await sessions(window))[0]!.id;
}

/** Hears what the panes report from here on, as `seen` reads it. */
const listenForTerminals = (window: Page) =>
  window.evaluate(() => {
    const seen: { name: string; detail: unknown }[] = [];
    (globalThis.window as unknown as { seen: typeof seen }).seen = seen;
    new PerformanceObserver((list) => {
      for (const { name, detail } of list.getEntries() as PerformanceMeasure[]) if (name.startsWith('terminal.')) seen.push({ name, detail });
    }).observe({ type: 'measure' });
  });

/** How many connections the daemon has, not counting the one that asks. */
const connections = (dataDir: string) => withDaemon(dataDir, async (client) => (await client.call('daemon.health')).clients - 1);

/** Marks the terminal's element, which a kept terminal keeps and a rebuilt one doesn't. */
const markTerminal = (window: Page) => pane(window).locator('.xterm').evaluate((element) => void ((element as HTMLElement).dataset.mark = 'kept'));

const sessions = (window: Page) => window.evaluate(() => globalThis.window.agentBoard.sessions.list());

/** What the panes reported as `name` since `expandedShell`. */
const seen = (window: Page, name: string) =>
  window.evaluate((asked) => (globalThis.window as unknown as { seen: { name: string; detail: unknown }[] }).seen.filter((each) => each.name === asked).map((each) => each.detail), name);

/** Pans the board until its one expanded tile is no longer drawn, and says how far, to come back by as much. */
async function panAway(window: Page): Promise<number> {
  let steps = 0;
  for (; steps < 60 && (await window.getByTestId('expanded-tile').count()) > 0; steps++) await pan(window, 300, 0);
  await expect(window.getByTestId('expanded-tile')).toHaveCount(0);
  return steps;
}

async function panBack(window: Page, steps: number): Promise<void> {
  for (let step = 0; step < steps; step++) await pan(window, -300, 0);
  await expect(pane(window).locator('.xterm')).toBeVisible();
}

test('off by default: a pane panned away detaches, and comes back with a new terminal from the snapshot', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await expandedShell(window);
    await run(window, 'echo before-$((40 + 2))');
    await expect(pane(window).locator('.xterm-rows')).toContainText('before-42');
    const connected = await connections(dataDir);
    await expect(pane(window).locator('.terminal-host')).toHaveCount(0);

    const steps = await panAway(window);
    await expect.poll(() => connections(dataDir)).toBe(connected - 1);
    expect(await seen(window, 'terminal.parked')).toEqual([]);
    const snapshots = (await seen(window, 'terminal.snapshot')).length;
    await panBack(window, steps);

    await expect(pane(window).locator('.xterm')).not.toHaveAttribute('data-mark', 'kept');
    await expect.poll(() => seen(window, 'terminal.snapshot')).toHaveLength(snapshots + 1);
    await expect(pane(window).locator('.xterm-rows')).toContainText('before-42');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('the setting in Settings › Advanced › Terminals keeps a pane panned away; turned off, it lets go of it', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    const settings = await openSettings(window, 'advanced.terminals');
    const keep = settings.getByRole('switch', { name: 'Keep terminals while off screen' });
    await expect(keep).not.toBeChecked();
    await keep.click();
    await expect(keep).toBeChecked();

    const id = await expandedShell(window);
    const steps = await panAway(window);
    await panBack(window, steps);
    await expect(pane(window).locator('.xterm')).toHaveAttribute('data-mark', 'kept');

    await panAway(window);
    // Settings again: the window from before no longer shows its switch.
    const reopened = (await openSettings(window, 'advanced.terminals')).getByRole('switch', { name: 'Keep terminals while off screen' });
    await expect(reopened).toBeChecked();
    await reopened.click();
    await expect(reopened).not.toBeChecked();
    await expect.poll(() => seen(window, 'terminal.letGo')).toEqual([{ sessionId: id, reason: 'setting' }]);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a pane panned out of view and back keeps its terminal, and still takes input', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, KEPT_ENV);
  try {
    await expandedShell(window);
    await run(window, 'echo before-$((40 + 2))');
    await expect(pane(window).locator('.xterm-rows')).toContainText('before-42');
    const { cols, rows } = (await sessions(window))[0]!;

    const steps = await panAway(window);
    // What the session prints while the pane is away reaches the terminal, ready for its return.
    const id = (await sessions(window))[0]!.id;
    await window.evaluate((session) => globalThis.window.agentBoard.sessions.write(session, 'echo away-$((40 + 3))\r'), id);
    // A change of theme restyles a parked terminal without sizing its session to nothing.
    await window.evaluate(() => {
      document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    });
    expect((await sessions(window))[0]).toMatchObject({ cols, rows });
    await panBack(window, steps);

    // The same terminal, not a new one with the same text, and nothing parsed again.
    await expect(pane(window).locator('.xterm')).toHaveAttribute('data-mark', 'kept');
    expect(await seen(window, 'terminal.snapshot')).toEqual([]);
    await expect(pane(window).locator('.xterm-rows')).toContainText('before-42');
    await expect(pane(window).locator('.xterm-rows')).toContainText('away-43');
    expect((await sessions(window))[0]).toMatchObject({ cols, rows });

    await pane(window).click();
    await run(window, 'echo after-$((40 + 4))');
    await expect(pane(window).locator('.xterm-rows')).toContainText('after-44');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a kept terminal on WebGL draws for a zoom that changed while it was away, at a device pixel ratio of 2', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...KEPT_ENV, AGENT_BOARD_TERMINAL_RENDERER: 'auto', AGENT_BOARD_TEST_DEVICE_SCALE: '2' });
  try {
    await expandedShell(window);
    await expect(pane(window).locator('.xterm')).toHaveAttribute('data-renderer', 'webgl');
    await expectSharp(pane(window));
    const steps = await panAway(window);
    await window.getByRole('button', { name: 'Zoom In' }).click();
    await viewSettled(window);
    await panBack(window, steps);
    await settledBox(window.getByTestId('expanded-tile'));

    expect(await boardZoom(window)).toBeGreaterThan(1.1);
    await expect(pane(window).locator('.xterm')).toHaveAttribute('data-mark', 'kept');
    await expect(pane(window).locator('.xterm')).toHaveAttribute('data-renderer', 'webgl');
    await expectSharp(pane(window));
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a pane keeps its place in the scrollback while it is away', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, KEPT_ENV);
  try {
    await expandedShell(window);
    await run(window, 'clear; i=0; while [ $i -lt 200 ]; do echo line-$i; i=$((i+1)); done; echo last-line');
    await expect(pane(window).locator('.xterm-rows')).toContainText('last-line');
    const box = (await pane(window).boundingBox())!;
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.wheel(0, -1000);
    await expect(pane(window).locator('.xterm-rows')).not.toContainText('last-line');
    const top = await pane(window).locator('.xterm-rows > div').first().textContent();
    // That scroll's gesture ends, or the pan away would carry on as a scroll of the terminal.
    await window.waitForTimeout(GESTURE_QUIET_MS * 3);

    const steps = await panAway(window);
    await panBack(window, steps);

    await expect(pane(window).locator('.xterm')).toHaveAttribute('data-mark', 'kept');
    await expect(pane(window).locator('.xterm-rows > div').first()).toHaveText(top!);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a session that ends while its pane is away lets its terminal go, and closes its connection', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, KEPT_ENV);
  try {
    const id = await expandedShell(window);
    await panAway(window);
    expect(await seen(window, 'terminal.parked')).toContainEqual(expect.objectContaining({ count: 1 }));
    const connected = await connections(dataDir);
    await window.evaluate((session) => globalThis.window.agentBoard.sessions.kill(session), id);
    await expect.poll(() => seen(window, 'terminal.letGo')).toEqual([{ sessionId: id, reason: 'ended' }]);
    await expect.poll(() => connections(dataDir)).toBe(connected - 1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('an agent deleted while its pane is away lets its terminal go', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...KEPT_ENV });
  try {
    await setClickOpens(window, 'Expand in place');
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');
    await tile(window).dblclick();
    await expect(pane(window).locator('.xterm-rows')).toBeVisible();
    await listenForTerminals(window);
    await panAway(window);
    const { sessionId } = (await agents(window))[0]!;
    await window.evaluate((id) => globalThis.window.agentBoard.agents.delete(id, true), sessionId);
    await expect.poll(() => seen(window, 'terminal.letGo')).toEqual([{ sessionId, reason: 'ended' }]);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a connection lost while a pane is away lets its terminal go', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, KEPT_ENV);
  try {
    const id = await expandedShell(window);
    await panAway(window);
    process.kill(await connectedDaemonPid(window), 'SIGKILL');
    await expect.poll(() => seen(window, 'terminal.letGo')).toEqual([{ sessionId: id, reason: 'disconnected' }]);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a parked terminal gives no answer to its session: only a pane that shows it does', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, KEPT_ENV);
  try {
    const id = await expandedShell(window);
    /** Asks the terminal for its status, waits two seconds for the answer, and says what came back. */
    const ask = async (name: string) => {
      const answer = join(dataDir, name);
      const command = `stty -echo -icanon min 0 time 20; printf '\\033[5n'; dd bs=16 count=1 of='${answer}.part' 2>/dev/null; stty sane; mv '${answer}.part' '${answer}'\r`;
      await window.evaluate(([session, line]) => globalThis.window.agentBoard.sessions.write(session!, line!), [id, command]);
      await expect.poll(() => existsSync(answer), { timeout: 15_000 }).toBe(true);
      return readFileSync(answer, 'utf8');
    };
    expect(await ask('shown')).toContain('[0n');

    await panAway(window);
    expect(await ask('parked')).toBe('');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a parked terminal that grows past the budget is let go, and its pane comes back from the snapshot', async () => {
  const dataDir = tempDataDir();
  // Room for an empty terminal, not for thousands of lines.
  const { app, window } = await launch(dataDir, { ...KEPT_ENV, AGENT_BOARD_TERMINAL_CACHE: '6000000' });
  try {
    const id = await expandedShell(window);
    const steps = await panAway(window);
    await expect.poll(() => seen(window, 'terminal.parked')).toContainEqual(expect.objectContaining({ count: 1 }));
    await window.evaluate((session) => globalThis.window.agentBoard.sessions.write(session, 'clear; seq 1 9000; echo printed-$((40 + 2))\r'), id);
    await expect.poll(() => seen(window, 'terminal.letGo'), { timeout: 20_000 }).toEqual([{ sessionId: id, reason: 'budget' }]);

    await panBack(window, steps);
    await expect(pane(window).locator('.xterm')).not.toHaveAttribute('data-mark', 'kept');
    await expect(pane(window).locator('.xterm-rows')).toContainText('printed-42');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('popping an agent out builds it one terminal, though its pane mounts before the agent arrives', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...KEPT_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');
    await tile(window).dblclick();
    await expect(sessionWindow(window).locator('.xterm')).toBeVisible();
    const connected = await connections(dataDir);

    const [popped] = await Promise.all([app.waitForEvent('window'), clickPopOut(sessionWindow(window))]);
    await expect(sessionWindow(popped)).toHaveAttribute('data-state', 'attached');
    await expect(sessionWindow(popped)).toContainText('pick-a-database');
    // The board's terminal, parked, and the pop-out's one. Time for a second one to show, if it were coming.
    await expect.poll(() => connections(dataDir)).toBe(connected + 1);
    await popped.waitForTimeout(1500);
    expect(await connections(dataDir)).toBe(connected + 1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a session resized elsewhere while its pane is away comes back from its snapshot, at the size of the pane', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, KEPT_ENV);
  try {
    const id = await expandedShell(window);
    await run(window, 'echo before-$((40 + 2))');
    await expect(pane(window).locator('.xterm-rows')).toContainText('before-42');
    const { cols, rows } = (await sessions(window))[0]!;

    const steps = await panAway(window);
    // As a session window opened on it would.
    await window.evaluate((session) => globalThis.window.agentBoard.sessions.resize(session, { cols: 50, rows: 20 }), id);
    await panBack(window, steps);

    await expect.poll(async () => pane(window).locator('.xterm').getAttribute('data-mark')).toBeNull();
    await expect.poll(() => seen(window, 'terminal.letGo')).toEqual([{ sessionId: id, reason: 'resized' }]);
    await expect.poll(() => seen(window, 'terminal.snapshot')).toHaveLength(1);
    await expect(pane(window).locator('.xterm-rows')).toContainText('before-42');
    await expect.poll(async () => (await sessions(window))[0]).toMatchObject({ cols, rows });

    await pane(window).click();
    await run(window, 'echo after-$((40 + 4))');
    await expect(pane(window).locator('.xterm-rows')).toContainText('after-44');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
