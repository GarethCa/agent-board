// Starting a crew with every box its dialog shows filled in, from each way in: a zone's ⋯ (a crew and a ticket), New
// agent's Crew, ⌘K and the crew library. In a group with no repo it asks for one; a drafted crew with a ticket input asks
// for its ticket; with no tracker linked, the ticket goes to the agent as typed, and the dialog says it looks it up.
import { expect, type Page } from '@playwright/test';
import type { Agent } from '@agent-board/daemon/protocol';
import { agents, launch, SHELL_ENV, windowKey, zoneNamed, zones } from './agent-helpers.ts';
import { test, addEmptyZone, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

const promptBox = (page: Page) => page.getByRole('dialog', { name: 'Start a crew', exact: true });
const ticketSheet = (page: Page) => page.getByRole('dialog', { name: 'New ticket', exact: true });

/** Saves a crew as an agent drafts one: Your prompt and a ticket both go to its one builder. */
const saveDrafted = (page: Page) =>
  page.evaluate(() =>
    window.agentBoard.orchestrators.savePrefab({
      name: 'Drafted fix',
      icon: 'crew',
      purpose: 'Fixes a ticket',
      roundLimit: 1,
      onBoard: 'card',
      members: [{ id: 'impl', role: 'implementer', name: null, harness: 'claude', model: null, effort: null, template: null, starts: 'prompt', subagents: [] }],
      inputs: [
        { id: 'prompt', kind: 'prompt' },
        { id: 'ticket', kind: 'ticket' },
        { id: 'end', kind: 'end', as: 'ready' },
      ],
      gates: [],
      lines: [
        { from: 'prompt', to: 'impl' },
        { from: 'ticket', to: 'impl' },
        { from: 'impl', to: 'end' },
      ],
    }),
  );

/** Fits the board in the window, so a zone the new tiles pushed aside is in view again. */
const fitView = (page: Page) => page.getByRole('button', { name: /^Fit view/i }).click();

/** The one agent started since `known`. */
const startedSince = async (page: Page, known: readonly Agent[]): Promise<Agent | undefined> =>
  (await agents(page)).find((agent) => !known.some((each) => each.sessionId === agent.sessionId));

test('every crew dialog starts once each box it shows is filled in, and says why while it can’t', async () => {
  test.setTimeout(120_000);
  const { repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await addEmptyZone(window, 'Bank');
    await saveDrafted(window);
    const idOf = async (name: string) => (await zones(window)).find((zone) => zone.name === name)!.id;
    const bank = zoneNamed(window, 'Bank');
    const box = promptBox(window);
    /** Presses Start and waits for its one agent, in `zone`. */
    const startsIn = async (start: () => Promise<void>, zone: string) => {
      const known = await agents(window);
      await start();
      // A crew's member starts in a fresh worktree, which can take a while on a loaded machine.
      await expect
        .poll(async () => (await startedSince(window, known))?.zoneId, { timeout: 30_000, message: `started in ${zone}; the dialogs said: ${await window.getByRole('dialog').allTextContents()}` })
        .toBe(await idOf(zone));
    };

    // A zone's ⋯ in a group: the drafted crew asks for its repo (a recent one, picked for it) and its ticket.
    await bank.getByRole('button', { name: 'Zone options' }).click();
    await window.getByRole('menuitem', { name: 'New crew' }).click();
    await window.getByRole('menuitem', { name: /^Drafted fix/ }).press('Enter');
    await expect(box.getByRole('combobox', { name: 'Repo' })).not.toHaveValue('');
    const start = box.getByRole('button', { name: /^Start/ });
    await expect(start).toBeDisabled();
    await expect(box.getByTestId('start-blocked')).toHaveText('Give it its ticket, or say what it should do.');
    await box.getByRole('textbox', { name: 'Ticket' }).fill('ABC-12');
    await expect(box).toContainText('looks it up itself');
    await expect(box.getByTestId('start-blocked')).toHaveCount(0);
    await startsIn(() => start.click(), 'Bank');
    await expect(box).toBeHidden();
    // The ticket reached it: named after the ticket as typed, and linked to no issue.
    await expect.poll(async () => (await agents(window)).find((agent) => agent.name === 'ABC-12')?.issue).toBeNull();

    // New agent's Crew in the repo zone: its ticket and a prompt.
    const sheet = window.getByRole('dialog', { name: 'New agent' });
    await fitView(window);
    await zoneNamed(window, 'monorepo').getByRole('button', { name: 'New agent' }).click();
    await sheet.getByRole('group', { name: 'Start' }).getByRole('button', { name: 'Crew' }).click();
    await sheet.getByRole('button', { name: 'All prefabs…' }).click();
    await window.getByRole('dialog', { name: 'Crew library', exact: true }).getByTestId('prefab-card').filter({ hasText: 'Drafted fix' }).getByRole('button', { name: 'Start' }).click();
    await box.getByRole('textbox', { name: 'Ticket' }).fill('https://linear.app/acme/issue/ABC-13/add-a-footer');
    await box.getByRole('textbox', { name: 'Prompt' }).fill('Keep it small');
    await startsIn(() => start.click(), 'monorepo');
    await expect(box).toBeHidden();
    await expect.poll(async () => (await agents(window)).some((agent) => agent.name === 'ABC-13: Keep it small')).toBe(true);
    // Whatever it was picked from closes with it, or is left to close.
    const library = window.getByRole('dialog', { name: 'Crew library', exact: true });
    if (await library.isVisible()) await library.getByRole('button', { name: 'Done' }).click();
    if (await sheet.isVisible()) await sheet.getByRole('button', { name: 'Cancel' }).click();

    // ⌘K, its zone changed to the group: a prompt alone starts it there.
    await window.keyboard.press(windowKey('k'));
    await window.getByRole('dialog', { name: 'Jump to a session, zone or setting' }).getByRole('combobox', { name: 'Jump to a session, zone or setting' }).fill('drafted');
    await window.keyboard.press('Enter');
    await box.getByRole('combobox', { name: 'Zone' }).selectOption(await idOf('Bank'));
    // The group asks for a repo, and a recent one is picked for it once the list has loaded.
    await expect(box.getByRole('combobox', { name: 'Repo' })).not.toHaveValue('');
    await box.getByRole('textbox', { name: 'Prompt' }).fill('Tidy the docs');
    await startsIn(() => box.getByRole('textbox', { name: 'Prompt' }).press('ControlOrMeta+Enter'), 'Bank');
    await expect(box).toBeHidden();

    // A zone's ⋯ › New ticket in the group: the sheet asks for its repo now, and starts on the ticket alone.
    const tickets = ticketSheet(window);
    await fitView(window);
    await bank.getByRole('button', { name: 'Zone options' }).click();
    await window.getByRole('menuitem', { name: 'New crew' }).click();
    await window.getByRole('menuitem', { name: /New ticket/ }).press('Enter');
    await expect(tickets.getByRole('combobox', { name: 'Repo' })).not.toHaveValue('');
    await expect(tickets.getByTestId('start-blocked')).toHaveText('Give it its ticket, or say what it should do.');
    await tickets.getByRole('textbox', { name: 'Ticket' }).fill('ABC-14');
    await expect(tickets).toContainText('looks it up itself');
    await startsIn(() => tickets.getByRole('button', { name: /Start ticket/ }).click(), 'Bank');
    await expect(tickets).toBeHidden();
    await expect.poll(async () => (await agents(window)).some((agent) => agent.name === 'ABC-14' && agent.ticketChat)).toBe(true);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
