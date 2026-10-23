import { expect, type Page } from '@playwright/test';
import type { Agent } from '@agent-board/daemon/protocol';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, screen, sessionWindow, spawnAgent, tile, TURN_MS } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// An agent shows the user a document through the board MCP: a Document tab in its window, and a card on the board. The
// user edits a Markdown one there, which writes the file and tells the agent what changed. The fake claude's
// `ask-plan` scenario writes and shows the file; nothing here writes it for the agent.

const agentTile = (window: Page, agent: Agent) => tile(window).and(window.locator(`[data-session-id="${agent.sessionId}"]`));
const docView = (window: Page) => sessionWindow(window).getByTestId('document-view');

async function spawn(page: Page, prompt: string): Promise<Agent> {
  const before = await page.evaluate(() => window.agentBoard.agents.list());
  await spawnAgent(page, 'monorepo', prompt);
  const after = await page.evaluate(() => window.agentBoard.agents.list());
  return after.find((agent) => !before.some((known) => known.sessionId === agent.sessionId))!;
}

/** The agent as the daemon has it now. */
const latest = (page: Page, agent: Agent) => page.evaluate((sessionId) => window.agentBoard.agents.list().then((all) => all.find((each) => each.sessionId === sessionId)!), agent.sessionId);

async function withApp(body: (window: Page) => Promise<void>): Promise<void> {
  const setup = scratch('ask-plan');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, setup.env);
  try {
    await pickFolderNext(app, setup.repo);
    await browseForZone(window);
    await body(window);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(setup.dir, { recursive: true, force: true });
  }
}

test('a document shown on the board is a card beside its agent; its Document tab edits the file and tells the agent the diff', async () => {
  await withApp(async (window) => {
    const agent = await spawn(window, 'Doc on the board: docs/release-plan.md');

    const card = window.getByTestId('doc-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Release 1.4 plan');
    await expect(card).toContainText('release-plan.md');
    await expect(card.getByTestId('doc-card-preview')).toContainText('Merge the flake fix first');
    await expect(agentTile(window, agent).getByTestId('tile-docs')).toHaveText('1 doc');

    // Double-click opens it as a Document tab in the agent's window, read by default.
    await card.dispatchEvent('dblclick');
    await expect(docView(window)).toBeVisible();
    await expect(docView(window).getByTestId('doc-body').getByRole('heading', { name: 'Order' })).toBeVisible();
    await expect(docView(window).getByTestId('doc-meta')).toContainText('v1 · written by');

    // Edit splits it into its source and the live render; ⌘S writes the file and tells the agent.
    await docView(window).getByRole('button', { name: 'Edit' }).click();
    const source = docView(window).getByLabel('Markdown of Release 1.4 plan');
    await expect(source).toBeFocused();
    await source.fill('# Release 1.4 plan\n\n## Order\nHold the pin bump to 1.5.\n');
    await expect(docView(window).getByLabel('Preview')).toContainText('Hold the pin bump to 1.5.');
    await expect(docView(window).getByTestId('doc-edit-hint')).toContainText('1 change');
    await source.press('ControlOrMeta+s');

    await expect(docView(window)).toHaveAttribute('data-mode', 'read');
    await expect(docView(window).getByTestId('doc-meta')).toContainText('v2 · written by you');
    const saved = await latest(window, agent);
    expect(readFileSync(join(saved.worktree, 'docs/release-plan.md'), 'utf8')).toBe('# Release 1.4 plan\n\n## Order\nHold the pin bump to 1.5.\n');
    await expect(card).toContainText('you edited');

    // Typed at its prompt once its turn is over.
    await sessionWindow(window).getByRole('tab', { name: 'claude', exact: true }).click();
    await expect(screen(window)).toContainText('The user edited docs/release-plan.md (v2)', { timeout: TURN_MS });
    await expect(screen(window)).toContainText('+ Hold the pin bump to 1.5.', { timeout: TURN_MS });

    // The card collapses to a slim bar and back, and taken off the board, the document stays the agent's.
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await card.click();
    await window.getByRole('button', { name: 'Collapse to a bar' }).click();
    await expect(card).toHaveAttribute('data-collapsed', 'true');
    await expect(card.getByTestId('doc-card-preview')).toHaveCount(0);
    await window.getByRole('button', { name: 'Show the page' }).click();
    await expect(card.getByTestId('doc-card-preview')).toBeVisible();
    await window.getByRole('button', { name: 'Take it off the board' }).click();
    await expect(card).toHaveCount(0);
    await agentTile(window, agent).getByTestId('tile-docs').click();
    await expect(docView(window)).toContainText('Release 1.4 plan');
  });
});

