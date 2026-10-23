// An agent's model and role at spawn: the harness, model and role chips in New agent, a zone's Role
// templates dialog, and the tile's model and role badges, with a reviewer's detached branch line.
// A named custom role shows its name on the chip and the badge.
import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agents, launch, pickInChip, screen, tile, zoneNamed } from './agent-helpers.ts';
import { test, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

test('a zone’s role template starts a reviewer on a detached checkout of the branch it reviews, and the tiles show model and role', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const zone = zoneNamed(window, 'monorepo');

    // The zone's ⋯ › Role templates…: the app's own until edited, as this repo has no worker prompts.
    await zone.getByRole('button', { name: 'Zone options' }).click();
    await window.getByRole('menuitem', { name: /Role templates…/ }).click();
    const templates = window.getByRole('dialog', { name: 'Role templates' });
    await expect(templates.getByRole('tab', { name: 'Implementer' })).toHaveAttribute('aria-selected', 'true');
    await expect(templates).toContainText("The app's own template");
    await templates.getByRole('tab', { name: 'Reviewer', exact: true }).click();
    const editor = templates.getByRole('textbox', { name: 'Reviewer template', exact: true });
    await editor.fill('Review ');
    await templates.getByRole('button', { name: '{{branch}}' }).click();
    await expect(editor).toHaveValue('Review {{branch}}');
    await templates.getByRole('button', { name: 'Save' }).click();
    await expect(templates).toBeHidden();

    // An implementer on a typed model (Other…): Start takes the id as typed, without Enter. Its tile has a model badge,
    // and no role badge.
    await zone.getByRole('button', { name: 'New agent' }).click();
    const form = window.getByRole('dialog', { name: 'New agent' });
    await pickInChip(form, 'Model', 'Opus');
    await expect(form.getByRole('button', { name: /^Model:/ })).toHaveText('Opus');
    await pickInChip(form, 'Model', 'Other…');
    await form.getByRole('textbox', { name: 'Model id' }).fill('claude-opus-5-5');
    await form.getByLabel('Task').fill('Build it');
    await form.getByRole('button', { name: 'Start' }).click();
    await expect(form).toBeHidden();
    const implementerTile = tile(window).filter({ hasText: 'Build it' });
    await expect(implementerTile.getByTestId('tile-model')).toHaveText('claude-opus-5-5');
    await expect(implementerTile.getByTestId('tile-role')).toHaveCount(0);
    const [implementer] = await agents(window);
    expect(implementer!.model).toBe('claude-opus-5-5');

    // A reviewer of its branch, named in the dialog, from the zone's Reviewer template.
    await zone.getByRole('button', { name: 'New agent' }).click();
    await pickInChip(form, 'Role', 'Reviewer');
    await expect(form.getByRole('combobox', { name: 'Reviews' })).toHaveValue(implementer!.sessionId);
    await expect(form.getByRole('combobox', { name: 'Reviews' }).locator('option:checked')).toHaveText(`Build it · ${implementer!.branch}`);
    await expect(form).toContainText("Uses monorepo's Reviewer template.");
    await form.getByRole('button', { name: 'Start' }).click();
    await expect(form).toBeHidden();

    await expect.poll(async () => (await agents(window)).length).toBe(2);
    const reviewer = (await agents(window)).find((agent) => agent.role === 'reviewer')!;
    const tip = execFileSync('git', ['-C', repo, 'rev-parse', implementer!.branch], { encoding: 'utf8' }).trim();
    expect(reviewer).toMatchObject({ branch: '', reviews: { branch: implementer!.branch, head: tip } });
    const reviewerTile = tile(window).filter({ hasText: `Reviews ${implementer!.branch}` });
    await expect(reviewerTile).toContainText(`detached @ ${tip.slice(0, 7)} · ${implementer!.branch}`);
    await expect(reviewerTile.getByTestId('tile-role')).toHaveText('Reviewer');
    await expect(reviewerTile.getByTestId('tile-model')).toHaveCount(0);
    // It began with the zone's template, filled in.
    await reviewerTile.dblclick();
    await expect(screen(window)).toContainText(`> Review ${implementer!.branch}`);
    await window.getByRole('button', { name: 'Close session window' }).click();

    // Reset to the repo's puts the Reviewer template back to its seed, here the app's own.
    await zone.getByRole('button', { name: 'Zone options' }).click();
    await window.getByRole('menuitem', { name: /Role templates…/ }).click();
    await templates.getByRole('tab', { name: 'Reviewer', exact: true }).click();
    await expect(editor).toHaveValue('Review {{branch}}');
    await expect(templates).toContainText(/The app's own template · edited/);
    await templates.getByRole('button', { name: "Reset to the repo's" }).click();
    await expect(editor).toHaveValue(/adversarial reviewer/);
    await expect(templates).not.toContainText('edited');
    await expect(templates.getByRole('button', { name: "Reset to the repo's" })).toBeDisabled();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent started in a named role shows the name on its badge, and its zone lists a template for it', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const zone = zoneNamed(window, 'monorepo');

    // Named role… takes a typed name, which the chip and the template note then show.
    await zone.getByRole('button', { name: 'New agent' }).click();
    const form = window.getByRole('dialog', { name: 'New agent' });
    await pickInChip(form, 'Role', 'Named role…');
    await form.getByRole('textbox', { name: 'Role name' }).fill('  designer ');
    await form.getByRole('textbox', { name: 'Role name' }).press('Enter');
    await expect(form.getByRole('button', { name: /^Role:/ })).toHaveText('designer');
    await expect(form).toContainText("Uses monorepo's designer template.");
    await form.getByLabel('Task').fill('Mock the badge');
    await form.getByRole('button', { name: 'Start' }).click();
    await expect(form).toBeHidden();

    const designerTile = tile(window).filter({ hasText: 'Mock the badge' });
    await expect(designerTile.getByTestId('tile-role')).toHaveText('designer');
    const [designer] = await agents(window);
    expect(designer).toMatchObject({ role: 'custom', roleName: 'designer' });
    expect(designer!.branch).not.toBe('');

    // The zone's Role templates now list it, empty until saved.
    await zone.getByRole('button', { name: 'Zone options' }).click();
    await window.getByRole('menuitem', { name: /Role templates…/ }).click();
    const templates = window.getByRole('dialog', { name: 'Role templates' });
    await templates.getByRole('tab', { name: 'designer' }).click();
    await expect(templates.getByRole('textbox', { name: 'designer template' })).toHaveValue('');
    await expect(templates).toContainText('Empty until saved');
    await expect(templates.getByRole('button', { name: "Reset to the app's" })).toBeDisabled();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Orchestrator role in New agent adds a Checkout row and fills the task from its template; it starts in the main checkout, with the violet badge', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const zone = zoneNamed(window, 'monorepo');
    await zone.getByRole('button', { name: 'New agent' }).click();
    const form = window.getByRole('dialog', { name: 'New agent' });
    await expect(form.getByRole('group', { name: 'Checkout' })).toHaveCount(0);

    await pickInChip(form, 'Role', 'Orchestrator');
    await expect(form.getByRole('group', { name: 'Checkout' }).getByRole('button', { name: 'Main checkout' })).toHaveAttribute('aria-pressed', 'true');
    await expect(form.getByLabel('Task')).toHaveValue(/Orchestrate this zone/);
    await form.getByRole('button', { name: 'Start' }).click();
    await expect(form).toBeHidden();

    await expect.poll(async () => (await agents(window)).length).toBe(1);
    const [orchestrator] = await agents(window);
    expect(orchestrator).toMatchObject({ roleName: 'orchestrator', orchestrate: 'zone', ownsWorktree: false, worktree: repo });
    const badge = tile(window).getByTestId('tile-role');
    await expect(badge).toHaveText('orchestrator');
    await expect(badge).toHaveAttribute('data-orchestrator-role', 'true');

    // The worktree option still gives it a worktree of its own.
    await zone.getByRole('button', { name: 'New agent' }).click();
    await pickInChip(form, 'Role', 'Orchestrator');
    await form.getByRole('group', { name: 'Checkout' }).getByRole('button', { name: 'New worktree' }).click();
    await form.getByRole('button', { name: 'Start' }).click();
    await expect.poll(async () => (await agents(window)).length).toBe(2);
    expect((await agents(window))[1]).toMatchObject({ roleName: 'orchestrator', ownsWorktree: true });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an orchestrator in a dirty or off-branch main checkout warns in New agent and on its tile, and still starts; a clean default-branch checkout shows none', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    execFileSync('git', ['-C', repo, 'branch', '-M', 'main']);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const zone = zoneNamed(window, 'monorepo');
    const open = async () => {
      await zone.getByRole('button', { name: 'New agent' }).click();
      const form = window.getByRole('dialog', { name: 'New agent' });
      await pickInChip(form, 'Role', 'Orchestrator');
      return form;
    };

    const clean = await open();
    await expect(clean.getByRole('group', { name: 'Checkout' })).toBeVisible();
    await expect(clean.getByTestId('checkout-warning')).toHaveCount(0);
    await clean.getByRole('button', { name: 'Cancel' }).click();

    writeFileSync(join(repo, 'wip.txt'), 'unsaved\n');
    const dirty = await open();
    await expect(dirty.getByTestId('checkout-warning')).toHaveText('main checkout has uncommitted changes');
    // The worktree option has no main checkout to warn about.
    await dirty.getByRole('group', { name: 'Checkout' }).getByRole('button', { name: 'New worktree' }).click();
    await expect(dirty.getByTestId('checkout-warning')).toHaveCount(0);
    await dirty.getByRole('group', { name: 'Checkout' }).getByRole('button', { name: 'Main checkout' }).click();
    await dirty.getByRole('button', { name: 'Start' }).click();
    await expect(dirty).toBeHidden();
    await expect(tile(window).getByTestId('checkout-warning')).toHaveText('main checkout has uncommitted changes');

    // Off the default branch, and clean again: the tile follows.
    rmSync(join(repo, 'wip.txt'));
    execFileSync('git', ['-C', repo, 'switch', '--quiet', '-c', 'fix-login-flake']);
    await expect(tile(window).getByTestId('checkout-warning')).toHaveText('main checkout is on fix-login-flake', { timeout: 15_000 });
    const offBranch = await open();
    await expect(offBranch.getByTestId('checkout-warning')).toHaveText('main checkout is on fix-login-flake');
    await offBranch.getByRole('button', { name: 'Cancel' }).click();
    execFileSync('git', ['-C', repo, 'switch', '--quiet', 'main']);
    await expect(tile(window).getByTestId('checkout-warning')).toHaveCount(0, { timeout: 15_000 });
    expect(execFileSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('main');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
