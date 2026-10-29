import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { Agent, AgentState, Zone } from '@agent-board/daemon/protocol';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { LINEAR_API_URL, type TrackerIssue } from '@agent-board/tracker';
import { RECORDED_LINEAR_FIXTURES, serveFixtures, type HttpInteraction } from '@agent-board/tracker/testing';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { drag } from './board-helpers.ts';
import { connectedDaemonPid, launchApp } from './launch.ts';

/** Launches the app on `dataDir` with `env` and extra switches `args`, and waits for it to reach its daemon. */
export async function launch(dataDir: string, env: Record<string, string>, args: string[] = []): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await launchApp(dataDir, env, args);
  const window = await app.firstWindow();
  await connectedDaemonPid(window);
  return { app, window };
}

/**
 * Lists every finished turn in Needs you, not only explicit requests: for tests of an agent waiting at its prompt,
 * which the inbox, the pill and notifications leave out by default.
 */
export async function listFinishedTurns(page: Page): Promise<void> {
  await page.evaluate(() => window.agentBoard.flowEdges.setSettings({ needsYouShows: 'turns' }));
}

// A plain, non-login sh: never the developer's own shell, rc files or profile.
export const SHELL_ENV = { SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' };

/** The key typed into the app's Linear prompts; the fixture server takes any. */
export const LINEAR_API_KEY = 'lin_api_e2e0123456789';

/**
 * The recorded Linear fixtures, served as the Linear API: what they were recorded against (`subject`), every request
 * and response (`interactions`, which `edit` may change before they are served), and the `server` the app's `AGENT_BOARD_LINEAR_API_URL` should point at.
 */
export async function serveLinearFixtures(edit?: (interactions: HttpInteraction[]) => void) {
  const { subject, interactions } = JSON.parse(readFileSync(RECORDED_LINEAR_FIXTURES, 'utf8')) as {
    subject: { scope: string; knownIssue: TrackerIssue; searchTerm: string };
    interactions: HttpInteraction[];
  };
  edit?.(interactions);
  // Fixtures match requests without headers, so Linear's recorded refusal of a revoked key would shadow `teams`.
  const server = await serveFixtures(
    interactions.filter((i) => i.response.status === 200),
    LINEAR_API_URL,
  );
  return { subject, interactions, server };
}

export const agents = (page: Page): Promise<Agent[]> => page.evaluate(() => window.agentBoard.agents.list());
export const zones = (page: Page): Promise<Zone[]> => page.evaluate(() => window.agentBoard.zones.list());
export const sessionWindow = (page: Page) => page.getByTestId('session-window');

/** Opens the details strip of a session window or expanded tile, which start collapsed to the icon rail. */
export async function showDetails(scope: Locator): Promise<void> {
  await scope.getByRole('button', { name: 'Show details' }).click();
  await expect(scope.getByRole('complementary', { name: 'Session details' })).toBeVisible();
}

/** The zone whose tab is named `name`. */
export const zoneNamed = (window: Page, name: string): Locator =>
  window.getByTestId('zone').filter({ has: window.getByTestId('zone-tab').getByText(name, { exact: true }) });

/**
 * Starts an agent with `prompt` from the zone named `zoneName`'s New agent button: a Claude one unless `harness` says
 * Codex (past Codex's one-time hooks notice), working on the zone tracker's issue `issue` if given. It waits until the agent has started, unless `started` is false.
 */
export async function spawnAgent(
  window: Page,
  zoneName: string,
  prompt: string,
  { harness = 'Claude', issue, name, started = true }: { harness?: 'Claude' | 'Codex'; issue?: string; name?: string; started?: boolean } = {},
): Promise<void> {
  await zoneNamed(window, zoneName).getByRole('button', { name: 'New agent' }).click();
  const form = window.getByRole('dialog', { name: 'New agent' });
  await pickInChip(form, 'Harness', harness);
  if (issue !== undefined) await form.getByRole('listbox', { name: 'Issues' }).getByRole('option').filter({ hasText: issue }).click();
  await form.getByLabel('Task').fill(prompt);
  if (name !== undefined) await form.getByLabel('Name').fill(name);
  await form.getByRole('button', { name: 'Start' }).click();
  // The form gives way either to the agent starting or, the first time, to Codex's notice in the same dialog.
  await expect(form).toBeHidden();
  const notice = window.getByRole('dialog', { name: 'About Codex hooks' });
  if (await notice.isVisible()) {
    await notice.getByRole('button', { name: 'Start' }).click();
    await expect(notice).toBeHidden();
  }
  if (started) await untilStarted(window);
}

/** The New agent dialog closes as soon as the start's tile is on the board: waits until every start is an agent, or failed. */
export async function untilStarted(window: Page): Promise<void> {
  await expect.poll(() => window.evaluate(async () => (await self.agentBoard.agents.starts()).some((start) => start.error === null))).toBe(false);
}

/**
 * Picks `choice` from one of a New agent form's footer chips: `Harness`, `Model` or `Role`. The chip's
 * name is "<chip>: <what it is now>".
 */
export async function pickInChip(form: Locator, chip: 'Harness' | 'Model' | 'Role', choice: string): Promise<void> {
  const button = form.getByRole('button', { name: new RegExp(`^${chip}:`) });
  await button.click();
  await form.page().getByRole('menuitem', { name: choice, exact: true }).click();
}

/** Sets the zone named `zoneName`'s tracker from its tab: `connect` fills the dialog in, and the tab then shows `shown`. */
export async function setZoneTracker(page: Page, zoneName: string, connect: (dialog: Locator) => Promise<void>, shown: string): Promise<void> {
  const tracker = zoneNamed(page, zoneName).getByTestId('zone-tab').getByRole('button', { name: 'Zone tracker' });
  await tracker.click();
  const dialog = page.getByRole('dialog', { name: 'Zone tracker' });
  await connect(dialog);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(tracker).toHaveText(shown);
}

/** A session window's own shortcut: ⌘ on macOS, Ctrl+Shift elsewhere, where Ctrl's keys are the terminal's. */
export const windowKey = (key: string) => `${process.platform === 'darwin' ? 'Meta' : 'Control+Shift'}+${key}`;

export const tile = (window: Page) => window.getByTestId('agent-tile');
export const screen = (window: Page) => window.getByTestId('session-terminal').locator('.xterm-rows');

/** Opens the board menu if it is closed, and returns it. */
export async function openBoardMenu(window: Page): Promise<Locator> {
  const panel = window.getByRole('dialog', { name: 'Board menu' });
  // Dispatched, not clicked: a session window's scrim may cover the island (⌘\\ reaches it from the keyboard).
  if (!(await panel.isVisible())) await window.getByRole('button', { name: 'Board menu' }).dispatchEvent('click');
  return panel;
}

/** Sets what a double-click on a tile opens, from the board menu's Settings, and closes the menu again. */
export async function setClickOpens(window: Page, opens: 'Session window' | 'Expand in place'): Promise<void> {
  const menu = await openBoardMenu(window);
  const choice = menu.getByRole('radiogroup', { name: 'Double-clicking a tile opens' }).getByRole('radio', { name: opens });
  await choice.check();
  await expect(choice).toBeChecked();
  await window.keyboard.press('Escape');
  await expect(menu).toBeHidden();
}

/** The board menu's running sessions, opening the menu first if it is closed. */
export async function sessionItems(window: Page): Promise<Locator> {
  return (await openBoardMenu(window)).getByTestId('session-item');
}

/** Picks `action` from a tile's More menu: Delete agent, Link issue…, Schedule…, Mute notifications, Delete shell. */
export async function tileAction(tile: Locator, action: string): Promise<void> {
  await tile.getByRole('button', { name: 'More' }).click();
  await tile.page().getByRole('menuitem', { name: action }).click();
}

/**
 * How long starting an agent (a worktree, then its harness) or a whole turn of the fake harness may take: a few seconds
 * alone, as git and each hook run processes of their own, and several times that on a loaded machine. For the
 * waits on one of those; everything else keeps Playwright's 5 s.
 */
export const TURN_MS = 20_000;

/** Starts recording every state the window hears its agents move through, into `window.agentStates`. */
export async function recordStates(page: Page): Promise<void> {
  await page.evaluate(() => {
    const states: string[] = [];
    (window as unknown as { agentStates: string[] }).agentStates = states;
    window.agentBoard.agents.onChanged((change) => {
      if (change.type === 'agent.updated' && states.at(-1) !== change.agent.state) states.push(change.agent.state);
    });
  });
}

export const recordedStates = (page: Page): Promise<AgentState[]> =>
  page.evaluate(() => (window as unknown as { agentStates: AgentState[] }).agentStates);

/**
 * Starts recording each character drawn in the window, as `pose/body`, into `window.characters`; with `onTile`, as
 * `pose/body@harness`, the harness of the tile it is drawn on.
 */
export async function recordCharacters(page: Page, { onTile = false } = {}): Promise<void> {
  await page.evaluate((onTile) => {
    const seen: string[] = [];
    (window as unknown as { characters: string[] }).characters = seen;
    const record = (node: Node) => {
      if (!(node instanceof Element)) return;
      for (const character of node.querySelectorAll('[data-testid="character"]')) {
        let drawn = `${character.getAttribute('data-pose')}/${character.getAttribute('data-body')}`;
        if (onTile) drawn += `@${character.closest('[data-testid="agent-tile"]')?.getAttribute('data-harness')}`;
        if (seen.at(-1) !== drawn) seen.push(drawn);
      }
    };
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach(record);
        if (mutation.type === 'attributes') record(mutation.target.parentNode as Node);
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-pose'] });
  }, onTile);
}

export const recordedCharacters = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { characters: string[] }).characters);

