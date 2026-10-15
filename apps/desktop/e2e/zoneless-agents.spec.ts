// Zone-less agents and group zones: agents and shells put straight on the board with the Agent and Shell
// tools (AG2), the repo picker (AH1), groups bound later and unbound again (AI1), a group's default repo (AJ2), and a
// loose shell's folder chip (AK1).
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { Agent, Zone } from '@agent-board/daemon/protocol';
import { createTempKeychain } from '@agent-board/tracker/testing';
import { rmSync } from 'node:fs';
import { withDaemon } from './board-helpers.ts';
import { agents, launch, pickInChip, sessionWindow, LINEAR_API_KEY, serveLinearFixtures, SHELL_ENV, tile, zoneNamed, zones } from './agent-helpers.ts';
import { test, addEmptyZone, browseForZone, openAddZone, pickFolderNext, placeWithTool, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

/** The board as the daemon has stored it. */
function stored(dataDir: string): Promise<{ zones: Zone[]; agents: Agent[] }> {
  return withDaemon(dataDir, async (client) => ({ zones: await client.call('zone.list'), agents: await client.call('agent.list') }));
}

const picker = (window: Page) => window.getByRole('dialog', { name: 'Choose where the agent works' });

/** Drags the toolbar's `tool` button onto the board, letting go at `at` (relative to the board), as a hand would (AG2). */
async function dragTool(window: Page, tool: 'New agent' | 'New shell', at: { x: number; y: number }): Promise<void> {
  const button = (await window.getByRole('button', { name: tool, exact: true }).boundingBox())!;
  const board = (await window.locator('.board').boundingBox())!;
  await window.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
  await window.mouse.down();
  await window.mouse.move(board.x + at.x, board.y + at.y, { steps: 16 });
  await expect(window.getByTestId('tool-ghost')).toBeVisible();
  await window.mouse.up();
}

/** Puts an agent on bare board at `at` with the Agent tool, and starts it in `repo`, browsed for in the picker. */
async function startLoose(app: ElectronApplication, window: Page, repo: string, at?: { x: number; y: number }): Promise<void> {
  await placeWithTool(window, 'New agent', at);
  await expect(picker(window)).toBeVisible();
  await pickFolderNext(app, repo);
  await picker(window).getByRole('button', { name: 'Browse…' }).click();
  await expect(picker(window).getByRole('option', { selected: true })).toContainText('monorepo');
  await picker(window).getByRole('button', { name: /^Start/ }).click();
  await expect(picker(window)).toHaveCount(0);
}

test('the Agent tool starts an agent loose on the board, in a repo picked for it, and the next in the repo it used last', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    // A drop on bare board: the new tile waits for a repo, with the picker on it (AH1).
    await placeWithTool(window, 'New agent');
    await expect(window.getByTestId('pending-tile')).toContainText('new-agent-1');
    // Placing again moves the picker to the new spot; the empty board's welcome stays away from the stand-in tile.
    await placeWithTool(window, 'New agent', { x: 800, y: 300 });
    await expect(window.getByTestId('pending-tile')).toHaveCount(1);
    await expect(window.getByText('An empty board')).toHaveCount(0);
    await pickFolderNext(app, repo);
    await picker(window).getByRole('button', { name: 'Browse…' }).click();
    await picker(window).getByRole('textbox', { name: 'New branch' }).fill('agent/first-loose');
    // The harness, model and role chips (BJ3), on the defaults until picked.
    const chips = picker(window).getByRole('group', { name: 'Harness, model and role' });
    await expect(chips).toHaveText(/Claude\s*Default\s*No role/);
    await pickInChip(picker(window), 'Model', 'Haiku');
    await pickInChip(picker(window), 'Role', 'Implementer');
    await expect(chips).toHaveText(/Claude\s*Haiku\s*Implementer/);
    await expect(picker(window)).toContainText("Uses the repo's Implementer template.");
    await picker(window).getByRole('button', { name: /^Start/ }).click();

    await expect(tile(window)).toHaveCount(1);
    await expect(tile(window)).toHaveAttribute('data-zone', '');
    await expect(window.getByTestId('pending-tile')).toHaveCount(0);
    const [first] = (await stored(dataDir)).agents;
    expect(first).toMatchObject({ zoneId: null, repoRoot: repo, branch: 'agent/first-loose', name: 'new-agent-1', model: 'haiku', role: 'implementer' });

    // The next one remembers the repo: it is preselected, so ⏎ starts it.
    await placeWithTool(window, 'New agent', { x: 240, y: 460 });
    await expect(picker(window).getByRole('option', { selected: true })).toContainText('last used');
    await picker(window).getByRole('searchbox', { name: 'Search repos and folders' }).press('Enter');

    await expect(tile(window)).toHaveCount(2);
    const second = (await stored(dataDir)).agents[1];
    expect(second).toMatchObject({ zoneId: null, repoRoot: repo, branch: 'agent/new-agent-2' });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent starts with no task, from the dialog and from the Agent tool: idle, "No task yet", and a first message runs it', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    // The Agent tool's drop, started from the picker with no task.
    await startLoose(app, window, repo);
    await expect(tile(window)).toHaveCount(1);
    await expect(tile(window)).toContainText('No task yet');
    await expect(tile(window)).toHaveAttribute('data-state', /^(idle|waiting)$/);

    // The zone's New agent dialog, with its task left empty.
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await zoneNamed(window, 'monorepo').getByRole('button', { name: 'New agent' }).click();
    const form = window.getByRole('dialog', { name: 'New agent' });
    await expect(form.getByLabel('Task')).toHaveAttribute('placeholder', /optional/);
    await form.getByRole('button', { name: 'Start' }).click();
    await expect(form).toBeHidden();
    await expect(tile(window)).toHaveCount(2);
    for (const each of await tile(window).all()) await expect(each).toContainText('No task yet');
    const [loose, inZone] = (await stored(dataDir)).agents;
    expect(loose).toMatchObject({ name: 'new-agent-1', description: '' });
    expect(inZone).toMatchObject({ name: 'new-agent-2', description: '' });
    expect(new Set([inZone!.branch, loose!.branch]).size).toBe(2);

    // A message typed to one makes it run.
    await tile(window).first().dblclick();
    await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
    const composer = sessionWindow(window).getByRole('textbox', { name: 'Message to the agent' });
    await composer.fill('start on this');
    await composer.press('Enter');
    await expect(tile(window).first()).toHaveAttribute('data-state', /^(running|thinking)$/);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Agent and Shell tools drag straight off the toolbar: a ghost tile follows, and the tile lands where it is let go', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    // Dropped on bare board: the new agent's tile waits there, with the picker on it.
    await dragTool(window, 'New agent', { x: 300, y: 260 });
    const pending = window.getByTestId('pending-tile');
    await expect(pending).toBeVisible();
    const board = (await window.locator('.board').boundingBox())!;
    const box = (await pending.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - (board.x + 300))).toBeLessThan(12);
    expect(Math.abs(box.y + box.height / 2 - (board.y + 260))).toBeLessThan(12);
    await picker(window).getByRole('button', { name: 'Cancel' }).click();
    await expect(pending).toHaveCount(0);

    // Dropped over a bound zone, a shell snaps into it and starts in its folder, with no question.
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const zone = zoneNamed(window, 'monorepo');
    const into = (await zone.boundingBox())!;
    await dragTool(window, 'New shell', { x: into.x - board.x + into.width / 2, y: into.y - board.y + into.height / 2 });
    const zoneId = (await zones(window))[0]!.id;
    await expect(window.getByTestId('shell-tile')).toHaveAttribute('data-zone', zoneId);
    // A drag never arms the tool.
    await expect(window.getByRole('button', { name: 'New shell', exact: true })).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an issue in a group that only tracks Linear starts an agent through the picker, in the group, fed by its card', async () => {
  // The key goes to a throwaway keychain file, which only macOS has.
  test.skip(process.platform !== 'darwin', 'needs a throwaway macOS keychain');
  const { subject, server: linear } = await serveLinearFixtures();
  const keychain = createTempKeychain();
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_LINEAR_API_URL: linear.url, AGENT_BOARD_KEYCHAIN: keychain.path });
  try {
    // A Linear team's zone left unbound: a group with a tracker and no repo.
    const popover = await openAddZone(window, 'Linear');
    await popover.getByRole('textbox', { name: 'Linear API key' }).fill(LINEAR_API_KEY);
    await popover.getByRole('button', { name: 'Connect Linear' }).click();
    await popover.getByRole('option').first().click();
    await popover.getByRole('textbox', { name: 'Zone name' }).fill('Planning');
    await popover.getByRole('button', { name: /^Add zone/ }).click();
    const group = zoneNamed(window, 'Planning');
    await expect(group).toHaveAttribute('data-kind', 'unbound');

    await group.getByRole('button', { name: 'Add issue' }).click();
    const issues = window.getByRole('dialog', { name: 'Add an issue' });
    await issues.getByRole('option').filter({ hasText: subject.knownIssue.id }).click();
    await issues.getByRole('button', { name: 'Start agent' }).click();

    await expect(picker(window)).toContainText(subject.knownIssue.id);
    await pickFolderNext(app, repo);
    await picker(window).getByRole('button', { name: 'Browse…' }).click();
    await picker(window).getByRole('button', { name: /^Start/ }).click();

    await expect(tile(window)).toHaveCount(1);
    const groupId = (await zones(window)).find((zone) => zone.name === 'Planning')!.id;
    const [agent] = await agents(window);
    expect(agent).toMatchObject({ zoneId: groupId, repoRoot: repo, issue: { provider: 'linear', id: subject.knownIssue.id } });
    await expect(window.getByTestId('issue-card')).toHaveAttribute('data-zone', groupId);
    await expect(window.getByTestId('brief-edge')).toHaveCount(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
    keychain.remove();
    await linear.close();
  }
});

