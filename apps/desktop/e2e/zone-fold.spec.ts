import { expect, type Page } from '@playwright/test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { agents, claudeInTerminal, launch, SHELL_ENV, spawnAgent, TURN_MS, zoneNamed, zones } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings, settingsSection } from './settings-helpers.ts';

// A whole zone folds to a chip while it isn't needed: its agents are paused (hibernated) and its tiles let go, and
// unfolding wakes none of them unless asked. The same chip, fold button and ⋯ in both designs.

/** Wakes the board's one agent, as its tile's Wake does. */
const wakeAgent = (page: Page) =>
  page.evaluate(async () => {
    const [agent] = await window.agentBoard.agents.list();
    await window.agentBoard.agents.resume(agent!.sessionId);
  });

const DESIGNS = ['classic', 'simplified'] as const;

for (const design of DESIGNS) {
  test(`a zone folds to a chip, pausing its agents, and unfolds without waking them unless asked (${design})`, async () => {
    const { dir, repo, env } = scratch('output');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV }, [], { design });
    try {
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Run the tests');
      // Its turn is over: it sits at its prompt, so it can pause.
      await expect.poll(async () => (await agents(window))[0]?.state, { timeout: TURN_MS }).toMatch(/^(idle|waiting)$/);
      const zone = zoneNamed(window, 'monorepo');
      await expect(window.getByTestId('agent-tile')).toHaveCount(1);
      const open = { width: await zone.getAttribute('data-width'), height: await zone.getAttribute('data-height') };

      // Fold it from its header: a chip with its name and a count, no tile, the agent paused.
      await zone.getByRole('button', { name: /^Fold (zone|project)$/ }).click();
      await expect(zone).toHaveAttribute('data-folded', 'true');
      await expect(window.getByTestId('agent-tile')).toHaveCount(0);
      await expect.poll(async () => (await agents(window))[0]?.state).toBe('hibernated');
      await expect(zone.getByTestId('folded-summary')).toHaveText('1 paused');
      expect((await zones(window))[0]).toMatchObject({ folded: true });
      await window.screenshot({ path: test.info().outputPath(`folded-${design}.png`), animations: 'disabled' });

      // Unfold from the chip: the zone is as it was, and its agent still paused.
      await zone.getByRole('button', { name: /^Unfold (zone|project)$/ }).click();
      await expect(zone).not.toHaveAttribute('data-folded', 'true');
      await expect(zone).toHaveAttribute('data-width', open.width!);
      await expect(zone).toHaveAttribute('data-height', open.height!);
      expect((await agents(window))[0]).toMatchObject({ state: 'hibernated' });
      expect((await zones(window))[0]).toMatchObject({ folded: false });

      // Unfolded so, it is paused as if by hand: woken by hand, it is at its prompt again.
      await wakeAgent(window);
      await expect.poll(async () => (await agents(window))[0]?.state, { timeout: TURN_MS }).toMatch(/^(idle|waiting)$/);

      // Folded again, which pauses it again, ⋯ unfolds and wakes what the fold paused.
      await zone.getByRole('button', { name: /^Fold (zone|project)$/ }).click();
      await expect(zone).toHaveAttribute('data-folded', 'true');
      await expect.poll(async () => (await agents(window))[0]?.state).toBe('hibernated');
      await zone.getByRole('button', { name: /^(Zone|Project) options$/ }).click();
      await window.getByRole('menuitem', { name: /^Unfold and wake its agents/ }).click();
      await expect(zone).not.toHaveAttribute('data-folded', 'true');
      await expect.poll(async () => (await agents(window))[0]?.state, { timeout: TURN_MS }).not.toBe('hibernated');
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const design of DESIGNS) {
  test(`a folded zone's chip counts the agent that needs you, beside the rest, and the fold leaves it running (${design})`, async () => {
    const { dir, repo, env } = scratch('permission');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV }, [], { design });
    try {
      await pickFolderNext(app, repo);
      await browseForZone(window);
      const states = async () => (await agents(window)).map((agent) => agent.state).sort();
      // One agent whose permission is allowed, as the inbox allows it: its turn ends, so it can pause.
      await spawnAgent(window, 'monorepo', 'Clean up');
      await expect.poll(async () => (await agents(window))[0]?.permissions.length, { timeout: TURN_MS }).toBe(1);
      await window.evaluate(async () => {
        const [agent] = await globalThis.window.agentBoard.agents.list();
        await globalThis.window.agentBoard.agents.decidePermission(agent!.sessionId, agent!.permissions[0]!.id, { behavior: 'allow' });
      });
      await expect.poll(async () => (await states())[0], { timeout: TURN_MS }).toMatch(/^(idle|waiting)$/);
      // And one left asking.
      await spawnAgent(window, 'monorepo', 'Clean up again');
      await expect.poll(states, { timeout: TURN_MS }).toContain('needs-permission');

      const zone = zoneNamed(window, 'monorepo');
      await zone.getByRole('button', { name: /^Fold (zone|project)$/ }).click();
      await expect(zone).toHaveAttribute('data-folded', 'true');
      // The one asking is not paused: it is counted in orange on the chip, before the rest, and the toast names it.
      await expect.poll(states).toEqual(['hibernated', 'needs-permission']);
      await expect(zone.getByTestId('folded-needs-you')).toHaveText('1');
      await expect(zone.getByTestId('folded-needs-you')).toHaveAccessibleName('1 needs you');
      await expect(zone.getByTestId('folded-summary')).toHaveText('· 1 paused');
      const toast = window.locator('.ui-toast').filter({ hasText: 'monorepo is folded' });
      await expect(toast).toContainText(/1 agent paused\. Left running: .+, as it is waiting/);
      await expect(toast).toHaveAttribute('data-tone', 'info');
      // The chip in light and in dark, as the Appearance setting switches it (Playwright pins the page to light).
      for (const colorScheme of ['light', 'dark'] as const) {
        await window.evaluate((mode) => globalThis.window.agentBoard.appearance.set({ mode, theme: 'agent-board' }), colorScheme);
        await window.emulateMedia({ colorScheme });
        await expect(window.locator('html')).toHaveAttribute('data-theme', colorScheme);
        await window.screenshot({ path: test.info().outputPath(`needs-you-${design}-${colorScheme}.png`), animations: 'disabled' });
      }
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a folded zone's chip counts a session from another terminal that needs you, though its tile is hidden", async () => {
  const { dir, repo, env } = scratch('permission');
  const home = env.HOME!;
  mkdirSync(join(home, '.claude'), { recursive: true });
  const dataDir = tempDataDir();
  // Never the developer's own ~/.claude or ~/.codex.
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex') });
  let session: ChildProcessWithoutNullStreams | undefined;
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const settings = await openSettings(window, 'accounts.terminals');
    const toggle = settingsSection(settings, 'Other terminals').getByRole('switch', { name: 'Show sessions from other terminals' });
    await toggle.click();
    // Its hooks are installed by now: a session started before them is never seen.
    await expect(toggle).toBeChecked();
    const zone = zoneNamed(window, 'monorepo');
    await zone.getByRole('button', { name: /^Fold (zone|project)$/ }).click();
    await expect(zone).toHaveAttribute('data-folded', 'true');
    await expect(zone.getByTestId('folded-summary')).toHaveText('No agents');

    // Started in the zone's repo in a terminal of the user's own, and asking for a permission there.
    session = claudeInTerminal(repo, home, ['Clean up'], 'permission');
    session.stdout.resume();
    session.stderr.resume();
    await expect(zone.getByTestId('folded-needs-you')).toHaveText('1', { timeout: TURN_MS });
    await expect(zone.getByTestId('folded-summary')).toBeHidden();
    await expect(window.getByTestId('external-tile')).toHaveCount(0);
  } finally {
    session?.kill();
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

type Rect = { x: number; y: number; width: number; height: number };

/** Each zone's layout by name, as the daemon stores it. */
const zoneLayouts = async (page: Page): Promise<Record<string, Rect>> =>
  Object.fromEntries((await zones(page)).map((zone) => [zone.name, { x: zone.x, y: zone.y, width: zone.width, height: zone.height }]));

/** Where each shell is, as the daemon stores it. */
const shellPlaces = (page: Page) => page.evaluate(async () => (await window.agentBoard.shells.list()).map((shell) => shell.position && { x: shell.position.x, y: shell.position.y }));

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const design of DESIGNS) {
  test(`an arrange closes the board up round a folded zone, and unfolding it moves what is in its way back out, as no step to undo (${design})`, async () => {
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, SHELL_ENV, [], { design });
    try {
      // Five zones, some on top of each other, and a shell loose on the board.
      await window.evaluate(async () => {
        const { zones, shells } = globalThis.window.agentBoard;
        for (const [name, x, y, width, height] of [
          ['web', 900, 100, 700, 400],
          ['api', 1300, 300, 600, 500],
          ['docs', 2600, 50, 500, 300],
          ['ops', 950, 1200, 900, 350],
          ['misc', 2200, 1100, 400, 260],
        ] as const) {
          await zones.addUnbound({ name, x, y, width, height });
        }
        await shells.create({ zoneId: null, position: { x: 4000, y: 3000 } });
      });
      await expect(window.getByTestId('zone').first()).toBeVisible();
      const messy = await zoneLayouts(window);
      const fitView = () => window.getByRole('button', { name: /^Fit view/i }).click();
      const arrange = async () => {
        await window.locator('.react-flow__pane').click({ position: { x: 60, y: 600 } });
        await window.keyboard.press('Shift+L');
      };

      await arrange();
      await expect.poll(async () => (await zoneLayouts(window)).web).not.toEqual(messy.web);
      await expect.poll(async () => Object.values(await zoneLayouts(window)).some((a, index, all) => all.slice(index + 1).some((b) => overlap(a, b)))).toBe(false);
      const arranged = { zones: await zoneLayouts(window), shells: await shellPlaces(window) };

      // The first zone of the second row (clear of the toolbars along the top), folded, is a chip, and the next arrange
      // closes the rest up round it: the zone keeps its saved size.
      const top = Math.min(...Object.values(arranged.zones).map((rect) => rect.y));
      const [[name, open], [after]] = Object.entries(arranged.zones)
        .filter(([, rect]) => rect.y !== top)
        .sort(([, a], [, b]) => a.x - b.x) as [[string, Rect], [string, Rect]];
      await fitView();
      const zone = zoneNamed(window, name);
      await zone.getByRole('button', { name: /^Fold (zone|project)$/ }).click();
      await expect(zone).toHaveAttribute('data-folded', 'true');
      await arrange();
      await expect.poll(async () => (await zoneLayouts(window))[after]).not.toEqual(arranged.zones[after]);
      const closedUp = await zoneLayouts(window);
      expect(closedUp[name]).toEqual(open);
      // Something now sits where the zone opens.
      expect(Object.entries(closedUp).some(([other, rect]) => other !== name && overlap(rect, open))).toBe(true);

      // Unfolded, it opens onto nothing: the board is as it was arranged, the loose shell too.
      await fitView();
      await zone.getByRole('button', { name: /^Unfold (zone|project)$/ }).click();
      await expect(zone).not.toHaveAttribute('data-folded', 'true');
      await expect.poll(() => zoneLayouts(window)).toEqual(arranged.zones);
      await expect.poll(() => shellPlaces(window)).toEqual(arranged.shells);

      // The room it made is no step to undo: two undos take back the two arranges, and none puts a zone back under it.
      await window.locator('.react-flow__pane').click({ position: { x: 60, y: 600 } });
      await window.keyboard.press('ControlOrMeta+z');
      await window.keyboard.press('ControlOrMeta+z');
      await expect.poll(() => zoneLayouts(window)).toEqual(messy);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}
