import { expect } from '@playwright/test';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { launch, sessionWindow, SHELL_ENV, spawnAgent, tile, TURN_MS } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';

/** Makes `git worktree add` in `repo` take `seconds` longer, as on a slow disk: its checkout hook sleeps. */
function slowCheckout(repo: string, seconds: number): void {
  const hook = join(repo, '.git', 'hooks', 'post-checkout');
  writeFileSync(hook, `#!/bin/sh\nsleep ${seconds}\n`);
  chmodSync(hook, 0o755);
}

test('a new agent is on the board at once, shows its steps and its harness starting, then turns into a live tile', async () => {
  const { dir, repo, env } = scratch('output');
  slowCheckout(repo, 2);
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, FAKE_HARNESS_START_DELAY_MS: '3000' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);

    await spawnAgent(window, 'monorepo', 'Pick a cache for the job queue', { started: false });
    // The dialog closed and the start's tile is there while git is still making the worktree: no agent yet.
    const start = window.getByTestId('start-tile');
    await expect(start).toBeVisible();
    await expect(tile(window)).toHaveCount(0);
    await expect(start).toHaveAttribute('data-start', 'starting');
    await expect(start).toContainText('Pick a cache for the job queue');
    await expect(start.getByTestId('start-steps')).toContainText('creating worktree…');

    // Its session runs: the agent's own tile, still dashed, lists what was done and shows its harness starting.
    const agent = tile(window);
    await expect(agent).toHaveAttribute('data-start', 'starting', { timeout: 10_000 });
    await expect(start).toHaveCount(0);
    // Only the step it is on.
    await expect(agent.getByTestId('start-steps').locator('.hybrid-tile-step')).toHaveCount(1);
    await expect(agent.getByTestId('start-steps')).toContainText('starting Claude…');
    await expect(agent.getByTestId('start-output')).toHaveText('claude is starting');

    // Once its first hook comes, it is a normal live tile with its task.
    await expect(agent).not.toHaveAttribute('data-start', /.*/, { timeout: TURN_MS });
    await expect(agent.getByTestId('tile-description')).toContainText('Pick a cache for the job queue');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a harness that exits as it starts leaves its tile with the error, Retry and Delete', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, FAKE_HARNESS_START_FAIL: 'ANTHROPIC_API_KEY not set' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);

    await spawnAgent(window, 'monorepo', 'Pick a cache');
    const agent = tile(window);
    await expect(agent).toHaveAttribute('data-start', 'failed', { timeout: 10_000 });
    await expect(agent.getByTestId('start-steps')).toContainText('claude exited (code 1)');
    await expect(agent.getByTestId('start-error')).toHaveText('ANTHROPIC_API_KEY not set');
    await expect(agent.getByRole('button', { name: 'Retry' })).toBeVisible();

    await agent.getByRole('button', { name: 'Delete' }).click();
    // Deleted at once, or after a confirm, whichever the board asks for.
    const confirm = window.getByRole('alertdialog');
    await expect.poll(async () => (await agent.count()) === 0 || (await confirm.isVisible())).toBe(true);
    if (await confirm.isVisible()) await confirm.getByRole('button', { name: /^Delete/ }).click();
    await expect(agent).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

const LONG_ERROR = 'ANTHROPIC_API_KEY not set: export it, or log in with claude login, then retry the start';

test('a start with a long name that goes from starting to failed keeps its error and its buttons inside its tile', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, FAKE_HARNESS_START_DELAY_MS: '4000', FAKE_HARNESS_START_FAIL: LONG_ERROR });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);

    await spawnAgent(window, 'monorepo', 'Pick a cache', { name: 'Rework the movable sessions follow-up so the dock keeps up', started: false });
    const agent = tile(window);
    await expect(agent).toHaveAttribute('data-start', 'starting', { timeout: 10_000 });
    const [starting] = await startingTiles(window);
    expect(starting).toMatchObject({ outside: [], shown: [] });

    // The harness exits: the tile now lists all its steps and the error. It has no room for the done ones, which drop.
    await expect(agent).toHaveAttribute('data-start', 'failed', { timeout: 15_000 });
    await expect(agent.getByTestId('start-error')).toHaveText(LONG_ERROR);
    const [failed] = await startingTiles(window, '[data-testid="agent-tile"][data-start="failed"]');
    expect(failed).toMatchObject({ outside: [], shown: [] });
    expect(failed!.errorHeight).toBeGreaterThanOrEqual(14);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** What the page says of a starting tile, measured in one go so that a tile going live meanwhile can't hang the read. */