/** Starts the fake claude as if typed into another terminal: not through the app, with `home` as `~`. */
export function claudeInTerminal(cwd: string, home: string, args: string[], scenario: 'waiting' | 'output') {
  return spawn('claude', args, {
    cwd,
    env: fakeHarnessEnv({ scenario, home, stepDelayMs: 100, idleNotifyMs: 300 }),
  }) as ChildProcessWithoutNullStreams;
}

/**
 * Expects an issue card for `issueId` beside the agent's tile, not over it: their boxes don't intersect, the tile
 * would take a click, and the "issue brief" edge joins them. The board's edges aren't told apart by issue, so
 * `briefEdges` is how many it should draw in all.
 */
export async function expectCardBesideTile(window: Page, issueId: string, agentTile: Locator, briefEdges = 1): Promise<void> {
  const card = window.getByTestId('issue-card').filter({ hasText: issueId });
  await expect(card).toHaveCount(1);
  await expect(agentTile).toBeVisible();
  await expect(window.getByTestId('brief-edge')).toHaveCount(briefEdges);
  const [cardBox, tileBox] = [await card.boundingBox(), await agentTile.boundingBox()];
  expect(cardBox).not.toBeNull();
  expect(tileBox).not.toBeNull();
  const apart =
    cardBox!.x + cardBox!.width <= tileBox!.x ||
    tileBox!.x + tileBox!.width <= cardBox!.x ||
    cardBox!.y + cardBox!.height <= tileBox!.y ||
    tileBox!.y + tileBox!.height <= cardBox!.y;
  expect(apart, `card ${JSON.stringify(cardBox)} and tile ${JSON.stringify(tileBox)} overlap`).toBe(true);
  // Nothing covers the tile: a trial click checks what is under the pointer without clicking.
  await agentTile.click({ trial: true });
}

