import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, pickInChip, tile, zones, zoneNamed } from './agent-helpers.ts';
import { test, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

// New agent under the Simplified design: the same dialog in its sheet style, asking for the assistant, the task and a
// name. The model and role are technical details, so they come back with Show technical details and not before.

for (const technical of [false, true]) {
  test(`New agent under the Simplified design ${technical ? 'adds' : 'leaves out'} the model and role chips, ${technical ? 'with' : 'without'} Show technical details`, async () => {
    const { dir, repo, env } = scratch('output');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, env, [], { design: 'simplified', technical });
    try {
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await zoneNamed(window, 'monorepo').getByRole('button', { name: 'New agent' }).click();
      const form = window.getByRole('dialog', { name: 'New agent' });
      await expect(form.getByRole('button', { name: /^Harness:/ })).toBeVisible();
      await expect(form.getByLabel('Task')).toBeVisible();
      await expect(form.getByLabel('Name (optional)')).toBeVisible();
      for (const chip of ['Model', 'Role']) {
        const button = form.getByRole('button', { name: new RegExp(`^${chip}:`) });
        if (technical) await expect(button).toBeVisible();
        else await expect(button).toBeHidden();
      }
      if (technical) await pickInChip(form, 'Role', 'Implementer');
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('New agent under the Simplified design still starts an agent from its task, and switching the details off puts the role back', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env, [], { design: 'simplified', technical: true });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await zoneNamed(window, 'monorepo').getByRole('button', { name: 'New agent' }).click();
    const form = window.getByRole('dialog', { name: 'New agent' });
    await pickInChip(form, 'Role', 'Reviewer');
    await expect(form).toContainText("Uses monorepo's Reviewer template.");
    // The switch turned off while the dialog is open: the chips go, and the role they set goes with them.
    await app.evaluate(({ Menu }) => {
      const view = Menu.getApplicationMenu()!.items.find((menu) => menu.label === 'View')!;
      view.submenu!.items.find((entry) => entry.label === 'Show Technical Details')!.click();
    });
    await expect(form.getByRole('button', { name: /^Role:/ })).toBeHidden();
    await expect(form).not.toContainText('Reviewer template');
    await expect(form.getByRole('group', { name: 'Harness' })).toBeVisible();
    await form.getByLabel('Task').fill('Build it');
    await form.getByRole('button', { name: 'Start' }).click();
    await expect(form).toBeHidden();
    await expect(tile(window).filter({ hasText: 'Build it' })).toHaveCount(1);
    expect((await agents(window))[0]).toMatchObject({ role: null });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Ask Claude under the Simplified design keeps its model and role chips', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env, [], { design: 'simplified' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const [zone] = await zones(window);
    const shape = { shape: 'rounded', fill: null, stroke: '#2b2a27', strokeWidth: 2, dashed: false, text: 'API', textSize: 'body', bold: false, textColor: '#2b2a27' };
    await window.evaluate(async ({ zoneId, data }) => {
      await globalThis.window.agentBoard.items.create({ kind: 'shape', zoneId, x: 20, y: 60, width: 120, height: 70, data });
    }, { zoneId: zone!.id, data: shape });
    await window.getByTestId('shape').click();
    await window.keyboard.press('ControlOrMeta+Shift+A');
    const popover = window.getByRole('dialog', { name: 'Ask Claude' });
    await expect(popover.getByRole('button', { name: /^Model:/ })).toBeVisible();
    await expect(popover.getByRole('button', { name: /^Role: .*rchitect/ })).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