interface StartingTile {
  id: string;
  name: string;
  /** What of its visible descendants lies outside its box, as lines. An orchestrator's crew count sits on its corner by design. */
  outside: string[];
  /** Which of the rows and badges that can't apply yet are drawn. */
  shown: string[];
  /** Whether its "+N" chip is drawn. */
  folded: boolean;
  /** How tall its start's error shows, 0 with none. */
  errorHeight: number;
  /** The first 11 characters of its name lie inside its box: not clamped away. */
  nameLeads: boolean;
}

const HIDDEN_WHILE_STARTING = ['tile-set-by', 'tile-pr', 'tile-finished', 'tile-review', 'tile-plan', 'tile-docs', 'tile-gate', 'from-chip', 'tile-repo', 'checkout-warning', 'crew-flags'];

const STARTING = '[data-testid="agent-tile"][data-start="starting"]';
const EVERY_TILE = '[data-testid="agent-tile"], [data-testid="start-tile"]';

/** Every tile matching `selector` (the agent tiles still starting, by default), measured. */
function startingTiles(window: Page, selector = STARTING): Promise<StartingTile[]> {
  return window.evaluate(([hidden, match]: [string[], string]) => {
    const tiles = [...document.querySelectorAll<HTMLElement>(match)];
    return tiles.map((root) => {
      const box = root.getBoundingClientRect();
      const outside = [...root.querySelectorAll<HTMLElement>('*')]
        .filter((each) => each.offsetParent !== null && !each.matches('.hybrid-tile-crew-count') && each.getBoundingClientRect().width > 0)
        .flatMap((each) => {
          const at = each.getBoundingClientRect();
          const over = Math.max(box.left - at.left, at.right - box.right, box.top - at.top, at.bottom - box.bottom);
          return over > 0.5 ? [`${each.className || each.tagName} runs out by ${over.toFixed(1)}px`] : [];
        });
      const drawn = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)].some((each) => each.offsetParent !== null);
      return {
        id: root.dataset.sessionId ?? '',
        name: root.querySelector('.hybrid-tile-name')?.textContent ?? '',
        outside,
        shown: [...hidden.map((testid) => (drawn(`[data-testid="${testid}"]`) ? testid : '')), drawn('.hybrid-tile-subtitle') ? 'subtitle' : ''].filter(Boolean),
        folded: drawn('[data-testid="tile-folded"]'),
        errorHeight: root.querySelector<HTMLElement>('[data-testid="start-error"]')?.getBoundingClientRect().height ?? 0,
        nameLeads: (() => {
          const name = root.querySelector<HTMLElement>('.hybrid-tile-name');
          const text = name?.firstChild;
          if (name === null || name === undefined || text?.nodeType !== Node.TEXT_NODE) return false;
          const range = document.createRange();
          range.setStart(text, 0);
          range.setEnd(text, Math.min(11, text.textContent?.length ?? 0));
          const at = range.getBoundingClientRect();
          const box = name.getBoundingClientRect();
          return at.width > 0 && at.left >= box.left - 0.5 && at.right <= box.right + 0.5 && at.top >= box.top - 0.5 && at.bottom <= box.bottom + 0.5;
        })(),
      };
    });
  }, [HIDDEN_WHILE_STARTING, selector] as [string[], string]);
}