test('Save and ⌘S never write over a version the agent saved while the user was editing: only Keep mine does', async () => {
  await withApp(async (window) => {
    const agent = await spawn(window, 'Doc: plan.md');
    await expect(agentTile(window, agent).getByTestId('tile-docs')).toHaveText('1 doc');
    await agentTile(window, agent).getByTestId('tile-docs').click();
    await docView(window).getByRole('button', { name: 'Edit' }).click();
    const source = docView(window).getByLabel('Markdown of Release 1.4 plan');
    await source.fill('# Release 1.4 plan\n\nMine.\n');

    // The agent writes the file again meanwhile.
    const path = join((await latest(window, agent)).worktree, 'plan.md');
    writeFileSync(path, '# Release 1.4 plan\n\nThe agent’s new section.\n');
    const banner = docView(window).getByTestId('doc-rewritten');
    await expect(banner).toContainText(`${agent.name} saved v2 while you were editing.`);
    await expect(docView(window).getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

    await source.press('ControlOrMeta+s');
    await expect(banner.getByRole('button', { name: 'Keep mine' })).toBeFocused();
    await expect(banner).toBeVisible();
    expect(readFileSync(path, 'utf8')).toBe('# Release 1.4 plan\n\nThe agent’s new section.\n');

    await banner.getByRole('button', { name: 'Keep mine' }).click();
    await expect(docView(window)).toHaveAttribute('data-mode', 'read');
    expect(readFileSync(path, 'utf8')).toBe('# Release 1.4 plan\n\nMine.\n');
    await sessionWindow(window).getByRole('tab', { name: 'claude', exact: true }).click();
    await expect(screen(window)).toContainText('The user kept their version of plan.md over your v2', { timeout: TURN_MS });
  });
});

test('esc leaves Edit with nothing written, and an HTML document is view-only with comments for the agent', async () => {
  await withApp(async (window) => {
    const agent = await spawn(window, 'Doc: notes/plan.md');
    await expect(agentTile(window, agent).getByTestId('tile-docs')).toHaveText('1 doc');
    await agentTile(window, agent).getByTestId('tile-docs').click();
    await expect(docView(window)).toBeVisible();

    await docView(window).getByRole('button', { name: 'Edit' }).click();
    await docView(window).getByLabel('Markdown of Release 1.4 plan').fill('Not this.');
    await docView(window).getByLabel('Markdown of Release 1.4 plan').press('Escape');
    await expect(docView(window)).toHaveAttribute('data-mode', 'read');
    // The window stays open: the first esc was the editor's.
    await expect(sessionWindow(window)).toBeVisible();
    expect((await latest(window, agent)).docs[0]).toMatchObject({ version: 1, writtenBy: 'agent' });

    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow(window)).toHaveCount(0);
    const page = await spawn(window, 'Doc: bench.html');
    await expect(agentTile(window, page).getByTestId('tile-docs')).toHaveText('1 doc');
    await agentTile(window, page).getByTestId('tile-docs').click();
    await expect(docView(window)).toHaveAttribute('data-format', 'html');
    await expect(docView(window).getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(docView(window)).toContainText('view only');
    const comments = docView(window).getByTestId('doc-comments');
    await comments.getByLabel(`Comments on Cache benchmark for ${page.name}`).fill('Was this with WAL on?');
    await comments.getByRole('button', { name: 'Send comments' }).click();
    await expect(comments).toContainText('Sent');
    await sessionWindow(window).getByRole('tab', { name: 'claude', exact: true }).click();
    await expect(screen(window)).toContainText('The user commented on bench.html (v1):', { timeout: TURN_MS });
    await expect(screen(window)).toContainText('Was this with WAL on?', { timeout: TURN_MS });
  });
});
