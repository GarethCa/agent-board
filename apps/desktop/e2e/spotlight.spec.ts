import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, listFinishedTurns, sessionWindow, setClickOpens, SHELL_ENV, spawnAgent, tile, TURN_MS, windowKey, zones } from './agent-helpers.ts';
import { test, addEmptyZone, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';
import { serveWebPages } from './web-server.ts';

const spotlight = (page: Page) => page.getByRole('dialog', { name: 'Jump to a session or zone' });
const field = (page: Page) => spotlight(page).getByRole('combobox', { name: 'Jump to a session or zone' });
const agentTile = (page: Page, name: string) => tile(page).filter({ hasText: name });
const shellTile = (page: Page, name: string) => page.getByTestId('shell-tile').filter({ hasText: name });

/** Makes a shell tile named `name` in the zone at `position`, with the daemon's API, and returns its id. */
async function shellAt(page: Page, name: string, zoneId: string, position: { x: number; y: number }): Promise<string> {
  const id = await page.evaluate(
    async ({ name, zoneId, position }) => {
      const shell = await window.agentBoard.shells.create({ zoneId, position });
      await window.agentBoard.shells.setName(shell.id, name);
      return shell.id;
    },
    { name, zoneId, position },
  );
  await expect(shellTile(page, name)).toBeVisible();
  return id;
}

/** Whether the focus is in a terminal inside `scope` (a CSS selector), as typing there would reach it. */
const terminalFocusedIn = (page: Page, scope: string) =>
  page.evaluate((scope) => {
    const active = document.activeElement;
    return active?.classList.contains('xterm-helper-textarea') === true && active.closest(scope) !== null;
  }, scope);

/**
 * Records, from now on, each tile pulsed (its text) and each place the board's view moved to: read back with `watched`.
 * Recorded as they happen, so a check never races the pulse's short life.
 */
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen = { pulsed: [] as string[], views: [] as string[] };
    (globalThis as { watched?: typeof seen }).watched = seen;
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport')!;
    new MutationObserver((records) => {
      for (const { target } of records) {
        if (target === viewport) seen.views.push(viewport.style.transform);
        else if (target instanceof Element && target.hasAttribute('data-pulse')) seen.pulsed.push(target.textContent ?? '');
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-pulse', 'style'] });
  });
}
const watched = (page: Page) => page.evaluate(() => (globalThis as { watched?: { pulsed: string[]; views: string[] } }).watched!);

/** How far the tile's centre is from the board's, in screen pixels. */
async function offCentre(page: Page, name: string): Promise<number> {
  const board = (await page.locator('.react-flow').boundingBox())!;
  const box = await agentTile(page, name).boundingBox();
  if (box === null) return Infinity;
  return Math.hypot(box.x + box.width / 2 - (board.x + board.width / 2), box.y + box.height / 2 - (board.y + board.height / 2));
}

async function twoAgents(app: ElectronApplication, window: Page, repo: string): Promise<void> {
  await pickFolderNext(app, repo);
  await browseForZone(window);
  await spawnAgent(window, 'monorepo', 'Pick a database');
  await spawnAgent(window, 'monorepo', 'Tidy the docs');
  await expect(tile(window)).toHaveCount(2);
}

test('⌘K on the board finds an agent by part of its name and flies to its tile, leaving it selected; Esc puts the focus back', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  await listFinishedTurns(window);
  try {
    await twoAgents(app, window, repo);
    // Away from the tile, so flying there has somewhere to go.
    await window.getByRole('button', { name: 'Zoom Out' }).click();
    await window.mouse.wheel(0, 600);

    // Before anything is typed it lists the sessions and the zone, and says ↵ shows the tile here.
    const fit = window.getByRole('button', { name: 'Fit View' });
    await fit.focus();
    await window.keyboard.press(windowKey('k'));
    await expect(field(window)).toBeFocused();
    await expect(spotlight(window).getByTestId('spotlight-where')).toHaveText('↵ show on board');
    await expect(spotlight(window).getByTestId('spotlight-row')).toHaveCount(3);
    await window.keyboard.press('Escape');
    await expect(spotlight(window)).toHaveCount(0);
    await expect(fit).toBeFocused();

    await window.keyboard.press(windowKey('k'));
    await window.keyboard.type('databa');
    const rows = spotlight(window).getByTestId('spotlight-row');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('Pick a database');
    await watch(window);
    await window.keyboard.press('Enter');
    await expect(spotlight(window)).toHaveCount(0);
    await expect(window.locator('.react-flow__node.selected').getByTestId('agent-tile')).toContainText('Pick a database');
    await expect.poll(async () => (await watched(window)).pulsed.join()).toContain('Pick a database');
    await expect.poll(() => offCentre(window, 'Pick a database')).toBeLessThan(4);
    // It flew there, through the frames between.
    expect(new Set((await watched(window)).views).size).toBeGreaterThan(1);
    // Shown, not opened.
    await expect(sessionWindow(window)).toHaveCount(0);
    await expect(window.getByTestId('expanded-tile')).toHaveCount(0);

    // With reduced motion it jumps there instead, in one step.
    await window.emulateMedia({ reducedMotion: 'reduce' });
    await window.getByRole('button', { name: 'Zoom Out' }).click();
    await window.mouse.wheel(0, 600);
    await expect.poll(() => offCentre(window, 'Tidy the docs')).toBeGreaterThan(100);
    await window.keyboard.press(windowKey('k'));
    await window.keyboard.type('tidy');
    await watch(window);
    await window.keyboard.press('Enter');
    await expect.poll(() => offCentre(window, 'Tidy the docs')).toBeLessThan(4);
    await expect.poll(async () => (await watched(window)).pulsed.join()).toContain('Tidy the docs');
    expect(new Set((await watched(window)).views).size).toBe(1);

    // ⌘↵ opens it, as Enter on the selected tile does: its session window.
    await window.keyboard.press(windowKey('k'));
    await window.keyboard.type('tidy');
    await window.keyboard.press(windowKey('Enter'));
    await expect(sessionWindow(window).getByRole('heading')).toHaveText('Tidy the docs');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⌘K from a session window’s terminal switches the window to the agent picked, focus in its terminal; Esc goes back to the terminal', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  await listFinishedTurns(window);
  try {
    await twoAgents(app, window, repo);
    await agentTile(window, 'Tidy the docs').dblclick();
    await expect(sessionWindow(window).getByRole('heading')).toHaveText('Tidy the docs');
    await sessionWindow(window).getByTestId('session-terminal').click();
    await expect.poll(() => terminalFocusedIn(window, '[data-testid="session-window"]')).toBe(true);

    // The terminal doesn't keep ⌘K: the switcher opens, and Esc gives the terminal its focus back.
    await window.keyboard.press(windowKey('k'));
    await expect(field(window)).toBeFocused();
    await expect(spotlight(window).getByTestId('spotlight-where')).toHaveText('↵ switch here');
    await window.keyboard.press('Escape');
    await expect(spotlight(window)).toHaveCount(0);
    await expect.poll(() => terminalFocusedIn(window, '[data-testid="session-window"]')).toBe(true);
    await expect(sessionWindow(window).getByRole('heading')).toHaveText('Tidy the docs');

    await window.keyboard.press(windowKey('k'));
    await window.keyboard.type('databa');
    await window.keyboard.press('Enter');
    await expect(sessionWindow(window).getByRole('heading')).toHaveText('Pick a database');
    await expect(sessionWindow(window)).toHaveCount(1);
    await expect.poll(() => terminalFocusedIn(window, '[data-testid="session-window"]')).toBe(true);

    // A zone picked leaves the window for the board, the zone in view.
    await window.keyboard.press(windowKey('k'));
    await window.keyboard.type('monorepo');
    await expect(spotlight(window).getByTestId('spotlight-row').first()).toHaveAttribute('data-kind', 'zone');
    await window.keyboard.press('Enter');
    await expect(sessionWindow(window)).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⌘K from an expanded tile’s terminal expands the agent picked in its place, focus in its terminal; a zone collapses it', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  await listFinishedTurns(window);
  try {
    await twoAgents(app, window, repo);
    await setClickOpens(window, 'Expand in place');
    const listed = await agents(window);
    const [tidy, database] = ['Tidy the docs', 'Pick a database'].map((name) => listed.find((agent) => agent.name === name)!.sessionId);
    await agentTile(window, 'Tidy the docs').dblclick();
    const expanded = window.getByTestId('expanded-tile');
    await expect(expanded).toHaveAttribute('data-session-id', tidy!);
    await expanded.getByTestId('session-terminal').click();
    await expect.poll(() => terminalFocusedIn(window, '.expanded-tile')).toBe(true);

    await window.keyboard.press(windowKey('k'));
    await expect(spotlight(window).getByTestId('spotlight-where')).toHaveText('↵ switch here');
    // Esc closes the switcher only: the tile stays expanded, its terminal focused.
    await window.keyboard.press('Escape');
    await expect(spotlight(window)).toHaveCount(0);
    await expect(expanded).toHaveAttribute('data-session-id', tidy!);
    await expect.poll(() => terminalFocusedIn(window, `.expanded-tile[data-session-id="${tidy}"]`)).toBe(true);

    await window.keyboard.press(windowKey('k'));
    await window.keyboard.type('databa');
    await window.keyboard.press('Enter');
    await expect(expanded).toHaveCount(1);
    await expect(expanded).toHaveAttribute('data-session-id', database!);
    await expect.poll(() => terminalFocusedIn(window, `.expanded-tile[data-session-id="${database}"]`)).toBe(true);

    await window.keyboard.press(windowKey('k'));
    await window.keyboard.type('monorepo');
    await window.keyboard.press('Enter');
    await expect(expanded).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⌘K with no match offers a new agent by that name, in the zone', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  await listFinishedTurns(window);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await window.keyboard.press(windowKey('k'));
    await window.keyboard.type('Write the changelog');
    await expect(spotlight(window).getByTestId('spotlight-row')).toHaveCount(0);
    await expect(spotlight(window).getByTestId('spotlight-new-agent')).toHaveText('New agent named ‘Write the changelog’');
    await window.keyboard.press('Enter');
    const form = window.getByRole('dialog', { name: 'New agent' });
    await expect(form.getByLabel('Name')).toHaveValue('Write the changelog');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the switcher follows the board while it is open: an agent that starts asking moves into Needs you, and the row picked stays picked', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  await listFinishedTurns(window);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    // Seen, so it is Recent rather than Needs you.
    await tile(window).dblclick();
    await window.getByRole('button', { name: 'Close session window' }).click();

    await window.keyboard.press(windowKey('k'));
    const groups = spotlight(window).locator('.spotlight-group');
    await expect(groups).toHaveText(['Recent', 'Zones']);
    await window.keyboard.press('ArrowDown');
    const picked = spotlight(window).getByRole('option', { selected: true });
    await expect(picked).toContainText('monorepo');

    // Another agent starts and asks, the switcher still open.
    const [zone] = await zones(window);
    await window.evaluate(
      async (params) => {
        const result = await globalThis.window.agentBoard.agents.spawn(params);
        if (result.status !== 'started') throw new Error(result.message);
      },
      { zoneId: zone!.id, prompt: 'Name the tables', position: { x: 320, y: 40 }, cols: 100, rows: 30 },
    );
    await expect(groups).toHaveText(['Needs you · 1', 'Recent', 'Zones'], { timeout: TURN_MS });
    await expect(spotlight(window).getByTestId('spotlight-row').first()).toContainText('Name the tables');
    // The row picked is the same row, not the same place in the list.
    await expect(picked).toContainText('monorepo');
    await expect(spotlight(window)).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⌘K pressed in a web tab’s page opens the switcher, which takes the keyboard; Esc gives it back to the page', async () => {
  const server = await serveWebPages();
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  await listFinishedTurns(window);
  /**
   * The web contents given the keyboard from now on, by URL, as the main process asks it to: an e2e window in the
   * background never holds the OS's focus, so who has it can't be read back.
   */
  const watchFocus = () =>
    app.evaluate(({ webContents }) => {
      const asked: string[] = [];
      (globalThis as { focusAsked?: string[] }).focusAsked = asked;
      for (const contents of webContents.getAllWebContents()) {
        const focus = contents.focus.bind(contents);
        contents.focus = () => {
          asked.push(contents.getURL());
          focus();
        };
      }
    });
  const focusAsked = () => app.evaluate(() => (globalThis as { focusAsked?: string[] }).focusAsked ?? []);
  try {
    await addEmptyZone(window, 'Frontend');
    await window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' }).click();
    await sessionWindow(window).getByRole('button', { name: 'New tab' }).click();
    await window.getByRole('menuitem', { name: 'Web…' }).click();
    // A new tab has no page and its address bar is focused: the URL typed there loads.
    const address = window.getByTestId('web-address');
    await expect(address).toBeFocused();
    await address.fill(server.url);
    await address.press('Enter');
    await expect.poll(() => app.windows().some((page) => page.url().startsWith(server.url))).toBe(true);
    const page = app.windows().find((each) => each.url().startsWith(server.url))!;
    await expect(page.locator('h1')).toHaveText('Dev home');
    await page.locator('h1').click();
    await watchFocus();

    // Pressed in the page, it reaches the window, which takes the keyboard for the switcher's field. Sent as the OS
    // sends it, through the page's input: Playwright's own keys reach the page past the hook main reads them from.
    await app.evaluate(({ webContents }, { url, mac }) => {
      const contents = webContents.getAllWebContents().find((each) => each.getURL().startsWith(url))!;
      const modifiers: ('meta' | 'control' | 'shift')[] = mac ? ['meta'] : ['control', 'shift'];
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'K', modifiers });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'K', modifiers });
    }, { url: server.url, mac: process.platform === 'darwin' });
    await expect(field(window)).toBeFocused();
    await expect.poll(async () => (await focusAsked()).some((url) => !url.startsWith(server.url))).toBe(true);
    await expect(sessionWindow(window).getByTestId('web-page')).not.toHaveAttribute('data-drawn');
    await window.keyboard.press('Escape');
    await expect(spotlight(window)).toHaveCount(0);
    await expect.poll(async () => (await focusAsked()).at(-1)).toMatch(new RegExp(`^${server.url}`));
    await expect(sessionWindow(window).getByTestId('web-page')).toHaveAttribute('data-drawn', 'true');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    await server.close();
  }
});

