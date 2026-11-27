import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, sessionWindow, setClickOpens, spawnAgent, tile, windowKey, zones } from './agent-helpers.ts';
import { test, browseForZone, pickFolderNext, removeDataDir, runDesign, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

// ⌘K and the app's other keys from anywhere, in every view an agent is open in, the focus in its terminal; and what
// picking a row does there. The popped-out window's switcher is in spotlight.spec.ts.

const spotlight = (page: Page) => page.getByRole('dialog', { name: 'Jump to a session, zone or setting' });
const field = (page: Page) => spotlight(page).getByRole('combobox', { name: 'Jump to a session, zone or setting' });
const agentTile = (page: Page, name: string) => tile(page).filter({ hasText: name });

/** Whether the focus is in a terminal inside `scope` (a CSS selector), as typing there would reach it. */
const terminalFocusedIn = (page: Page, scope: string) =>
  page.evaluate((scope) => {
    const active = document.activeElement;
    return active?.classList.contains('xterm-helper-textarea') === true && active.closest(scope) !== null;
  }, scope);

/** Gives the keyboard to the terminal in `scope`, its view switched to the terminal where it shows the chat. */
async function focusTerminal(page: Page, scope: string): Promise<void> {
  const view = page.locator(scope);
  const terminal = view.getByTestId('session-terminal').first();
  if (!(await terminal.isVisible())) await view.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Terminal' }).first().click();
  await terminal.click();
  await expect.poll(() => terminalFocusedIn(page, scope)).toBe(true);
}

/** Opens ⌘K from where the focus is, and closes it with Esc: the focus goes back to the terminal in `scope`. */
async function switcherFrom(page: Page, scope: string): Promise<void> {
  await page.keyboard.press(windowKey('k'));
  await expect(field(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(spotlight(page)).toHaveCount(0);
  await expect.poll(() => terminalFocusedIn(page, scope)).toBe(true);
}

test("on the board ↵ flies to the tile picked and ⇧↵ opens its view; from the pop-up's terminal ⌘K and ⌘⇧P open, ↵ opens the agent picked in the pop-up's place, and a zone closes it onto the board", async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  // The app's own default, the pop-up.
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_CLICK_OPENS: '' });
  try {
    await window.emulateMedia({ reducedMotion: 'reduce' });
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await spawnAgent(window, 'monorepo', 'Tidy the docs');
    await expect(window.locator('.board[data-click-opens]')).toHaveAttribute('data-click-opens', 'popup');
    const listed = await agents(window);
    const idOf = (name: string) => listed.find((agent) => agent.name === name)!.sessionId;
    const popup = window.getByTestId('agent-popup');
    const inPopUp = '[data-testid="agent-popup"]';

    // On the board, ↵ flies to the tile picked and selects it; nothing opens.
    await window.keyboard.press(windowKey('k'));
    await expect(spotlight(window).getByTestId('spotlight-where')).toHaveText('↵ show · ⇧↵ open');
    await window.keyboard.type('tidy');
    await window.keyboard.press('Enter');
    await expect(spotlight(window)).toHaveCount(0);
    await expect(window.locator('.react-flow__node.selected')).toContainText('Tidy the docs');
    await expect(popup).toHaveCount(0);

    // Zoomed in past the zone's edges, for a zone picked in the pop-up to bring it back into view.
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

    // ⇧↵ opens the view of the tile picked, another one selected, as a double-click on it does: here, its pop-up.
    await window.keyboard.press(windowKey('k'));
    await window.keyboard.type('databa');
    await window.keyboard.press('Shift+Enter');
    await expect(spotlight(window)).toHaveCount(0);
    await expect(popup).toHaveAttribute('data-session-id', idOf('Pick a database'));
    await focusTerminal(window, inPopUp);

    // The pop-up is a dialog, and its terminal has the focus: ⌘K opens all the same, ↵ here opening in the pop-up.
    await window.keyboard.press(windowKey('k'));
    await expect(field(window)).toBeFocused();
    await expect(spotlight(window).getByTestId('spotlight-where')).toHaveText('↵ switch here');
    await window.keyboard.press('Escape');
    await expect(spotlight(window)).toHaveCount(0);
    await expect(popup).toHaveAttribute('data-session-id', idOf('Pick a database'));
    await expect.poll(() => terminalFocusedIn(window, inPopUp)).toBe(true);

    // So does Park a thought.
    await window.keyboard.press('ControlOrMeta+Shift+KeyP');
    const line = window.getByTestId('park-thought').getByRole('textbox', { name: 'Park a thought' });
    await expect(line).toBeFocused();
    await window.keyboard.press('Escape');
    await expect(line).toHaveCount(0);
    await expect.poll(() => terminalFocusedIn(window, inPopUp)).toBe(true);

    // ↵ opens the agent picked in the pop-up's place: no session window, nothing expanded.
    await window.keyboard.press(windowKey('k'));
    await window.keyboard.type('tidy');
    await window.keyboard.press('Enter');
    await expect(spotlight(window)).toHaveCount(0);
    await expect(popup).toHaveAttribute('data-session-id', idOf('Tidy the docs'));
    await expect(popup).toHaveCount(1);
    await expect(sessionWindow(window)).toHaveCount(0);
    await expect(window.getByTestId('expanded-tile')).toHaveCount(0);

    // A zone it can't show: the pop-up closes onto the board, the whole zone in view.
    await expect.poll(zoneWhollyInView).toBe(false);
    await window.keyboard.press(windowKey('k'));
    await window.keyboard.type('monorepo');
    await expect(spotlight(window).getByTestId('spotlight-row').first()).toHaveAttribute('data-kind', 'zone');
    await window.keyboard.press('Enter');
    await expect(popup).toHaveCount(0);
    await expect.poll(zoneWhollyInView).toBe(true);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⌘K opens from the terminal of every other view an agent is open in: the expanded tile, the session window and a ticket's tile", async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await window.emulateMedia({ reducedMotion: 'reduce' });
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');

    await setClickOpens(window, 'Expand in place');
    await agentTile(window, 'Pick a database').dblclick();
    await expect(window.getByTestId('expanded-tile')).toHaveCount(1);
    await focusTerminal(window, '.expanded-tile');
    await switcherFrom(window, '.expanded-tile');
    await window.getByTestId('expanded-tile').getByRole('button', { name: 'Collapse', exact: true }).click();
    await expect(window.getByTestId('expanded-tile')).toHaveCount(0);

    await setClickOpens(window, 'Session window');
    await agentTile(window, 'Pick a database').dblclick();
    await expect(sessionWindow(window).getByRole('heading')).toHaveText('Pick a database');
    if (runDesign() === 'simplified') await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Terminal' }).click();
    await focusTerminal(window, '[data-testid="session-window"]');
    await switcherFrom(window, '[data-testid="session-window"]');
    // Classic's Close, the Simplified header's Done.
    await window.getByRole('button', { name: /^(Close session window|Done, close )/ }).click();
    await expect(sessionWindow(window)).toHaveCount(0);

    // A ticket's tile opens as its chat's terminal, in place.
    const [zone] = await zones(window);
    const chat = await window.evaluate(async (zoneId) => {
      const result = await globalThis.window.agentBoard.agents.spawn({ zoneId, prompt: 'Watch settings for a zone', ticketChat: true, cols: 100, rows: 30 });
      if (result.status !== 'started') throw new Error(result.message);
      return result.agent;
    }, zone!.id);
    const ticket = `[data-testid="expanded-tile"][data-session-id="${chat.sessionId}"]`;
    await expect(window.locator(ticket)).toHaveAttribute('data-ticket-open', 'terminal', { timeout: 30_000 });
    await focusTerminal(window, ticket);
    await switcherFrom(window, ticket);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