/** A model id of the length a typed one can have ("Other…"). */
export const LONG_MODEL = 'claude-opus-5-5-20261001-experimental';

/**
 * Starts an agent in the zone `monorepo` on `LONG_MODEL` and as a follow-up reviewer, then mutes it and gives it a
 * schedule: its tile's footer has a model badge, a role badge, a clock and a bell, as crowded as the app lets a test make it.
 */
export async function startCrowdedAgent(page: Page): Promise<void> {
  await zoneNamed(page, 'monorepo').getByRole('button', { name: 'New agent' }).click();
  const form = page.getByRole('dialog', { name: 'New agent' });
  await pickInChip(form, 'Model', 'Other…');
  await form.getByRole('textbox', { name: 'Model id' }).fill(LONG_MODEL);
  await pickInChip(form, 'Role', 'Follow-up reviewer');
  await form.getByLabel('Task').fill('Build it');
  await form.getByRole('button', { name: 'Start' }).click();
  await expect(form).toBeHidden();
  await expect(tile(page)).toHaveCount(1);
  const [agent] = await agents(page);
  await page.evaluate(async (sessionId) => {
    await window.agentBoard.agents.setMuted(sessionId, true);
    await window.agentBoard.agents.setSchedule(sessionId, { cron: '0 9 * * 2', prompt: 'Go' });
  }, agent!.sessionId);
}

/** Starts an agent in the zone `monorepo` on a short model id and as an implementer: a tile whose footer has room for its badges and little more. */
export async function startBadgedAgent(page: Page): Promise<void> {
  await zoneNamed(page, 'monorepo').getByRole('button', { name: 'New agent' }).click();
  const form = page.getByRole('dialog', { name: 'New agent' });
  await pickInChip(form, 'Model', 'Other…');
  await form.getByRole('textbox', { name: 'Model id' }).fill('claude-opus-5-5');
  await pickInChip(form, 'Role', 'Implementer');
  await form.getByLabel('Task').fill('Build it');
  await form.getByRole('button', { name: 'Start' }).click();
  await expect(form).toBeHidden();
  await expect(tile(page)).toHaveCount(1);
}

/** Selects the tile `of` with a click on its body and drags its right edge by `dx` screen pixels (negative narrows it). */
export async function narrowBy(page: Page, of: Locator, dx: number): Promise<void> {
  const box = await of.boundingBox();
  await page.mouse.click(box!.x + box!.width - 12, box!.y + box!.height / 2);
  const handle = (await page.locator('.react-flow__node.selected .tile-resize.bottom.right').boundingBox())!;
  const [x, y] = [handle.x + handle.width / 2, handle.y + handle.height / 2];
  await drag(page, { x, y }, { x: x + dx, y });
}

/**
 * Ends the agent and closes the shell its pane drops into, so it is closed in the board's sense (a folded chip): an agent
 * that has only ended keeps its tile and its Restart while that shell runs.
 */
export async function closeAgent(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const { agents, sessions } = globalThis.window.agentBoard;
    await agents.stop(id);
    for (let tries = 0; tries < 100; tries++) {
      const shell = (await agents.list()).find((agent) => agent.sessionId === id)?.shellSessionId;
      if (shell) return void (await sessions.kill(shell));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, sessionId);
}

/**
 * Makes the zones added from now on normal spacing, the gaps a test written in px for a zone's slots and padding uses
 * (a new zone is roomy otherwise).
 */
export async function normalNewZones(page: Page): Promise<void> {
  await page.evaluate(() => window.agentBoard.flowEdges.setSettings({ arrangeSpacing: 'normal' }));
}
