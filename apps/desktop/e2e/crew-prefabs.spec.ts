// A crew prefab's flow editor, from a zone's ⋯ › Crew prefabs…: a built-in copied under a name of your own, a
// reviewer added and set up in the inspector, the flow read back in words, saved to the app's library, edited and
// renamed (read back from the library), a refused save, and removed.
import { expect, type Page } from '@playwright/test';
import type { LibraryPrefab } from '@agent-board/daemon/protocol';
import { launch, zoneNamed } from './agent-helpers.ts';
import { test, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

/** The app's crew prefab library, as the app reads it. */
const prefabs = (page: Page): Promise<LibraryPrefab[]> => page.evaluate(async () => (await window.agentBoard.orchestrators.prefabs()).prefabs);

test('a built-in crew prefab is copied, given a second reviewer, saved, edited and renamed, refused a built-in\'s name, and removed', async () => {
  const { repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await zoneNamed(window, 'monorepo').getByRole('button', { name: 'Zone options' }).click();
    await window.getByRole('menuitem', { name: /Crew prefabs…/ }).click();

    const library = window.getByRole('dialog', { name: 'Crew prefabs', exact: true });
    const pair = library.getByRole('listitem').filter({ hasText: 'Implementer + reviewer' });
    await expect(pair).toContainText('Built-in');
    await pair.getByRole('button', { name: 'Copy' }).click();

    const editor = window.getByRole('dialog', { name: 'Crew prefab', exact: true });
    await expect(editor.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Implementer + reviewer (mine)');
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Pair and design');
    await editor.getByRole('button', { name: 'Add member' }).click();
    await editor.getByRole('textbox', { name: 'Member name' }).fill('Design review');
    await editor.getByRole('group', { name: 'Reasoning' }).getByRole('button', { name: 'High', exact: true }).click();
    await expect(editor.getByRole('button', { name: 'Design review, high' })).toHaveAttribute('aria-pressed', 'true');
    await expect(editor).toContainText('If both approve, the crew stops: ready to merge.');

    await editor.getByRole('button', { name: 'Save a copy' }).click();
    await expect(editor).toBeHidden();
    const saved = library.getByRole('listitem').filter({ hasText: 'Pair and design' });
    await expect(saved).toBeVisible();

    // Edit it: renamed, with one more round, it replaces itself, and the library holds what was set.
    await saved.getByRole('button', { name: 'Edit' }).click();
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Pair with design');
    await editor.getByRole('combobox', { name: 'Round limit' }).selectOption('4');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor).toBeHidden();
    await expect(library.getByRole('listitem').filter({ hasText: 'Pair and design' })).toHaveCount(0);
    const renamed = library.getByRole('listitem').filter({ hasText: 'Pair with design' });
    await expect(renamed).toBeVisible();
    const kept = (await prefabs(window)).find((prefab) => prefab.name === 'Pair with design');
    expect(kept).toMatchObject({ roundLimit: 4, builtIn: false });
    expect(kept!.members.map((member) => [member.name, member.role, member.starts, member.effort])).toEqual([
      [null, 'implementer', 'prompt', null],
      [null, 'reviewer', 'handoff', null],
      ['Design review', 'reviewer', 'handoff', 'high'],
    ]);

    // A name the library refuses (a built-in's) says why on Save; closing with the change asks before it is lost.
    await renamed.getByRole('button', { name: 'Edit' }).click();
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Solo agent');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor).toContainText('Solo agent is a built-in prefab');
    await editor.getByRole('button', { name: 'Cancel' }).click();
    const discard = window.getByRole('alertdialog', { name: 'Discard your changes?' });
    await discard.getByRole('button', { name: 'Discard' }).click();
    await expect(editor).toBeHidden();

    // Remove asks first, in its row.
    await renamed.getByRole('button', { name: 'Remove' }).click();
    await expect(renamed).toContainText('Remove it for good?');
    await renamed.getByRole('button', { name: 'Remove' }).click();
    await expect(renamed).toBeHidden();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
