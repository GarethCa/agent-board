// The app's crew prefabs: the crew library from the board menu, the flow editor it opens (a built-in copied under a
// name of your own, edited, renamed, refused a built-in's name, removed), a file imported, and each way a crew starts:
// New agent's Crew, a zone's ⋯, and ⌘K, through the one prompt box. A started crew's card is on the board, and its
// crew stops from it on the user's yes.
import { expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LibraryPrefab } from '@agent-board/daemon/protocol';
import { run } from './board-helpers.ts';
import { agents, launch, screen, sessionWindow, SHELL_ENV, TURN_MS, windowKey, zoneNamed, zones } from './agent-helpers.ts';
import { test, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

/** The app's crew prefab library, as the app reads it. */
const prefabs = (page: Page): Promise<LibraryPrefab[]> => page.evaluate(async () => (await window.agentBoard.orchestrators.prefabs()).prefabs);

const library = (page: Page) => page.getByRole('dialog', { name: 'Crew library', exact: true });
const editorOf = (page: Page) => page.getByRole('dialog', { name: 'Crew prefab', exact: true });
const promptBox = (page: Page) => page.getByRole('dialog', { name: 'Start a crew', exact: true });
const card = (page: Page, name: string) => library(page).getByTestId('prefab-card').filter({ hasText: name });
/** A running crew's card on the board, by what its crew was asked. */
const crewCard = (page: Page, asked: string) => page.getByTestId('crew-card').filter({ hasText: asked });

async function openLibrary(page: Page) {
  await page.getByTestId('board-menu').getByRole('button').first().click();
  await page.getByRole('button', { name: 'Crew library' }).click();
  await expect(library(page)).toBeVisible();
}

test('the library makes and shares prefabs: copied, edited, renamed, refused a built-in’s name, removed, and a file imported', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await openLibrary(window);

    await expect(card(window, 'Implementer + reviewer')).toContainText('Built in');
    await expect(card(window, 'Implementer + reviewer')).toContainText('3 rounds');
    await expect(card(window, 'Lead and crew')).toContainText('lead decides');
    await card(window, 'Implementer + reviewer').getByRole('button', { name: 'Copy' }).click();

    const editor = editorOf(window);
    await expect(editor.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Implementer + reviewer (mine)');
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Pair and design');
    await editor.getByRole('button', { name: 'Add member' }).click();
    await editor.getByRole('textbox', { name: 'Member name' }).fill('Design review');
    await editor.getByRole('group', { name: 'Reasoning' }).getByRole('button', { name: 'High', exact: true }).click();
    await expect(editor.getByRole('button', { name: 'Design review, high' })).toHaveAttribute('aria-pressed', 'true');
    await expect(editor).toContainText('If both approve, the crew stops: ready to merge.');
    await editor.getByRole('button', { name: 'Save a copy' }).click();
    await expect(editor).toBeHidden();

    // Yours come first.
    await expect(library(window).getByTestId('prefab-card').first()).toContainText('Pair and design');
    await expect(card(window, 'Pair and design')).toContainText('Yours');

    // Edited: renamed, with one more round, it replaces itself, and the library holds what was set.
    await card(window, 'Pair and design').getByRole('button', { name: 'Edit' }).click();
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Pair with design');
    await editor.getByRole('combobox', { name: 'Round limit' }).selectOption('4');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor).toBeHidden();
    await expect(card(window, 'Pair and design')).toHaveCount(0);
    await expect(card(window, 'Pair with design')).toBeVisible();
    const kept = (await prefabs(window)).find((prefab) => prefab.name === 'Pair with design');
    expect(kept).toMatchObject({ roundLimit: 4, builtIn: false });
    expect(kept!.members.map((member) => [member.name, member.role, member.starts, member.effort])).toEqual([
      [null, 'implementer', 'prompt', null],
      [null, 'reviewer', 'handoff', null],
      ['Design review', 'reviewer', 'handoff', 'high'],
    ]);

    // A name the library refuses (a built-in's) says why on Save; closing with the change asks before it is lost.
    await card(window, 'Pair with design').getByRole('button', { name: 'Edit' }).click();
    await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Solo agent');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor).toContainText('Solo agent is a built-in prefab');
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await window.getByRole('alertdialog', { name: 'Discard your changes?' }).getByRole('button', { name: 'Discard' }).click();
    await expect(editor).toBeHidden();

    // Remove asks first, on its card.
    await card(window, 'Pair with design').getByRole('button', { name: 'Remove' }).click();
    await expect(card(window, 'Pair with design')).toContainText('Remove it for good?');
    await card(window, 'Pair with design').getByRole('button', { name: 'Remove' }).click();
    await expect(card(window, 'Pair with design')).toHaveCount(0);

    // A file is shown whole in the editor, and added only by Save.
    const file = join(dir, 'docs.crew.json');
    writeFileSync(
      file,
      JSON.stringify({
        agentBoardCrewPrefab: 1,
        name: 'Docs pass',
        members: [
          { id: 'writer', role: 'implementer', starts: 'prompt' },
          { id: 'checker', role: 'reviewer', starts: 'handoff' },
        ],
      }),
    );
    await pickFolderNext(app, file);
    await library(window).getByRole('button', { name: 'Import a file' }).click();
    await expect(editor.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Docs pass');
    await expect(editor).toContainText('added to the library once you save');
    expect((await prefabs(window)).some((prefab) => prefab.name === 'Docs pass')).toBe(false);
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(card(window, 'Docs pass')).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

/** Saves a prefab whose builder is on Codex. */
const saveCodexPair = (page: Page) =>
  page.evaluate(() =>
    window.agentBoard.orchestrators.savePrefab({
      name: 'Codex pair',
      icon: 'crew',
      purpose: '',
      roundLimit: 2,
      onBoard: 'card',
      members: [
        { id: 'impl', role: 'implementer', name: null, harness: 'codex', model: null, effort: null, template: null, starts: 'prompt', subagents: [] },
        { id: 'review', role: 'reviewer', name: null, harness: 'claude', model: null, effort: null, template: null, starts: 'handoff', subagents: [] },
      ],
    }),
  );

/** A second repo beside the scratch one, to be a second zone. */
function secondRepo(dir: string): string {
  const repo = join(dir, 'api');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '--quiet');
  writeFileSync(join(repo, 'index.ts'), 'export {};\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'init');
  return repo;
}

test('a crew starts in the right zone from every entry point, through one prompt box, its round limit for this crew alone', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await pickFolderNext(app, secondRepo(dir));
    await browseForZone(window);
    const zoneList = await zones(window);
    const idOf = (name: string) => zoneList.find((zone) => zone.name === name)!.id;
    const web = zoneNamed(window, 'monorepo');
    const api = zoneNamed(window, 'api');
    const box = promptBox(window);
    const sheet = window.getByRole('dialog', { name: 'New agent' });

    // New agent's Crew in the second zone: picking one opens its prompt box in the sheet's place, naming the zone.
    await api.getByRole('button', { name: 'New agent' }).click();
    await sheet.getByRole('group', { name: 'Start' }).getByRole('button', { name: 'Crew' }).click();
    await sheet.getByRole('button', { name: /Implementer \+ reviewer/ }).click();
    await expect(sheet).toBeHidden();
    await expect(box.getByRole('heading')).toHaveText('Implementer + reviewer in api');
    await expect(box).toContainText('after Impl hands off');
    await expect(box.getByRole('button', { name: /Start crew/ })).toBeDisabled();
    // Cancel goes back to the sheet it was picked in.
    await box.getByRole('button', { name: 'Cancel' }).click();
    await sheet.getByRole('button', { name: /Implementer \+ reviewer/ }).click();
    const prompt = box.getByRole('textbox', { name: 'Prompt' });
    await prompt.fill('Add a footer');
    await box.getByRole('combobox', { name: 'Round limit' }).selectOption('5');
    // ⌘↵ starts it, once, however fast it is pressed.
    await prompt.press('ControlOrMeta+Enter');
    await prompt.press('ControlOrMeta+Enter').catch(() => {});
    await expect(box).toBeHidden();
    await expect.poll(async () => (await agents(window)).filter((agent) => agent.description === 'Add a footer').map((agent) => agent.zoneId)).toEqual([idOf('api')]);
    // Its builder's tile is shown: selected, as there is nothing else of the crew to see yet.
    await expect(window.locator('.react-flow__node.selected').filter({ hasText: 'Add a footer' })).toBeVisible();
    // Still one, now the start has settled: the second press started nothing.
    expect((await agents(window)).filter((agent) => agent.description === 'Add a footer')).toHaveLength(1);
    expect((await prefabs(window)).find((prefab) => prefab.name === 'Implementer + reviewer')?.roundLimit).toBe(3);
    // Its card is on the board: what it was asked, its round of the five asked for, and a row for each member.
    const footer = crewCard(window, 'Add a footer');
    await expect(footer.getByTestId('crew-card-round')).toHaveText('round 1 of 5');
    await expect(footer.getByTestId('crew-card-row')).toHaveCount(2);

    // The sheet remembers a crew was started, and a crew from its library starts in its zone.
    await api.getByRole('button', { name: 'New agent' }).click();
    await expect(sheet.getByRole('group', { name: 'Start' }).getByRole('button', { name: 'Crew' })).toHaveAttribute('aria-pressed', 'true');
    await sheet.getByRole('button', { name: 'All prefabs…' }).click();
    await card(window, 'Spike + reviewer').getByRole('button', { name: 'Start' }).click();
    await expect(box.getByRole('heading')).toHaveText('Spike + reviewer in api');
    await box.getByRole('button', { name: 'Cancel' }).click();
    await library(window).getByRole('button', { name: 'Done' }).click();
    await sheet.getByRole('button', { name: 'Cancel' }).click();

    // A zone's ⋯ › New crew names that zone.
    await web.getByRole('button', { name: 'Zone options' }).click();
    await window.getByRole('menuitem', { name: 'New crew' }).click();
    await window.getByRole('menuitem', { name: /Spike \+ reviewer/ }).press('Enter');
    await expect(box.getByRole('heading')).toHaveText('Spike + reviewer in monorepo');
    await box.getByRole('button', { name: 'Cancel' }).click();

    // ⌘K: ↵ opens the crew, and no agent starts named for what was typed. Its guess at the zone can be changed.
    const before = (await agents(window)).length;
    await window.keyboard.press(windowKey('k'));
    await window.getByRole('dialog', { name: 'Jump to a session, zone or setting' }).getByRole('combobox', { name: 'Jump to a session, zone or setting' }).fill('spike');
    await window.keyboard.press('Enter');
    await expect(box).toContainText('Spike + reviewer');
    await expect(box.getByRole('combobox', { name: 'Zone' })).toBeVisible();
    await box.getByRole('combobox', { name: 'Zone' }).selectOption(idOf('monorepo'));
    expect(await agents(window)).toHaveLength(before);
    await box.getByRole('button', { name: 'Cancel' }).click();

    // The board's right-click: its Zone starts on the zone nearest the click, and a crew starts there.
    const apiBox = (await api.boundingBox())!;
    const nearest = 'api';
    await window.locator('.react-flow__pane').click({ button: 'right', position: { x: apiBox.x + apiBox.width / 2, y: apiBox.y + apiBox.height + 24 } });
    await window.getByRole('menuitem', { name: 'New crew' }).press('ArrowRight');
    await window.getByRole('menuitem', { name: /Solo agent/ }).press('Enter');
    await expect(box.getByRole('combobox', { name: 'Zone' })).toHaveValue(idOf(nearest));
    await expect(box.getByRole('button', { name: /^Start/ })).toHaveText(/^Start(?! crew)/);
    await box.getByRole('textbox', { name: 'Prompt' }).fill('Tidy up');
    await box.getByRole('button', { name: /^Start/ }).click();
    await expect.poll(async () => (await agents(window)).filter((agent) => agent.description === 'Tidy up').map((agent) => agent.zoneId)).toEqual([idOf(nearest)]);

    // A prefab with a Codex member says what New agent says first, once, and Back keeps the prompt.
    await saveCodexPair(window);
    // Saved with no reload of the zone: its ⋯ lists it, as it does one added from a shell.
    await api.getByRole('button', { name: 'Zone options' }).click();
    await window.getByRole('menuitem', { name: 'New crew' }).click();
    await window.getByRole('menuitem', { name: /Codex pair/ }).press('Enter');
    await box.getByRole('textbox', { name: 'Prompt' }).fill('Port it');
    await box.getByRole('button', { name: /Start crew/ }).click();
    const notice = window.getByRole('dialog', { name: 'About Codex hooks' });
    await notice.getByRole('button', { name: 'Back' }).click();
    await expect(box.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Port it');
    await box.getByRole('button', { name: 'Cancel' }).click();

    // The crew itself holds the round limit asked for.
    await api.getByRole('button', { name: 'New shell in zone' }).click();
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await run(window, 'agent-board crew');
    await expect(screen(window)).toContainText(/Implementer \+ reviewer +round \d of 5/, { timeout: TURN_MS });

    // A crew stops from its card, on the user's yes: the card then says so, and can be taken off the board.
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow(window)).toBeHidden();
    await footer.locator('.crew-card-title').click();
    await window.getByRole('button', { name: 'Stop crew', exact: true }).click();
    const stop = window.getByRole('alertdialog', { name: 'Stop this crew?' });
    await expect(stop).toContainText('Add a footer');
    await stop.getByRole('button', { name: 'Stop crew' }).click();
    await expect(footer.getByTestId('crew-card-label')).toHaveText('Stopped');
    await expect(window.getByRole('button', { name: 'Stop crew', exact: true })).toBeHidden();
    await window.getByRole('button', { name: 'Take it off the board' }).click();
    await expect(footer).toHaveCount(0);
    // Its agents stay as they were.
    expect((await agents(window)).filter((agent) => agent.description === 'Add a footer')).toHaveLength(1);

    // Taking a running crew's card off the board asks to stop its crew first, from its key as from its button: the
    // card stays drawn while the question waits, and on a no its crew runs on.
    await window.evaluate((zoneId) => globalThis.window.agentBoard.orchestrators.startPrefab({ name: 'Spike + reviewer', prompt: 'Try a cache', zoneId }), idOf('monorepo'));
    const cache = crewCard(window, 'Try a cache');
    const remove = window.getByRole('alertdialog', { name: 'Stop this crew and take its card off the board?' });
    await cache.locator('.crew-card-title').click();
    await window.keyboard.press('Backspace');
    await expect(remove).toContainText('Try a cache');
    await expect(cache).toBeVisible();
    await remove.getByRole('button', { name: 'Cancel' }).click();
    await expect(remove).toBeHidden();
    await expect(cache).toBeVisible();
    await expect(cache.getByTestId('crew-card-label')).toHaveCount(0);
    await expect(window.getByRole('button', { name: 'Stop crew', exact: true })).toBeVisible();

    await cache.locator('.crew-card-title').click();
    await window.keyboard.press('Backspace');
    await expect(cache).toBeVisible();
    await remove.getByRole('button', { name: 'Stop and remove' }).click();
    // Gone, so its crew stopped: the daemon keeps a running crew's card.
    await expect(cache).toHaveCount(0);
    expect((await agents(window)).filter((agent) => agent.description === 'Try a cache')).toHaveLength(1);

    // Its button asks the same.
    await window.evaluate((zoneId) => globalThis.window.agentBoard.orchestrators.startPrefab({ name: 'Spike + reviewer', prompt: 'Try a queue', zoneId }), idOf('monorepo'));
    const queue = crewCard(window, 'Try a queue');
    await queue.locator('.crew-card-title').click();
    await window.getByRole('button', { name: 'Stop crew and take its card off the board' }).click();
    await expect(remove).toContainText('Try a queue');
    await remove.getByRole('button', { name: 'Stop and remove' }).click();
    await expect(queue).toHaveCount(0);

    // Two running crews' cards deleted together are asked about once, each by what it was asked, and both stop.
    for (const prompt of ['Try a heap', 'Try a stack']) {
      await window.evaluate(([zoneId, asked]) => globalThis.window.agentBoard.orchestrators.startPrefab({ name: 'Spike + reviewer', prompt: asked!, zoneId: zoneId! }), [idOf('monorepo'), prompt]);
    }
    const heap = crewCard(window, 'Try a heap');
    const stack = crewCard(window, 'Try a stack');
    await heap.locator('.crew-card-title').click();
    await stack.locator('.crew-card-title').click({ modifiers: ['Shift'] });
    await window.keyboard.press('Backspace');
    const both = window.getByRole('alertdialog', { name: 'Delete selection?' });
    await expect(both).toContainText('The crew asked “Try a heap” is stopped');
    await expect(both).toContainText('The crew asked “Try a stack” is stopped');
    await expect(heap).toBeVisible();
    await expect(stack).toBeVisible();
    await both.getByRole('button', { name: 'Delete' }).click();
    await expect(heap).toHaveCount(0);
    await expect(stack).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
