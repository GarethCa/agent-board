import { expect, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agents, launch, listFinishedTurns, pickInChip, recordCharacters, recordedCharacters, recordedStates, recordStates, screen, spawnAgent, tile, tileAction, TURN_MS, zones } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';

test('a Claude agent runs in its own worktree, its tile follows it running → waiting → running → done across an app restart, and deleting it removes the worktree', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const apps: ElectronApplication[] = [];
  try {
    const first = await launch(dataDir, env);
    apps.push(first.app);
    // Its waiting tile is outlined as needing you once Needs you lists finished turns.
    await listFinishedTurns(first.window);
    await pickFolderNext(first.app, repo);
    await browseForZone(first.window);
    await recordStates(first.window);

    await spawnAgent(first.window, 'monorepo', 'Pick a database');

    await expect(tile(first.window)).toHaveCount(1);
    await expect(tile(first.window)).toContainText('Pick a database');
    await expect(tile(first.window)).toHaveAttribute('data-harness', 'claude');
    const [agent] = await agents(first.window);
    await expect(tile(first.window)).toContainText(agent!.branch);
    expect(agent!.worktree.startsWith(join(dir, 'worktrees'))).toBe(true);
    expect(existsSync(agent!.worktree)).toBe(true);
    await expect(tile(first.window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    await expect(tile(first.window)).toHaveCSS('outline-color', 'rgb(247, 103, 7)');
    // Spawned starting, its first prompt queued; starting until that prompt, typed at it once its session was up, went
    // up, before it waited.
    const before = await recordedStates(first.window);
    expect(before[0]).toBe('starting');
    expect(before).not.toContain('running');
    expect(before.indexOf('thinking')).toBeGreaterThan(0);
    expect(before.indexOf('thinking')).toBeLessThan(before.indexOf('waiting'));

    // Quit with the agent still waiting: it keeps running in the daemon.
    await first.app.close();
    const second = await launch(dataDir, env);
    apps.push(second.app);
    const { window } = second;
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');
    await recordStates(window);

    await tile(window).dblclick();
    await expect(screen(window)).toContainText('Which database should I use');
    await window.getByTestId('session-terminal').click();
    await window.keyboard.type('SQLite');
    await window.keyboard.press('Enter');
    await expect(screen(window)).toContainText('Going with SQLite.');
    await window.keyboard.press('Control+D');
    await expect(tile(window)).toHaveAttribute('data-state', 'done');
    // From waiting, the answer's tool call (PreToolUse) made it running again, and then it was done.
    const after = await recordedStates(window);
    expect(after).toContain('running');
    expect(after.indexOf('running')).toBeLessThan(after.indexOf('done'));
    expect(after.at(-1)).toBe('done');
    // The tile still says what the agent was asked to do, not the answer to its question.
    await expect(tile(window)).toContainText('Pick a database');

    await window.getByRole('button', { name: 'Close session window' }).click();
    await tileAction(tile(window), 'Delete agent');
    await window.getByRole('alertdialog', { name: 'Delete agent?' }).getByRole('button', { name: 'Delete agent' }).click();
    await expect(tile(window)).toHaveCount(0);
    expect(existsSync(agent!.worktree)).toBe(false);
    expect(execFileSync('git', ['-C', repo, 'branch', '--list', agent!.branch], { encoding: 'utf8' })).toBe('');
  } finally {
    for (const app of apps) await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a message whose Enter the agent's harness keeps losing shows on its tile as not sent, and the tile's Send sends it", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  // Its harness loses three Enters after its first prompt: the first and both pressed again; the tile's Send is its fourth.
  const { app, window } = await launch(dataDir, {
    ...env,
    FAKE_HARNESS_LOSE_ENTERS: '3',
    FAKE_HARNESS_LOSE_ENTERS_AFTER: '1',
    AGENT_BOARD_SUBMIT_CONFIRM_MS: '300',
  });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    const [agent] = await agents(window);

    await window.evaluate((sessionId) => globalThis.window.agentBoard.agents.answer(sessionId, 'SQLite'), agent!.sessionId);
    const unsent = tile(window).getByTestId('tile-unsent');
    await expect(unsent).toHaveText(/A message not sent: it is typed at its prompt/);

    await unsent.getByRole('button', { name: 'Send' }).click();
    await expect(unsent).toBeHidden();
    await tile(window).dblclick();
    await expect(screen(window)).toContainText('Going with SQLite.', { timeout: TURN_MS });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Claude agent whose session never says it is up offers its task on its tile, untyped, and Send types it", async () => {
  // Given up on a minute after it starts: past the default limit.
  test.setTimeout(120_000);
  const { dir, repo, env } = scratch('waiting');
  // Its hooks never run, as with Claude Code's `disableAllHooks`.
  mkdirSync(join(env.HOME!, '.claude'), { recursive: true });
  writeFileSync(join(env.HOME!, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: true }));
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    const untyped = tile(window).getByTestId('tile-untyped');
    await expect(untyped).toHaveText(/^Answer its terminal first: Pick a database/, { timeout: 80_000 });
    // What to do shows whole, even with the row fitted to one line, never cut off by its clamp.
    const hintClipped = await untyped.locator('.hybrid-tile-text').evaluate((text) => {
      const hint = text.querySelector('strong')!.getBoundingClientRect();
      const shown = text.getBoundingClientRect();
      return hint.bottom > shown.bottom + 0.5 || hint.right > shown.right + 0.5;
    });
    expect(hintClipped).toBe(false);

    await untyped.getByRole('button', { name: 'Send' }).click();
    await expect(untyped).toBeHidden();
    await tile(window).dblclick();
    await expect(screen(window)).toContainText('> Pick a database', { timeout: TURN_MS });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rate-limited Claude agent's tile offers Continue on credits, which closes Claude's menu picking no row and resumes its turn", async () => {
  const { dir, repo, env } = scratch('rate-limit');
  const dataDir = tempDataDir();
  // Claude's menu with its usage-credits row first, under its pointer: Escape picks no row.
  const { app, window } = await launch(dataDir, { ...env, FAKE_HARNESS_RATE_LIMIT_SCREEN: 'menu-credits-first' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Fix the tests');
    await expect(tile(window)).toHaveAttribute('data-state', 'rate-limited', { timeout: TURN_MS });

    await tile(window).getByTestId('continue-on-credits').click();
    await expect(tile(window)).not.toHaveAttribute('data-state', 'rate-limited', { timeout: TURN_MS });
    await expect(tile(window).getByTestId('continue-on-credits')).toBeHidden();
    await tile(window).dblclick();
    await expect(screen(window)).toContainText('Done: continue.', { timeout: TURN_MS });
    await expect(screen(window)).not.toContainText('opened its page');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Claude agent's subagent pops onto its tile as a bean character from its hooks, then hands off its result and goes", async () => {
  const { dir, repo, env } = scratch('subagent');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await recordCharacters(window);

    await spawnAgent(window, 'monorepo', 'Map the code');

    // The scenario's last hook: the turn is over, and the subagent long finished.
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    await expect.poll(() => recordedCharacters(window)).toEqual(['running/bean', 'handing-off/bean']);
    await expect(tile(window).getByTestId('character')).toHaveCount(0);
    await expect(tile(window).getByTestId('subagent-perch')).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a folder zone agent starts in the folder, and deleting a live agent or one with unsaved work asks first', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, join(repo, 'apps', 'web'));
    await browseForZone(window);

    await spawnAgent(window, 'monorepo/apps/web', 'Tidy the web app');

    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    const [agent] = await agents(window);
    expect(agent!.cwd).toBe(join(agent!.worktree, 'apps', 'web'));
    // Where claude really ran: the fake keeps its transcript under ~/.claude/projects/<its cwd, mangled>.
    expect(existsSync(join(dir, 'home', '.claude', 'projects', agent!.cwd.replace(/[^a-zA-Z0-9]/g, '-')))).toBe(true);

    // It is still running, so deleting asks first, even with nothing to lose yet.
    const confirm = window.getByRole('alertdialog');
    await tileAction(tile(window), 'Delete agent');
    await expect(confirm).toContainText('is still running');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(tile(window)).toHaveCount(1);

    writeFileSync(join(agent!.cwd, 'notes.md'), 'unsaved\n');
    await tileAction(tile(window), 'Delete agent');
    await confirm.getByRole('button', { name: 'Delete anyway' }).click();
    await expect(confirm).toContainText('uncommitted changes');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(tile(window)).toHaveCount(1);
    expect(existsSync(agent!.worktree)).toBe(true);

    await tileAction(tile(window), 'Delete agent');
    await confirm.getByRole('button', { name: 'Delete anyway' }).click();
    await expect(confirm).toContainText('uncommitted changes');
    await confirm.getByRole('button', { name: 'Delete anyway' }).click();
    await expect(tile(window)).toHaveCount(0);
    expect(existsSync(agent!.worktree)).toBe(false);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Codex agent explains the bypass flag once, shows the Codex mark, and follows its hooks live to done', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await recordStates(window);

    const zone = window.getByTestId('zone');
    await zone.getByRole('button', { name: 'New agent' }).click();
    const form = window.getByRole('dialog', { name: 'New agent' });
    await pickInChip(form, 'Harness', 'Codex');
    await expect(form.getByRole('heading')).toHaveText('New Codex agent in monorepo');
    await expect(form.getByRole('checkbox', { name: "Skip Codex's hook review in this zone" })).toBeChecked();
    await form.getByLabel('Task').fill('Run the tests');
    await form.getByRole('button', { name: 'Start' }).click();

    // The first Codex agent: the one-time notice about --dangerously-bypass-hook-trust comes first.
    const notice = window.getByRole('dialog', { name: 'About Codex hooks' });
    await expect(notice).toContainText('--dangerously-bypass-hook-trust');
    await notice.getByRole('button', { name: 'Start' }).click();
    await expect(notice).toBeHidden();

    await expect(tile(window)).toHaveCount(1);
    await expect(tile(window)).toHaveAttribute('data-harness', 'codex');
    await expect(tile(window).getByRole('img', { name: 'Codex' })).toBeVisible();
    // The fake codex's turn ran, its hooks went through the forwarder, and the tile followed them.
    await expect.poll(() => recordedStates(window), { timeout: TURN_MS }).toEqual(['starting', 'running', 'thinking', 'running', 'thinking', 'idle']);

    await tile(window).dblclick();
    await expect(screen(window)).toContainText('All tests pass.');
    await window.getByTestId('session-terminal').click();
    await window.keyboard.press('Control+D');
    await expect(tile(window)).toHaveAttribute('data-state', 'done');
    await window.getByRole('button', { name: 'Close session window' }).click();

    // Unticking the bypass and cancelling leaves the zone as it was.
    const skipReview = form.getByRole('checkbox', { name: "Skip Codex's hook review in this zone" });
    await zone.getByRole('button', { name: 'New agent' }).click();
    await pickInChip(form, 'Harness', 'Codex');
    await skipReview.uncheck();
    await expect(form).toContainText('Until you trust them, the tile stays idle.');
    await form.getByRole('button', { name: 'Cancel' }).click();
    expect((await zones(window))[0]!.codexBypassHookTrust).toBe(true);

    // The notice shows only once. Turning the bypass off is saved for the zone when the agent starts.
    await zone.getByRole('button', { name: 'New agent' }).click();
    await pickInChip(form, 'Harness', 'Codex');
    await expect(skipReview).toBeChecked();
    await skipReview.uncheck();
    await form.getByLabel('Task').fill('Again');
    await form.getByRole('button', { name: 'Start' }).click();
    await expect(form).toBeHidden();
    await expect(notice).toHaveCount(0);
    await expect(tile(window)).toHaveCount(2);
    expect((await zones(window))[0]!.codexBypassHookTrust).toBe(false);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Codex agent asks first, from its tile, in a repo with its own Codex config, and one stopped for new config says why', async () => {
  const { dir, repo, env } = scratch('output');
  mkdirSync(join(repo, '.codex'));
  writeFileSync(join(repo, '.codex', 'hooks.json'), '{}\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'codex config']);
  const plain = join(dir, 'plain');
  execFileSync('git', ['clone', '--quiet', repo, plain]);
  execFileSync('git', ['-C', plain, 'rm', '-r', '--quiet', '.codex']);
  execFileSync('git', ['-C', plain, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'no codex']);
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    // Seen before: this test is about the repo's own config.
    await window.evaluate(() => localStorage.setItem('agent-board.codexBypassNoticeSeen', '1'));
    await pickFolderNext(app, repo);
    await browseForZone(window);

    const startCodex = async (zoneName: string, task: string) => {
      const zone = window.getByTestId('zone').filter({ has: window.getByTestId('zone-tab').getByText(zoneName, { exact: true }) });
      await zone.getByRole('button', { name: 'New agent' }).click();
      const form = window.getByRole('dialog', { name: 'New agent' });
      await pickInChip(form, 'Harness', 'Codex');
      await form.getByLabel('Task').fill(task);
      await form.getByRole('button', { name: 'Start' }).click();
    };

    await startCodex('monorepo', 'Tidy up');
    // Its tile says so, and Retry asks before it starts.
    const failed = window.getByTestId('start-tile');
    await expect(failed).toHaveAttribute('data-start', 'failed');
    await expect(failed.getByRole('alert')).toContainText('own Codex config');
    await failed.getByRole('button', { name: 'Retry' }).click();
    const confirm = window.getByRole('alertdialog', { name: 'Codex config in this repo' });
    await expect(confirm).toContainText('.codex');
    await expect(confirm).toContainText('trusting all of them trusts both');
    await expect(tile(window)).toHaveCount(0);
    await confirm.getByRole('button', { name: 'Start anyway' }).click();
    await expect(confirm).toBeHidden();
    await expect(tile(window)).toHaveCount(1);
    await expect(failed).toHaveCount(0);

    // A flagged agent whose worktree gains Codex config is stopped, and its tile says why.
    await pickFolderNext(app, plain);
    await browseForZone(window);
    await startCodex('plain', 'Write config');
    const flagged = tile(window).filter({ hasText: 'Write config' });
    await expect(flagged).toHaveAttribute('data-state', /^(starting|idle)$/);
    const agent = (await agents(window)).find((a) => a.name === 'Write config')!;
    mkdirSync(join(agent.cwd, '.codex'));
    await expect(flagged).toHaveAttribute('data-state', 'failed');
    // Stopped, it is a chip; unfolded, its tile says why.
    await flagged.click();
    await expect(flagged.getByRole('note')).toContainText('stopped this agent');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