test('a popped-out window has the switcher too: ↵ shows the session picked in it, and a zone on the board; from an expanded tile, a popped-out session comes forward and the tile stays', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  await listFinishedTurns(window);
  try {
    await addEmptyZone(window, 'Frontend');
    const zone = (await zones(window))[0]!;
    await shellAt(window, 'alpha', zone.id, { x: 20, y: 40 });
    const bravo = await shellAt(window, 'bravo', zone.id, { x: 380, y: 40 });
    const charlie = await shellAt(window, 'charlie', zone.id, { x: 20, y: 240 });

    await shellTile(window, 'alpha').dblclick();
    const [popped] = await Promise.all([app.waitForEvent('window'), sessionWindow(window).getByRole('button', { name: 'Pop out session window' }).click()]);
    const poppedWindow = popped.getByTestId('session-window');
    await expect(poppedWindow.getByRole('heading')).toHaveText('alpha');
    await popped.getByTestId('shell-pane').first().click();
    await expect.poll(() => terminalFocusedIn(popped, '[data-testid="session-window"]')).toBe(true);

    // Opened from its terminal, Esc gives the terminal its focus back.
    await popped.keyboard.press(windowKey('k'));
    await expect(field(popped)).toBeFocused();
    await expect(spotlight(popped).getByTestId('spotlight-where')).toHaveText('↵ switch here');
    await popped.keyboard.press('Escape');
    await expect(spotlight(popped)).toHaveCount(0);
    await expect.poll(() => terminalFocusedIn(popped, '[data-testid="session-window"]')).toBe(true);

    // ↵ shows the session picked in the same OS window, its terminal focused, and the board's dock follows.
    await popped.keyboard.press(windowKey('k'));
    await popped.keyboard.type('brav');
    await popped.keyboard.press('Enter');
    await expect(poppedWindow.getByRole('heading')).toHaveText('bravo');
    await expect.poll(() => terminalFocusedIn(popped, '[data-testid="session-window"]')).toBe(true);
    await expect(window.getByTestId('dock-item')).toHaveCount(1);
    await expect(window.getByTestId('dock-item')).toHaveAttribute('data-shell-id', bravo);
    await expect(window.getByTestId('dock-item')).toHaveAttribute('data-placement', 'popped');

    // A zone picked there is the board's to show: its window brings the whole zone into view.
    const board = (await window.locator('.react-flow').boundingBox())!;
    const zoneWhollyInView = async () => {
      const box = await window.getByTestId('zone').boundingBox();
      return box !== null && box.x >= board.x && box.y >= board.y && box.x + box.width <= board.x + board.width && box.y + box.height <= board.y + board.height;
    };
    await window.getByRole('button', { name: 'Zoom In' }).click();
    await window.getByRole('button', { name: 'Zoom In' }).click();
    await window.mouse.move(board.x + board.width / 2, board.y + board.height / 2);
    await window.mouse.wheel(0, 600);
    await expect.poll(zoneWhollyInView).toBe(false);
    await popped.keyboard.press(windowKey('k'));
    await popped.keyboard.type('Frontend');
    await expect(spotlight(popped).getByTestId('spotlight-row').first()).toHaveAttribute('data-kind', 'zone');
    await popped.keyboard.press('Enter');
    await expect.poll(zoneWhollyInView).toBe(true);
    await expect(poppedWindow.getByRole('heading')).toHaveText('bravo');

    // In an expanded tile, picking the popped-out session leaves the tile as it is.
    await setClickOpens(window, 'Expand in place');
    await shellTile(window, 'charlie').dblclick();
    const expanded = window.getByTestId('expanded-tile');
    await expect(expanded).toHaveAttribute('data-shell-id', charlie);
    await expanded.getByTestId('shell-pane').first().click();
    await window.keyboard.press(windowKey('k'));
    await window.keyboard.type('brav');
    await window.keyboard.press('Enter');
    await expect(spotlight(window)).toHaveCount(0);
    await expect(expanded).toHaveCount(1);
    await expect(expanded).toHaveAttribute('data-shell-id', charlie);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