test('a group holds an agent dragged into it, and is bound to a repo and unbound again, the agent keeping its own repo', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await startLoose(app, window, repo);
    await expect(tile(window)).toHaveCount(1);
    await addEmptyZone(window, 'Onboarding');
    const group = zoneNamed(window, 'Onboarding');
    await expect(group).toHaveAttribute('data-kind', 'unbound');
    await expect(group.getByTestId('zone-tab')).toContainText('group');

    // Dragged in, it sits in the group, still on its own repo.
    const from = (await tile(window).boundingBox())!;
    const to = (await group.boundingBox())!;
    await window.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await window.mouse.down();
    await window.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await window.mouse.up();
    const groupId = (await stored(dataDir)).zones[0]!.id;
    await expect(tile(window)).toHaveAttribute('data-zone', groupId);
    expect((await stored(dataDir)).agents[0]).toMatchObject({ zoneId: groupId, repoRoot: repo });

    // Bound to the repo later, from its tab.
    await pickFolderNext(app, repo);
    await group.getByRole('button', { name: 'Bind zone' }).click();
    await window.getByRole('menuitem', { name: 'Open as repo…' }).click();
    await expect(group).toHaveAttribute('data-kind', 'repo');

    // And unbound again: a group once more, its agent where it was.
    await group.getByRole('button', { name: 'Zone options' }).click();
    await window.getByRole('menuitem', { name: /^Unbind/ }).click();
    await expect(group).toHaveAttribute('data-kind', 'unbound');
    const after = await stored(dataDir);
    expect(after.zones[0]).toMatchObject({ kind: 'unbound', repoRoot: null });
    expect(after.agents[0]).toMatchObject({ zoneId: groupId, repoRoot: repo });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a group with a default repo starts its agents there at once, with no picker', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await addEmptyZone(window, 'Onboarding');
    const group = zoneNamed(window, 'Onboarding');
    await group.getByRole('button', { name: 'Zone options' }).click();
    await window.getByRole('menuitem', { name: /^Set a default repo/ }).click();
    const dialog = window.getByRole('dialog', { name: 'Default repo' });
    await pickFolderNext(app, repo);
    await dialog.getByRole('button', { name: 'Browse…' }).click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(group.getByRole('button', { name: 'Default repo' })).toHaveText('monorepo');

    await group.getByRole('button', { name: 'New agent' }).click();

    await expect(tile(window)).toHaveCount(1);
    await expect(picker(window)).toHaveCount(0);
    const { zones, agents } = await stored(dataDir);
    expect(agents[0]).toMatchObject({ zoneId: zones[0]!.id, repoRoot: repo });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Shell tool puts a shell at home on the board; its folder chip follows cd and opens a pane elsewhere', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await placeWithTool(window, 'New shell');
    const sessionWindow = window.getByTestId('session-window');
    await expect(sessionWindow).toHaveAttribute('data-state', 'attached');
    const folder = window.getByTestId('shell-tile').getByTestId('shell-folder');
    await expect(folder).toHaveText('~');

    await window.keyboard.type(`cd ${repo}`);
    await window.keyboard.press('Enter');
    await sessionWindow.getByRole('button', { name: 'Close session window' }).click();
    await expect(folder).toHaveText('monorepo', { timeout: 15_000 });

    // A new pane at home; the first stays in the repo.
    await folder.click();
    await window.getByRole('menuitem', { name: 'Home ~' }).click();
    await expect(sessionWindow).toHaveAttribute('data-state', 'attached');
    await expect(window.getByTestId('shell-pane')).toHaveCount(2);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const appearance of ['light', 'dark'] as const) {
  test(`the repo picker's footer keeps Start inside the card, however long the branch and model, ${appearance}`, async () => {
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_APPEARANCE: appearance });
    try {
      await placeWithTool(window, 'New agent');
      await pickFolderNext(app, repo);
      await picker(window).getByRole('button', { name: 'Browse…' }).click();
      await picker(window).getByRole('textbox', { name: 'Base branch' }).fill('origin/release/2026-10-a-very-long-base-branch-name-indeed');
      await pickInChip(picker(window), 'Model', 'Other…');
      await picker(window).getByRole('textbox', { name: 'Model id' }).fill('claude-opus-5-5-with-a-very-long-model-name');
      await picker(window).getByRole('textbox', { name: 'Model id' }).press('Enter');
      await pickInChip(picker(window), 'Role', 'Follow-up reviewer');

      const card = (await picker(window).boundingBox())!;
      for (const control of [picker(window).getByRole('button', { name: /^Start/ }), picker(window).getByRole('button', { name: /^Model:/ })]) {
        const box = (await control.boundingBox())!;
        expect(box.x, 'inside the card on the left').toBeGreaterThanOrEqual(card.x);
        expect(box.x + box.width, 'inside the card on the right').toBeLessThanOrEqual(card.x + card.width);
      }
      // Nothing in the footer runs past it, nor makes it scroll sideways.
      const overflow = await window.locator('.repo-picker-foot').evaluate((foot) => foot.scrollWidth - foot.clientWidth);
      expect(overflow).toBe(0);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
