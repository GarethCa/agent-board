import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, spawnAgent, tile, zones } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';

/** Picks how agent notes look, from the board menu's Settings, and closes the menu again. */
async function agentNotesLook(window: Page, look: 'Document' | 'Terminal'): Promise<void> {
  const menu = window.getByRole('dialog', { name: 'Board menu' });
  await window.getByRole('button', { name: 'Board menu' }).dispatchEvent('click');
  const choice = menu.getByRole('group', { name: 'Agent notes' }).getByRole('button', { name: look });
  await choice.click();
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  await window.keyboard.press('Escape');
  await expect(menu).toBeHidden();
}

test("an agent note: its badge selects its agent's tile, a tether leads there, the user's edit says so, and the look switches live", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Run the crew');
    const lead = tile(window).filter({ hasText: 'Run the crew' });
    await expect(lead).toHaveAttribute('data-state', 'waiting');
    const [agent] = await agents(window);
    const [zone] = await zones(window);
    await window.evaluate(
      async ({ zoneId, sessionId, name }) => {
        const board = globalThis.window.agentBoard;
        await board.agents.move(sessionId, { zoneId, x: 20, y: 300 });
        await board.items.create({ kind: 'sticky', zoneId, x: 20, y: 40, width: 200, height: 160, data: { text: 'mine', color: '#fff3a3' } });
        await board.items.create({
          kind: 'agent-note',
          zoneId,
          x: 300,
          y: 40,
          width: 272,
          height: 150,
          data: {
            text: '**Round 2 of 3**\n\n- implementer: `2 of 3` done\n- reviewer: idle',
            agent: { sessionId, name, harness: 'claude', role: 'orchestrator' },
            about: sessionId,
            writtenAt: new Date().toISOString(),
            editedByUser: false,
          },
        });
      },
      { zoneId: zone!.id, sessionId: agent!.sessionId, name: agent!.name },
    );
    const note = window.getByTestId('agent-note');
    await expect(note).toHaveAttribute('data-look', 'document');
    // A sticky the user made stays a sticky.
    await expect(window.getByTestId('sticky')).toHaveCount(1);
    await expect(note.locator('strong')).toHaveText('Round 2 of 3');
    await expect(note.locator('code')).toHaveText('2 of 3');
    await expect(window.getByTestId('agent-note-tether')).toHaveCount(1);
    await expect(note).not.toContainText('edited by you');

    // The badge selects its agent's tile.
    await note.getByRole('button', { name: new RegExp(agent!.name) }).click();
    await expect(lead.locator('xpath=ancestor::*[contains(@class, "react-flow__node")][1]')).toHaveClass(/selected/);

    // The user's edit says so.
    await note.dblclick();
    const editor = note.getByRole('textbox', { name: 'Note text' });
    await editor.fill('Waiting on the gate');
    await editor.press('Escape');
    await expect(note).toContainText('✎ edited by you');
    await expect
      .poll(async () => (await window.evaluate(() => globalThis.window.agentBoard.items.list())).find((item) => item.kind === 'agent-note')?.data)
      .toMatchObject({ text: 'Waiting on the gate', editedByUser: true });

    // Every agent note switches look at once, and the setting is kept.
    await agentNotesLook(window, 'Terminal');
    await expect(note).toHaveAttribute('data-look', 'terminal');
    expect(await window.evaluate(() => globalThis.window.agentBoard.view.get('agentNoteLook'))).toBe('terminal');
    await agentNotesLook(window, 'Document');
    await expect(note).toHaveAttribute('data-look', 'document');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