test('a start an orchestrator made, in the gallery with a long name, an issue and a role, or a reviewer, fits its tile: only name, step and footer show, the rest folds into +N, and what hides returns once live', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, {});
  try {
    await window.evaluate(() => {
      location.hash = '#gallery';
      location.reload();
    });
    await expect(window.locator('[data-session-id="gallery-starting-orchestrated"]')).toBeVisible();
    const ids = ['gallery-starting-orchestrated', 'gallery-starting-reviewer'];
    await expect
      .poll(async () => (await startingTiles(window)).filter((each) => ids.includes(each.id)).map((each) => ({ id: each.id, outside: each.outside, shown: each.shown })))
      .toEqual(ids.map((id) => ({ id, outside: [], shown: [] })));
    for (const id of ids) {
      const starting = window.locator(`[data-session-id="${id}"]`);
      await expect(starting.getByTestId('start-steps').locator('.hybrid-tile-step')).toHaveCount(1);
      await expect(starting.getByTestId('tile-issue')).toBeVisible();
      await expect(starting.getByTestId('tile-folded')).toBeVisible();
    }
    // The reviewer's marker leads its name, inside the name's box where a long name's clamp can't cut it off.
    const reviewer = (await startingTiles(window)).find((each) => each.id === 'gallery-starting-reviewer')!;
    expect(reviewer.name).toMatch(/^Review · r1 · /);
    expect(reviewer.nameLeads).toBe(true);
    // A start whose harness exited, under an orchestrator, with a long name: Retry and Delete inside, and its error not squeezed out.
    const failed = await startingTiles(window, '[data-start="failed"][data-session-id="gallery-start-exited-orchestrated"]');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ outside: [], shown: [] });
    expect(failed[0]!.errorHeight).toBeGreaterThanOrEqual(14);
    // Live, the same line from its orchestrator shows.
    await expect(window.locator('[data-session-id="gallery-receiving"]').getByTestId('tile-set-by')).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('an orchestrator starts a slow worker with a long name, a role, its status line, and a reviewer of it: while they start every tile stays inside its bounds, and the status line shows once they are live', async () => {
  test.setTimeout(150_000);
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV, FAKE_HARNESS_START_DELAY_MS: '6000' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    // The reviewer starts through `new_agent`, which leaves `reviewOf` empty: its subtitle is the gallery's to test.
    await spawnAgent(window, 'monorepo', 'Lead a crowded crew: Fix the flaky test', { started: false });
    if (await sessionWindow(window).isVisible()) await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();

    // Watch every 150 ms, each read one call, until both of its agents have been seen starting and are live.
    const seen = new Map<string, StartingTile>();
    const problems: string[] = [];
    let folded = false;
    const deadline = Date.now() + 100_000;
    while (Date.now() < deadline) {
      const starting = await startingTiles(window);
      for (const each of starting) {
        seen.set(each.id, each);
        folded ||= each.folded;
        if (each.outside.length > 0) problems.push(`${each.name}: ${each.outside.join('; ')}`);
        if (each.shown.length > 0) problems.push(`${each.name} shows ${each.shown.join(', ')} while starting`);
      }
      const names = [...seen.values()].map((each) => each.name);
      if (starting.length === 0 && names.some((name) => name.includes('review r1')) && names.some((name) => !name.includes('review r1') && name.startsWith('Rework')) && (await tile(window).count()) === 3) break;
      await window.waitForTimeout(150);
    }
    expect(problems).toEqual([]);
    expect([...seen.values()].map((each) => each.name).filter((name) => name.startsWith('Rework')).toSorted()).toEqual(['Rework the movable sessions follow-up so the dock keeps up', 'Rework the movable sessions follow-up so the dock keeps up · review r1']);
    expect(folded).toBe(true);

    // Once live, every tile (and any start tile still there) fits too.
    for (const each of await startingTiles(window, EVERY_TILE)) expect({ name: each.name, outside: each.outside }).toEqual({ name: each.name, outside: [] });
    // Live, the line its orchestrator set is drawn again (it yields to the body's lines, so a two-line name can hide it).
    const worker = tile(window).filter({ has: window.getByTitle('Rework the movable sessions follow-up so the dock keeps up', { exact: true }) });
    await expect(worker.getByTestId('tile-set-by')).toHaveText('set by ◎ Lead a crowded crew: Fix the flaky test');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
