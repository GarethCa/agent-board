// A ticket from a ticket prefab: New ticket from a zone's ⋯ starts one with its chat as the implementer (the builds mark
// by its title) or as its own lead, and the tile's ⋯ switches who builds, at a hand-off.
import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import type { Agent } from '@agent-board/daemon/protocol';
import { agents, launch, SHELL_ENV, TURN_MS, zoneNamed } from './agent-helpers.ts';
import { test, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

const sheetOf = (page: Page) => page.getByRole('dialog', { name: 'New ticket', exact: true });
/** A ticket's tile by its chat's session: its card, or the tile opened in place (a live chat opens as its terminal). */
const tileOf = (page: Page, sessionId: string) =>
  page.locator(`:is([data-testid="agent-tile"], [data-testid="expanded-tile"])[data-session-id="${sessionId}"]`);
/** A ticket's chat by its session, as the daemon has it now. */
const chatNow = async (page: Page, sessionId: string): Promise<Agent | undefined> => (await agents(page)).find((agent) => agent.sessionId === sessionId);
/** The one ticket's chat started since `known`: a turn's status soon replaces what it was asked, so not by that. */
const newChat = async (page: Page, known: readonly Agent[]): Promise<Agent | undefined> =>
  (await agents(page)).find((agent) => agent.ticketChat && !known.some((each) => each.sessionId === agent.sessionId));
const setChat = (page: Page, sessionId: string, kind: 'implementer' | 'lead') =>
  page.evaluate(([id, picked]) => window.agentBoard.orchestrators.setTicketChat(id!, picked as 'implementer' | 'lead'), [sessionId, kind]);
const answer = (page: Page, sessionId: string, text: string) => page.evaluate(([id, typed]) => window.agentBoard.agents.answer(id!, typed!), [sessionId, text]);

async function newTicket(page: Page) {
  await zoneNamed(page, 'monorepo').getByRole('button', { name: 'Zone options' }).click();
  await page.getByRole('menuitem', { name: 'New crew' }).click();
  await page.getByRole('menuitem', { name: /New ticket/ }).press('Enter');
  await expect(sheetOf(page)).toBeVisible();
}

test('a ticket starts from its prefab with either kind of chat, and its ⋯ switches who builds at a hand-off', async () => {
  // Three turns of the fake harness, and a builder that starts and hands off.
  test.setTimeout(150_000);
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV, FAKE_HARNESS_REPEAT: '1' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const sheet = sheetOf(window);

    // The implementer by default: one session, which builds.
    await newTicket(window);
    await expect(sheet.getByRole('radio', { name: /The implementer/ })).toBeChecked();
    await expect(sheet.getByRole('button', { name: /Start ticket/ })).toBeDisabled();
    await sheet.getByRole('textbox', { name: 'Prompt' }).fill('Add a footer');
    await sheet.getByRole('button', { name: /Start ticket/ }).click();
    await expect(sheet).toBeHidden();
    await expect.poll(async () => (await newChat(window, []))?.chatKind).toBe('implementer');
    const built = (await newChat(window, []))!;
    await expect(tileOf(window, built.sessionId).getByTestId('ticket-builds')).toBeVisible();

    // Its own lead, picked for this ticket alone: the chat leads, and has no builds mark.
    await newTicket(window);
    await sheet.getByRole('radio', { name: /Its own lead/ }).check();
    await sheet.getByRole('textbox', { name: 'Prompt' }).fill('Add a header');
    await sheet.getByRole('button', { name: /Start ticket/ }).click();
    await expect(sheet).toBeHidden();
    await expect.poll(async () => (await newChat(window, [built]))?.chatKind).toBe('lead');
    const led = (await newChat(window, [built]))!;
    expect(led).toMatchObject({ role: 'custom', roleName: 'orchestrator' });
    await expect(tileOf(window, led.sessionId).getByTestId('ticket-builds')).toHaveCount(0);

    // The implementer, its turn ended (a hand-off: at its prompt, not mid-turn), becomes its own lead at once: a builder
    // starts in its worktree. Its turn ends without `done`, so the turn's end is the signal, not finished work.
    await expect.poll(async () => (await chatNow(window, built.sessionId))?.finishedAt ?? null, { timeout: TURN_MS }).not.toBeNull();
    const footer = tileOf(window, built.sessionId);
    await footer.getByRole('button', { name: 'More' }).click();
    await expect(window.getByRole('menuitemradio', { name: /The implementer/ })).toHaveAttribute('aria-checked', 'true');
    await window.getByRole('menuitemradio', { name: /Its own lead/ }).click();
    await expect.poll(async () => (await chatNow(window, built.sessionId))?.chatKind, { timeout: TURN_MS }).toBe('lead');
    await expect(footer.getByTestId('ticket-builds')).toHaveCount(0);
    const builderOf = async () => (await agents(window)).find((agent) => agent.ticket === built.sessionId && agent.role === 'implementer');
    await expect.poll(async () => (await builderOf())?.worktree).toBe(built.worktree);
    const builder = (await builderOf())!;

    // Back to the implementer while the builder is mid-turn: it waits for the builder to hand off, and says so.
    await expect.poll(async () => (await agents(window)).find((agent) => agent.sessionId === builder.sessionId)?.state, { timeout: TURN_MS }).toBe('waiting');
    await answer(window, builder.sessionId, 'Work slowly');
    await expect.poll(async () => (await agents(window)).find((agent) => agent.sessionId === builder.sessionId)?.state).toMatch(/running|thinking/);
    // Picked at once, well inside its slow turn, so the switch waits (the ⋯ row's wiring is the lead pick's, above).
    const asked = await setChat(window, built.sessionId, 'implementer');
    expect(asked).toMatchObject({ chatKind: 'lead', chatSwitch: 'implementer' });
    await footer.getByRole('button', { name: 'More' }).click();
    await expect(window.getByRole('menuitemradio', { name: /The implementer/ })).toContainText('after the builder hands off');
    await window.keyboard.press('Escape');

    // Its slow turn ends, a hand-off: the chat builds again, and the builder closes.
    await expect.poll(async () => (await chatNow(window, built.sessionId))?.chatKind, { timeout: TURN_MS }).toBe('implementer');
    await expect.poll(async () => (await agents(window)).some((agent) => agent.sessionId === builder.sessionId), { timeout: TURN_MS }).toBe(false);
    await expect(footer.getByTestId('ticket-builds')).toBeVisible();
  } finally {
    await app.close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
